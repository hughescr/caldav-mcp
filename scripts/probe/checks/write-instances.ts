/**
 * Instance tuples (DTSTART, DTEND, RECURRENCE-ID) of the events the probe wrote itself, and the
 * exact comparison of what came back with what a correct server returns. A value is published
 * (as an `AuthoredValue`) only from events of a resource whose URL and every VEVENT UID were
 * validated by `requireSynthetic`: callers hand this module events taken from the results of
 * `windowResources` or `readStored`, which fail closed otherwise.
 */
import type { CheckContext, TempCalendar } from '../context';
import { eventComponents, getIcal, requireSynthetic } from '../dav';
import { comps, prop, type IcalComponent } from '../ical';
import { dateShape, instanceOf, kindOf, type Instance } from '../ical-time';
export { compareInstances, instanceOf, type Expected } from '../ical-time';
import { AuthoredValue, fixed } from '../safe';
import type { Evidence } from '../types';
import { windowResources, type Expanded } from './write-expansion';

const SHAPE = /^\d{8}(T\d{6}Z?)?$/;

const part = (value: string | null): string => (value === null ? '-' : SHAPE.test(value) ? value : '<other>');
const keyOf = (i: Instance): string => `${i.start ?? '-'}|${i.rid ?? '-'}|${i.end ?? '-'}`;

/** One tuple as authored text, `DTSTART/DTEND/RECURRENCE-ID` with `-` for an absent property; duplicates are kept. */
export function tuples(events: readonly IcalComponent[]): AuthoredValue[] {
    return events.map(instanceOf).map((i) => `${part(i.start)}/${part(i.end)}/${part(i.rid)}`).toSorted().map((text) => new AuthoredValue(fixed(text)));
}

/** True when every instance is UTC (and has a UTC RECURRENCE-ID if it has one), so its instants can be read. */
export function readableInstants(events: readonly IcalComponent[]): boolean {
    return events.length > 0 && events.every((e) => kindOf(prop(e, 'DTSTART')) === 'utc' && ['none', 'utc'].includes(kindOf(prop(e, 'RECURRENCE-ID'))));
}

const unique = (instances: readonly Instance[]): number => new Set(instances.map(keyOf)).size;

/** The count, the forms and the tuples of the instances in one result, under evidence keys that start with `prefix`. */
export function describeResult(prefix: string, got: Expanded | undefined): Evidence {
    const events = got?.events ?? [];
    const kindCounts = (name: string): Record<string, number> => {
        const counts: Record<string, number> = {};
        for (const e of events) {
            const kind = kindOf(prop(e, name));
            counts[kind] = (counts[kind] ?? 0) + 1;
        }
        return counts;
    };
    return {
        [`${prefix}Status`]: got?.status ?? 0,
        [`${prefix}Returned`]: got?.returned ?? false,
        [`${prefix}Count`]: events.length,
        [`${prefix}DistinctCount`]: unique(events.map(instanceOf)),
        [`${prefix}DtstartKinds`]: kindCounts('DTSTART'),
        [`${prefix}DtendKinds`]: kindCounts('DTEND'),
        [`${prefix}RecurrenceIdKinds`]: kindCounts('RECURRENCE-ID'),
        [`${prefix}Tuples`]: tuples(events),
    };
}

export interface Stored { status: number; events: IcalComponent[]; vtimezones: number }

/** GET of the resource the probe wrote; a 200 must carry exactly the probe's UID or the check stops. */
export async function readStored(ctx: CheckContext, temp: TempCalendar, url: string, uid: string): Promise<Stored> {
    const stored = await getIcal(ctx, url);
    if (stored.status === 200) {
        requireSynthetic(stored.ical, stored.url, temp.url, uid, stored.status);
    }
    return { status: stored.status, events: eventComponents(stored.ical), vtimezones: stored.ical === undefined ? 0 : comps(stored.ical, 'VTIMEZONE').length };
}

/** The stored forms of the event as read back: forms as enums, values as strict date shapes, and whether the TZID is still the one sent (never the TZID itself). */
export function describeStored(prefix: string, stored: Stored, sentTzid: string | null): Evidence {
    const first = stored.events.find((e) => prop(e, 'RECURRENCE-ID') === undefined);
    const start = first === undefined ? undefined : prop(first, 'DTSTART');
    const end = first === undefined ? undefined : prop(first, 'DTEND');
    return {
        [`${prefix}ReadBackStatus`]: stored.status,
        [`${prefix}StoredVevents`]: stored.events.length,
        // Forms are keys, never values: the second redaction layer rewrites a value that happens to contain account text.
        [`${prefix}StoredDtstartKinds`]: { [kindOf(start)]: 1 },
        [`${prefix}StoredDtendKinds`]: { [kindOf(end)]: 1 },
        [`${prefix}StoredDtstart`]: dateShape(start?.value),
        [`${prefix}StoredDtend`]: dateShape(end?.value),
        [`${prefix}StoredTzidKept`]: sentTzid !== null && start?.params.TZID === sentTzid && end?.params.TZID === sentTzid,
        [`${prefix}StoredRrulePresent`]: first !== undefined && prop(first, 'RRULE') !== undefined,
        [`${prefix}StoredVtimezones`]: stored.vtimezones,
    };
}

/** One time-range query without data: which of the hrefs it selected (undefined for each when the server did not answer 207). */
export async function selectedIn(ctx: CheckContext, temp: TempCalendar, hrefs: readonly string[], start: number, end: number): Promise<{ status: number; selected: Map<string, boolean | undefined> }> {
    const got = await windowResources(ctx, temp, hrefs, start, end, 'none');
    const status = [...got.values()][0]?.status ?? 0;
    return { status, selected: new Map(hrefs.map((href) => [href, status === 207 ? got.get(href)?.returned === true : undefined])) };
}
