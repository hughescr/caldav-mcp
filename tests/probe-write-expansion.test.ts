/**
 * The --write evidence for the phase 2 read path: how the server expands, stores and filters
 * events the probe wrote itself (all-day, floating, TZID with a VTIMEZONE across the March change,
 * a custom TZID, moved overrides, February 29, floating values against UTC boundaries, and two
 * inputs strict servers refuse). Values may be recorded here because the probe authored them.
 */
import { describe, expect, test } from 'bun:test';
import { PLAIN, standardAccount, type FakeBehaviour, type FakeICloud } from './fixtures/probe/fake-icloud';
import { WRITE, WRITE_METHODS, check, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const IDS = [
    'write-expand-date', 'write-expand-floating', 'write-expand-tzid-dst', 'write-custom-tzid', 'write-moved-overrides',
    'write-moved-override-in-span', 'write-feb29', 'write-floating-time-range', 'write-date-zero-length', 'write-range-thisandfuture',
    'write-dst-repeated-hour', 'write-dst-skipped-hour', 'write-dst-utc-in-repeated-hour',
];

async function run(behaviour: Partial<FakeBehaviour> = {}): Promise<{ report: Awaited<ReturnType<typeof probe>>; fake: FakeICloud }> {
    const fake = standardAccount(PLAIN, { expand: true, ...behaviour });
    return { report: await probe(fake, WRITE, creds), fake };
}

const ev = (report: Awaited<ReturnType<typeof probe>>, id: string): Record<string, unknown> => check(report, id).evidence;

describe('every new write check runs inside the temporary calendar and leaves nothing behind', () => {
    test('defaults: a UTC-everything server', async () => {
        const { report, fake } = await run();
        for (const id of IDS) {
            expect(check(report, id).outcome).not.toBe('skipped');
            expect(check(report, id).outcome).not.toBe('error');
        }
        expect(report.cleanup?.allRemoved).toBe(true);
        expect([...fake.calendars.keys()].filter((id) => id.startsWith('caldav-mcp-probe-'))).toEqual([]);
        for (const w of fake.requests.filter((r) => WRITE_METHODS.has(r.method))) {
            expect(['PUT', 'DELETE', 'MKCALENDAR', 'POST']).toContain(w.method);
            expect(w.url.pathname).toMatch(/^\/10000000001\/calendars\/caldav-mcp-probe-[0-9a-f]{8}\//);
        }
        expect(report.redaction.scrubbedOccurrences).toBe(0);
        // Zone names appear in the claims (fixed text), never in the evidence or the summaries.
        const text = JSON.stringify(report.checks.map((c) => ({ evidence: c.evidence, summary: c.summary })));
        for (const authored of ['Probe/Custom', 'America/New_York', 'America/Los_Angeles']) {
            expect(text).not.toContain(authored);
        }
    });

    test('every event the new checks write has a probe UID and a probe summary, so --cleanup could remove the calendar', async () => {
        const { fake } = await run();
        const puts = fake.requests.filter((r) => r.method === 'PUT' && /-w[a-z0-9]+\.ics$/.test(r.url.pathname));
        // 12 expansion events (three moved-override series) and 2 each for the three DST checks.
        expect(puts.length).toBe(18);
        for (const put of puts) {
            const stem = /\/(caldav-mcp-probe-[0-9a-f]{8}-[0-9a-z]{1,12})\.ics$/.exec(put.url.pathname)?.[1];
            expect(stem).toBeDefined();
            const events = (put.body.match(/^BEGIN:VEVENT/gm) ?? []).length;
            const summaries = [...put.body.matchAll(/^SUMMARY:(.*?)\r?$/gm)].map((m) => m[1] ?? '');
            const uids = [...put.body.matchAll(/^UID:(.*?)\r?$/gm)].map((m) => m[1]);
            expect(summaries.length).toBe(events);
            expect(summaries.every((s) => s.startsWith('caldav-mcp probe '))).toBe(true);
            expect(uids.length).toBe(events);
            expect(uids.every((u) => u === stem)).toBe(true);
        }
    });

    test('if the calendars survive a failed deletion, --cleanup still recognises everything the new checks wrote and removes them', async () => {
        const fake = standardAccount(PLAIN, { expand: true, deleteCollection: 'fails' });
        const first = await probe(fake, WRITE, creds);
        expect(first.cleanup?.allRemoved).toBe(false);
        const left = [...fake.calendars.values()].filter((c) => c.id.startsWith('caldav-mcp-probe-'));
        expect(left.length).toBe(2);
        expect(Math.max(...left.map((c) => c.events.size))).toBeLessThanOrEqual(50);
        fake.behaviour.deleteCollection = 'works';
        const cleaned = await probe(fake, { write: false, invite: false, cleanup: true }, creds, { confirmCleanup: async () => true });
        expect(check(cleaned, 'cleanup-leftovers').evidence).toMatchObject({ found: 2, candidates: 2, removalVerified: 2 });
        expect(cleaned.cleanup).toMatchObject({ deleted: 2, notDeleted: [], allRemoved: true });
        expect([...fake.calendars.keys()].filter((id) => id.startsWith('caldav-mcp-probe-'))).toEqual([]);
    });

    test('the primary calendar is made with an explicit calendar-timezone, the second one without', async () => {
        const { report, fake } = await run();
        const makes = fake.requests.filter((r) => r.method === 'MKCALENDAR');
        expect(makes.length).toBe(2);
        expect(makes[0]?.body).toContain('calendar-timezone');
        expect(makes[0]?.body).toContain('TZID:America/Los_Angeles');
        expect(makes[1]?.body).not.toContain('calendar-timezone');
        expect(ev(report, 'write-mkcalendar')).toMatchObject({ calendarTimezoneSent: true, calendarTimezoneKept: true, calendarTimezoneRefused: false });
    });

    test('a server that refuses the calendar-timezone gets one retry without it, and the run goes on', async () => {
        const { report, fake } = await run({ calendarTimezone: 'refused' });
        expect(check(report, 'write-mkcalendar').outcome).toBe('confirmed');
        expect(ev(report, 'write-mkcalendar')).toMatchObject({ calendarTimezoneSent: true, calendarTimezoneKept: false, calendarTimezoneRefused: true });
        expect(fake.requests.filter((r) => r.method === 'MKCALENDAR').length).toBe(3);
        expect(check(report, 'write-floating-time-range').outcome).toBe('inconclusive');
        expect(report.cleanup?.allRemoved).toBe(true);
    });
});

describe('write-moved-override-in-span: third Tuesday moved to Thursday', () => {
    test('wide sanity, Thursday, vacated Tuesday and Monday-Friday counts and tuples', async () => {
        const { report, fake } = await run();
        const result = check(report, 'write-moved-override-in-span');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ sanityPassed: true, wideExpandCount: 10, widePlainCount: 2, thursdayExpandCount: 1, thursdayExpandTuples: ['20270121T100000Z/20270121T110000Z/20270119T100000Z'], tuesdayExpandCount: 0, weekExpandCount: 1, weekPlainCount: 2 });
        const put = fake.requests.find((r) => r.method === 'PUT' && r.url.pathname.endsWith('-wmovespan.ics'));
        expect(put?.body).toContain('DTSTART:20270105T100000Z');
        expect(put?.body).toContain('RRULE:FREQ=WEEKLY;COUNT=10');
    });

    test('empty Thursday is refuted only after wide sanity passes', async () => {
        const { report } = await run({ overrideMatching: 'original-slot' });
        expect(check(report, 'write-moved-override-in-span').outcome).toBe('refuted');
        expect(ev(report, 'write-moved-override-in-span')).toMatchObject({ sanityPassed: true, thursdayExpandCount: 0 });
    });

    test('failed wide sanity is inconclusive and skips narrow queries', async () => {
        const { report } = await run({ expand: false });
        expect(check(report, 'write-moved-override-in-span').outcome).toBe('inconclusive');
        expect(ev(report, 'write-moved-override-in-span')).toMatchObject({ sanityPassed: false, narrowClaimsEvaluated: false });
    });

    for (const fault of ['put', 'status', 'tuple', 'uid'] as const) {
        test(`${fault} is inconclusive`, async () => {
            const { report } = await run({
                hook: (req) => fault === 'put' && req.method === 'PUT' && req.url.pathname.endsWith('-wmovespan.ics') ? new Response('no', { status: 403 }) : undefined,
                transformResponse: async (req, res) => {
                    if (req.method !== 'REPORT' || !req.body.includes('start="20270121T000000Z"') || !req.body.includes('<C:expand')) { return res; }
                    if (fault === 'status') { return new Response('no', { status: 500 }); }
                    const text = await res.text();
                    return new Response(fault === 'tuple' ? text.replaceAll('20270121T100000Z', '20270121T120000Z') : fault === 'uid' ? text.replace(/UID:[^\r\n<]+/g, 'UID:foreign') : text, { status: res.status, headers: res.headers });
                },
            });
            expect(check(report, 'write-moved-override-in-span').outcome).toBe('inconclusive');
        });
    }
});

describe('write-expand-date (W1): a weekly all-day series', () => {
    test('a server that keeps VALUE=DATE is confirmed, with the dates recorded', async () => {
        const { report } = await run({ expandStyle: 'keep-forms' });
        expect(check(report, 'write-expand-date').outcome).toBe('confirmed');
        expect(ev(report, 'write-expand-date')).toMatchObject({
            instancesReturned: 4, dtstartKinds: { date: 4 }, dtendKinds: { date: 4 }, recurrenceIdKinds: { date: 4 },
            startValues: ['20261203', '20261210', '20261217', '20261224'],
            endValues: ['20261204', '20261211', '20261218', '20261225'],
            recurrenceIdValues: ['20261203', '20261210', '20261217', '20261224'],
            startsOnExpectedDates: 4, endsOnExpectedDates: 4, rrulePresent: false,
        });
    });

    test('a server that turns the dates into UTC midnights is refuted, and the values show it', async () => {
        const { report } = await run();
        expect(check(report, 'write-expand-date').outcome).toBe('refuted');
        expect(ev(report, 'write-expand-date')).toMatchObject({ dtstartKinds: { utc: 4, date: 0 }, startValues: ['20261203T000000Z', '20261210T000000Z', '20261217T000000Z', '20261224T000000Z'] });
    });
});

describe('write-expand-floating (W2): a weekly floating series', () => {
    test('floating values that stay floating are confirmed', async () => {
        const { report } = await run({ expandStyle: 'keep-forms' });
        expect(check(report, 'write-expand-floating').outcome).toBe('confirmed');
        expect(ev(report, 'write-expand-floating')).toMatchObject({
            instancesReturned: 4, dtstartKinds: { floating: 4 }, startsEqualSent: 4,
            startValues: ['20261204T100000', '20261211T100000', '20261218T100000', '20261225T100000'],
        });
    });

    test('floating values given a Z are refuted', async () => {
        const { report } = await run();
        expect(check(report, 'write-expand-floating').outcome).toBe('refuted');
        expect(ev(report, 'write-expand-floating')).toMatchObject({ dtstartKinds: { utc: 4, floating: 0 }, startsEqualSent: 0 });
    });
});

describe('write-expand-tzid-dst (W3): a weekly TZID=America/New_York series across the March change', () => {
    const EXPECTED = ['20270307T140000Z', '20270314T130000Z', '20270321T130000Z', '20270328T130000Z'];

    test('UTC output at the right instants is confirmed', async () => {
        const { report } = await run();
        expect(check(report, 'write-expand-tzid-dst').outcome).toBe('confirmed');
        expect(ev(report, 'write-expand-tzid-dst')).toMatchObject({
            instancesReturned: 4, dtstartKinds: { utc: 4 }, startValues: EXPECTED, expectedInstants: EXPECTED, allInstantsMatch: true,
            instantMatches: { instance0: true, instance1: true, instance2: true, instance3: true },
        });
    });

    test('TZID output is checked against the same instants using the zone’s rules', async () => {
        const { report } = await run({ expandStyle: 'keep-forms' });
        expect(check(report, 'write-expand-tzid-dst').outcome).toBe('confirmed');
        expect(ev(report, 'write-expand-tzid-dst')).toMatchObject({
            dtstartKinds: { tzid: 4 }, startValues: ['20270307T090000', '20270314T090000', '20270321T090000', '20270328T090000'], allInstantsMatch: true, vtimezoneComponentsReturned: 1,
        });
    });

    test('a server that ignores the zone puts every instance an hour or more off', async () => {
        const { report } = await run({ tzPolicy: 'ignore' });
        expect(check(report, 'write-expand-tzid-dst').outcome).toBe('refuted');
        expect(ev(report, 'write-expand-tzid-dst')).toMatchObject({ allInstantsMatch: false, instantMatches: { instance0: false, instance3: false } });
    });
});

describe('write-custom-tzid (W4): a custom zone whose rules disagree with tzdb', () => {
    const EMBEDDED = ['20270315T140000Z', '20270322T140000Z', '20270329T140000Z'];
    const TZDB = ['20270315T130000Z', '20270322T130000Z', '20270329T130000Z'];

    test('a server that stores the VTIMEZONE and uses its rules is confirmed', async () => {
        const { report } = await run();
        expect(check(report, 'write-custom-tzid').outcome).toBe('confirmed');
        expect(ev(report, 'write-custom-tzid')).toMatchObject({
            putStatus: 201, vtimezonePreserved: true, vtimezoneRulesPreserved: true, instancesReturned: 3, startValues: EMBEDDED,
            expectedEmbeddedInstants: EMBEDDED, expectedTzdbInstants: TZDB, instancesMatchingEmbedded: 3, instancesMatchingTzdb: 0, instancesMatchingNeither: 0, instancesObservable: 3,
        });
    });

    test('a server that maps the name to a tzdb zone is refuted', async () => {
        const { report } = await run({ unknownTzid: 'as-new-york' });
        expect(check(report, 'write-custom-tzid').outcome).toBe('refuted');
        expect(ev(report, 'write-custom-tzid')).toMatchObject({ startValues: TZDB, instancesMatchingEmbedded: 0, instancesMatchingTzdb: 3 });
    });

    test('a server that reads the unknown name as UTC matches neither answer', async () => {
        const { report } = await run({ unknownTzid: 'as-utc' });
        expect(check(report, 'write-custom-tzid').outcome).toBe('refuted');
        expect(ev(report, 'write-custom-tzid')).toMatchObject({ instancesMatchingNeither: 3, instancesMatchingEmbedded: 0, instancesMatchingTzdb: 0 });
    });

    test('a refused PUT and a dropped VTIMEZONE are both reported', async () => {
        const refused = await run({ vtimezonePolicy: 'refuse-unknown' });
        expect(check(refused.report, 'write-custom-tzid').outcome).toBe('refuted');
        expect(ev(refused.report, 'write-custom-tzid')).toMatchObject({ putStatus: 400 });
        const dropped = await run({ vtimezonePolicy: 'strip-unknown' });
        expect(check(dropped.report, 'write-custom-tzid').outcome).toBe('refuted');
        expect(ev(dropped.report, 'write-custom-tzid')).toMatchObject({ putStatus: 201, vtimezonePreserved: false });
    });

    test('when expansion keeps the TZID the rules cannot be seen: inconclusive', async () => {
        const { report } = await run({ expandStyle: 'keep-forms' });
        expect(check(report, 'write-custom-tzid').outcome).toBe('inconclusive');
        expect(ev(report, 'write-custom-tzid')).toMatchObject({ dtstartKinds: { tzid: 3 }, instancesObservable: 0 });
    });
});

describe('write-moved-overrides (W5): overrides moved past the end of a daily series', () => {
    const WIDE_START = 'start="20270109T000000Z"';
    const OVERRIDE_IN = '20270130T100000Z/20270130T110000Z/20270111T100000Z';
    const OVERRIDE_OUT = '20270120T100000Z/20270120T110000Z/20270113T100000Z';

    test('a server that counts an override by its own times is confirmed, with counts and tuples for every query, expanded and plain', async () => {
        const { report } = await run();
        expect(check(report, 'write-moved-overrides').outcome).toBe('confirmed');
        expect(ev(report, 'write-moved-overrides')).toMatchObject({
            firstDay: '20270110', expandStatus: 207, sanityPassed: true, narrowClaimsEvaluated: true,
            movedInPutStatus: 201, movedOutPutStatus: 201,
            movedInWideExpandCount: 5, movedInWideExpandDistinctCount: 5, movedInWideExpandRecurrenceIdKinds: { utc: 5 }, movedInSanityExpandedAllFive: true,
            movedInWideExpandTuples: [
                '20270110T100000Z/20270110T110000Z/20270110T100000Z', '20270112T100000Z/20270112T110000Z/20270112T100000Z', '20270113T100000Z/20270113T110000Z/20270113T100000Z',
                '20270114T100000Z/20270114T110000Z/20270114T100000Z', OVERRIDE_IN,
            ],
            movedInWidePlainReturned: true, movedInWidePlainCount: 2, movedInWidePlainTuples: ['20270110T100000Z/20270110T110000Z/-', OVERRIDE_IN], movedInSanityPlainSelectsWithBothComponents: true,
            movedInMovedWindowExpandCount: 1, movedInMovedWindowExpandTuples: [OVERRIDE_IN], movedInMovedWindowExpandReturnsOverride: true,
            movedInMovedWindowPlainReturned: true, movedInMovedWindowPlainSelects: true, movedInMovedWindowPlainCount: 2,
            movedInOriginalWindowExpandCount: 0, movedInOriginalWindowExpandReturned: false, movedInOriginalWindowExpandEmpty: true,
            movedInOriginalWindowPlainReturned: false, movedInOriginalWindowPlainCount: 0, movedInOriginalWindowPlainSelectsNothing: true,
            movedOutWideExpandCount: 5, movedOutMovedWindowExpandTuples: [OVERRIDE_OUT], movedOutMovedWindowPlainSelects: true,
            movedOutOriginalWindowExpandCount: 0, movedOutOriginalWindowPlainSelectsNothing: true,
        });
    });

    test('a server that counts an override by the slot it replaces passes the sanity step and then fails both narrow claims', async () => {
        const { report } = await run({ overrideMatching: 'original-slot' });
        expect(check(report, 'write-moved-overrides').outcome).toBe('refuted');
        expect(ev(report, 'write-moved-overrides')).toMatchObject({
            sanityPassed: true, narrowClaimsEvaluated: true,
            movedInMovedWindowExpandCount: 0, movedInMovedWindowExpandReturnsOverride: false, movedInMovedWindowPlainSelects: false,
            movedInOriginalWindowExpandCount: 1, movedInOriginalWindowExpandEmpty: false, movedInOriginalWindowPlainReturned: true,
            movedOutMovedWindowExpandCount: 0, movedOutOriginalWindowExpandCount: 1,
        });
    });

    test('a wide window that does not return all five instances is inconclusive, with the raw counts and no narrow claims', async () => {
        const { report } = await run({ transformResponse: async (req, res) => {
            if (req.method !== 'REPORT' || !req.body.includes('<C:expand') || !req.body.includes(WIDE_START)) { return res; }
            // Drops the moved-in override from the wide expand answer.
            return new Response((await res.text()).replace(/BEGIN:VEVENT(?:(?!END:VEVENT)[\s\S])*?DTSTART:20270130T100000Z(?:(?!END:VEVENT)[\s\S])*?END:VEVENT/g, ''), { status: res.status, headers: res.headers });
        } });
        const result = check(report, 'write-moved-overrides');
        expect(result.outcome).toBe('inconclusive');
        expect(result.evidence).toMatchObject({ sanityPassed: false, narrowClaimsEvaluated: false, movedInWideExpandCount: 4, movedInSanityExpandedAllFive: false, movedInWidePlainCount: 2, movedOutWideExpandCount: 5 });
        expect(Object.keys(result.evidence).filter((k) => k.includes('MovedWindow') || k.includes('OriginalWindow'))).toEqual([]);
    });

    test('a failing expand query is inconclusive and the status is recorded', async () => {
        const { report } = await run({ hook: (req) => (req.method === 'REPORT' && req.body.includes('<C:expand') && req.url.pathname.includes('caldav-mcp-probe-') ? new Response('boom', { status: 500 }) : undefined) });
        expect(check(report, 'write-moved-overrides').outcome).toBe('inconclusive');
        expect(ev(report, 'write-moved-overrides')).toMatchObject({ expandStatus: 500, sanityPassed: false, narrowClaimsEvaluated: false });
    });

    test('a refused PUT is inconclusive and nothing is queried', async () => {
        const { report, fake } = await run({ hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-wmoveout.ics') ? new Response('no', { status: 403 }) : undefined) });
        expect(check(report, 'write-moved-overrides').outcome).toBe('inconclusive');
        expect(ev(report, 'write-moved-overrides')).toMatchObject({ movedInPutStatus: 201, movedOutPutStatus: 403 });
        expect(fake.requests.some((r) => r.method === 'REPORT' && r.body.includes(WIDE_START))).toBe(false);
    });
});

/** The 2027 instants of the DST checks. */
const REP = { first: '20271107T053000Z', second: '20271107T063000Z', end: '20271107T073000Z' };

describe('write-dst-repeated-hour: 01:30 America/New_York on 2027-11-07 occurs twice', () => {
    test('a server that picks the first occurrence is confirmed, with stored forms, expanded tuples and window selections', async () => {
        const { report } = await run();
        expect(check(report, 'write-dst-repeated-hour').outcome).toBe('confirmed');
        expect(ev(report, 'write-dst-repeated-hour')).toMatchObject({
            singlePutStatus: 201, seriesPutStatus: 201,
            singleReadBackStatus: 200, singleStoredDtstartKinds: { tzid: 1 }, singleStoredDtendKinds: { tzid: 1 }, singleStoredDtstart: '20271107T013000', singleStoredDtend: '20271107T023000', singleStoredTzidKept: true, singleStoredVtimezones: 1, singleStoredRrulePresent: false,
            seriesStoredDtstart: '20271031T013000', seriesStoredRrulePresent: true, seriesStoredVevents: 1,
            singleExpandedStatus: 207, singleExpandedCount: 1, singleExpandedDtstartKinds: { utc: 1 }, singleExpandedRecurrenceIdKinds: { none: 1 }, singleExpandedTuples: [`${REP.first}/${REP.end}/-`],
            seriesExpandedCount: 3, seriesExpandedRecurrenceIdKinds: { utc: 3 },
            seriesExpandedTuples: ['20271031T053000Z/20271031T063000Z/20271031T053000Z', `${REP.first}/${REP.end}/${REP.first}`, '20271114T063000Z/20271114T073000Z/20271114T063000Z'],
            window1Status: 207, window1Start: '20271107T051500Z', window1End: '20271107T054500Z', window2Start: '20271107T061500Z', window2End: '20271107T064500Z',
            singleInWindow1: true, singleInWindow2: true, seriesInWindow1: true, seriesInWindow2: true,
            expandedSingleIsFirst: true, expandedSeriesIsFirst: true, windowSingleIsFirst: true, windowSeriesIsFirst: true, endsPlausibleWhereReadable: true, coverageComplete: true,
            expectedFirstInstant: REP.first, expectedSecondInstant: REP.second,
        });
    });

    test('a server that picks the second occurrence is refuted, and the second instant shows in the tuples and the windows', async () => {
        const { report } = await run({ repeatedHour: 'second' });
        expect(check(report, 'write-dst-repeated-hour').outcome).toBe('refuted');
        expect(ev(report, 'write-dst-repeated-hour')).toMatchObject({
            singleExpandedTuples: [`${REP.second}/${REP.end}/-`], seriesExpandedTuples: expect.arrayContaining([`${REP.second}/${REP.end}/${REP.second}`]),
            singleInWindow1: false, singleInWindow2: true, seriesInWindow1: false, seriesInWindow2: true,
            expandedSingleIsSecond: true, expandedSeriesIsSecond: true, windowSingleIsSecond: true, windowSeriesIsSecond: true, windowSingleIsFirst: false,
        });
    });

    test('expansion that keeps the TZID cannot be read, but the windows settle it', async () => {
        const { report } = await run({ expandStyle: 'keep-forms' });
        expect(check(report, 'write-dst-repeated-hour').outcome).toBe('confirmed');
        expect(ev(report, 'write-dst-repeated-hour')).toMatchObject({ singleExpandedDtstartKinds: { tzid: 1 }, expandedSingleReadable: false, expandedSeriesReadable: false, windowSingleIsFirst: true });
    });

    test('a window query that is not answered leaves it inconclusive, whatever the rest says', async () => {
        const { report } = await run({ hook: (req) => (req.method === 'REPORT' && req.body.includes('start="20271107T061500Z"') ? new Response('boom', { status: 500 }) : undefined) });
        expect(check(report, 'write-dst-repeated-hour').outcome).toBe('inconclusive');
        expect(ev(report, 'write-dst-repeated-hour')).toMatchObject({ window2Status: 500, singleInWindow2: null, windowSingleReadable: false, expandedSingleIsFirst: true, coverageComplete: false });
    });

    test('a server that places it at neither occurrence is inconclusive', async () => {
        const { report } = await run({ tzPolicy: 'ignore' });
        expect(check(report, 'write-dst-repeated-hour').outcome).toBe('inconclusive');
        expect(ev(report, 'write-dst-repeated-hour')).toMatchObject({ expandedSingleMatchesNeither: true, windowSingleMatchesNeither: true });
    });
});

describe('write-dst-skipped-hour: 02:30 America/New_York on 2027-03-14 does not exist', () => {
    const SKIP = { rfc: '20270314T073000Z', after: '20270314T063000Z' };

    test('a server that reads it with the offset before the gap is confirmed (07:30Z)', async () => {
        const { report } = await run();
        expect(check(report, 'write-dst-skipped-hour').outcome).toBe('confirmed');
        expect(ev(report, 'write-dst-skipped-hour')).toMatchObject({
            singlePutStatus: 201, seriesPutStatus: 201, singleStoredDtstart: '20270314T023000', singleStoredDtend: '20270314T033000', singleStoredTzidKept: true,
            singleExpandedTuples: [`${SKIP.rfc}/${SKIP.rfc}/-`],
            seriesExpandedTuples: ['20270307T073000Z/20270307T083000Z/20270307T073000Z', `${SKIP.rfc}/${SKIP.rfc}/${SKIP.rfc}`, '20270321T063000Z/20270321T073000Z/20270321T063000Z'],
            window1Start: '20270314T071500Z', window2Start: '20270314T061500Z', singleInWindow1: true, singleInWindow2: false, seriesInWindow1: true, seriesInWindow2: false,
            expandedSingleIsBeforeGap: true, windowSingleIsBeforeGap: true, expectedInstant: SKIP.rfc, alternativeInstant: SKIP.after, coverageComplete: true,
        });
    });

    test('a server that reads it with the offset after the gap is refuted (06:30Z)', async () => {
        const { report } = await run({ skippedHour: 'after-gap' });
        expect(check(report, 'write-dst-skipped-hour').outcome).toBe('refuted');
        expect(ev(report, 'write-dst-skipped-hour')).toMatchObject({
            singleExpandedTuples: [`${SKIP.after}/${SKIP.rfc}/-`], singleInWindow1: true, singleInWindow2: true, expandedSingleIsAfterGap: true, windowSingleIsAfterGap: true, windowSingleIsBeforeGap: false,
        });
    });

    test('a server that places it somewhere else is refuted', async () => {
        const { report } = await run({ tzPolicy: 'ignore' });
        expect(check(report, 'write-dst-skipped-hour').outcome).toBe('refuted');
        expect(ev(report, 'write-dst-skipped-hour')).toMatchObject({ expandedSingleMatchesNeither: true });
    });

    test('a refused PUT is inconclusive and its status and preconditions are recorded, while the other event is still examined', async () => {
        const { report } = await run({ hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-wdstskpone.ics')
            ? new Response('<d:error xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><cal:valid-calendar-data/></d:error>', { status: 400, headers: { 'content-type': 'text/xml' } }) : undefined) });
        expect(check(report, 'write-dst-skipped-hour').outcome).toBe('inconclusive');
        const evidence = ev(report, 'write-dst-skipped-hour');
        expect(evidence).toMatchObject({ singlePutStatus: 400, singlePreconditions: ['valid-calendar-data'], seriesPutStatus: 201, seriesExpandedCount: 3, coverageComplete: false });
        expect(evidence).not.toHaveProperty('singleExpandedTuples');
    });

    test('data that cannot be read back is inconclusive', async () => {
        const { report } = await run({ hook: (req) => (req.method === 'GET' && req.url.pathname.endsWith('-wdstskpser.ics') ? new Response('gone', { status: 404 }) : undefined) });
        expect(check(report, 'write-dst-skipped-hour').outcome).toBe('inconclusive');
        expect(ev(report, 'write-dst-skipped-hour')).toMatchObject({ seriesReadBackStatus: 404, coverageComplete: false });
    });
});

describe('write-dst-utc-in-repeated-hour: the control, two UTC events', () => {
    test('stored and expanded as UTC, distinct, and selected exactly by the windows that overlap them', async () => {
        const { report } = await run();
        expect(check(report, 'write-dst-utc-in-repeated-hour').outcome).toBe('confirmed');
        expect(ev(report, 'write-dst-utc-in-repeated-hour')).toMatchObject({
            firstPutStatus: 201, secondPutStatus: 201,
            firstStoredDtstartKinds: { utc: 1 }, firstStoredDtstart: '20271107T053000Z', firstStoredDtend: '20271107T063000Z', firstStoredTzidKept: false, firstStoredVtimezones: 0,
            secondStoredDtstart: '20271107T063000Z', secondStoredDtend: '20271107T073000Z',
            firstExpandedTuples: ['20271107T053000Z/20271107T063000Z/-'], secondExpandedTuples: ['20271107T063000Z/20271107T073000Z/-'], bothStayDistinct: true,
            firstInWindow1: true, firstInWindow2: true, firstInWindow3: false, secondInWindow1: false, secondInWindow2: true, secondInWindow3: true,
            firstStoredMatchesSent: true, firstExpandedMatchesSent: true, firstSelectionMatchesOverlap: true, secondSelectionMatchesOverlap: true, coverageComplete: true,
        });
    });

    test('a changed stored value is refuted', async () => {
        const { report } = await run({ transformResponse: async (req, res) => (req.method === 'GET' && req.url.pathname.endsWith('-wdstutcb.ics')
            ? new Response((await res.text()).replace('DTSTART:20271107T063000Z', 'DTSTART:20271107T053000Z'), { status: res.status, headers: res.headers }) : res) });
        expect(check(report, 'write-dst-utc-in-repeated-hour').outcome).toBe('refuted');
        expect(ev(report, 'write-dst-utc-in-repeated-hour')).toMatchObject({ secondStoredMatchesSent: false, firstStoredMatchesSent: true, secondStoredDtstart: '20271107T053000Z' });
    });

    test('a window that selects the wrong event is refuted', async () => {
        const { report } = await run({ timeRange: false });
        // With time-range filtering off every window selects every event: the control no longer matches the overlap rule.
        expect(check(report, 'write-dst-utc-in-repeated-hour').outcome).toBe('refuted');
        expect(ev(report, 'write-dst-utc-in-repeated-hour')).toMatchObject({ firstSelectionMatchesOverlap: false, firstStoredMatchesSent: true, firstExpandedMatchesSent: true });
    });

    test('an unanswered expand query is inconclusive', async () => {
        const { report } = await run({ hook: (req) => (req.method === 'REPORT' && req.body.includes('<C:expand') && req.url.pathname.includes('caldav-mcp-probe-') ? new Response('boom', { status: 500 }) : undefined) });
        expect(check(report, 'write-dst-utc-in-repeated-hour').outcome).toBe('inconclusive');
        expect(ev(report, 'write-dst-utc-in-repeated-hour')).toMatchObject({ firstExpandedStatus: 500, coverageComplete: false });
    });
});

describe('the new write checks publish no value they cannot attribute to the probe', () => {
    const response = (res: Response, body: string): Response => new Response(body, { status: res.status, headers: res.headers });
    const foreign = (text: string): string => text.replace(/UID:caldav-mcp-probe-[^\r\n<]+/g, 'UID:owner');
    const CASES: [string, string, readonly ('get' | 'expand' | 'plain')[]][] = [
        ['write-dst-repeated-hour', 'wdstrepone', ['get', 'expand']],
        ['write-dst-skipped-hour', 'wdstskpser', ['get', 'expand']],
        ['write-dst-utc-in-repeated-hour', 'wdstutcb', ['get', 'expand']],
        ['write-moved-overrides', 'wmovein', ['expand', 'plain']],
    ];
    for (const [id, suffix, faults] of CASES) {
        for (const fault of faults) {
            test(`${id}: a foreign UID in the ${fault} answer gives status and count evidence only`, async () => {
                const { report } = await run({ transformResponse: async (req, res) => {
                    const target = fault === 'get'
                        ? req.method === 'GET' && req.url.pathname.endsWith(`-${suffix}.ics`)
                        : req.method === 'REPORT' && req.url.pathname.includes('caldav-mcp-probe-') && req.body.includes('<C:expand') === (fault === 'expand') && (fault === 'expand' || req.body.includes('<C:calendar-data/>'));
                    return target ? response(res, foreign(await res.text())) : res;
                } });
                const result = check(report, id);
                expect(result.outcome).toBe('inconclusive');
                expect(result.evidence).toMatchObject({ provenanceVerified: false });
                expect(JSON.stringify(result.evidence)).not.toMatch(/20\d{6}/);
                expect(Object.keys(result.evidence).filter((k) => /Tuples|Stored|Start|End/.test(k))).toEqual([]);
                expect(report.cleanup?.allRemoved).toBe(true);
            });
        }
    }
});

describe('request counts of the new checks', () => {
    test('each check sends a fixed, small number of requests', async () => {
        const { fake } = await run();
        const firstPut = (suffix: string): number => fake.requests.findIndex((r) => r.method === 'PUT' && r.url.pathname.endsWith(`-${suffix}.ics`));
        const starts = ['wmovein', 'wmovespan', 'wdstrepone', 'wdstskpone', 'wdstutca', 'attmanaged'].map(firstPut);
        expect(starts.every((i) => i > 0)).toBe(true);
        const counts = starts.slice(0, -1).map((start, i) => (starts[i + 1] ?? 0) - start);
        // moved: 2 PUT + 2 wide + 4 + 4 narrow REPORTs; repeated/skipped: 2 PUT + 2 GET + 1 expand + 2 windows; control: the same with 3 windows.
        expect(counts).toEqual([12, 9, 7, 7, 8]);
    });
});

describe('write-feb29 (W6): yearly VALUE=DATE on February 29, COUNT=3, over 2028 to 2037', () => {
    test('leap years only is confirmed', async () => {
        const { report } = await run();
        expect(check(report, 'write-feb29').outcome).toBe('confirmed');
        expect(ev(report, 'write-feb29')).toMatchObject({
            instancesReturned: 3, startValues: ['20280229T000000Z', '20320229T000000Z', '20360229T000000Z'], expectedDates: ['20280229', '20320229', '20360229'], datesMatchRfc: true,
        });
    });

    test('February 28 or March 1 in other years is refuted', async () => {
        for (const feb29 of ['clamp', 'roll'] as const) {
            const { report } = await run({ feb29, expandStyle: 'keep-forms' });
            expect(check(report, 'write-feb29').outcome).toBe('refuted');
            expect(ev(report, 'write-feb29')).toMatchObject({ datesMatchRfc: false, instancesReturned: 3 });
        }
        const clamped = await run({ feb29: 'clamp', expandStyle: 'keep-forms' });
        expect(ev(clamped.report, 'write-feb29')).toMatchObject({ startValues: ['20280229', '20290228', '20300228'] });
    });
});

describe('write-floating-time-range (W7): floating and DATE values against UTC boundaries', () => {
    test('a server that reads them in UTC is refuted, and each window shows it', async () => {
        const { report } = await run();
        expect(check(report, 'write-floating-time-range').outcome).toBe('refuted');
        expect(ev(report, 'write-floating-time-range')).toMatchObject({
            calendarTimezoneKept: true,
            floatingInLateUtcWindow: true, floatingInLateLocalWindow: false, dateInEarlyUtcWindow: true, dateInEarlyLocalWindow: false,
            floatingUsesUtc: true, floatingUsesCalendarTimezone: false, dateUsesUtc: true, dateUsesCalendarTimezone: false,
        });
    });

    test('a server that reads them in the calendar-timezone is confirmed', async () => {
        const { report } = await run({ floatingInterpretation: 'calendar-timezone' });
        expect(check(report, 'write-floating-time-range').outcome).toBe('confirmed');
        expect(ev(report, 'write-floating-time-range')).toMatchObject({
            floatingInLateUtcWindow: false, floatingInLateLocalWindow: true, dateInEarlyUtcWindow: false, dateInEarlyLocalWindow: true,
            floatingUsesCalendarTimezone: true, dateUsesCalendarTimezone: true,
        });
    });

    test('a calendar-timezone the server did not keep makes the test inconclusive, with the answers still recorded', async () => {
        const { report } = await run({ calendarTimezone: 'ignored' });
        expect(check(report, 'write-floating-time-range').outcome).toBe('inconclusive');
        expect(ev(report, 'write-floating-time-range')).toMatchObject({ calendarTimezoneKept: false, floatingUsesUtc: true });
        expect(ev(report, 'write-mkcalendar')).toMatchObject({ calendarTimezoneSent: true, calendarTimezonePresent: false, calendarTimezoneKept: false });
    });

    test('a server that answers with a calendar-timezone of its own is not mistaken for one that kept the probe’s', async () => {
        const { report } = await run({ calendarTimezone: 'replaced', floatingInterpretation: 'calendar-timezone' });
        expect(ev(report, 'write-mkcalendar')).toMatchObject({ calendarTimezonePresent: true, calendarTimezoneKept: false });
        expect(check(report, 'write-floating-time-range').outcome).toBe('inconclusive');
        expect(ev(report, 'write-floating-time-range')).toMatchObject({ calendarTimezoneKept: false });
    });
});

describe('write-date-zero-length (W8): a VALUE=DATE event whose DTEND equals its DTSTART', () => {
    test('accepted and kept as sent', async () => {
        const { report } = await run();
        expect(check(report, 'write-date-zero-length').outcome).toBe('confirmed');
        expect(ev(report, 'write-date-zero-length')).toMatchObject({
            putStatus: 201, readBackStatus: 200, readBackDtstartValue: '20270105', readBackDtendValue: '20270105', readBackDtendEqualsSent: true,
            expandStatus: 207, instancesReturned: 1, startValues: ['20270105T000000Z'], endValues: ['20270105T000000Z'],
        });
    });

    test('refused, or altered on read-back', async () => {
        const refused = await run({ dateZeroLength: 'refuse' });
        expect(check(refused.report, 'write-date-zero-length').outcome).toBe('refuted');
        expect(ev(refused.report, 'write-date-zero-length')).toMatchObject({ putStatus: 400 });
        const rewritten = await run({ dateZeroLength: 'rewrite' });
        expect(check(rewritten.report, 'write-date-zero-length').outcome).toBe('refuted');
        expect(ev(rewritten.report, 'write-date-zero-length')).toMatchObject({ putStatus: 201, readBackDtendValue: '20270106', readBackDtendEqualsSent: false });
    });
});

describe('write-range-thisandfuture (W8): an override with RECURRENCE-ID;RANGE=THISANDFUTURE', () => {
    test('accepted with the parameter kept, and expanded for one instance only', async () => {
        const { report } = await run();
        expect(check(report, 'write-range-thisandfuture').outcome).toBe('confirmed');
        expect(ev(report, 'write-range-thisandfuture')).toMatchObject({
            putStatus: 201, rangeOnReadBack: 1, overridesOnReadBack: 1, instancesReturned: 4, shiftedInstances: 1, appliesToFollowingInstances: false,
            startValues: ['20261207T100000Z', '20261214T120000Z', '20261221T100000Z', '20261228T100000Z'],
        });
    });

    test('a server that applies it to later instances is visible in the expansion', async () => {
        const { report } = await run({ thisAndFuture: 'applied' });
        expect(ev(report, 'write-range-thisandfuture')).toMatchObject({ shiftedInstances: 3, appliesToFollowingInstances: true });
    });

    test('a dropped parameter or a refusal is refuted', async () => {
        const stripped = await run({ rangeParam: 'strip' });
        expect(check(stripped.report, 'write-range-thisandfuture').outcome).toBe('refuted');
        expect(ev(stripped.report, 'write-range-thisandfuture')).toMatchObject({ putStatus: 201, rangeOnReadBack: 0 });
        const refused = await run({ rangeParam: 'refuse' });
        expect(check(refused.report, 'write-range-thisandfuture').outcome).toBe('refuted');
        expect(ev(refused.report, 'write-range-thisandfuture')).toMatchObject({ putStatus: 400 });
    });
});

describe('adversarial synthetic evidence', () => {
    const response = (res: Response, body: string): Response => new Response(body, { status: res.status, headers: res.headers });
    for (const fault of ['duplicate', 'rid', 'end'] as const) {
        test(`instance tuples reject ${fault} corruption`, async () => {
            const { report } = await run({ expandStyle: 'keep-forms', transformResponse: async (req, res) => {
                if (!req.body.includes('<C:expand') || !req.url.pathname.includes('caldav-mcp-probe-')) { return res; }
                let body = await res.text();
                body = body.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g, (block) => {
                    if (!/-w(date|float)\b/.test(block)) { return block; }
                    if (fault === 'rid') { return block.replace(/(RECURRENCE-ID[^:]*:)[^\r\n<]+/, '$120261203'); }
                    if (fault === 'end') { return block.replace(/(DTEND[^:]*:)[^\r\n<]+/, '$120261204T110000'); }
                    return block;
                });
                if (fault === 'duplicate') {
                    const first = new Map<string, string>();
                    body = body.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g, (block) => {
                        const uid = /UID:([^\r\n<]+)/.exec(block)?.[1] ?? '';
                        if (!/-w(date|float)\b/.test(uid)) { return block; }
                        const saved = first.get(uid); first.set(uid, saved ?? block); return saved ?? block;
                    });
                }
                return response(res, body);
            } });
            for (const id of ['write-expand-date', 'write-expand-floating']) { expect(check(report, id).outcome).toBe('refuted'); }
        });
    }
    test('RANGE value comparison is case-insensitive', async () => {
        const { report } = await run({ transformResponse: async (req, res) => {
            if (req.method !== 'GET' || !req.url.pathname.endsWith('-wrange.ics')) { return res; }
            return response(res, (await res.text()).replace('RANGE=THISANDFUTURE', 'RANGE=thisandfuture'));
        } });
        expect(check(report, 'write-range-thisandfuture').outcome).toBe('confirmed');
        expect(ev(report, 'write-range-thisandfuture').rangeValuePreserved).toBe(true);
    });
    for (const fault of ['start', 'kind', 'range'] as const) {
        test(`read-back rejects changed ${fault}`, async () => {
            const { report } = await run({ transformResponse: async (req, res) => {
                if (req.method !== 'GET' || !/-w(datezl|range)\.ics$/.test(req.url.pathname)) { return res; }
                const text = await res.text();
                const changed = fault === 'start' ? text.replace('DTSTART;VALUE=DATE:20270105', 'DTSTART;VALUE=DATE:20270104')
                    : fault === 'kind' ? text.replaceAll('VALUE=DATE:', 'VALUE=DATE-TIME:') : text.replace('RANGE=THISANDFUTURE', 'RANGE=THISANDPRIOR');
                return response(res, changed);
            } });
            expect(check(report, fault === 'range' ? 'write-range-thisandfuture' : 'write-date-zero-length').outcome).toBe('refuted');
        });
    }
    test('older value-recording write checks also reject wrong-UID read-back', async () => {
        const fake = standardAccount(PLAIN, { expand: true, requireEnd: false, transformResponse: async (req, res) => {
            if (req.method !== 'GET' || !/-?(tzvt|noend|invite)\.ics$/.test(req.url.pathname)) { return res; }
            return response(res, (await res.text()).replace(/UID:caldav-mcp-probe-[^\r\n]+/g, 'UID:owner'));
        } });
        const report = await probe(fake, { ...WRITE, invite: true }, creds, {}, 'invitee@example.invalid');
        for (const id of ['roundtrip-tzid-with-vtimezone', 'write-no-end', 'write-invite']) {
            expect(check(report, id).outcome).toBe('inconclusive');
            expect(check(report, id).evidence.provenanceVerified).toBe(false);
        }
        expect(report.cleanup?.allRemoved).toBe(true);
    });
    for (const fault of ['redirect', 'uid', 'expanded-uid', 'report-redirect'] as const) {
        test(`unproven synthetic provenance (${fault}) emits no values`, async () => {
            const { report } = await run({
                hook: (req) => fault === 'redirect' && req.method === 'GET' && req.url.pathname.endsWith('-wdatezl.ics')
                    ? new Response(null, { status: 302, headers: { location: '/10000000001/calendars/home/owner.ics' } })
                    : fault === 'report-redirect' && req.method === 'REPORT' && req.body.includes('<C:expand') && req.url.pathname.includes('caldav-mcp-probe-')
                        ? new Response(null, { status: 307, headers: { location: '/10000000001/calendars/home/' } })
                        : req.url.pathname.endsWith('/owner.ics') ? new Response('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:owner\r\nDTSTART;VALUE=DATE:19990102\r\nDTEND;VALUE=DATE:19990103\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n') : undefined,
                transformResponse: async (req, res) => {
                    const target = fault === 'uid' ? req.method === 'GET' && req.url.pathname.endsWith('-wdatezl.ics')
                        : fault === 'expanded-uid' && req.body.includes('<C:expand') && req.url.pathname.includes('caldav-mcp-probe-');
                    return target ? response(res, (await res.text()).replace(/UID:caldav-mcp-probe-[^\r\n<]+/g, 'UID:owner').replace(/202[678]\d{4}/g, '19990102')) : res;
                },
            });
            const id = fault === 'redirect' || fault === 'uid' ? 'write-date-zero-length' : 'write-expand-date';
            const result = check(report, id);
            if (fault === 'expanded-uid' || fault === 'report-redirect') {
                expect(check(report, 'write-expand').outcome).toBe('inconclusive');
            }
            expect(result.outcome).toBe('inconclusive');
            expect(JSON.stringify(result.evidence)).not.toContain('19990102');
            expect(result.evidence).not.toHaveProperty('startValues');
            expect(result.evidence).not.toHaveProperty('readBackDtstartValue');
            expect(report.cleanup?.allRemoved).toBe(true);
        });
    }
});

describe('malformed and incomplete expansion evidence fails closed', () => {
    for (const [id, window] of [
        ['write-moved-overrides', 'start="20270111T000000Z"'],
        ['write-dst-repeated-hour', 'start="20271107T061500Z"'],
    ]) {
        for (const fault of ['malformed', 'resource-status'] as const) {
            test(`${id} rejects ${fault} 207 window evidence`, async () => {
                const { report } = await run({ hook: (req) => req.method === 'REPORT' && req.body.includes(window ?? '')
                    ? new Response(fault === 'malformed' ? 'not XML' : '<d:multistatus xmlns:d="DAV:"><d:response><d:href>failed.ics</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response></d:multistatus>', { status: 207 }) : undefined });
                expect(check(report, id ?? '').outcome).toBe('inconclusive');
            });
        }
    }
    test('DST rejects UTC properties that illegally retain TZID', async () => {
        const { report } = await run({ transformResponse: async (req, res) => {
            if (!req.body.includes('<C:expand')) { return res; }
            const text = (await res.text()).replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g, (block) => !block.includes('-wdstrep') ? block : block.replace(/(DTSTART|DTEND|RECURRENCE-ID):/g, '$1;TZID=America/New_York:'));
            return new Response(text, { status: res.status, headers: res.headers });
        } });
        expect(check(report, 'write-dst-repeated-hour').outcome).toBe('inconclusive');
        expect(ev(report, 'write-dst-repeated-hour').coverageComplete).toBe(false);
    });
    for (const fault of ['missing', 'duplicate'] as const) {
        test(`keep-TZID DST rejects ${fault} instances`, async () => {
            const { report } = await run({ expandStyle: 'keep-forms', transformResponse: async (req, res) => {
                if (!req.body.includes('<C:expand')) { return res; }
                let seen = false;
                const text = (await res.text()).replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g, (block) => {
                    if (!block.includes('-wdstrepser') || seen) { return block; }
                    seen = true;
                    return fault === 'missing' ? '' : `${block}\r\n${block}`;
                });
                return new Response(text, { status: res.status, headers: res.headers });
            } });
            expect(check(report, 'write-dst-repeated-hour').outcome).toBe('inconclusive');
            expect(ev(report, 'write-dst-repeated-hour').coverageComplete).toBe(false);
        });
        test(`custom TZID rejects ${fault} instances`, async () => {
            const { report } = await run({ transformResponse: async (req, res) => {
                if (!req.body.includes('<C:expand')) { return res; }
                let seen = false;
                const text = (await res.text()).replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g, (block) => {
                    if (!block.includes('-wcustom') || seen) { return block; }
                    seen = true;
                    return fault === 'missing' ? '' : `${block}\r\n${block}`;
                });
                return new Response(text, { status: res.status, headers: res.headers });
            } });
            expect(check(report, 'write-custom-tzid').outcome).toBe('refuted');
        });
    }
});

describe('degrading to inconclusive', () => {
    test('a server that answers every REPORT with an error leaves each expansion check inconclusive, not failed', async () => {
        const { report } = await run({ hook: (req) => (req.method === 'REPORT' && req.body.includes('<C:expand') && req.url.pathname.includes('caldav-mcp-probe-') ? new Response('boom', { status: 500 }) : undefined) });
        for (const id of ['write-expand-date', 'write-expand-floating', 'write-expand-tzid-dst', 'write-feb29', 'write-moved-overrides']) {
            expect(['inconclusive', 'refuted']).toContain(check(report, id).outcome);
            expect(ev(report, id)).toMatchObject({ expandStatus: 500 });
        }
        expect(report.cleanup?.allRemoved).toBe(true);
    });

    test('throttling in the middle stops the remaining writes of that check and cleanup still happens', async () => {
        let puts = 0;
        const { report, fake } = await run({ hook: (req) => (req.method === 'PUT' && ++puts === 20 ? new Response('busy', { status: 503, headers: { 'retry-after': '1' } }) : undefined) });
        expect(report.cleanup?.allRemoved).toBe(true);
        expect([...fake.calendars.keys()].filter((id) => id.startsWith('caldav-mcp-probe-'))).toEqual([]);
        expect(report.checks.filter((c) => c.outcome === 'error').map((c) => c.id)).toEqual([]);
    });
});
