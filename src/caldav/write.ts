/**
 * The only PUT and DELETE senders (phase 3 design v2 sections 5.1 and 6.5), on the guarded fetch:
 * - fixed host rule, and a scope guard: the request URL is on the authenticated home's origin and its canonical path is the
 *   target href, a direct child of a calendar collection directly under the home;
 * - `If-None-Match: *` for a create, the exact strong ETag in `If-Match` for an update or delete; nothing else is buildable;
 * - no redirect is followed (a 3xx is reported, the write is never re-sent), no retry of any kind;
 * - a 401 is decided from the status alone; a definitive 2xx (not 202) is decided from its status and headers, its body
 *   cancelled unread; any other answer body is read at most 16 KiB and summarised by {@link sanitizeUpstream}, and when it
 *   fails or stalls the status still stands, with an empty summary;
 * - a failure after the request was handed to the network and before a status arrived is `uncertain`, never a refusal:
 *   iCloud may have applied it.
 * Errors before sending are bare CalDavError codes. Nothing here logs.
 */
import { MAX_RESOURCE_BYTES } from '../calendar/limits';
import { isCanonicalPath } from '../calendar/model';
import { CalDavError, type CalDavAuth, type Discovery } from './contracts';
import { assertAllowedCalDavUrl, createGuardedFetch, isTruncatedResponse, type FetchLike } from './hosts';
import { canonicalizeServerHref, isDirectChildResource } from './identifiers';
import { strongEtag, type CalDavWriteBackend, type UpstreamDetail, type WriteCallOptions, type WriteResponse } from './write-contracts';
import { DAV_NS, parseXml, type XmlElement } from './xml';

export interface WriteBackendOptions {
    /** Transport under the guarded fetch. Defaults to the global fetch, looked up per call. */
    fetch?: FetchLike;
    /** The Basic authorization value for these credentials; throws CalDavError('unauthorized') when they cannot be sent. */
    authorization: (auth: CalDavAuth) => string;
}

/** Answer bodies are read at most this far (design 6.5). */
export const MAX_WRITE_RESPONSE_BYTES = 16 * 1024;
const WRITE_TIMEOUT_MS = 10_000;
const MAX_PRECONDITIONS = 8;
const MAX_PRECONDITION_LENGTH = 128;
const MAX_DETAIL_UNITS = 512;

function fail(code: 'protocol' | 'temporary' | 'too_large'): never {
    throw new CalDavError(code);
}

/** A 2xx other than 202: the save or delete happened. Its body is never read, so it can neither stall nor fail the answer. */
const isDefinitiveSuccess = (status: number): boolean => status >= 200 && status < 300 && status !== 202;

// ---- Answer summaries (ORCH S4) ----

function contentTypeClass(header: string | null): UpstreamDetail['content_type'] {
    const type = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (type === '') { return 'none'; }
    if (type === 'text/html' || type === 'application/xhtml+xml') { return 'html'; }
    if (type === 'text/xml' || type === 'application/xml' || type.endsWith('+xml')) { return 'xml'; }
    return type.startsWith('text/') ? 'text' : 'other';
}

/**
 * Code points turned into a space: C0 and C1 controls with DEL, the Arabic letter mark, LRM and RLM, the line and paragraph
 * separators, the bidi embeddings and overrides, and the bidi isolates. Written as numbers so no invisible character is
 * ever part of this source file.
 */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
    [0x00, 0x1F], [0x7F, 0x9F], [0x061C, 0x061C], [0x200E, 0x200F], [0x2028, 0x2029], [0x202A, 0x202E], [0x2066, 0x2069],
];

function spaceUnsafe(text: string): string {
    let out = '';
    for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        out += UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high) ? ' ' : character;
    }
    return out;
}

const PRECONDITION_RE = /^\{[\x21\x23-\x3B\x3D\x3F-\x5B\x5D-\x7E]{0,100}\}[A-Za-z0-9._-]{1,64}$/u;

function escapeRegExp(text: string): string {
    return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Cleaned, masked, cut to 512 units on a code-point boundary; null when nothing is left. */
function cleanDetail(text: string, masks: readonly string[]): { detail: string | null; cut: boolean } {
    let clean = spaceUnsafe(text.toWellFormed()).replaceAll(/\s+/gu, ' ').trim();
    for (const mask of masks) {
        if (mask !== '') { clean = clean.replaceAll(new RegExp(escapeRegExp(mask), 'giu'), '<account>'); }
    }
    if (clean === '') { return { detail: null, cut: false }; }
    if (clean.length <= MAX_DETAIL_UNITS) { return { detail: clean, cut: false }; }
    let end = MAX_DETAIL_UNITS;
    const last = clean.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) { end--; }
    return { detail: clean.slice(0, end), cut: true };
}

function allText(element: XmlElement): string {
    return [element.text, ...element.children.map(allText)].join(' ');
}

/**
 * A bounded summary of an answer body. XML goes through the strict xml.ts parser (no DTD, no entities beyond the
 * predefined five); a DAV:error root yields its child names as preconditions and its text as detail. HTML and unknown
 * types are never forwarded. Text is decoded as strict UTF-8 (else null), controls and bidi characters become spaces,
 * whitespace collapses, each mask (the account's principal id, its Apple ID) becomes `<account>`, and the result is cut to
 * 512 UTF-16 units.
 */
export function sanitizeUpstream(status: number, contentType: string | null, body: Uint8Array, bodyTruncated: boolean, masks: readonly string[]): UpstreamDetail {
    const content_type = contentTypeClass(contentType);
    const summary: UpstreamDetail = { status, content_type, preconditions: [], detail: null };
    let text: string | null = null;
    if (content_type === 'xml' || content_type === 'text') {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { text = null; }
    }
    if (text !== null && content_type === 'xml') {
        let root: XmlElement | null = null;
        try { root = parseXml(text); } catch { root = null; }
        text = null;
        if (root !== null && root.ns === DAV_NS && root.local === 'error') {
            summary.preconditions = root.children
                .map(child => `{${child.ns}}${child.local}`)
                .filter(name => name.length <= MAX_PRECONDITION_LENGTH && PRECONDITION_RE.test(name))
                .slice(0, MAX_PRECONDITIONS);
            text = allText(root);
        }
    }
    const cleaned = text === null ? { detail: null, cut: false } : cleanDetail(text, masks);
    summary.detail = cleaned.detail;
    if (bodyTruncated || cleaned.cut) { summary.detail_truncated = true; }
    return summary;
}

// ---- Targets ----

interface Target { home: URL; url: URL; href: string }

/** The home, and the request URL for a direct child of a calendar directly under it. Anything else is refused unsent. */
function writeTarget(discovery: Discovery, calendarId: string, href: string): Target {
    const home = assertAllowedCalDavUrl(discovery.calendarHomeUrl);
    const homePath = canonicalizeServerHref(home.href, home.href).replace(/\/?$/u, '/');
    if (typeof calendarId !== 'string' || typeof href !== 'string' || !isCanonicalPath(calendarId) || !calendarId.endsWith('/') || !calendarId.startsWith(homePath)) { return fail('protocol'); }
    const child = calendarId.slice(homePath.length, -1);
    if (child === '' || child.includes('/') || !isDirectChildResource(calendarId, href)) { return fail('protocol'); }
    const url = new URL(href, home);
    if (url.origin !== home.origin || canonicalizeServerHref(url.href, home.href) !== href) { return fail('protocol'); }
    return { home, url, href };
}

/** Masks for answer text: the numeric principal id from the discovered URLs, and the Apple ID. */
function accountMasks(auth: CalDavAuth, discovery: Discovery): string[] {
    const ids = new Set<string>();
    for (const url of [discovery.principalUrl, discovery.calendarHomeUrl]) {
        try {
            const first = new URL(url).pathname.split('/')[1] ?? '';
            if (/^\d{4,}$/u.test(first)) { ids.add(first); }
        } catch { /* a URL that does not parse has no id to mask */ }
    }
    if (typeof auth.appleId === 'string' && auth.appleId !== '') { ids.add(auth.appleId); }
    return [...ids].sort((a, b) => b.length - a.length);
}

// ---- Sending ----

export function createWriteBackend(options: WriteBackendOptions): CalDavWriteBackend {
    async function send(auth: CalDavAuth, discovery: Discovery, target: Target, method: 'PUT' | 'DELETE', headers: Record<string, string>, body: string | null, call: WriteCallOptions = {}): Promise<WriteResponse> {
        if (call.deadlineMs !== undefined && (!Number.isFinite(call.deadlineMs) || call.deadlineMs <= 0)) { return fail('temporary'); }
        const authorization = options.authorization(auth);
        const base: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
        let sent = false;
        const recording: FetchLike = (input, init) => {
            sent = true;
            return base(input, init);
        };
        const guarded = createGuardedFetch(recording, {
            timeoutMs: Math.min(WRITE_TIMEOUT_MS, call.deadlineMs ?? WRITE_TIMEOUT_MS),
            maxResponseBytes: MAX_WRITE_RESPONSE_BYTES,
            truncateBody: true,
            skipBody: isDefinitiveSuccess,
            keepStatusOnBodyFailure: true,
            followRedirects: false,
            preserveMethod: true,
            validateUrl: (url, raw) => {
                if (url.origin !== target.home.origin || canonicalizeServerHref(raw, url.href) !== target.href || canonicalizeServerHref(url.href, target.home.href) !== target.href) { fail('protocol'); }
            },
        });
        let response: Response;
        try {
            response = await guarded(target.url.href, {
                method,
                headers: { authorization, ...headers },
                ...(body === null ? {} : { body }),
                ...(call.signal ? { signal: call.signal } : {}),
            });
        } catch (error) {
            // Before the request reached the transport nothing can have been applied; after it, anything may have been.
            if (!sent) { throw error instanceof CalDavError ? error : new CalDavError('temporary'); }
            return { kind: 'uncertain' };
        }
        const { status } = response;
        if (status === 401) { throw new CalDavError('unauthorized'); }
        if (status >= 300 && status < 400) { return { kind: 'redirected', status }; }
        // The status is the answer from here on: a body that cannot be read only empties the summary, never the status.
        let bytes: Uint8Array;
        let lost = false;
        try { bytes = new Uint8Array(await response.arrayBuffer()); } catch { bytes = new Uint8Array(0); lost = true; }
        return {
            kind: 'status',
            status,
            etag: strongEtag(response.headers.get('etag')),
            upstream: sanitizeUpstream(status, response.headers.get('content-type'), bytes, lost || isTruncatedResponse(response), accountMasks(auth, discovery)),
        };
    }

    return {
        async putEvent(auth, discovery, request, call) {
            const target = writeTarget(discovery, request.calendarId, request.href);
            const precondition: unknown = request.precondition;
            let condition: Record<string, string>;
            if (typeof precondition === 'object' && precondition !== null && 'kind' in precondition && precondition.kind === 'create') {
                condition = { 'if-none-match': '*' };
            } else if (typeof precondition === 'object' && precondition !== null && 'kind' in precondition && precondition.kind === 'match' && 'etag' in precondition) {
                const etag = strongEtag(precondition.etag);
                if (etag === null) { return fail('protocol'); }
                condition = { 'if-match': etag };
            } else {
                return fail('protocol');
            }
            if (typeof request.body !== 'string') { return fail('protocol'); }
            if (Buffer.byteLength(request.body, 'utf8') > MAX_RESOURCE_BYTES) { return fail('too_large'); }
            return send(auth, discovery, target, 'PUT', { 'content-type': 'text/calendar; charset=utf-8', ...condition }, request.body, call);
        },

        async deleteEvent(auth, discovery, request, call) {
            const target = writeTarget(discovery, request.calendarId, request.href);
            const etag = strongEtag(request.etag);
            if (etag === null) { return fail('protocol'); }
            return send(auth, discovery, target, 'DELETE', { 'if-match': etag }, null, call);
        },
    };
}
