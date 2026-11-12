/** Canonical URL paths shared by discovery and the event-read transport. */
import { isCanonicalPath } from '../calendar/model';
import { CalDavError } from './contracts';

function protocol(): never { throw new CalDavError('protocol'); }

// WHATWG URL discards dot segments, controls and backslashes. Check the spelling before resolving it.
// oxlint-disable-next-line no-control-regex -- matching URL-stripped controls is intentional
const UNSAFE_RAW = /[\u0000-\u001F\u007F\\?#]|%(?![0-9A-Fa-f]{2})/u;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/u;

function assertSpelling(href: string): void {
    if (!href || href.trim() !== href || UNSAFE_RAW.test(href)) { protocol(); }
    for (const segment of href.split('/')) {
        const decoded = segment.replace(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
        if (decoded === '.' || decoded === '..') { protocol(); }
    }
}

/**
 * Resolves a server href against the actual final response URL. Decodes unreserved escapes and uppercases
 * remaining hex; rejects traversal, foreign origins and ambiguous paths before URL normalization can hide them.
 * @throws {CalDavError} With code protocol for an unsafe href.
 */
export function canonicalizeServerHref(href: string, baseUrl: string): string {
    assertSpelling(href);
    let base: URL;
    let url: URL;
    try {
        base = new URL(baseUrl);
        url = new URL(href, base);
    } catch { return protocol(); }
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash) { return protocol(); }
    const path = url.pathname.replace(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) => {
        const character = String.fromCharCode(Number.parseInt(hex, 16));
        return UNRESERVED.test(character) ? character : `%${hex.toUpperCase()}`;
    });
    return isCanonicalPath(path) ? path : protocol();
}

/** Canonicalizes a server collection path to the same lexical form as the public Path scalar. */
export function canonicalizeCalendarPath(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//') || !path.endsWith('/')) { return protocol(); }
    return canonicalizeServerHref(path, 'https://caldav.icloud.com/');
}

/** True only for an already-canonical, direct child resource of an already-canonical collection. */
export function isDirectChildResource(collectionPath: string, resourcePath: string): boolean {
    if (!isCanonicalPath(collectionPath) || !collectionPath.endsWith('/') || !isCanonicalPath(resourcePath)
        || !resourcePath.startsWith(collectionPath)) { return false; }
    const child = resourcePath.slice(collectionPath.length);
    return child !== '' && !child.includes('/');
}
