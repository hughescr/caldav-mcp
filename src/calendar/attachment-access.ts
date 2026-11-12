/**
 * How get_event_attachment_download can serve one attachment. Pure: no network. get_event's download_supported and the
 * download tool both use this one classification, so they cannot disagree.
 *
 * - inline: VALUE=BINARY;ENCODING=BASE64 that passed the structural pre-scan: decoded and staged.
 * - managed: MANAGED-ID with a URL the reviewed managed policy approves: fetched anonymously and staged.
 * - external: any other http(s) URL, including a MANAGED-ID URL the policy refuses. Never fetched (no SSRF): the link
 *   itself is returned, marked as not fetched by the server.
 * - unsupported: duplicate or conflicting structural parameters, invalid base64, or no usable http(s) URL.
 */
import { checkManagedAttachmentUrl, MANAGED_ATTACHMENT_POLICY, type ManagedAttachmentPolicy } from '../caldav/managed-attachment-policy';
import { MAX_DOWNLOAD_BYTES } from './limits';
import type { AttachmentDescriptor } from './model';

/** Longest external link returned, in characters after URL normalization. */
export const EXTERNAL_URL_MAX = 4096;

export type AttachmentAccess =
    | { kind: 'inline'; base64: string }
    | { kind: 'managed'; url: URL }
    | { kind: 'external'; url: string }
    | { kind: 'unsupported' };

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_RAW = /[\u0000- \u007F]/u;

function externalLink(text: string | null): AttachmentAccess {
    if (text === null || text === '' || text.length > EXTERNAL_URL_MAX || UNSAFE_RAW.test(text)) { return { kind: 'unsupported' }; }
    let url: URL;
    try { url = new URL(text); } catch { return { kind: 'unsupported' }; }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.href.length > EXTERNAL_URL_MAX) { return { kind: 'unsupported' }; }
    return { kind: 'external', url: url.href };
}

export function classifyAttachment(descriptor: AttachmentDescriptor, calendarHomeUrl: string, policy: ManagedAttachmentPolicy = MANAGED_ATTACHMENT_POLICY): AttachmentAccess {
    if (!descriptor.structurallySupported) { return { kind: 'unsupported' }; }
    if (descriptor.form === 'inline') {
        return descriptor.inlineBase64 === null ? { kind: 'unsupported' } : { kind: 'inline', base64: descriptor.inlineBase64 };
    }
    if (descriptor.form === 'managed' && descriptor.uri !== null) {
        const decision = checkManagedAttachmentUrl({ url: descriptor.uri, managedId: descriptor.managedId, calendarHomeUrl }, policy);
        if (decision.allowed) { return { kind: 'managed', url: decision.url }; }
    }
    return externalLink(descriptor.uri);
}

/** get_event's download_supported: the download tool will stage it, or return its external link. */
export function downloadSupported(descriptor: AttachmentDescriptor, calendarHomeUrl: string, policy: ManagedAttachmentPolicy = MANAGED_ATTACHMENT_POLICY): boolean {
    const access = classifyAttachment(descriptor, calendarHomeUrl, policy);
    if (access.kind === 'unsupported') { return false; }
    // A managed SIZE over the cap is refused before fetching; inline bytes are already bounded by the resource cap.
    return access.kind !== 'managed' || descriptor.declaredSize === null || descriptor.declaredSize <= MAX_DOWNLOAD_BYTES;
}
