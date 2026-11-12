/**
 * Generic checked fetch of one managed attachment (design v3 section 5). Where it may go and whether credentials may go
 * with it are decided only by managed-attachment-policy.ts; this module enforces the transport rules:
 *
 * - One GET of the policy-approved URL, anonymous: no Authorization header and no cookies. `redirect: 'manual'`, and any
 *   redirect is a failure, never followed.
 * - Credentials are sent at most once more, to the same URL, only when the policy allows it after a 401 Basic challenge.
 * - Only 200 is accepted, without a Content-Encoding other than identity.
 * - A hard byte cap while streaming: 20 MiB, and the ATTACH SIZE, when present, as a further upper bound. SIZE is not
 *   trusted as exact. A Content-Length, when present, must fit both and must equal the bytes received.
 * - The caller's signal bounds the whole exchange, body included. Failures are bare codes, never upstream text or URLs.
 */
import type { CalDavAuth } from './contracts';
import type { FetchLike } from './hosts';
import { basicAuthorization } from './icloud';
import { credentialRetryAllowed, MANAGED_ATTACHMENT_POLICY, type ManagedAttachmentPolicy } from './managed-attachment-policy';
import { MAX_DOWNLOAD_BYTES, MAX_EMPTY_STREAM_CHUNKS } from '../calendar/limits';

export type AttachmentFetchErrorCode =
    /** 404 or 410. */
    | 'not_found'
    /** Network failure, timeout, 403, 408, 429 or 5xx. */
    | 'temporary'
    /** Any other status, including a 401 after credentials were sent. */
    | 'upstream'
    /** Any 3xx answer: redirects are never followed. */
    | 'redirect'
    /** 401 that the policy does not allow answering with credentials. */
    | 'login_required'
    /** More than the 20 MiB download cap. */
    | 'too_large'
    /** More than SIZE, a Content-Length mismatch, or an unexpected Content-Encoding. */
    | 'verification';

export class AttachmentFetchError extends Error {
    constructor(public readonly code: AttachmentFetchErrorCode) { super(code); }
}

export interface ByteLimit {
    maxBytes: number;
    /** The code for crossing maxBytes. */
    overflow: 'too_large' | 'verification';
}

/** The cap for one attachment: 20 MiB, or the declared SIZE when that is smaller. */
export function byteLimit(declaredSize: number | null): ByteLimit {
    if (declaredSize !== null && declaredSize > MAX_DOWNLOAD_BYTES) { throw new AttachmentFetchError('too_large'); }
    if (declaredSize !== null && declaredSize < MAX_DOWNLOAD_BYTES) { return { maxBytes: declaredSize, overflow: 'verification' }; }
    return { maxBytes: MAX_DOWNLOAD_BYTES, overflow: 'too_large' };
}

function aborted(signal: AbortSignal): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(new AttachmentFetchError('temporary'));
        if (signal.aborted) { fail(); return; }
        signal.addEventListener('abort', fail, { once: true });
    });
}

/**
 * Reads a body into memory, charging the cap before each chunk is kept. Stops and cancels the source as soon as the cap
 * is crossed or the signal aborts; never holds more than the cap.
 */
export async function readCappedBody(body: ReadableStream<Uint8Array> | null, limit: ByteLimit, signal: AbortSignal): Promise<Uint8Array> {
    if (body === null) { return new Uint8Array(0); }
    const reader = body.getReader();
    const abort = aborted(signal);
    abort.catch(() => undefined);
    const chunks: Uint8Array[] = [];
    let total = 0;
    let empty = 0;
    try {
        for (;;) {
            const next = await Promise.race([reader.read(), abort]);
            if (next.done) { break; }
            const chunk: unknown = next.value;
            if (!(chunk instanceof Uint8Array)) { throw new AttachmentFetchError('upstream'); }
            // Synchronously produced empty chunks never grow the total and would starve the deadline timer.
            if (chunk.byteLength === 0 && ++empty > MAX_EMPTY_STREAM_CHUNKS) { throw new AttachmentFetchError('upstream'); }
            total += chunk.byteLength;
            if (total > limit.maxBytes) { throw new AttachmentFetchError(limit.overflow); }
            chunks.push(chunk);
        }
    } catch (error) {
        reader.cancel().catch(() => undefined);
        throw error instanceof AttachmentFetchError ? error : new AttachmentFetchError('temporary');
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

export interface ManagedFetchRequest {
    /** A URL the managed policy approved. */
    url: URL;
    /** Canonical SIZE from the ATTACH, or null. An upper bound only. */
    declaredSize: number | null;
    /** Bounds the whole exchange, body included. */
    signal: AbortSignal;
    /** Read only if the policy allows a credentialed retry. */
    credentials: () => CalDavAuth;
}

export type ManagedAttachmentFetcher = (request: ManagedFetchRequest) => Promise<Uint8Array>;

export interface ManagedFetcherOptions {
    /** Defaults to the global fetch, looked up per call. */
    fetch?: FetchLike;
    policy?: ManagedAttachmentPolicy;
}

function discard(response: Response): void {
    response.body?.cancel().catch(() => undefined);
}

function statusCode(status: number): AttachmentFetchErrorCode {
    if (status === 404 || status === 410) { return 'not_found'; }
    if (status === 403 || status === 408 || status === 429 || status >= 500) { return 'temporary'; }
    return 'upstream';
}

export function createManagedAttachmentFetcher(options: ManagedFetcherOptions = {}): ManagedAttachmentFetcher {
    const policy = options.policy ?? MANAGED_ATTACHMENT_POLICY;
    const send: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    return async (request) => {
        const { url, signal } = request;
        const limit = byteLimit(request.declaredSize);
        const get = async (authorization: string | null): Promise<Response> => {
            if (signal.aborted) { throw new AttachmentFetchError('temporary'); }
            const headers = new Headers({ accept: '*/*', 'accept-encoding': 'identity' });
            if (authorization !== null) { headers.set('authorization', authorization); }
            try {
                return await Promise.race([send(url.href, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal }), aborted(signal)]);
            } catch (error) {
                if (error instanceof AttachmentFetchError) { throw error; }
                // Network failures and aborts: the cause is dropped, it may echo the URL.
                throw new AttachmentFetchError('temporary');
            }
        };

        let response = await get(null);
        if (credentialRetryAllowed(url, { status: response.status, wwwAuthenticate: response.headers.get('www-authenticate') }, policy)) {
            discard(response);
            let authorization: string;
            try { authorization = basicAuthorization(request.credentials()); } catch { throw new AttachmentFetchError('upstream'); }
            response = await get(authorization);
            if (response.status === 401) {
                discard(response);
                throw new AttachmentFetchError('upstream');
            }
        }
        const { status } = response;
        if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
            discard(response);
            throw new AttachmentFetchError('redirect');
        }
        if (status === 401) {
            discard(response);
            throw new AttachmentFetchError('login_required');
        }
        if (status !== 200) {
            discard(response);
            throw new AttachmentFetchError(statusCode(status));
        }
        const encoding = response.headers.get('content-encoding');
        if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
            discard(response);
            throw new AttachmentFetchError('verification');
        }
        const lengthHeader = response.headers.get('content-length');
        let declaredLength: number | null = null;
        if (lengthHeader !== null) {
            if (!/^\d{1,16}$/u.test(lengthHeader.trim())) {
                discard(response);
                throw new AttachmentFetchError('verification');
            }
            declaredLength = Number(lengthHeader.trim());
            if (declaredLength > limit.maxBytes) {
                discard(response);
                throw new AttachmentFetchError(declaredLength > MAX_DOWNLOAD_BYTES ? 'too_large' : limit.overflow);
            }
        }
        const bytes = await readCappedBody(response.body, limit, signal);
        if (declaredLength !== null && bytes.byteLength !== declaredLength) { throw new AttachmentFetchError('verification'); }
        return bytes;
    };
}
