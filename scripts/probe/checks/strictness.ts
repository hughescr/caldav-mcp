import { addAttachments, emptyTally, type AttachmentState } from '../attachments';
import type { CheckContext, CheckDef } from '../context';
import { calendarQueryBody, dav, eventComponents } from '../dav';
import { comps, prop, props, type IcalComponent } from '../ical';
import { classifyTzid, isDateValue, kindOf, timeValidity } from '../ical-time';
import { prose } from '../safe';
import { zoneValidator } from '../tz';
import type { Evidence } from '../types';
import { Failures, attempt } from './census-helpers';
import { eventCalendars, toResources } from './queries';

const DAY = 86_400_000;
const SINGLETONS = ['UID', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID'] as const;
const TZID_PROPS = ['DTSTART', 'DTEND', 'RECURRENCE-ID', 'EXDATE', 'RDATE'] as const;

/** The counters of the census. Every one is a count; none holds a value from the account. */
export const ANOMALY_KEYS = [
    'dateEventsEndNotAfterStart', 'timedEventsEndBeforeStart', 'startEndKindMismatch', 'tzidOnDateValue',
    'unresolvedTzidWindowsLike', 'unresolvedTzidMozillaPrefix', 'unresolvedTzidOther', 'vtimezoneObservancesOtherRecurrence',
    'recurrenceIdWithRange', 'veventsWithoutEndOrDuration', 'resourcesWithDuplicateSingletons', 'resourcesWithMultipleUids',
    'resourcesWithOverridesNoMaster', 'invalidTimeValues', 'declaredTimeFormMismatch',
] as const;

export type Census = Record<'resources' | 'vevents' | (typeof ANOMALY_KEYS)[number], number>;

export function emptyCensus(): Census {
    return Object.fromEntries(['resources', 'vevents', ...ANOMALY_KEYS].map((k) => [k, 0])) as Census;
}

const FREQ = /(?:^|;)FREQ=([A-Z]+)/i;

/** Adds one parsed resource to the census. Reads values; keeps only counts. */
export function addToCensus(census: Census, root: IcalComponent | undefined, isIanaZone: (tzid: string) => boolean | undefined): void {
    if (root === undefined) {
        return;
    }
    census.resources++;
    const zones = comps(root, 'VTIMEZONE');
    const defined = new Set(zones.map((tz) => prop(tz, 'TZID')?.value ?? ''));
    for (const tz of zones) {
        for (const observance of [...comps(tz, 'STANDARD'), ...comps(tz, 'DAYLIGHT')]) {
            if (props(observance, 'RRULE').some((r) => FREQ.exec(r.value)?.[1]?.toUpperCase() !== 'YEARLY')) {
                census.vtimezoneObservancesOtherRecurrence++;
            }
        }
    }
    const events = eventComponents(root);
    let duplicates = false;
    for (const event of events) {
        census.vevents++;
        const start = prop(event, 'DTSTART');
        const end = prop(event, 'DTEND');
        if (end === undefined && prop(event, 'DURATION') === undefined) {
            census.veventsWithoutEndOrDuration++;
        }
        if (start !== undefined && end !== undefined) {
            const [startKind, endKind] = [kindOf(start), kindOf(end)];
            const sameZone = startKind !== 'tzid' || start.params.TZID === end.params.TZID;
            if (startKind !== endKind) {
                census.startEndKindMismatch++;
            } else if (startKind === 'date') {
                census.dateEventsEndNotAfterStart += end.value.trim() <= start.value.trim() ? 1 : 0;
            } else if (sameZone && startKind !== 'invalid') {
                census.timedEventsEndBeforeStart += end.value.trim() < start.value.trim() ? 1 : 0;
            }
        }
        for (const name of ['DTSTART', 'DTEND', 'RECURRENCE-ID'] as const) {
            for (const p of props(event, name)) {
                const validity = timeValidity(p);
                census.invalidTimeValues += validity.valid ? 0 : 1;
                census.declaredTimeFormMismatch += validity.mismatched ? 1 : 0;
                census.tzidOnDateValue += isDateValue(p) && p.params.TZID !== undefined ? 1 : 0;
            }
        }
        for (const name of TZID_PROPS) {
            for (const p of props(event, name)) {
                const tzid = p.params.TZID;
                if (tzid === undefined || defined.has(tzid) || isIanaZone(tzid) !== false) {
                    continue;
                }
                const kind = classifyTzid(tzid);
                census[kind === 'windows' ? 'unresolvedTzidWindowsLike' : kind === 'mozilla' ? 'unresolvedTzidMozillaPrefix' : 'unresolvedTzidOther']++;
            }
        }
        census.recurrenceIdWithRange += props(event, 'RECURRENCE-ID').filter((p) => p.params.RANGE !== undefined).length;
        duplicates = duplicates || SINGLETONS.some((name) => props(event, name).length > 1);
    }
    census.resourcesWithDuplicateSingletons += duplicates ? 1 : 0;
    const uids = new Set(events.map((e) => prop(e, 'UID')?.value ?? ''));
    census.resourcesWithMultipleUids += uids.size > 1 ? 1 : 0;
    const orphan = [...uids].some((uid) => {
        const own = events.filter((e) => (prop(e, 'UID')?.value ?? '') === uid);
        return own.some((e) => prop(e, 'RECURRENCE-ID') !== undefined) && !own.some((e) => prop(e, 'RECURRENCE-ID') === undefined);
    });
    census.resourcesWithOverridesNoMaster += orphan ? 1 : 0;
}

export const strictnessCheck: CheckDef = {
    id: 'strictness-census',
    planItem: 'Phase 2 read path: how strict a parser can be about real data (counts of malformed or unusual events)',
    claim: 'In a wide unexpanded query, no event is malformed or unusual in any of the ways a strict parser would reject: end not after start, DTSTART/DTEND of different forms, TZID on a DATE, an unresolvable TZID, a non-yearly VTIMEZONE rule, RANGE on RECURRENCE-ID, no end, duplicate singleton properties, several UIDs in one resource, or overrides without a master.',
    needs: 'calendars',
    async run(ctx: CheckContext) {
        const now = ctx.now();
        const days = ctx.limits.wideWindowDays;
        const body = calendarQueryBody({ start: now - days * DAY, end: now + days * DAY, calendarData: 'full' });
        const census = emptyCensus();
        const isIanaZone = zoneValidator();
        const failures = new Failures();
        const attachments: AttachmentState = { tally: emptyTally(), calendarsQueried: 0, calendarsRead: 0, calendarsOverBodyCap: 0, stoppedEarly: false, coverageComplete: false };
        /** The fetch check needs one managed attachment the host guard allows; one with a declared SIZE is better. */
        const keepCandidate = (url: string, size: number | null): void => {
            if (attachments.candidate === undefined || (attachments.candidate.declaredSize === null && size !== null)) {
                attachments.candidate = { url, declaredSize: size };
            }
        };
        let queried = 0;
        let read = 0;
        let overCap = 0;
        let fetched = 0;
        let missingData = 0;
        let parseFailed = 0;
        for (const cal of eventCalendars(ctx)) {
            queried++;
            const got = await attempt(() => dav(ctx, 'REPORT', cal.href, { depth: '1', body }));
            if (!got.ok) {
                if (got.code === 'body_too_large') {
                    overCap++;
                    continue;
                }
                failures.record(got);
                if (got.stop) {
                    break;
                }
                continue;
            }
            if (got.value.res.status !== 207 || got.value.ms === undefined) {
                failures.record({ ok: false, stop: false, code: null, status: null, retryAfterSeconds: null });
                continue;
            }
            read++;
            const resources = toResources(got.value.ms, cal.href);
            fetched += got.value.ms.responses.length;
            parseFailed += got.value.ms.responses.length - resources.length;
            for (const resource of resources) {
                if (resource.calendarData === null) {
                    missingData++;
                } else if (resource.ical?.name !== 'VCALENDAR' || eventComponents(resource.ical).length === 0) {
                    parseFailed++;
                } else {
                    addToCensus(census, resource.ical, isIanaZone);
                    // The same successfully parsed resources feed the attachment census (no request of its own).
                    addAttachments(attachments.tally, resource.ical, keepCandidate);
                }
            }
        }
        attachments.calendarsQueried = queried;
        attachments.calendarsRead = read;
        attachments.calendarsOverBodyCap = overCap;
        attachments.stoppedEarly = failures.stopped;
        const complete = read === eventCalendars(ctx).length && overCap === 0 && failures.count === 0 && missingData === 0 && parseFailed === 0;
        attachments.coverageComplete = complete;
        ctx.state.attachments = attachments;
        const anomalies = ANOMALY_KEYS.reduce((sum, key) => sum + census[key], 0);
        const evidence: Evidence = {
            wideWindowDays: days * 2,
            calendarsQueried: queried,
            calendarsRead: read,
            calendarsOverBodyCap: overCap,
            coverageComplete: complete,
            resourcesFetched: fetched,
            resourcesMissingCalendarData: missingData,
            resourcesParseFailed: parseFailed,
            temporalAvailable: isIanaZone('UTC') !== undefined,
            ...census,
            ...failures.evidence(),
        };
        if (anomalies > 0) {
            return { outcome: 'refuted', summary: prose`${anomalies} anomaly(ies) in ${census.resources} resource(s) and ${census.vevents} event(s).`, evidence };
        }
        if (!complete || census.resources === 0) {
            return { outcome: 'inconclusive', summary: prose`${census.resources} resource(s) were read from ${read} of ${queried} calendar(s); nothing can be concluded.`, evidence };
        }
        if (isIanaZone('UTC') === undefined) {
            return { outcome: 'inconclusive', summary: prose`No other anomaly was found, but this runtime has no Temporal, so TZIDs could not be checked.`, evidence };
        }
        return { outcome: 'confirmed', summary: prose`None of the ${census.vevents} event(s) in ${census.resources} resource(s) showed any of the listed anomalies.`, evidence };
    },
};
