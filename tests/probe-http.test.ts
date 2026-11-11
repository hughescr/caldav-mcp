import { describe, expect, test } from 'bun:test';
import { ProbeHttp, ProbeHttpError, type HttpMode } from '../scripts/probe/http';
import { Taint } from '../scripts/probe/safe';

interface Sent { method: string; url: string; headers: Headers; at: number }

function setup(mode: HttpMode, respond: (req: Request) => Response | Promise<Response> = () => new Response('ok', { status: 207 }), limits: Record<string, number> = {}) {
    let clock = 1_000_000;
    const sent: Sent[] = [];
    const sleeps: number[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        sent.push({ method: req.method, url: req.url, headers: req.headers, at: clock });
        clock += 5;
        return respond(req);
    };
    const http = new ProbeHttp({
        fetch: fetchImpl,
        now: () => clock,
        sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
            await Promise.resolve();
        },
        auth: { appleId: 'user@example.invalid', appPassword: 'abcd-efgh-ijkl-mnop' },
        mode,
        taint: new Taint(),
        limits: { minIntervalMs: 150, maxRequests: 20, reserveRequests: 4, timeoutMs: 20_000, maxBodyBytes: 1024, maxRedirects: 3, ...limits },
    });
    return { http, sent, sleeps };
}

async function code(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
        return 'resolved';
    } catch (error) {
        return error instanceof ProbeHttpError ? error.code : 'other';
    }
}

const HOME = 'https://p42-caldav.icloud.com/10000000001/calendars/';

describe('host rule', () => {
    test('a forbidden host is refused before anything is sent', async () => {
        const { http, sent } = setup('read');
        expect(await code(http.request({ method: 'PROPFIND', url: 'https://evil.example/' }))).toBe('forbidden_host');
        expect(await code(http.request({ method: 'GET', url: 'http://caldav.icloud.com/' }))).toBe('forbidden_host');
        expect(sent.length).toBe(0);
    });

    test('redirects are followed manually only to allowed hosts and re-checked', async () => {
        const { http, sent } = setup('read', (req) => {
            if (req.url === 'https://caldav.icloud.com/.well-known/caldav') {
                return new Response(null, { status: 301, headers: { location: '/' } });
            }
            if (req.url === 'https://caldav.icloud.com/') {
                return new Response(null, { status: 302, headers: { location: 'https://p42-caldav.icloud.com/x/' } });
            }
            if (req.url === 'https://p42-caldav.icloud.com/x/') {
                return new Response(null, { status: 307, headers: { location: 'https://attacker.example/steal' } });
            }
            return new Response('no', { status: 500 });
        });
        expect(await code(http.request({ method: 'PROPFIND', url: 'https://caldav.icloud.com/.well-known/caldav' }))).toBe('forbidden_host');
        expect(sent.map((s) => new URL(s.url).hostname)).toEqual(['caldav.icloud.com', 'caldav.icloud.com', 'p42-caldav.icloud.com']);
    });

    test('redirect hops are counted and capped', async () => {
        const { http } = setup('read', () => new Response(null, { status: 301, headers: { location: '/again' } }));
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/' }))).toBe('too_many_redirects');
        const ok = setup('read', (req) => (req.url.endsWith('/end') ? new Response('fine', { status: 200 }) : new Response(null, { status: 308, headers: { location: '/end' } })));
        const res = await ok.http.request({ method: 'PROPFIND', url: 'https://caldav.icloud.com/' });
        expect(res.status).toBe(200);
        expect(res.redirects).toBe(1);
        expect(res.redirectStatuses).toEqual([308]);
        expect(ok.sent[1]?.method).toBe('PROPFIND');
    });

    test('every request carries Basic auth and redirect manual', async () => {
        const { http, sent } = setup('read');
        await http.request({ method: 'OPTIONS', url: 'https://caldav.icloud.com/' });
        expect(sent[0]?.headers.get('authorization')).toBe(`Basic ${btoa('user@example.invalid:abcd-efgh-ijkl-mnop')}`);
        expect(sent[0]?.headers.get('user-agent')).toMatch(/^caldav-mcp-probe\//);
    });
});

describe('write enforcement', () => {
    test('a read-only run can never issue a writing method', async () => {
        const { http, sent } = setup('read');
        for (const method of ['PUT', 'DELETE', 'MKCALENDAR', 'POST', 'PROPPATCH', 'MOVE', 'COPY', 'PATCH', 'LOCK', 'MKCOL', 'put']) {
            expect(await code(http.request({ method, url: `${HOME}x/y.ics` }))).toBe('method_not_allowed');
        }
        expect(() => http.registerProbeCollection(`${HOME}caldav-mcp-probe-0a1b2c3d/`, HOME)).toThrow(ProbeHttpError);
        expect(sent.length).toBe(0);
    });

    test('a write run only writes under a registered probe calendar', async () => {
        const { http, sent } = setup('write', () => new Response(null, { status: 201 }));
        const probe = `${HOME}caldav-mcp-probe-0a1b2c3d/`;
        expect(await code(http.request({ method: 'PUT', url: `${probe}e.ics`, body: 'x' }))).toBe('write_outside_probe_calendar');
        expect(await code(http.request({ method: 'MKCALENDAR', url: probe }))).toBe('write_outside_probe_calendar');
        http.registerProbeCollection(probe, HOME);
        expect(await code(http.request({ method: 'MKCALENDAR', url: probe }))).toBe('resolved');
        expect(await code(http.request({ method: 'PUT', url: `${probe}e.ics`, body: 'x' }))).toBe('resolved');
        expect(await code(http.request({ method: 'DELETE', url: `${probe}e.ics` }))).toBe('resolved');
        expect(await code(http.request({ method: 'DELETE', url: probe }))).toBe('resolved');
        for (const url of [
            `${HOME}personal/e.ics`,
            `${HOME}caldav-mcp-probe-0a1b2c3dX/e.ics`,
            `${HOME}caldav-mcp-probe-0a1b2c3d/../personal/e.ics`,
            `${HOME}caldav-mcp-probe-0a1b2c3d/%2e%2e/personal/e.ics`,
            `https://p43-caldav.icloud.com/10000000001/calendars/caldav-mcp-probe-0a1b2c3d/e.ics`,
            HOME,
        ]) {
            expect(await code(http.request({ method: 'PUT', url, body: 'x' }))).not.toBe('resolved');
            expect(await code(http.request({ method: 'DELETE', url }))).not.toBe('resolved');
        }
        expect(await code(http.request({ method: 'PUT', url: probe, body: 'x' }))).toBe('write_outside_probe_calendar');
        expect(await code(http.request({ method: 'POST', url: `${probe}e.ics` }))).toBe('method_not_allowed');
        expect(await code(http.request({ method: 'PROPPATCH', url: probe }))).toBe('method_not_allowed');
        expect(sent.map((s) => s.method)).toEqual(['MKCALENDAR', 'PUT', 'DELETE', 'DELETE']);
    });

    test('a write that is redirected elsewhere is refused at the redirect', async () => {
        const probe = `${HOME}caldav-mcp-probe-0a1b2c3d/`;
        const { http, sent } = setup('write', () => new Response(null, { status: 307, headers: { location: `${HOME}personal/e.ics` } }));
        http.registerProbeCollection(probe, HOME);
        expect(await code(http.request({ method: 'PUT', url: `${probe}e.ics`, body: 'x' }))).toBe('write_outside_probe_calendar');
        expect(sent.length).toBe(1);
    });

    test('registration only accepts a probe-named direct child of the home', () => {
        const { http } = setup('write');
        expect(() => http.registerProbeCollection(`${HOME}personal/`, HOME)).toThrow(ProbeHttpError);
        expect(() => http.registerProbeCollection(`${HOME}a/caldav-mcp-probe-0a1b2c3d/`, HOME)).toThrow(ProbeHttpError);
        expect(() => http.registerProbeCollection(HOME, HOME)).toThrow(ProbeHttpError);
        expect(() => http.registerProbeCollection(`https://evil.example/caldav-mcp-probe-0a1b2c3d/`, HOME)).toThrow(ProbeHttpError);
    });

    test('a cleanup run may only DELETE registered collections', async () => {
        const { http, sent } = setup('cleanup', () => new Response(null, { status: 204 }));
        const leftover = `${HOME}caldav-mcp-probe-3f2b6a10/`;
        expect(await code(http.request({ method: 'DELETE', url: leftover }))).toBe('write_outside_probe_calendar');
        expect(() => http.registerLeftoverCollection(`${HOME}3F2B6A10-AAAA-4BBB-8CCC-000000000001/`, HOME, 'caldav-mcp-probe-3f2b6a10')).toThrow(ProbeHttpError);
        http.registerLeftoverCollection(leftover, HOME, 'caldav-mcp-probe-3f2b6a10');
        expect(await code(http.request({ method: 'DELETE', url: leftover }))).toBe('resolved');
        expect(await code(http.request({ method: 'PUT', url: `${leftover}e.ics`, body: 'x' }))).toBe('method_not_allowed');
        expect(await code(http.request({ method: 'MKCALENDAR', url: leftover }))).toBe('method_not_allowed');
        expect(sent.length).toBe(1);
    });
});

describe('gentleness', () => {
    test('requests are spaced at least 150 ms apart unless unpaced', async () => {
        const { http, sent } = setup('read');
        await http.request({ method: 'OPTIONS', url: 'https://caldav.icloud.com/' });
        await http.request({ method: 'OPTIONS', url: 'https://caldav.icloud.com/' });
        await http.request({ method: 'OPTIONS', url: 'https://caldav.icloud.com/' });
        const gaps = sent.slice(1).map((s, i) => s.at - (sent[i]?.at ?? 0));
        expect(gaps.every((gap) => gap >= 150)).toBe(true);
        await http.request({ method: 'OPTIONS', url: 'https://caldav.icloud.com/', paced: false });
        expect((sent[3]?.at ?? 0) - (sent[2]?.at ?? 0)).toBeLessThan(150);
    });

    test('the total request cap holds a reserve back for essential cleanup', async () => {
        const { http } = setup('read', () => new Response('x', { status: 200 }), { maxRequests: 5, reserveRequests: 2 });
        for (let i = 0; i < 3; i++) {
            await http.request({ method: 'GET', url: 'https://caldav.icloud.com/' });
        }
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/' }))).toBe('request_cap');
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/', essential: true }))).toBe('resolved');
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/', essential: true }))).toBe('resolved');
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/', essential: true }))).toBe('request_cap');
        expect(http.stats().requests).toBe(5);
    });

    test('a request that never answers times out', async () => {
        const { http } = setup('read', (req) => new Promise((_resolve, reject) => {
            req.signal.addEventListener('abort', () => { reject(new Error('aborted')); });
        }), { timeoutMs: 15 });
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/' }))).toBe('timeout');
    });

    test('network failures and oversized bodies get fixed codes', async () => {
        const failing = setup('read', () => { throw new Error('secret detail'); });
        expect(await code(failing.http.request({ method: 'GET', url: 'https://caldav.icloud.com/' }))).toBe('network');
        const big = setup('read', () => new Response('x'.repeat(2048), { status: 200 }));
        expect(await code(big.http.request({ method: 'GET', url: 'https://caldav.icloud.com/' }))).toBe('body_too_large');
    });

    test('429 and 503 are recorded with Retry-After, cool down, and repeated throttling stops the run', async () => {
        const { http, sleeps } = setup('read', () => new Response('slow down', { status: 429, headers: { 'retry-after': '7', 'x-ratelimit-remaining': '0' } }));
        const first = await http.request({ method: 'GET', url: 'https://caldav.icloud.com/' });
        expect(first.status).toBe(429);
        await http.request({ method: 'GET', url: 'https://caldav.icloud.com/' });
        expect(sleeps.some((ms) => ms >= 7000)).toBe(true);
        await http.request({ method: 'GET', url: 'https://caldav.icloud.com/' });
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/' }))).toBe('throttled_abort');
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/', essential: true }))).toBe('resolved');
        const stats = http.stats();
        expect(stats.throttles[0]).toEqual({ status: 429, retryAfterSeconds: 7 });
        expect(stats.headerNames).toContain('x-ratelimit-remaining');
    });

    test('an aborted run refuses non-essential requests but still allows cleanup', async () => {
        const controller = new AbortController();
        let clock = 0;
        const http = new ProbeHttp({
            fetch: async () => new Response('x', { status: 200 }),
            now: () => clock++,
            sleep: async () => {},
            auth: { appleId: 'a@example.invalid', appPassword: 'p' },
            mode: 'read',
            taint: new Taint(),
            signal: controller.signal,
        });
        controller.abort();
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/' }))).toBe('interrupted');
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/', essential: true }))).toBe('resolved');
    });

    test('a deadline refuses non-essential requests', async () => {
        let remaining = 100_000;
        const http = new ProbeHttp({
            fetch: async () => new Response('x', { status: 200 }),
            now: () => 0,
            sleep: async () => {},
            auth: { appleId: 'a@example.invalid', appPassword: 'p' },
            mode: 'read',
            taint: new Taint(),
            remainingMs: () => remaining,
            limits: { deadlineReserveMs: 20_000 },
        });
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/' }))).toBe('resolved');
        remaining = 10_000;
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/' }))).toBe('deadline');
        expect(await code(http.request({ method: 'GET', url: 'https://caldav.icloud.com/', essential: true }))).toBe('resolved');
    });
});

describe('fetch adapter for the skeleton backend', () => {
    test('passes single hops through the same guard and policy', async () => {
        const { http, sent } = setup('read', (req) => (req.url.endsWith('/r') ? new Response(null, { status: 301, headers: { location: '/' } }) : new Response('<x/>', { status: 207, headers: { etag: '"e"' } })));
        const adapted = http.fetchAdapter();
        const res = await adapted('https://caldav.icloud.com/r', { method: 'PROPFIND', redirect: 'manual' });
        expect(res.status).toBe(301);
        const ok = await adapted('https://caldav.icloud.com/', { method: 'PROPFIND', body: '<a/>' });
        expect(ok.status).toBe(207);
        expect(await ok.text()).toBe('<x/>');
        await expect(adapted('https://evil.example/', {})).rejects.toBeInstanceOf(ProbeHttpError);
        await expect(adapted(`${HOME}x/y.ics`, { method: 'PUT', body: 'x' })).rejects.toBeInstanceOf(ProbeHttpError);
        expect(sent.length).toBe(2);
    });
});
