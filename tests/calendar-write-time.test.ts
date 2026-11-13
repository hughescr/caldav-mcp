import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWriteSpan, parseWriteTime, WriteTimeError, type WriteTime } from '../src/calendar/write-time';

// Every expected value is hand-written. The offset arithmetic is checked against instants worked out by hand.

function reasonOf(action: () => unknown): string | null {
    try { action(); } catch (error) { return error instanceof WriteTimeError ? `${error.reason}@${error.field}` : `other:${String(error)}`; }
    return null;
}

const time = (input: unknown): WriteTime => parseWriteTime(input, 'start');

describe('the five input forms (design 4.1, OD5-OD7, ORCH B4)', () => {
    test('offset string: stored as the exact UTC instant by integer arithmetic', () => {
        const table: [string, string][] = [
            ['2026-12-01T09:00:00-05:00', '20261201T140000Z'],
            ['2026-12-01T09:00-05:00', '20261201T140000Z'],
            ['2026-12-01T14:00:00Z', '20261201T140000Z'],
            ['2026-12-01T14:00Z', '20261201T140000Z'],
            ['2026-12-01T00:30:00+14:00', '20261130T103000Z'],
            ['2026-12-31T23:00:00-12:00', '20270101T110000Z'],
            ['2026-06-15T12:00:00+05:45', '20260615T061500Z'],
            ['2028-02-29T01:00:00+02:00', '20280228T230000Z'],
            ['2026-03-01T00:00:00+00:30', '20260228T233000Z'],
            ['2026-12-01T09:00:00.000-05:00', '20261201T140000Z'],
            ['2026-12-01T09:00:00+00:00', '20261201T090000Z'],
        ];
        for (const [input, utc] of table) {
            expect<unknown>([input, time(input)]).toEqual([input, { time: { kind: 'utc', utc }, zoneDropped: false }]);
        }
    });

    test('{utc}: Z only, seconds required', () => {
        expect<unknown>(time({ utc: '2026-12-01T14:00:00Z' })).toEqual({ time: { kind: 'utc', utc: '20261201T140000Z' }, zoneDropped: false });
        for (const utc of ['2026-12-01T14:00:00+00:00', '2026-12-01T14:00Z', '2026-12-01T14:00:00', '2026-12-01 14:00:00Z', '2026-02-30T00:00:00Z', '2026-12-01T24:00:00Z']) {
            expect<unknown>([utc, reasonOf(() => time({ utc }))]).toEqual([utc, 'time_invalid@start']);
        }
    });

    test('{local, zone}: TZID passed through with no zone interpretation, Windows and unknown names included', () => {
        const table: [unknown, string, string][] = [
            [{ local: '2026-12-01T09:00', zone: 'America/New_York' }, '20261201T090000', 'America/New_York'],
            [{ local: '2026-12-01T09:00:30', zone: 'Europe/Berlin' }, '20261201T090030', 'Europe/Berlin'],
            [{ local: '2026-12-01T09:00:00', zone: 'Pacific Standard Time' }, '20261201T090000', 'Pacific Standard Time'],
            [{ local: '2026-12-01T09:00:00', zone: 'Mars/Olympus' }, '20261201T090000', 'Mars/Olympus'],
            [{ local: '2026-12-01T09:00:00', zone: 'Zone; with: punctuation, ok' }, '20261201T090000', 'Zone; with: punctuation, ok'],
            [{ local: '2026-12-01T09:00:00', zone: 'Zürich/Ö' }, '20261201T090000', 'Zürich/Ö'],
            // get_event output passed back unchanged: utc, offset and timezone_warning are ignored, never trusted.
            [{ local: '2026-12-01T09:00:00', zone: 'America/New_York', utc: '1999-01-01T00:00:00Z', offset: '+09:00', timezone_warning: 'utc_uncertain_dst_transition' }, '20261201T090000', 'America/New_York'],
            [{ local: '2027-03-14T02:30:00', zone: 'America/New_York' }, '20270314T023000', 'America/New_York'],
        ];
        for (const [input, local, tzid] of table) {
            expect<unknown>([input, time(input)]).toEqual([input, { time: { kind: 'zoned', local, tzid }, zoneDropped: false }]);
        }
    });

    test('{date}: VALUE=DATE; a zone given with a date is dropped and reported (OD7)', () => {
        expect<unknown>(time({ date: '2026-12-24' })).toEqual({ time: { kind: 'date', date: '20261224' }, zoneDropped: false });
        expect<unknown>(time({ date: '2026-12-24', all_day: true })).toEqual({ time: { kind: 'date', date: '20261224' }, zoneDropped: false });
        expect<unknown>(time({ date: '2026-12-24', zone: 'Europe/Paris' })).toEqual({ time: { kind: 'date', date: '20261224' }, zoneDropped: true });
        // A get_event all-day value whose stored date carried a stray zone: the warning is an output, not a zone to drop now.
        expect<unknown>(time({ date: '2026-12-24', all_day: true, timezone_warning: 'timezone_dropped_from_date' })).toEqual({ time: { kind: 'date', date: '20261224' }, zoneDropped: false });
        // Even an unrepresentable zone is simply dropped: it is never sent.
        expect<unknown>(time({ date: '2026-12-24', zone: 'bad"zone' })).toEqual({ time: { kind: 'date', date: '20261224' }, zoneDropped: true });
    });
});

describe('refusals carry a fixed reason and the field, never the text', () => {
    test('no timezone: a bare local string, a floating read value, a local without zone', () => {
        for (const input of ['2026-12-01T09:00:00', '2026-12-01T09:00', { local: '2026-12-01T09:00:00' }, { local: '2026-12-01T09:00:00', floating: true, timezone_warning: 'no_timezone_on_event' }]) {
            expect<unknown>([input, reasonOf(() => time(input))]).toEqual([input, 'timezone_required@start']);
        }
        expect(reasonOf(() => parseWriteTime('2026-12-01T09:00:00', 'end'))).toBe('timezone_required@end');
    });

    test('malformed or out-of-range times', () => {
        for (const input of [
            '2026-12-01T09:00:00-00:00', '2026-12-01T09:00:00.5Z', '2026-12-01T09:00:00.000000001+01:00', '2026-12-01T09:00:60Z', '2026-12-01T24:00:00Z',
            '2026-13-01T09:00:00Z', '2026-02-29T09:00:00Z', '1899-12-31T23:00:00Z', '2101-01-01T00:00:00Z', '2100-12-31T23:30:00-01:00', '1900-01-01T00:30:00+01:00',
            '2026-12-01t09:00:00z', '2026-12-01T09:00:00+5:00', '2026-12-01T09:00:00+05', '2026-12-01T09:00:00 +05:00', ' 2026-12-01T09:00:00Z',
            '2026-12-01T09:00:00Z\n', '2026-12-01T09:00:00[America/New_York]', '20261201T090000Z', '', 'now',
            { date: '2026-02-30' }, { date: '2026-12-1' }, { date: '1899-12-31' }, { date: '2101-01-01' }, { local: '2026-12-01T25:00', zone: 'UTC' }, { local: '2026-12-01', zone: 'UTC' },
            { local: '2101-01-01T00:00:00', zone: 'UTC' }, { local: '2026-12-01T09:00:00Z', zone: 'UTC' }, { local: '2026-12-01T09:00:00-05:00', zone: 'UTC' },
        ]) {
            expect<unknown>([input, reasonOf(() => time(input))]).toEqual([input, 'time_invalid@start']);
        }
    });

    test('a zone that cannot be a parameter value: empty, over 128 units, controls, DQUOTE, caret, backslash, lone surrogate', () => {
        for (const zone of ['', 'x'.repeat(129), 'a\u0000b', 'a\tb', 'a\nb', 'a\u007Fb', 'a"b', 'a^b', 'a\\b', '\uD800']) {
            expect<unknown>([zone, reasonOf(() => time({ local: '2026-12-01T09:00:00', zone }))]).toEqual([zone, 'zone_not_representable@start']);
        }
        expect<unknown>(time({ local: '2026-12-01T09:00:00', zone: 'x'.repeat(128) }).time).toEqual({ kind: 'zoned', local: '20261201T090000', tzid: 'x'.repeat(128) });
    });

    test('anything that is not one of the forms', () => {
        for (const input of [null, undefined, 5, [], {}, { utc: 5 }, { local: 5, zone: 'UTC' }, { date: 20261224 }, { local: '2026-12-01T09:00:00', zone: 5 }, { date: '2026-12-24', local: '2026-12-24T00:00:00', zone: 'UTC' }, { utc: '2026-12-01T14:00:00Z', zone: 'UTC' }]) {
            expect<unknown>([input, reasonOf(() => time(input))]).toEqual([input, 'time_invalid@start']);
        }
    });
});

describe('start and end together', () => {
    test('same kind required; zone-dropped dates are reported per field', () => {
        expect<unknown>(parseWriteSpan({ date: '2026-12-24', zone: 'Europe/Paris' }, { date: '2026-12-25' })).toEqual({
            start: { kind: 'date', date: '20261224' }, end: { kind: 'date', date: '20261225' }, zoneDropped: ['start'],
        });
        expect<unknown>(parseWriteSpan({ date: '2026-12-24', zone: 'Europe/Paris' }, { date: '2026-12-25', zone: 'Europe/Paris' }).zoneDropped).toEqual(['start', 'end']);
        for (const [start, end] of [
            ['2026-12-01T09:00:00Z', { date: '2026-12-02' }],
            [{ date: '2026-12-01' }, { local: '2026-12-02T00:00:00', zone: 'UTC' }],
            [{ local: '2026-12-01T09:00:00', zone: 'UTC' }, '2026-12-01T10:00:00Z'],
        ] as const) {
            expect<unknown>([start, end, reasonOf(() => parseWriteSpan(start, end))]).toEqual([start, end, 'start_end_kind_mismatch@end']);
        }
    });

    test('order is checked only where digits are comparable without zone math; equal is allowed (measured: iCloud accepts it)', () => {
        expect(reasonOf(() => parseWriteSpan('2026-12-01T10:00:00Z', '2026-12-01T09:59:59Z'))).toBe('end_before_start@end');
        // The offsets are different, the instants are not: end 15:00Z is after start 14:00Z.
        expect(reasonOf(() => parseWriteSpan('2026-12-01T09:00:00-05:00', '2026-12-01T16:00:00+01:00'))).toBeNull();
        expect(reasonOf(() => parseWriteSpan('2026-12-01T09:00:00-05:00', '2026-12-01T14:00:00+01:00'))).toBe('end_before_start@end');
        expect(reasonOf(() => parseWriteSpan({ date: '2026-12-02' }, { date: '2026-12-01' }))).toBe('end_before_start@end');
        expect(reasonOf(() => parseWriteSpan({ local: '2026-12-01T10:00', zone: 'Europe/Berlin' }, { local: '2026-12-01T09:00', zone: 'Europe/Berlin' }))).toBe('end_before_start@end');
        // Different zone texts are iCloud's call: no zone math here.
        expect(reasonOf(() => parseWriteSpan({ local: '2026-12-01T10:00', zone: 'Europe/Berlin' }, { local: '2026-12-01T09:00', zone: 'Europe/London' }))).toBeNull();
        for (const [start, end] of [['2026-12-01T10:00:00Z', '2026-12-01T10:00:00Z'], [{ date: '2026-12-01' }, { date: '2026-12-01' }]] as const) {
            expect<unknown>(reasonOf(() => parseWriteSpan(start, end))).toBeNull();
        }
    });

    test('the start is checked before the end', () => {
        expect(reasonOf(() => parseWriteSpan('bad', 'also bad'))).toBe('time_invalid@start');
        expect(reasonOf(() => parseWriteSpan('2026-12-01T10:00:00Z', 'bad'))).toBe('time_invalid@end');
    });
});

test('no Temporal, no Date and no zone database in the write-time module (OD3, OD10)', () => {
    const source = readFileSync(join(import.meta.dir, '../src/calendar/write-time.ts'), 'utf8');
    for (const banned of ['Temporal', 'new Date', 'Date.', 'Intl', 'toLocale', 'timeZone']) { expect<unknown>([banned, source.includes(banned)]).toEqual([banned, false]); }
});
