/**
 * Client times for the write tools (phase 3 design v2 section 4.1; owner decisions OD3, OD5-OD7, OD10; ORCH B4). Pure:
 * no clock, no zone database, no zone mapping and no date math beyond one zone-free step, an explicit UTC offset turned
 * into the exact UTC instant by integer arithmetic.
 *
 * The five forms, and what is written:
 * - RFC 3339 text with an offset or Z (`2026-12-01T09:00:00-05:00`) → the UTC instant (`DTSTART:20261201T140000Z`);
 * - `{utc}` (`2026-12-01T14:00:00Z`) → the same UTC form;
 * - `{local, zone}` → `DTSTART;TZID=<zone>:<local digits>`, the zone text passed through unrecognised, Windows names and
 *   unknown names included (iCloud decides; measured: it stores unknown names as sent);
 * - `{date}` → `DTSTART;VALUE=DATE:<digits>`;
 * - `{date, zone}` → the date alone; the zone is dropped and reported (`zoneDropped`, OD7).
 * A time with no offset, Z or zone is refused (`timezone_required`, OD5). Output fields a client may pass back from
 * get_event (`utc`, `offset`, `timezone_warning`, `all_day`) are accepted and ignored, never trusted.
 */
import { IcsWriteError, quoteParameterValue, type IcsTime } from './ics-write';
import { MAX_INPUT_YEAR, MIN_INPUT_YEAR } from './limits';
import { formatInstant, isValidDateText, isValidInstantText, isValidLocalText, parseRangeBoundary } from './time-core';

export type WriteTimeField = 'start' | 'end';
export type WriteTimeReason = 'timezone_required' | 'time_invalid' | 'zone_not_representable' | 'start_end_kind_mismatch' | 'end_before_start';

/** A client time that cannot be written. Carries a fixed reason and the input field, never the text. */
export class WriteTimeError extends Error {
    constructor(public readonly reason: WriteTimeReason, public readonly field: WriteTimeField) { super(reason); }
}

/** A validated client time: never floating. */
export type ClientTime = Extract<IcsTime, { kind: 'utc' | 'zoned' | 'date' }>;

export interface WriteTime {
    time: ClientTime;
    /** A zone given with an all-day date was dropped (`timezone_dropped_from_date`). */
    zoneDropped: boolean;
}

const OFFSET_TEXT_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/u;
const BARE_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u;
const MINUTES_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;

const IGNORED_LOCAL_KEYS: ReadonlySet<string> = new Set(['local', 'zone', 'floating', 'utc', 'offset', 'timezone_warning']);
const IGNORED_DATE_KEYS: ReadonlySet<string> = new Set(['date', 'zone', 'all_day', 'timezone_warning']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const basic = (text: string): string => text.replaceAll(/[-:]/gu, '');
const yearOf = (text: string): number => Number(text.slice(0, 4));
const inYears = (text: string): boolean => yearOf(text) >= MIN_INPUT_YEAR && yearOf(text) <= MAX_INPUT_YEAR;

/** RFC 3339 with an explicit offset or Z, seconds optional, a fraction only when it is zero; the UTC instant in basic digits. */
function offsetText(text: string, field: WriteTimeField): ClientTime {
    const match = OFFSET_TEXT_RE.exec(text);
    if (match === null) {
        throw new WriteTimeError(BARE_LOCAL_RE.test(text) ? 'timezone_required' : 'time_invalid', field);
    }
    const seconds = match[2] ?? ':00';
    if (/[1-9]/u.test(seconds.slice(4))) { throw new WriteTimeError('time_invalid', field); }
    const boundary = parseRangeBoundary(`${match[1] ?? ''}${seconds}${match[3] ?? ''}`);
    if (boundary === null || boundary.year < MIN_INPUT_YEAR || boundary.year > MAX_INPUT_YEAR) { throw new WriteTimeError('time_invalid', field); }
    // Zone-free integer arithmetic only: the instant minus nothing, formatted as UTC digits.
    const instant = formatInstant(boundary.instantNs);
    if (instant === null || !inYears(instant)) { throw new WriteTimeError('time_invalid', field); }
    return { kind: 'utc', utc: basic(instant) };
}

function localTime(value: Record<string, unknown>, field: WriteTimeField): WriteTime {
    if (Object.keys(value).some(key => !IGNORED_LOCAL_KEYS.has(key))) { throw new WriteTimeError('time_invalid', field); }
    const { local, zone } = value;
    if (typeof local !== 'string') { throw new WriteTimeError('time_invalid', field); }
    const text = MINUTES_LOCAL_RE.test(local) ? `${local}:00` : local;
    if (!isValidLocalText(text) || !inYears(text)) { throw new WriteTimeError('time_invalid', field); }
    if (zone === undefined) { throw new WriteTimeError('timezone_required', field); }
    if (typeof zone !== 'string') { throw new WriteTimeError('time_invalid', field); }
    try {
        quoteParameterValue(zone);
    } catch (error) {
        if (error instanceof IcsWriteError) { throw new WriteTimeError('zone_not_representable', field); }
        throw error;
    }
    return { time: { kind: 'zoned', local: basic(text), tzid: zone }, zoneDropped: false };
}

function dateTime(value: Record<string, unknown>, field: WriteTimeField): WriteTime {
    if (Object.keys(value).some(key => !IGNORED_DATE_KEYS.has(key))) { throw new WriteTimeError('time_invalid', field); }
    const { date, zone } = value;
    if (typeof date !== 'string' || !isValidDateText(date) || !inYears(date)) { throw new WriteTimeError('time_invalid', field); }
    // A zone on a date is dropped, whatever it says: it is never sent (OD7, "conservative in what you send").
    if (zone !== undefined && typeof zone !== 'string') { throw new WriteTimeError('time_invalid', field); }
    return { time: { kind: 'date', date: basic(date) }, zoneDropped: zone !== undefined };
}

/** One client time in any of the five forms. Throws {@link WriteTimeError}. */
export function parseWriteTime(input: unknown, field: WriteTimeField): WriteTime {
    if (typeof input === 'string') { return { time: offsetText(input, field), zoneDropped: false }; }
    if (!isRecord(input)) { throw new WriteTimeError('time_invalid', field); }
    if ('utc' in input && !('local' in input)) {
        const { utc } = input;
        if (Object.keys(input).length !== 1 || typeof utc !== 'string' || !isValidInstantText(utc) || !inYears(utc)) { throw new WriteTimeError('time_invalid', field); }
        return { time: { kind: 'utc', utc: basic(utc) }, zoneDropped: false };
    }
    if ('local' in input) { return localTime(input, field); }
    if ('date' in input) { return dateTime(input, field); }
    throw new WriteTimeError('time_invalid', field);
}

export interface WriteSpan {
    start: ClientTime;
    end: ClientTime;
    /** The fields whose all-day date had a zone that was dropped, in order. */
    zoneDropped: WriteTimeField[];
}

/** Digits that order the same way as the instants or dates they write, or null when only zone math could order them. */
function comparable(start: ClientTime, end: ClientTime): [string, string] | null {
    if (start.kind === 'utc' && end.kind === 'utc') { return [start.utc, end.utc]; }
    if (start.kind === 'date' && end.kind === 'date') { return [start.date, end.date]; }
    if (start.kind === 'zoned' && end.kind === 'zoned' && start.tzid === end.tzid) { return [start.local, end.local]; }
    return null;
}

/**
 * Start and end of one event: the same kind (`start_end_kind_mismatch`), and an end not before the start where the digits
 * compare without zone math (both UTC, both dates, or both local in the identical zone text). An equal end is accepted, as
 * iCloud does (probe Run 7, write-end-order); other pairs are iCloud's call.
 */
export function parseWriteSpan(startInput: unknown, endInput: unknown): WriteSpan {
    const start = parseWriteTime(startInput, 'start');
    const end = parseWriteTime(endInput, 'end');
    if (start.time.kind !== end.time.kind) { throw new WriteTimeError('start_end_kind_mismatch', 'end'); }
    const digits = comparable(start.time, end.time);
    if (digits !== null && digits[1] < digits[0]) { throw new WriteTimeError('end_before_start', 'end'); }
    const zoneDropped: WriteTimeField[] = [];
    if (start.zoneDropped) { zoneDropped.push('start'); }
    if (end.zoneDropped) { zoneDropped.push('end'); }
    return { start: start.time, end: end.time, zoneDropped };
}
