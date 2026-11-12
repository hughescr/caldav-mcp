/**
 * get_event_attachment_download (design v3 section 5). Every call re-reads the event from iCloud and selects the
 * attachment server-side by its ref; no URL, filename, account or key is ever taken from the caller. Order: fresh
 * membership, one original multiget, optional expected_version check, ref relocation, classification, then (inline or
 * managed) the bytes and a fresh staged copy. External links are returned without being fetched.
 */
import { AttachmentFetchError, type AttachmentFetchErrorCode, type ManagedAttachmentFetcher } from '../caldav/attachment-fetch';
import { classifyAttachment } from './attachment-access';
import { DownloadStageError, stageDownload, type DownloadStore } from './downloads';
import type { DownloadArgs, DownloadOutput, ReadToolErrorCode } from './event-schemas';
import { FILENAME_MAX, MAX_DOWNLOAD_BYTES, MIME_MAX } from './limits';
import type { ManagedAttachmentPolicy } from '../caldav/managed-attachment-policy';
import { sanitizeDisplayText } from './normalize';
import { detailTarget, readOriginal, ReadError, type ReadDeps } from './read';

export interface DownloadDeps extends ReadDeps {
    /** Undefined when no download bucket is configured: staging then fails, external links still work. */
    store: DownloadStore | undefined;
    fetchManaged: ManagedAttachmentFetcher;
    policy: ManagedAttachmentPolicy;
    now?: () => number;
}

const FETCH_CODES: Record<AttachmentFetchErrorCode, ReadToolErrorCode> = {
    not_found: 'not_found',
    temporary: 'temporarily_unavailable',
    upstream: 'upstream_error',
    redirect: 'upstream_error',
    login_required: 'unsupported_attachment',
    too_large: 'result_too_large',
    verification: 'verification_failed',
};

function displayText(value: string | null, max: number): string | null {
    return value === null ? null : sanitizeDisplayText(value, max).text;
}

/** A signal that aborts with the budget or after `ms`, whichever is first. */
function within(signal: AbortSignal, ms: number): AbortSignal {
    if (ms <= 0) { throw new ReadError('temporarily_unavailable'); }
    return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

export async function getAttachmentDownload(deps: DownloadDeps, input: DownloadArgs): Promise<DownloadOutput> {
    const { budget } = deps;
    const calendarId = input.calendar_id;
    const href = input.resource_href;
    detailTarget(calendarId, href, input.recurrence_id ?? null);
    if (!/^a1_[A-Za-z0-9_-]{43}$/u.test(input.attachment_ref)) { throw new ReadError('invalid_input'); }

    const { resource, attachments } = await readOriginal(deps, calendarId, href, input.expected_version);
    const entry = attachments.find(candidate => candidate.ref === input.attachment_ref);
    if (entry === undefined) { throw new ReadError('not_found'); }
    const { descriptor } = entry;
    const access = classifyAttachment(descriptor, deps.discovery.calendarHomeUrl, deps.policy);
    const base = { attachment_ref: entry.ref, expected_version: resource.etag };

    if (access.kind === 'unsupported') { throw new ReadError('unsupported_attachment'); }
    if (access.kind === 'external') {
        return {
            form: 'external', ...base, url: access.url, fetched_by_server: false,
            filename: displayText(descriptor.filename, FILENAME_MAX), content_type: displayText(descriptor.contentType, MIME_MAX),
        };
    }
    if (access.kind === 'managed' && descriptor.declaredSize !== null && descriptor.declaredSize > MAX_DOWNLOAD_BYTES) { throw new ReadError('result_too_large', 'attachment_size'); }
    // Checked before any fetch: without a bucket there is nowhere to stage, so nothing is fetched.
    const { store } = deps;
    if (store === undefined) { throw new ReadError('temporarily_unavailable'); }

    let bytes: Uint8Array;
    if (access.kind === 'inline') {
        // The pre-scan accepted only canonical base64, so this decoding is exact; the 2 MiB resource cap bounds it.
        bytes = new Uint8Array(Buffer.from(access.base64, 'base64'));
        if (bytes.byteLength > MAX_DOWNLOAD_BYTES) { throw new ReadError('result_too_large', 'attachment_size'); }
        // SIZE is an upper bound, never trusted as exact.
        if (descriptor.declaredSize !== null && bytes.byteLength > descriptor.declaredSize) { throw new ReadError('verification_failed'); }
    } else {
        try {
            bytes = await deps.fetchManaged({
                url: access.url,
                declaredSize: descriptor.declaredSize,
                signal: within(budget.signal, budget.streamLeaseMs()),
                credentials: () => deps.auth,
            });
        } catch (error) {
            if (error instanceof AttachmentFetchError) { throw error.code === 'too_large' ? new ReadError('result_too_large', 'attachment_size') : new ReadError(FETCH_CODES[error.code]); }
            if (error instanceof ReadError) { throw error; }
            throw new ReadError('temporarily_unavailable');
        }
    }

    let staged;
    try {
        staged = await stageDownload(store, {
            accountId: deps.accountId, bytes, filename: descriptor.filename, url: descriptor.uri, declaredContentType: descriptor.contentType,
        }, within(budget.signal, budget.workRemainingMs()), deps.now);
    } catch (error) {
        if (error instanceof DownloadStageError) { throw new ReadError(error.code); }
        if (error instanceof ReadError) { throw error; }
        throw new ReadError('temporarily_unavailable');
    }
    return {
        form: access.kind, ...base, fetched_by_server: true,
        filename: staged.filename, content_type: staged.contentType, size: staged.size, download_url: staged.url, expires_at: staged.expiresAt,
    };
}
