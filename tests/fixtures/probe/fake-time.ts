/**
 * The time and recurrence engine of the fake iCloud server: zones, recurrence expansion and the
 * forms in which expanded instances are written back. Every behaviour a real server may differ
 * on (the form of expanded values, which rules a custom TZID uses, how floating and DATE values
 * are placed on the time axis, where a moved override counts) is an option, so each probe check
 * can be driven to every outcome. All data is synthetic.
 */
import { comps, parseIcal, prop, props, type IcalComponent, type IcalProperty } from '../../../scripts/probe/ical';

export const DAY = 86_400_000;
const MIN = 60_000;

export type ExpandStyle = 'utc-all' | 'keep-forms' | 'keep-forms-no-vtimezone' | 'date-as-utc';

export interface TimeEnv {
    /** Zone in which floating and DATE values are placed on the time axis; undefined means UTC. */
    floating: ZoneRules | undefined;
    embedded: Map<string, ZoneRules>;
    /** Which rules a known TZID with an embedded VTIMEZONE uses; `ignore` reads every TZID value as UTC. */
    tzPolicy: 'embedded-first' | 'tzdb-first' | 'ignore';
    unknownTzid: 'use-embedded' | 'as-new-york' | 'as-utc';
    overrideMatching: 'actual' | 'original-slot';
    thisAndFuture: 'applied' | 'ignored';
    feb29: 'skip' | 'clamp' | 'roll';
    /** A local time that occurs twice: the first occurrence (RFC 5545, the default) or the second. */
    repeatedHour?: 'first' | 'second';
    /** A local time that does not exist: read with the offset before the gap (RFC 5545, the default) or the one after it. */
    skippedHour?: 'before-gap' | 'after-gap';
}

export interface ExpandOptions {
    style: ExpandStyle;
    keepDuration: boolean;
}

export function utc(ms: number): string {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** UTC range or date value, as used in time-range attributes. */
export function parseDt(value: string | undefined): number | undefined {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value ?? '');
    if (match === null) {
        return undefined;
    }
    const [, y, mo, d, h, mi, s] = match;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
}

function wall(ms: number): string {
    return utc(ms).replace(/Z$/, '');
}

function dateText(ms: number): string {
    return utc(ms).slice(0, 8);
}

function durationMs(value: string | undefined): number | undefined {
    const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value ?? '');
    if (match === null) {
        return undefined;
    }
    const [, w, d, h, m, s] = match.map((x) => Number(x ?? 0));
    return ((((w ?? 0) * 7 + (d ?? 0)) * 24 + (h ?? 0)) * 60 + (m ?? 0)) * 60_000 + (s ?? 0) * 1000;
}

// ---- zones -----------------------------------------------------------------------------

/** One STANDARD or DAYLIGHT block. Offsets are minutes; `start` is a local wall-clock time as UTC milliseconds. */
export interface Observance {
    offsetFrom: number;
    offsetTo: number;
    start: number;
    month?: number;
    nth?: number;
    weekday?: number;
}
export type ZoneRules = Observance[];

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function nthWeekdayMs(year: number, month: number, weekday: number, nth: number, timeOfDay: number): number {
    if (nth > 0) {
        const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
        return Date.UTC(year, month - 1, 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7) + timeOfDay;
    }
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
    return Date.UTC(year, month - 1, lastDay - ((lastDow - weekday + 7) % 7)) + timeOfDay;
}

function onsets(o: Observance, year: number): number[] {
    if (o.month === undefined || o.nth === undefined || o.weekday === undefined) {
        return new Date(o.start).getUTCFullYear() === year ? [o.start] : [];
    }
    const timeOfDay = o.start - Math.floor(o.start / DAY) * DAY;
    const local = nthWeekdayMs(year, o.month, o.weekday, o.nth, timeOfDay);
    return local >= o.start ? [local] : [];
}

function offsetAt(zone: ZoneRules, instant: number): number {
    const year = new Date(instant).getUTCFullYear();
    let best: { at: number; offset: number } | undefined;
    for (const o of zone) {
        for (const y of [year - 1, year, year + 1]) {
            for (const local of onsets(o, y)) {
                const at = local - o.offsetFrom * MIN;
                if (at <= instant && (best === undefined || at > best.at)) {
                    best = { at, offset: o.offsetTo };
                }
            }
        }
    }
    return best?.offset ?? zone[0]?.offsetFrom ?? 0;
}

/**
 * The instant of a local clock time. A time that occurs twice (the end of daylight time) is the
 * first occurrence (RFC 5545 section 3.3.5) unless `repeated` is `second`; a time that does not
 * exist (the start of daylight time) is read with the offset in force before the gap unless
 * `skipped` is `after-gap`.
 */
function localToInstant(zone: ZoneRules, local: number, repeated: 'first' | 'second' = 'first', skipped: 'before-gap' | 'after-gap' = 'before-gap'): number {
    const largestFirst = [...new Set(zone.flatMap((o) => [o.offsetTo, o.offsetFrom]))].toSorted((a, b) => b - a);
    const offsets = repeated === 'first' ? largestFirst : largestFirst.toReversed();
    for (const offset of offsets) {
        const instant = local - offset * MIN;
        if (offsetAt(zone, instant) === offset) {
            return instant;
        }
    }
    return local - (skipped === 'before-gap' ? (largestFirst.at(-1) ?? 0) : (largestFirst[0] ?? 0)) * MIN;
}

const US = (standard: number, daylight: number): ZoneRules => [
    { offsetFrom: standard, offsetTo: daylight, start: Date.UTC(2007, 2, 11, 2), month: 3, nth: 2, weekday: 0 },
    { offsetFrom: daylight, offsetTo: standard, start: Date.UTC(2007, 10, 4, 2), month: 11, nth: 1, weekday: 0 },
];

/** The fake's "tzdb": the zones it knows by name. */
export const BUILTIN_ZONES: Record<string, ZoneRules> = {
    'America/New_York': US(-300, -240),
    'America/Los_Angeles': US(-480, -420),
    'Europe/Berlin': [
        { offsetFrom: 60, offsetTo: 120, start: Date.UTC(1996, 2, 31, 2), month: 3, nth: -1, weekday: 0 },
        { offsetFrom: 120, offsetTo: 60, start: Date.UTC(1996, 9, 27, 3), month: 10, nth: -1, weekday: 0 },
    ],
};

function offsetMinutes(value: string | undefined): number {
    const match = /^([+-])(\d{2})(\d{2})/.exec(value ?? '');
    return match === null ? 0 : (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

export function zoneFromVtimezone(tz: IcalComponent): ZoneRules {
    const zone: ZoneRules = [];
    for (const block of [...comps(tz, 'STANDARD'), ...comps(tz, 'DAYLIGHT')]) {
        const start = parseDt(prop(block, 'DTSTART')?.value);
        if (start === undefined) {
            continue;
        }
        const rule = Object.fromEntries((prop(block, 'RRULE')?.value ?? '').split(';').map((p) => p.split('=') as [string, string]));
        const byday = /^(-?\d)([A-Z]{2})$/.exec(rule.BYDAY ?? '');
        const observance: Observance = { offsetFrom: offsetMinutes(prop(block, 'TZOFFSETFROM')?.value), offsetTo: offsetMinutes(prop(block, 'TZOFFSETTO')?.value), start };
        if (rule.FREQ === 'YEARLY' && rule.BYMONTH !== undefined && byday?.[1] !== undefined) {
            Object.assign(observance, { month: Number(rule.BYMONTH), nth: Number(byday[1]), weekday: WEEKDAYS.indexOf(byday[2] ?? '') });
        }
        zone.push(observance);
    }
    return zone;
}

export function embeddedZones(root: IcalComponent | undefined): Map<string, ZoneRules> {
    const zones = new Map<string, ZoneRules>();
    for (const tz of root === undefined ? [] : comps(root, 'VTIMEZONE')) {
        const id = prop(tz, 'TZID')?.value;
        if (id !== undefined) {
            zones.set(id, zoneFromVtimezone(tz));
        }
    }
    return zones;
}

function zoneFor(tzid: string, env: TimeEnv): ZoneRules | undefined {
    if (env.tzPolicy === 'ignore') {
        return undefined;
    }
    const builtin = BUILTIN_ZONES[tzid];
    const embedded = env.embedded.get(tzid);
    if (builtin !== undefined) {
        return env.tzPolicy === 'embedded-first' ? (embedded ?? builtin) : builtin;
    }
    switch (env.unknownTzid) {
        case 'use-embedded':
            return embedded;
        case 'as-new-york':
            return BUILTIN_ZONES['America/New_York'];
        case 'as-utc':
            return undefined;
    }
}

// ---- time points -----------------------------------------------------------------------

export interface TimePoint {
    kind: 'date' | 'utc' | 'tzid' | 'floating';
    /** Wall-clock value as UTC milliseconds (for kind utc this is the instant). */
    local: number;
    tzid?: string;
}

export function pointOf(p: IcalProperty | undefined): TimePoint | undefined {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(p?.value.trim() ?? '');
    if (p === undefined || match === null) {
        return undefined;
    }
    const [, y, mo, d, h, mi, s, z] = match;
    const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
    if (h === undefined || p.params.VALUE === 'DATE') {
        return { kind: 'date', local: Date.UTC(Number(y), Number(mo) - 1, Number(d)) };
    }
    if (z === 'Z') {
        return { kind: 'utc', local };
    }
    return p.params.TZID === undefined ? { kind: 'floating', local } : { kind: 'tzid', local, tzid: p.params.TZID };
}

export function instantOf(point: TimePoint, env: TimeEnv): number {
    switch (point.kind) {
        case 'utc':
            return point.local;
        case 'tzid': {
            const zone = zoneFor(point.tzid ?? '', env);
            return zone === undefined ? point.local : localToInstant(zone, point.local, env.repeatedHour, env.skippedHour);
        }
        default:
            return env.floating === undefined ? point.local : localToInstant(env.floating, point.local);
    }
}

// ---- occurrences -----------------------------------------------------------------------

export interface Occurrence {
    start: number;
    end: number;
    /** Instant of the instance this occurrence replaces or represents; null for a plain event. */
    recurrenceId: number | null;
    component: IcalComponent;
    startPoint: TimePoint;
    endPoint: TimePoint | undefined;
    ridPoint: TimePoint | undefined;
    /** What time-range filtering uses. */
    matchStart: number;
    matchEnd: number;
}

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function* localStarts(base: TimePoint, rule: Record<string, string>, env: TimeEnv): Generator<number> {
    const interval = Number(rule.INTERVAL ?? 1);
    if (rule.FREQ === 'YEARLY') {
        const d = new Date(base.local);
        const [year, month, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
        const timeOfDay = base.local - Date.UTC(year, month, day);
        for (let i = 0; ; i++) {
            const y = year + i * interval;
            if (month === 1 && day === 29 && !isLeap(y)) {
                if (env.feb29 === 'skip') {
                    continue;
                }
                yield (env.feb29 === 'clamp' ? Date.UTC(y, 1, 28) : Date.UTC(y, 2, 1)) + timeOfDay;
                continue;
            }
            yield Date.UTC(y, month, day) + timeOfDay;
        }
    }
    const step = (rule.FREQ === 'DAILY' ? DAY : 7 * DAY) * interval;
    for (let i = 0; ; i++) {
        yield base.local + i * step;
    }
}

function exdateInstants(master: IcalComponent, env: TimeEnv): Set<number> {
    const out = new Set<number>();
    for (const p of props(master, 'EXDATE')) {
        for (const value of p.value.split(',')) {
            const point = pointOf({ ...p, value });
            if (point !== undefined) {
                out.add(instantOf(point, env));
            }
        }
    }
    return out;
}

function eventLength(event: IcalComponent, startPoint: TimePoint, env: TimeEnv): { end: number; endPoint: TimePoint | undefined } {
    const endPoint = pointOf(prop(event, 'DTEND'));
    const start = instantOf(startPoint, env);
    if (endPoint !== undefined) {
        return { end: instantOf(endPoint, env), endPoint };
    }
    return { end: start + (durationMs(prop(event, 'DURATION')?.value) ?? (startPoint.kind === 'date' ? DAY : 0)), endPoint: undefined };
}

export function occurrences(resource: IcalComponent, limitEnd: number, env: TimeEnv): Occurrence[] {
    const events = [...comps(resource, 'VEVENT'), ...comps(resource, 'VTODO')];
    const master = events.find((e) => prop(e, 'RECURRENCE-ID') === undefined);
    const overrides = events.filter((e) => prop(e, 'RECURRENCE-ID') !== undefined);
    const result: Occurrence[] = [];
    const overriddenInstants = new Set(overrides.map((o) => {
        const rid = pointOf(prop(o, 'RECURRENCE-ID'));
        return rid === undefined ? undefined : instantOf(rid, env);
    }));
    let masterLength = 0;
    if (master !== undefined) {
        const base = pointOf(prop(master, 'DTSTART'));
        if (base !== undefined) {
            const first = eventLength(master, base, env);
            const baseStart = instantOf(base, env);
            masterLength = first.end - baseStart;
            const rule = prop(master, 'RRULE')?.value;
            if (rule === undefined) {
                result.push({ start: baseStart, end: first.end, recurrenceId: null, component: master, startPoint: base, endPoint: first.endPoint, ridPoint: undefined, matchStart: baseStart, matchEnd: first.end });
            } else {
                const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=') as [string, string]));
                const count = parts.COUNT === undefined ? Infinity : Number(parts.COUNT);
                const until = parseDt(parts.UNTIL) ?? Infinity;
                const exdates = exdateInstants(master, env);
                const future = env.thisAndFuture === 'applied' ? overrides.find((o) => prop(o, 'RECURRENCE-ID')?.params.RANGE === 'THISANDFUTURE') : undefined;
                const futureRid = future === undefined ? undefined : pointOf(prop(future, 'RECURRENCE-ID'));
                const futureStart = future === undefined ? undefined : pointOf(prop(future, 'DTSTART'));
                const shift = futureRid !== undefined && futureStart !== undefined ? instantOf(futureStart, env) - instantOf(futureRid, env) : 0;
                const endOffset = first.endPoint === undefined ? 0 : first.endPoint.local - base.local;
                let n = 0;
                for (const local of localStarts(base, parts, env)) {
                    if (n >= count || n >= 2000) {
                        break;
                    }
                    n++;
                    const startPoint: TimePoint = { ...base, local };
                    const start = instantOf(startPoint, env);
                    if (start > until || start >= limitEnd) {
                        break;
                    }
                    if (exdates.has(start) || overriddenInstants.has(start)) {
                        continue;
                    }
                    const moved = futureRid !== undefined && start > instantOf(futureRid, env) ? shift : 0;
                    const endPoint = first.endPoint === undefined ? undefined : { ...first.endPoint, local: local + endOffset };
                    const end = endPoint === undefined ? start + masterLength : instantOf(endPoint, env);
                    result.push({
                        start: start + moved, end: end + moved, recurrenceId: start, component: master, startPoint: { ...startPoint, local: local + moved },
                        endPoint: endPoint === undefined ? undefined : { ...endPoint, local: endPoint.local + moved }, ridPoint: startPoint, matchStart: start + moved, matchEnd: end + moved,
                    });
                }
            }
        }
    }
    for (const o of overrides) {
        const startPoint = pointOf(prop(o, 'DTSTART'));
        if (startPoint === undefined) {
            continue;
        }
        const start = instantOf(startPoint, env);
        const length = eventLength(o, startPoint, env);
        const ridPoint = pointOf(prop(o, 'RECURRENCE-ID'));
        const rid = ridPoint === undefined ? null : instantOf(ridPoint, env);
        const slot = env.overrideMatching === 'original-slot' && rid !== null;
        result.push({
            start, end: length.end, recurrenceId: rid, component: o, startPoint, endPoint: length.endPoint, ridPoint,
            matchStart: slot ? rid : start, matchEnd: slot ? rid + masterLength : length.end,
        });
    }
    return result;
}

export function overlaps(o: { matchStart: number; matchEnd: number }, start: number, end: number): boolean {
    return o.matchEnd > o.matchStart ? o.matchStart < end && o.matchEnd > start : o.matchStart >= start && o.matchStart < end;
}

// ---- serialisation and expansion --------------------------------------------------------

export function serialise(component: IcalComponent): string[] {
    const lines = [`BEGIN:${component.name}`];
    for (const p of component.properties) {
        lines.push(`${p.name}${Object.entries(p.params).map(([k, v]) => `;${k}=${v}`).join('')}:${p.value}`);
    }
    for (const inner of component.components) {
        lines.push(...serialise(inner));
    }
    lines.push(`END:${component.name}`);
    return lines;
}

function pointLine(name: string, point: TimePoint, instant: number, style: ExpandStyle): string {
    if (style === 'utc-all' || (style === 'date-as-utc' && point.kind === 'date')) {
        return `${name}:${utc(instant)}`;
    }
    switch (point.kind) {
        case 'date':
            return `${name};VALUE=DATE:${dateText(point.local)}`;
        case 'utc':
            return `${name}:${utc(point.local)}`;
        case 'tzid':
            return `${name};TZID=${point.tzid ?? ''}:${wall(point.local)}`;
        case 'floating':
            return `${name}:${wall(point.local)}`;
    }
}

const DROPPED = new Set(['RRULE', 'EXDATE', 'RDATE', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID']);

export function expandResource(ical: string, start: number, end: number, env: TimeEnv, options: ExpandOptions): string {
    const root = parseIcal(ical);
    if (root === undefined) {
        return ical;
    }
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fake//EN'];
    if (options.style === 'keep-forms' || options.style === 'date-as-utc') {
        for (const tz of comps(root, 'VTIMEZONE')) {
            lines.push(...serialise(tz));
        }
    }
    const byUid = Map.groupBy(comps(root, 'VEVENT'), (e) => prop(e, 'UID')?.value ?? '');
    const all = [...byUid.values()].flatMap((events) => occurrences({ ...root, components: [...comps(root, 'VTIMEZONE'), ...events] }, end, env));
    for (const occ of all) {
        const uid = prop(occ.component, 'UID')?.value ?? '';
        const recurring = (byUid.get(uid) ?? []).some((e) => prop(e, 'RRULE') !== undefined);
        if (!overlaps(occ, start, end)) {
            continue;
        }
        lines.push('BEGIN:VEVENT');
        for (const p of occ.component.properties) {
            if (!DROPPED.has(p.name)) {
                lines.push(`${p.name}${Object.entries(p.params).map(([k, v]) => `;${k}=${v}`).join('')}:${p.value}`);
            }
        }
        if (recurring && occ.recurrenceId !== null) {
            lines.push(pointLine('RECURRENCE-ID', occ.ridPoint ?? { kind: 'utc', local: occ.recurrenceId }, occ.recurrenceId, options.style));
        }
        lines.push(pointLine('DTSTART', occ.startPoint, occ.start, options.style));
        const duration = prop(occ.component, 'DURATION')?.value;
        if (occ.endPoint !== undefined) {
            lines.push(pointLine('DTEND', occ.endPoint, occ.end, options.style));
        } else if (duration !== undefined && options.keepDuration) {
            lines.push(`DURATION:${duration}`);
        } else {
            lines.push(pointLine('DTEND', { ...occ.startPoint, local: occ.startPoint.local + (occ.end - occ.start) }, occ.end, options.style));
        }
        lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
}

/** The resource with only the overrides that overlap the window kept (RFC 4791 limit-recurrence-set). */
export function limitRecurrenceSet(ical: string, start: number, end: number, env: TimeEnv): string {
    const root = parseIcal(ical);
    if (root === undefined) {
        return ical;
    }
    const keep = new Set(occurrences(root, end, env).filter((o) => o.recurrenceId !== null && overlaps(o, start, end)).map((o) => o.component));
    const limited: IcalComponent = {
        ...root,
        components: root.components.filter((c) => c.name !== 'VEVENT' || prop(c, 'RECURRENCE-ID') === undefined || keep.has(c)),
    };
    return `${serialise(limited).join('\r\n')}\r\n`;
}
