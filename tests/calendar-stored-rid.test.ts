import { describe, expect, test } from 'bun:test';
import type { CalendarSummary } from '../src/caldav/contracts';
import { createReadBudget } from '../src/calendar/budget';
import { downloadInputSchema, fullEventSchema, getEventInputSchema, slimEventSchema } from '../src/calendar/event-schemas';
import { parseExpandedResource, parseOriginalResource } from '../src/calendar/ical';
import type { OccurrenceId } from '../src/calendar/model';
import { detailTarget, getEvent, listEvents, ReadError, searchEvents, type ReadDeps } from '../src/calendar/read';
import { parseOccurrenceId } from '../src/calendar/time-core';
import { FakeCalDavRead, FAKE_DISCOVERY, measuredExpandedText, measuredOriginalText, measuredSeriesServer, type MeasuredSeries } from './helpers/fake-caldav-read';

// Synthetic, from probe evidence: Run 7 (2026-11-12), check write-override-expanded-shape. In the expanded REPORT an instance
// with a stored override carries its RECURRENCE-ID in the stored form (TZID + local text, VALUE=DATE, or floating) and
// X-RECURRENCE-EXCEPTION; every other instance carries the `…Z` form. The TZID, DATE and floating tuples are the measured
// ones; the titles, UIDs and hrefs are invented. The unrecognised-zone and repeated-hour series are defensive variants in the
// same shape, not measured. The fake never touches a network.

const path = (name: string) => `/10000000001/calendars/${name}/`;
const calendar = (name: string): CalendarSummary => ({ id: path(name), displayName: name, components: ['VEVENT'], color: null });
const href = (name: string) => `${path('work')}${name}.ics`;

const NY = 'QW1lcmljYS9OZXdfWW9yaw'; // base64url('America/New_York')
const MARS = 'TWFycy9PbHltcHVz'; // base64url('Mars/Olympus')

/** Measured: the TZID series, instance 3 overridden at its slot, instance 4 moved two days. New York is UTC-4 in April and May. */
const tzidSeries: MeasuredSeries = {
    href: href('tzid'), etag: '"t1"', uid: 'synthetic-tzid', form: { kind: 'tzid', tzid: 'America/New_York' }, summary: 'Weekly sync', rrule: 'FREQ=WEEKLY;COUNT=6',
    instances: [
        { tuple: '20270406T100000/20270406T110000/20270406T140000Z', utc: ['20270406T140000Z', '20270406T150000Z', '20270406T140000Z'] },
        { tuple: '20270413T100000/20270413T110000/20270413T140000Z', utc: ['20270413T140000Z', '20270413T150000Z', '20270413T140000Z'] },
        { tuple: '20270420T100000/20270420T110000/20270420T100000', utc: ['20270420T140000Z', '20270420T150000Z', '20270420T140000Z'], overrideSummary: 'Instance 3 retitled' },
        { tuple: '20270429T100000/20270429T110000/20270427T100000', utc: ['20270429T140000Z', '20270429T150000Z', '20270427T140000Z'], overrideSummary: 'Instance 4 moved' },
        { tuple: '20270504T100000/20270504T110000/20270504T140000Z', utc: ['20270504T140000Z', '20270504T150000Z', '20270504T140000Z'] },
        { tuple: '20270511T100000/20270511T110000/20270511T140000Z', utc: ['20270511T140000Z', '20270511T150000Z', '20270511T140000Z'] },
    ],
};

/** Measured: the all-day series. iCloud reads all-day values as UTC, so the fake does too. */
const dateSeries: MeasuredSeries = {
    href: href('date'), etag: '"d1"', uid: 'synthetic-date', form: { kind: 'date' }, summary: 'All-day weekly', rrule: 'FREQ=WEEKLY;COUNT=6',
    instances: [
        { tuple: '20270408/20270409/20270408T000000Z', utc: ['20270408T000000Z', '20270409T000000Z', '20270408T000000Z'] },
        { tuple: '20270415/20270416/20270415T000000Z', utc: ['20270415T000000Z', '20270416T000000Z', '20270415T000000Z'] },
        { tuple: '20270422/20270423/20270422', utc: ['20270422T000000Z', '20270423T000000Z', '20270422T000000Z'], overrideSummary: 'All-day 3 retitled' },
        { tuple: '20270501/20270502/20270429', utc: ['20270501T000000Z', '20270502T000000Z', '20270429T000000Z'], overrideSummary: 'All-day 4 moved' },
        { tuple: '20270506/20270507/20270506T000000Z', utc: ['20270506T000000Z', '20270507T000000Z', '20270506T000000Z'] },
        { tuple: '20270513/20270514/20270513T000000Z', utc: ['20270513T000000Z', '20270514T000000Z', '20270513T000000Z'] },
    ],
};

/** Measured: the floating series. iCloud reads floating values as UTC, so the fake does too. */
const floatingSeries: MeasuredSeries = {
    href: href('floating'), etag: '"f1"', uid: 'synthetic-floating', form: { kind: 'floating' }, summary: 'Floating weekly', rrule: 'FREQ=WEEKLY;COUNT=6',
    instances: [
        { tuple: '20270409T090000/20270409T100000/20270409T090000Z', utc: ['20270409T090000Z', '20270409T100000Z', '20270409T090000Z'] },
        { tuple: '20270416T090000/20270416T100000/20270416T090000Z', utc: ['20270416T090000Z', '20270416T100000Z', '20270416T090000Z'] },
        { tuple: '20270423T090000/20270423T100000/20270423T090000', utc: ['20270423T090000Z', '20270423T100000Z', '20270423T090000Z'], overrideSummary: 'Floating 3 retitled' },
        { tuple: '20270502T090000/20270502T100000/20270430T090000', utc: ['20270502T090000Z', '20270502T100000Z', '20270430T090000Z'], overrideSummary: 'Floating 4 moved' },
        { tuple: '20270507T090000/20270507T100000/20270507T090000Z', utc: ['20270507T090000Z', '20270507T100000Z', '20270507T090000Z'] },
        { tuple: '20270514T090000/20270514T100000/20270514T090000Z', utc: ['20270514T090000Z', '20270514T100000Z', '20270514T090000Z'] },
    ],
};

/**
 * Defensive: a zone name no runtime recognises. How iCloud renders such a series' unmodified instances is not measured; they
 * are given the `…Z` form of their local digits here. The overridden ones are in the measured stored form.
 */
const marsSeries: MeasuredSeries = {
    href: href('mars'), etag: '"m1"', uid: 'synthetic-mars', form: { kind: 'tzid', tzid: 'Mars/Olympus' }, summary: 'Olympus standup', rrule: 'FREQ=WEEKLY;COUNT=3',
    instances: [
        { tuple: '20270405T080000/20270405T083000/20270405T080000Z', utc: ['20270405T080000Z', '20270405T083000Z', '20270405T080000Z'] },
        { tuple: '20270412T080000/20270412T083000/20270412T080000', utc: ['20270412T080000Z', '20270412T083000Z', '20270412T080000Z'], overrideSummary: 'Olympus retitled' },
        { tuple: '20270421T080000/20270421T083000/20270419T080000', utc: ['20270421T080000Z', '20270421T083000Z', '20270419T080000Z'], overrideSummary: 'Olympus moved' },
    ],
};

/**
 * Defensive: an override at 01:30 on 2027-11-07 in New York, an hour that happens twice. Its RECURRENCE-ID text names the slot
 * without saying which 01:30; the token carries the text, so nothing has to choose. The fake places it at the first one.
 */
const dstSeries: MeasuredSeries = {
    href: href('dst'), etag: '"s1"', uid: 'synthetic-dst', form: { kind: 'tzid', tzid: 'America/New_York' }, summary: 'Night shift', rrule: 'FREQ=WEEKLY;COUNT=3',
    instances: [
        { tuple: '20271031T013000/20271031T023000/20271031T053000Z', utc: ['20271031T053000Z', '20271031T063000Z', '20271031T053000Z'] },
        { tuple: '20271107T013000/20271107T023000/20271107T013000', utc: ['20271107T053000Z', '20271107T073000Z', '20271107T053000Z'], overrideSummary: 'Night shift, repeated hour' },
        { tuple: '20271114T013000/20271114T023000/20271114T063000Z', utc: ['20271114T063000Z', '20271114T073000Z', '20271114T063000Z'] },
    ],
};

const ALL = [tzidSeries, dateSeries, floatingSeries, marsSeries, dstSeries];
const range = { start: '2027-04-01T00:00:00Z', end: '2027-12-01T00:00:00Z' };

function setup(series: readonly MeasuredSeries[] = ALL): { backend: FakeCalDavRead; deps: ReadDeps } {
    const backend = new FakeCalDavRead().setCalendars([calendar('work')]).serve(path('work'), measuredSeriesServer(series));
    return { backend, deps: { backend, auth: { appleId: 'synthetic@example.test', appPassword: 'synthetic' }, discovery: FAKE_DISCOVERY, accountId: 'synthetic-account', budget: createReadBudget({ now: () => 0, yieldFn: async () => {} }) } };
}
async function codeOf(action: Promise<unknown>): Promise<string | null> {
    try { await action; } catch (error) { return error instanceof ReadError ? error.code : `other:${String(error)}`; }
    return null;
}
const get = (deps: ReadDeps, series: MeasuredSeries, token: string | null, extra: { expected_version?: string } = {}) =>
    getEvent(deps, { calendar_id: path('work'), resource_href: series.href, recurrence_id: token, ...extra });

describe('expanded RECURRENCE-ID in stored form (probe Run 7)', () => {
    test('the measured TZID series parses: 4 occ1_ tokens, 2 occ2_ tokens carrying the stored text and zone', () => {
        const resource = parseExpandedResource(measuredExpandedText(tzidSeries), {});
        expect(resource.components.map(component => component.recurrenceId?.token)).toEqual([
            'occ1_20270406T140000Z', 'occ1_20270413T140000Z', `occ2_20270420T100000_${NY}`, `occ2_20270427T100000_${NY}`, 'occ1_20270504T140000Z', 'occ1_20270511T140000Z',
        ]);
        expect(resource.components[2]?.recurrenceId?.time).toEqual({ kind: 'zoned', local: '2027-04-20T10:00:00', tzid: 'America/New_York' });
        expect(resource.components[2]?.properties.has('x-recurrence-exception')).toBe(true);
        expect(resource.components[0]?.properties.has('x-recurrence-exception')).toBe(false);
    });

    test('the measured DATE and floating series already map their stored forms to occ1_ tokens', () => {
        expect(parseExpandedResource(measuredExpandedText(dateSeries), {}).components.map(component => component.recurrenceId?.token)).toEqual([
            'occ1_20270408T000000Z', 'occ1_20270415T000000Z', 'occ1_20270422T000000Z', 'occ1_20270429T000000Z', 'occ1_20270506T000000Z', 'occ1_20270513T000000Z',
        ]);
        expect(parseExpandedResource(measuredExpandedText(floatingSeries), {}).components.map(component => component.recurrenceId?.token)).toEqual([
            'occ1_20270409T090000Z', 'occ1_20270416T090000Z', 'occ1_20270423T090000Z', 'occ1_20270430T090000Z', 'occ1_20270507T090000Z', 'occ1_20270514T090000Z',
        ]);
    });

    test('the stored originals parse, and each override has the same token as its expanded instance', () => {
        for (const series of ALL) {
            const original = parseOriginalResource(measuredOriginalText(series), {});
            expect(original.kind).toBe('series');
            const expanded: (string | null | undefined)[] = parseExpandedResource(measuredExpandedText(series), {}).components.map(component => component.recurrenceId?.token);
            expect(original.overrides).toHaveLength(series.instances.filter(instance => instance.overrideSummary !== undefined).length);
            for (const override of original.overrides) {
                expect(expanded).toContain(override.recurrenceId?.token ?? 'missing');
            }
        }
    });

    test('list_events returns every instance of every series exactly once, nothing unreadable, all passing the public schema', async () => {
        const { deps } = setup();
        const result = await listEvents(deps, { range });
        expect(result.calendars[0]?.status).toBe('ok');
        expect(result.unreadableCount).toBe(0);
        expect(result.unreadable).toEqual([]);
        for (const series of ALL) {
            const events = result.events.filter(event => event.resource_href === series.href);
            expect(events).toHaveLength(series.instances.length);
            expect(new Set(events.map(event => event.recurrence_id)).size).toBe(series.instances.length);
            expect(events.map(event => event.title).filter(title => title !== series.summary)).toEqual(series.instances.flatMap(instance => instance.overrideSummary ?? []));
        }
        for (const event of result.events) { expect(() => slimEventSchema.parse(event)).not.toThrow(); }
    });

    test('the TZID series in a list: ordinary starts, the moved override sorted by its new start, override titles', async () => {
        const { deps } = setup([tzidSeries]);
        const { events } = await listEvents(deps, { range });
        expect(events.map(event => [event.recurrence_id, 'local' in event.start ? event.start.local : null, event.title])).toEqual([
            ['occ1_20270406T140000Z', '2027-04-06T10:00:00', 'Weekly sync'],
            ['occ1_20270413T140000Z', '2027-04-13T10:00:00', 'Weekly sync'],
            [`occ2_20270420T100000_${NY}`, '2027-04-20T10:00:00', 'Instance 3 retitled'],
            [`occ2_20270427T100000_${NY}`, '2027-04-29T10:00:00', 'Instance 4 moved'],
            ['occ1_20270504T140000Z', '2027-05-04T10:00:00', 'Weekly sync'],
            ['occ1_20270511T140000Z', '2027-05-11T10:00:00', 'Weekly sync'],
        ]);
        expect(events[3]?.start).toEqual({ local: '2027-04-29T10:00:00', zone: 'America/New_York', utc: '2027-04-29T14:00:00Z', offset: '-04:00' });
        expect(events.every(event => event.recurring && event.expected_version === '"t1"')).toBe(true);
    });

    test('range filtering uses the instances\' own starts: a range holding only the moved override\'s new time returns it alone', async () => {
        const { deps } = setup([tzidSeries]);
        const { events } = await listEvents(deps, { range: { start: '2027-04-29T13:00:00Z', end: '2027-04-29T16:00:00Z' } });
        expect(events.map(event => event.recurrence_id)).toEqual([`occ2_20270427T100000_${NY}`]);
        const slot = await listEvents(setup([tzidSeries]).deps, { range: { start: '2027-04-27T13:00:00Z', end: '2027-04-27T16:00:00Z' } });
        expect(slot.events).toEqual([]);
    });

    test('search_events finds an overridden instance by its own title', async () => {
        const { deps } = setup();
        const result = await searchEvents(deps, { range, query: 'retitled' });
        expect(result.unreadableCount).toBe(0);
        expect(result.events.map(event => event.recurrence_id)).toEqual([
            `occ2_20270412T080000_${MARS}`, `occ2_20270420T100000_${NY}`, 'occ1_20270422T000000Z', 'occ1_20270423T090000Z',
        ]);
    });

    test('get_event round-trips every token list_events issued, overrides included, with the same content', async () => {
        const { deps } = setup();
        const listed = await listEvents(deps, { range });
        expect(listed.events).toHaveLength(ALL.reduce((sum, series) => sum + series.instances.length, 0));
        for (const event of listed.events) {
            const series = ALL.find(candidate => candidate.href === event.resource_href);
            if (series === undefined) { throw new Error('unknown href'); }
            const detail = await get(setup().deps, series, event.recurrence_id);
            expect(detail.event.view).toBe('occurrence');
            expect(detail.event.recurrence_id).toBe(event.recurrence_id);
            expect(detail.event.title).toBe(event.title);
            expect(detail.event.start).toEqual(event.start);
            expect(detail.event.end).toEqual(event.end);
            expect(detail.event.expected_version).toBe(series.etag);
            expect(() => fullEventSchema.parse(detail.event)).not.toThrow();
        }
    });

    test('get_event for a moved TZID override sends one bounded window covering its slot and its new time', async () => {
        const { backend, deps } = setup([tzidSeries]);
        const detail = await get(deps, tzidSeries, `occ2_20270427T100000_${NY}`);
        expect(detail.event.title).toBe('Instance 4 moved');
        expect(detail.event.start).toEqual({ local: '2027-04-29T10:00:00', zone: 'America/New_York', utc: '2027-04-29T14:00:00Z', offset: '-04:00' });
        // Slot digits 04-27 10:00 (+1 h span), the override's digits and instants on 04-29, padded 24 h. No zone conversion of the slot.
        expect(backend.calls.filter(call => call.method === 'queryEvents').map(call => call.range)).toEqual([{ startUtc: '20270426T100000Z', endUtc: '20270430T150000Z' }]);
    });

    test('an unrecognised zone and a repeated-hour local time round-trip by text, with the usual time warnings', async () => {
        const mars = await get(setup().deps, marsSeries, `occ2_20270412T080000_${MARS}`);
        expect(mars.event.title).toBe('Olympus retitled');
        expect(mars.event.start).toEqual({ local: '2027-04-12T08:00:00', zone: 'Mars/Olympus', timezone_warning: 'unrecognized_timezone' });
        const moved = await get(setup().deps, marsSeries, `occ2_20270419T080000_${MARS}`);
        expect(moved.event.title).toBe('Olympus moved');
        const dst = await get(setup().deps, dstSeries, `occ2_20271107T013000_${NY}`);
        expect(dst.event.title).toBe('Night shift, repeated hour');
        expect(dst.event.start).toMatchObject({ local: '2027-11-07T01:30:00', zone: 'America/New_York', timezone_warning: 'utc_uncertain_dst_transition' });
    });

    test('an occ1_ token for an instance without an override still resolves, in a series that has occ2_ overrides', async () => {
        const { backend, deps } = setup([tzidSeries]);
        const detail = await get(deps, tzidSeries, 'occ1_20270413T140000Z');
        expect(detail.event.title).toBe('Weekly sync');
        expect(detail.event.recurrence_id).toBe('occ1_20270413T140000Z');
        expect(backend.calls.filter(call => call.method === 'queryEvents').map(call => call.range)).toEqual([{ startUtc: '20270412T140000Z', endUtc: '20270414T150000Z' }]);
    });

    test('expected_version handling is unchanged for an occ2_ token', async () => {
        const token = `occ2_20270420T100000_${NY}`;
        expect((await get(setup().deps, tzidSeries, token, { expected_version: '"t1"' })).event.title).toBe('Instance 3 retitled');
        const { backend, deps } = setup();
        expect(await codeOf(get(deps, tzidSeries, token, { expected_version: '"older"' }))).toBe('calendar_changed');
        // The version check happens on the original read, before any occurrence query.
        expect(backend.count('queryEvents')).toBe(0);
    });

    test('an occ2_ token that names no stored override is not_found; one on a non-recurring event is not_found', async () => {
        expect(await codeOf(get(setup().deps, tzidSeries, `occ2_20270413T100000_${NY}`))).toBe('not_found');
        expect(await codeOf(get(setup().deps, tzidSeries, `occ2_20270420T100000_${MARS}`))).toBe('not_found');
        const single = new FakeCalDavRead().setCalendars([calendar('work')]);
        single.scriptMultiget(path('work'), [{ kind: 'found', resource: { href: href('single'), etag: '"x1"', calendarData: 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:u\nDTSTART;TZID=America/New_York:20270420T100000\nEND:VEVENT\nEND:VCALENDAR\n' } }]);
        const deps: ReadDeps = { ...setup().deps, backend: single };
        expect(await codeOf(getEvent(deps, { calendar_id: path('work'), resource_href: href('single'), recurrence_id: `occ2_20270420T100000_${NY}` }))).toBe('not_found');
        expect(single.count('queryEvents')).toBe(0);
    });

    test('a malformed or oversized token is invalid_input, in the schemas, get_event and the download tool, before any request', async () => {
        const long = Buffer.from('A'.repeat(129)).toString('base64url');
        const bad = [
            'occ2_20270420T100000_', // no zone
            'occ2_20270420T100000', // no separator
            `occ2_20270420T100000_${NY}=`, // padding
            `occ2_20270420T100000_${NY}+`, // not base64url
            'occ2_20270420T100000_QW1lcmljYS9OZXdfWW9ya', // a length no encoding has
            'occ2_20270420T100000_QW1lcmljYS9OZXdfWW9yax', // nonzero trailing bits: not the canonical encoding
            `occ2_20270420T100000_${long}`, // zone over 128 bytes
            `occ2_20270420T100000_${Buffer.from('A'.repeat(128)).toString('base64url')}x`, // over the length bound
            `occ2_20270230T100000_${NY}`, // not a date
            `occ2_20270420T240000_${NY}`, // not a time
            `occ2_20270420T100000Z_${NY}`, // a UTC value has no zone
            `occ2_2027-04-20T10:00:00_${NY}`,
            `occ2_20270420T100000_${Buffer.from([0xC3, 0x28]).toString('base64url')}`, // invalid UTF-8
            `occ2_20270420T100000_${Buffer.from('New\nYork').toString('base64url')}`, // a control character
            `occ3_20270420T100000_${NY}`,
            `OCC2_20270420T100000_${NY}`,
        ];
        for (const token of bad) {
            expect(getEventInputSchema.safeParse({ calendar_id: path('work'), resource_href: tzidSeries.href, recurrence_id: token }).success).toBe(false);
            expect(downloadInputSchema.safeParse({ calendar_id: path('work'), resource_href: tzidSeries.href, recurrence_id: token, attachment_ref: `a1_${'A'.repeat(43)}` }).success).toBe(false);
            expect(() => detailTarget(path('work'), tzidSeries.href, token)).toThrow(ReadError);
            const { backend, deps } = setup([tzidSeries]);
            expect(await codeOf(get(deps, tzidSeries, token))).toBe('invalid_input');
            expect(backend.count()).toBe(0);
        }
        // The largest zone the bound allows is accepted: 128 bytes, a 192-character token.
        const largest = `occ2_20270420T100000_${Buffer.from('A'.repeat(128)).toString('base64url')}`;
        expect(largest).toHaveLength(192);
        expect(getEventInputSchema.safeParse({ calendar_id: path('work'), resource_href: tzidSeries.href, recurrence_id: largest }).success).toBe(true);
        expect(downloadInputSchema.safeParse({ calendar_id: path('work'), resource_href: tzidSeries.href, recurrence_id: `occ2_20270420T100000_${NY}`, attachment_ref: `a1_${'A'.repeat(43)}` }).success).toBe(true);
    });

    test('parseOccurrenceId reads back exactly what the issuer encoded, non-ASCII and BOM text included', () => {
        const issued = (tzid: string): string | null | undefined => parseExpandedResource(
            `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u1\nDTSTART;TZID="${tzid}":20270420T100000\nRECURRENCE-ID;TZID="${tzid}":20270420T100000\nEND:VEVENT\nEND:VCALENDAR\n`, {},
        ).components[0]?.recurrenceId?.token;
        for (const tzid of ['America/New_York', 'Zürich Ortszeit', '(UTC-05:00) Eastern Time (US & Canada)', '/mozilla.org/20050126_1/America/New_York', '﻿BOM/Zone']) {
            const token = issued(tzid);
            if (token === null || token === undefined) { throw new Error('no token'); }
            expect(parseOccurrenceId(token)).toEqual({ kind: 'stored', id: token as OccurrenceId, local: '2027-04-20T10:00:00', tzid, ns: parseOccurrenceId('occ1_20270420T100000Z')?.ns ?? 0n });
        }
        expect(parseOccurrenceId('occ1_20270420T140000Z')).toMatchObject({ kind: 'server', id: 'occ1_20270420T140000Z', serverForm: '20270420T140000Z' });
    });

    test('an expanded TZID RECURRENCE-ID with another parameter, a second TZID, an over-long zone or a DATE value still degrades its resource alone', () => {
        const rid = (line: string): string => `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u1\nDTSTART;TZID=America/New_York:20270420T100000\n${line}\nEND:VEVENT\nEND:VCALENDAR\n`;
        const reason = (line: string): string | null => {
            try { parseExpandedResource(rid(line), {}); } catch (error) { return error instanceof Error ? error.message : 'other'; }
            return null;
        };
        expect(reason('RECURRENCE-ID;TZID=America/New_York:20270420T100000')).toBeNull();
        expect(reason('RECURRENCE-ID;TZID=America/New_York;X-FOO=1:20270420T100000')).toBe('unsupported_recurrence_id');
        expect(reason('RECURRENCE-ID;TZID=America/New_York;RANGE=THISANDFUTURE:20270420T100000')).toBe('unsupported_recurrence_id');
        expect(reason(`RECURRENCE-ID;TZID=${'A'.repeat(129)}:20270420T100000`)).toBe('unsupported_recurrence_id');
        expect(reason('RECURRENCE-ID;VALUE=DATE;TZID=America/New_York:20270420')).toBe('unsupported_recurrence_id');
    });
});
