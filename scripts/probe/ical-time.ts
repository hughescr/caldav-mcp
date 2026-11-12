/**
 * The form of an iCalendar date or date-time value, and the few strictly shaped values the
 * probe may record. From the owner's own data only the form (an enum) and counts are ever
 * recorded; the values are recorded only for events the probe itself wrote.
 */
import { prop, type IcalComponent, type IcalProperty } from './ical';
import { AuthoredValue, fixed, type Safe } from './safe';

/** utc: DATE-TIME ending in Z. tzid: DATE-TIME with a TZID parameter. date: VALUE=DATE. floating: DATE-TIME with neither. */
export type TimeKind = 'utc' | 'tzid' | 'date' | 'floating';
export type KindOrNone = TimeKind | 'none' | 'invalid';

export const KIND_NAMES: readonly KindOrNone[] = ['utc', 'tzid', 'date', 'floating', 'none', 'invalid'];

/** Declaration and lexical validity are independent: eight digits alone do not declare DATE. */
export function isDateValue(p: IcalProperty): boolean {
    return p.params.VALUE?.toUpperCase() === 'DATE';
}

export function timeValidity(p: IcalProperty): { valid: boolean; mismatched: boolean } {
    const date = /^\d{8}$/.test(p.value);
    const datetime = /^\d{8}T\d{6}Z?$/i.test(p.value);
    const declaration = p.params.VALUE?.toUpperCase() ?? 'DATE-TIME';
    const mismatched = (date && declaration !== 'DATE') || (datetime && declaration !== 'DATE-TIME');
    return { valid: !mismatched && (declaration === 'DATE' ? date : declaration === 'DATE-TIME' && datetime), mismatched };
}

export function kindOf(p: IcalProperty | undefined): KindOrNone {
    if (p === undefined) {
        return 'none';
    }
    if (!timeValidity(p).valid) {
        return 'invalid';
    }
    if (isDateValue(p)) {
        return 'date';
    }
    if (p.value.toUpperCase().endsWith('Z')) {
        return 'utc';
    }
    return p.params.TZID === undefined ? 'floating' : 'tzid';
}

export function emptyKindCounts(): Record<KindOrNone, number> {
    return { utc: 0, tzid: 0, date: 0, floating: 0, none: 0, invalid: 0 };
}

const SHAPE = /^\d{8}(T\d{6}Z?)?$/;
const NONE = fixed('<none>');
const OTHER = fixed('<other>');

/**
 * A date or date-time value of a probe-authored event, as the server returned it. Anything
 * that is not exactly 8 digits, or 8 digits, T, 6 digits and an optional Z becomes `<other>`.
 */
export function dateShape(value: string | undefined): Safe | AuthoredValue {
    if (value === undefined) {
        return NONE;
    }
    return SHAPE.test(value) ? new AuthoredValue(fixed(value)) : OTHER;
}

export interface Instance { start: string | null; end: string | null; rid: string | null }

export function instanceOf(event: IcalComponent): Instance {
    return { start: prop(event, 'DTSTART')?.value ?? null, end: prop(event, 'DTEND')?.value ?? null, rid: prop(event, 'RECURRENCE-ID')?.value ?? null };
}

/** Expected authored tuple; more than one end may be valid at a clock change. */
export interface Expected { start: string; rid: string | null; ends: readonly string[] }
export interface Match { starts: boolean; full: boolean }

/** Compare full multisets, preserving cardinality and DTSTART/RECURRENCE-ID pairing. */
export function compareInstances(events: readonly IcalComponent[], expected: readonly Expected[]): Match {
    const byStartAndRid = (a: Pick<Instance, 'start' | 'rid'>, b: Pick<Instance, 'start' | 'rid'>): number => {
        const [x, y] = [`${a.start ?? '-'}|${a.rid ?? '-'}`, `${b.start ?? '-'}|${b.rid ?? '-'}`];
        return x < y ? -1 : x > y ? 1 : 0;
    };
    const observed = events.map(instanceOf).toSorted(byStartAndRid);
    const wanted = expected.toSorted(byStartAndRid);
    const starts = observed.length === wanted.length && observed.every((o, i) => o.start === wanted[i]?.start && o.rid === wanted[i]?.rid);
    return { starts, full: starts && observed.every((o, i) => o.end !== null && wanted[i]?.ends.includes(o.end) === true) };
}

export type TzidClass = 'windows' | 'mozilla' | 'other';

/** Only the class of an unresolvable TZID is ever recorded, never the TZID itself. */
export function classifyTzid(tzid: string): TzidClass {
    if (/^\/mozilla\.org\//i.test(tzid)) {
        return 'mozilla';
    }
    if (/standard time$/i.test(tzid) || /^\(UTC[+-]\d{2}:\d{2}\)/i.test(tzid) || /^customized time zone$/i.test(tzid) || /^tzone:\/\/microsoft\//i.test(tzid)) {
        return 'windows';
    }
    return 'other';
}
