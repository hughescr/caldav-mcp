import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { EventTime } from '../src/calendar/model';
import { BudgetError, IcalError, TIMEZONE_WARNINGS, isCanonicalPath, notImplemented } from '../src/calendar/model';
import * as limits from '../src/calendar/limits';
import {
    civilStartText, compareEventOrder, eventSpan, formatInstant, isValidDateText, isValidInstantText, isValidLocalText, nominalSpanSeconds,
    occurrenceIdFromJcal, occurrenceServerForm, occurrenceTransportWindow, padTransportWindow, parseDuration, parseOccurrenceId, parseRange,
    parseRangeBoundary, rangeTransportWindow, spanOverlapsRange, storedTimeFromJcal, toEventTime,
} from '../src/calendar/time-core';
import {
    INVALID_INPUT_MESSAGE, attachmentMetadataSchema, attachmentRefSchema, attendeeSchema, calendarStatusSchema, dateSchema, downloadInputSchema, downloadOutputSchema,
    etagSchema, eventTimeSchema, eventsOutputSchema, fullEventSchema, getEventInputSchema, getEventOutputSchema, instantSchema, listEventsInputSchema, localSchema,
    occurrenceIdSchema, pathSchema, rangeBoundarySchema, readToolErrorCodeSchema, searchEventsInputSchema, slimEventSchema, unreadableSchema,
    type EventTimeOutput, type EventsOutput, type FullEvent, type GetEventOutput, type SlimEvent,
} from '../src/calendar/event-schemas';
import { createDownloadBudget, createReadBudget } from '../src/calendar/budget';
import { FakeCalDavRead, fakeCalendarPath, FAKE_DISCOVERY } from './helpers/fake-caldav-read';
import type { CalendarResource } from '../src/caldav/read-contracts';

const AUTH = { appleId: 'a@example.test', appPassword: 'pw' };
const parse = (schema: z.ZodType, value: unknown) => schema.safeParse(value);
const ok = (schema: z.ZodType, value: unknown) => expect(parse(schema, value).success).toBe(true);
const bad = (schema: z.ZodType, value: unknown) => expect(parse(schema, value).success).toBe(false);
const issueMessages = (result: z.ZodSafeParseResult<unknown>): string[] => result.success ? [] : result.error.issues.map(issue => issue.message);
const issueText = (result: z.ZodSafeParseResult<unknown>): string => issueMessages(result).join('|');
const NS = 1_000_000_000n;

// Compile-time: every model time value is a valid schema output. (The reverse fails only on exactOptionalPropertyTypes noise.)
const modelToSchema = (value: EventTime): EventTimeOutput => value;
void modelToSchema;

describe('limits', () => {
    test('resource envelope lower bound is proven by the mandatory element markup', () => {
        expect(limits.MAX_RESOURCES_PER_REPORT).toBe(131_072);
        expect(limits.MAX_RESOURCES_PER_REPORT).toBe(Math.floor(limits.MAX_REPORT_BYTES / limits.RESOURCE_ENVELOPE_LOWER_BOUND));
        expect(limits.RESOURCE_ENVELOPE_MARKUP).toHaveLength(7);
        expect(limits.MIN_RESOURCE_ENVELOPE_BYTES).toBe(135);
        expect(limits.MIN_RESOURCE_ENVELOPE_BYTES).toBeGreaterThanOrEqual(limits.RESOURCE_ENVELOPE_LOWER_BOUND);
    });
    test('design constants', () => {
        expect([limits.DEFAULT_EVENTS, limits.MAX_EVENTS, limits.MAX_SELECTED_CALENDARS, limits.MAX_DISCOVERED_CALENDARS]).toEqual([25, 100, 20, 300]);
        expect(limits.MAX_WIRE_BYTES).toBe(98_304);
        expect(limits.MAX_RAW_BYTES).toBe(16_384);
        expect([limits.MAX_REPORT_BYTES, limits.MAX_AGGREGATE_BYTES, limits.MAX_RESOURCE_BYTES]).toEqual([8 * 1048576, 16 * 1048576, 2 * 1048576]);
        expect([limits.MAX_EXPANDED_VEVENTS_PER_CALENDAR, limits.MAX_EXPANDED_VEVENTS_PER_TOOL]).toEqual([5000, 10_000]);
        expect([limits.READ_CALL_MS, limits.DOWNLOAD_CALL_MS, limits.DAV_REQUEST_MS, limits.MIN_CALENDAR_START_MS, limits.CALENDAR_CONCURRENCY]).toEqual([45_000, 30_000, 10_000, 12_000, 3]);
    });
    test('transport pads: 31 days for list/search, 24 hours for occurrence windows and the DATE/floating filter, 430-day cap', () => {
        expect([limits.MOVED_PAD_DAYS, limits.TRANSPORT_PAD_HOURS, limits.MAX_TRANSPORT_DAYS]).toEqual([31, 24, 430]);
        // 366-day range + two 24 h axis offsets + two 31-day pads, rounded up to a whole day.
        expect(limits.MAX_TRANSPORT_DAYS).toBeGreaterThanOrEqual(limits.MAX_RANGE_DAYS + 2 + 2 * limits.MOVED_PAD_DAYS);
    });
    test('the too-large notice names every cap from trusted constants', () => {
        for (const text of ['8 MiB/report', '16 MiB/tool', '2 MiB/resource', '5,000 expanded events/calendar', '10,000/tool', '131,072 resources/report', '50,000 lines', '50,000 properties']) {
            expect(limits.RESULT_TOO_LARGE_NOTICE).toContain(text);
        }
    });
});

describe('literal validation: hour, minute and second bounds', () => {
    test('dates are valid Gregorian dates with overflow rejected', () => {
        for (const text of ['2026-02-28', '2028-02-29', '2000-02-29', '0001-01-01']) { expect(isValidDateText(text)).toBe(true); }
        for (const text of ['2026-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-01', '2026-01-001', '']) { expect(isValidDateText(text)).toBe(false); }
    });
    test('local and instant literals bound hours to 23 and minutes/seconds to 59', () => {
        expect(isValidLocalText('2026-03-08T23:59:59')).toBe(true);
        expect(isValidLocalText('2026-03-08T00:00:00')).toBe(true);
        for (const text of ['2026-03-08T24:00:00', '2026-03-08T23:60:00', '2026-03-08T23:59:60', '2026-03-08T23:59:59Z', '2026-02-30T00:00:00', '2026-03-08T2:00:00']) { expect(isValidLocalText(text)).toBe(false); }
        expect(isValidInstantText('2026-12-31T23:59:59Z')).toBe(true);
        for (const text of ['2026-12-31T23:59:60Z', '2026-12-31T24:00:00Z', '2026-12-31T23:59:59', '2026-12-31T23:59:59z']) { expect(isValidInstantText(text)).toBe(false); }
    });
    test('storedTimeFromJcal covers the four forms and rejects second 60 and hour 24', () => {
        expect(storedTimeFromJcal('date', '2026-03-08', undefined)).toEqual({ kind: 'date', date: '2026-03-08' });
        expect(storedTimeFromJcal('date', '2026-03-08', 'Europe/Paris')).toEqual({ kind: 'date', date: '2026-03-08', tzid: 'Europe/Paris' });
        expect(storedTimeFromJcal('date-time', '2026-03-08T10:00:00', undefined)).toEqual({ kind: 'floating', local: '2026-03-08T10:00:00' });
        expect(storedTimeFromJcal('date-time', '2026-03-08T10:00:00', 'Europe/Paris')).toEqual({ kind: 'zoned', local: '2026-03-08T10:00:00', tzid: 'Europe/Paris' });
        expect(storedTimeFromJcal('date-time', '2026-03-08T10:00:00Z', undefined)).toEqual({ kind: 'utc', utc: '2026-03-08T10:00:00Z' });
        expect(storedTimeFromJcal('date-time', '2026-03-08T10:00:60Z', undefined)).toBeNull();
        expect(storedTimeFromJcal('date-time', '2026-03-08T24:00:00', 'UTC')).toBeNull();
        expect(storedTimeFromJcal('date-time', '2026-03-08T10:00:00', '')).toBeNull();
        expect(storedTimeFromJcal('period', '2026-03-08T10:00:00Z', undefined)).toBeNull();
        expect(storedTimeFromJcal('date', '2026-02-30', undefined)).toBeNull();
    });
});

describe('range boundaries and the input range', () => {
    test('accepts Z and explicit offsets with optional fractions of 1-9 digits', () => {
        for (const text of ['2026-03-08T10:00:00Z', '2026-03-08T10:00:00+05:30', '2026-03-08T10:00:00-08:00', '2026-03-08T10:00:00.1Z', '2026-03-08T10:00:00.123456789-07:00', '2026-03-08T10:00:00+23:59', '2026-03-08T10:00:00+00:00']) {
            expect(parseRangeBoundary(text)).not.toBeNull();
        }
    });
    test('rejects a missing timezone, -00:00, annotations, leap seconds and out-of-range parts', () => {
        for (const text of [
            '2026-03-08T10:00:00', '2026-03-08', '2026-03-08T10:00:00-00:00', '2026-03-08T10:00:00Z[UTC]', '2026-03-08T10:00:00+01:00[Europe/Paris]',
            '2026-03-08T10:00:60Z', '2026-03-08T24:00:00Z', '2026-03-08T10:60:00Z', '2026-03-08T10:00:00+24:00', '2026-03-08T10:00:00+05:60',
            '2026-03-08T10:00:00.Z', '2026-03-08T10:00:00.1234567890Z', '2026-03-08t10:00:00z', '2026-03-08 10:00:00Z', '2026-02-30T10:00:00Z', '2026-03-08T10:00:00+0530', ' 2026-03-08T10:00:00Z',
        ]) { expect(parseRangeBoundary(text)).toBeNull(); }
    });
    test('the instant and civil axes differ by the offset', () => {
        const boundary = parseRangeBoundary('2026-03-08T00:00:00-08:00');
        expect(boundary?.civilNs).toBe(1_772_928_000n * NS);
        expect(boundary?.instantNs).toBe((1_772_928_000n + 8n * 3600n) * NS);
        expect(parseRangeBoundary('2026-03-08T00:00:00.5Z')?.civilNs).toBe(1_772_928_000n * NS + 500_000_000n);
    });
    test('parseRange: start before end, 1900-2100, at most 366 elapsed days', () => {
        expect(parseRange({ start: '2026-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' })).not.toBeNull();
        expect(parseRange({ start: '2026-01-01T00:00:00Z', end: '2027-01-02T00:00:01Z' })).toBeNull();
        expect(parseRange({ start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:00Z' })).toBeNull();
        expect(parseRange({ start: '2026-01-02T00:00:00Z', end: '2026-01-01T00:00:00Z' })).toBeNull();
        expect(parseRange({ start: '2026-01-01T00:00:00+01:00', end: '2026-01-01T00:00:00Z' })).not.toBeNull();
        expect(parseRange({ start: '1899-12-31T00:00:00Z', end: '1900-01-02T00:00:00Z' })).toBeNull();
        expect(parseRange({ start: '1900-01-01T00:00:00Z', end: '1900-01-02T00:00:00Z' })).not.toBeNull();
        expect(parseRange({ start: '2100-12-30T00:00:00Z', end: '2101-01-01T00:00:00Z' })).toBeNull();
        expect(parseRange({ start: '2100-12-30T00:00:00Z', end: '2100-12-31T00:00:00Z' })).not.toBeNull();
        expect(parseRange({ start: '2026-01-01T00:00:00', end: '2026-01-02T00:00:00Z' })).toBeNull();
    });
});

describe('transport window construction', () => {
    const DAY = 86_400n * NS;
    const MOVED_PAD_HOURS = limits.MOVED_PAD_DAYS * 24;
    test('pads 31 days either side of the union of the instant axis and the civil-digits axis (Run 5 moved-override pad)', () => {
        // start: I = 08:00Z, U = 00:00Z, so U is earlier; end: I = 08:00Z next day, U = 00:00Z, so I is later.
        expect(rangeTransportWindow({ start: '2026-03-08T00:00:00-08:00', end: '2026-03-09T00:00:00-08:00' })).toEqual({ startUtc: '20260205T000000Z', endUtc: '20260409T080000Z' });
        // Positive offsets flip which axis wins.
        expect(rangeTransportWindow({ start: '2026-03-08T00:00:00+05:30', end: '2026-03-09T00:00:00+05:30' })).toEqual({ startUtc: '20260204T183000Z', endUtc: '20260409T000000Z' });
        expect(rangeTransportWindow({ start: '2026-03-08T00:00:00Z', end: '2026-03-09T00:00:00Z' })).toEqual({ startUtc: '20260205T000000Z', endUtc: '20260409T000000Z' });
    });
    test('rounds outward to whole seconds', () => {
        expect(rangeTransportWindow({ start: '2026-03-08T00:00:00.9Z', end: '2026-03-09T00:00:00.1Z' })).toEqual({ startUtc: '20260205T000000Z', endUtc: '20260409T000001Z' });
        expect(rangeTransportWindow({ start: '2026-03-08T00:00:00.000000001Z', end: '2026-03-08T00:00:00.000000002Z' })).toEqual({ startUtc: '20260205T000000Z', endUtc: '20260408T000001Z' });
        expect(rangeTransportWindow({ start: '2027-01-11T00:00:00.1+05:30', end: '2027-01-12T00:00:00.1+05:30' })).toEqual({ startUtc: '20261210T183000Z', endUtc: '20270212T000001Z' });
    });
    test('the widest valid range stays within the 430-day transport bound and a wider interval fails', () => {
        // 366 days with the most extreme offsets: the two axes diverge by 23:59 at both ends.
        const widest = rangeTransportWindow({ start: '2026-01-01T00:00:00+23:59', end: '2027-01-02T00:00:00-23:59' });
        expect(widest).toEqual({ startUtc: '20251130T000100Z', endUtc: '20270202T235900Z' });
        // 368 days + two 31-day pads is exactly 430; one nanosecond more rounds outward to a 430-day-plus-one-second span.
        expect(padTransportWindow([{ startNs: 0n, endNs: 368n * DAY }], MOVED_PAD_HOURS).startUtc).toBe('19691201T000000Z');
        expect(() => padTransportWindow([{ startNs: 0n, endNs: 368n * DAY + 1n }], MOVED_PAD_HOURS)).toThrow(IcalError);
        expect(() => padTransportWindow([{ startNs: 0n, endNs: 369n * DAY }], MOVED_PAD_HOURS)).toThrow(IcalError);
        expect(() => padTransportWindow([{ startNs: 0n, endNs: 366n * DAY }, { startNs: 400n * DAY, endNs: 401n * DAY }], MOVED_PAD_HOURS)).toThrow(IcalError);
        try { padTransportWindow([{ startNs: 0n, endNs: 369n * DAY }], MOVED_PAD_HOURS); } catch (error) { expect((error as IcalError).reason).toBe('window_too_large'); }
        expect(() => padTransportWindow([], MOVED_PAD_HOURS)).toThrow(IcalError);
        expect(() => rangeTransportWindow({ start: 'garbage', end: '2026-01-01T00:00:00Z' })).toThrow(IcalError);
    });
    test('the pad is a parameter: 24 hours gives the narrow occurrence-window padding', () => {
        expect(padTransportWindow([{ startNs: 0n, endNs: 3600n * NS }], 24)).toEqual({ startUtc: '19691231T000000Z', endUtc: '19700102T010000Z' });
    });
    test('formatInstant floors fractions and refuses years outside 0001-9999', () => {
        expect(formatInstant(1_772_928_000n * NS + 999_999_999n)).toBe('2026-03-08T00:00:00Z');
        expect(formatInstant(-62_135_596_800n * NS)).toBe('0001-01-01T00:00:00Z');
        expect(formatInstant(-62_135_596_801n * NS)).toBeNull();
        expect(formatInstant(253_402_300_800n * NS)).toBeNull();
    });
});

describe('pass-through time and the four fixed timezone warnings', () => {
    test('the warning enum has exactly four fixed values', () => {
        expect([...TIMEZONE_WARNINGS]).toEqual(['no_timezone_on_event', 'unrecognized_timezone', 'timezone_dropped_from_date', 'utc_uncertain_dst_transition']);
    });
    test('DATE carries no timezone; a stray TZID is dropped and warned (OD7)', () => {
        expect(toEventTime({ kind: 'date', date: '2026-03-08' })).toEqual({ date: '2026-03-08', all_day: true });
        const dropped = toEventTime({ kind: 'date', date: '2026-03-08', tzid: 'America/New_York' });
        expect(dropped).toEqual({ date: '2026-03-08', all_day: true, timezone_warning: 'timezone_dropped_from_date' });
        expect(JSON.stringify(dropped)).not.toContain('America');
    });
    test('floating gets no_timezone_on_event and never UTC or offset', () => {
        expect(toEventTime({ kind: 'floating', local: '2026-03-08T10:00:00' })).toEqual({ local: '2026-03-08T10:00:00', floating: true, timezone_warning: 'no_timezone_on_event' });
    });
    test('explicit UTC is passed through with no warning', () => {
        expect(toEventTime({ kind: 'utc', utc: '2026-03-08T10:00:00Z' })).toEqual({ utc: '2026-03-08T10:00:00Z' });
    });
    test('a recognized IANA zone adds utc and offset and keeps the exact label', () => {
        expect(toEventTime({ kind: 'zoned', local: '2026-01-15T09:00:00', tzid: 'America/New_York' })).toEqual({ local: '2026-01-15T09:00:00', zone: 'America/New_York', utc: '2026-01-15T14:00:00Z', offset: '-05:00' });
        expect(toEventTime({ kind: 'zoned', local: '2026-07-15T09:00:00', tzid: 'Europe/Paris' })).toEqual({ local: '2026-07-15T09:00:00', zone: 'Europe/Paris', utc: '2026-07-15T07:00:00Z', offset: '+02:00' });
        expect(toEventTime({ kind: 'zoned', local: '2026-07-15T09:00:00', tzid: 'Asia/Kolkata' })).toMatchObject({ utc: '2026-07-15T03:30:00Z', offset: '+05:30' });
        // The label is not case-normalized or replaced by Temporal's canonical id.
        expect(toEventTime({ kind: 'zoned', local: '2026-01-15T09:00:00', tzid: 'america/new_york' })).toMatchObject({ zone: 'america/new_york', utc: '2026-01-15T14:00:00Z' });
    });
    test('unrecognized zones pass through with unrecognized_timezone and no extras', () => {
        for (const tzid of ['Foo/Bar', 'Pacific Standard Time', '/mozilla.org/20050126_1/Europe/Paris', '+05:00', '-0800', '2026-01-01T00:00+05:00', '2026-01-01T00:00:00Z[UTC]', 'UTC+1', 'a'.repeat(300), '']) {
            const result = toEventTime({ kind: 'zoned', local: '2026-03-08T10:00:00', tzid });
            expect(result).toEqual({ local: '2026-03-08T10:00:00', zone: tzid, timezone_warning: 'unrecognized_timezone' });
        }
    });
    test('Windows zone names are never mapped (OD10): passed through as unrecognized, with no utc or offset and no instants', () => {
        for (const tzid of ['Pacific Standard Time', 'Eastern Standard Time', 'W. Europe Standard Time']) {
            expect(toEventTime({ kind: 'zoned', local: '2026-01-15T09:00:00', tzid })).toEqual({ local: '2026-01-15T09:00:00', zone: tzid, timezone_warning: 'unrecognized_timezone' });
            const span = eventSpan({ kind: 'zoned', local: '2026-01-15T09:00:00', tzid }, null, 'PT1H');
            expect(span.instant).toBeNull();
        }
    });
    test('repeated hour: the original local text is kept, default disambiguation supplies utc/offset, and the value is warned (OD8)', () => {
        const fall = toEventTime({ kind: 'zoned', local: '2027-11-07T01:30:00', tzid: 'America/New_York' });
        expect(fall).toEqual({ local: '2027-11-07T01:30:00', zone: 'America/New_York', utc: '2027-11-07T05:30:00Z', offset: '-04:00', timezone_warning: 'utc_uncertain_dst_transition' });
    });
    test('skipped hour: the original local text is kept (not rewritten), utc/offset are emitted, and the value is warned (OD8)', () => {
        const spring = toEventTime({ kind: 'zoned', local: '2027-03-14T02:30:00', tzid: 'America/New_York' });
        expect(spring).toEqual({ local: '2027-03-14T02:30:00', zone: 'America/New_York', utc: '2027-03-14T07:30:00Z', offset: '-04:00', timezone_warning: 'utc_uncertain_dst_transition' });
    });
    test('outside a transition there is no warning (OD8)', () => {
        expect(toEventTime({ kind: 'zoned', local: '2027-11-07T03:30:00', tzid: 'America/New_York' })).toEqual({ local: '2027-11-07T03:30:00', zone: 'America/New_York', utc: '2027-11-07T08:30:00Z', offset: '-05:00' });
        expect(toEventTime({ kind: 'zoned', local: '2027-03-14T03:30:00', tzid: 'America/New_York' })).not.toHaveProperty('timezone_warning');
        expect(toEventTime({ kind: 'zoned', local: '2027-11-07T00:59:59', tzid: 'America/New_York' })).not.toHaveProperty('timezone_warning');
        expect(toEventTime({ kind: 'zoned', local: '2027-11-07T02:00:00', tzid: 'America/New_York' })).not.toHaveProperty('timezone_warning');
        expect(toEventTime({ kind: 'zoned', local: '2027-11-07T01:30:00', tzid: 'UTC' })).not.toHaveProperty('timezone_warning');
    });
    test('an explicit UTC second fold stays UTC', () => {
        expect(toEventTime({ kind: 'utc', utc: '2027-11-07T06:30:00Z' })).toEqual({ utc: '2027-11-07T06:30:00Z' });
    });
    test('no zone problem ever throws', () => {
        for (const tzid of ['America/New_York', 'Foo', 'UTC', 'Etc/GMT+12']) {
            expect(() => toEventTime({ kind: 'zoned', local: '0001-01-01T00:00:00', tzid })).not.toThrow();
            expect(() => toEventTime({ kind: 'zoned', local: '9999-12-31T23:59:59', tzid })).not.toThrow();
        }
    });
});

describe('effective end, duration and the range filter', () => {
    const utc = (text: string) => ({ kind: 'utc', utc: text }) as const;
    const range = (start: string, end: string) => { const parsed = parseRange({ start, end }); if (parsed === null) { throw new Error('bad range'); } return parsed; };
    test('durations: non-negative weeks or days/hours/minutes/seconds only', () => {
        expect(parseDuration('PT1H30M')).toEqual({ weeks: 0, days: 0, hours: 1, minutes: 30, seconds: 0 });
        expect(parseDuration('P2W')).toEqual({ weeks: 2, days: 0, hours: 0, minutes: 0, seconds: 0 });
        expect(parseDuration('P1DT2H3M4S')).toEqual({ weeks: 0, days: 1, hours: 2, minutes: 3, seconds: 4 });
        for (const text of ['P1Y', 'P1M', 'PT1.5H', '-PT1H', '+PT1H', '-PT0S', 'P1W2D', 'PT', 'P', '1H', 'P1DT', 'PT1H1D']) { expect(parseDuration(text)).toBeNull(); }
    });
    test('a zero duration is legal: a point for timed starts, one day for DATE starts', () => {
        const zero = { weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
        for (const text of ['PT0S', 'P0D', 'P0W', 'PT0H0M0S', 'P0DT0S']) { expect(parseDuration(text)).toEqual(zero); }
        const point = eventSpan(utc('2026-03-08T10:00:00Z'), null, 'PT0S');
        expect(point.instant).toEqual({ startNs: 1_772_964_000n * NS, endNs: 1_772_964_000n * NS });
        expect(point.civil.endNs).toBe(point.civil.startNs);
        expect(spanOverlapsRange(range('2026-03-08T10:00:00Z', '2026-03-08T11:00:00Z'), point)).toBe(true);
        expect(spanOverlapsRange(range('2026-03-08T09:00:00Z', '2026-03-08T10:00:00Z'), point)).toBe(false);
        const zoned = eventSpan({ kind: 'zoned', local: '2027-03-13T12:00:00', tzid: 'America/New_York' }, null, 'PT0S');
        expect(zoned.instant?.endNs).toBe(zoned.instant?.startNs);
        const floating = eventSpan({ kind: 'floating', local: '2027-03-13T12:00:00' }, null, 'P0D');
        expect(floating.civil.endNs).toBe(floating.civil.startNs);
        // Like an equal DATE end (W8), a zero DATE duration means one day.
        const date = eventSpan({ kind: 'date', date: '2027-03-13' }, null, 'P0D');
        expect(date.civil.endNs - date.civil.startNs).toBe(86_400n * NS);
        expect(eventSpan({ kind: 'date', date: '2027-03-13' }, null, 'PT0S').civil.endNs - date.civil.startNs).toBe(86_400n * NS);
    });
    test('timed overlap is half-open and uses DTEND', () => {
        const span = eventSpan(utc('2026-03-08T10:00:00Z'), utc('2026-03-08T11:00:00Z'), null);
        expect(spanOverlapsRange(range('2026-03-08T09:00:00Z', '2026-03-08T10:00:00Z'), span)).toBe(false);
        expect(spanOverlapsRange(range('2026-03-08T09:00:00Z', '2026-03-08T10:00:01Z'), span)).toBe(true);
        expect(spanOverlapsRange(range('2026-03-08T11:00:00Z', '2026-03-08T12:00:00Z'), span)).toBe(false);
        expect(spanOverlapsRange(range('2026-03-08T10:59:59Z', '2026-03-08T12:00:00Z'), span)).toBe(true);
    });
    test('a point matches when range.start <= start < range.end', () => {
        const point = eventSpan(utc('2026-03-08T10:00:00Z'), null, null);
        expect(spanOverlapsRange(range('2026-03-08T10:00:00Z', '2026-03-08T11:00:00Z'), point)).toBe(true);
        expect(spanOverlapsRange(range('2026-03-08T09:00:00Z', '2026-03-08T10:00:00Z'), point)).toBe(false);
        expect(spanOverlapsRange(range('2026-03-08T10:00:01Z', '2026-03-08T11:00:00Z'), point)).toBe(false);
    });
    test('DURATION gives an effective end; calendar days stay calendar days across DST in a recognized zone', () => {
        const start = { kind: 'zoned', local: '2027-03-13T12:00:00', tzid: 'America/New_York' } as const;
        const day = eventSpan(start, null, 'P1D');
        const hours = eventSpan(start, null, 'PT24H');
        expect((day.instant?.endNs ?? 0n) - (day.instant?.startNs ?? 0n)).toBe(23n * 3600n * NS);
        expect((hours.instant?.endNs ?? 0n) - (hours.instant?.startNs ?? 0n)).toBe(24n * 3600n * NS);
        expect(eventSpan(utc('2026-03-08T10:00:00Z'), null, 'P1DT1H').instant).toEqual({ startNs: 1_772_964_000n * NS, endNs: (1_772_964_000n + 90_000n) * NS });
    });
    test('a conversion that puts the end instant before the start instant is never rejected; both endpoints keep their extras and warnings', () => {
        // America/New_York 2027-03-14 02:30 does not exist: Temporal's default gives 03:30 EDT = 07:30Z, while 03:00 EDT = 07:00Z.
        const start = { kind: 'zoned', local: '2027-03-14T02:30:00', tzid: 'America/New_York' } as const;
        const end = { kind: 'zoned', local: '2027-03-14T03:00:00', tzid: 'America/New_York' } as const;
        expect(toEventTime(start)).toEqual({ local: '2027-03-14T02:30:00', zone: 'America/New_York', utc: '2027-03-14T07:30:00Z', offset: '-04:00', timezone_warning: 'utc_uncertain_dst_transition' });
        expect(toEventTime(end)).toEqual({ local: '2027-03-14T03:00:00', zone: 'America/New_York', utc: '2027-03-14T07:00:00Z', offset: '-04:00' });
        const span = eventSpan(start, end, null);
        // Overlap uses min/max of the two instants.
        expect(span.instant === null ? null : [formatInstant(span.instant.startNs), formatInstant(span.instant.endNs)]).toEqual(['2027-03-14T07:00:00Z', '2027-03-14T07:30:00Z']);
        expect(span.civil.endNs - span.civil.startNs).toBe(1800n * NS);
        expect(spanOverlapsRange(range('2027-03-14T07:10:00Z', '2027-03-14T07:20:00Z'), span)).toBe(true);
        expect(spanOverlapsRange(range('2027-03-14T07:29:59Z', '2027-03-14T08:00:00Z'), span)).toBe(true);
        expect(spanOverlapsRange(range('2027-03-14T07:30:00Z', '2027-03-14T08:00:00Z'), span)).toBe(false);
        expect(spanOverlapsRange(range('2027-03-14T06:00:00Z', '2027-03-14T07:00:00Z'), span)).toBe(false);
    });
    test('an end instant before the start instant from different zones is not an error either', () => {
        const span = eventSpan({ kind: 'zoned', local: '2026-07-15T10:00:00', tzid: 'Asia/Tokyo' }, { kind: 'zoned', local: '2026-07-15T10:00:00', tzid: 'America/New_York' }, null);
        // 10:00 Tokyo = 01:00Z and 10:00 New York = 14:00Z; the first pairing is in order, the reversed one has end < start.
        expect(span.instant).toEqual({ startNs: 1_784_077_200n * NS, endNs: 1_784_124_000n * NS });
        const reversed = eventSpan({ kind: 'zoned', local: '2026-07-15T10:00:00', tzid: 'America/New_York' }, { kind: 'zoned', local: '2026-07-15T10:00:00', tzid: 'Asia/Tokyo' }, null);
        expect(reversed.instant).toEqual({ startNs: 1_784_077_200n * NS, endNs: 1_784_124_000n * NS });
    });
    test('DATE: missing end is one day, equal end is one day, DTEND is exclusive, no instants are computed', () => {
        const date = (value: string) => ({ kind: 'date', date: value }) as const;
        const oneDay = 86_400n * NS;
        const missing = eventSpan(date('2026-03-08'), null, null);
        expect(missing.civil.endNs - missing.civil.startNs).toBe(oneDay);
        const equal = eventSpan(date('2026-03-08'), date('2026-03-08'), null);
        expect(equal.civil.endNs - equal.civil.startNs).toBe(oneDay);
        const three = eventSpan(date('2026-03-08'), date('2026-03-11'), null);
        expect(nominalSpanSeconds(three)).toBe(3 * 86_400);
        expect(eventSpan(date('2026-03-08'), null, 'P2W').civil.endNs - missing.civil.startNs).toBe(14n * oneDay);
        expect(missing.instant).toBeNull();
        expect(spanOverlapsRange(range('2030-01-01T00:00:00Z', '2030-01-02T00:00:00Z'), missing)).toBe(false);
    });
    test('DATE values are read as if UTC and kept iff they overlap the requested range widened by 24 h each side', () => {
        const date = (value: string) => ({ kind: 'date', date: value }) as const;
        const requested = range('2027-01-21T00:00:00Z', '2027-01-22T00:00:00Z');
        // Widened range is [2027-01-20T00:00Z, 2027-01-23T00:00Z).
        expect(spanOverlapsRange(requested, eventSpan(date('2027-01-20'), date('2027-01-21'), null))).toBe(true);
        expect(spanOverlapsRange(requested, eventSpan(date('2027-01-22'), null, null))).toBe(true);
        expect(spanOverlapsRange(requested, eventSpan(date('2027-01-19'), date('2027-01-20'), null))).toBe(false);
        expect(spanOverlapsRange(requested, eventSpan(date('2027-01-23'), null, null))).toBe(false);
        expect(spanOverlapsRange(requested, eventSpan(date('2027-01-31'), date('2027-02-01'), null))).toBe(false);
        // A long all-day event that spans the whole window overlaps it.
        expect(spanOverlapsRange(requested, eventSpan(date('2027-01-01'), date('2027-03-01'), null))).toBe(true);
    });
    test('floating values follow the same widened-by-24h rule, with points matching on start >= widened start and start < widened end', () => {
        const floating = (local: string) => ({ kind: 'floating', local }) as const;
        const requested = range('2027-01-21T00:00:00Z', '2027-01-22T00:00:00Z');
        expect(spanOverlapsRange(requested, eventSpan(floating('2027-01-20T23:00:00'), floating('2027-01-20T23:30:00'), null))).toBe(true);
        expect(spanOverlapsRange(requested, eventSpan(floating('2027-01-20T00:00:00'), null, null))).toBe(true);
        expect(spanOverlapsRange(requested, eventSpan(floating('2027-01-22T23:59:59'), null, null))).toBe(true);
        expect(spanOverlapsRange(requested, eventSpan(floating('2027-01-23T00:00:00'), null, null))).toBe(false);
        expect(spanOverlapsRange(requested, eventSpan(floating('2027-01-19T23:59:59'), null, null))).toBe(false);
        expect(spanOverlapsRange(requested, eventSpan(floating('2027-01-19T23:00:00'), floating('2027-01-20T00:00:00'), null))).toBe(false);
        expect(spanOverlapsRange(requested, eventSpan(floating('2027-01-31T10:00:00'), floating('2027-01-31T11:00:00'), null))).toBe(false);
    });
    test('an unrecognized-zone value has no instant and is treated like floating for filtering', () => {
        const unknown = (local: string) => ({ kind: 'zoned', local, tzid: 'Foo/Bar' }) as const;
        const requested = range('2027-01-21T00:00:00Z', '2027-01-22T00:00:00Z');
        const near = eventSpan(unknown('2027-01-20T10:00:00'), unknown('2027-01-20T11:00:00'), null);
        const far = eventSpan(unknown('2027-01-31T10:00:00'), unknown('2027-01-31T11:00:00'), null);
        expect(near.instant).toBeNull();
        expect(near.civil.endNs - near.civil.startNs).toBe(3600n * NS);
        expect(spanOverlapsRange(requested, near)).toBe(true);
        expect(spanOverlapsRange(requested, far)).toBe(false);
    });
    test('zoned and UTC values are filtered on instants, never on their civil digits', () => {
        const requested = range('2027-01-21T00:00:00Z', '2027-01-22T00:00:00Z');
        // 19:00 New York on the 21st is 00:00Z on the 22nd: its civil digits fall inside the range, its instant starts at the range end.
        const zoned = eventSpan({ kind: 'zoned', local: '2027-01-21T19:00:00', tzid: 'America/New_York' }, { kind: 'zoned', local: '2027-01-21T20:00:00', tzid: 'America/New_York' }, null);
        expect(spanOverlapsRange(requested, zoned)).toBe(false);
        const inside = eventSpan({ kind: 'zoned', local: '2027-01-21T18:59:59', tzid: 'America/New_York' }, { kind: 'zoned', local: '2027-01-21T20:00:00', tzid: 'America/New_York' }, null);
        expect(spanOverlapsRange(requested, inside)).toBe(true);
        // Ten days outside the range: excluded despite any wider provider query.
        expect(spanOverlapsRange(requested, eventSpan(utc('2027-01-31T10:00:00Z'), utc('2027-01-31T11:00:00Z'), null))).toBe(false);
        expect(spanOverlapsRange(requested, eventSpan(utc('2027-01-11T10:00:00Z'), utc('2027-01-11T11:00:00Z'), null))).toBe(false);
    });
    test('a range given with an offset widens the DATE/floating envelope around its instants', () => {
        // 2027-01-21T00:00+05:30 is 2027-01-20T18:30Z; widened by 24 h that starts 2027-01-19T18:30Z.
        const requested = range('2027-01-21T00:00:00+05:30', '2027-01-22T00:00:00+05:30');
        const date = (value: string) => ({ kind: 'date', date: value }) as const;
        expect(spanOverlapsRange(requested, eventSpan(date('2027-01-19'), date('2027-01-20'), null))).toBe(true);
        expect(spanOverlapsRange(requested, eventSpan(date('2027-01-18'), date('2027-01-19'), null))).toBe(false);
    });
    test('floating and unrecognized-zone candidates carry no instants', () => {
        const floating = eventSpan({ kind: 'floating', local: '2026-03-08T10:00:00' }, { kind: 'floating', local: '2026-03-08T11:00:00' }, null);
        const unknown = eventSpan({ kind: 'zoned', local: '2026-03-08T10:00:00', tzid: 'Foo/Bar' }, { kind: 'zoned', local: '2026-03-08T11:00:00', tzid: 'Foo/Bar' }, null);
        expect(floating.instant).toBeNull();
        expect(unknown.instant).toBeNull();
        expect(unknown.civil.endNs - unknown.civil.startNs).toBe(3600n * NS);
    });
    test('structural errors: DATE/timed mix, end with duration, bad or sub-day DATE duration, negative intervals', () => {
        const d = { kind: 'date', date: '2026-03-08' } as const;
        const t = utc('2026-03-08T10:00:00Z');
        expect(() => eventSpan(d, t, null)).toThrow(IcalError);
        expect(() => eventSpan(t, d, null)).toThrow(IcalError);
        expect(() => eventSpan(t, utc('2026-03-08T11:00:00Z'), 'PT1H')).toThrow(IcalError);
        expect(() => eventSpan(t, null, 'garbage')).toThrow(IcalError);
        expect(() => eventSpan(d, null, 'PT1H')).toThrow(IcalError);
        expect(() => eventSpan(d, { kind: 'date', date: '2026-03-07' }, null)).toThrow(IcalError);
        expect(() => eventSpan(t, utc('2026-03-08T09:00:00Z'), null)).toThrow(IcalError);
        expect(() => eventSpan({ kind: 'floating', local: '2026-03-08T10:00:00' }, { kind: 'floating', local: '2026-03-08T09:00:00' }, null)).toThrow(IcalError);
    });
    test('a surprising order across different zones is never an error for unrecognized zones', () => {
        expect(() => eventSpan({ kind: 'zoned', local: '2026-03-08T10:00:00', tzid: 'Foo/A' }, { kind: 'zoned', local: '2026-03-08T09:00:00', tzid: 'Foo/B' }, null)).not.toThrow();
    });
});

describe('deterministic order', () => {
    const key = (start: EventTime, calendarId = '/c/a/', href = '/c/a/x.ics', token: string | null = null) => ({ start, calendarId, href, token });
    test('civil start, then DATE < floating < TZID < UTC at the same civil start', () => {
        const same = '2026-03-08T00:00:00';
        const events = [
            key({ utc: '2026-03-08T00:00:00Z' }), key({ local: same, zone: 'Europe/Paris', utc: '2026-03-07T23:00:00Z', offset: '+01:00' }),
            key({ local: same, floating: true, timezone_warning: 'no_timezone_on_event' }), key({ date: '2026-03-08', all_day: true }),
        ];
        const sorted = [...events].sort(compareEventOrder);
        expect(sorted.map(event => Object.keys(event.start)[0])).toEqual(['date', 'local', 'local', 'utc']);
        expect(sorted[1]?.start).toHaveProperty('floating');
        expect(sorted[2]?.start).toHaveProperty('zone');
    });
    test('civil text compares before kind: an earlier civil start wins whatever its kind', () => {
        expect(compareEventOrder(key({ utc: '2026-03-07T23:59:59Z' }), key({ date: '2026-03-08', all_day: true }))).toBe(-1);
    });
    test('ties break by available UTC (absent first), calendar, href, then token with null first', () => {
        const local = '2026-03-08T10:00:00';
        const noUtc = key({ local, zone: 'Foo/Bar', timezone_warning: 'unrecognized_timezone' });
        const withUtc = key({ local, zone: 'Foo/Bar', utc: '2026-03-08T10:00:00Z', offset: '+00:00' });
        expect(compareEventOrder(noUtc, withUtc)).toBe(-1);
        expect(compareEventOrder(withUtc, noUtc)).toBe(1);
        const base = { utc: '2026-03-08T10:00:00Z' } as const;
        expect(compareEventOrder(key(base, '/c/a/'), key(base, '/c/b/'))).toBe(-1);
        expect(compareEventOrder(key(base, '/c/a/', '/c/a/x.ics'), key(base, '/c/a/', '/c/a/y.ics'))).toBe(-1);
        expect(compareEventOrder(key(base, '/c/a/', '/c/a/x.ics', null), key(base, '/c/a/', '/c/a/x.ics', 'occ1_20260308T100000Z'))).toBe(-1);
        expect(compareEventOrder(key(base, '/c/a/', '/c/a/x.ics', 'occ1_20260308T100000Z'), key(base, '/c/a/', '/c/a/x.ics', null))).toBe(1);
        expect(compareEventOrder(key(base), key(base))).toBe(0);
    });
    test('comparison is by code point, not UTF-16 unit', () => {
        // U+FF5E (BMP, one unit 0xFF5E) sorts before U+1F600 (astral, units 0xD83D 0xDE00) by code point but after by unit.
        expect(compareEventOrder(key(base(), '/c/～/'), key(base(), '/c/\u{1F600}/'))).toBe(-1);
        function base(): EventTime { return { utc: '2026-03-08T10:00:00Z' }; }
    });
    test('civilStartText gives the resume-hint text without timezone conversion', () => {
        expect(civilStartText({ date: '2026-03-08', all_day: true })).toBe('2026-03-08T00:00:00');
        expect(civilStartText({ utc: '2026-03-08T10:00:00Z' })).toBe('2026-03-08T10:00:00');
        expect(civilStartText({ local: '2026-03-08T10:00:00', zone: 'Europe/Paris', utc: '2026-03-08T09:00:00Z', offset: '+01:00' })).toBe('2026-03-08T10:00:00');
        expect(civilStartText({ local: '2026-03-08T10:00:00', floating: true, timezone_warning: 'no_timezone_on_event' })).toBe('2026-03-08T10:00:00');
    });
});

describe('occurrence identity', () => {
    test('token from a raw jCal RID: bounded extended UTC form, no parameters', () => {
        expect(occurrenceIdFromJcal('2026-03-08T10:30:00Z', false)).toBe('occ1_20260308T103000Z');
        expect(occurrenceIdFromJcal('2026-03-08T10:30:00Z', true)).toBeNull();
        for (const text of ['20260308T103000Z', '2026-03-08T10:30:00', '2026-03-08', '2026-03-08T10:30:60Z', '2026-03-08T24:00:00Z', '2026-02-30T10:30:00Z', '2026-03-08T10:30:00z']) { expect(occurrenceIdFromJcal(text, false)).toBeNull(); }
    });
    test('parseOccurrenceId validates the digits as a civil value and round-trips', () => {
        const parsed = parseOccurrenceId('occ1_20260308T103000Z');
        expect(parsed).toMatchObject({ serverForm: '20260308T103000Z', local: '2026-03-08T10:30:00' });
        expect(parsed?.ns).toBe(1_772_965_800n * NS);
        for (const text of ['occ1_20260308T103060Z', 'occ1_20260308T243000Z', 'occ1_20260230T103000Z', 'occ2_20260308T103000Z', 'occ1_20260308T103000', '20260308T103000Z', 'occ1_2026-03-08T10:30:00Z']) { expect(parseOccurrenceId(text)).toBeNull(); }
    });
    test('server-form lookup keys: DATE midnight, floating wall digits, UTC, recognized zone; unknown zone is null, not an error', () => {
        expect(occurrenceServerForm({ kind: 'date', date: '2026-03-08' })).toBe('20260308T000000Z');
        expect(occurrenceServerForm({ kind: 'floating', local: '2026-03-08T10:30:00' })).toBe('20260308T103000Z');
        expect(occurrenceServerForm({ kind: 'utc', utc: '2026-03-08T10:30:00Z' })).toBe('20260308T103000Z');
        expect(occurrenceServerForm({ kind: 'zoned', local: '2026-01-15T09:00:00', tzid: 'America/New_York' })).toBe('20260115T140000Z');
        expect(occurrenceServerForm({ kind: 'zoned', local: '2026-01-15T09:00:00', tzid: 'Foo/Bar' })).toBeNull();
    });
    test('occurrence window: token on the server axis plus nominal span, padded 24 h, unioned with override intervals', () => {
        const token = parseOccurrenceId('occ1_20260308T103000Z');
        if (token === null) { throw new Error('token'); }
        expect(occurrenceTransportWindow({ token, masterSpanSeconds: 3600 })).toEqual({ startUtc: '20260307T103000Z', endUtc: '20260309T113000Z' });
        const moved = { startNs: 1_773_200_000n * NS, endNs: 1_773_203_600n * NS };
        expect(occurrenceTransportWindow({ token, masterSpanSeconds: 0, overrideIntervals: [moved] })).toEqual({ startUtc: '20260307T103000Z', endUtc: '20260312T043320Z' });
        expect(() => occurrenceTransportWindow({ token, masterSpanSeconds: 0, overrideIntervals: [{ startNs: 0n, endNs: 1n }] })).toThrow(IcalError);
    });
    test('moved occurrence: the window is the union of the original slot and the override interval, padded 24 h (probe Run 5)', () => {
        const token = parseOccurrenceId('occ1_20270112T100000Z');
        if (token === null) { throw new Error('token'); }
        // 2027-01-12T10:00Z original slot (1 h) and the override 2027-02-01T10:00Z-11:00Z: both are covered, never the override alone.
        expect(occurrenceTransportWindow({ token, masterSpanSeconds: 3600, overrideIntervals: [{ startNs: token.ns + 20n * 86_400n * NS, endNs: token.ns + 20n * 86_400n * NS + 3600n * NS }] })).toEqual({ startUtc: '20270111T100000Z', endUtc: '20270202T110000Z' });
        // Moved earlier than the original slot: the union still reaches the original slot's end.
        expect(occurrenceTransportWindow({ token, masterSpanSeconds: 3600, overrideIntervals: [{ startNs: token.ns - 5n * 86_400n * NS, endNs: token.ns - 5n * 86_400n * NS + 3600n * NS }] })).toEqual({ startUtc: '20270106T100000Z', endUtc: '20270113T110000Z' });
    });
    test('moved occurrence: a union wider than MAX_TRANSPORT_DAYS is window_too_large, never a clipped window', () => {
        const token = parseOccurrenceId('occ1_20270112T100000Z');
        if (token === null) { throw new Error('token'); }
        const at = (days: bigint) => [{ startNs: token.ns + days * 86_400n * NS, endNs: token.ns + days * 86_400n * NS + 3600n * NS }];
        // Hull = 427 d + 1 h, plus two 24 h pads = 429 d + 1 h: within 430 days.
        expect(() => occurrenceTransportWindow({ token, masterSpanSeconds: 0, overrideIntervals: at(427n) })).not.toThrow();
        // 429 d + 1 h plus pads is 431 d + 1 h.
        expect(() => occurrenceTransportWindow({ token, masterSpanSeconds: 0, overrideIntervals: at(429n) })).toThrow(IcalError);
        try { occurrenceTransportWindow({ token, masterSpanSeconds: 0, overrideIntervals: at(429n) }); } catch (error) { expect((error as IcalError).reason).toBe('window_too_large'); }
    });
});

describe('scalars', () => {
    test('Path: canonical opaque absolute paths only', () => {
        for (const path of ['/', '/10000000001/calendars/home/', '/a/b%20c/', '/a/%7Bx%7D/', '/a/b:c@d/e.ics', '/a/%E2%82%AC/']) { ok(pathSchema, path); expect(isCanonicalPath(path)).toBe(true); }
        for (const path of [
            '', 'a/b', '//host/path', 'https://host/path', '/a?x=1', '/a#f', '/a/../b', '/a/./b', '/a//b', '/a\\b', '/a/%2F/b', '/a/%2f/b', '/a/%5C/b', '/a/%00', '/a/%3F', '/a/%23', '/a/%7e/b',
            '/a/%41', '/a/b c', '/a/b\tc', '/a/b\u0000c', '/a/%', '/a/%zz', '/a/%252F', '/a/%2541', '/a/{x}', '/a/^x', '/a/é', '/a/%e2%82%ac', '/a/%2E%2E/b', '/a/%0D%0A', '/a/%7F', '/' + 'a'.repeat(2048),
        ]) { bad(pathSchema, path); expect(isCanonicalPath(path)).toBe(false); }
        ok(pathSchema, '/' + 'a'.repeat(2047));
        ok(pathSchema, '/a/100%25/');
        bad(pathSchema, 123);
    });
    test('ETag: strong quoted ASCII only', () => {
        for (const etag of ['"abc"', '""', '"a b"'.replace(' ', '-'), '"C=123/4"', '"' + 'x'.repeat(1022) + '"']) { ok(etagSchema, etag); }
        for (const etag of ['abc', 'W/"abc"', '*', '"ab', 'ab"', '"a"b"', '"aé"', '"a\u007F"', '"a b"', '', '"' + 'x'.repeat(1023) + '"']) { bad(etagSchema, etag); }
    });
    test('Date, Local, Instant', () => {
        ok(dateSchema, '2028-02-29'); bad(dateSchema, '2026-02-29'); bad(dateSchema, '2026-02-29T00:00:00');
        ok(localSchema, '2026-03-08T23:59:59'); bad(localSchema, '2026-03-08T23:59:60'); bad(localSchema, '2026-03-08T24:00:00'); bad(localSchema, '2026-03-08T10:00:00Z');
        ok(instantSchema, '2026-03-08T10:00:00Z'); bad(instantSchema, '2026-03-08T10:00:00.5Z'); bad(instantSchema, '2026-03-08T10:00:00+00:00'); bad(instantSchema, '2026-03-08T10:00:60Z');
    });
    test('RangeBoundary, OccurrenceId, AttachmentRef', () => {
        ok(rangeBoundarySchema, '2026-03-08T10:00:00.123+01:00'); bad(rangeBoundarySchema, '2026-03-08T10:00:00'); bad(rangeBoundarySchema, '2026-03-08T10:00:00-00:00');
        ok(occurrenceIdSchema, 'occ1_20260308T103000Z'); bad(occurrenceIdSchema, 'occ1_20260308T103060Z'); bad(occurrenceIdSchema, 'occ1_20260230T103000Z'); bad(occurrenceIdSchema, '20260308T103000Z');
        ok(attachmentRefSchema, 'a1_' + 'A'.repeat(43)); ok(attachmentRefSchema, 'a1_' + 'a-_9'.repeat(10) + 'abc');
        bad(attachmentRefSchema, 'a1_' + 'A'.repeat(42)); bad(attachmentRefSchema, 'a1_' + 'A'.repeat(44)); bad(attachmentRefSchema, 'a2_' + 'A'.repeat(43)); bad(attachmentRefSchema, 'a1_' + 'A'.repeat(42) + '=');
    });
});

describe('EventTime schema: strict shapes with refinements', () => {
    test('accepts each form', () => {
        ok(eventTimeSchema, { date: '2026-03-08', all_day: true });
        ok(eventTimeSchema, { date: '2026-03-08', all_day: true, timezone_warning: 'timezone_dropped_from_date' });
        ok(eventTimeSchema, { local: '2026-03-08T10:00:00', floating: true, timezone_warning: 'no_timezone_on_event' });
        ok(eventTimeSchema, { utc: '2026-03-08T10:00:00Z' });
        ok(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Foo/Bar' });
        ok(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Foo/Bar', timezone_warning: 'unrecognized_timezone' });
        ok(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'America/New_York', utc: '2026-03-08T15:00:00Z', offset: '-05:00' });
        ok(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'America/New_York', utc: '2026-03-08T15:00:00Z', offset: '-04:56:02' });
        ok(eventTimeSchema, { local: '2027-11-07T01:30:00', zone: 'America/New_York', utc: '2027-11-07T05:30:00Z', offset: '-04:00', timezone_warning: 'utc_uncertain_dst_transition' });
    });
    test('rejects each inconsistent form', () => {
        bad(eventTimeSchema, { date: '2026-03-08' });
        bad(eventTimeSchema, { date: '2026-03-08', all_day: false });
        bad(eventTimeSchema, { date: '2026-03-08', all_day: true, zone: 'Europe/Paris' });
        bad(eventTimeSchema, { date: '2026-03-08', all_day: true, timezone_warning: 'no_timezone_on_event' });
        bad(eventTimeSchema, { date: '2026-03-08', all_day: true, timezone_warning: 'unrecognized_timezone' });
        bad(eventTimeSchema, { date: '2026-02-30', all_day: true });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', floating: true });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', floating: true, timezone_warning: 'unrecognized_timezone' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', floating: true, timezone_warning: 'no_timezone_on_event', utc: '2026-03-08T10:00:00Z', offset: '+00:00' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', floating: true, timezone_warning: 'no_timezone_on_event', zone: 'UTC' });
        bad(eventTimeSchema, { utc: '2026-03-08T10:00:00Z', timezone_warning: 'no_timezone_on_event' });
        bad(eventTimeSchema, { utc: '2026-03-08T10:00:00Z', local: '2026-03-08T10:00:00' });
        bad(eventTimeSchema, { utc: '2026-03-08T10:00:60Z' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: '' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Foo/Bar', utc: '2026-03-08T10:00:00Z' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Foo/Bar', offset: '+00:00' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Foo/Bar', utc: '2026-03-08T10:00:00Z', offset: '+00:00', timezone_warning: 'unrecognized_timezone' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Foo/Bar', timezone_warning: 'utc_uncertain_dst_transition' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Foo/Bar', timezone_warning: 'no_timezone_on_event' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Foo/Bar', timezone_warning: 'made_up' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Europe/Paris', utc: '2026-03-08T10:00:00Z', offset: '+1:00' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Europe/Paris', utc: '2026-03-08T10:00:00Z', offset: '+24:00' });
        bad(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'Europe/Paris', extra: true });
        bad(eventTimeSchema, {});
        bad(eventTimeSchema, null);
    });
    test('the zone label is data and is not sanitized or length-capped by the schema', () => {
        ok(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: 'a'.repeat(5000), timezone_warning: 'unrecognized_timezone' });
        ok(eventTimeSchema, { local: '2026-03-08T10:00:00', zone: '/mozilla.org/20050126_1/Europe/Paris\u0007', timezone_warning: 'unrecognized_timezone' });
    });
    test('every toEventTime result satisfies the schema', () => {
        const stored = [
            { kind: 'date', date: '2026-03-08' }, { kind: 'date', date: '2026-03-08', tzid: 'X/Y' }, { kind: 'floating', local: '2026-03-08T10:00:00' }, { kind: 'utc', utc: '2026-03-08T10:00:00Z' },
            { kind: 'zoned', local: '2026-03-08T10:00:00', tzid: 'Foo/Bar' }, { kind: 'zoned', local: '2026-03-08T10:00:00', tzid: 'Europe/Paris' }, { kind: 'zoned', local: '2027-11-07T01:30:00', tzid: 'America/New_York' },
            { kind: 'zoned', local: '2027-03-14T02:30:00', tzid: 'America/New_York' }, { kind: 'zoned', local: '2026-03-08T10:00:00', tzid: '+05:00' },
        ] as const;
        for (const value of stored) { ok(eventTimeSchema, toEventTime(value)); }
    });
});

const slim = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    calendar: 0, resource_href: '/1/calendars/c/e.ics', recurrence_id: null, expected_version: '"v1"', recurring: false,
    start: { utc: '2026-03-08T10:00:00Z' }, end: { utc: '2026-03-08T11:00:00Z' }, duration: null, title: 'T', location: null, description: null, attendees_count: 0, ...overrides,
});
const full = (overrides: Record<string, unknown> = {}): Record<string, unknown> => slim({ calendar_id: '/1/calendars/c/', uid: 'u1', view: 'single', end_exclusive: true, organizer: null, attendees: [], omitted: { alarms: 0, extension_properties: 0 }, ...overrides });

describe('event schemas', () => {
    test('SlimEvent accepts the design shape and optional true-only flags', () => {
        ok(slimEventSchema, slim());
        ok(slimEventSchema, slim({ recurrence_id: 'occ1_20260308T100000Z', recurring: true, status: 'CANCELLED', transparency: 'TRANSPARENT', sanitized: true, title_truncated: true, location_truncated: true, description_truncated: true, end: null, duration: 'PT1H' }));
        ok(slimEventSchema, slim({ status: 'TENTATIVE', title: '', location: '', description: '' }));
        ok(slimEventSchema, slim({ start: { date: '2026-03-08', all_day: true }, end: { date: '2026-03-09', all_day: true } }));
    });
    test('SlimEvent rejects bad shapes, caps, nulls and unknown keys', () => {
        bad(slimEventSchema, slim({ extra: 1 }));
        bad(slimEventSchema, slim({ status: 'CONFIRMED' }));
        bad(slimEventSchema, slim({ transparency: 'OPAQUE' }));
        bad(slimEventSchema, slim({ title_truncated: false }));
        bad(slimEventSchema, slim({ sanitized: false }));
        bad(slimEventSchema, slim({ title: 'x'.repeat(257) }));
        ok(slimEventSchema, slim({ title: 'x'.repeat(256), location: 'y'.repeat(256), description: 'z'.repeat(280) }));
        bad(slimEventSchema, slim({ location: 'y'.repeat(257) }));
        bad(slimEventSchema, slim({ description: 'z'.repeat(281) }));
        bad(slimEventSchema, slim({ attendees_count: -1 }));
        bad(slimEventSchema, slim({ attendees_count: 1.5 }));
        bad(slimEventSchema, slim({ attendees_count: Number.MAX_SAFE_INTEGER + 1 }));
        bad(slimEventSchema, slim({ calendar: -1 }));
        bad(slimEventSchema, slim({ expected_version: 'W/"v"' }));
        bad(slimEventSchema, slim({ resource_href: '/a/../b' }));
        bad(slimEventSchema, slim({ recurrence_id: 'nope' }));
        bad(slimEventSchema, slim({ title: undefined }));
        bad(slimEventSchema, slim({ start: { utc: '2026-03-08T10:00:00Z', all_day: true } }));
        bad(slimEventSchema, slim({ duration: undefined }));
    });
    test('FullEvent is slim plus the detail fields with larger caps', () => {
        ok(fullEventSchema, full());
        ok(fullEventSchema, full({ title: 'x'.repeat(1024), location: 'y'.repeat(2048), description: 'z'.repeat(8192), uid: 'u'.repeat(1024), view: 'series_master' }));
        bad(fullEventSchema, full({ title: 'x'.repeat(1025) })); bad(fullEventSchema, full({ location: 'y'.repeat(2049) })); bad(fullEventSchema, full({ description: 'z'.repeat(8193) })); bad(fullEventSchema, full({ uid: 'u'.repeat(1025) }));
        bad(fullEventSchema, full({ view: 'whatever' }));
        bad(fullEventSchema, full({ end_exclusive: false }));
        bad(fullEventSchema, slim());
        bad(fullEventSchema, full({ omitted: { alarms: 0 } }));
        bad(fullEventSchema, full({ omitted: { alarms: -1, extension_properties: 0 } }));
        const attendee = { address: 'a@example.test', name: 'A', role: 'CHAIR', participation: 'ACCEPTED' };
        ok(fullEventSchema, full({ organizer: attendee, attendees: [attendee, { address: null, name: null, role: null, participation: null, sanitized: true, truncated: true }], attendees_truncated: true }));
        bad(fullEventSchema, full({ attendees: Array.from({ length: 101 }, () => attendee) }));
        ok(fullEventSchema, full({ attendees: Array.from({ length: 100 }, () => attendee), attendees_count: 400 }));
    });
    test('Attendee: bounded text and fixed enums', () => {
        ok(attendeeSchema, { address: 'x'.repeat(512), name: 'y'.repeat(512), role: 'REQ-PARTICIPANT', participation: 'DELEGATED' });
        bad(attendeeSchema, { address: 'x'.repeat(513), name: null, role: null, participation: null });
        bad(attendeeSchema, { address: null, name: 'y'.repeat(513), role: null, participation: null });
        bad(attendeeSchema, { address: null, name: null, role: 'BOSS', participation: null });
        bad(attendeeSchema, { address: null, name: null, role: null, participation: 'MAYBE' });
        bad(attendeeSchema, { address: null, name: null, role: null, participation: null, truncated: false });
        bad(attendeeSchema, { address: null, name: null, role: null });
    });
    test('SlimEvent output type is assignable from the design shape', () => {
        const value: SlimEvent = { ...(slim() as unknown as SlimEvent) };
        const detail: FullEvent = { ...(full() as unknown as FullEvent) };
        expect(value.calendar).toBe(0);
        expect(detail.view).toBe('single');
    });
});

const statuses = (count = 1) => Array.from({ length: count }, (_, index) => ({ calendar_id: `/1/calendars/c${index}/`, display_name: `Cal ${index}`, status: 'ok' }));
const eventsOutput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    calendars: statuses(), range: { start: '2026-03-01T00:00:00Z', end: '2026-03-08T00:00:00Z' }, events: [slim()], matched_count: 1, returned_count: 1, unreadable: [], unreadable_count: 0, unreadable_truncated: false,
    truncated: false, truncation_reasons: [], complete: true, coverage: 'server_reports', limitations: ['moved_overrides_unverified', 'silent_server_omissions_undetectable'], ...overrides,
});

describe('output schemas', () => {
    test('CalendarStatus and Unreadable', () => {
        ok(calendarStatusSchema, { calendar_id: '/1/calendars/c/', display_name: null, status: 'not_read' });
        for (const status of ['ok', 'not_found', 'reconnect_required', 'temporarily_unavailable', 'upstream_error', 'result_too_large', 'not_read']) { ok(calendarStatusSchema, { calendar_id: '/1/calendars/c/', display_name: 'x', status }); }
        bad(calendarStatusSchema, { calendar_id: '/1/calendars/c/', display_name: 'x', status: 'calendar_changed' });
        bad(calendarStatusSchema, { calendar_id: '/1/calendars/c/', display_name: 'x'.repeat(257), status: 'ok' });
        ok(calendarStatusSchema, { calendar_id: '/1/calendars/c/', display_name: 'x'.repeat(256), display_name_truncated: true, sanitized: true, status: 'ok' });
        ok(unreadableSchema, { calendar: 0, resource_href: '/1/calendars/c/e.ics', recurrence_id: null, reason: 'malformed' });
        ok(unreadableSchema, { calendar: 0, resource_href: '/1/calendars/c/e.ics', recurrence_id: 'occ1_20260308T100000Z', reason: 'unsupported_recurrence_data' });
        bad(unreadableSchema, { calendar: 0, resource_href: '/1/calendars/c/e.ics', recurrence_id: null, reason: 'missing_original' });
    });
    test('EventsOutput: counts, flags and the fixed limitations are consistent', () => {
        ok(eventsOutputSchema, eventsOutput());
        ok(eventsOutputSchema, eventsOutput({ events: [], matched_count: 0, returned_count: 0 }));
        ok(eventsOutputSchema, eventsOutput({ matched_count: 5, truncated: true, truncation_reasons: ['result_limit'], complete: false, resume_hint: { last_returned_civil_start: '2026-03-08T10:00:00', instruction: 'x' } }));
        ok(eventsOutputSchema, eventsOutput({ matched_count: 5, truncated: true, truncation_reasons: ['result_limit', 'response_bytes'], complete: false, resume_hint: { last_returned_civil_start: null, instruction: 'x' } }));
        bad(eventsOutputSchema, eventsOutput({ returned_count: 2 }));
        bad(eventsOutputSchema, eventsOutput({ matched_count: 0 }));
        bad(eventsOutputSchema, eventsOutput({ matched_count: 2 }));
        bad(eventsOutputSchema, eventsOutput({ truncated: true, truncation_reasons: ['result_limit'], complete: false }));
        bad(eventsOutputSchema, eventsOutput({ matched_count: 2, truncated: true, truncation_reasons: [], complete: false }));
        bad(eventsOutputSchema, eventsOutput({ matched_count: 2, truncated: true, truncation_reasons: ['response_bytes', 'result_limit'], complete: false }));
        bad(eventsOutputSchema, eventsOutput({ matched_count: 2, truncated: true, truncation_reasons: ['result_limit', 'result_limit'], complete: false }));
        bad(eventsOutputSchema, eventsOutput({ complete: false }));
        bad(eventsOutputSchema, eventsOutput({ calendars: [{ ...statuses()[0], status: 'not_read' }] }));
        bad(eventsOutputSchema, eventsOutput({ unreadable: [{ calendar: 0, resource_href: '/1/calendars/c/e.ics', recurrence_id: null, reason: 'malformed' }], unreadable_count: 1 }));
        ok(eventsOutputSchema, eventsOutput({ unreadable: [{ calendar: 0, resource_href: '/1/calendars/c/e.ics', recurrence_id: null, reason: 'malformed' }], unreadable_count: 1, complete: false }));
        bad(eventsOutputSchema, eventsOutput({ unreadable_count: 3, unreadable_truncated: false, complete: false }));
        ok(eventsOutputSchema, eventsOutput({ unreadable_count: 3, unreadable_truncated: true, complete: false }));
        bad(eventsOutputSchema, eventsOutput({ events: [slim({ calendar: 1 })] }));
        bad(eventsOutputSchema, eventsOutput({ limitations: ['moved_overrides_unverified'] }));
        bad(eventsOutputSchema, eventsOutput({ coverage: 'complete' }));
        bad(eventsOutputSchema, eventsOutput({ extra: 1 }));
        bad(eventsOutputSchema, eventsOutput({ events: Array.from({ length: 101 }, () => slim()), matched_count: 101, returned_count: 101 }));
        bad(eventsOutputSchema, eventsOutput({ calendars: statuses(301) }));
        ok(eventsOutputSchema, eventsOutput({ calendars: statuses(300) }));
        bad(eventsOutputSchema, eventsOutput({ unreadable: Array.from({ length: 51 }, () => ({ calendar: 0, resource_href: '/1/calendars/c/e.ics', recurrence_id: null, reason: 'malformed' })), unreadable_count: 51, unreadable_truncated: false, complete: false }));
    });
    test('the output range echoes two RFC 3339 strings, not a resolved zone tuple', () => {
        bad(eventsOutputSchema, eventsOutput({ range: { start: '2026-03-01T00:00:00Z', end: '2026-03-08T00:00:00Z', zone: 'UTC' } }));
        bad(eventsOutputSchema, eventsOutput({ range: { start: '2026-03-01T00:00:00', end: '2026-03-08T00:00:00Z' } }));
    });
    test('EventsOutput type check', () => {
        const value = eventsOutput() as unknown as EventsOutput;
        expect(value.coverage).toBe('server_reports');
    });
});

const attachment = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    attachment_ref: 'a1_' + 'A'.repeat(43), component: 'master', component_recurrence_id: null, filename: 'f.pdf', content_type: 'application/pdf', declared_size: 10, form: 'inline', download_supported: false, ...overrides,
});
const detail = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ calendars: [statuses()[0]], event: full({ calendar: 0 }), attachments: [], attachments_total: 0, attachments_truncated: false, raw_included: false, ...overrides });

describe('get_event output: one strict object root', () => {
    test('raw fields are all required when raw_included and all forbidden otherwise', () => {
        ok(getEventOutputSchema, detail());
        ok(getEventOutputSchema, detail({ raw_included: true, raw_ics: 'BEGIN:VCALENDAR\n', raw_truncated: false, raw_representation: 'report_calendar_data' }));
        ok(getEventOutputSchema, detail({ raw_included: true, raw_ics: '', raw_truncated: true, raw_representation: 'report_calendar_data' }));
        bad(getEventOutputSchema, detail({ raw_included: true }));
        bad(getEventOutputSchema, detail({ raw_included: true, raw_ics: 'x', raw_truncated: false }));
        bad(getEventOutputSchema, detail({ raw_included: true, raw_ics: 'x', raw_representation: 'report_calendar_data' }));
        bad(getEventOutputSchema, detail({ raw_included: true, raw_truncated: false, raw_representation: 'report_calendar_data' }));
        bad(getEventOutputSchema, detail({ raw_included: true, raw_ics: 'x', raw_truncated: false, raw_representation: 'get' }));
        bad(getEventOutputSchema, detail({ raw_ics: 'x' }));
        bad(getEventOutputSchema, detail({ raw_truncated: false }));
        bad(getEventOutputSchema, detail({ raw_representation: 'report_calendar_data' }));
        bad(getEventOutputSchema, detail({ raw_included: true, raw_ics: 'x'.repeat(16385), raw_truncated: true, raw_representation: 'report_calendar_data' }));
    });
    test('calendars is exactly one status and the event refers to it', () => {
        bad(getEventOutputSchema, detail({ calendars: [] }));
        bad(getEventOutputSchema, detail({ calendars: [statuses()[0], statuses()[0]] }));
        bad(getEventOutputSchema, detail({ event: full({ calendar: 1 }) }));
    });
    test('attachments: bounded, with an exact total and truncation flag', () => {
        ok(getEventOutputSchema, detail({ attachments: [attachment(), attachment({ form: 'managed', component: 'override', component_recurrence_id: { utc: '2026-03-08T10:00:00Z' }, download_supported: true, filename: null, content_type: null, declared_size: null })], attachments_total: 2 }));
        bad(getEventOutputSchema, detail({ attachments: [attachment()], attachments_total: 0 }));
        bad(getEventOutputSchema, detail({ attachments: [attachment()], attachments_total: 5, attachments_truncated: false }));
        ok(getEventOutputSchema, detail({ attachments: [attachment()], attachments_total: 5, attachments_truncated: true }));
        bad(getEventOutputSchema, detail({ attachments: [], attachments_total: 0, attachments_truncated: true }));
        bad(getEventOutputSchema, detail({ attachments: Array.from({ length: 101 }, () => attachment()), attachments_total: 101, attachments_truncated: false }));
        ok(getEventOutputSchema, detail({ attachments: Array.from({ length: 100 }, () => attachment()), attachments_total: 100 }));
    });
    test('AttachmentMetadata exposes no URL or bytes and bounds names', () => {
        ok(attachmentMetadataSchema, attachment());
        bad(attachmentMetadataSchema, attachment({ url: 'https://example.test/x' }));
        bad(attachmentMetadataSchema, attachment({ data: 'AAAA' }));
        bad(attachmentMetadataSchema, attachment({ form: 'file' }));
        bad(attachmentMetadataSchema, attachment({ component: 'alarm' }));
        bad(attachmentMetadataSchema, attachment({ filename: 'f'.repeat(256) }));
        ok(attachmentMetadataSchema, attachment({ filename: 'f'.repeat(255), content_type: 'a'.repeat(255), sanitized: true, truncated: true }));
        bad(attachmentMetadataSchema, attachment({ content_type: 'a'.repeat(256) }));
        bad(attachmentMetadataSchema, attachment({ declared_size: -1 }));
        bad(attachmentMetadataSchema, attachment({ declared_size: 1.5 }));
        bad(attachmentMetadataSchema, attachment({ component_recurrence_id: { date: '2026-03-08' } }));
        bad(attachmentMetadataSchema, attachment({ download_supported: undefined }));
    });
    test('the JSON Schema root is a single object, not a union, so the MCP SDK will not wrap structuredContent', () => {
        const root = z.toJSONSchema(getEventOutputSchema, { io: 'output' }) as Record<string, unknown>;
        expect(root.type).toBe('object');
        expect(root.anyOf).toBeUndefined();
        expect(root.oneOf).toBeUndefined();
        expect(root.additionalProperties).toBe(false);
        const events = z.toJSONSchema(eventsOutputSchema, { io: 'output' }) as Record<string, unknown>;
        expect(events.type).toBe('object');
    });
    test('GetEventOutput type check', () => {
        const value = detail() as unknown as GetEventOutput;
        expect(value.raw_included).toBe(false);
    });
});

const range = { start: '2026-03-01T00:00:00Z', end: '2026-03-08T00:00:00+01:00' };
const calendarIds = ['/1/calendars/a/', '/1/calendars/b/'];

describe('input schemas', () => {
    test('list_events: accepts a range, optional unique 1..20 calendar_ids, optional limit 1..100', () => {
        const parsed = parse(listEventsInputSchema, { range });
        expect(parsed.success).toBe(true);
        ok(listEventsInputSchema, { range, calendar_ids: calendarIds, limit: 100 });
        ok(listEventsInputSchema, { range, limit: 1 });
        ok(listEventsInputSchema, { range, calendar_ids: Array.from({ length: 20 }, (_, i) => `/1/calendars/c${i}/`) });
        bad(listEventsInputSchema, { range, calendar_ids: [] });
        bad(listEventsInputSchema, { range, calendar_ids: Array.from({ length: 21 }, (_, i) => `/1/calendars/c${i}/`) });
        bad(listEventsInputSchema, { range, calendar_ids: ['/1/calendars/a/', '/1/calendars/a/'] });
        bad(listEventsInputSchema, { range, calendar_ids: ['/1/calendars/%7e/'] });
        bad(listEventsInputSchema, { range, limit: 0 });
        bad(listEventsInputSchema, { range, limit: 101 });
        bad(listEventsInputSchema, { range, limit: 1.5 });
        bad(listEventsInputSchema, { range, limit: '5' });
        bad(listEventsInputSchema, {});
        bad(listEventsInputSchema, { range: {} });
    });
    test('range: explicit offset or Z, start < end, years 1900-2100, at most 366 days, no time_zone', () => {
        bad(listEventsInputSchema, { range: { start: '2026-03-01T00:00:00', end: '2026-03-08T00:00:00Z' } });
        bad(listEventsInputSchema, { range: { start: '2026-03-01T00:00:00Z', end: '2026-03-08T00:00:00' } });
        bad(listEventsInputSchema, { range: { start: '2026-03-01', end: '2026-03-08' } });
        bad(listEventsInputSchema, { range: { start: '2026-03-08T00:00:00Z', end: '2026-03-01T00:00:00Z' } });
        bad(listEventsInputSchema, { range: { start: '2026-03-01T00:00:00Z', end: '2026-03-01T00:00:00Z' } });
        bad(listEventsInputSchema, { range: { start: '2026-03-01T00:00:00Z', end: '2026-03-08T00:00:60Z' } });
        bad(listEventsInputSchema, { range: { start: '2026-03-01T00:00:00-00:00', end: '2026-03-08T00:00:00Z' } });
        bad(listEventsInputSchema, { range: { start: '1899-01-01T00:00:00Z', end: '1899-01-02T00:00:00Z' } });
        bad(listEventsInputSchema, { range: { start: '2101-01-01T00:00:00Z', end: '2101-01-02T00:00:00Z' } });
        ok(listEventsInputSchema, { range: { start: '2026-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' } });
        bad(listEventsInputSchema, { range: { start: '2026-01-01T00:00:00Z', end: '2027-01-02T00:00:01Z' } });
        bad(listEventsInputSchema, { range: { ...range, time_zone: 'UTC' } });
        bad(listEventsInputSchema, { range, time_zone: 'UTC' });
    });
    test('a missing timezone is rejected with the fixed message that says a timezone is required, without echoing the value', () => {
        const canary = '2026-03-01T00:00:00-SECRET-CANARY';
        for (const value of [{ range: { start: '2026-03-01T00:00:00', end: '2026-03-08T00:00:00Z' } }, { range: { start: canary, end: '2026-03-08T00:00:00Z' } }]) {
            const result = parse(listEventsInputSchema, value);
            expect(result.success).toBe(false);
            const messages = issueMessages(result);
            expect(messages.length).toBeGreaterThan(0);
            for (const message of messages) {
                expect(message).toContain('A timezone is required');
                expect(message).toBe(INVALID_INPUT_MESSAGE);
            }
            expect(issueText(result)).not.toContain('CANARY');
        }
        expect(INVALID_INPUT_MESSAGE).toBe('Invalid calendar, event, occurrence, attachment or range arguments. A timezone is required for client-supplied times: use an explicit offset or Z.');
    });
    test('unknown keys are rejected without echoing the key name', () => {
        const result = parse(listEventsInputSchema, { range, 'SECRET-CANARY-KEY': 'x' });
        expect(result.success).toBe(false);
        expect(issueText(result)).not.toContain('CANARY');
        const nested = parse(listEventsInputSchema, { range: { ...range, 'SECRET-CANARY-KEY': 'x' } });
        expect(issueText(nested)).not.toContain('CANARY');
        const wrongType = parse(listEventsInputSchema, { range, limit: 'SECRET-CANARY-VALUE' });
        expect(issueText(wrongType)).not.toContain('CANARY');
    });
    test('search_events: query 1..256 nonblank after trimming, unique fields', () => {
        ok(searchEventsInputSchema, { range, query: 'standup' });
        ok(searchEventsInputSchema, { range, query: 'x'.repeat(256) });
        ok(searchEventsInputSchema, { range, query: 'q', fields: ['title'] });
        ok(searchEventsInputSchema, { range, query: 'q', fields: ['title', 'description', 'location'] });
        bad(searchEventsInputSchema, { range, query: '' });
        bad(searchEventsInputSchema, { range, query: '   \t\n ' });
        bad(searchEventsInputSchema, { range, query: 'x'.repeat(257) });
        bad(searchEventsInputSchema, { range, query: 'q', fields: [] });
        bad(searchEventsInputSchema, { range, query: 'q', fields: ['title', 'title'] });
        bad(searchEventsInputSchema, { range, query: 'q', fields: ['attendees'] });
        bad(searchEventsInputSchema, { range, query: 'q', fields: ['title', 'description', 'location', 'title'] });
        bad(searchEventsInputSchema, { range });
        bad(searchEventsInputSchema, { range, query: 5 });
        bad(searchEventsInputSchema, { range, query: 'q', regex: true });
    });
    test('get_event: canonical paths, optional token (nullable), version and include_raw', () => {
        const base = { calendar_id: '/1/calendars/c/', resource_href: '/1/calendars/c/e.ics' };
        ok(getEventInputSchema, base);
        ok(getEventInputSchema, { ...base, recurrence_id: null });
        ok(getEventInputSchema, { ...base, recurrence_id: 'occ1_20260308T100000Z', expected_version: '"v1"', include_raw: true });
        bad(getEventInputSchema, { ...base, recurrence_id: '20260308T100000Z' });
        bad(getEventInputSchema, { ...base, expected_version: 'v1' });
        bad(getEventInputSchema, { ...base, include_raw: 'yes' });
        bad(getEventInputSchema, { ...base, range });
        bad(getEventInputSchema, { resource_href: base.resource_href });
        bad(getEventInputSchema, { ...base, calendar_id: 'https://p01-caldav.icloud.com/1/calendars/c/' });
        bad(getEventInputSchema, { ...base, resource_href: '/1/calendars/c/../d/e.ics' });
    });
    test('get_event_attachment_download input: refs only, optional version, no caller URL', () => {
        const base = { calendar_id: '/1/calendars/c/', resource_href: '/1/calendars/c/e.ics', attachment_ref: 'a1_' + 'A'.repeat(43) };
        ok(downloadInputSchema, base);
        ok(downloadInputSchema, { ...base, expected_version: '"v1"' });
        ok(downloadInputSchema, { ...base, recurrence_id: 'occ1_20270111T100000Z' });
        ok(downloadInputSchema, { ...base, recurrence_id: null });
        bad(downloadInputSchema, { ...base, recurrence_id: '20270111T100000Z' });
        bad(downloadInputSchema, { ...base, url: 'https://example.test/' });
        bad(downloadInputSchema, { ...base, attachment_ref: 'a1_short' });
        bad(downloadInputSchema, { ...base, filename: 'x' });
        bad(downloadInputSchema, { calendar_id: base.calendar_id, resource_href: base.resource_href });
    });
    test('download output: a staged copy has size 0..20 MiB, an https link and a UTC expiry; an external link has only its url', () => {
        const result = { form: 'managed', attachment_ref: 'a1_' + 'A'.repeat(43), expected_version: '"v1"', filename: 'f.pdf', content_type: 'application/pdf', size: 0, download_url: 'https://s3.example.test/x', expires_at: '2026-03-08T10:05:00Z', fetched_by_server: true };
        ok(downloadOutputSchema, result);
        ok(downloadOutputSchema, { ...result, form: 'inline', size: 20 * 1048576 });
        bad(downloadOutputSchema, { ...result, size: 20 * 1048576 + 1 });
        bad(downloadOutputSchema, { ...result, size: -1 });
        bad(downloadOutputSchema, { ...result, filename: null });
        bad(downloadOutputSchema, { ...result, url: 'https://s3.example.test/x' });
        bad(downloadOutputSchema, { ...result, download_url: 'http://s3.example.test/x' });
        bad(downloadOutputSchema, { ...result, expires_at: '2026-03-08T10:05:00+01:00' });
        bad(downloadOutputSchema, { ...result, content_type: 'a b' });
        bad(downloadOutputSchema, { ...result, fetched_by_server: false });
        bad(downloadOutputSchema, { ...result, calendar_id: '/1/calendars/c/' });
        const external = { form: 'external', attachment_ref: result.attachment_ref, expected_version: '"v1"', filename: null, content_type: 'any text', url: 'https://files.example.test/a', fetched_by_server: false };
        ok(downloadOutputSchema, external);
        bad(downloadOutputSchema, { ...external, fetched_by_server: true });
        bad(downloadOutputSchema, { ...external, url: undefined });
        bad(downloadOutputSchema, { ...external, url: 'javascript:alert(1)' });
        bad(downloadOutputSchema, { ...external, download_url: 'https://s3.example.test/x' });
        bad(downloadOutputSchema, { ...external, size: 1 });
    });
    test('tool error codes: the existing four plus the phase 2 fixed codes', () => {
        for (const code of ['reconnect_required', 'temporarily_unavailable', 'insufficient_scope', 'upstream_error', 'invalid_input', 'not_found', 'result_too_large', 'calendar_changed', 'unsupported_calendar_data', 'unsupported_attachment', 'verification_failed']) { ok(readToolErrorCodeSchema, code); }
        bad(readToolErrorCodeSchema, 'timezone_error');
    });
});

describe('budget', () => {
    const clock = (start = 0) => { const state = { now: start }; return { state, now: () => state.now }; };

    test('read work deadline is min(call start + 45 s, live Lambda remaining - 3 s)', () => {
        const { state, now } = clock();
        let lambda: number | undefined;
        const budget = createReadBudget({ now, lambdaRemainingMs: () => lambda });
        expect(budget.workRemainingMs()).toBe(45_000);
        state.now = 10_000;
        expect(budget.workRemainingMs()).toBe(35_000);
        lambda = 20_000;
        expect(budget.workRemainingMs()).toBe(17_000);
        lambda = 2000;
        expect(budget.workRemainingMs()).toBe(0);
        lambda = 0;
        expect(budget.workRemainingMs()).toBe(0);
    });
    test('each DAV request gets min(10 s, remaining work, live Lambda remaining - 2 s)', () => {
        const { state, now } = clock();
        let lambda: number | undefined = 60_000;
        const budget = createReadBudget({ now, lambdaRemainingMs: () => lambda });
        expect(budget.requestTimeoutMs()).toBe(10_000);
        state.now = 40_000;
        expect(budget.requestTimeoutMs()).toBe(5000);
        lambda = 9000;
        expect(budget.requestTimeoutMs()).toBe(5000);
        lambda = 8000;
        expect(budget.requestTimeoutMs()).toBe(5000);
        lambda = 6000;
        expect(budget.requestTimeoutMs()).toBe(3000);
        lambda = 3000;
        expect(() => budget.requestTimeoutMs()).toThrow(BudgetError);
        lambda = 2000;
        expect(() => budget.requestTimeoutMs()).toThrow(BudgetError);
    });
    test('a new calendar starts only with at least 12 s of work time left', () => {
        const { state, now } = clock();
        const budget = createReadBudget({ now, lambdaRemainingMs: () => undefined });
        state.now = 33_000;
        expect(budget.canStartCalendar()).toBe(true);
        state.now = 33_001;
        expect(budget.canStartCalendar()).toBe(false);
    });
    test('throwIfExpired throws a deadline BudgetError and aborts the signal', () => {
        const { state, now } = clock();
        const budget = createReadBudget({ now, lambdaRemainingMs: () => undefined });
        expect(() => budget.throwIfExpired()).not.toThrow();
        expect(budget.signal.aborted).toBe(false);
        state.now = 45_000;
        let caught: unknown;
        try { budget.throwIfExpired(); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(BudgetError);
        expect((caught as BudgetError).kind).toBe('deadline');
        expect(budget.signal.aborted).toBe(true);
    });
    test('an absent Lambda context imposes only the call budget', () => {
        const { now } = clock();
        expect(createReadBudget({ now, lambdaRemainingMs: () => undefined }).workRemainingMs()).toBe(45_000);
    });
    test('aggregate bytes: 16 MiB shared, charged before accepting, never refunded, sticky', () => {
        const budget = createReadBudget({ now: () => 0, lambdaRemainingMs: () => undefined });
        budget.chargeBytes(16 * 1048576 - 10);
        budget.chargeBytes(10);
        expect(budget.exhausted()).toBe(false);
        let caught: unknown;
        try { budget.chargeBytes(1); } catch (error) { caught = error; }
        expect((caught as BudgetError).kind).toBe('aggregate_bytes');
        expect(budget.exhausted()).toBe(true);
        expect(() => budget.chargeBytes(0)).toThrow(BudgetError);
        expect(() => budget.responseCharge(100).chargeBytes(1)).toThrow(BudgetError);
    });
    test('per-response overflow does not exhaust shared capacity, but its bytes stay charged', () => {
        const budget = createReadBudget({ now: () => 0, lambdaRemainingMs: () => undefined });
        const first = budget.responseCharge(1000);
        first.chargeBytes(600);
        let caught: unknown;
        try { first.chargeBytes(600); } catch (error) { caught = error; }
        expect((caught as BudgetError).kind).toBe('response_bytes');
        expect(budget.exhausted()).toBe(false);
        expect(budget.bytesCharged()).toBe(1200);
        const second = budget.responseCharge(1000);
        second.chargeBytes(1000);
        expect(budget.bytesCharged()).toBe(2200);
        expect(() => second.chargeBytes(1)).toThrow(BudgetError);
    });
    test('negative, fractional or non-finite byte counts are rejected', () => {
        const budget = createReadBudget({ now: () => 0, lambdaRemainingMs: () => undefined });
        for (const value of [-1, 1.5, NaN, Infinity]) { expect(() => budget.chargeBytes(value)).toThrow(BudgetError); }
    });
    test('work: 5,000 expanded events per calendar and 10,000 per tool, lines and properties 200,000 per tool', () => {
        const budget = createReadBudget({ now: () => 0, lambdaRemainingMs: () => undefined });
        const a = budget.newCalendarWork();
        a.chargeComponents(5000);
        let caught: unknown;
        try { a.chargeComponents(1); } catch (error) { caught = error; }
        expect((caught as BudgetError).kind).toBe('work');
        expect(budget.exhausted()).toBe(false);
        const b = budget.newCalendarWork();
        b.chargeComponents(4999);
        expect(budget.exhausted()).toBe(false);
        // Tool total so far: 5000 + the failed 1 (never refunded) + 4999 = exactly 10,000; one more crosses the tool cap.
        const c = budget.newCalendarWork();
        expect(() => c.chargeComponents(1)).toThrow(BudgetError);
        expect(budget.exhausted()).toBe(true);
        const lines = createReadBudget({ now: () => 0, lambdaRemainingMs: () => undefined });
        lines.newResourceWork().chargeLines(50_000);
        expect(() => lines.newResourceWork().chargeLines(50_001)).toThrow(BudgetError);
        const properties = createReadBudget({ now: () => 0, lambdaRemainingMs: () => undefined });
        for (let index = 0; index < 4; index++) { properties.newResourceWork().chargeProperties(50_000); }
        expect(() => properties.newResourceWork().chargeProperties(1)).toThrow(BudgetError);
    });
    test('resource work caps lines and properties per resource', () => {
        const budget = createReadBudget({ now: () => 0, lambdaRemainingMs: () => undefined });
        const resource = budget.newResourceWork();
        resource.chargeLines(50_000);
        expect(() => resource.chargeLines(1)).toThrow(BudgetError);
        const other = budget.newResourceWork();
        other.chargeProperties(50_000);
        expect(() => other.chargeProperties(1)).toThrow(BudgetError);
    });
    test('the event loop is yielded every 32 normalized components', async () => {
        let yields = 0;
        const budget = createReadBudget({ now: () => 0, lambdaRemainingMs: () => undefined, yieldFn: async () => { yields++; } });
        for (let index = 0; index < 100; index++) { await budget.afterComponent(); }
        expect(yields).toBe(3);
        await budget.afterComponent(28);
        expect(yields).toBe(4);
    });
    test('download budget: 30 s whole call, further limited by live Lambda remaining - 3 s, stream lease through consumption', () => {
        const { state, now } = clock();
        let lambda: number | undefined;
        const budget = createDownloadBudget({ now, lambdaRemainingMs: () => lambda });
        expect(budget.workRemainingMs()).toBe(30_000);
        // The lease is not the 10 s buffered request guard: a 20 s stream fits inside the remaining whole budget.
        expect(budget.streamLeaseMs()).toBe(29_000);
        expect(budget.streamLeaseMs()).toBeGreaterThan(10_000);
        state.now = 5000;
        expect(budget.streamLeaseMs()).toBe(24_000);
        lambda = 12_000;
        expect(budget.workRemainingMs()).toBe(9000);
        expect(budget.streamLeaseMs()).toBe(8000);
        state.now = 29_500;
        lambda = undefined;
        expect(budget.streamLeaseMs()).toBe(0);
        expect(budget.cleanupTimeoutMs()).toBe(1000);
    });
    test('the default clock and Lambda source work without injection', () => {
        const budget = createReadBudget();
        expect(budget.workRemainingMs()).toBeGreaterThan(44_000);
        expect(budget.workRemainingMs()).toBeLessThanOrEqual(45_000);
    });
});

describe('fake read backend', () => {
    const resource = (name: string): CalendarResource => ({ href: `/1/calendars/c/${name}.ics`, etag: '"e"', calendarData: 'BEGIN:VCALENDAR\nEND:VCALENDAR\n' });
    test('records calls with the options received and returns scripts in order', async () => {
        const fake = new FakeCalDavRead().setCalendars([{ id: fakeCalendarPath('a'), displayName: 'A', components: ['VEVENT'], color: null }]);
        fake.scriptQuery(fakeCalendarPath('a'), [resource('x')], new Error('boom'));
        const charge = { chargeBytes() { /* no-op */ } };
        expect(await fake.listCalendars(AUTH, FAKE_DISCOVERY)).toHaveLength(1);
        expect(await fake.queryEvents(AUTH, FAKE_DISCOVERY, { calendarId: fakeCalendarPath('a'), range: { startUtc: '20260307T000000Z', endUtc: '20260310T000000Z' } }, { charge, deadlineMs: 5 })).toHaveLength(1);
        await expect(fake.queryEvents(AUTH, FAKE_DISCOVERY, { calendarId: fakeCalendarPath('a'), range: { startUtc: 'x', endUtc: 'y' } })).rejects.toThrow('boom');
        expect(await fake.queryEvents(AUTH, FAKE_DISCOVERY, { calendarId: fakeCalendarPath('a'), range: { startUtc: 'x', endUtc: 'y' } })).toEqual([]);
        expect(fake.count('queryEvents')).toBe(3);
        expect(fake.calls[1]?.options?.deadlineMs).toBe(5);
        expect(fake.calls[1]?.range).toEqual({ startUtc: '20260307T000000Z', endUtc: '20260310T000000Z' });
    });
    test('unscripted multiget reports not_found for every href', async () => {
        const fake = new FakeCalDavRead();
        expect(await fake.multigetEvents(AUTH, FAKE_DISCOVERY, { calendarId: fakeCalendarPath('a'), hrefs: ['/1/calendars/a/x.ics'] })).toEqual([{ kind: 'not_found', href: '/1/calendars/a/x.ics' }]);
    });
    test('held calls measure concurrency and are released by the test', async () => {
        const fake = new FakeCalDavRead();
        const holds = ['a', 'b', 'c'].map(name => fake.holdQuery(fakeCalendarPath(name)));
        const pending = ['a', 'b', 'c'].map(name => fake.queryEvents(AUTH, FAKE_DISCOVERY, { calendarId: fakeCalendarPath(name), range: { startUtc: 'x', endUtc: 'y' } }));
        await Promise.all(holds.map(hold => hold.started));
        expect(fake.inFlight).toBe(3);
        holds.forEach((hold, index) => hold.release([resource(String(index))]));
        expect((await Promise.all(pending)).map(list => list.length)).toEqual([1, 1, 1]);
        expect(fake.maxInFlight).toBe(3);
        expect(fake.inFlight).toBe(0);
    });
    test('an aborted signal stops a held call', async () => {
        const fake = new FakeCalDavRead();
        const hold = fake.holdQuery(fakeCalendarPath('a'));
        const controller = new AbortController();
        const pending = fake.queryEvents(AUTH, FAKE_DISCOVERY, { calendarId: fakeCalendarPath('a'), range: { startUtc: 'x', endUtc: 'y' } }, { signal: controller.signal });
        await hold.started;
        controller.abort();
        await expect(pending).rejects.toThrow('aborted');
    });
});

describe('compile-only stubs fail explicitly and expose the agreed signatures', () => {
    test('notImplemented names what it replaces', () => {
        expect(() => notImplemented('x.y')).toThrow('not implemented: x.y');
    });
});
