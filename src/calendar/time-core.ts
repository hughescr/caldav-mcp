/**
 * Minimal time operations (design v3 sections 2-3). Times are passed through exactly as stored.
 * The only arithmetic here is the transport window, the effective-end rule where overlap needs it,
 * and best-effort native-Temporal enrichment. No ical.js time APIs, no polyfill, no zone policy.
 *
 * Every clock regex bounds hours to [01]\d|2[0-3] and minutes/seconds to [0-5]\d, because Temporal
 * silently clamps second 60 to 59 and would otherwise accept it.
 */
import { MAX_INPUT_YEAR, MAX_RANGE_DAYS, MAX_TOKEN_TZID_BYTES, MAX_TRANSPORT_DAYS, MIN_INPUT_YEAR, MOVED_PAD_DAYS, OCCURRENCE_ID_MAX, TRANSPORT_PAD_HOURS } from './limits';
import { IcalError, type EventTime, type Interval, type OccurrenceId, type StoredTime, type TransportWindow } from './model';

const NS_PER_SECOND = 1_000_000_000n;
const SECONDS_PER_DAY = 86_400;
const HOUR = '(?:[01]\\d|2[0-3])';
const MINUTE_SECOND = '[0-5]\\d';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_RE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})T(${HOUR}):(${MINUTE_SECOND}):(${MINUTE_SECOND})$`, 'u');
const UTC_RE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})T(${HOUR}):(${MINUTE_SECOND}):(${MINUTE_SECOND})Z$`, 'u');
const BOUNDARY_RE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})T(${HOUR}):(${MINUTE_SECOND}):(${MINUTE_SECOND})(?:\\.(\\d{1,9}))?(?:Z|([+-])(${HOUR}):(${MINUTE_SECOND}))$`, 'u');
const OFFSET_RE = new RegExp(`^[+-]${HOUR}:${MINUTE_SECOND}(?::${MINUTE_SECOND})?$`, 'u');
const ID_RE = new RegExp(`^occ1_(\\d{4})(\\d{2})(\\d{2})T(${HOUR})(${MINUTE_SECOND})(${MINUTE_SECOND})Z$`, 'u');
const STORED_ID_RE = new RegExp(`^occ2_(\\d{4})(\\d{2})(\\d{2})T(${HOUR})(${MINUTE_SECOND})(${MINUTE_SECOND})_([A-Za-z0-9_-]+)$`, 'u');
const RID_JCAL_RE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})T(${HOUR}):(${MINUTE_SECOND}):(${MINUTE_SECOND})Z$`, 'u');
/** IANA-like grammar. Stops Temporal from parsing ISO strings or offsets handed in as a zone name. */
const IANA_GRAMMAR_RE = /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/u;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

// ---- Gregorian arithmetic (no Date, no Temporal) ----

function isLeap(year: number): boolean { return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0; }
function daysInMonth(year: number, month: number): number {
    if (month === 2) { return isLeap(year) ? 29 : 28; }
    return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
function validDate(year: number, month: number, day: number): boolean {
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}
function daysFromCivil(year: number, month: number, day: number): number {
    const y = month <= 2 ? year - 1 : year;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146_097 + doe - 719_468;
}
function civilFromDays(days: number): [number, number, number] {
    const z = days + 719_468;
    const era = Math.floor(z / 146_097);
    const doe = z - era * 146_097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}
function civilSeconds(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
    return daysFromCivil(year, month, day) * SECONDS_PER_DAY + hour * 3600 + minute * 60 + second;
}
function floorDiv(a: bigint, b: bigint): bigint {
    const quotient = a / b;
    return a % b !== 0n && (a < 0n) !== (b < 0n) ? quotient - 1n : quotient;
}
/** Civil fields of an epoch-second count, or null when the year leaves 0001-9999. */
function civilOf(seconds: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
    const days = Math.floor(seconds / SECONDS_PER_DAY);
    const rest = seconds - days * SECONDS_PER_DAY;
    const [year, month, day] = civilFromDays(days);
    if (year < 1 || year > 9999) { return null; }
    return { year, month, day, hour: Math.floor(rest / 3600), minute: Math.floor((rest % 3600) / 60), second: rest % 60 };
}
function secondsOfNs(ns: bigint, rounding: 'floor' | 'ceil'): number {
    const floor = floorDiv(ns, NS_PER_SECOND);
    return Number(rounding === 'ceil' && floor * NS_PER_SECOND !== ns ? floor + 1n : floor);
}

// ---- Literal validation ----

export function isValidDateText(text: string): boolean {
    const match = DATE_RE.exec(text);
    return match !== null && validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}
/** Literal `YYYY-MM-DDTHH:mm:ss`. */
export function isValidLocalText(text: string): boolean {
    const match = LOCAL_RE.exec(text);
    return match !== null && validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}
/** Literal `YYYY-MM-DDTHH:mm:ssZ`. */
export function isValidInstantText(text: string): boolean {
    const match = UTC_RE.exec(text);
    return match !== null && validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}
export function isValidOffsetText(text: string): boolean { return OFFSET_RE.test(text); }

function localNs(text: string): bigint {
    const match = LOCAL_RE.exec(text.endsWith('Z') ? text.slice(0, -1) : text);
    if (match === null) { throw new IcalError('malformed'); }
    return BigInt(civilSeconds(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]))) * NS_PER_SECOND;
}
function dateNs(text: string): bigint {
    const match = DATE_RE.exec(text);
    if (match === null) { throw new IcalError('malformed'); }
    return BigInt(daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3])) * SECONDS_PER_DAY) * NS_PER_SECOND;
}

/** `YYYY-MM-DDTHH:mm:ssZ` for an instant (fractions floored), or null when the year is outside 0001-9999. */
export function formatInstant(ns: bigint): string | null {
    const civil = civilOf(secondsOfNs(ns, 'floor'));
    return civil === null ? null : `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}T${pad(civil.hour, 2)}:${pad(civil.minute, 2)}:${pad(civil.second, 2)}Z`;
}
function formatBasicUtc(ns: bigint, rounding: 'floor' | 'ceil'): string | null {
    const civil = civilOf(secondsOfNs(ns, rounding));
    return civil === null ? null : `${pad(civil.year, 4)}${pad(civil.month, 2)}${pad(civil.day, 2)}T${pad(civil.hour, 2)}${pad(civil.minute, 2)}${pad(civil.second, 2)}Z`;
}

// ---- Range boundaries and transport window ----

export interface ParsedBoundary {
    /** The explicit instant. */
    instantNs: bigint;
    /** The literal civil digits read on a synthetic UTC axis (W7). */
    civilNs: bigint;
    year: number;
}

/**
 * Parses an RFC 3339 boundary with an explicit `Z` or `+/-HH:mm` offset and optional 1-9 fraction digits.
 * Null for anything else: missing offset, `-00:00`, annotations, leap seconds, bad dates, out-of-range clock parts.
 */
export function parseRangeBoundary(text: string): ParsedBoundary | null {
    const match = BOUNDARY_RE.exec(text);
    if (match === null) { return null; }
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!validDate(year, month, day)) { return null; }
    const sign = match[8];
    const offsetHours = match[9];
    const offsetMinutes = match[10];
    if (sign === '-' && offsetHours === '00' && offsetMinutes === '00') { return null; }
    const fraction = BigInt((match[7] ?? '').padEnd(9, '0') || '0');
    const civilNs = BigInt(civilSeconds(year, month, day, Number(match[4]), Number(match[5]), Number(match[6]))) * NS_PER_SECOND + fraction;
    const offsetSeconds = sign === undefined ? 0 : (sign === '-' ? -1 : 1) * (Number(offsetHours) * 3600 + Number(offsetMinutes) * 60);
    return { instantNs: civilNs - BigInt(offsetSeconds) * NS_PER_SECOND, civilNs, year };
}

export interface ParsedRange { startNs: bigint; endNs: bigint }

/** A valid input range: both boundaries parse, years 1900-2100, start < end, at most 366 elapsed days. Null otherwise. */
export function parseRange(range: { start: string; end: string }): ParsedRange | null {
    const start = parseRangeBoundary(range.start);
    const end = parseRangeBoundary(range.end);
    if (start === null || end === null) { return null; }
    for (const boundary of [start, end]) {
        if (boundary.year < MIN_INPUT_YEAR || boundary.year > MAX_INPUT_YEAR) { return null; }
    }
    if (start.instantNs >= end.instantNs) { return null; }
    if (end.instantNs - start.instantNs > BigInt(MAX_RANGE_DAYS * SECONDS_PER_DAY) * NS_PER_SECOND) { return null; }
    return { startNs: start.instantNs, endNs: end.instantNs };
}

/**
 * Smallest window covering every interval, padded `padHours` each side and rounded outward to whole seconds.
 * More than MAX_TRANSPORT_DAYS elapsed days (measured after rounding, padding included) is IcalError('window_too_large'),
 * which callers map to result_too_large.
 */
export function padTransportWindow(intervals: readonly Interval[], padHours: number): TransportWindow {
    const first = intervals[0];
    if (first === undefined) { throw new IcalError('malformed'); }
    let start = first.startNs;
    let end = first.endNs;
    for (const interval of intervals) {
        if (interval.startNs < start) { start = interval.startNs; }
        if (interval.endNs > end) { end = interval.endNs; }
    }
    const padNs = BigInt(padHours * 3600) * NS_PER_SECOND;
    start -= padNs;
    end += padNs;
    const startUtc = formatBasicUtc(start, 'floor');
    const endUtc = formatBasicUtc(end, 'ceil');
    if (startUtc === null || endUtc === null) { throw new IcalError('window_too_large'); }
    // Rounding is outward, so measure the span after rounding to what is actually sent.
    const sent = (BigInt(secondsOfNs(end, 'ceil')) - BigInt(secondsOfNs(start, 'floor'))) * NS_PER_SECOND;
    if (sent > BigInt(MAX_TRANSPORT_DAYS * SECONDS_PER_DAY) * NS_PER_SECOND) { throw new IcalError('window_too_large'); }
    return { startUtc, endUtc };
}

/**
 * List/search transport window: `[min(Is,Us)-31d, max(Ie,Ue)+31d)` over the instant axis I and the civil-digits axis U of the
 * two boundaries (MOVED_PAD_DAYS, probe Run 5), rounded outward to whole seconds.
 */
export function rangeTransportWindow(range: { start: string; end: string }): TransportWindow {
    const start = parseRangeBoundary(range.start);
    const end = parseRangeBoundary(range.end);
    if (start === null || end === null) { throw new IcalError('malformed'); }
    return padTransportWindow([
        { startNs: start.instantNs, endNs: end.instantNs },
        { startNs: start.civilNs, endNs: end.civilNs },
    ], MOVED_PAD_DAYS * 24);
}

// ---- Temporal enrichment (best effort, native only) ----

interface TemporalZoned {
    epochNanoseconds: bigint;
    offset: string;
    add(duration: { weeks?: number; days?: number; hours?: number; minutes?: number; seconds?: number }): TemporalZoned;
}
interface TemporalPlainDateTime {
    toZonedDateTime(zone: string, options?: { disambiguation: 'compatible' | 'earlier' | 'later' | 'reject' }): TemporalZoned;
}
interface TemporalApi { PlainDateTime: { from(text: string): TemporalPlainDateTime } }
function temporal(): TemporalApi | undefined {
    return (globalThis as unknown as { Temporal?: TemporalApi }).Temporal;
}

interface ResolvedZone {
    compatible: TemporalZoned;
    /** True when 'earlier' and 'later' disambiguation give different instants: a repeated or skipped hour. */
    inTransition: boolean;
}

/** The name itself when it has IANA grammar, else null. Windows names, numeric offsets and ISO strings are never zone names (OD10). */
function zoneIdFor(tzid: string): string | null {
    return IANA_GRAMMAR_RE.test(tzid) && tzid.length <= 128 ? tzid : null;
}

/** Null when the zone is unrecognized by Temporal; undefined when the zone is recognized but conversion failed. */
function resolveZoned(local: string, tzid: string): ResolvedZone | null | undefined {
    const api = temporal();
    const zoneId = zoneIdFor(tzid);
    if (api === undefined || zoneId === null) { return null; }
    // Recognition is decided on a fixed safe local time, so an out-of-range result below is never mistaken for an unknown zone.
    try { api.PlainDateTime.from('1970-01-01T00:00:00').toZonedDateTime(zoneId); } catch { return null; }
    try {
        const plain = api.PlainDateTime.from(local);
        const compatible = plain.toZonedDateTime(zoneId);
        const earlier = plain.toZonedDateTime(zoneId, { disambiguation: 'earlier' });
        const later = plain.toZonedDateTime(zoneId, { disambiguation: 'later' });
        return { compatible, inTransition: earlier.epochNanoseconds !== later.epochNanoseconds };
    } catch { return undefined; }
}

/**
 * Pass-through public time for a stored time. Adds `utc` and `offset` for recognized zones with Temporal's
 * default 'compatible' disambiguation, and a fixed `timezone_warning` where the instant is unknown or uncertain.
 */
export function toEventTime(stored: StoredTime): EventTime {
    switch (stored.kind) {
        case 'date':
            // A DATE never carries a timezone. A stray TZID is dropped and said so.
            return stored.tzid === undefined ? { date: stored.date, all_day: true } : { date: stored.date, all_day: true, timezone_warning: 'timezone_dropped_from_date' };
        case 'floating':
            return { local: stored.local, floating: true, timezone_warning: 'no_timezone_on_event' };
        case 'utc':
            return { utc: stored.utc };
        case 'zoned': {
            const resolved = resolveZoned(stored.local, stored.tzid);
            if (resolved === null) { return { local: stored.local, zone: stored.tzid, timezone_warning: 'unrecognized_timezone' }; }
            if (resolved === undefined) { return { local: stored.local, zone: stored.tzid }; }
            const utc = formatInstant(resolved.compatible.epochNanoseconds);
            const offset = resolved.compatible.offset;
            if (utc === null || !OFFSET_RE.test(offset)) { return { local: stored.local, zone: stored.tzid }; }
            return resolved.inTransition
                ? { local: stored.local, zone: stored.tzid, utc, offset, timezone_warning: 'utc_uncertain_dst_transition' }
                : { local: stored.local, zone: stored.tzid, utc, offset };
        }
    }
}

/**
 * Literal-validates a jCal time value. `type` is the jCal value type ('date' or 'date-time'), `value` its text, `tzid` the
 * TZID parameter if any. Null for malformed literals. A trailing Z means UTC; otherwise a TZID makes it zoned and its
 * absence floating.
 */
export function storedTimeFromJcal(type: string, value: string, tzid: string | undefined): StoredTime | null {
    if (tzid === '') { return null; }
    if (type === 'date') {
        if (!isValidDateText(value)) { return null; }
        return tzid === undefined ? { kind: 'date', date: value } : { kind: 'date', date: value, tzid };
    }
    if (type !== 'date-time') { return null; }
    if (value.endsWith('Z')) { return isValidInstantText(value) ? { kind: 'utc', utc: value } : null; }
    if (!isValidLocalText(value)) { return null; }
    return tzid === undefined ? { kind: 'floating', local: value } : { kind: 'zoned', local: value, tzid };
}

// ---- Durations, spans and the range filter ----

export interface DurationParts { weeks: number; days: number; hours: number; minutes: number; seconds: number }

/**
 * Non-negative ICS duration: `PnW` or `PnDTnHnMnS` with whole numbers only. No years, months, fractions or sign. A zero
 * duration (`PT0S`, `P0D`) is legal: a point for a timed start, one day for a DATE start (like an equal DATE end, W8).
 * Null when it does not parse.
 */
export function parseDuration(text: string): DurationParts | null {
    const weeks = /^P(\d{1,6})W$/u.exec(text);
    if (weeks !== null) { return { weeks: Number(weeks[1]), days: 0, hours: 0, minutes: 0, seconds: 0 }; }
    const match = /^P(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?)?$/u.exec(text);
    // At least one component: bare `P` and `PT` are not durations.
    if (match === null || text.endsWith('T') || text === 'P') { return null; }
    return { weeks: 0, days: Number(match[1] ?? 0), hours: Number(match[2] ?? 0), minutes: Number(match[3] ?? 0), seconds: Number(match[4] ?? 0) };
}
function durationSeconds(parts: DurationParts): number {
    return ((parts.weeks * 7 + parts.days) * 24 + parts.hours) * 3600 + parts.minutes * 60 + parts.seconds;
}

export interface EventSpan {
    /**
     * Literal civil digits on the synthetic UTC axis (DATE at midnight, floating and zoned wall digits read as UTC). Always
     * present; used for transport and as the filter basis for values without instants.
     */
    civil: Interval;
    /**
     * Real instants, only when both endpoints are computable (UTC or recognized zone); null for DATE, floating and
     * unrecognized-zone values. Best-effort enrichment can put the end before the start (a DST gap), so this holds
     * `[min, max]` of the two instants and is never an error.
     */
    instant: Interval | null;
}

function civilNsOf(time: StoredTime): bigint {
    switch (time.kind) {
        case 'date': return dateNs(time.date);
        case 'utc': return localNs(time.utc);
        case 'floating':
        case 'zoned': return localNs(time.local);
    }
}
function sameCivilAxis(a: StoredTime, b: StoredTime): boolean {
    if (a.kind === 'zoned' && b.kind === 'zoned') { return a.tzid === b.tzid; }
    return a.kind === b.kind;
}
function instantOf(time: StoredTime): { ns: bigint; zoned: TemporalZoned | null } | null {
    if (time.kind === 'utc') { return { ns: localNs(time.utc), zoned: null }; }
    if (time.kind !== 'zoned') { return null; }
    const resolved = resolveZoned(time.local, time.tzid);
    return resolved === null || resolved === undefined ? null : { ns: resolved.compatible.epochNanoseconds, zoned: resolved.compatible };
}

/**
 * Effective interval used only where overlap or occurrence transport needs an end: DTEND if present; else a non-negative DURATION
 * (calendar days stay calendar days in a recognized zone, subday units are elapsed); a missing end is one day for DATE and a
 * point for timed values; an equal DATE end or a zero DATE duration means one day, a zero timed duration a point. Throws IcalError('malformed') for DATE/timed mixes, a DTEND with a
 * DURATION, an unparseable or DATE-invalid DURATION, or an end whose literal civil digits precede the start's in one zone.
 * Never throws because best-effort UTC enrichment puts the end instant before the start instant (e.g. a DST gap).
 */
export function eventSpan(start: StoredTime, end: StoredTime | null, duration: string | null): EventSpan {
    if (end !== null && duration !== null) { throw new IcalError('malformed'); }
    const startCivil = civilNsOf(start);
    const startIsDate = start.kind === 'date';
    const oneDay = BigInt(SECONDS_PER_DAY) * NS_PER_SECOND;
    let parts: DurationParts | null = null;
    if (duration !== null) {
        parts = parseDuration(duration);
        if (parts === null || (startIsDate && (parts.hours + parts.minutes + parts.seconds) > 0)) { throw new IcalError('malformed'); }
    }
    let endCivil: bigint;
    if (end !== null) {
        if ((end.kind === 'date') !== startIsDate) { throw new IcalError('malformed'); }
        endCivil = civilNsOf(end);
        if (startIsDate && endCivil === startCivil) { endCivil += oneDay; }
    } else if (parts !== null) {
        endCivil = startCivil + BigInt(durationSeconds(parts)) * NS_PER_SECOND;
        // A zero DATE duration means one day, exactly like an equal DATE end.
        if (startIsDate && endCivil === startCivil) { endCivil += oneDay; }
    } else {
        endCivil = startIsDate ? startCivil + oneDay : startCivil;
    }
    // Civil order is only meaningful on one axis; mixed zones are checked on instants below.
    if (end !== null && endCivil < startCivil && sameCivilAxis(start, end)) { throw new IcalError('malformed'); }
    const civil: Interval = { startNs: startCivil, endNs: endCivil };

    const startInstant = instantOf(start);
    if (startInstant === null) { return { civil, instant: null }; }
    let endInstantNs: bigint | null;
    if (end !== null) {
        const endInstant = instantOf(end);
        endInstantNs = endInstant === null ? null : endInstant.ns;
    } else if (parts !== null) {
        if (startInstant.zoned === null) {
            endInstantNs = startInstant.ns + BigInt(durationSeconds(parts)) * NS_PER_SECOND;
        } else {
            try { endInstantNs = startInstant.zoned.add({ weeks: parts.weeks, days: parts.days, hours: parts.hours, minutes: parts.minutes, seconds: parts.seconds }).epochNanoseconds; } catch { endInstantNs = null; }
        }
    } else {
        endInstantNs = startInstant.ns;
    }
    if (endInstantNs === null) { return { civil, instant: null }; }
    // Enrichment is best effort: a DST gap can put the end instant before the start instant. Overlap uses min/max, never an error.
    const [low, high] = endInstantNs < startInstant.ns ? [endInstantNs, startInstant.ns] : [startInstant.ns, endInstantNs];
    return { civil, instant: { startNs: low, endNs: high } };
}

/** Half-open overlap of `interval` with `[from, to)`; a point (zero length) matches when `from <= start < to`. */
function intervalOverlaps(from: bigint, to: bigint, interval: Interval): boolean {
    const low = interval.startNs < interval.endNs ? interval.startNs : interval.endNs;
    const high = interval.startNs < interval.endNs ? interval.endNs : interval.startNs;
    if (high === low) { return from <= low && low < to; }
    return low < to && high > from;
}

/**
 * The post-query range filter for one candidate against the requested range. Zoned and UTC values (those with instants) are
 * kept iff their instant interval overlaps the requested range. DATE, floating and unrecognized-zone values have no instant:
 * their literal civil digits, read as if UTC, are kept iff they overlap the requested range widened by 24 h each side (the
 * margin absorbs the offset between the requested instants and the digits iCloud compares). Half-open overlap throughout; a
 * point (zero length) matches when `start <= value < end` of the interval it is tested against.
 */
export function spanOverlapsRange(range: ParsedRange, span: EventSpan): boolean {
    if (span.instant !== null) { return intervalOverlaps(range.startNs, range.endNs, span.instant); }
    const pad = BigInt(TRANSPORT_PAD_HOURS * 3600) * NS_PER_SECOND;
    return intervalOverlaps(range.startNs - pad, range.endNs + pad, span.civil);
}

/** Nominal span of an event in whole seconds on the civil axis, for occurrence window construction. */
export function nominalSpanSeconds(span: EventSpan): number {
    return Number((span.civil.endNs - span.civil.startNs) / NS_PER_SECOND);
}

// ---- Ordering ----

export interface OrderKey {
    start: EventTime;
    calendarId: string;
    href: string;
    token: string | null;
}

/** Literal civil start text: DATE at midnight, UTC without the Z. */
export function civilStartText(start: EventTime): string {
    if ('date' in start) { return `${start.date}T00:00:00`; }
    if ('local' in start) { return start.local; }
    return start.utc.slice(0, -1);
}
function kindRank(start: EventTime): number {
    if ('date' in start) { return 0; }
    if ('floating' in start) { return 1; }
    return 'zone' in start ? 2 : 3;
}
function availableUtc(start: EventTime): string | undefined {
    return 'utc' in start ? start.utc : undefined;
}

/** Code-point order, not UTF-16 unit order. */
export function compareCodePoints(a: string, b: string): number {
    const left = Array.from(a);
    const right = Array.from(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
        if (difference !== 0) { return difference < 0 ? -1 : 1; }
    }
    return Math.sign(left.length - right.length);
}

/**
 * Deterministic calendar-card ordering: literal civil start, then kind DATE/floating/TZID/UTC, then available UTC
 * instant (absent first), calendar_id, href, token (null first). Not a claim of one chronological axis.
 */
export function compareEventOrder(a: OrderKey, b: OrderKey): number {
    const civil = compareCodePoints(civilStartText(a.start), civilStartText(b.start));
    if (civil !== 0) { return civil; }
    const kind = kindRank(a.start) - kindRank(b.start);
    if (kind !== 0) { return Math.sign(kind); }
    const utcA = availableUtc(a.start);
    const utcB = availableUtc(b.start);
    if (utcA !== utcB) {
        if (utcA === undefined) { return -1; }
        if (utcB === undefined) { return 1; }
        const utc = compareCodePoints(utcA, utcB);
        if (utc !== 0) { return utc; }
    }
    const calendar = compareCodePoints(a.calendarId, b.calendarId);
    if (calendar !== 0) { return calendar; }
    const href = compareCodePoints(a.href, b.href);
    if (href !== 0) { return href; }
    if (a.token === b.token) { return 0; }
    if (a.token === null) { return -1; }
    if (b.token === null) { return 1; }
    return compareCodePoints(a.token, b.token);
}

// ---- Occurrence identity ----

/**
 * Token for an expanded RECURRENCE-ID: the raw jCal value must be `YYYY-MM-DDTHH:mm:ssZ` with no parameters. The extended
 * form is validated as literal civil digits, `-` and `:` are stripped, and `occ1_` is prefixed. Anything else is null.
 */
export function occurrenceIdFromJcal(value: string, hasParameters: boolean): OccurrenceId | null {
    if (hasParameters) { return null; }
    const match = RID_JCAL_RE.exec(value);
    if (match === null || !validDate(Number(match[1]), Number(match[2]), Number(match[3]))) { return null; }
    return `occ1_${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}Z`;
}

/** Strict, and a leading BOM is kept as text, so decoding is the exact inverse of the issuer's encoding. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A TZID an `occ2_` token can carry: non-empty, well-formed, no control characters, at most MAX_TOKEN_TZID_BYTES in UTF-8. */
function tokenTzid(tzid: string): boolean {
    if (tzid === '' || !tzid.isWellFormed() || Buffer.byteLength(tzid, 'utf8') > MAX_TOKEN_TZID_BYTES) { return false; }
    for (let index = 0; index < tzid.length; index++) {
        const code = tzid.charCodeAt(index);
        if (code < 0x20 || code === 0x7F) { return false; }
    }
    return true;
}

/**
 * `occ2_` token for a TZID-form RECURRENCE-ID: the local digits and the exact TZID text, base64url-encoded without padding.
 * It is an identity by text, so it needs no zone and works for an unrecognized zone or a repeated hour. Null for a TZID the
 * token cannot carry.
 */
function storedOccurrenceId(local: RegExpExecArray, tzid: string): OccurrenceId | null {
    if (!validDate(Number(local[1]), Number(local[2]), Number(local[3])) || !tokenTzid(tzid)) { return null; }
    return `occ2_${local[1]}${local[2]}${local[3]}T${local[4]}${local[5]}${local[6]}_${Buffer.from(tzid, 'utf8').toString('base64url')}`;
}

/**
 * Token for an expanded RECURRENCE-ID property (jCal type, value, and the parameters besides the VALUE that jCal folds into
 * the type). iCloud emits equivalent forms for the same all-day occurrence, so each parameterless form maps to the one
 * `occ1_` token of its server form: a Z date-time as given, `VALUE=DATE` as midnight Z, a floating date-time as its wall
 * digits Z. A local date-time whose only parameter is a single TZID (the stored form iCloud uses for an overridden instance
 * of a TZID series, probe Run 7) maps to an `occ2_` token of its text. Any other parameter, or an invalid literal, is null.
 */
export function occurrenceIdFromRecurrenceId(type: string, value: string, params: ReadonlyMap<string, readonly string[]>): OccurrenceId | null {
    if (params.size > 0) {
        const tzids = params.get('tzid');
        const local = type === 'date-time' && params.size === 1 && tzids?.length === 1 ? LOCAL_RE.exec(value) : null;
        return local === null || tzids?.[0] === undefined ? null : storedOccurrenceId(local, tzids[0]);
    }
    if (type === 'date') {
        const date = DATE_RE.exec(value);
        if (date === null || !validDate(Number(date[1]), Number(date[2]), Number(date[3]))) { return null; }
        return `occ1_${date[1]}${date[2]}${date[3]}T000000Z`;
    }
    if (type !== 'date-time') { return null; }
    const floating = LOCAL_RE.exec(value);
    if (floating !== null) {
        if (!validDate(Number(floating[1]), Number(floating[2]), Number(floating[3]))) { return null; }
        return `occ1_${floating[1]}${floating[2]}${floating[3]}T${floating[4]}${floating[5]}${floating[6]}Z`;
    }
    return occurrenceIdFromJcal(value, false);
}

export type ParsedOccurrenceId =
    | {
        kind: 'server';
        id: OccurrenceId;
        /** Server form, `YYYYMMDDTHHmmssZ`. Internal. */
        serverForm: string;
        /** The same digits as a Local literal. */
        local: string;
        /** The token read as an instant on the server axis. */
        ns: bigint;
    }
    | {
        kind: 'stored';
        id: OccurrenceId;
        /** The RECURRENCE-ID's local text, as a Local literal. */
        local: string;
        /** The RECURRENCE-ID's exact TZID text. */
        tzid: string;
        /** The local digits on the synthetic UTC civil axis, never converted through the zone. */
        ns: bigint;
    };

/**
 * Parses a client-supplied token strictly: `occ1_` with valid civil digits, or `occ2_` with valid civil digits and the
 * canonical unpadded base64url of a TZID the issuer could have encoded (UTF-8, no controls, within the byte bound), at most
 * OCCURRENCE_ID_MAX characters. Exactly the tokens the server issues parse; anything else is null.
 */
export function parseOccurrenceId(token: string): ParsedOccurrenceId | null {
    if (token.length > OCCURRENCE_ID_MAX) { return null; }
    const server = ID_RE.exec(token);
    if (server !== null) {
        if (!validDate(Number(server[1]), Number(server[2]), Number(server[3]))) { return null; }
        const local = `${server[1]}-${server[2]}-${server[3]}T${server[4]}:${server[5]}:${server[6]}`;
        return { kind: 'server', id: `occ1_${token.slice(5)}`, serverForm: `${server[1]}${server[2]}${server[3]}T${server[4]}${server[5]}${server[6]}Z`, local, ns: localNs(local) };
    }
    const stored = STORED_ID_RE.exec(token);
    const encoded = stored?.[7];
    if (stored === null || encoded === undefined || !validDate(Number(stored[1]), Number(stored[2]), Number(stored[3]))) { return null; }
    const bytes = Buffer.from(encoded, 'base64url');
    // Buffer decoding is lenient, so only the one canonical spelling of the bytes is accepted.
    if (bytes.toString('base64url') !== encoded) { return null; }
    let tzid: string;
    try { tzid = UTF8.decode(bytes); } catch { return null; }
    if (!tokenTzid(tzid)) { return null; }
    const local = `${stored[1]}-${stored[2]}-${stored[3]}T${stored[4]}:${stored[5]}:${stored[6]}`;
    return { kind: 'stored', id: `occ2_${token.slice(5)}`, local, tzid, ns: localNs(local) };
}

/**
 * Server-form (`YYYYMMDDTHHmmssZ`) lookup key for an original RECURRENCE-ID: DATE becomes midnight Z, floating its wall digits
 * Z, UTC itself, a recognized zone its best-effort UTC. Null when the zone cannot be converted; that alone is never an error.
 */
export function occurrenceServerForm(stored: StoredTime): string | null {
    const ns = stored.kind === 'zoned' ? instantOf(stored)?.ns : civilNsOf(stored);
    return ns === undefined ? null : formatBasicUtc(ns, 'floor');
}

/**
 * One bounded transport window for a non-null occurrence token, without expanding recurrence: the original slot (the token's
 * `ns` with the master's nominal span; for an `occ2_` token its local digits read as UTC, which the 24 h pad covers for any
 * real zone offset) unioned with the actual intervals of any overrides that map to it or cannot be matched, padded 24 h. iCloud returns a moved occurrence only when the window covers both its original slot and its new
 * time (probe Run 5), so the override interval is never used alone. Over MAX_TRANSPORT_DAYS is IcalError('window_too_large').
 */
export function occurrenceTransportWindow(input: { token: ParsedOccurrenceId; masterSpanSeconds: number; overrideIntervals?: readonly Interval[] }): TransportWindow {
    const nominal: Interval = { startNs: input.token.ns, endNs: input.token.ns + BigInt(Math.max(0, input.masterSpanSeconds)) * NS_PER_SECOND };
    return padTransportWindow([nominal, ...(input.overrideIntervals ?? [])], TRANSPORT_PAD_HOURS);
}
