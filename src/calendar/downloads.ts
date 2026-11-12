/**
 * Staging of attachment bytes for download (design v3 section 5, "Private S3 stager"). Storage is behind the small
 * DownloadStore interface: production uses s3-download-store.ts, tests an in-memory fake.
 *
 * Decisions:
 * - Every download stages a fresh copy under a new unguessable key. There is no cache and no HEAD, so a copy can never
 *   outlive a change to the event or the attachment, and the runtime needs only PutObject and GetObject.
 * - Keys are `downloads/v1/<account namespace>/<256 random bits>`: the namespace is a hash of the pseudonymous account
 *   id, and no name, path, URL or event identifier appears in a key or in object metadata.
 * - The object is always served as an attachment with a sanitized filename, `Cache-Control: private, no-store`, and a
 *   safe content type: FMTTYPE when it is a plain type/subtype that browsers will not execute, otherwise
 *   application/octet-stream.
 */
import { createHash, randomBytes } from 'node:crypto';
import { MIME_MAX } from './limits';

/** Presigned links last at most five minutes. */
export const DOWNLOAD_URL_TTL_SECONDS = 300;
export const DOWNLOAD_KEY_PREFIX = 'downloads/v1/';
const FILENAME_UNITS = 180;
const URL_MAX = 8192;

export interface StagedObject {
    key: string;
    body: Uint8Array;
    contentType: string;
    contentDisposition: string;
}

export interface DownloadStore {
    /** Writes one private object. Rejects on any failure. */
    putObject(object: StagedObject, signal: AbortSignal): Promise<void>;
    /** A presigned GET for the key, valid for at most maxTtlSeconds. */
    presignGet(key: string, maxTtlSeconds: number): Promise<{ url: string; expiresAt: Date }>;
}

export class DownloadStageError extends Error {
    constructor(public readonly code: 'temporarily_unavailable' | 'verification_failed') { super(code); }
}

// ---- Filename and headers ----

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const STRIPPED = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩"'`]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

/** The last non-empty path segment of a URL, percent-decoded where that is well formed. */
function urlBasename(text: string | null): string | null {
    if (text === null) { return null; }
    let url: URL;
    try { url = new URL(text); } catch { return null; }
    const segment = url.pathname.split('/').findLast(part => part !== '');
    if (segment === undefined) { return null; }
    try { return decodeURIComponent(segment); } catch { return segment; }
}

/** Prefix of at most `units` UTF-16 units that does not split a surrogate pair. */
function unitPrefix(text: string, units: number): string {
    if (text.length <= units) { return text; }
    const last = text.charCodeAt(units - 1);
    return text.slice(0, last >= 0xD800 && last <= 0xDBFF ? units - 1 : units);
}

/**
 * The download filename: FILENAME (or X-APPLE-FILENAME), else the URL's last path segment, else `attachment`. NFC,
 * with control, bidi and quote characters removed, path separators replaced by `_`, trimmed and bounded.
 */
export function downloadFilename(filename: string | null, url: string | null): string {
    for (const candidate of [filename, urlBasename(url)]) {
        if (candidate === null) { continue; }
        const cleaned = unitPrefix(candidate.normalize('NFC').replace(LONE_SURROGATE, '').replace(STRIPPED, '').replace(/[/\\]/gu, '_').trim(), FILENAME_UNITS).trim();
        if (cleaned !== '' && cleaned !== '.' && cleaned !== '..') { return cleaned; }
    }
    return 'attachment';
}

/** RFC 6266 attachment disposition with an ASCII fallback and an RFC 5987 UTF-8 filename. */
export function contentDisposition(name: string): string {
    const ascii = name.replace(/[^A-Za-z0-9 ._-]/gu, '_');
    const encoded = encodeURIComponent(name).replace(/['()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const MIME_RE = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/u;
const ACTIVE_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml', 'text/xsl', 'application/xslt+xml']);

/** FMTTYPE without parameters when it is a plain, non-active type/subtype; otherwise application/octet-stream. */
export function safeContentType(declared: string | null): string {
    if (declared === null) { return 'application/octet-stream'; }
    const type = (declared.split(';')[0] ?? '').trim().toLowerCase();
    if (type.length > MIME_MAX || !MIME_RE.test(type)) { return 'application/octet-stream'; }
    if (ACTIVE_TYPES.has(type) || type.endsWith('+xml') || type.endsWith('/xml') || type.includes('javascript') || type.includes('ecmascript')) {
        return 'application/octet-stream';
    }
    return type;
}

/** A new unguessable key in the account's namespace. */
export function stagingKey(accountId: string): string {
    const namespace = createHash('sha256').update(JSON.stringify(['caldav-mcp/download-namespace/v1', accountId])).digest('hex');
    return `${DOWNLOAD_KEY_PREFIX}${namespace}/${randomBytes(32).toString('hex')}`;
}

// ---- Staging ----

export interface StageRequest {
    /** The authenticated pseudonymous account id, never caller input. */
    accountId: string;
    bytes: Uint8Array;
    filename: string | null;
    /** The ATTACH value for a URI attachment, used only for a fallback filename. */
    url: string | null;
    declaredContentType: string | null;
}

export interface StagedDownload {
    url: string;
    /** RFC 3339 UTC, whole seconds. */
    expiresAt: string;
    filename: string;
    contentType: string;
    size: number;
}

function wholeSecondsUtc(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** Writes one private object and presigns a short-lived GET for it. Never logs or returns the key. */
export async function stageDownload(store: DownloadStore, request: StageRequest, signal: AbortSignal, now: () => number = Date.now): Promise<StagedDownload> {
    const filename = downloadFilename(request.filename, request.url);
    const contentType = safeContentType(request.declaredContentType);
    const key = stagingKey(request.accountId);
    if (signal.aborted) { throw new DownloadStageError('temporarily_unavailable'); }
    let signed: { url: string; expiresAt: Date };
    try {
        await store.putObject({ key, body: request.bytes, contentType, contentDisposition: contentDisposition(filename) }, signal);
        if (signal.aborted) { throw new DownloadStageError('temporarily_unavailable'); }
        signed = await store.presignGet(key, DOWNLOAD_URL_TTL_SECONDS);
    } catch {
        // Store errors can carry AWS request details; only the fixed code leaves this function.
        throw new DownloadStageError('temporarily_unavailable');
    }
    const expiry = Math.floor(signed.expiresAt.getTime() / 1000) * 1000;
    const start = now();
    if (typeof signed.url !== 'string' || !signed.url.startsWith('https://') || signed.url.length > URL_MAX
        || !Number.isFinite(expiry) || expiry <= start || expiry > start + (DOWNLOAD_URL_TTL_SECONDS + 1) * 1000) {
        throw new DownloadStageError('verification_failed');
    }
    return { url: signed.url, expiresAt: wholeSecondsUtc(new Date(expiry)), filename, contentType, size: request.bytes.byteLength };
}
