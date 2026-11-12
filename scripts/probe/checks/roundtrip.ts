import { CheckStop, type CheckContext, type CheckDef, type RoundTripDiff } from '../context';
import { getIcal, requireSynthetic } from '../dav';
import { comps, icalDate, icalLocal, icalUtc, parseIcal, prop, type IcalComponent, type IcalProperty } from '../ical';
import { prose, safeNames, type Prose } from '../safe';
import type { Evidence } from '../types';
import { DAY, HOUR, SUMMARY, baseDay, createOrStop, newEvent, primary, probeCalendar } from './write-helpers';
import { NEW_YORK } from './zones';

function serialise(p: IcalProperty): string {
    const params = Object.entries(p.params).toSorted(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(';');
    return `${params}:${p.value}`;
}

function grouped(component: IcalComponent | undefined): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const p of component?.properties ?? []) {
        map.set(p.name, [...(map.get(p.name) ?? []), serialise(p)].toSorted());
    }
    return map;
}

function master(cal: IcalComponent | undefined): IcalComponent | undefined {
    return cal === undefined ? undefined : comps(cal, 'VEVENT').find((e) => prop(e, 'RECURRENCE-ID') === undefined);
}

export function diffEvents(id: string, sent: IcalComponent | undefined, got: IcalComponent | undefined): RoundTripDiff {
    const a = grouped(master(sent));
    const b = grouped(master(got));
    const changed: string[] = [];
    const removed: string[] = [];
    const added: string[] = [];
    for (const [name, values] of a) {
        const other = b.get(name);
        if (other === undefined) {
            removed.push(name);
        } else if (other.join('\n') !== values.join('\n')) {
            changed.push(name);
        }
    }
    for (const name of b.keys()) {
        if (!a.has(name)) {
            added.push(name);
        }
    }
    return {
        id,
        changed,
        removed,
        added,
        prodidChanged: (sent === undefined ? undefined : prop(sent, 'PRODID')?.value) !== (got === undefined ? undefined : prop(got, 'PRODID')?.value),
        dtstampChanged: changed.includes('DTSTAMP'),
        sequenceChanged: changed.includes('SEQUENCE') || added.includes('SEQUENCE'),
    };
}

interface Trip { sent: IcalComponent | undefined; got: IcalComponent | undefined; diff: RoundTripDiff; evidence: Evidence }

async function roundTrip(ctx: CheckContext, id: string, suffix: string, build: (uid: string) => string): Promise<Trip> {
    const temp = primary(ctx);
    const { url, uid } = newEvent(temp, suffix);
    const text = build(uid);
    const evidence: Evidence = {};
    await createOrStop(ctx, url, text, evidence);
    const stored = await getIcal(ctx, url);
    evidence.getStatus = stored.status;
    if (stored.ical === undefined) {
        throw new CheckStop('inconclusive', prose`The stored event could not be read back (HTTP ${stored.status}).`, evidence);
    }
    requireSynthetic(stored.ical, stored.url, temp.url, uid, stored.status);
    const sent = parseIcal(text);
    const diff = diffEvents(id, sent, stored.ical);
    ctx.state.roundTrips.push(diff);
    Object.assign(evidence, { changedProperties: safeNames(diff.changed, ctx.taint), removedProperties: safeNames(diff.removed, ctx.taint), addedProperties: safeNames(diff.added, ctx.taint) });
    return { sent, got: stored.ical, diff, evidence };
}

function same(trip: Trip, name: string): boolean {
    const a = master(trip.sent);
    const b = master(trip.got);
    const pa = a === undefined ? undefined : prop(a, name);
    const pb = b === undefined ? undefined : prop(b, name);
    return pa !== undefined && pb !== undefined && serialise(pa) === serialise(pb);
}

function vtimezones(cal: IcalComponent | undefined): string[] {
    return cal === undefined ? [] : comps(cal, 'VTIMEZONE').map((tz) => prop(tz, 'TZID')?.value ?? '');
}

function startEndOutcome(trip: Trip, label: Prose): { outcome: 'confirmed' | 'refuted'; summary: Prose; evidence: Evidence } {
    const dtstart = same(trip, 'DTSTART');
    const dtend = same(trip, 'DTEND');
    const evidence = { ...trip.evidence, dtstartPreserved: dtstart, dtendPreserved: dtend };
    return dtstart && dtend
        ? { outcome: 'confirmed', summary: prose`${label}: DTSTART and DTEND came back unchanged.`, evidence }
        : { outcome: 'refuted', summary: prose`${label}: DTSTART or DTEND was changed by the server.`, evidence };
}

const DATETIME = 'Datetime rules';

function at(ctx: CheckContext, day: number): number {
    return baseDay(ctx) + day * DAY + 10 * HOUR;
}

export const roundTripChecks: CheckDef[] = [
    {
        id: 'roundtrip-tzid-with-vtimezone',
        planItem: `${DATETIME} 6: an embedded VTIMEZONE is preferred when present`,
        claim: 'An event with TZID=America/New_York and its VTIMEZONE is stored with DTSTART/DTEND value and TZID unchanged.',
        needs: 'temp',
        async run(ctx) {
            const start = at(ctx, 30);
            const trip = await roundTrip(ctx, 'tzid-vtimezone', 'tzvt', (uid) => probeCalendar(ctx, uid, [
                `DTSTART;TZID=America/New_York:${icalLocal(start)}`, `DTEND;TZID=America/New_York:${icalLocal(start + HOUR)}`, `SUMMARY:${SUMMARY}`,
            ], { vtimezone: NEW_YORK }));
            const result = startEndOutcome(trip, prose`TZID with VTIMEZONE`);
            result.evidence.vtimezoneReturned = vtimezones(trip.got).includes('America/New_York');
            return result;
        },
    },
    {
        id: 'roundtrip-tzid-without-vtimezone',
        planItem: 'Open item: how to emit a VTIMEZONE block for a new event with a TZID',
        claim: 'An event with TZID=Europe/Berlin and no VTIMEZONE is accepted and stored with DTSTART/DTEND unchanged.',
        needs: 'temp',
        async run(ctx) {
            const start = at(ctx, 31);
            const trip = await roundTrip(ctx, 'tzid-no-vtimezone', 'tznovt', (uid) => probeCalendar(ctx, uid, [
                `DTSTART;TZID=Europe/Berlin:${icalLocal(start)}`, `DTEND;TZID=Europe/Berlin:${icalLocal(start + HOUR)}`, `SUMMARY:${SUMMARY}`,
            ]));
            const result = startEndOutcome(trip, prose`TZID without VTIMEZONE`);
            result.evidence.vtimezoneAddedByServer = vtimezones(trip.got).includes('Europe/Berlin');
            result.evidence.vtimezoneCountReturned = vtimezones(trip.got).length;
            return result;
        },
    },
    {
        id: 'roundtrip-all-day',
        planItem: `${DATETIME} 3: all-day events (VALUE=DATE, exclusive end date)`,
        claim: 'An all-day event with VALUE=DATE and an exclusive DTEND is stored unchanged.',
        needs: 'temp',
        async run(ctx) {
            const day = baseDay(ctx) + 32 * DAY;
            const trip = await roundTrip(ctx, 'all-day', 'allday', (uid) => probeCalendar(ctx, uid, [
                `DTSTART;VALUE=DATE:${icalDate(day)}`, `DTEND;VALUE=DATE:${icalDate(day + DAY)}`, `SUMMARY:${SUMMARY}`, 'TRANSP:TRANSPARENT',
            ]));
            return startEndOutcome(trip, prose`All-day`);
        },
    },
    {
        id: 'roundtrip-floating',
        planItem: `${DATETIME} 3: floating events (no zone) are never converted`,
        claim: 'A floating event (no TZID, no Z) is stored unchanged.',
        needs: 'temp',
        async run(ctx) {
            const start = at(ctx, 33);
            const trip = await roundTrip(ctx, 'floating', 'floating', (uid) => probeCalendar(ctx, uid, [
                `DTSTART:${icalLocal(start)}`, `DTEND:${icalLocal(start + HOUR)}`, `SUMMARY:${SUMMARY}`,
            ]));
            return startEndOutcome(trip, prose`Floating`);
        },
    },
    {
        id: 'roundtrip-utc',
        planItem: `${DATETIME} 2: outputs give the UTC instant`,
        claim: 'A UTC event (Z suffix) is stored unchanged.',
        needs: 'temp',
        async run(ctx) {
            const start = at(ctx, 34);
            const trip = await roundTrip(ctx, 'utc', 'utc', (uid) => probeCalendar(ctx, uid, [
                `DTSTART:${icalUtc(start)}`, `DTEND:${icalUtc(start + HOUR)}`, `SUMMARY:${SUMMARY}`,
            ]));
            return startEndOutcome(trip, prose`UTC`);
        },
    },
    {
        id: 'roundtrip-unknown-properties',
        planItem: `${DATETIME} 7: unknown properties (X-APPLE-*, alarms) survive updates`,
        claim: 'An unknown X- property with a parameter and a VALARM are stored unchanged.',
        needs: 'temp',
        async run(ctx) {
            const start = at(ctx, 35);
            const alarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:caldav-mcp probe alarm', 'TRIGGER:-PT15M', 'END:VALARM'];
            const trip = await roundTrip(ctx, 'unknown-properties', 'xprop', (uid) => probeCalendar(ctx, uid, [
                `DTSTART:${icalUtc(start)}`, `DTEND:${icalUtc(start + HOUR)}`, `SUMMARY:${SUMMARY}`, 'X-CALDAV-MCP-PROBE;X-CALDAV-MCP-PARAM=yes:kept', ...alarm,
            ]));
            const sentAlarm = master(trip.sent)?.components.find((c) => c.name === 'VALARM');
            const gotAlarms = master(trip.got)?.components.filter((c) => c.name === 'VALARM') ?? [];
            const sentNames = new Set(sentAlarm?.properties.map((p) => p.name));
            const gotAlarm = gotAlarms[0];
            const evidence: Evidence = {
                ...trip.evidence,
                xPropertyPreserved: same(trip, 'X-CALDAV-MCP-PROBE'),
                valarmCountReturned: gotAlarms.length,
                valarmActionPreserved: gotAlarm !== undefined && prop(gotAlarm, 'ACTION')?.value === 'DISPLAY',
                valarmTriggerPreserved: gotAlarm !== undefined && prop(gotAlarm, 'TRIGGER')?.value === '-PT15M',
                valarmAddedProperties: safeNames((gotAlarm?.properties ?? []).map((p) => p.name).filter((n) => !sentNames.has(n)), ctx.taint),
            };
            if (evidence.xPropertyPreserved === true && evidence.valarmActionPreserved === true && evidence.valarmTriggerPreserved === true) {
                return { outcome: 'confirmed', summary: prose`The X- property and the VALARM survived.`, evidence };
            }
            return { outcome: 'refuted', summary: prose`The X- property or the VALARM was changed or dropped.`, evidence };
        },
    },
];

export const rewritesCheck: CheckDef = {
    id: 'server-rewrites',
    planItem: `${DATETIME} 7 and 9: what the server rewrites on save (DTSTAMP, SEQUENCE, PRODID, added properties)`,
    claim: 'The server stores events without changing or dropping any client property (additions are listed but allowed).',
    needs: 'temp',
    async run(ctx) {
        const trips = ctx.state.roundTrips;
        if (trips.length === 0) {
            return { outcome: 'inconclusive', summary: prose`No round trip completed.`, evidence: {} };
        }
        const changed = new Set(trips.flatMap((t) => t.changed));
        const removed = new Set(trips.flatMap((t) => t.removed));
        const evidence: Evidence = {
            roundTrips: trips.length,
            prodidChanged: trips.filter((t) => t.prodidChanged).length,
            dtstampChanged: trips.filter((t) => t.dtstampChanged).length,
            sequenceChangedOrAdded: trips.filter((t) => t.sequenceChanged).length,
            changedProperties: safeNames(changed, ctx.taint),
            removedProperties: safeNames(removed, ctx.taint),
            addedProperties: safeNames(trips.flatMap((t) => t.added), ctx.taint),
        };
        if (changed.size === 0 && removed.size === 0 && evidence.prodidChanged === 0) {
            return { outcome: 'confirmed', summary: prose`No client property was changed or dropped in ${trips.length} round trip(s).`, evidence };
        }
        return { outcome: 'refuted', summary: prose`The server changed or dropped client content (see evidence for property names).`, evidence };
    },
};
