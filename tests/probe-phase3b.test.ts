/**
 * Phase 3b checks of probe 0.6.0 (design §8.2): occurrence edits, against the fake iCloud in its
 * measured mode and against servers that answer differently.
 */
import { describe, expect, test } from 'bun:test';
import type { ProbeReport } from '../scripts/probe/types';
import { ICLOUD_MEASURED, PLAIN, standardAccount, type FakeBehaviour, type FakeICloud } from './fixtures/probe/fake-icloud';
import { WRITE, check, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };

async function run(behaviour: Partial<FakeBehaviour> = {}): Promise<{ fake: FakeICloud; report: ProbeReport }> {
    const fake = standardAccount(PLAIN, behaviour);
    return { fake, report: await probe(fake, WRITE, creds) };
}

const putsTo = (fake: FakeICloud, suffix: string) => fake.requests.filter((r) => r.method === 'PUT' && r.url.pathname.endsWith(`-${suffix}.ics`));

describe('write-override-new-forms (P3B-1)', () => {
    test('measured expansion: instance 3 is replaced in all four forms, with the RECURRENCE-ID in the master’s form', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        const result = check(report, 'write-override-new-forms');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ formsAsClaimed: 4, tzidReplaced: true, utcReplaced: true, dateReplaced: true, floatingReplaced: true, tzidStoredRidVerbatim: true, dateStoredRidKind: 'date', tzidAfterCount: 6 });
        const [create, edit] = putsTo(fake, 'p3b1tz');
        expect(create?.headers.get('if-none-match')).toBe('*');
        expect(edit?.headers.get('if-match')).not.toBeNull();
        expect(edit?.body).toContain('RECURRENCE-ID;TZID=America/New_York:20270420T100000\r\nDTSTART;TZID=America/New_York:20270420T100000\r\nDTEND;TZID=America/New_York:20270420T110000');
        expect(edit?.body).toContain('SUMMARY:caldav-mcp probe override\r\nSEQUENCE:1');
        // The master is sent again byte for byte.
        expect(edit?.body.split('BEGIN:VEVENT')[1]).toBe(create?.body.split('BEGIN:VEVENT')[1]?.replace('END:VCALENDAR\r\n', ''));
        expect(putsTo(fake, 'p3b1date')[1]?.body).toContain('RECURRENCE-ID;VALUE=DATE:20270422\r\n');
        expect(putsTo(fake, 'p3b1flt')[1]?.body).toContain('RECURRENCE-ID:20270423T090000\r\n');
    });

    test('a server where only UTC RECURRENCE-IDs match refutes (the other forms duplicate an instance)', async () => {
        const result = check((await run({ ...ICLOUD_MEASURED, ridMatching: 'utc-only' })).report, 'write-override-new-forms');
        expect(result).toMatchObject({ outcome: 'refuted', evidence: { utcReplaced: true, tzidReplaced: false, tzidAfterCount: 7 } });
    });

    test('a server that does not expand, or flattens forms to UTC, writes no override and is inconclusive', async () => {
        for (const behaviour of [{}, { expand: true }] satisfies Partial<FakeBehaviour>[]) {
            const { report, fake } = await run(behaviour);
            expect(check(report, 'write-override-new-forms').outcome).toBe('inconclusive');
            expect(putsTo(fake, 'p3b1tz')).toHaveLength(1);
            expect(check(report, 'write-override-expanded-shape').outcome).toBe('inconclusive');
        }
    });
});

describe('write-override-expanded-shape (P3B-2)', () => {
    test('the fake’s guess (overridden instances keep the …Z token) is outcome (b) and confirms; P3B-6 is skipped', async () => {
        const { report } = await run(ICLOUD_MEASURED);
        const result = check(report, 'write-override-expanded-shape');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ tzidSeriesOutcome: 'b-utc-token', tzidOverriddenRidClass: 'b-utc-token', dateOverriddenRidClass: 'b-utc-token', tzidOverrideTimesVerbatim: true, tzidNamesOnlyOnOverridden: [] });
        expect(check(report, 'write-override-utc-rid-on-tzid').outcome).toBe('skipped');
    });

    test('a server that renders the stored text is outcome (a): refuted, and the P3B-6 contingency runs', async () => {
        const { report, fake } = await run({ ...ICLOUD_MEASURED, overrideRid: 'stored-text' });
        expect(check(report, 'write-override-expanded-shape')).toMatchObject({ outcome: 'refuted', evidence: { tzidSeriesOutcome: 'a-stored-text' } });
        const contingency = check(report, 'write-override-utc-rid-on-tzid');
        expect(contingency.outcome).toBe('confirmed');
        expect(putsTo(fake, 'p3b6tz')[1]?.body).toContain('RECURRENCE-ID:20270720T140000Z\r\nDTSTART;TZID=America/New_York:20270720T100000');
    });
});

describe('write-override-reedit (P3B-3)', () => {
    test('re-editing the moved override leaves one instance at the new values and the master unchanged', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        const result = check(report, 'write-override-reedit');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ tzidMasterUnchanged: true, tzidOneInstanceAtNewValues: true, tzidStoredOverrides: 2, formsAsClaimed: 4 });
        const last = putsTo(fake, 'p3b1utc').at(-1)?.body ?? '';
        // Instance 4 (2027-04-28) moved three days; its RECURRENCE-ID line is kept.
        expect(last).toContain('RECURRENCE-ID:20270428T150000Z\r\nDTSTART:20270501T150000Z');
        expect(last).toContain('SUMMARY:caldav-mcp probe override again');
    });

    test('a server that rewrites the master on a later save refutes', async () => {
        let gets = 0;
        const { report } = await run({
            ...ICLOUD_MEASURED,
            transformResponse: async (req, res) => (req.method === 'GET' && req.url.pathname.endsWith('-p3b1utc.ics') && ++gets === 3
                ? new Response((await res.text()).replace('SEQUENCE:0', 'SEQUENCE:7'), { status: res.status, headers: res.headers })
                : res),
        });
        expect(check(report, 'write-override-reedit')).toMatchObject({ outcome: 'refuted', evidence: { utcMasterUnchanged: false, tzidMasterUnchanged: true } });
    });
});

describe('write-override-dst (P3B-4)', () => {
    test('measured (second 01:30): the override copied from the expanded text replaces exactly that night’s instance', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        expect(check(report, 'write-override-dst')).toMatchObject({ outcome: 'confirmed', evidence: { repeatedHourReplacedExactly: true, skippedHourReplacedExactly: true } });
        expect(putsTo(fake, 'p3b4repeat')[1]?.body).toContain('RECURRENCE-ID;TZID=America/New_York:20271107T013000');
    });

    test('a server whose zoned RECURRENCE-IDs never match refutes', async () => {
        expect(check((await run({ ...ICLOUD_MEASURED, ridMatching: 'utc-only' })).report, 'write-override-dst')).toMatchObject({ outcome: 'refuted', evidence: { repeatedHourReplacedExactly: false, repeatedHourAfterCount: 4 } });
    });
});

describe('write-exdate-forms (P3B-5)', () => {
    test('an EXDATE in each master form, and override removal plus EXDATE, remove exactly instance 3', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        const result = check(report, 'write-exdate-forms');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ formsAsClaimed: 5, overriddenInstanceGone: true, tzidExdateKind: 'tzid', dateExdateKind: 'date', dateAfterCount: 5 });
        expect(putsTo(fake, 'p3b5tz')[1]?.body).toContain('SEQUENCE:1\r\nEXDATE;TZID=America/New_York:20270615T100000\r\nEND:VEVENT');
        expect(putsTo(fake, 'p3b5date')[1]?.body).toContain('EXDATE;VALUE=DATE:20270617\r\n');
        const overridden = putsTo(fake, 'p3b5ovr');
        expect(overridden[0]?.body).toContain('RECURRENCE-ID:');
        expect(overridden[1]?.body).not.toContain('RECURRENCE-ID:');
    });

    test('a refused EXDATE edit refutes', async () => {
        const { report } = await run({ ...ICLOUD_MEASURED, hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-p3b5date.ics') && req.headers.has('if-match') ? new Response(null, { status: 403 }) : undefined) });
        expect(check(report, 'write-exdate-forms')).toMatchObject({ outcome: 'refuted', evidence: { dateExdatePutStatus: 403, editsRefused: 1, formsAsClaimed: 4 } });
    });
});
