import { describe, expect, test } from 'bun:test';
import { PLAIN, standardAccount, type FakeICloud } from './fixtures/probe/fake-icloud';
import { WRITE, WRITE_METHODS, check, outcomes, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };

function writesStayInProbeCalendars(fake: FakeICloud): void {
    const writes = fake.requests.filter((r) => WRITE_METHODS.has(r.method));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
        expect(['PUT', 'DELETE', 'MKCALENDAR', 'POST']).toContain(w.method);
        expect(w.url.pathname).toMatch(/^\/10000000001\/calendars\/caldav-mcp-probe-[0-9a-f]{8}\//);
        if (w.method === 'POST') {
            // Only the managed-attachment actions, on an event the probe wrote.
            expect(w.url.pathname).toMatch(/\.ics$/);
            expect(w.url.search).toMatch(/^\?action=attachment-(?:add|remove&managed-id=[A-Za-z0-9._-]+)$/);
        }
    }
}

function probeCalendarsLeft(fake: FakeICloud): number {
    return [...fake.calendars.keys()].filter((id) => id.startsWith('caldav-mcp-probe-')).length;
}

const WRITE_IDS = [
    'write-mkcalendar', 'write-create-if-none-match', 'write-if-match-exact', 'write-if-match-stale', 'write-if-match-star',
    'write-no-end', 'write-duplicate-uid', 'roundtrip-tzid-with-vtimezone', 'roundtrip-tzid-without-vtimezone', 'roundtrip-all-day',
    'roundtrip-floating', 'roundtrip-utc', 'roundtrip-unknown-properties', 'server-rewrites', 'write-expand', 'write-text-match',
    'write-time-range', 'write-sync-changes', 'write-sync-limit', 'write-delete-calendar',
];

describe('write mode', () => {
    test('runs every write check inside temporary calendars and removes them', async () => {
        const fake = standardAccount();
        const before = new Map([...fake.calendars].map(([id, cal]) => [id, [...cal.events.keys()].join(',')]));
        const report = await probe(fake, WRITE, creds);
        const got = outcomes(report);
        expect(Object.fromEntries(WRITE_IDS.map((id) => [id, got[id]]))).toEqual({
            'write-mkcalendar': 'confirmed',
            'write-create-if-none-match': 'confirmed',
            'write-if-match-exact': 'confirmed',
            'write-if-match-stale': 'confirmed',
            'write-if-match-star': 'confirmed',
            'write-no-end': 'confirmed',
            'write-duplicate-uid': 'confirmed',
            'roundtrip-tzid-with-vtimezone': 'confirmed',
            'roundtrip-tzid-without-vtimezone': 'confirmed',
            'roundtrip-all-day': 'confirmed',
            'roundtrip-floating': 'confirmed',
            'roundtrip-utc': 'confirmed',
            'roundtrip-unknown-properties': 'confirmed',
            'server-rewrites': 'refuted',
            'write-expand': 'refuted',
            'write-text-match': 'refuted',
            'write-time-range': 'confirmed',
            'write-sync-changes': 'confirmed',
            'write-sync-limit': 'confirmed',
            'write-delete-calendar': 'confirmed',
        });
        expect(got['write-invite']).toBeUndefined();
        writesStayInProbeCalendars(fake);
        expect(probeCalendarsLeft(fake)).toBe(0);
        expect(new Map([...fake.calendars].map(([id, cal]) => [id, [...cal.events.keys()].join(',')]))).toEqual(before);
        expect(report.cleanup?.allRemoved).toBe(true);
        expect(report.cleanup?.tempCalendars.length).toBe(2);
        expect(report.cleanup?.tempCalendars.every((t) => /^caldav-mcp-probe-[0-9a-f]{8}$/.test(t.name) && t.removalVerified)).toBe(true);
        expect(check(report, 'server-rewrites').evidence).toMatchObject({ prodidChanged: 6 });
        expect(check(report, 'write-create-if-none-match').evidence).toMatchObject({ createStatus: 201, etagHeaderOnCreate: true, secondCreateStatus: 412 });
        expect(check(report, 'write-duplicate-uid').evidence).toMatchObject({ otherCalendarStatus: 403, otherCalendarPreconditions: ['no-uid-conflict'] });
        expect(check(report, 'write-if-match-star').evidence).toMatchObject({ existingStatus: 412, missingStatus: 412 });
        expect(report.totals.requests).toBeLessThan(260);
        expect(report.redaction.scrubbedOccurrences).toBe(0);
    });

    test('the other server behaviours flip the write outcomes', async () => {
        const fake = standardAccount(PLAIN, {
            expand: true, textMatch: true, ifMatchStar: 'works', requireEnd: false, uniqueUidAcrossCalendars: false,
            putReturnsEtag: false, rewritesProdid: false, addsVtimezone: true, syncLimitHonoured: true,
        });
        const report = await probe(fake, WRITE, creds);
        expect(check(report, 'write-expand').outcome).toBe('confirmed');
        expect(check(report, 'write-expand').evidence).toMatchObject({ instancesReturned: 5, overrideApplied: true, exdateRespected: true, rrulePresent: false });
        expect(check(report, 'write-text-match').outcome).toBe('confirmed');
        expect(check(report, 'write-if-match-star').outcome).toBe('refuted');
        expect(check(report, 'write-no-end').outcome).toBe('refuted');
        expect(check(report, 'write-duplicate-uid').outcome).toBe('refuted');
        expect(check(report, 'write-create-if-none-match').evidence.etagHeaderOnCreate).toBe(false);
        expect(check(report, 'write-if-match-exact').outcome).toBe('confirmed');
        expect(check(report, 'roundtrip-tzid-without-vtimezone').evidence.vtimezoneAddedByServer).toBe(true);
        expect(check(report, 'server-rewrites').outcome).toBe('confirmed');
        expect(check(report, 'write-sync-limit').outcome).toBe('refuted');
        expect(probeCalendarsLeft(fake)).toBe(0);
        writesStayInProbeCalendars(fake);
    });

    test('a calendar that cannot be deleted is reported prominently by its temporary name', async () => {
        for (const mode of ['fails', 'pretend'] as const) {
            const fake = standardAccount(PLAIN, { deleteCollection: mode });
            const report = await probe(fake, WRITE, creds);
            expect(report.cleanup?.allRemoved).toBe(false);
            const left = report.cleanup?.tempCalendars.filter((t) => !t.removalVerified) ?? [];
            expect(left.length).toBe(2);
            expect(left.every((t) => fake.calendars.has(t.name))).toBe(true);
            expect(check(report, 'write-delete-calendar').outcome).toBe('refuted');
        }
    });

    test('an interrupted run still removes its calendar', async () => {
        const controller = new AbortController();
        const fake = standardAccount(PLAIN, {
            hook: (req) => {
                if (req.method === 'PUT') {
                    controller.abort();
                }
                return undefined;
            },
        });
        const report = await probe(fake, WRITE, creds, { signal: controller.signal });
        expect(report.cleanup?.allRemoved).toBe(true);
        expect(probeCalendarsLeft(fake)).toBe(0);
    });

    test('the request cap still leaves room to clean up', async () => {
        const fake = standardAccount();
        const report = await probe(fake, WRITE, creds, { limits: { maxRequests: 70, reserveRequests: 12 } });
        expect(report.totals.requests).toBeLessThanOrEqual(70);
        expect(report.cleanup?.allRemoved).toBe(true);
        expect(probeCalendarsLeft(fake)).toBe(0);
    });

    test('a short Lambda deadline still leaves time to clean up', async () => {
        const fake = standardAccount();
        const report = await probe(fake, WRITE, creds, { remainingMs: () => (fake.requests.length > 60 ? 5_000 : 300_000) });
        expect(fake.requests.some((r) => r.method === 'MKCALENDAR')).toBe(true);
        expect(report.cleanup?.allRemoved).toBe(true);
        expect(probeCalendarsLeft(fake)).toBe(0);
    });
});

describe('invite mode', () => {
    test('saves one event with an attendee, records scheduling evidence, then deletes it', async () => {
        const fake = standardAccount();
        const report = await probe(fake, { write: true, invite: true, cleanup: false }, creds, {}, 'invitee@example.invalid');
        const invite = check(report, 'write-invite');
        expect(invite.outcome).toBe('confirmed');
        expect(invite.evidence).toMatchObject({ putStatus: 201, scheduleTagHeader: true, attendeeScheduleStatusPresent: true, scheduleStatus: '1.2', deleteStatus: 204, confirmByHand: true });
        expect(invite.summary).toContain('by hand');
        const invitePuts = fake.requests.filter((r) => r.method === 'PUT' && r.body.includes('ATTENDEE'));
        expect(invitePuts.length).toBe(1);
        expect(invitePuts[0]?.body).toContain('ORGANIZER:mailto:person@example.invalid');
        expect(invitePuts[0]?.body).toContain('mailto:invitee@example.invalid');
        expect(probeCalendarsLeft(fake)).toBe(0);
    });

    test('refuses to invite one of the account’s own addresses', async () => {
        const report = await probe(standardAccount(), { write: true, invite: true, cleanup: false }, creds, {}, PLAIN.address);
        expect(check(report, 'write-invite').outcome).toBe('skipped');
    });
});

describe('cleanup mode', () => {
    test('deletes only exact probe calendars at exact probe URLs; reports the rest', async () => {
        const fake = standardAccount();
        for (const id of ['caldav-mcp-probe-0a0a0a0a', 'C0FFEE00-1111-4222-8333-444455556666']) {
            fake.calendars.set(id, { id, displayName: id.startsWith('caldav') ? id : 'caldav-mcp-probe-1b1b1b1b', kind: 'owned', components: ['VEVENT'], writable: true, color: '#000', events: new Map(), tombstones: new Map(), rev: 1 });
        }
        fake.calendars.set('lookalike', { id: 'lookalike', displayName: 'caldav-mcp probe notes', kind: 'owned', components: ['VEVENT'], writable: true, color: '#000', events: new Map(), tombstones: new Map(), rev: 1 });
        const kept = [...fake.calendars.keys()].filter((id) => id !== 'caldav-mcp-probe-0a0a0a0a');
        const report = await probe(fake, { write: false, invite: false, cleanup: true }, creds, { confirmCleanup: async () => true });
        const result = check(report, 'cleanup-leftovers');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence).toMatchObject({ found: 2, candidates: 1, deleteAccepted: 1, removalVerified: 1, notDeleted: 1, reasons: { url_not_probe_pattern: 1 } });
        expect([...fake.calendars.keys()].toSorted()).toEqual(kept.toSorted());
        expect(fake.requests.filter((r) => WRITE_METHODS.has(r.method)).map((r) => r.method)).toEqual(['DELETE']);
        expect(report.cleanup).toEqual({
            tempCalendars: [{ name: 'caldav-mcp-probe-0a0a0a0a', removalVerified: true }],
            notDeleted: [{ name: 'caldav-mcp-probe-1b1b1b1b', reason: 'url_not_probe_pattern', cleanupCanRemove: false }],
            deleted: 1,
            allRemoved: false,
        });
        expect(report.checks.map((c) => c.id)).toEqual(['discovery', 'auth-app-password', 'cleanup-leftovers']);
    });

    test('reports zero when nothing is left over', async () => {
        const fake = standardAccount();
        const report = await probe(fake, { write: false, invite: false, cleanup: true }, creds);
        expect(check(report, 'cleanup-leftovers').evidence).toMatchObject({ found: 0 });
        expect(fake.requests.some((r) => WRITE_METHODS.has(r.method))).toBe(false);
    });
});
