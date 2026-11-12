/**
 * Phase 3c and 3d checks of probe 0.6.0 (design §8.3, §8.4): splits and series moves, against
 * the fake iCloud in its measured mode and against servers that answer differently.
 */
import { describe, expect, test } from 'bun:test';
import { truncatedRule, untilFor } from '../scripts/probe/checks/write-3cd';
import type { ProbeReport } from '../scripts/probe/types';
import { ICLOUD_MEASURED, PLAIN, standardAccount, type FakeBehaviour, type FakeICloud } from './fixtures/probe/fake-icloud';
import { WRITE, check, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };

async function run(behaviour: Partial<FakeBehaviour> = {}): Promise<{ fake: FakeICloud; report: ProbeReport }> {
    const fake = standardAccount(PLAIN, behaviour);
    return { fake, report: await probe(fake, WRITE, creds) };
}

const putsTo = (fake: FakeICloud, suffix: string) => fake.requests.filter((r) => r.method === 'PUT' && r.url.pathname.endsWith(`-${suffix}.ics`));

describe('UNTIL arithmetic of design §3.5 (hand-written expectations)', () => {
    test('one second before the split token, in the master’s form', () => {
        expect(untilFor('DTSTART:20270202T150000Z', '20270223T150000Z')).toBe('20270223T145959Z');
        expect(untilFor('DTSTART;TZID=America/New_York:20270223T100000', '20270316T140000Z')).toBe('20270316T135959Z');
        expect(untilFor('DTSTART;VALUE=DATE:20270204', '20270225T000000Z')).toBe('20270224');
        expect(untilFor('DTSTART:20270205T090000', '20270226T090000Z')).toBe('20270226T085959');
        expect(untilFor('DTSTART:20270205T090000', '20270226T090000')).toBeUndefined();
        expect(truncatedRule('FREQ=WEEKLY;COUNT=8;BYDAY=TU', '20270223T145959Z')).toBe('FREQ=WEEKLY;BYDAY=TU;UNTIL=20270223T145959Z');
    });
});

describe('write-split-until (P3C-1) and write-split-count-to-until (P3C-2)', () => {
    test('measured expansion: every form ends at instance 3, and COUNT to UNTIL matches the UTC case', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        expect(check(report, 'write-split-until')).toMatchObject({ outcome: 'confirmed', evidence: { utcEndsAtInstance3: true, tzidEndsAtInstance3: true, dateEndsAtInstance3: true, floatingEndsAtInstance3: true, tzidTruncatedCount: 3 } });
        expect(check(report, 'write-split-count-to-until')).toMatchObject({ outcome: 'confirmed', evidence: { sameAsSplitUntilUtc: true, countEndsAtInstance3: true } });
        expect(putsTo(fake, 'p3c1tz')[1]?.body).toContain('RRULE:FREQ=WEEKLY;UNTIL=20270316T135959Z\r\n');
        expect(putsTo(fake, 'p3c1date')[1]?.body).toContain('RRULE:FREQ=WEEKLY;UNTIL=20270224\r\n');
        expect(putsTo(fake, 'p3c2count')[1]?.body).toContain('RRULE:FREQ=WEEKLY;UNTIL=20270223T145959Z\r\n');
    });

    test('a server that ignores UNTIL refutes, and one that does not expand is inconclusive', async () => {
        const ignoring = await run({
            ...ICLOUD_MEASURED,
            hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-p3c1date.ics') && req.headers.has('if-match') ? new Response(null, { status: 400 }) : undefined),
        });
        expect(check(ignoring.report, 'write-split-until')).toMatchObject({ outcome: 'refuted', evidence: { dateTruncatePutStatus: 400, utcEndsAtInstance3: true } });
        expect(check((await run()).report, 'write-split-until').outcome).toBe('inconclusive');
    });
});

describe('write-split-new-series (P3C-3)', () => {
    test('the new series applies the copied EXDATE and override; each slot appears once', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        expect(check(report, 'write-split-new-series')).toMatchObject({ outcome: 'confirmed', evidence: { oldEndsAtInstance3: true, newAppliesExdate: true, newAppliesOverride: true, eachSlotOnce: true, oldAfterCount: 3, newAfterCount: 7 } });
        const created = putsTo(fake, 'p3c3new')[0];
        expect(created?.headers.get('if-none-match')).toBe('*');
        expect(created?.body).toContain('DTSTART:20270224T160000Z\r\nDTEND:20270224T170000Z\r\nRRULE:FREQ=WEEKLY\r\n');
        expect(created?.body).toContain('EXDATE:20270310T160000Z');
        expect(created?.body.match(/UID:caldav-mcp-probe-[0-9a-f]{8}-p3c3new\r\n/g)).toHaveLength(2);
        // The new series is created before the original is truncated.
        const order = fake.requests.filter((r) => r.method === 'PUT' && /-p3c3(new|old)\.ics$/.test(r.url.pathname)).map((r) => r.url.pathname.slice(-11));
        expect(order).toEqual(['p3c3old.ics', 'p3c3new.ics', 'p3c3old.ics']);
    });

    test('a refused new series refutes and the original is left as it was', async () => {
        const { report, fake } = await run({ ...ICLOUD_MEASURED, hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-p3c3new.ics') ? new Response(null, { status: 403 }) : undefined) });
        expect(check(report, 'write-split-new-series')).toMatchObject({ outcome: 'refuted', evidence: { newSeriesPutStatus: 403 } });
        expect(putsTo(fake, 'p3c3old')).toHaveLength(1);
    });
});

describe('write-orphan-override (P3C-4)', () => {
    test('the fake’s guess (shown) refutes; hidden or refused orphans confirm', async () => {
        expect(check((await run(ICLOUD_MEASURED)).report, 'write-orphan-override')).toMatchObject({ outcome: 'refuted', evidence: { beyondUntilDisposition: 'shown', offSlotDisposition: 'shown', offSlotRegularInstances: 4 } });
        expect(check((await run({ ...ICLOUD_MEASURED, orphanOverride: 'hidden' })).report, 'write-orphan-override')).toMatchObject({ outcome: 'confirmed', evidence: { beyondUntilDisposition: 'hidden', beyondUntilRegularInstances: 4 } });
        expect(check((await run({ ...ICLOUD_MEASURED, orphanOverride: 'refused' })).report, 'write-orphan-override')).toMatchObject({ outcome: 'confirmed', evidence: { beyondUntilDisposition: 'refused', beyondUntilPutStatus: 400 } });
    });
});

describe('write-series-move-plain (P3D-1)', () => {
    test('every instance moves to the new local time across the clock change', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        expect(check(report, 'write-series-move-plain')).toMatchObject({ outcome: 'confirmed', evidence: { tzidAsClaimed: true, ridTokensMatchNewInstants: true, tzidMovedCount: 4 } });
        expect(putsTo(fake, 'p3d1tz')[1]?.body).toContain('DTSTART;TZID=America/New_York:20270303T110000\r\nDTEND;TZID=America/New_York:20270303T120000');
    });

    test('a server that keeps the old start refutes', async () => {
        const { report } = await run({ ...ICLOUD_MEASURED, hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-p3d1tz.ics') && req.headers.has('if-match') ? new Response(null, { status: 204 }) : undefined) });
        expect(check(report, 'write-series-move-plain')).toMatchObject({ outcome: 'refuted', evidence: { tzidAsClaimed: false } });
    });
});

describe('write-series-move-shift (P3D-2) and write-series-move-drop (P3D-3)', () => {
    test('shift keeps the exclusion and both overrides on their instances; drop leaves a plain series', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        expect(check(report, 'write-series-move-shift')).toMatchObject({
            outcome: 'confirmed',
            evidence: { utcUnmovedOverrideShifted: true, utcMovedOverrideKeptTime: true, utcExclusionKept: true, dateUnmovedOverrideShifted: true, dateMovedOverrideKeptTime: true, dateExclusionKept: true },
        });
        const utc = putsTo(fake, 'p3d2utc')[1]?.body ?? '';
        expect(utc).toContain('DTSTART:20270209T160000Z');
        expect(utc).toContain('EXDATE:20270309T160000Z');
        expect(utc).toContain('RECURRENCE-ID:20270216T160000Z\r\nDTSTART:20270216T160000Z');
        expect(utc).toContain('RECURRENCE-ID:20270223T160000Z\r\nDTSTART:20270223T150000Z');
        expect(check(report, 'write-series-move-drop')).toMatchObject({ outcome: 'confirmed', evidence: { noOrphan: true, tzidMovedCount: 5 } });
        const drop = putsTo(fake, 'p3d3tz')[1]?.body ?? '';
        expect(drop).not.toContain('EXDATE');
        expect(drop).not.toContain('RECURRENCE-ID');
    });

    test('a server where only UTC RECURRENCE-IDs match is inconclusive: the DATE series has extra instances before the move, so it is not moved', async () => {
        const { report } = await run({ ...ICLOUD_MEASURED, ridMatching: 'utc-only' });
        // The DATE series no longer expands as written before the move, so only the UTC series is judged.
        expect(check(report, 'write-series-move-shift')).toMatchObject({ outcome: 'inconclusive', evidence: { utcAsClaimed: true, dateSlotsInMasterForm: true } });
    });
});
