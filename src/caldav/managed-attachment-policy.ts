/**
 * The one reviewed module that holds provider facts about Apple-managed attachment downloads (design v3 section 5).
 * Nothing else in the server may decide where a managed attachment is fetched from or whether credentials go with it.
 *
 * Evidence (probe 0.5.0, run 5, 2026-11-11, one account): a managed ATTACH carries MANAGED-ID and SIZE, its URL is
 * https on exactly `gateway.icloud.com` with no query, an anonymous GET answers 200 with the bytes (the URL is a
 * capability), with no Content-Length, no redirect, and Range is ignored. No host has been seen to need a login.
 *
 * Decisions:
 * - The download host list is closed. Adding a host is a deliberate, reviewed edit of DOWNLOAD_HOSTS.
 * - Fetches are anonymous. Owner decision OD9 allows the account's credentials to go to an Apple download host only
 *   when that host answers 401 with a Basic challenge AND it is in CREDENTIALED_HOSTS. That list ships empty, because
 *   no evidence shows any host needs a login.
 * - Generic denials apply whatever the host list says: only https on the default port, no userinfo or fragment, no
 *   ambiguous path encoding, nothing under the calendar-home path, no `.ics` path and no collection (trailing-slash)
 *   path. An invitation's ATTACH text can never make the server fetch CalDAV data.
 * - A query string is allowed: the fetch is anonymous and the host is fixed, so a query cannot widen what is reached.
 */

export interface ManagedAttachmentPolicy {
    /** Exact host names a managed attachment may be fetched from, anonymously. */
    readonly downloadHosts: readonly string[];
    /** Hosts, also in downloadHosts, that may receive the account's credentials after a 401 Basic challenge (OD9). */
    readonly credentialedHosts: readonly string[];
}

const DOWNLOAD_HOSTS: readonly string[] = Object.freeze(['gateway.icloud.com']);
const CREDENTIALED_HOSTS: readonly string[] = Object.freeze([]);

export const MANAGED_ATTACHMENT_POLICY: ManagedAttachmentPolicy = Object.freeze({
    downloadHosts: DOWNLOAD_HOSTS,
    credentialedHosts: CREDENTIALED_HOSTS,
});

export type ManagedDenial =
    | 'missing_managed_id' | 'invalid_url' | 'not_https' | 'userinfo' | 'port' | 'fragment' | 'host'
    | 'ambiguous_path' | 'calendar_home_path' | 'ics_path' | 'collection_path';

export type ManagedDecision = { allowed: true; url: URL } | { allowed: false; reason: ManagedDenial };

export interface ManagedCandidate {
    /** The exact unfolded ATTACH value. */
    url: string;
    /** The single MANAGED-ID parameter value, or null when absent, empty or duplicated. */
    managedId: string | null;
    /** The authenticated account's calendar-home URL. */
    calendarHomeUrl: string;
}

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_RAW = /[\u0000- \u007F\\]/u;
/** Percent escapes that would make the decoded path differ structurally from the sent one, plus malformed escapes. */
const AMBIGUOUS_ESCAPE = /%(?:2[eEfF]|5[cC]|00)|%(?![0-9A-Fa-f]{2})/u;

function deny(reason: ManagedDenial): ManagedDecision {
    return { allowed: false, reason };
}

function decodedLowerPath(pathname: string): string | null {
    try { return decodeURIComponent(pathname).toLowerCase(); } catch { return null; }
}

function homePathOf(calendarHomeUrl: string): string | null {
    let home: URL;
    try { home = new URL(calendarHomeUrl); } catch { return null; }
    const path = decodedLowerPath(home.pathname);
    if (path === null) { return null; }
    return path.endsWith('/') ? path : `${path}/`;
}

/** Decides whether a managed attachment URL may be fetched. Never sends anything. */
export function checkManagedAttachmentUrl(candidate: ManagedCandidate, policy: ManagedAttachmentPolicy = MANAGED_ATTACHMENT_POLICY): ManagedDecision {
    if (candidate.managedId === null || candidate.managedId === '') { return deny('missing_managed_id'); }
    const raw = candidate.url;
    if (typeof raw !== 'string' || raw === '' || UNSAFE_RAW.test(raw)) { return deny('invalid_url'); }
    let url: URL;
    try { url = new URL(raw); } catch { return deny('invalid_url'); }
    if (url.protocol !== 'https:') { return deny('not_https'); }
    if (url.username !== '' || url.password !== '') { return deny('userinfo'); }
    // An explicit :443 normalizes to '' and is the same destination; any other port is not.
    if (url.port !== '') { return deny('port'); }
    if (url.hash !== '' || raw.includes('#')) { return deny('fragment'); }
    // WHATWG normalization lowercases and IDNA-maps the host; a trailing dot or a lookalike is not an exact match.
    if (!policy.downloadHosts.includes(url.hostname)) { return deny('host'); }
    if (AMBIGUOUS_ESCAPE.test(url.pathname) || url.pathname.includes('//')) { return deny('ambiguous_path'); }
    const path = decodedLowerPath(url.pathname);
    const home = homePathOf(candidate.calendarHomeUrl);
    if (path === null || home === null) { return deny('ambiguous_path'); }
    if (path === home.slice(0, -1) || path.startsWith(home)) { return deny('calendar_home_path'); }
    if (path.split('/').some(segment => segment.endsWith('.ics'))) { return deny('ics_path'); }
    if (path.endsWith('/')) { return deny('collection_path'); }
    return { allowed: true, url };
}

/** True when a WWW-Authenticate value offers the Basic scheme in any of its challenges. */
export function offersBasicChallenge(header: string | null): boolean {
    return header !== null && /(?:^|,)\s*basic(?:\s|,|$)/iu.test(header);
}

/**
 * OD9: credentials may be sent once, to the same approved URL, only after that host answered 401 with a Basic challenge
 * and only when the host is listed in both downloadHosts and credentialedHosts.
 */
export function credentialRetryAllowed(url: URL, response: { status: number; wwwAuthenticate: string | null }, policy: ManagedAttachmentPolicy = MANAGED_ATTACHMENT_POLICY): boolean {
    return response.status === 401
        && offersBasicChallenge(response.wwwAuthenticate)
        && url.protocol === 'https:'
        && policy.downloadHosts.includes(url.hostname)
        && policy.credentialedHosts.includes(url.hostname);
}
