import { describe, expect, test } from 'bun:test';
import { ProbeHttp, ProbeHttpError } from '../scripts/probe/http';
import { parseLambdaEvent } from '../scripts/probe/lambda';
import { Taint } from '../scripts/probe/safe';
import { FAKE_NOW, PLAIN, probeStyleEvent, seedCalendar, seedEvent, standardAccount, type FakeICloud } from './fixtures/probe/fake-icloud';
import { WRITE_METHODS, check, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const CLEANUP = { write: false, invite: false, cleanup: true };
const HOME = 'https://p42-caldav.icloud.com/10000000001/calendars/';

function deletes(fake: FakeICloud): string[] {
    return fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.url.pathname);
}

function realEvent(uid: string): { name: string; ical: string } {
    return { name: `${uid}.ics`, ical: seedEvent({ uid, summary: 'Real appointment', start: FAKE_NOW + 86_400_000 }) };
}

const yes = { confirmCleanup: async () => true };

describe('--cleanup deletes only what the probe itself made (B1)', () => {
    test('reviewer PoC C: a populated calendar the owner named with the prefix, and a shared-by-me one, both survive', async () => {
        const fake = standardAccount();
        seedCalendar(fake, { id: 'work-archive', displayName: 'caldav-mcp-probe-notes (keep!)', events: [realEvent('real-1'), realEvent('real-2')] });
        seedCalendar(fake, { id: 'family-shared', displayName: 'caldav-mcp-probe-family', kind: 'shared-owner', events: [realEvent('fam')] });
        const report = await probe(fake, CLEANUP, creds, yes);
        expect(deletes(fake)).toEqual([]);
        expect(fake.calendars.has('work-archive')).toBe(true);
        expect(fake.calendars.has('family-shared')).toBe(true);
        expect(report.cleanup).toMatchObject({ deleted: 0, tempCalendars: [], notDeleted: [] });
        expect(check(report, 'cleanup-leftovers').evidence).toMatchObject({ found: 0, lookalikesIgnored: 2 });
    });

    test('a strict probe name at a non-probe URL is reported for deletion by hand, never deleted', async () => {
        const fake = standardAccount();
        seedCalendar(fake, { id: 'C0FFEE00-1111-4222-8333-444455556666', displayName: 'caldav-mcp-probe-1b1b1b1b' });
        seedCalendar(fake, { id: 'caldav-mcp-probe-2c2c2c2c', displayName: 'caldav-mcp-probe-3d3d3d3d' });
        const report = await probe(fake, CLEANUP, creds, yes);
        expect(deletes(fake)).toEqual([]);
        expect(report.cleanup?.notDeleted.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
            { name: 'caldav-mcp-probe-1b1b1b1b', reason: 'url_not_probe_pattern', cleanupCanRemove: false },
            { name: 'caldav-mcp-probe-3d3d3d3d', reason: 'url_not_probe_pattern', cleanupCanRemove: false },
        ]);
        expect(report.cleanup?.allRemoved).toBe(false);
    });

    test('shared, subscribed-like and foreign-owner calendars with a strict probe name and URL are skipped', async () => {
        const fake = standardAccount();
        seedCalendar(fake, { id: 'caldav-mcp-probe-0a0a0a0a', displayName: 'caldav-mcp-probe-0a0a0a0a', kind: 'shared-owner' });
        seedCalendar(fake, { id: 'caldav-mcp-probe-0b0b0b0b', displayName: 'caldav-mcp-probe-0b0b0b0b', kind: 'shared' });
        const report = await probe(fake, CLEANUP, creds, yes);
        expect(deletes(fake)).toEqual([]);
        expect(Object.fromEntries((report.cleanup?.notDeleted ?? []).map((n) => [n.name, n.reason]))).toEqual({
            'caldav-mcp-probe-0a0a0a0a': 'shared',
            'caldav-mcp-probe-0b0b0b0b': 'shared',
        });
    });

    test('any resource the probe did not write blocks deletion', async () => {
        const fake = standardAccount();
        seedCalendar(fake, { id: 'caldav-mcp-probe-0a0a0a0a', displayName: 'caldav-mcp-probe-0a0a0a0a', events: [probeStyleEvent('caldav-mcp-probe-0a0a0a0a-1'), realEvent('real-1')] });
        // Probe-style resource name, but the UID inside is someone else's.
        const disguised = probeStyleEvent('caldav-mcp-probe-0b0b0b0b-1');
        seedCalendar(fake, { id: 'caldav-mcp-probe-0b0b0b0b', displayName: 'caldav-mcp-probe-0b0b0b0b', events: [{ name: disguised.name, ical: disguised.ical.replace('UID:caldav-mcp-probe-0b0b0b0b-1', 'UID:someone-else') }] });
        // Probe-style UID and name, but not the probe's SUMMARY.
        const retitled = probeStyleEvent('caldav-mcp-probe-0c0c0c0c-1');
        seedCalendar(fake, { id: 'caldav-mcp-probe-0c0c0c0c', displayName: 'caldav-mcp-probe-0c0c0c0c', events: [{ name: retitled.name, ical: retitled.ical.replace('SUMMARY:caldav-mcp probe event', 'SUMMARY:Rent due') }] });
        const report = await probe(fake, CLEANUP, creds, yes);
        expect(deletes(fake)).toEqual([]);
        expect(new Set(report.cleanup?.notDeleted.map((n) => n.reason))).toEqual(new Set(['foreign_resource']));
        expect(report.cleanup?.notDeleted.length).toBe(3);
    });

    test('a probe calendar holding only probe events is deleted after typed confirmation, and the report counts exactly', async () => {
        const fake = standardAccount();
        seedCalendar(fake, { id: 'caldav-mcp-probe-0a0a0a0a', displayName: 'caldav-mcp-probe-0a0a0a0a', events: [probeStyleEvent('caldav-mcp-probe-0a0a0a0a-1'), probeStyleEvent('caldav-mcp-probe-9f9f9f9f-dupsame')] });
        seedCalendar(fake, { id: 'caldav-mcp-probe-1b1b1b1b', displayName: 'caldav-mcp-probe-1b1b1b1b' });
        seedCalendar(fake, { id: 'caldav-mcp-probe-2c2c2c2c', displayName: 'caldav-mcp-probe-2c2c2c2c', events: [realEvent('real-1')] });
        const asked: { names: string[] }[] = [];
        const before = [...fake.calendars.keys()].filter((id) => !id.startsWith('caldav-mcp-probe-'));
        const report = await probe(fake, CLEANUP, creds, { confirmCleanup: async (c) => { asked.push(c); return true; } });
        expect(asked).toEqual([{ names: ['caldav-mcp-probe-0a0a0a0a', 'caldav-mcp-probe-1b1b1b1b'] }]);
        expect(deletes(fake).toSorted()).toEqual(['/10000000001/calendars/caldav-mcp-probe-0a0a0a0a/', '/10000000001/calendars/caldav-mcp-probe-1b1b1b1b/']);
        expect([...fake.calendars.keys()].filter((id) => !id.startsWith('caldav-mcp-probe-'))).toEqual(before);
        expect(fake.calendars.has('caldav-mcp-probe-2c2c2c2c')).toBe(true);
        expect(report.cleanup).toMatchObject({ deleted: 2, allRemoved: false, notDeleted: [{ name: 'caldav-mcp-probe-2c2c2c2c', reason: 'foreign_resource', cleanupCanRemove: false }] });
        expect(check(report, 'cleanup-leftovers').evidence).toMatchObject({ found: 3, candidates: 2, removalVerified: 2, notDeleted: 1 });
        expect(fake.requests.filter((r) => WRITE_METHODS.has(r.method)).every((r) => r.method === 'DELETE')).toBe(true);
    });

    test('without confirmation nothing is deleted, and that is what the report says', async () => {
        for (const overrides of [{}, { confirmCleanup: async () => false }]) {
            const fake = standardAccount();
            seedCalendar(fake, { id: 'caldav-mcp-probe-0a0a0a0a', displayName: 'caldav-mcp-probe-0a0a0a0a' });
            const report = await probe(fake, CLEANUP, creds, overrides);
            expect(deletes(fake)).toEqual([]);
            expect(report.cleanup).toMatchObject({ deleted: 0, allRemoved: false, notDeleted: [{ name: 'caldav-mcp-probe-0a0a0a0a', reason: 'not_confirmed', cleanupCanRemove: true }] });
            expect(check(report, 'cleanup-leftovers').outcome).toBe('skipped');
        }
    });

    test('an interrupt while waiting for confirmation deletes nothing', async () => {
        const fake = standardAccount();
        seedCalendar(fake, { id: 'caldav-mcp-probe-0a0a0a0a', displayName: 'caldav-mcp-probe-0a0a0a0a' });
        const controller = new AbortController();
        const report = await probe(fake, CLEANUP, creds, {
            signal: controller.signal,
            confirmCleanup: () => {
                controller.abort();
                return new Promise<boolean>(() => undefined);
            },
        });
        expect(deletes(fake)).toEqual([]);
        expect(report.cleanup?.notDeleted[0]?.reason).toBe('not_confirmed');
    });

    test('nothing to clean up: no prompt and no writes', async () => {
        const fake = standardAccount();
        let asked = 0;
        const report = await probe(fake, CLEANUP, creds, { confirmCleanup: async () => { asked++; return true; } });
        expect(asked).toBe(0);
        expect(fake.requests.some((r) => WRITE_METHODS.has(r.method))).toBe(false);
        expect(report.cleanup).toEqual({ tempCalendars: [], notDeleted: [], deleted: 0, allRemoved: true });
    });
});

describe('the HTTP layer enforces the cleanup name and URL rules itself (B1)', () => {
    function cleanupHttp(): { http: ProbeHttp; sent: string[] } {
        const sent: string[] = [];
        const http = new ProbeHttp({
            fetch: async (u, init) => { sent.push(`${init?.method} ${String(u)}`); return new Response(null, { status: 204 }); },
            now: () => 0, sleep: async () => undefined, auth: { appleId: 'a@example.invalid', appPassword: 'x' }, mode: 'cleanup', taint: new Taint(),
        });
        return { http, sent };
    }

    test('registration needs a strict display name equal to a strict direct-child URL segment', async () => {
        const { http, sent } = cleanupHttp();
        for (const [url, name] of [
            [`${HOME}home/`, 'caldav-mcp-probe-0a0a0a0a'],
            [`${HOME}caldav-mcp-probe-0a0a0a0a/`, 'caldav-mcp-probe-notes'],
            [`${HOME}caldav-mcp-probe-0a0a0a0a/`, 'caldav-mcp-probe-0b0b0b0b'],
            [`${HOME}caldav-mcp-probe-0a0a0a0aX/`, 'caldav-mcp-probe-0a0a0a0aX'],
            [`${HOME}x/caldav-mcp-probe-0a0a0a0a/`, 'caldav-mcp-probe-0a0a0a0a'],
            [HOME, 'caldav-mcp-probe-0a0a0a0a'],
        ] as const) {
            expect(() => http.registerLeftoverCollection(url, HOME, name)).toThrow(ProbeHttpError);
            expect(await http.request({ method: 'DELETE', url, essential: true }).then(() => 'sent', (e: unknown) => (e instanceof ProbeHttpError ? e.code : 'other'))).toBe('write_outside_probe_calendar');
        }
        http.registerLeftoverCollection(`${HOME}caldav-mcp-probe-0a0a0a0a/`, HOME, 'caldav-mcp-probe-0a0a0a0a');
        await http.request({ method: 'DELETE', url: `${HOME}caldav-mcp-probe-0a0a0a0a/`, essential: true });
        expect(sent).toEqual([`DELETE ${HOME}caldav-mcp-probe-0a0a0a0a/`]);
    });
});

describe('Lambda cleanup needs an explicit confirmation boolean (B1)', () => {
    test('cleanup without cleanupConfirmed: true is refused', () => {
        const base = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
        expect(parseLambdaEvent({ ...base, flags: { cleanup: true } })).toBeUndefined();
        expect(parseLambdaEvent({ ...base, flags: { cleanup: true, cleanupConfirmed: 'true' } })).toBeUndefined();
        expect(parseLambdaEvent({ ...base, flags: { cleanup: true, cleanupConfirmed: false } })).toBeUndefined();
        expect(parseLambdaEvent({ ...base, flags: { cleanup: true, cleanupConfirmed: true } })).toMatchObject({ flags: { cleanup: true }, cleanupConfirmed: true });
        expect(parseLambdaEvent({ ...base, flags: { write: true } })).toMatchObject({ cleanupConfirmed: false });
    });
});
