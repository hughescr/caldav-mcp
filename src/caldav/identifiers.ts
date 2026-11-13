/**
 * URL paths shared by discovery, the event-read transport and the writer. Collection paths (the home and calendar ids)
 * are canonicalized; a resource href is an opaque string issued by iCloud, kept and sent byte for byte.
 */
import { isCanonicalPath, isResourceHref } from '../calendar/model';
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

/**
 * True only for a resource href that is exactly this canonical collection path followed by one opaque resource name
 * ({@link isResourceHref}). Compares bytes: nothing is decoded, so a differently escaped spelling is a different href.
 */
export function isDirectChildResource(collectionPath: string, resourcePath: string): boolean {
    if (typeof collectionPath !== 'string' || typeof resourcePath !== 'string' || !isCanonicalPath(collectionPath) || !collectionPath.endsWith('/')) { return false; }
    return isResourceHref(resourcePath) && resourcePath.lastIndexOf('/') === collectionPath.length - 1 && resourcePath.startsWith(collectionPath);
}

export type ServerResourceHref = { kind: 'resource'; href: string } | { kind: 'unsupported_name' };

const SCHEME_AUTHORITY = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/]*)(.*)$/su;
const decodeOnce = (text: string): string => text.replace(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/**
 * The exact resource href that one server href of a REPORT names, without decoding, re-encoding or case-normalising any
 * of it. An absolute URL must be on the base's origin with no userinfo (only the origin is parsed; the path is the raw
 * text after it); an absolute path is taken as is; a relative reference is appended to the base path's directory.
 *
 * - `resource`: a direct child of `calendarId` under {@link isResourceHref}; WHATWG URL parses it back to the same bytes.
 * - `unsupported_name`: the href names something in this calendar (the calendar path, then one segment with no `/` or `\`
 *   that is not a dot segment) whose name the rule refuses. Attributable to its own response; carries nothing from it.
 * @throws {CalDavError} protocol when the href is outside the calendar: another origin, userinfo, a network-path or
 *   backslash reference, another collection or account, the collection itself, a nested path or a dot segment.
 */
export function resolveServerResourceHref(href: string, baseUrl: string, calendarId: string): ServerResourceHref {
    let base: URL;
    try { base = new URL(baseUrl); } catch { return protocol(); }
    let path: string;
    const absolute = SCHEME_AUTHORITY.exec(href);
    if (absolute) {
        const [, scheme = '', authority = '', rest = ''] = absolute;
        if (authority === '' || /[@\\?#\s]/u.test(authority)) { return protocol(); }
        let origin: URL;
        try { origin = new URL(`${scheme}${authority}/`); } catch { return protocol(); }
        if (origin.origin !== base.origin || origin.username !== '' || origin.password !== '' || !rest.startsWith('/')) { return protocol(); }
        path = rest;
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(href) || href.startsWith('//') || href.startsWith('\\')) {
        return protocol();
    } else if (href.startsWith('/')) {
        path = href;
    } else {
        path = `${base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1)}${href}`;
    }
    if (!path.startsWith(calendarId)) { return protocol(); }
    const name = path.slice(calendarId.length);
    const segment = name.split(/[?#]/u)[0] ?? '';
    const dot = decodeOnce(segment);
    if (name === '' || /[/\\]/u.test(name) || dot === '.' || dot === '..') { return protocol(); }
    if (!isDirectChildResource(calendarId, path)) { return { kind: 'unsupported_name' }; }
    // The rule's character set is chosen so this holds; checked anyway, so an accepted href is one URL leaves untouched.
    const parsed = new URL(path, base.origin);
    if (parsed.pathname !== path || parsed.search !== '' || parsed.hash !== '') { return { kind: 'unsupported_name' }; }
    return { kind: 'resource', href: path };
}

/**
 * The request URL for a resource href on the home's origin, proven to carry the href byte for byte: WHATWG URL must
 * parse it back to exactly that path, with no query or fragment. Null otherwise.
 */
export function exactResourceUrl(home: URL, href: string): URL | null {
    let url: URL;
    try { url = new URL(href, home.origin); } catch { return null; }
    return url.origin === home.origin && url.username === '' && url.password === '' && url.pathname === href && url.search === '' && url.hash === '' ? url : null;
}
