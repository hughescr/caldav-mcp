/**
 * The read-only evidence for the phase 2 read path: what expansion does to value forms, whether
 * a calendar-query and a GET agree, limit-recurrence-set, payload sizes, how lax the data is,
 * and calendar-multiget. Every check records counts and fixed enums only.
 */
import { describe, expect, test } from 'bun:test';
import { FakeICloud, PLAIN, type FakeBehaviour, type FakeCalendarSeed } from './fixtures/probe/fake-icloud';
import { READ_ONLY, WRITE_METHODS, check, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const NEW_YORK = [
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
];

/** An iCalendar resource: calendar-level components first, then the events (each an array of lines). */
function resource(events: string[][], zones: string[] = []): string {
    const body = events.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']);
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//seed//EN', ...zones, ...body, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

const STAMP = 'DTSTAMP:20261101T000000Z';
const weekly = (uid: string, start: string[], extra: string[] = []): string[] => [`UID:${uid}`, STAMP, ...start, 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Secret title', ...extra];
const tzStart = (day: string): string[] => [`DTSTART;TZID=America/New_York:${day}T090000`, `DTEND;TZID=America/New_York:${day}T100000`];

function account(events: [string, string][], behaviour: Partial<FakeBehaviour> = {}, extraCalendars: FakeCalendarSeed[] = []): FakeICloud {
    return new FakeICloud({
        ...creds, dsid: PLAIN.dsid, behaviour,
        calendars: [{ id: 'home', displayName: 'Home', events: events.map(([name, ical]) => ({ name, ical })) }, ...extraCalendars],
    });
}

function rangeDays(body: string): number {
    const match = /start="(\d{8}T\d{6}Z)" end="(\d{8}T\d{6}Z)"/.exec(body);
    if (match?.[1] === undefined || match[2] === undefined) {
        return 0;
    }
    const parse = (v: string): number => Date.UTC(Number(v.slice(0, 4)), Number(v.slice(4, 6)) - 1, Number(v.slice(6, 8)), Number(v.slice(9, 11)));
    return Math.round((parse(match[2]) - parse(match[1])) / 86_400_000);
}

function reports(fake: FakeICloud, filter: (body: string) => boolean): number {
    return fake.requests.filter((r) => r.method === 'REPORT' && filter(r.body)).length;
}

const FORM_EVENTS: [string, string][] = [
    ['tz.ics', resource([weekly('tz', tzStart('20261113'))], NEW_YORK)],
    ['date.ics', resource([weekly('date', ['DTSTART;VALUE=DATE:20261114', 'DTEND;VALUE=DATE:20261115'])])],
    ['floating.ics', resource([weekly('floating', ['DTSTART:20261115T100000', 'DTEND:20261115T110000'])])],
    ['utc.ics', resource([weekly('utc', ['DTSTART:20261116T100000Z', 'DTEND:20261116T110000Z'])])],
    ['single.ics', resource([['UID:single', STAMP, ...tzStart('20261120'), 'SUMMARY:Secret single']], NEW_YORK)],
];

describe('etag-expand-vs-multiget', () => {
    for (const fault of ['equal', 'different', 'missing', 'duplicate', 'failed', 'malformed'] as const) {
        test(`ETag verdict for ${fault} multiget evidence`, async () => {
            const fake = account(FORM_EVENTS, { expand: true, transformResponse: async (req, res) => {
                if (!req.body.includes('calendar-multiget')) { return res; }
                const text = await res.text();
                const changed = fault === 'different' ? text.replace(/(<d:getetag>)[^<]+/, '$1&quot;different&quot;')
                    : fault === 'missing' ? text.replace(/<d:response>[\s\S]*?<\/d:response>/, '')
                        : fault === 'duplicate' ? text.replace(/(<d:response>[\s\S]*?<\/d:response>)/, '$1$1')
                            : fault === 'failed' ? text.replace('HTTP/1.1 200 OK', 'HTTP/1.1 403 Forbidden')
                                : fault === 'malformed' ? 'not XML' : text;
                return new Response(changed, { status: res.status, headers: res.headers });
            } });
            const result = check(await probe(fake, READ_ONLY, creds), 'etag-expand-vs-multiget');
            expect(result.outcome).toBe(fault === 'equal' ? 'confirmed' : fault === 'different' ? 'refuted' : 'inconclusive');
            expect(Object.keys(result.evidence).toSorted()).toEqual(['compared', 'different', 'equal', 'missing']);
            expect(Object.values(result.evidence).every((value) => typeof value === 'number')).toBe(true);
            if (fault === 'equal') { expect(result.evidence).toEqual({ compared: 5, equal: 5, different: 0, missing: 0 }); }
            if (fault === 'different') { expect(result.evidence).toEqual({ compared: 5, equal: 4, different: 1, missing: 0 }); }
        });
    }
    test('compares at most 20 hrefs with one multiget and reuses the expanded window', async () => {
        const events: [string, string][] = Array.from({ length: 25 }, (_, i) => [`e${i}.ics`, resource([weekly(`u${i}`, ['DTSTART:20261116T100000Z', 'DTEND:20261116T110000Z'])])]);
        const fake = account(events, { expand: true });
        const result = check(await probe(fake, READ_ONLY, creds), 'etag-expand-vs-multiget');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toEqual({ compared: 20, equal: 20, different: 0, missing: 0 });
        const comparison = fake.requests.filter((req) => req.body.includes('calendar-multiget') && !req.body.includes('calendar-data'));
        expect(comparison).toHaveLength(1);
        expect(comparison[0]?.body.match(/<D:href>/g)).toHaveLength(20);
        expect(reports(fake, (body) => body.includes('<C:expand') && rangeDays(body) === 120)).toBe(1);
    });
    test('no events is inconclusive and adds no multiget', async () => {
        const fake = account([], { expand: true });
        const result = check(await probe(fake, READ_ONLY, creds), 'etag-expand-vs-multiget');
        expect(result.outcome).toBe('inconclusive');
        expect(result.evidence).toEqual({ compared: 0, equal: 0, different: 0, missing: 0 });
        expect(reports(fake, (body) => body.includes('calendar-multiget'))).toBe(0);
    });
});

describe('expand-forms: what expansion does to DTSTART, DTEND and RECURRENCE-ID forms', () => {
    test('an unreadable 207 original window is not skipped as an empty calendar', async () => {
        const fake = account(FORM_EVENTS, { expand: true, expandStyle: 'keep-forms', hook: (req) => req.method === 'REPORT' && req.body.includes('calendar-query') && !req.body.includes('<C:expand') && req.url.pathname.endsWith('/broken/')
            ? new Response('not XML', { status: 207 }) : undefined }, [{ id: 'broken', displayName: 'Broken', events: [] }]);
        expect(check(await probe(fake, READ_ONLY, creds), 'expand-forms').outcome).toBe('inconclusive');
    });
    test('a server that turns everything into UTC changes every non-UTC form', async () => {
        const fake = account(FORM_EVENTS, { expand: true });
        const report = await probe(fake, READ_ONLY, creds);
        const result = check(report, 'expand-forms');
        expect(result.outcome).toBe('refuted');
        const all = (kind: string): Record<string, number> => ({ [`tzid>${kind}`]: 3, [`date>${kind}`]: 3, [`floating>${kind}`]: 3, [`utc>${kind}`]: 3 });
        expect(result.evidence).toMatchObject({
            expandedResources: 5, matchedToOriginal: 5, expandedInstances: 13,
            recurringDtstart: all('utc'), recurringDtend: all('utc'), recurringRecurrenceId: all('utc'),
            nonrecurringDtstart: { 'tzid>utc': 1 }, nonrecurringDtend: { 'tzid>utc': 1 }, nonrecurringRecurrenceId: { 'tzid>none': 1 },
            vtimezoneComponentsOriginal: 2, vtimezoneComponentsExpanded: 0, expandedTzidWithoutVtimezone: 0,
        });
    });

    test('a server that keeps the forms and the VTIMEZONE is confirmed', async () => {
        const report = await probe(account(FORM_EVENTS, { expand: true, expandStyle: 'keep-forms' }), READ_ONLY, creds);
        const result = check(report, 'expand-forms');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({
            recurringDtstart: { 'tzid>tzid': 3, 'date>date': 3, 'floating>floating': 3, 'utc>utc': 3 },
            recurringRecurrenceId: { 'tzid>tzid': 3, 'date>date': 3, 'floating>floating': 3, 'utc>utc': 3 },
            nonrecurringDtstart: { 'tzid>tzid': 1 }, nonrecurringRecurrenceId: { 'tzid>none': 1 },
            vtimezoneComponentsExpanded: 2, expandedTzidWithoutVtimezone: 0,
        });
    });

    test('expanded TZID values with no VTIMEZONE in the same resource are counted', async () => {
        const report = await probe(account(FORM_EVENTS, { expand: true, expandStyle: 'keep-forms-no-vtimezone' }), READ_ONLY, creds);
        const result = check(report, 'expand-forms');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence).toMatchObject({ vtimezoneComponentsExpanded: 0, expandedTzidWithoutVtimezone: 11, resourcesWithTzidWithoutVtimezone: 2 });
    });

    test('DATE values turned into UTC by an otherwise form-keeping server show up in the DTSTART table', async () => {
        const report = await probe(account(FORM_EVENTS, { expand: true, expandStyle: 'date-as-utc' }), READ_ONLY, creds);
        expect(check(report, 'expand-forms').evidence).toMatchObject({ recurringDtstart: { 'tzid>tzid': 3, 'date>utc': 3, 'floating>floating': 3, 'utc>utc': 3 } });
        expect(check(report, 'expand-forms').outcome).toBe('refuted');
    });

    test('DURATION is counted separately from DTEND, and survives only when the server keeps it', async () => {
        const events: [string, string][] = [['dur.ics', resource([weekly('dur', ['DTSTART:20261116T100000Z', 'DURATION:PT1H'])])]];
        const dropped = check(await probe(account(events, { expand: true }), READ_ONLY, creds), 'expand-forms').evidence;
        expect(dropped).toMatchObject({ instancesWithDuration: 0, instancesWithDtend: 3, instancesWithNeither: 0, originalMastersWithDuration: 1 });
        const kept = check(await probe(account(events, { expand: true, expandKeepsDuration: true }), READ_ONLY, creds), 'expand-forms').evidence;
        expect(kept).toMatchObject({ instancesWithDuration: 3, instancesWithDtend: 0, instancesWithNeither: 0 });
    });

    test('every calendar with events is expanded once; the expand-read query is reused, not repeated', async () => {
        const other: FakeCalendarSeed = { id: 'other', displayName: 'Other', events: [{ name: 'o.ics', ical: resource([weekly('o', ['DTSTART:20261117T100000Z', 'DTEND:20261117T110000Z'])]) }] };
        const empty: FakeCalendarSeed = { id: 'empty', displayName: 'Empty' };
        const fake = account(FORM_EVENTS, { expand: true }, [other, empty]);
        await probe(fake, READ_ONLY, creds);
        const wide = fake.requests.filter((r) => r.method === 'REPORT' && r.body.includes('<C:expand') && rangeDays(r.body) === 120);
        expect(wide.map((r) => r.url.pathname.split('/').at(-2)).toSorted()).toEqual(['home', 'other']);
    });

    test('a plain event that keeps its form confirms, no events at all is inconclusive, and a server that never expands refutes the claim', async () => {
        const none = await probe(account([['one.ics', resource([['UID:one', STAMP, 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', 'SUMMARY:x']])]], { expand: true }), READ_ONLY, creds);
        expect(check(none, 'expand-forms').outcome).toBe('confirmed');
        const noEvents = await probe(account([], { expand: true }), READ_ONLY, creds);
        expect(check(noEvents, 'expand-forms').outcome).toBe('inconclusive');
        const unexpanded = await probe(account(FORM_EVENTS, { expand: false }), READ_ONLY, creds);
        expect(check(unexpanded, 'expand-forms').outcome).toBe('refuted');
    });

    test('a throttled expand query stops this check with partial data and the run continues', async () => {
        const other: FakeCalendarSeed = { id: 'other', displayName: 'Other', events: [{ name: 'o.ics', ical: resource([weekly('o', ['DTSTART:20261117T100000Z', 'DTEND:20261117T110000Z'])]) }] };
        let expands = 0;
        const fake = account(FORM_EVENTS, {
            expand: true,
            hook: (req) => (req.method === 'REPORT' && req.body.includes('<C:expand') && ++expands === 2 ? new Response('busy', { status: 503, headers: { 'retry-after': '2' } }) : undefined),
        }, [other]);
        const report = await probe(fake, READ_ONLY, creds);
        const result = check(report, 'expand-forms');
        expect(result.outcome).toBe('inconclusive');
        expect(result.evidence).toMatchObject({ stoppedEarly: true, stopStatus: 503, retryAfterSeconds: 2 });
        expect(Number(result.evidence.expandedInstances)).toBeGreaterThan(0);
        expect(check(report, 'request-pacing').outcome).toBe('refuted');
        expect(check(report, 'strictness-census').outcome).not.toBe('skipped');
    });
});

describe('calendar-data-vs-get: a calendar-query against a GET of the same resource', () => {
    const series = (uid: string, overrides: number, extra: string[] = []): [string, string] => [
        `${uid}.ics`,
        resource([
            weekly(uid, ['DTSTART:20261116T100000Z', 'DTEND:20261116T110000Z'], extra),
            ...(['20261123', '20261130'] as const).slice(0, overrides).map((day): string[] => [`UID:${uid}`, STAMP, `RECURRENCE-ID:${day}T100000Z`, `DTSTART:${day}T120000Z`, `DTEND:${day}T130000Z`, 'SUMMARY:Moved']),
        ]),
    ];
    const gets = (fake: FakeICloud): number => fake.requests.filter((r) => r.method === 'GET' && r.url.pathname.includes('series')).length;

    test('identical data and ETags confirm the claim, and overrides are counted in both forms', async () => {
        const fake = account([series('series1', 1)]);
        const result = check(await probe(fake, READ_ONLY, creds), 'calendar-data-vs-get');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({
            resourcesCompared: 1, byteIdentical: 1, identicalIgnoringLineEndings: 1, etagsEqual: 1,
            overridesInQuery: 1, overridesInGet: 1, overrideCountsEqual: 1, resourcesWithOverrides: 1,
        });
    });

    test('LF-only line endings in the query are noticed and told apart from a real difference', async () => {
        const result = check(await probe(account([series('series1', 1)], { queryCalendarData: 'lf-line-endings' }), READ_ONLY, creds), 'calendar-data-vs-get');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence).toMatchObject({ byteIdentical: 0, identicalIgnoringLineEndings: 1 });
        const dropped = check(await probe(account([series('series1', 1, ['X-APPLE-THING:1'])], { queryCalendarData: 'dropped-x-properties' }), READ_ONLY, creds), 'calendar-data-vs-get');
        expect(dropped.evidence).toMatchObject({ byteIdentical: 0, identicalIgnoringLineEndings: 0, overrideCountsEqual: 1 });
    });

    test('a different ETag in the REPORT is counted', async () => {
        const result = check(await probe(account([series('series1', 0)], { reportEtagSuffix: 'q' }), READ_ONLY, creds), 'calendar-data-vs-get');
        expect(result.evidence).toMatchObject({ etagsEqual: 0, byteIdentical: 1 });
        expect(result.outcome).toBe('refuted');
    });

    test('at most 5 recurring resources are fetched, those with overrides first', async () => {
        const events = Array.from({ length: 7 }, (_, i) => series(`series${i}`, i === 6 ? 1 : 0));
        const fake = account(events);
        const result = check(await probe(fake, READ_ONLY, creds), 'calendar-data-vs-get');
        expect(result.evidence).toMatchObject({ resourcesCompared: 5, resourcesWithOverrides: 1 });
        // Five GETs for this check, plus the one the existing etag-shape check sends.
        expect(gets(fake)).toBe(5 + 1);
        expect(fake.requests.some((r) => r.method === 'GET' && r.url.pathname.endsWith('series6.ics'))).toBe(true);
    });

    test('no recurring resource is inconclusive and sends no GET', async () => {
        const fake = account([['one.ics', resource([['UID:one', STAMP, 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z']])]]);
        const result = check(await probe(fake, READ_ONLY, creds), 'calendar-data-vs-get');
        expect(result.outcome).toBe('inconclusive');
        expect(result.evidence).toMatchObject({ resourcesCompared: 0 });
        expect(fake.requests.filter((r) => r.method === 'GET').length).toBe(1);
    });
});

describe('limit-recurrence-set', () => {
    const withOverrides = (): [string, string] => ['s.ics', resource([
        weekly('s', ['DTSTART:20261112T100000Z', 'DTEND:20261112T110000Z']),
        ['UID:s', STAMP, 'RECURRENCE-ID:20261119T100000Z', 'DTSTART:20261119T120000Z', 'DTEND:20261119T130000Z'],
        ['UID:s', STAMP, 'RECURRENCE-ID:20261126T100000Z', 'DTSTART:20270301T120000Z', 'DTEND:20270301T130000Z'],
    ])];

    test('a server that applies the limit returns fewer overrides than the plain form', async () => {
        const fake = account([withOverrides()]);
        const result = check(await probe(fake, READ_ONLY, creds), 'limit-recurrence-set');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ status: 207, plainResources: 1, limitedResources: 1, plainOverrides: 2, limitedOverrides: 1, limitedMastersWithRrule: 1 });
        expect(reports(fake, (b) => b.includes('limit-recurrence-set'))).toBe(1);
    });

    test('a server that ignores the element, or refuses it, is told apart', async () => {
        const ignored = check(await probe(account([withOverrides()], { limitRecurrenceSet: 'ignored' }), READ_ONLY, creds), 'limit-recurrence-set');
        expect(ignored.outcome).toBe('inconclusive');
        expect(ignored.evidence).toMatchObject({ status: 207, plainOverrides: 2, limitedOverrides: 2 });
        const refused = check(await probe(account([withOverrides()], { limitRecurrenceSet: 'refused' }), READ_ONLY, creds), 'limit-recurrence-set');
        expect(refused.outcome).toBe('refuted');
        expect(refused.evidence).toMatchObject({ status: 400 });
    });

    test('with no recurring resource nothing is asked', async () => {
        const fake = account([['one.ics', resource([['UID:one', STAMP, 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z']])]]);
        const result = check(await probe(fake, READ_ONLY, creds), 'limit-recurrence-set');
        expect(result.outcome).toBe('inconclusive');
        expect(reports(fake, (b) => b.includes('limit-recurrence-set'))).toBe(0);
    });
});

describe('payload-sizes', () => {
    const big = `DESCRIPTION:${'x'.repeat(300_000)}`;
    const events = (): [string, string][] => [
        ['big.ics', resource([['UID:big', STAMP, 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', big]])],
        ['s.ics', resource([
            weekly('s', ['DTSTART:20261113T100000Z', 'DTEND:20261113T110000Z']),
            ['UID:s', STAMP, 'RECURRENCE-ID:20261120T100000Z', 'DTSTART:20261120T120000Z', 'DTEND:20261120T130000Z'],
            ['UID:s', STAMP, 'RECURRENCE-ID:20261127T100000Z', 'DTSTART:20261127T120000Z', 'DTEND:20261127T130000Z'],
        ])],
    ];

    test('records sizes per calendar index, with the largest resource and the 256 KiB count', async () => {
        const fake = account(events(), { expand: true }, [{ id: 'empty', displayName: 'Empty' }]);
        const report = await probe(fake, READ_ONLY, creds);
        const result = check(report, 'payload-sizes');
        expect(result.outcome).toBe('refuted');
        const e = result.evidence;
        expect(e).toMatchObject({ calendarsMeasured: 1, largestVeventsInResource: 3, resourcesOver256KiB: 1 });
        expect(Number(e.largestCalendarDataBytes)).toBeGreaterThan(300_000);
        const calendar = e.calendar0 as Record<string, number | null>;
        expect(calendar).toMatchObject({ windowResources: 2, resourcesOver256KiB: 1, largestVeventCount: 3 });
        expect(Number(calendar?.unexpanded31dBytes)).toBeGreaterThan(300_000);
        expect(Number(calendar?.expanded31dBytes)).toBeGreaterThan(300_000);
        expect(Number(calendar?.unexpandedWideBytes)).toBeGreaterThan(300_000);
        expect(Number(calendar?.expandedWideBytes)).toBeGreaterThan(300_000);
        expect(e.calendar1).toMatchObject({ windowResources: 0 });
        expect(JSON.stringify(report)).not.toContain('Home');
        expect(reports(fake, (b) => rangeDays(b) === 31)).toBe(2);
    });

    test('small resources confirm the claim', async () => {
        const report = await probe(account([events()[1] as [string, string]], { expand: true }), READ_ONLY, creds);
        expect(check(report, 'payload-sizes').outcome).toBe('confirmed');
        expect(check(report, 'payload-sizes').evidence).toMatchObject({ resourcesOver256KiB: 0 });
    });

    test('a failing 31-day query is recorded for that calendar and the run goes on', async () => {
        const fake = account(events(), { expand: true, hook: (req) => (req.method === 'REPORT' && rangeDays(req.body) === 31 && req.body.includes('<C:expand') ? new Response('boom', { status: 500 }) : undefined) });
        const result = check(await probe(fake, READ_ONLY, creds), 'payload-sizes');
        expect((result.evidence.calendar0 as Record<string, number | null>).expanded31dStatus).toBe(500);
        expect(result.outcome).toBe('refuted');
    });
});

describe('strictness-census', () => {
    const base = (n: number): string[] => [`UID:ok${n}`, STAMP, `DTSTART:2026112${n}T100000Z`, `DTEND:2026112${n}T110000Z`, 'SUMMARY:Fine'];

    test('clean data confirms the claim', async () => {
        const fake = account([['a.ics', resource([base(1)])], ['b.ics', resource([base(2)])]]);
        const result = check(await probe(fake, READ_ONLY, creds), 'strictness-census');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ resources: 2, vevents: 2, dateEventsEndNotAfterStart: 0, resourcesWithMultipleUids: 0 });
    });

    test('each anomaly is counted, and TZIDs only by class', async () => {
        const vtz = (id: string, rule: string): string[] => ['BEGIN:VTIMEZONE', `TZID:${id}`, 'BEGIN:STANDARD', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0000', 'DTSTART:19700101T000000', rule, 'END:STANDARD', 'END:VTIMEZONE'];
        const events: [string, string][] = [
            ['date-zero.ics', resource([['UID:d1', STAMP, 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261120']])],
            ['date-backwards.ics', resource([['UID:d2', STAMP, 'DTSTART;VALUE=DATE:20261121', 'DTEND;VALUE=DATE:20261120']])],
            ['timed-backwards.ics', resource([['UID:t1', STAMP, 'DTSTART:20261122T100000Z', 'DTEND:20261122T090000Z']])],
            ['mismatch.ics', resource([['UID:m1', STAMP, 'DTSTART:20261123T100000Z', 'DTEND;VALUE=DATE:20261124']])],
            ['tzid-on-date.ics', resource([['UID:x1', STAMP, 'DTSTART;VALUE=DATE;TZID=America/New_York:20261125', 'DTEND;VALUE=DATE:20261126']])],
            ['windows.ics', resource([['UID:w1', STAMP, 'DTSTART;TZID=Eastern Standard Time:20261126T100000', 'DTEND;TZID=Eastern Standard Time:20261126T110000']])],
            ['mozilla.ics', resource([['UID:z1', STAMP, 'DTSTART;TZID=/mozilla.org/20050126_1/America/New_York:20261127T100000', 'DTEND;TZID=/mozilla.org/20050126_1/America/New_York:20261127T110000']])],
            ['nowhere.ics', resource([['UID:n1', STAMP, 'DTSTART;TZID=Nowhere/Land:20261128T100000', 'DTEND;TZID=Nowhere/Land:20261128T110000']])],
            ['valid.ics', resource([['UID:v1', STAMP, 'DTSTART;TZID=America/New_York:20261129T100000', 'DTEND;TZID=America/New_York:20261129T110000']])],
            ['embedded.ics', resource([['UID:e1', STAMP, 'DTSTART;TZID=Custom/Defined:20261130T100000', 'DTEND;TZID=Custom/Defined:20261130T110000']], vtz('Custom/Defined', 'RRULE:FREQ=YEARLY;BYMONTH=1;BYDAY=1SU'))],
            ['monthly-zone.ics', resource([['UID:o1', STAMP, 'DTSTART:20261201T100000Z', 'DTEND:20261201T110000Z']], vtz('Custom/Monthly', 'RRULE:FREQ=MONTHLY;BYDAY=1SU'))],
            ['range.ics', resource([
                ['UID:r1', STAMP, 'DTSTART:20261202T100000Z', 'DTEND:20261202T110000Z', 'RRULE:FREQ=DAILY;COUNT=3'],
                ['UID:r1', STAMP, 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261203T100000Z', 'DTSTART:20261203T120000Z', 'DTEND:20261203T130000Z'],
            ])],
            ['no-end.ics', resource([['UID:ne1', STAMP, 'DTSTART:20261203T100000Z']])],
            ['dup.ics', resource([['UID:du1', STAMP, 'DTSTART:20261204T100000Z', 'DTSTART:20261204T110000Z', 'DTEND:20261204T120000Z']])],
            ['two-uids.ics', resource([['UID:a1', STAMP, 'DTSTART:20261205T100000Z', 'DTEND:20261205T110000Z'], ['UID:a2', STAMP, 'DTSTART:20261205T100000Z', 'DTEND:20261205T110000Z']])],
            ['no-master.ics', resource([['UID:nm1', STAMP, 'RECURRENCE-ID:20261206T100000Z', 'DTSTART:20261206T120000Z', 'DTEND:20261206T130000Z']])],
        ];
        const report = await probe(account(events), READ_ONLY, creds);
        const result = check(report, 'strictness-census');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence).toMatchObject({
            resources: 16, dateEventsEndNotAfterStart: 2, timedEventsEndBeforeStart: 1, startEndKindMismatch: 1, tzidOnDateValue: 1,
            unresolvedTzidWindowsLike: 2, unresolvedTzidMozillaPrefix: 2, unresolvedTzidOther: 2,
            vtimezoneObservancesOtherRecurrence: 1, recurrenceIdWithRange: 1, veventsWithoutEndOrDuration: 1,
            resourcesWithDuplicateSingletons: 1, resourcesWithMultipleUids: 1, resourcesWithOverridesNoMaster: 1,
            calendarsOverBodyCap: 0, temporalAvailable: true,
        });
        const text = JSON.stringify(report);
        for (const secret of ['Nowhere', 'mozilla', 'Eastern', 'Custom', 'Hidden', 'America/New_York']) {
            expect(text).not.toContain(secret);
        }
    });

    test('a calendar whose answer exceeds the body cap is counted and the next one is read', async () => {
        const other: FakeCalendarSeed = { id: 'other', displayName: 'Other', events: [{ name: 'o.ics', ical: resource([['UID:o', STAMP, 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261120']]) }] };
        const fake = account([['a.ics', resource([base(1)])]], {
            hook: (req) => (req.method === 'REPORT' && req.url.pathname.endsWith('/home/') && rangeDays(req.body) > 700 ? new Response('y'.repeat(70_000), { status: 207 }) : undefined),
        }, [other]);
        const result = check(await probe(fake, READ_ONLY, creds, { limits: { maxBodyBytes: 65_536 } }), 'strictness-census');
        expect(result.evidence).toMatchObject({ calendarsOverBodyCap: 1, resources: 1, dateEventsEndNotAfterStart: 1 });
        expect(result.outcome).toBe('refuted');
    });

    test('one wide query per calendar that can hold events, and nothing written', async () => {
        const fake = account([['a.ics', resource([base(1)])]], {}, [{ id: 'empty', displayName: 'Empty' }]);
        await probe(fake, READ_ONLY, creds);
        expect(reports(fake, (b) => rangeDays(b) > 700)).toBe(2);
        expect(fake.requests.some((r) => WRITE_METHODS.has(r.method))).toBe(false);
    });

    test('a runtime without Temporal is recorded, and TZIDs are then not counted as unresolved', async () => {
        const holder = globalThis as { Temporal?: unknown };
        const saved = holder.Temporal;
        holder.Temporal = undefined;
        try {
            const fake = account([['n.ics', resource([['UID:n1', STAMP, 'DTSTART;TZID=Nowhere/Land:20261128T100000', 'DTEND;TZID=Nowhere/Land:20261128T110000']])]]);
            const result = check(await probe(fake, READ_ONLY, creds), 'strictness-census');
            expect(result.evidence).toMatchObject({ temporalAvailable: false, unresolvedTzidOther: 0 });
            expect(result.outcome).toBe('inconclusive');
        } finally {
            holder.Temporal = saved;
        }
    });

    test('an account with no events is inconclusive', async () => {
        expect(check(await probe(account([]), READ_ONLY, creds), 'strictness-census').outcome).toBe('inconclusive');
    });
});

describe('multiget-bulk', () => {
    const many = (n: number, size = 0): [string, string][] => Array.from({ length: n }, (_, i) => [
        `e${i}.ics`, resource([[`UID:e${i}`, STAMP, `DTSTART:20261120T${String(i % 24).padStart(2, '0')}0000Z`, `DTEND:20261120T${String(i % 24).padStart(2, '0')}3000Z`, ...(size > 0 ? [`DESCRIPTION:${'z'.repeat(size)}`] : [])]]),
    ]);
    const multigets = (fake: FakeICloud): number => reports(fake, (b) => b.includes('calendar-multiget'));

    test('100 hrefs of a larger calendar are requested and all come back', async () => {
        const fake = account(many(130));
        const result = check(await probe(fake, READ_ONLY, creds), 'multiget-bulk');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ requested: 100, status: 207, returned: 100, returnedWithCalendarData: 100, perHrefNon200: 0, requestTrimmedBySize: false });
        const bulk = fake.requests.filter((r) => r.method === 'REPORT' && r.body.includes('calendar-multiget') && r.body.split('<D:href>').length > 50);
        expect(bulk.length).toBe(1);
    });

    test('a smaller calendar is requested in full', async () => {
        const result = check(await probe(account(many(12)), READ_ONLY, creds), 'multiget-bulk');
        expect(result.evidence).toMatchObject({ requested: 12, returned: 12 });
    });

    test('silent truncation and per-href 404s are both visible', async () => {
        const truncated = check(await probe(account(many(130), { multigetMaxHrefs: 50 }), READ_ONLY, creds), 'multiget-bulk');
        expect(truncated.outcome).toBe('inconclusive');
        expect(truncated.evidence).toMatchObject({ requested: 100, returned: 50 });
        const hidden = check(await probe(account(many(30), { multigetHidesEvery: 10 }), READ_ONLY, creds), 'multiget-bulk');
        expect(hidden.outcome).toBe('refuted');
        expect(hidden.evidence).toMatchObject({ requested: 30, returned: 30, perHrefNon200: 3, returnedWithCalendarData: 27 });
    });

    test('a request that would exceed half the body cap is trimmed by size', async () => {
        const fake = account(many(6, 100_000));
        const result = check(await probe(fake, READ_ONLY, creds, { limits: { maxBodyBytes: 1_000_000 } }), 'multiget-bulk');
        expect(result.evidence).toMatchObject({ requested: 4, requestTrimmedBySize: true, status: 207 });
        expect(multigets(fake)).toBeGreaterThanOrEqual(1);
    });

    test('a refused multiget is refuted with its status; no event is inconclusive', async () => {
        const refused = check(await probe(account(many(3), { hook: (req) => (req.method === 'REPORT' && req.body.includes('<D:href>') && req.body.split('<D:href>').length === 4 ? new Response('no', { status: 403 }) : undefined) }), READ_ONLY, creds), 'multiget-bulk');
        expect(refused.outcome).toBe('refuted');
        expect(refused.evidence).toMatchObject({ status: 403 });
        expect(check(await probe(account([]), READ_ONLY, creds), 'multiget-bulk').outcome).toBe('inconclusive');
    });
});

describe('adversarial read coverage', () => {
    const clean = resource([['UID:clean', STAMP, 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z']]);
    for (const fault of ['cap', 'http', 'malformed', 'missing', 'parse'] as const) {
        test(`strictness cannot confirm incomplete ${fault} coverage beside a clean calendar`, async () => {
            const fake = account([['a.ics', clean]], {
                transformResponse: async (req, res) => {
                    if (req.method !== 'REPORT' || rangeDays(req.body) < 700 || !req.url.pathname.endsWith('/home/')) { return res; }
                    if (fault === 'cap') { return new Response('x'.repeat(70_000), { status: 207 }); }
                    if (fault === 'http') { return new Response('failed', { status: 500 }); }
                    if (fault === 'malformed') { return new Response('not xml', { status: 207 }); }
                    const text = await res.text();
                    return new Response(text.replace(/<cal:calendar-data>[\s\S]*?<\/cal:calendar-data>/g, fault === 'missing' ? '' : '<cal:calendar-data>not an ical</cal:calendar-data>'), { status: 207 });
                },
            }, [{ id: 'other', displayName: 'Other', events: [{ name: 'o.ics', ical: clean }] }]);
            const result = check(await probe(fake, READ_ONLY, creds, { limits: { maxBodyBytes: 65_536 } }), 'strictness-census');
            expect(result.outcome).toBe('inconclusive');
            if (fault === 'missing') { expect(result.evidence.resourcesMissingCalendarData).toBe(1); }
            if (fault === 'parse') { expect(result.evidence.resourcesParseFailed).toBe(1); }
        });
    }
    test('lowercase yearly RRULE is valid while malformed declared time forms are counted', async () => {
        const zone = NEW_YORK.map((line) => line.startsWith('RRULE:') ? line.toLowerCase() : line);
        const good = check(await probe(account([['a.ics', resource([['UID:a', STAMP, ...tzStart('20261120')]], zone)]]), READ_ONLY, creds), 'strictness-census');
        expect(good.evidence.vtimezoneObservancesOtherRecurrence).toBe(0);
        expect(good.outcome).toBe('confirmed');
        const bad = resource([
            ['UID:a', STAMP, 'DTSTART;VALUE=DATE-TIME:20261120', 'DTEND:20261120T110000Z'],
            ['UID:b', STAMP, 'DTSTART:20261120', 'DTEND;VALUE=DATE:20261121'],
            ['UID:c', STAMP, 'DTSTART:nonsenseZ', 'DTEND:garbage'],
        ]);
        const result = check(await probe(account([['bad.ics', bad]], { timeRange: false }), READ_ONLY, creds), 'strictness-census');
        expect(result.evidence).toMatchObject({ invalidTimeValues: 4, declaredTimeFormMismatch: 2 });
        expect(result.outcome).toBe('refuted');
    });
    test('expansion joins each UID to its own master', async () => {
        const both = resource([
            weekly('utc', ['DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z']),
            weekly('date', ['DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261121']),
        ]);
        const result = check(await probe(account([['both.ics', both]], { expand: true, expandStyle: 'keep-forms' }), READ_ONLY, creds), 'expand-forms');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence.recurringDtstart).toEqual({ 'utc>utc': 3, 'date>date': 3 });
        expect(result.evidence.instancesCompared).toBe(6);
    });
    test('override-only and ambiguous-master expansion cannot confirm without comparisons', async () => {
        for (const events of [
            [['UID:o', STAMP, 'RECURRENCE-ID:20261120T100000Z', 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z']],
            Array.from({ length: 2 }, () => ['UID:o', STAMP, 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z']),
        ]) {
            const result = check(await probe(account([['o.ics', resource(events)]], { expand: true, expandStyle: 'keep-forms' }), READ_ONLY, creds), 'expand-forms');
            expect(result.outcome).toBe('inconclusive');
            expect(result.evidence.instancesCompared).toBe(0);
        }
    });
    const overridden = resource([
        weekly('s', ['DTSTART:20261112T100000Z', 'DTEND:20261112T110000Z']),
        ['UID:s', STAMP, 'RECURRENCE-ID:20261119T100000Z', 'DTSTART:20261119T120000Z', 'DTEND:20261119T130000Z'],
        ['UID:s', STAMP, 'RECURRENCE-ID:20261126T100000Z', 'DTSTART:20270301T120000Z', 'DTEND:20270301T130000Z'],
    ]);
    for (const fault of ['drop', 'missing', 'parse', 'master', 'unexpected-override'] as const) {
        test(`limited recurrence cannot confirm ${fault} data`, async () => {
            const fake = account([['s.ics', overridden]], { transformResponse: async (req, res) => {
                if (!req.body.includes('limit-recurrence-set')) { return res; }
                let text = await res.text();
                if (fault === 'drop') { text = text.replace(/<d:response>[\s\S]*?<\/d:response>/, ''); }
                if (fault === 'missing') { text = text.replace(/<cal:calendar-data>[\s\S]*?<\/cal:calendar-data>/, ''); }
                if (fault === 'parse') { text = text.replace(/<cal:calendar-data>[\s\S]*?<\/cal:calendar-data>/, '<cal:calendar-data>invalid</cal:calendar-data>'); }
                if (fault === 'master') { text = text.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/, ''); }
                if (fault === 'unexpected-override') { text = text.replace('RECURRENCE-ID:20261119', 'RECURRENCE-ID:20261118'); }
                return new Response(text, { status: 207 });
            } });
            expect(check(await probe(fake, READ_ONLY, creds), 'limit-recurrence-set').outcome).toBe('inconclusive');
        });
    }
    for (const fault of ['duplicate', 'unexpected'] as const) {
        test(`bulk multiget cannot confirm equal counts with ${fault} hrefs`, async () => {
            const fake = account([['a.ics', clean], ['b.ics', clean]], { transformResponse: async (req, res) => {
                if (!req.body.includes('calendar-multiget') || req.body.split('<D:href>').length !== 3) { return res; }
                const text = (await res.text()).replace('/home/b.ics', fault === 'duplicate' ? '/home/a.ics' : '/home/other.ics');
                return new Response(text, { status: 207 });
            } });
            expect(check(await probe(fake, READ_ONLY, creds), 'multiget-bulk').outcome).toBe('inconclusive');
        });
    }
});

describe('the read-only additions stay read-only and inside their budget', () => {
    test('no write method, and a bounded number of extra requests', async () => {
        const fake = account(FORM_EVENTS, { expand: true });
        const report = await probe(fake, READ_ONLY, creds);
        expect(fake.requests.some((r) => WRITE_METHODS.has(r.method))).toBe(false);
        expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['expand-forms', 'calendar-data-vs-get', 'limit-recurrence-set', 'payload-sizes', 'strictness-census', 'multiget-bulk']));
        expect(report.totals.requests).toBeLessThan(100);
        expect(report.redaction.scrubbedOccurrences).toBe(0);
    });
});
