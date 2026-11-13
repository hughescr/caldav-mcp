import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseExpandedResource, parseOriginalResource } from '../src/calendar/ical';
import type { EventComponent } from '../src/calendar/model';
import { lexicalSlot, occurrencesBefore, OccurrenceTargetError, resolveOccurrence, shiftUtc, sideOf, untilBefore, utcDelta } from '../src/calendar/occurrence-target';
import { parseOccurrenceId, type ParsedOccurrenceId } from '../src/calendar/time-core';

// Hand-written stored and expanded texts in the measured shapes (probe Run 7): unmoved instances with UTC-form
// RECURRENCE-IDs and master-form times, overridden instances with the stored RECURRENCE-ID and X-RECURRENCE-EXCEPTION.

const NY = 'America/New_York';
const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const stored = (events: readonly (readonly string[])[]): ReturnType<typeof parseOriginalResource> => parseOriginalResource(crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap(lines => ['BEGIN:VEVENT', 'UID:T-1', ...lines, 'END:VEVENT']), 'END:VCALENDAR']), {});
const expanded = (events: readonly (readonly string[])[]): readonly EventComponent[] => parseExpandedResource(crlf(['BEGIN:VCALENDAR', ...events.flatMap(lines => ['BEGIN:VEVENT', 'UID:T-1', ...lines, 'END:VEVENT']), 'END:VCALENDAR']), {}).components;
const token = (text: string): ParsedOccurrenceId => {
    const parsed = parseOccurrenceId(text);
    if (parsed === null) { throw new Error('bad token'); }
    return parsed;
};
const refusal = (run: () => unknown): string => {
    try { run(); } catch (error) { return error instanceof OccurrenceTargetError ? `${error.code}${error.reason === undefined ? '' : `:${error.reason}`}` : 'other'; }
    return 'none';
};

const TZ_MASTER = [`DTSTART;TZID=${NY}:20261201T100000`, `DTEND;TZID=${NY}:20261201T103000`, 'RRULE:FREQ=WEEKLY'];
/** An unmoved half-hour instance at `local` (HH:00) with its UTC-form RECURRENCE-ID. */
const unmoved = (local: string, utc: string): string[] => [`DTSTART;TZID=${NY}:${local}`, `DTEND;TZID=${NY}:${local.slice(0, 11)}3000`, `RECURRENCE-ID:${utc}`];

describe('resolveOccurrence', () => {
    test('an unmoved instance of a zoned series: a new override at its expanded DTSTART (P3B-1)', () => {
        const original = stored([TZ_MASTER]);
        const result = resolveOccurrence(original, token('occ1_20261208T150000Z'), expanded([unmoved('20261208T100000', '20261208T150000Z'), unmoved('20261215T100000', '20261215T150000Z')]));
        expect<unknown>([result.kind, result.slot]).toEqual(['new', { kind: 'zoned', local: '20261208T100000', tzid: NY }]);
    });

    test('an existing TZID override by its occ2_ token; one moved elsewhere is still matched by its text (P3B-2, P3B-3)', () => {
        const override = [`RECURRENCE-ID;TZID=${NY}:20261208T100000`, `DTSTART;TZID=${NY}:20261209T110000`, `DTEND;TZID=${NY}:20261209T113000`, 'SUMMARY:moved'];
        const original = stored([TZ_MASTER, override]);
        const instances = expanded([[...override, 'X-RECURRENCE-EXCEPTION:TRUE']]);
        const id = instances[0]?.recurrenceId?.token ?? '';
        expect(id.startsWith('occ2_20261208T100000_')).toBe(true);
        const result = resolveOccurrence(original, token(id), instances);
        expect<unknown>([result.kind, result.slot]).toEqual(['existing', { kind: 'zoned', local: '20261208T100000', tzid: NY }]);
        // The expansion showing other times for that override is not that override.
        const other = expanded([[`RECURRENCE-ID;TZID=${NY}:20261208T100000`, `DTSTART;TZID=${NY}:20261210T110000`, `DTEND;TZID=${NY}:20261210T113000`, 'X-RECURRENCE-EXCEPTION:TRUE']]);
        expect(refusal(() => resolveOccurrence(original, token(id), other))).toBe('occurrence_identity_unprovable:override_not_matched');
    });

    test('a UTC override on a zoned master is matched by its occ1_ token (P3B-6)', () => {
        const override = ['RECURRENCE-ID:20261208T150000Z', `DTSTART;TZID=${NY}:20261208T100000`, `DTEND;TZID=${NY}:20261208T103000`];
        const result = resolveOccurrence(stored([TZ_MASTER, override]), token('occ1_20261208T150000Z'), expanded([[...override, 'X-RECURRENCE-EXCEPTION:TRUE']]));
        expect<unknown>([result.kind, result.slot]).toEqual(['existing', { kind: 'utc', utc: '20261208T150000Z' }]);
    });

    test('DATE, floating and UTC series: the slot agrees with the token lexically; a form mismatch fails closed', () => {
        const date = stored([['DTSTART;VALUE=DATE:20270408', 'DTEND;VALUE=DATE:20270409', 'RRULE:FREQ=WEEKLY']]);
        expect(resolveOccurrence(date, token('occ1_20270415T000000Z'), expanded([['DTSTART;VALUE=DATE:20270415', 'DTEND;VALUE=DATE:20270416', 'RECURRENCE-ID:20270415T000000Z']])).slot).toEqual({ kind: 'date', date: '20270415' });
        const floating = stored([['DTSTART:20270409T090000', 'DTEND:20270409T100000', 'RRULE:FREQ=WEEKLY']]);
        expect(resolveOccurrence(floating, token('occ1_20270416T090000Z'), expanded([['DTSTART:20270416T090000', 'DTEND:20270416T100000', 'RECURRENCE-ID:20270416T090000Z']])).slot).toEqual({ kind: 'floating', local: '20270416T090000' });
        // iCloud rendering the instance in another form than the master's: refused, never adapted.
        expect(refusal(() => resolveOccurrence(floating, token('occ1_20270416T090000Z'), expanded([['DTSTART:20270416T090000Z', 'DTEND:20270416T100000Z', 'RECURRENCE-ID:20270416T090000Z']])))).toBe('occurrence_identity_unprovable:form_mismatch');
        const utc = stored([['DTSTART:20270407T150000Z', 'DTEND:20270407T160000Z', 'RRULE:FREQ=WEEKLY']]);
        expect(refusal(() => resolveOccurrence(utc, token('occ1_20270414T150000Z'), expanded([['DTSTART:20270414T160000Z', 'DTEND:20270414T170000Z', 'RECURRENCE-ID:20270414T150000Z']])))).toBe('occurrence_identity_unprovable:form_mismatch');
    });

    test('fail closed: no instance, an expanded override without a stored one, two unmoved at one local time, an unrecognised zone, a stored orphan at the slot', () => {
        const original = stored([TZ_MASTER]);
        expect(refusal(() => resolveOccurrence(original, token('occ1_20261208T150000Z'), expanded([unmoved('20261215T100000', '20261215T150000Z')])))).toBe('not_found');
        expect(refusal(() => resolveOccurrence(original, token('occ1_20261208T150000Z'), expanded([[...unmoved('20261208T100000', '20261208T150000Z'), 'X-RECURRENCE-EXCEPTION:TRUE']])))).toBe('occurrence_identity_unprovable:override_not_matched');
        // A repeated hour of a sub-daily series: two unmoved instances share the local text (a test injection of that shape).
        const twins = expanded([[`DTSTART;TZID=${NY}:20271107T013000`, `DTEND;TZID=${NY}:20271107T020000`, 'RECURRENCE-ID:20271107T053000Z'], [`DTSTART;TZID=${NY}:20271107T013000`, `DTEND;TZID=${NY}:20271107T020000`, 'RECURRENCE-ID:20271107T063000Z']]);
        expect(refusal(() => resolveOccurrence(stored([[`DTSTART;TZID=${NY}:20271107T003000`, `DTEND;TZID=${NY}:20271107T010000`, 'RRULE:FREQ=HOURLY']]), token('occ1_20271107T063000Z'), twins))).toBe('occurrence_identity_unprovable:shares_time_with_other_occurrence');
        const mars = stored([['DTSTART;TZID=Mars/Olympus:20261201T100000', 'DTEND;TZID=Mars/Olympus:20261201T103000', 'RRULE:FREQ=WEEKLY']]);
        expect(refusal(() => resolveOccurrence(mars, token('occ1_20261208T100000Z'), expanded([['DTSTART;TZID=Mars/Olympus:20261208T100000', 'DTEND;TZID=Mars/Olympus:20261208T103000', 'RECURRENCE-ID:20261208T100000Z']])))).toBe('occurrence_identity_unprovable:unrecognized_zone');
        const orphan = stored([TZ_MASTER, [`RECURRENCE-ID;TZID=${NY}:20261208T100000`, `DTSTART;TZID=${NY}:20261208T100000`, `DTEND;TZID=${NY}:20261208T103000`]]);
        expect(refusal(() => resolveOccurrence(orphan, token('occ1_20261208T150000Z'), expanded([unmoved('20261208T100000', '20261208T150000Z')])))).toBe('occurrence_identity_unprovable:override_exists_unmatched');
    });

    test('lexicalSlot: only where no expansion is needed', () => {
        const utc = { kind: 'utc' as const, utc: '2027-01-05T15:00:00Z' };
        expect(lexicalSlot(utc, token('occ1_20270112T150000Z'))).toEqual({ kind: 'utc', utc: '20270112T150000Z' });
        expect(lexicalSlot({ kind: 'date', date: '2027-01-05' }, token('occ1_20270112T000000Z'))).toEqual({ kind: 'date', date: '20270112' });
        expect(lexicalSlot({ kind: 'date', date: '2027-01-05' }, token('occ1_20270112T010000Z'))).toBeNull();
        expect(lexicalSlot({ kind: 'zoned', local: '2027-01-05T10:00:00', tzid: NY }, token('occ1_20270112T150000Z'))).toBeNull();
    });
});

describe('split arithmetic: zone-free only', () => {
    test('UNTIL is the split point minus one second, in the master form (P3C-1)', () => {
        expect(untilBefore('20270316T140000Z', 'zoned')).toBe('20270316T135959Z');
        expect(untilBefore('20270316T140000Z', 'utc')).toBe('20270316T135959Z');
        expect(untilBefore('20270225T000000Z', 'date')).toBe('20270224');
        expect(untilBefore('20270226T090000Z', 'floating')).toBe('20270226T085959');
        expect(untilBefore('20270101T000000Z', 'utc')).toBe('20261231T235959Z');
    });

    test('sideOf: UTC forms on the token axis; zoned values by local text with a 3-hour guard; mixed forms unprovable', () => {
        const zoned = { kind: 'zoned' as const, local: '2027-03-16T10:00:00', tzid: NY };
        const slot = { kind: 'zoned' as const, local: '20270316T100000', tzid: NY };
        expect(sideOf({ kind: 'utc', utc: '2027-03-09T15:00:00Z' }, zoned, '20270316T140000Z', slot)).toBe('before');
        expect(sideOf({ kind: 'utc', utc: '2027-03-16T14:00:00Z' }, zoned, '20270316T140000Z', slot)).toBe('after');
        expect(sideOf({ kind: 'zoned', local: '2027-03-23T10:00:00', tzid: NY }, zoned, '20270316T140000Z', slot)).toBe('after');
        expect(sideOf({ kind: 'zoned', local: '2027-03-16T08:30:00', tzid: NY }, zoned, '20270316T140000Z', slot)).toBe('unprovable');
        expect(sideOf({ kind: 'zoned', local: '2027-03-09T10:00:00', tzid: 'Europe/Berlin' }, zoned, '20270316T140000Z', slot)).toBe('unprovable');
        expect(sideOf({ kind: 'date', date: '2027-03-09' }, zoned, '20270316T140000Z', slot)).toBe('unprovable');
    });

    test('occurrencesBefore counts iCloud\'s instances; an EXDATE before the split, or an override the expansion does not show, makes it unprovable', () => {
        const master = ['DTSTART:20270202T150000Z', 'DTEND:20270202T160000Z', 'RRULE:FREQ=WEEKLY;COUNT=8'];
        const instances = (days: readonly string[]): readonly EventComponent[] => expanded(days.map(day => [`DTSTART:202702${day}T150000Z`, `DTEND:202702${day}T160000Z`, `RECURRENCE-ID:202702${day}T150000Z`]));
        const slot = { kind: 'utc' as const, utc: '20270223T150000Z' };
        expect(occurrencesBefore(stored([master]), instances(['02', '09', '16', '23']), '20270223T150000Z', slot)).toBe(3);
        expect(occurrencesBefore(stored([[...master, 'EXDATE:20270209T150000Z']]), instances(['02', '16', '23']), '20270223T150000Z', slot)).toBeNull();
        // An EXDATE after the split does not count before it.
        expect(occurrencesBefore(stored([[...master, 'EXDATE:20270302T150000Z']]), instances(['02', '09', '16', '23']), '20270223T150000Z', slot)).toBe(3);
        const hidden = stored([master, ['RECURRENCE-ID:20270209T150000Z', 'DTSTART:20270310T150000Z', 'DTEND:20270310T160000Z']]);
        expect(occurrencesBefore(hidden, instances(['02', '16', '23']), '20270223T150000Z', slot)).toBeNull();
    });

    test('series shift: UTC values only, by one delta', () => {
        expect(utcDelta({ kind: 'utc', utc: '20270208T150000Z' }, { kind: 'utc', utc: '20270209T160000Z' })).toBe(90_000n);
        expect(utcDelta({ kind: 'zoned', local: '20270208T100000', tzid: NY }, { kind: 'utc', utc: '20270209T160000Z' })).toBeNull();
        expect(shiftUtc('20270222T150000Z', 90_000n)).toBe('20270223T160000Z');
    });
});

test('no Temporal, no Date and no zone database in the occurrence-identity module (ORCH-R)', () => {
    const source = readFileSync(join(import.meta.dir, '../src/calendar/occurrence-target.ts'), 'utf8').replaceAll(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gmu, '');
    for (const banned of ['Temporal', 'new Date', 'Date.', 'Intl', 'toLocale', 'timeZone', 'ical.js']) { expect<unknown>([banned, source.includes(banned)]).toEqual([banned, false]); }
});
