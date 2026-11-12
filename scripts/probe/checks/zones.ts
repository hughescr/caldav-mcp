/**
 * Time zones the probe writes into its own events, and the arithmetic to know what instant a
 * correct server must return for them. Offsets are minutes; a "wall" value is a local clock
 * time held as UTC milliseconds.
 */
export const NEW_YORK = [
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
];

export const LOS_ANGELES = [
    'BEGIN:VTIMEZONE', 'TZID:America/Los_Angeles',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700', 'TZNAME:PDT', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800', 'TZNAME:PST', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
];

export const CUSTOM_TZID = 'Probe/Custom';

/** Eastern offsets with the pre-2007 US rules (daylight time from the first Sunday of April to the last Sunday of October), under a name tzdb does not have. */
export const CUSTOM_ZONE = [
    'BEGIN:VTIMEZONE', `TZID:${CUSTOM_TZID}`,
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19870405T020000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19971026T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
];

const DAY = 86_400_000;
const MINUTE = 60_000;

/** Day of the month of the nth (1-based) Sunday of a month (month 1 to 12). */
export function nthSunday(year: number, month: number, nth: number): number {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (nth - 1) * 7;
}

/** Midnight UTC (as a wall value) of the Sunday on which US daylight time starts (second Sunday of March). */
export function usDstStart(year: number): number {
    return Date.UTC(year, 2, nthSunday(year, 3, 2));
}

/** The first Sunday on which US daylight time starts at least `days` after `from` (a UTC midnight). */
export function nextUsDstStart(from: number, days: number): number {
    const year = new Date(from).getUTCFullYear();
    for (const y of [year, year + 1, year + 2]) {
        if (usDstStart(y) - days * DAY >= from) {
            return usDstStart(y);
        }
    }
    return usDstStart(year + 3);
}

/** Eastern offset in minutes at a wall-clock time, under the rules since 2007 (second Sunday of March to first Sunday of November, 02:00). */
export function easternOffset(wall: number): number {
    const year = new Date(wall).getUTCFullYear();
    const start = usDstStart(year) + 2 * 3_600_000;
    const end = Date.UTC(year, 10, nthSunday(year, 11, 1)) + 2 * 3_600_000;
    return wall >= start && wall < end ? -240 : -300;
}

export function wallToInstant(wall: number, offsetMinutes: number): number {
    return wall - offsetMinutes * MINUTE;
}

/** `20270307T090000` or `20270307T140000Z` as milliseconds, ignoring the Z; undefined for any other shape. */
export function parseWall(value: string | undefined): number | undefined {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value ?? '');
    if (match === null) {
        return undefined;
    }
    const [, y, mo, d, h, mi, s] = match;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/** The instant of a UTC value (with the Z), or undefined. */
export function parseUtc(value: string | undefined): number | undefined {
    return value?.endsWith('Z') === true ? parseWall(value) : undefined;
}
