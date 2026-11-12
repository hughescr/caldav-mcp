/**
 * Write-mode evidence for the phase 2 read path. Every event here is written by the probe into
 * its own temporary calendar, so the values it records (dates, date-times, the forms that came
 * back) are the probe's own and may appear in the report. They still pass `dateShape`, which
 * lets only strictly shaped date and date-time text through. The calendar and its events are
 * removed by the write phase's cleanup, exactly like every other write check.
 */
import { CheckStop, isOk, isRefusal, type CheckContext, type CheckDef, type CheckOutput, type TempCalendar } from '../context';
import { calendarQueryBody, dav, eventComponents, getIcal, requireSynthetic } from '../dav';
import { comps, icalDate, icalLocal, icalUtc, parseIcal, prop, props, type IcalComponent } from '../ical';
import { compareInstances, dateShape, emptyKindCounts, kindOf } from '../ical-time';
import { prose, safeNames, sortedSafe } from '../safe';
import type { Evidence } from '../types';
import { toResources } from './queries';
import { DAY, HOUR, SUMMARY, baseDay, newEvent, primary, probeCalendar, putEvent, type PutResult } from './write-helpers';
import { CUSTOM_TZID, CUSTOM_ZONE, NEW_YORK, easternOffset, nextUsDstStart, parseUtc, parseWall, wallToInstant } from './zones';

export const PLAN = 'Phase 2 read path: expansion and time handling';

/** PUT that must succeed for the check to continue; a refusal is the result, with its status and preconditions. */
export async function putOrStop(ctx: CheckContext, url: string, body: string, evidence: Evidence): Promise<PutResult> {
    const put = await putEvent(ctx, url, body, { 'if-none-match': '*' });
    evidence.putStatus = put.status;
    if (!isOk(put.status)) {
        evidence.preconditions = safeNames(put.errorElements, ctx.taint);
        throw new CheckStop(isRefusal(put.status) ? 'refuted' : 'inconclusive', prose`The server did not accept the test event (HTTP ${put.status}).`, evidence);
    }
    return put;
}

export interface Expanded { status: number; returned: boolean; events: IcalComponent[]; vtimezones: number; etag?: string | null }

export function resourceOf(status: number, ical: IcalComponent | undefined): Expanded {
    return { status, returned: ical !== undefined, events: eventComponents(ical), vtimezones: ical === undefined ? 0 : comps(ical, 'VTIMEZONE').length };
}

async function expandedEvents(ctx: CheckContext, temp: TempCalendar, href: string, start: number, end: number): Promise<Map<string, Expanded>> {
    return windowResources(ctx, temp, [href], start, end, 'expand');
}

/**
 * One calendar-query REPORT over a window (expanded, or plain with the stored data, or without
 * data), with the resource of each of several hrefs picked out. Every resource that comes back
 * with data must carry the UID the probe authored for that href, or the check stops.
 */
export async function windowResources(ctx: CheckContext, temp: TempCalendar, hrefs: readonly string[], start: number, end: number, calendarData: 'expand' | 'full' | 'none'): Promise<Map<string, Expanded>> {
    const r = await dav(ctx, 'REPORT', temp.url, { depth: '1', body: calendarQueryBody({ start, end, calendarData }) });
    if (new URL(r.res.url).href !== new URL(temp.url).href) {
        throw new CheckStop('inconclusive', prose`The ${calendarData === 'expand' ? prose`expand` : prose`time-range`} response was outside the probe calendar.`, { status: r.res.status, provenanceVerified: false });
    }
    const resources = r.res.status === 207 ? toResources(r.ms, temp.url) : [];
    return new Map(hrefs.map((href) => {
        const matches = resources.filter((res) => res.href === href);
        if (matches.length > 1) {
            throw new CheckStop('inconclusive', prose`The query response contained ambiguous resources.`, { status: r.res.status, matchingResources: matches.length });
        }
        const root = matches[0]?.ical;
        if (matches.length > 0 && calendarData !== 'none') {
            // href is constructed by newEvent, never supplied by the server.
            const uid = new URL(href).pathname.split('/').at(-1)?.slice(0, -4) ?? '';
            requireSynthetic(root, href, temp.url, uid, r.res.status);
        }
        return [href, { ...resourceOf(r.res.status, root), returned: matches.length > 0, etag: matches[0]?.etag ?? null }];
    }));
}

export function kinds(events: readonly IcalComponent[], name: string): Record<string, number> {
    const counts = emptyKindCounts();
    for (const e of events) {
        counts[kindOf(prop(e, name))]++;
    }
    return counts;
}

export function values(events: readonly IcalComponent[], name: string): ReturnType<typeof sortedSafe> {
    return sortedSafe(events.flatMap((e) => {
        const p = prop(e, name);
        return p === undefined ? [] : [dateShape(p.value)];
    }));
}

/** The forms and the values of the expanded instances: kinds as counts, values as strict date shapes. */
export function describeEvents(events: readonly IcalComponent[]): Evidence {
    return {
        instancesReturned: events.length,
        dtstartKinds: kinds(events, 'DTSTART'),
        dtendKinds: kinds(events, 'DTEND'),
        recurrenceIdKinds: kinds(events, 'RECURRENCE-ID'),
        startValues: values(events, 'DTSTART'),
        endValues: values(events, 'DTEND'),
        recurrenceIdValues: values(events, 'RECURRENCE-ID'),
        rrulePresent: events.some((e) => prop(e, 'RRULE') !== undefined),
    };
}

function allKind(events: readonly IcalComponent[], name: string, kind: string): boolean {
    return events.length > 0 && events.every((e) => kindOf(prop(e, name)) === kind);
}

/** A status that is not 207, or a series that did not come back, ends a check without a verdict on the claim. */
function unanswered(evidence: Evidence, got: Expanded): CheckOutput | undefined {
    if (got.status !== 207) {
        return { outcome: isRefusal(got.status) ? 'refuted' : 'inconclusive', summary: prose`The expand query answered HTTP ${got.status}.`, evidence };
    }
    if (!got.returned || got.events.length === 0) {
        return { outcome: 'inconclusive', summary: prose`The series was not returned by the expand query.`, evidence };
    }
    return undefined;
}

interface Series { evidence: Evidence; got: Expanded; url: string }

async function putAndExpand(ctx: CheckContext, suffix: string, body: (uid: string) => string, start: number, end: number): Promise<Series> {
    const temp = primary(ctx);
    const { url, uid } = newEvent(temp, suffix);
    const evidence: Evidence = {};
    await putOrStop(ctx, url, body(uid), evidence);
    const got = (await expandedEvents(ctx, temp, url, start, end)).get(url) ?? resourceOf(0, undefined);
    Object.assign(evidence, { expandStatus: got.status, seriesReturned: got.returned }, describeEvents(got.events));
    return { evidence, got, url };
}

const startOf = (e: IcalComponent): string | undefined => prop(e, 'DTSTART')?.value;

/** Compare multisets, not membership in each independent column: duplicates and swapped RIDs matter. */
function tuplesMatch(events: readonly IcalComponent[], starts: readonly string[], ends: readonly string[]): boolean {
    const observed = events.map((e) => JSON.stringify(['DTSTART', 'DTEND', 'RECURRENCE-ID'].map((name) => prop(e, name)?.value ?? null))).toSorted();
    const expected = starts.map((start, i) => JSON.stringify([start, ends[i], start])).toSorted();
    return observed.length === expected.length && observed.every((tuple, i) => tuple === expected[i]);
}

export const expandDateCheck: CheckDef = {
    id: 'write-expand-date',
    planItem: `${PLAN}: all-day series`,
    claim: 'A weekly VALUE=DATE series (COUNT=4) is expanded into 4 instances whose DTSTART, DTEND and RECURRENCE-ID are still VALUE=DATE on the right days.',
    needs: 'temp',
    async run(ctx) {
        const first = baseDay(ctx) + 12 * DAY;
        const starts = [0, 1, 2, 3].map((k) => icalDate(first + 7 * k * DAY));
        const ends = starts.map((_, k) => icalDate(first + (7 * k + 1) * DAY));
        const { evidence, got } = await putAndExpand(ctx, 'wdate', (uid) => probeCalendar(ctx, uid, [
            `DTSTART;VALUE=DATE:${icalDate(first)}`, `DTEND;VALUE=DATE:${icalDate(first + DAY)}`, 'RRULE:FREQ=WEEKLY;COUNT=4', `SUMMARY:${SUMMARY}`,
        ]), first - DAY, first + 30 * DAY);
        const onStarts = got.events.filter((e) => starts.includes(startOf(e)?.slice(0, 8) ?? '')).length;
        const onEnds = got.events.filter((e) => ends.includes(prop(e, 'DTEND')?.value.slice(0, 8) ?? '')).length;
        Object.assign(evidence, { expectedStartDates: sortedSafe(starts.map(dateShape)), expectedEndDates: sortedSafe(ends.map(dateShape)), startsOnExpectedDates: onStarts, endsOnExpectedDates: onEnds });
        const stop = unanswered(evidence, got);
        if (stop !== undefined) {
            return stop;
        }
        const events = got.events;
        const kept = allKind(events, 'DTSTART', 'date') && allKind(events, 'DTEND', 'date') && allKind(events, 'RECURRENCE-ID', 'date');
        const exact = tuplesMatch(events, starts, ends);
        evidence.instanceTuplesMatch = exact;
        if (events.length === 4 && kept && exact && evidence.rrulePresent === false) {
            return { outcome: 'confirmed', summary: prose`4 instances, all VALUE=DATE, on the expected days.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`${events.length} instance(s); the forms or the days differ from the expected all-day series.`, evidence };
    },
};

export const expandFloatingCheck: CheckDef = {
    id: 'write-expand-floating',
    planItem: `${PLAN}: floating series`,
    claim: 'A weekly floating series (no TZID, no Z; COUNT=4) is expanded into 4 instances that are still floating, with the same wall-clock times.',
    needs: 'temp',
    async run(ctx) {
        const first = baseDay(ctx) + 13 * DAY + 10 * HOUR;
        const starts = [0, 1, 2, 3].map((k) => icalLocal(first + 7 * k * DAY));
        const { evidence, got } = await putAndExpand(ctx, 'wfloat', (uid) => probeCalendar(ctx, uid, [
            `DTSTART:${icalLocal(first)}`, `DTEND:${icalLocal(first + HOUR)}`, 'RRULE:FREQ=WEEKLY;COUNT=4', `SUMMARY:${SUMMARY}`,
        ]), first - DAY, first + 30 * DAY);
        const ends = [0, 1, 2, 3].map((k) => icalLocal(first + 7 * k * DAY + HOUR));
        const equal = got.events.filter((e) => starts.includes(startOf(e) ?? '')).length;
        const exact = tuplesMatch(got.events, starts, ends);
        Object.assign(evidence, { expectedStarts: sortedSafe(starts.map(dateShape)), expectedEnds: sortedSafe(ends.map(dateShape)), startsEqualSent: equal, instanceTuplesMatch: exact });
        const stop = unanswered(evidence, got);
        if (stop !== undefined) {
            return stop;
        }
        const events = got.events;
        if (events.length === 4 && exact && evidence.rrulePresent === false && allKind(events, 'DTSTART', 'floating') && allKind(events, 'DTEND', 'floating') && allKind(events, 'RECURRENCE-ID', 'floating')) {
            return { outcome: 'confirmed', summary: prose`4 instances, all floating, at the same wall-clock times.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`${events.length} instance(s); ${equal} kept the floating wall-clock time as sent.`, evidence };
    },
};

/** The instant of an expanded DTSTART, if it can be known: UTC as given, or a TZID value read with the zone's rules. */
function instantOfStart(event: IcalComponent, tzid: string, offsetOf: (wall: number) => number): number | undefined {
    const p = prop(event, 'DTSTART');
    const kind = kindOf(p);
    if (p === undefined) {
        return undefined;
    }
    if (kind === 'utc') {
        return parseUtc(p.value);
    }
    const wall = parseWall(p.value);
    return kind === 'tzid' && p.params.TZID === tzid && wall !== undefined ? wallToInstant(wall, offsetOf(wall)) : undefined;
}

export const expandTzidCheck: CheckDef = {
    id: 'write-expand-tzid-dst',
    planItem: `${PLAN}: TZID series with an embedded VTIMEZONE across a daylight-time change`,
    claim: 'A weekly TZID=America/New_York series with its VTIMEZONE, from the week before the March change (COUNT=4), is expanded into 4 instances at the expected instants (09:00 local every week).',
    needs: 'temp',
    async run(ctx) {
        const sunday = nextUsDstStart(baseDay(ctx), 7);
        const first = sunday - 7 * DAY + 9 * HOUR;
        const walls = [0, 1, 2, 3].map((k) => first + 7 * k * DAY);
        const expected = walls.map((w) => wallToInstant(w, easternOffset(w)));
        const { evidence, got } = await putAndExpand(ctx, 'wnytz', (uid) => probeCalendar(ctx, uid, [
            `DTSTART;TZID=America/New_York:${icalLocal(first)}`, `DTEND;TZID=America/New_York:${icalLocal(first + HOUR)}`, 'RRULE:FREQ=WEEKLY;COUNT=4', `SUMMARY:${SUMMARY}`,
        ], { vtimezone: NEW_YORK }), first - DAY, first + 30 * DAY);
        const instants = got.events.map((e) => instantOfStart(e, 'America/New_York', easternOffset));
        const matches = Object.fromEntries(expected.map((instant, k) => [`instance${k}`, instants.includes(instant)]));
        const all = Object.values(matches).every(Boolean) && got.events.length === 4;
        Object.assign(evidence, {
            expectedInstants: sortedSafe(expected.map((ms) => dateShape(icalUtc(ms)))), instantMatches: matches, allInstantsMatch: all, vtimezoneComponentsReturned: got.vtimezones,
        });
        const stop = unanswered(evidence, got);
        if (stop !== undefined) {
            return stop;
        }
        return all
            ? { outcome: 'confirmed', summary: prose`All 4 instances are at the expected instants, across the daylight-time change.`, evidence }
            : { outcome: 'refuted', summary: prose`${Object.values(matches).filter(Boolean).length} of 4 expected instants were returned (${got.events.length} instance(s)).`, evidence };
    },
};

function sameTree(a: IcalComponent | undefined, b: IcalComponent | undefined): boolean {
    if (a === undefined || b === undefined || a.name !== b.name || a.properties.length !== b.properties.length || a.components.length !== b.components.length) {
        return false;
    }
    const flat = (c: IcalComponent): string[] => c.properties.map((p) => `${p.name};${Object.entries(p.params).toSorted().join(',')}:${p.value}`).toSorted();
    return flat(a).join('\n') === flat(b).join('\n') && a.components.every((inner, i) => sameTree(inner, b.components[i]));
}

export const customTzidCheck: CheckDef = {
    id: 'write-custom-tzid',
    planItem: `${PLAN}: a custom TZID whose rules disagree with tzdb`,
    claim: 'A series in a custom TZID (Probe/Custom) with an embedded VTIMEZONE using the pre-2007 US rules is accepted, the VTIMEZONE is stored unchanged, and expansion uses those embedded rules, not tzdb’s.',
    needs: 'temp',
    async run(ctx) {
        const monday = nextUsDstStart(baseDay(ctx), 7) + DAY;
        const first = monday + 9 * HOUR;
        const walls = [0, 1, 2].map((k) => first + 7 * k * DAY);
        // Between the second Sunday of March and the first Sunday of April the two rule sets differ by an hour.
        const embedded = walls.map((w) => wallToInstant(w, -300));
        const tzdb = walls.map((w) => wallToInstant(w, -240));
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'wcustom');
        const sent = probeCalendar(ctx, uid, [
            `DTSTART;TZID=${CUSTOM_TZID}:${icalLocal(first)}`, `DTEND;TZID=${CUSTOM_TZID}:${icalLocal(first + HOUR)}`, 'RRULE:FREQ=WEEKLY;COUNT=3', `SUMMARY:${SUMMARY}`,
        ], { vtimezone: CUSTOM_ZONE });
        const evidence: Evidence = {};
        await putOrStop(ctx, url, sent, evidence);
        const stored = await getIcal(ctx, url);
        if (stored.status === 200) {
            requireSynthetic(stored.ical, stored.url, temp.url, uid, stored.status);
        }
        const zoneOf = (root: IcalComponent | undefined): IcalComponent | undefined => (root === undefined ? undefined : comps(root, 'VTIMEZONE').find((z) => prop(z, 'TZID')?.value === CUSTOM_TZID));
        const sentZone = zoneOf(parseIcal(sent));
        const gotZone = zoneOf(stored.ical);
        const rules = (z: IcalComponent | undefined): IcalComponent[] => z?.components ?? [];
        const preserved = sameTree(sentZone, gotZone);
        const rulesPreserved = rules(sentZone).length > 0 && rules(sentZone).length === rules(gotZone).length && rules(sentZone).every((r, i) => sameTree(r, rules(gotZone)[i]));
        Object.assign(evidence, { readBackStatus: stored.status, vtimezonePreserved: preserved, vtimezoneRulesPreserved: rulesPreserved });
        const got = (await expandedEvents(ctx, temp, url, first - DAY, first + 21 * DAY)).get(url) ?? resourceOf(0, undefined);
        const observed = got.events.map((e) => {
            const p = prop(e, 'DTSTART');
            return kindOf(p) === 'utc' ? parseUtc(p?.value) : undefined;
        }).filter((v): v is number => v !== undefined);
        const onEmbedded = observed.filter((v) => embedded.includes(v)).length;
        const onTzdb = observed.filter((v) => tzdb.includes(v)).length;
        Object.assign(evidence, {
            expandStatus: got.status, seriesReturned: got.returned, ...describeEvents(got.events),
            expectedEmbeddedInstants: sortedSafe(embedded.map((ms) => dateShape(icalUtc(ms)))), expectedTzdbInstants: sortedSafe(tzdb.map((ms) => dateShape(icalUtc(ms)))),
            instancesObservable: observed.length, instancesMatchingEmbedded: onEmbedded, instancesMatchingTzdb: onTzdb, instancesMatchingNeither: observed.length - onEmbedded - onTzdb,
        });
        if (!preserved) {
            return { outcome: 'refuted', summary: prose`The custom VTIMEZONE was ${stored.status === 200 ? prose`changed or dropped` : prose`not readable back (HTTP ${stored.status})`} by the server.`, evidence };
        }
        const stop = unanswered(evidence, got);
        if (stop !== undefined) {
            return stop;
        }
        if (observed.length === 0) {
            return { outcome: 'inconclusive', summary: prose`Expansion did not return UTC values, so the rules it used cannot be seen.`, evidence };
        }
        const exact = compareInstances(got.events, embedded.map((ms) => ({ start: icalUtc(ms), rid: icalUtc(ms), ends: [icalUtc(ms + HOUR)] }))).full;
        evidence.instanceTuplesMatch = exact;
        if (exact && observed.length === got.events.length) {
            return { outcome: 'confirmed', summary: prose`The VTIMEZONE was kept and all ${observed.length} instance(s) follow its rules.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`Of ${observed.length} instance(s), ${onEmbedded} follow the embedded rules and ${onTzdb} the tzdb answer.`, evidence };
    },
};

export const feb29Check: CheckDef = {
    id: 'write-feb29',
    planItem: `${PLAN}: a yearly series on February 29`,
    claim: 'A yearly VALUE=DATE series starting 2028-02-29 with COUNT=3, expanded over 2028-01-01 to 2037-01-01, returns exactly 2028-02-29, 2032-02-29 and 2036-02-29.',
    needs: 'temp',
    async run(ctx) {
        const expected = ['20280229', '20320229', '20360229'];
        const { evidence, got } = await putAndExpand(ctx, 'wfeb29', (uid) => probeCalendar(ctx, uid, [
            'DTSTART;VALUE=DATE:20280229', 'DTEND;VALUE=DATE:20280301', 'RRULE:FREQ=YEARLY;COUNT=3', `SUMMARY:${SUMMARY}`,
        ]), Date.UTC(2028, 0, 1), Date.UTC(2037, 0, 1));
        const dates = got.events.map((e) => startOf(e)?.slice(0, 8) ?? '').toSorted();
        const matches = dates.length === 3 && dates.every((d, i) => d === expected[i]);
        Object.assign(evidence, { expectedDates: sortedSafe(expected.map(dateShape)), datesMatchRfc: matches });
        const stop = unanswered(evidence, got);
        if (stop !== undefined) {
            return stop;
        }
        return matches
            ? { outcome: 'confirmed', summary: prose`The three leap-day instances were returned.`, evidence }
            : { outcome: 'refuted', summary: prose`${got.events.length} instance(s) returned; they are not the three leap days.`, evidence };
    },
};

export const floatingTimeRangeCheck: CheckDef = {
    id: 'write-floating-time-range',
    planItem: `${PLAN}: floating and DATE values against UTC time-range boundaries`,
    claim: 'A time-range query reads floating and DATE values in the collection’s calendar-timezone (America/Los_Angeles, set by the probe), not in UTC.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const day = baseDay(ctx) + 40 * DAY;
        const floating = newEvent(temp, 'wfloatq');
        const dated = newEvent(temp, 'wdateq');
        const evidence: Evidence = { calendarTimezoneKept: temp.calendarTimezoneKept === true };
        await putOrStop(ctx, floating.url, probeCalendar(ctx, floating.uid, [`DTSTART:${icalLocal(day + 23 * HOUR + HOUR / 2)}`, `DTEND:${icalLocal(day + 23 * HOUR + 59 * 60_000)}`, `SUMMARY:${SUMMARY}`]), evidence);
        await putOrStop(ctx, dated.url, probeCalendar(ctx, dated.uid, [`DTSTART;VALUE=DATE:${icalDate(day)}`, `DTEND;VALUE=DATE:${icalDate(day + DAY)}`, `SUMMARY:${SUMMARY}`]), evidence);
        // Windows chosen so that UTC and America/Los_Angeles (UTC-8 or UTC-7) readings give different answers.
        const windows = {
            lateUtc: [day + 22 * HOUR, day + 24 * HOUR],
            lateLocal: [day + 24 * HOUR, day + 36 * HOUR],
            earlyUtc: [day - 12 * HOUR, day + 4 * HOUR],
            earlyLocal: [day + 26 * HOUR, day + 30 * HOUR],
        } as const;
        const statuses: Record<string, number> = {};
        const found: Record<string, string[]> = {};
        for (const [name, [start, end]] of Object.entries(windows)) {
            const r = await dav(ctx, 'REPORT', temp.url, { depth: '1', body: calendarQueryBody({ start: start ?? 0, end: end ?? 0, calendarData: 'none' }) });
            statuses[name] = r.res.status;
            found[name] = toResources(r.ms, temp.url).map((res) => res.href);
        }
        const inWindow = (name: string, href: string): boolean => found[name]?.includes(href) === true;
        const flags = {
            floatingInLateUtcWindow: inWindow('lateUtc', floating.url), floatingInLateLocalWindow: inWindow('lateLocal', floating.url),
            dateInEarlyUtcWindow: inWindow('earlyUtc', dated.url), dateInEarlyLocalWindow: inWindow('earlyLocal', dated.url),
        };
        const derived = {
            floatingUsesUtc: flags.floatingInLateUtcWindow && !flags.floatingInLateLocalWindow,
            floatingUsesCalendarTimezone: !flags.floatingInLateUtcWindow && flags.floatingInLateLocalWindow,
            dateUsesUtc: flags.dateInEarlyUtcWindow && !flags.dateInEarlyLocalWindow,
            dateUsesCalendarTimezone: !flags.dateInEarlyUtcWindow && flags.dateInEarlyLocalWindow,
        };
        Object.assign(evidence, { windowStatuses: statuses, ...flags, ...derived });
        if (Object.values(statuses).some((s) => s !== 207)) {
            return { outcome: 'inconclusive', summary: prose`A time-range query did not answer HTTP 207.`, evidence };
        }
        if (temp.calendarTimezoneKept !== true) {
            return { outcome: 'inconclusive', summary: prose`The server did not keep the calendar-timezone, so the reading cannot be attributed to it (the answers are recorded).`, evidence };
        }
        if (derived.floatingUsesCalendarTimezone && derived.dateUsesCalendarTimezone) {
            return { outcome: 'confirmed', summary: prose`Floating and DATE values were read in the calendar-timezone.`, evidence };
        }
        if (derived.floatingUsesUtc || derived.dateUsesUtc) {
            return { outcome: 'refuted', summary: prose`Floating or DATE values were read in UTC.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The windows did not separate a UTC reading from a calendar-timezone reading.`, evidence };
    },
};

export const dateZeroLengthCheck: CheckDef = {
    id: 'write-date-zero-length',
    planItem: `${PLAN}: a VALUE=DATE event whose DTEND equals its DTSTART`,
    claim: 'A VALUE=DATE event with DTEND equal to DTSTART is accepted and read back unchanged.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const day = baseDay(ctx) + 45 * DAY;
        const { url, uid } = newEvent(temp, 'wdatezl');
        const evidence: Evidence = {};
        await putOrStop(ctx, url, probeCalendar(ctx, uid, [`DTSTART;VALUE=DATE:${icalDate(day)}`, `DTEND;VALUE=DATE:${icalDate(day)}`, `SUMMARY:${SUMMARY}`]), evidence);
        const stored = await getIcal(ctx, url);
        if (stored.status === 200) {
            requireSynthetic(stored.ical, stored.url, temp.url, uid, stored.status);
        }
        const event = eventComponents(stored.ical)[0];
        const end = event === undefined ? undefined : prop(event, 'DTEND')?.value;
        const equal = end === icalDate(day);
        const kept = event !== undefined && eventComponents(stored.ical).length === 1 && startOf(event) === icalDate(day) && equal && kindOf(prop(event, 'DTSTART')) === 'date' && kindOf(prop(event, 'DTEND')) === 'date';
        Object.assign(evidence, {
            readBackStatus: stored.status, readBackDtstartValue: dateShape(event === undefined ? undefined : prop(event, 'DTSTART')?.value), readBackDtendValue: dateShape(end), readBackDtendEqualsSent: equal,
        });
        const got = (await expandedEvents(ctx, temp, url, day - DAY, day + 2 * DAY)).get(url) ?? resourceOf(0, undefined);
        Object.assign(evidence, { expandStatus: got.status, seriesReturned: got.returned, ...describeEvents(got.events) });
        if (stored.status !== 200) {
            return { outcome: 'inconclusive', summary: prose`The accepted event could not be read back (HTTP ${stored.status}).`, evidence };
        }
        evidence.bothEndpointsPreserved = kept;
        return kept
            ? { outcome: 'confirmed', summary: prose`The event was accepted and read back with DTEND equal to DTSTART.`, evidence }
            : { outcome: 'refuted', summary: prose`The event was accepted but DTEND was changed or removed on read-back.`, evidence };
    },
};

const SHIFT = 2 * HOUR;

export const rangeThisAndFutureCheck: CheckDef = {
    id: 'write-range-thisandfuture',
    planItem: `${PLAN}: RECURRENCE-ID;RANGE=THISANDFUTURE`,
    claim: 'A weekly series with an override carrying RECURRENCE-ID;RANGE=THISANDFUTURE is accepted and read back with the RANGE parameter intact.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const start = baseDay(ctx) + 16 * DAY + 10 * HOUR;
        const { url, uid } = newEvent(temp, 'wrange');
        const evidence: Evidence = {};
        await putOrStop(ctx, url, probeCalendar(ctx, uid, [`DTSTART:${icalUtc(start)}`, `DTEND:${icalUtc(start + HOUR)}`, 'RRULE:FREQ=WEEKLY;COUNT=4', `SUMMARY:${SUMMARY}`], {
            overrides: [[`RECURRENCE-ID;RANGE=THISANDFUTURE:${icalUtc(start + 7 * DAY)}`, `DTSTART:${icalUtc(start + 7 * DAY + SHIFT)}`, `DTEND:${icalUtc(start + 7 * DAY + SHIFT + HOUR)}`, `SUMMARY:${SUMMARY}`]],
        }), evidence);
        const stored = await getIcal(ctx, url);
        if (stored.status === 200) {
            requireSynthetic(stored.ical, stored.url, temp.url, uid, stored.status);
        }
        const storedEvents = eventComponents(stored.ical);
        const withRange = storedEvents.flatMap((e) => props(e, 'RECURRENCE-ID')).filter((p) => p.params.RANGE !== undefined).length;
        const got = (await expandedEvents(ctx, temp, url, start - DAY, start + 30 * DAY)).get(url) ?? resourceOf(0, undefined);
        const shifted = got.events.filter((e) => {
            const [s, r] = [parseUtc(startOf(e)), parseUtc(prop(e, 'RECURRENCE-ID')?.value)];
            return s !== undefined && r !== undefined && s - r === SHIFT;
        }).length;
        Object.assign(evidence, {
            readBackStatus: stored.status, rangeOnReadBack: withRange, overridesOnReadBack: storedEvents.filter((e) => prop(e, 'RECURRENCE-ID') !== undefined).length,
            expandStatus: got.status, seriesReturned: got.returned, ...describeEvents(got.events), shiftedInstances: shifted, appliesToFollowingInstances: shifted === 3,
        });
        if (stored.status !== 200) {
            return { outcome: 'inconclusive', summary: prose`The accepted series could not be read back (HTTP ${stored.status}).`, evidence };
        }
        const rangeKept = withRange === 1 && storedEvents.flatMap((e) => props(e, 'RECURRENCE-ID')).filter((p) => p.params.RANGE?.toUpperCase() === 'THISANDFUTURE').length === 1;
        evidence.rangeValuePreserved = rangeKept;
        return rangeKept
            ? { outcome: 'confirmed', summary: prose`The series was accepted and the RANGE parameter was kept (${shifted} shifted instance(s) in the expansion).`, evidence }
            : { outcome: 'refuted', summary: prose`The series was accepted but the RANGE parameter was dropped or changed.`, evidence };
    },
};

export const EXPANSION_WRITE_CHECKS: CheckDef[] = [
    expandDateCheck, expandFloatingCheck, expandTzidCheck, customTzidCheck, feb29Check,
    floatingTimeRangeCheck, dateZeroLengthCheck, rangeThisAndFutureCheck,
];
