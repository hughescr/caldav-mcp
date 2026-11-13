/**
 * Fixed-host rule and guarded fetch: the SSRF and credential-exfiltration control for all
 * upstream CalDAV traffic. Every request URL, including every redirect target, is checked
 * before anything is sent, so credentials can only ever reach Apple's CalDAV hosts.
 *
 * Decisions (see tests/caldav-hosts.test.ts):
 * - The check runs on the WHATWG-normalized URL, and the normalized href is what gets sent.
 *   Host case, IDNA mapping (e.g. full-width letters) and percent-encoded host bytes therefore
 *   resolve to the host the request would really reach. Lookalike labels become `xn--` and fail.
 * - `:443` written explicitly is the default port, which WHATWG URL normalizes to `''`; it is
 *   accepted because the destination is identical. iCloud returns its calendar-home-set hrefs as
 *   absolute URLs with an explicit `:443` port, as the read-only probe run of 2026-11-11
 *   confirmed. Any other port fails.
 * - A trailing-dot FQDN (`caldav.icloud.com.`) fails: it is not the exact host name.
 * - Too many redirects is reported as `forbidden_host`, like a redirect to a disallowed host.
 */
import { remainingRequestTimeMs } from '../request-budget';
import { BudgetError } from '../calendar/model';
import { CalDavError } from './contracts';
import type { ReadCharge } from './read-contracts';

export const ICLOUD_CALDAV_ROOT = 'https://caldav.icloud.com/';
export const MAX_REDIRECTS = 3;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Kept back from the request budget so the caller can still answer after a timeout. */
export const BUDGET_RESERVE_MS = 2_000;

const ROOT_HOST = 'caldav.icloud.com';
const PER_ACCOUNT_HOST = /^p\d{1,3}-caldav\.icloud\.com$/;
const MAX_EMPTY_CHUNKS = 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const REQUEST_BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location'];

/** The call shape this module needs; `typeof fetch` is assignable to it. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GuardedFetchOptions {
    /** Per-call timeout covering every redirect hop and the body read. Default 10 s. */
    timeoutMs?: number;
    /** Explicit read profile: streamed decompressed cap; generic phase-1 callers retain their defaults. */
    maxResponseBytes?: number;
    overflowCode?: 'protocol' | 'too_large';
    charge?: ReadCharge;
    /** Checks account/collection scope after the fixed-host rule, before every send. rawUrl is the redirect spelling. */
    validateUrl?: (url: URL, rawUrl: string) => void;
    /** Refuse method-rewriting redirects, and assert the final operation method. REPORT always enables this. */
    preserveMethod?: boolean;
    /**
     * Writes (`false`): a 3xx answer is returned bodiless and unfollowed, so a PUT or DELETE is never re-sent anywhere.
     * Default true.
     */
    followRedirects?: boolean;
    /**
     * Writes: keep at most `maxResponseBytes` of the body and stop reading, instead of failing, so the status of an answer
     * with a huge error body is still known. {@link isTruncatedResponse} reports the cut.
     */
    truncateBody?: boolean;
    /**
     * Writes: for a final status where this returns true, the body is cancelled unread and the Response has none. The status
     * and headers are the answer; the body can then neither stall nor fail it.
     */
    skipBody?: (status: number) => boolean;
    /**
     * Writes: once a final status has arrived, a body that fails or stalls past the timeout yields that status with an empty
     * body, marked by {@link isTruncatedResponse}, instead of an error. A shared charge's BudgetError still propagates.
     */
    keepStatusOnBodyFailure?: boolean;
}

const truncatedResponses = new WeakSet<Response>();

/** True when a guarded fetch with `truncateBody` cut this response's body, or `keepStatusOnBodyFailure` dropped it. */
export function isTruncatedResponse(response: Response): boolean {
    return truncatedResponses.has(response);
}

function parseUrl(url: unknown): URL | undefined {
    if (url instanceof URL) {
        return new URL(url.href);
    }
    if (typeof url !== 'string') {
        return undefined;
    }
    try {
        return new URL(url);
    } catch {
        return undefined;
    }
}

function passesRule(url: URL): boolean {
    return url.protocol === 'https:'
        && url.username === ''
        && url.password === ''
        && url.port === ''
        && (url.hostname === ROOT_HOST || PER_ACCOUNT_HOST.test(url.hostname));
}

export function isAllowedCalDavUrl(url: string | URL): boolean {
    const parsed = parseUrl(url);
    return parsed !== undefined && passesRule(parsed);
}

/** Returns a normalized copy of the URL, or throws CalDavError('forbidden_host'). */
export function assertAllowedCalDavUrl(url: string | URL): URL {
    const parsed = parseUrl(url);
    if (!parsed || !passesRule(parsed)) {
        throw new CalDavError('forbidden_host');
    }
    return parsed;
}

interface PreparedRequest {
    url: URL;
    method: string;
    headers: Headers;
    body: string | Uint8Array<ArrayBuffer> | null;
    signal: AbortSignal | undefined;
}

/** Bodies are buffered so a 307/308 can replay them. */
async function replayableBody(body: BodyInit | null | undefined): Promise<string | Uint8Array<ArrayBuffer> | null> {
    if (body === undefined || body === null) {
        return null;
    }
    if (typeof body === 'string') {
        return body;
    }
    return new Uint8Array(await new Response(body).arrayBuffer());
}

async function prepare(input: string | URL | Request, init: RequestInit | undefined): Promise<PreparedRequest> {
    const isRequest = input instanceof Request;
    // The host check comes first: nothing else is read from a disallowed input.
    const url = assertAllowedCalDavUrl(isRequest ? input.url : input);
    let method = isRequest ? input.method : 'GET';
    let headers = new Headers(isRequest ? input.headers : undefined);
    let body: BodyInit | null = null;
    let signal: AbortSignal | undefined = isRequest ? input.signal : undefined;
    if (init?.method !== undefined) {
        method = init.method;
    }
    if (init?.headers !== undefined) {
        headers = new Headers(init.headers);
    }
    if (init?.body !== undefined) {
        body = init.body;
    } else if (isRequest && input.body !== null) {
        body = await input.arrayBuffer();
    }
    if (init?.signal) {
        signal = init.signal;
    }
    return { url, method, headers, body: await replayableBody(body), signal };
}

function effectiveTimeoutMs(configured: number): number {
    const remaining = remainingRequestTimeMs();
    return remaining === undefined ? configured : Math.min(configured, remaining - BUDGET_RESERVE_MS);
}

/** Settles with the promise, or rejects with 'temporary' as soon as the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(new CalDavError('temporary'));
        if (signal.aborted) {
            promise.catch(() => undefined);
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

function discard(response: Response): void {
    response.body?.cancel().catch(() => undefined);
}

async function readCapped(response: Response, signal: AbortSignal, options: GuardedFetchOptions): Promise<{ bytes: Uint8Array<ArrayBuffer>; truncated: boolean }> {
    const cap = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > cap && options.truncateBody !== true) {
        discard(response);
        throw new CalDavError(options.overflowCode ?? 'protocol');
    }
    if (!response.body) {
        return { bytes: new Uint8Array(0), truncated: false };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let emptyChunks = 0;
    let truncated = false;
    try {
        for (;;) {
            const { done, value } = await abortable(reader.read(), signal);
            if (done) {
                break;
            }
            // Synchronously produced empty chunks never grow `total` and would starve the timeout timer.
            if (value.byteLength === 0 && ++emptyChunks > MAX_EMPTY_CHUNKS) {
                throw new CalDavError('protocol');
            }
            // Never refund failed reads, including the chunk crossing the per-response cap.
            options.charge?.chargeBytes(value.byteLength);
            if (total + value.byteLength > cap && options.truncateBody === true) {
                chunks.push(value.subarray(0, cap - total));
                total = cap;
                truncated = true;
                reader.cancel().catch(() => undefined);
                break;
            }
            total += value.byteLength;
            if (total > cap) {
                throw new CalDavError(options.overflowCode ?? 'protocol');
            }
            chunks.push(value);
        }
    } catch (error) {
        reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { bytes, truncated };
}

function nextHop(request: PreparedRequest, status: number, location: string, options: GuardedFetchOptions): PreparedRequest {
    let target: URL;
    try {
        target = new URL(location, request.url);
    } catch {
        throw new CalDavError('forbidden_host');
    }
    if (!passesRule(target)) {
        throw new CalDavError('forbidden_host');
    }
    options.validateUrl?.(target, location);
    const method = request.method.toUpperCase();
    if (status === 303 && method !== 'GET' && method !== 'HEAD' && (options.preserveMethod || method === 'REPORT')) {
        throw new CalDavError('protocol');
    }
    // Fetch-standard method rewriting: 303 (except HEAD), and 301/302 for POST, become a bodiless GET.
    if ((status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
        const headers = new Headers(request.headers);
        for (const name of REQUEST_BODY_HEADERS) {
            headers.delete(name);
        }
        return { ...request, url: target, method: 'GET', headers, body: null };
    }
    return { ...request, url: target };
}

/**
 * Wraps a fetch so that every request (and every redirect hop) must pass the fixed-host rule
 * before it is sent. Redirects are always handled here (`redirect: 'manual'` is forced), at most
 * MAX_REDIRECTS times. The returned Response is fully buffered (default MAX_RESPONSE_BYTES; a read
 * profile selects its own cap), and its `url` is the final URL. REPORT can never become GET; callers
 * may additionally require method preservation and account/collection scope on every hop.
 * Failures are bare CalDavError codes; a shared charge's BudgetError is preserved without refund.
 * Generic phase-1 overflow stays protocol; explicit read profiles use too_large.
 * Without `baseFetch`, the global fetch is looked up at call time.
 */
export function createGuardedFetch(baseFetch?: FetchLike, options: GuardedFetchOptions = {}): FetchLike {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError('timeoutMs must be a positive number');
    }
    const send: FetchLike = baseFetch ?? ((input, init) => globalThis.fetch(input, init));

    return async (input, init) => {
        let request = await prepare(input, init);
        const originalMethod = request.method.toUpperCase();
        options.validateUrl?.(request.url, request.url.href);
        const budgetMs = effectiveTimeoutMs(timeoutMs);
        if (budgetMs <= 0) {
            throw new CalDavError('temporary');
        }
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), budgetMs);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
        try {
            for (let redirects = 0; ; redirects += 1) {
                if (signal.aborted) {
                    throw new CalDavError('temporary');
                }
                const response = await abortable(
                    Promise.resolve().then(() => send(request.url.href, {
                        method: request.method,
                        headers: new Headers(request.headers),
                        body: request.body,
                        redirect: 'manual',
                        signal,
                    })),
                    signal,
                );
                const { status } = response;
                // Authentication is decided by headers, never by an untrusted error body or its read budget.
                if (status === 401) {
                    discard(response);
                    const unauthorized = new Response(null, { status: 401 });
                    Object.defineProperty(unauthorized, 'url', { value: request.url.href });
                    return unauthorized;
                }
                if (response.type === 'opaqueredirect' || status < 200 || status > 599) {
                    discard(response);
                    throw new CalDavError('protocol');
                }
                if (options.followRedirects === false && status >= 300 && status < 400) {
                    discard(response);
                    const unfollowed = new Response(null, { status });
                    Object.defineProperty(unfollowed, 'url', { value: request.url.href });
                    return unfollowed;
                }
                const location = REDIRECT_STATUSES.has(status) ? response.headers.get('location') : null;
                if (location !== null) {
                    discard(response);
                    if (redirects >= MAX_REDIRECTS) {
                        throw new CalDavError('forbidden_host');
                    }
                    const next = nextHop(request, status, location, options);
                    if ((options.preserveMethod || originalMethod === 'REPORT') && next.method.toUpperCase() !== originalMethod) {
                        throw new CalDavError('protocol');
                    }
                    request = next;
                    continue;
                }
                if ((options.preserveMethod || originalMethod === 'REPORT') && request.method.toUpperCase() !== originalMethod) {
                    discard(response);
                    throw new CalDavError('protocol');
                }
                if (options.skipBody?.(status) === true) {
                    discard(response);
                    const bodiless = new Response(null, { status, statusText: response.statusText, headers: response.headers });
                    Object.defineProperty(bodiless, 'url', { value: request.url.href });
                    return bodiless;
                }
                let read: { bytes: Uint8Array<ArrayBuffer>; truncated: boolean };
                try {
                    read = await readCapped(response, signal, options);
                } catch (error) {
                    if (options.keepStatusOnBodyFailure !== true || error instanceof BudgetError) { throw error; }
                    // The status is known; only the body is lost (readCapped has cancelled it).
                    read = { bytes: new Uint8Array(0), truncated: true };
                }
                const { bytes, truncated } = read;
                const buffered = new Response(NULL_BODY_STATUSES.has(status) ? null : bytes, {
                    status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
                Object.defineProperty(buffered, 'url', { value: request.url.href });
                if (truncated) { truncatedResponses.add(buffered); }
                return buffered;
            }
        } catch (error) {
            if (error instanceof CalDavError || error instanceof BudgetError) {
                throw error;
            }
            // Network failures and aborts: the cause is deliberately dropped (it may echo URLs or headers).
            throw new CalDavError('temporary');
        } finally {
            clearTimeout(timer);
        }
    };
}
