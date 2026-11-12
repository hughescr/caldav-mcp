import { describe, expect, test } from 'bun:test';
import { runCli } from '../scripts/probe/cli';
import { runProbe } from '../scripts/probe/core';
import { ProbeHttp, ProbeHttpError } from '../scripts/probe/http';
import { Taint } from '../scripts/probe/safe';
import type { BackendLoad, ProbeFlags } from '../scripts/probe/types';
import { PLAIN, standardAccount, type FakeRequest } from './fixtures/probe/fake-icloud';
import { READ_ONLY, WRITE, fakeDeps, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const WRONG = { appleId: PLAIN.appleId, appPassword: 'wrong-wrong-wrong-wrong' };
const INVITE: ProbeFlags = { write: true, invite: true, cleanup: false };

function recordingBackend(): { load: () => Promise<BackendLoad>; calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        load: async () => {
            calls.push('load');
            return { status: 'loaded', module: { createICloudBackend: () => ({ discover: async () => { calls.push('discover'); throw new Error('x'); }, validate: async () => 'valid', listCalendars: async () => [] }) } };
        },
    };
}

describe('a rejected password is tried exactly once (M1)', () => {
    for (const [label, flags] of [['read-only', READ_ONLY], ['write', WRITE], ['invite', INVITE]] as const) {
        test(`${label}: exactly one authenticated request reaches the server`, async () => {
            const fake = standardAccount();
            const backend = recordingBackend();
            const report = await probe(fake, flags, WRONG, { loadBackend: backend.load }, flags.invite ? 'invitee@example.invalid' : undefined);
            expect(fake.requests.length).toBe(1);
            expect(fake.requests[0]?.headers.get('authorization')).not.toBeNull();
            expect(backend.calls).toEqual([]);
            expect(report.auth).toEqual({ rejected: true, onFirstRequest: true });
            const discovery = report.checks.find((c) => c.id === 'discovery');
            expect(discovery?.outcome).toBe('error');
            expect(discovery?.summary).toContain('Do not retry');
            expect(report.checks.filter((c) => !['discovery', 'auth-app-password'].includes(c.id)).every((c) => c.outcome === 'skipped')).toBe(true);
        });
    }

    test('an OPTIONS that answers 200 without checking credentials cannot hide the 401 (reviewer PoC B)', async () => {
        const fake = standardAccount(PLAIN, { hook: (req) => (req.method === 'OPTIONS' ? new Response(null, { status: 200, headers: { dav: '1, calendar-access' } }) : undefined) });
        const report = await probe(fake, WRITE, WRONG);
        expect(fake.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(['PROPFIND /']);
        expect(report.auth.rejected).toBe(true);
    });

    test('the first request carrying Authorization is the one that proves the credentials', async () => {
        const fake = standardAccount();
        await probe(fake, READ_ONLY, creds);
        expect(fake.requests[0]?.method).toBe('PROPFIND');
        expect(fake.requests[0]?.url.href).toBe('https://caldav.icloud.com/');
        expect(fake.requests.every((r) => r.headers.get('authorization') !== null)).toBe(true);
    });

    test('the CLI prints one fixed message and exits 1', async () => {
        const fake = standardAccount();
        const err: string[] = [];
        const code = await runCli([], {
            env: { PROBE_APPLE_ID: WRONG.appleId, PROBE_APP_PASSWORD: WRONG.appPassword }, isTTY: false,
            promptLine: async () => undefined, promptHidden: async () => undefined, stdout: () => undefined, stderr: (t) => { err.push(t); },
        }, { probe: (input) => runProbe(input, fakeDeps(fake)), invokeLambda: async () => ({ ok: false, code: 'x' }) });
        expect(code).toBe(1);
        expect(err.join('')).toContain('Check the Apple ID and the app-specific password');
        expect(err.join('')).toContain('Do not retry');
        expect(fake.requests.length).toBe(1);
    });
});

/** Requests after the first 401 that are not the one allowed DELETE per created calendar. */
function unexpectedAfter401(requests: FakeRequest[], first401: number): string[] {
    const created = new Set(requests.slice(0, first401).filter((r) => r.method === 'MKCALENDAR').map((r) => r.url.pathname));
    const deleted = new Set<string>();
    const extra: string[] = [];
    let deleteRejected = false;
    for (const r of requests.slice(first401)) {
        const path = r.url.pathname;
        if (!deleteRejected && r.method === 'DELETE' && created.has(path) && !deleted.has(path)) {
            deleted.add(path);
            // In these tests every request after the switch is answered 401.
            deleteRejected = true;
            continue;
        }
        extra.push(`${r.method} ${path}`);
    }
    return extra;
}

describe('credentials that stop working mid-run stop the run (M1)', () => {
    for (const [label, flags] of [['read-only', READ_ONLY], ['write', WRITE]] as const) {
        test(`${label}: after the first 401 nothing is sent except one DELETE of a created calendar`, async () => {
            const baseline = standardAccount();
            await probe(baseline, flags, creds);
            const total = baseline.requests.length;
            // 1-based number of the final listing that ends removal (the request after the last calendar DELETE).
            const lastCalendarDelete = baseline.requests.findLastIndex((r) => r.method === 'DELETE' && r.url.pathname.endsWith('/'));
            const removalEnds = lastCalendarDelete < 0 ? 0 : lastCalendarDelete + 3;
            for (let switchAt = 2; switchAt <= total; switchAt++) {
                const fake = standardAccount(PLAIN, { hook: (_req, n) => (n >= switchAt ? new Response('Unauthorized', { status: 401 }) : undefined) });
                const report = await probe(fake, flags, creds);
                expect(report.auth.rejected).toBe(true);
                expect(report.auth.onFirstRequest).toBe(false);
                const challenged = fake.requests[switchAt - 1];
                const anonymousChallenge = challenged?.method === 'GET' && challenged.url.pathname.includes('/attachments/') && !challenged.headers.has('authorization');
                if (anonymousChallenge) {
                    const signed = fake.requests[switchAt];
                    expect(signed?.url.href).toBe(challenged.url.href);
                    expect(signed?.method).toBe('GET');
                    expect(signed?.headers.has('authorization')).toBe(true);
                }
                const extra = unexpectedAfter401(fake.requests, switchAt + (anonymousChallenge ? 1 : 0));
                // The last five requests of a run are the parallel burst: up to four of them may already
                // be in flight when the first 401 arrives (documented residual).
                const inFlight = switchAt > total - 5 ? Math.min(4, total - switchAt) : 0;
                expect({ switchAt, extra: extra.length <= inFlight ? [] : extra }).toEqual({ switchAt, extra: [] });
                if (fake.requests.slice(0, switchAt - 1).some((r) => r.method === 'MKCALENDAR') && switchAt <= removalEnds) {
                    expect(report.cleanup?.allRemoved).toBe(false);
                }
            }
        });
    }

    test('reviewer PoC D: credentials revoked right after discovery', async () => {
        const fake = standardAccount(PLAIN, { hook: (_req, n) => (n > 6 ? new Response('Unauthorized', { status: 401 }) : undefined) });
        await probe(fake, WRITE, creds);
        expect(fake.requests.length).toBe(7);
    });
});

describe('the latch lives in the single request choke point (M1)', () => {
    const HOME = 'https://p42-caldav.icloud.com/10000000001/calendars/';
    function latchHttp(respond: (method: string, url: string) => number): { http: ProbeHttp; sent: string[] } {
        const sent: string[] = [];
        const http = new ProbeHttp({
            fetch: async (u, init) => {
                sent.push(`${init?.method} ${String(u)}`);
                const status = respond(init?.method ?? 'GET', String(u));
                return status >= 300 && status < 400 ? new Response(null, { status, headers: { location: `${HOME}r/` } }) : new Response(null, { status });
            },
            now: () => 0, sleep: async () => undefined, auth: { appleId: 'a@example.invalid', appPassword: 'x' }, mode: 'write', taint: new Taint(),
        });
        return { http, sent };
    }
    const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'sent', (e: unknown) => (e instanceof ProbeHttpError ? e.code : 'other'));

    test('after a 401 every request fails fast; one essential DELETE per registered calendar is still allowed', async () => {
        let status = 207;
        const { http, sent } = latchHttp(() => status);
        const a = `${HOME}caldav-mcp-probe-0a0a0a0a/`;
        const b = `${HOME}caldav-mcp-probe-0b0b0b0b/`;
        http.registerProbeCollection(a, HOME);
        http.registerProbeCollection(b, HOME);
        await http.request({ method: 'PROPFIND', url: HOME });
        status = 401;
        expect((await http.request({ method: 'PROPFIND', url: HOME })).status).toBe(401);
        expect(http.credentialsRejected).toBe(true);
        status = 204;
        expect(await code(http.request({ method: 'PROPFIND', url: HOME }))).toBe('unauthorized');
        expect(await code(http.request({ method: 'PROPFIND', url: a, essential: true }))).toBe('unauthorized');
        expect(await code(http.request({ method: 'DELETE', url: `${a}x.ics`, essential: true }))).toBe('unauthorized');
        expect(await code(http.request({ method: 'DELETE', url: a }))).toBe('unauthorized');
        expect(await code(http.request({ method: 'DELETE', url: a, essential: true }))).toBe('sent');
        expect(await code(http.request({ method: 'DELETE', url: a, essential: true }))).toBe('unauthorized');
        status = 401;
        expect(await code(http.request({ method: 'DELETE', url: b, essential: true }))).toBe('sent');
        expect(sent.length).toBe(4);
    });

    test('a DELETE that is itself rejected stops everything', async () => {
        const { http, sent } = latchHttp(() => 401);
        const a = `${HOME}caldav-mcp-probe-0a0a0a0a/`;
        const b = `${HOME}caldav-mcp-probe-0b0b0b0b/`;
        http.registerProbeCollection(a, HOME);
        http.registerProbeCollection(b, HOME);
        await http.request({ method: 'PROPFIND', url: HOME });
        await http.request({ method: 'DELETE', url: a, essential: true });
        expect(await code(http.request({ method: 'DELETE', url: b, essential: true }))).toBe('unauthorized');
        expect(sent.length).toBe(2);
    });

    test('a 401 on a redirect hop latches too, and the first-request flag is exact', async () => {
        const { http, sent } = latchHttp((_m, url) => (url.endsWith('/r/') ? 401 : 307));
        expect((await http.request({ method: 'PROPFIND', url: HOME })).status).toBe(401);
        expect(http.credentialsRejected).toBe(true);
        expect(http.rejectedOnFirstRequest).toBe(false);
        expect(await code(http.request({ method: 'PROPFIND', url: HOME }))).toBe('unauthorized');
        expect(sent.length).toBe(2);
        const first = latchHttp(() => 401);
        await first.http.request({ method: 'PROPFIND', url: 'https://caldav.icloud.com/' });
        expect(first.http.rejectedOnFirstRequest).toBe(true);
    });
});
