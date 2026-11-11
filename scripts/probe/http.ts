import { isAllowedProbeUrl } from './hosts';
import { parseRetryAfter, type Taint } from './safe';
import { PROBE_VERSION } from './version';
import type { HTTP_ERROR_CODES } from './vocabulary';

/**
 * The only path from the probe to the network. It enforces, before every request
 * (including each redirect hop): the fixed-host rule, the method policy for the run
 * mode, the 401 latch, pacing, a total request cap, a per-request timeout, a body cap,
 * and a stop after repeated throttling. Errors carry fixed codes only.
 *
 * 401 latch: after the first HTTP 401 from any request, nothing else is sent in this
 * run. The one exception is a single essential DELETE per temporary calendar the probe
 * registered (so it can try once to remove what it created); if that DELETE is also
 * answered 401, even that stops. Repeated failed sign-ins can lock an Apple ID.
 */
export type HttpMode = 'read' | 'write' | 'cleanup';

export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];

export class ProbeHttpError extends Error {
    constructor(public readonly code: HttpErrorCode) {
        super(code);
        this.name = 'ProbeHttpError';
    }
}

export interface HttpLimits {
    minIntervalMs: number;
    maxRequests: number;
    /** Requests held back for essential cleanup (deleting temporary calendars). */
    reserveRequests: number;
    timeoutMs: number;
    /** Timeout of an essential (cleanup) request; shorter, so the whole cleanup fits the reserve. */
    cleanupTimeoutMs: number;
    /** Longest pacing or throttle cool-down an essential request waits for. */
    maxEssentialWaitMs: number;
    maxBodyBytes: number;
    maxRedirects: number;
    /** Below this much remaining time, only essential requests are sent. */
    deadlineReserveMs: number;
    /** After this many 429/503 responses, only essential requests are sent. */
    maxThrottles: number;
}

/**
 * Most essential requests a --write run can need: for each of at most two temporary
 * calendars, at most two URLs (the requested one and a server-chosen Location), each with
 * up to two DELETE attempts and one verifying PROPFIND; plus one final listing of the home.
 */
export const MAX_CLEANUP_REQUESTS = 2 * 2 * (2 + 1) + 1;

const CLEANUP_TIMEOUT_MS = 8_000;
const MAX_ESSENTIAL_WAIT_MS = 2_000;

export const DEFAULT_HTTP_LIMITS: HttpLimits = {
    minIntervalMs: 150,
    maxRequests: 400,
    reserveRequests: 25,
    timeoutMs: 20_000,
    cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
    maxEssentialWaitMs: MAX_ESSENTIAL_WAIT_MS,
    maxBodyBytes: 8 * 1024 * 1024,
    maxRedirects: 3,
    // Every cleanup request, plus one spare, at its worst case: 14 x 10 s = 140 s.
    deadlineReserveMs: (MAX_CLEANUP_REQUESTS + 1) * (CLEANUP_TIMEOUT_MS + MAX_ESSENTIAL_WAIT_MS),
    maxThrottles: 3,
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProbeHttpOptions {
    fetch: FetchLike;
    now(): number;
    sleep(ms: number): Promise<void>;
    auth: { appleId: string; appPassword: string };
    mode: HttpMode;
    taint: Taint;
    limits?: Partial<HttpLimits>;
    signal?: AbortSignal;
    remainingMs?: () => number;
}

export interface ProbeRequest {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    /** Cleanup requests: allowed past the cap reserve, the deadline, throttling and interruption. */
    essential?: boolean;
    /** Default true. The burst measurement turns pacing off. */
    paced?: boolean;
    /** Default true. The backend adapter sees each hop itself. */
    followRedirects?: boolean;
}

export interface ProbeResponse {
    status: number;
    headers: Headers;
    body: string;
    url: string;
    redirects: number;
    redirectStatuses: number[];
    elapsedMs: number;
}

export interface HttpStats {
    requests: number;
    latencies: { method: string; ms: number }[];
    statuses: Record<string, number>;
    headerNames: string[];
    throttles: { status: number; retryAfterSeconds: number | null }[];
}

const READ_METHODS = new Set(['OPTIONS', 'PROPFIND', 'REPORT', 'GET']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PROBE_COLLECTION = /^caldav-mcp-probe-[0-9a-f]{8}$/;
const UNTAINTED_HEADERS = new Set([
    'content-type', 'content-length', 'date', 'connection', 'transfer-encoding', 'vary', 'cache-control',
    'allow', 'dav', 'retry-after', 'server', 'keep-alive', 'content-encoding', 'strict-transport-security', 'accept-ranges',
]);

/** The collection URL when it is exactly one path segment below the home (and passes the host rule). */
export function directChildOf(url: string, home: string): URL | undefined {
    if (!isAllowedProbeUrl(url) || !isAllowedProbeUrl(home)) {
        return undefined;
    }
    const target = new URL(url);
    const base = new URL(home);
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    if (target.origin !== base.origin || !target.pathname.startsWith(basePath)) {
        return undefined;
    }
    const rest = target.pathname.slice(basePath.length);
    if (!/^[^/]+\/$/.test(rest) || target.search !== '' || target.hash !== '') {
        return undefined;
    }
    return target;
}

/** The last path segment of a direct child of the home, if it has the probe's exact form. */
export function probeSegment(url: string, home: string): string | undefined {
    const segment = directChildOf(url, home)?.pathname.split('/').at(-2);
    return segment !== undefined && PROBE_COLLECTION.test(segment) ? segment : undefined;
}

interface Registered {
    url: URL;
    /** The requested probe URL this collection belongs to; one post-401 DELETE per group. */
    group: string;
}

export class ProbeHttp {
    private readonly limits: HttpLimits;
    private readonly authorization: string;
    private readonly collections: Registered[] = [];
    private requestCount = 0;
    private rejected = false;
    private rejectedFirst = false;
    /** After the latch: groups that already had their one DELETE attempt. */
    private readonly latchDeletes = new Set<string>();
    private latchDeleteRejected = false;
    private lastSentAt: number | undefined;
    private cooldownUntil = 0;
    private readonly latencies: { method: string; ms: number }[] = [];
    private readonly statuses: Record<string, number> = {};
    private readonly headerNames = new Set<string>();
    private readonly throttles: { status: number; retryAfterSeconds: number | null }[] = [];

    constructor(private readonly options: ProbeHttpOptions) {
        this.limits = { ...DEFAULT_HTTP_LIMITS, ...options.limits };
        const pair = `${options.auth.appleId}:${options.auth.appPassword}`;
        const encoded = Buffer.from(pair, 'utf8').toString('base64');
        this.authorization = `Basic ${encoded}`;
        options.taint.add(options.auth.appleId);
        options.taint.add(options.auth.appPassword);
        options.taint.add(pair);
        options.taint.add(encoded);
    }

    get mode(): HttpMode {
        return this.options.mode;
    }

    /** True once any response was HTTP 401. */
    get credentialsRejected(): boolean {
        return this.rejected;
    }

    /** True when the very first request sent in this run was answered 401. */
    get rejectedOnFirstRequest(): boolean {
        return this.rejectedFirst;
    }

    /** Allows MKCALENDAR, PUT and DELETE in one probe-named calendar directly under the home. */
    registerProbeCollection(url: string, home: string): void {
        if (this.options.mode !== 'write') {
            throw new ProbeHttpError('method_not_allowed');
        }
        const target = directChildOf(url, home);
        if (target === undefined || probeSegment(url, home) === undefined) {
            throw new ProbeHttpError('write_outside_probe_calendar');
        }
        this.collections.push({ url: target, group: target.href });
    }

    /**
     * Write mode: allows PUT and DELETE in a calendar the server says it created at its own
     * URL (MKCALENDAR Location) for an already registered probe URL. The URL must be a direct
     * child of the home that was not in the home listing taken before the run's writes.
     */
    registerCreatedCollection(url: string, home: string, existing: ReadonlySet<string>, requested: string): void {
        if (this.options.mode !== 'write') {
            throw new ProbeHttpError('method_not_allowed');
        }
        const target = directChildOf(url, home);
        const group = this.collections.find((c) => c.url.href === requested && c.group === requested);
        if (target === undefined || group === undefined || existing.has(target.href) || this.collections.some((c) => c.url.href === target.href)) {
            throw new ProbeHttpError('write_outside_probe_calendar');
        }
        this.collections.push({ url: target, group: group.group });
    }

    /**
     * Cleanup mode: allows DELETE of one collection directly under the home, and only when
     * both its display name and its URL segment are exactly caldav-mcp-probe-<8 hex> and equal.
     */
    registerLeftoverCollection(url: string, home: string, displayName: string): void {
        if (this.options.mode !== 'cleanup') {
            throw new ProbeHttpError('method_not_allowed');
        }
        const target = directChildOf(url, home);
        const segment = probeSegment(url, home);
        if (target === undefined || segment === undefined || !PROBE_COLLECTION.test(displayName) || segment !== displayName) {
            throw new ProbeHttpError('write_outside_probe_calendar');
        }
        this.collections.push({ url: target, group: target.href });
    }

    private matching(url: string, allowSelf: boolean, allowChild: boolean): Registered | undefined {
        const target = new URL(url);
        return this.collections.find(({ url: collection }) => {
            if (target.origin !== collection.origin || target.search !== '') {
                return false;
            }
            if (target.pathname === collection.pathname) {
                return allowSelf;
            }
            return allowChild && target.pathname.startsWith(collection.pathname);
        });
    }

    private isUnderCollection(url: string, allowSelf: boolean, allowChild: boolean): boolean {
        return this.matching(url, allowSelf, allowChild) !== undefined;
    }

    /** The 401 latch. Throws unless this is the one permitted post-401 DELETE of a probe calendar. */
    private checkLatch(method: string, url: string, request: ProbeRequest, hop: number): void {
        if (!this.rejected) {
            return;
        }
        const allowed = !this.latchDeleteRejected && hop === 0 && request.essential === true && method === 'DELETE' && this.options.mode === 'write';
        const collection = allowed ? this.matching(url, true, false) : undefined;
        if (collection === undefined || this.latchDeletes.has(collection.group)) {
            throw new ProbeHttpError('unauthorized');
        }
        this.latchDeletes.add(collection.group);
    }

    private checkPolicy(method: string, url: string): void {
        if (READ_METHODS.has(method)) {
            return;
        }
        const mode = this.options.mode;
        if (mode === 'read') {
            throw new ProbeHttpError('method_not_allowed');
        }
        if (mode === 'cleanup') {
            if (method !== 'DELETE') {
                throw new ProbeHttpError('method_not_allowed');
            }
            if (!this.isUnderCollection(url, true, false)) {
                throw new ProbeHttpError('write_outside_probe_calendar');
            }
            return;
        }
        let allowed: boolean;
        if (method === 'MKCALENDAR') {
            allowed = this.isUnderCollection(url, true, false);
        } else if (method === 'PUT') {
            allowed = this.isUnderCollection(url, false, true);
        } else if (method === 'DELETE') {
            allowed = this.isUnderCollection(url, true, true);
        } else {
            throw new ProbeHttpError('method_not_allowed');
        }
        if (!allowed) {
            throw new ProbeHttpError('write_outside_probe_calendar');
        }
    }

    private async beforeSend(request: ProbeRequest): Promise<void> {
        const essential = request.essential === true;
        if (!essential && this.options.signal?.aborted === true) {
            throw new ProbeHttpError('interrupted');
        }
        if (!essential && this.throttles.length >= this.limits.maxThrottles) {
            throw new ProbeHttpError('throttled_abort');
        }
        if (!essential && this.options.remainingMs !== undefined && this.options.remainingMs() < this.limits.deadlineReserveMs) {
            throw new ProbeHttpError('deadline');
        }
        const cap = essential ? this.limits.maxRequests : this.limits.maxRequests - this.limits.reserveRequests;
        if (this.requestCount >= cap) {
            throw new ProbeHttpError('request_cap');
        }
        this.requestCount++;
        let wait = this.cooldownUntil - this.options.now();
        if (request.paced !== false && this.lastSentAt !== undefined) {
            wait = Math.max(wait, this.lastSentAt + this.limits.minIntervalMs - this.options.now());
        }
        if (essential) {
            wait = Math.min(wait, this.limits.maxEssentialWaitMs);
        }
        if (wait > 0) {
            await this.options.sleep(wait);
        }
        this.lastSentAt = this.options.now();
    }

    /** Essential requests get the short cleanup timeout; others never run into the deadline reserve. */
    private timeoutFor(request: ProbeRequest): number {
        if (request.essential === true) {
            return this.limits.cleanupTimeoutMs;
        }
        const remaining = this.options.remainingMs?.();
        if (remaining === undefined) {
            return this.limits.timeoutMs;
        }
        return Math.max(1, Math.min(this.limits.timeoutMs, remaining - this.limits.deadlineReserveMs));
    }

    private async readCapped(response: Response): Promise<string> {
        const reader = response.body?.getReader();
        if (reader === undefined) {
            return '';
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            size += value.byteLength;
            if (size > this.limits.maxBodyBytes) {
                await reader.cancel().catch(() => undefined);
                throw new ProbeHttpError('body_too_large');
            }
            chunks.push(value);
        }
        return new TextDecoder().decode(Buffer.concat(chunks));
    }

    private async sendOnce(method: string, url: string, request: ProbeRequest, body: string | undefined): Promise<{ response: Response; text: string | undefined; elapsedMs: number }> {
        const headers = new Headers(request.headers);
        headers.set('authorization', this.authorization);
        headers.set('user-agent', `caldav-mcp-probe/${PROBE_VERSION}`);
        if (body !== undefined && !headers.has('content-type')) {
            headers.set('content-type', 'application/xml; charset=utf-8');
        }
        const controller = new AbortController();
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                reject(new ProbeHttpError('timeout'));
            }, this.timeoutFor(request));
        });
        const started = this.options.now();
        const work = (async () => {
            let response: Response;
            try {
                response = await this.options.fetch(url, { method, headers, redirect: 'manual', signal: controller.signal, ...(body === undefined ? {} : { body }) });
            } catch {
                throw new ProbeHttpError(timedOut ? 'timeout' : 'network');
            }
            if (REDIRECTS.has(response.status) && response.headers.has('location') && request.followRedirects !== false) {
                await response.body?.cancel().catch(() => undefined);
                return { response, text: undefined };
            }
            try {
                return { response, text: await this.readCapped(response) };
            } catch (error) {
                if (error instanceof ProbeHttpError) {
                    throw error;
                }
                throw new ProbeHttpError(timedOut ? 'timeout' : 'network');
            }
        })();
        try {
            const result = await Promise.race([work, timeout]);
            return { ...result, elapsedMs: this.options.now() - started };
        } finally {
            clearTimeout(timer);
            work.catch(() => undefined);
        }
    }

    private record(method: string, response: Response, elapsedMs: number): void {
        if (response.status === 401) {
            if (this.rejected) {
                // The one permitted cleanup DELETE was refused too: stop everything.
                this.latchDeleteRejected = true;
            } else {
                this.rejected = true;
                this.rejectedFirst = this.requestCount === 1;
            }
        }
        this.latencies.push({ method, ms: elapsedMs });
        const key = String(response.status);
        this.statuses[key] = (this.statuses[key] ?? 0) + 1;
        response.headers.forEach((value, name) => {
            const lower = name.toLowerCase();
            this.headerNames.add(lower);
            if (!UNTAINTED_HEADERS.has(lower)) {
                this.options.taint.add(value);
                if (lower === 'location' || lower === 'content-location') {
                    this.options.taint.addHref(value);
                }
            }
        });
        if (response.status === 429 || response.status === 503) {
            const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'), this.options.now());
            this.throttles.push({ status: response.status, retryAfterSeconds });
            const seconds = Math.min(retryAfterSeconds ?? 5, 30);
            this.cooldownUntil = Math.max(this.cooldownUntil, this.options.now() + seconds * 1000);
        }
    }

    async request(request: ProbeRequest): Promise<ProbeResponse> {
        let method = request.method.toUpperCase();
        let url = request.url;
        let body = request.body;
        const redirectStatuses: number[] = [];
        let elapsedTotal = 0;
        for (let hop = 0; hop <= this.limits.maxRedirects; hop++) {
            if (!isAllowedProbeUrl(url)) {
                throw new ProbeHttpError('forbidden_host');
            }
            this.checkPolicy(method, url);
            this.checkLatch(method, url, request, hop);
            await this.beforeSend(request);
            const { response, text, elapsedMs } = await this.sendOnce(method, url, request, body);
            elapsedTotal += elapsedMs;
            this.record(method, response, elapsedMs);
            if (text === undefined) {
                redirectStatuses.push(response.status);
                url = new URL(response.headers.get('location') ?? '', url).href;
                if (response.status === 303) {
                    method = 'GET';
                    body = undefined;
                }
                continue;
            }
            return { status: response.status, headers: response.headers, body: text, url, redirects: redirectStatuses.length, redirectStatuses, elapsedMs: elapsedTotal };
        }
        throw new ProbeHttpError('too_many_redirects');
    }

    stats(): HttpStats {
        return {
            requests: this.requestCount,
            latencies: [...this.latencies],
            statuses: { ...this.statuses },
            headerNames: [...this.headerNames].toSorted(),
            throttles: [...this.throttles],
        };
    }

    /**
     * A `fetch` for the skeleton backend: one hop per call through the same host rule,
     * method policy, pacing and cap. The backend sees redirects itself.
     */
    fetchAdapter(): typeof fetch {
        const adapter = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const incoming = new Request(input, init);
            const headers: Record<string, string> = {};
            incoming.headers.forEach((value, name) => {
                headers[name] = value;
            });
            const body = incoming.body === null ? undefined : await incoming.text();
            const result = await this.request({ method: incoming.method, url: incoming.url, headers, ...(body === undefined ? {} : { body }), followRedirects: false });
            const nullBody = result.status === 204 || result.status === 304 || REDIRECTS.has(result.status);
            return new Response(nullBody ? null : result.body, { status: result.status, headers: result.headers });
        };
        return adapter as unknown as typeof fetch;
    }
}
