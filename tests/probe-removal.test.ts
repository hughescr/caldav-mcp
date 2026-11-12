import { describe, expect, test } from 'bun:test';
import { runCli } from '../scripts/probe/cli';
import { runProbe } from '../scripts/probe/core';
import { ProbeHttp, ProbeHttpError } from '../scripts/probe/http';
import { Taint } from '../scripts/probe/safe';
import { PLAIN, seedCalendar, standardAccount, type FakeICloud, type FakeRequest } from './fixtures/probe/fake-icloud';
import { WRITE, WRITE_METHODS, check, fakeDeps, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const PROBE_NAME = /^caldav-mcp-probe-[0-9a-f]{8}$/;
const HOME = 'https://p42-caldav.icloud.com/10000000001/calendars/';

function probeNamedLeft(fake: FakeICloud): string[] {
    return [...fake.calendars.values()].filter((c) => PROBE_NAME.test(c.displayName)).map((c) => c.id);
}

function displayNameOf(req: FakeRequest): string {
    return /<D:displayname>([^<]+)<\/D:displayname>/.exec(req.body)?.[1] ?? 'x';
}

describe('write-mode removal is only reported verified when it is (M2)', () => {
    test('a differing Location is never adopted and requires manual cleanup', async () => {
        let fake: FakeICloud | undefined;
        fake = standardAccount(PLAIN, {
            hook: (req) => {
                if (req.method !== 'MKCALENDAR' || fake === undefined) {
                    return undefined;
                }
                const id = `uuid-${fake.calendars.size}`;
                seedCalendar(fake, { id, displayName: displayNameOf(req) });
                return new Response(null, { status: 201, headers: { location: `/10000000001/calendars/${id}/` } });
            },
        });
        const report = await probe(fake, WRITE, creds);
        expect(probeNamedLeft(fake)).toHaveLength(1);
        expect(report.cleanup?.allRemoved).toBe(false);
        expect(check(report, 'write-mkcalendar').outcome).toBe('inconclusive');
        expect(check(report, 'write-mkcalendar').summary).toContain('manual cleanup');
        expect(check(report, 'write-mkcalendar').evidence).toMatchObject({ locationHeader: true, locationUsed: false });
        const writes = fake.requests.filter((r) => WRITE_METHODS.has(r.method) && r.method !== 'MKCALENDAR');
        expect(writes.every((r) => r.method === 'DELETE' && /\/caldav-mcp-probe-[0-9a-f]{8}\/$/.test(r.url.pathname))).toBe(true);
        expect(writes).toHaveLength(1);
    });

    test('a Location naming an existing calendar, another host or a deeper path is ignored', async () => {
        for (const location of ['/10000000001/calendars/home/', 'https://p43-caldav.icloud.com/10000000001/calendars/uuid-1/', '/10000000001/calendars/home/x/', '/10000000001/', 'https://evil.example/c/']) {
            let fake: FakeICloud | undefined;
            fake = standardAccount(PLAIN, {
                hook: (req) => {
                    if (req.method !== 'MKCALENDAR' || fake === undefined) {
                        return undefined;
                    }
                    const id = req.url.pathname.split('/').at(-2) ?? 'x';
                    seedCalendar(fake, { id, displayName: displayNameOf(req) });
                    return new Response(null, { status: 201, headers: { location } });
                },
            });
            const homeEvents = [...(fake.calendars.get('home')?.events.keys() ?? [])];
            const report = await probe(fake, WRITE, creds);
            expect(fake.requests.filter((r) => WRITE_METHODS.has(r.method) && !/^\/10000000001\/calendars\/caldav-mcp-probe-[0-9a-f]{8}\//.test(r.url.pathname))).toEqual([]);
            expect(fake.requests.some((r) => r.url.hostname !== 'caldav.icloud.com' && r.url.hostname !== 'p42-caldav.icloud.com')).toBe(false);
            expect([...(fake.calendars.get('home')?.events.keys() ?? [])]).toEqual(homeEvents);
            expect(fake.calendars.has('home')).toBe(true);
            expect(check(report, 'write-mkcalendar').evidence).toMatchObject({ locationHeader: true, locationUsed: false });
            expect(probeNamedLeft(fake)).toEqual([]);
        }
    });

    test('an unclassified owner collection and redirecting adoption PROPFIND cannot receive writes', async () => {
        let requested = '';
        const fake = standardAccount(PLAIN, {
            hook: (req) => {
                if (req.method === 'MKCALENDAR') {
                    requested = req.url.href;
                    seedCalendar(fake, { id: req.url.pathname.split('/').at(-2) ?? '', displayName: displayNameOf(req) });
                    return new Response(null, { status: 201, headers: { location: `${HOME}unclassified/` } });
                }
                if (req.method === 'PROPFIND' && req.url.href === `${HOME}unclassified/`) {
                    return new Response(null, { status: 307, headers: { location: requested } });
                }
                return undefined;
            },
            transformResponse: async (req, res) => {
                if (req.method === 'PROPFIND' && req.url.href === HOME && req.headers.get('depth') === '1') {
                    return new Response((await res.text()).replace(/<d:response><d:href>[^<]*\/unclassified\/<\/d:href>[\s\S]*?<\/d:response>/, '<d:response><d:href>/10000000001/calendars/unclassified/</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>'), { status: res.status, headers: res.headers });
                }
                return res;
            },
        });
        seedCalendar(fake, { id: 'unclassified', displayName: 'Owner calendar' });
        const report = await probe(fake, WRITE, creds);
        expect(fake.calendars.has('unclassified')).toBe(true);
        expect(check(report, 'write-mkcalendar').outcome).toBe('inconclusive');
        expect(fake.requests.filter((r) => ['PUT', 'POST', 'DELETE'].includes(r.method) && r.url.href.startsWith(`${HOME}unclassified/`))).toEqual([]);
        expect(fake.requests.some((r) => r.method === 'DELETE' && r.url.href === requested)).toBe(true);
        expect(fake.requests.some((r) => r.url.href === `${HOME}unclassified/`)).toBe(false);
    });

    test('the DELETE is always sent, even when a PROPFIND says the calendar is missing', async () => {
        const fake = standardAccount(PLAIN, {
            hook: (req) => (req.method === 'PROPFIND' && req.headers.get('depth') === '0' && /\/caldav-mcp-probe-[0-9a-f]{8}\/$/.test(req.url.pathname) && fake.requests.filter((r) => r.method === 'DELETE').length === 0 && fake.requests.some((r) => r.method === 'PUT') ? new Response('gone?', { status: 404 }) : undefined),
        });
        const report = await probe(fake, WRITE, creds);
        const mk = fake.requests.filter((r) => r.method === 'MKCALENDAR').map((r) => r.url.pathname);
        const del = new Set(fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.url.pathname));
        expect(mk.length).toBeGreaterThan(0);
        expect(mk.every((p) => del.has(p))).toBe(true);
        expect(probeNamedLeft(fake)).toEqual([]);
        expect(report.cleanup?.allRemoved).toBe(true);
    });

    test('a calendar created at a URL the probe never learned is found by the final listing and reported for deletion by hand', async () => {
        let fake: FakeICloud | undefined;
        fake = standardAccount(PLAIN, {
            hook: (req) => {
                if (req.method !== 'MKCALENDAR' || fake === undefined) {
                    return undefined;
                }
                // Created elsewhere, no Location: e.g. a MKCALENDAR that completed on the server after a timeout.
                seedCalendar(fake, { id: `uuid-${fake.calendars.size}`, displayName: displayNameOf(req) });
                return new Response('try later', { status: 504 });
            },
        });
        const report = await probe(fake, WRITE, creds);
        expect(probeNamedLeft(fake).length).toBe(1);
        expect(report.cleanup?.allRemoved).toBe(false);
        expect(report.cleanup?.notDeleted).toEqual([{ name: expect.stringMatching(PROBE_NAME), reason: 'server_chosen_url', cleanupCanRemove: false }]);
        expect(check(report, 'write-delete-calendar').outcome).not.toBe('confirmed');
        // The CLI banner says --cleanup cannot remove it and it must be deleted by hand.
        const out: string[] = [];
        const err: string[] = [];
        const code = await runCli(['--write'], {
            env: { PROBE_APPLE_ID: PLAIN.appleId, PROBE_APP_PASSWORD: PLAIN.appPassword }, isTTY: false,
            promptLine: async () => undefined, promptHidden: async () => undefined, stdout: (t) => { out.push(t); }, stderr: (t) => { err.push(t); },
        }, { probe: async () => report, invokeLambda: async () => ({ ok: false, code: 'x' }) });
        expect(code).toBe(1);
        expect(err.join('')).toContain('NOT REMOVED');
        expect(err.join('')).toContain('--cleanup will not remove it');
        expect(err.join('')).toContain('delete it by hand in Calendar');
    });

    test('a final listing that cannot be read leaves removal unverified', async () => {
        const fake = standardAccount(PLAIN, {
            hook: (req) => (req.method === 'PROPFIND' && req.headers.get('depth') === '1' && req.url.pathname === '/10000000001/calendars/' && fake.requests.some((r) => r.method === 'DELETE') ? new Response('busy', { status: 500 }) : undefined),
        });
        const report = await probe(fake, WRITE, creds);
        expect(probeNamedLeft(fake)).toEqual([]);
        expect(report.cleanup?.allRemoved).toBe(false);
        expect(check(report, 'write-delete-calendar').evidence).toMatchObject({ finalListingRead: false });
    });

    test('an older probe calendar in the listing does not make this run unverified', async () => {
        const fake = standardAccount();
        seedCalendar(fake, { id: 'caldav-mcp-probe-0f0f0f0f', displayName: 'caldav-mcp-probe-0f0f0f0f' });
        const report = await probe(fake, WRITE, creds);
        expect(report.cleanup?.allRemoved).toBe(true);
        expect(check(report, 'write-delete-calendar').evidence).toMatchObject({ olderProbeCalendarsListed: 1 });
        expect(fake.calendars.has('caldav-mcp-probe-0f0f0f0f')).toBe(true);
    });
});

describe('the HTTP layer only accepts a server-chosen calendar it was not told about before (M2)', () => {
    test('registerCreatedCollection refuses existing, nested, foreign-host and non-write registrations', async () => {
        const sent: string[] = [];
        const make = (mode: 'write' | 'read' | 'cleanup'): ProbeHttp => new ProbeHttp({
            fetch: async (u, init) => { sent.push(`${init?.method} ${String(u)}`); return new Response(null, { status: 201 }); },
            now: () => 0, sleep: async () => undefined, auth: { appleId: 'a@example.invalid', appPassword: 'x' }, mode, taint: new Taint(),
        });
        const http = make('write');
        const requested = `${HOME}caldav-mcp-probe-0a0a0a0a/`;
        http.registerProbeCollection(requested, HOME);
        const existing = new Set([`${HOME}home/`]);
        for (const url of [`${HOME}home/`, `${HOME}home/x/`, HOME, 'https://p43-caldav.icloud.com/10000000001/calendars/uuid-1/', `${HOME}uuid-1/?x=1`]) {
            expect(() => http.registerCreatedCollection(url, HOME, existing, requested)).toThrow(ProbeHttpError);
        }
        expect(() => http.registerCreatedCollection(`${HOME}uuid-1/`, HOME, existing, `${HOME}caldav-mcp-probe-0b0b0b0b/`)).toThrow(ProbeHttpError);
        expect(() => make('cleanup').registerCreatedCollection(`${HOME}uuid-1/`, HOME, existing, requested)).toThrow(ProbeHttpError);
        expect(() => http.registerCreatedCollection(`${HOME}uuid-1/`, HOME, existing, requested)).toThrow(ProbeHttpError);
        await expect(http.request({ method: 'PUT', url: `${HOME}uuid-1/e.ics`, body: 'x' })).rejects.toBeInstanceOf(ProbeHttpError);
        await expect(http.request({ method: 'DELETE', url: `${HOME}uuid-1/` })).rejects.toBeInstanceOf(ProbeHttpError);
        expect(sent).toEqual([]);
    });
});

describe('CLI for an unverified write removal (M2)', () => {
    test('runs end to end against the fake with no surprises', async () => {
        const fake = standardAccount();
        const code = await runCli(['--write'], {
            env: { PROBE_APPLE_ID: PLAIN.appleId, PROBE_APP_PASSWORD: PLAIN.appPassword }, isTTY: false,
            promptLine: async () => undefined, promptHidden: async () => undefined, stdout: () => undefined, stderr: () => undefined,
        }, { probe: (input) => runProbe(input, fakeDeps(fake)), invokeLambda: async () => ({ ok: false, code: 'x' }) });
        expect(code).toBe(0);
        expect(probeNamedLeft(fake)).toEqual([]);
    });
});
