import { CheckStop, isOk, isRefusal, stopOnThrottle, type CalendarInfo, type CheckContext, type CheckDef, type WindowData, type WindowResource } from '../context';
import { NS, absolute, calDavUtc, calendarQueryBody, dav, eventComponents, isRecurring, propfindBody, xmlDoc } from '../dav';
import { ProbeHttpError } from '../http';
import { parseIcal, prop } from '../ical';
import { etagShape, prose, safeNames } from '../safe';
import type { Evidence } from '../types';
import { escapeXml, okProp, type Multistatus } from '../xml';

const DAY = 86_400_000;
const RUN_LEVEL_STOPS = new Set(['request_cap', 'deadline', 'interrupted', 'throttled_abort']);
const KIND_ORDER = ['owned', 'shared-by-me', 'shared-with-me', 'subscribed'];

export function windowRange(ctx: CheckContext): { start: number; end: number } {
    const now = ctx.now();
    return { start: now - ctx.limits.windowDays * DAY, end: now + ctx.limits.windowDays * DAY };
}

/** Calendar collections that may hold events, owned first, capped. */
export function eventCalendars(ctx: CheckContext): CalendarInfo[] {
    return (ctx.state.calendars ?? [])
        .filter((c) => c.isCalendar && (c.components.length === 0 || c.components.includes('VEVENT')))
        .toSorted((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
        .slice(0, ctx.limits.maxCalendarsQueried);
}

export function toResources(ms: Multistatus | undefined, base: string): WindowResource[] {
    const resources: WindowResource[] = [];
    for (const response of ms?.responses ?? []) {
        const href = absolute(response.href, base);
        if (href === undefined || href === base) {
            continue;
        }
        const data = okProp(response, 'calendar-data');
        const ical = data === undefined ? undefined : parseIcal(data.text);
        resources.push({
            href,
            etag: okProp(response, 'getetag')?.text ?? null,
            ical,
            summaries: eventComponents(ical).map((e) => (prop(e, 'SUMMARY')?.value ?? '').toLowerCase()),
            recurring: isRecurring(ical),
        });
    }
    return resources;
}

/** One ±window calendar-query per event calendar, shared by several checks. */
export async function ensureWindow(ctx: CheckContext): Promise<void> {
    if (ctx.state.windowLoaded) {
        return;
    }
    ctx.state.windowLoaded = true;
    const { start, end } = windowRange(ctx);
    for (const cal of eventCalendars(ctx)) {
        try {
            const r = await dav(ctx, 'REPORT', cal.href, { depth: '1', body: calendarQueryBody({ start, end, calendarData: 'full' }) });
            ctx.state.window.set(cal.href, { status: r.res.status, resources: r.res.status === 207 ? toResources(r.ms, cal.href) : [] });
        } catch (error) {
            if (error instanceof CheckStop) {
                ctx.state.window.set(cal.href, { status: typeof error.evidence.status === 'number' ? error.evidence.status : 0, resources: [] });
                break;
            }
            if (error instanceof ProbeHttpError) {
                ctx.state.window.set(cal.href, { status: 0, resources: [] });
                // A per-request failure (timeout, oversized body) skips one calendar; a run-level stop ends the loop.
                if (RUN_LEVEL_STOPS.has(error.code)) {
                    break;
                }
                continue;
            }
            throw error;
        }
    }
}

function busiest(ctx: CheckContext, filter: (r: WindowResource) => boolean = () => true): [string, WindowData] | undefined {
    let best: [string, WindowData] | undefined;
    for (const entry of ctx.state.window) {
        if (entry[1].status === 207 && entry[1].resources.some(filter) && (best === undefined || entry[1].resources.length > best[1].resources.length)) {
            best = entry;
        }
    }
    return best;
}

async function countQuery(ctx: CheckContext, url: string, body: string): Promise<{ status: number; hrefs: string[]; errorElements: string[] }> {
    const r = await dav(ctx, 'REPORT', url, { depth: '1', body });
    const hrefs = (r.ms?.responses ?? []).map((resp) => absolute(resp.href, url)).filter((h): h is string => h !== undefined && h !== url);
    return { status: r.res.status, hrefs, errorElements: r.errorElements };
}

function firstEventCalendar(ctx: CheckContext): CalendarInfo {
    const cal = eventCalendars(ctx)[0];
    if (cal === undefined) {
        throw new CheckStop('inconclusive', prose`No calendar declaring VEVENT was found.`);
    }
    return cal;
}

export const timeRangeCheck: CheckDef = {
    id: 'time-range',
    planItem: 'Tools: list_events relies on calendar-query time-range filtering',
    claim: 'calendar-query with a time-range returns fewer resources for a narrow window than for a wide one, and only resources from the wide set.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        const statuses: Record<string, number> = {};
        let total = 0;
        for (const data of ctx.state.window.values()) {
            statuses[String(data.status)] = (statuses[String(data.status)] ?? 0) + 1;
            total += data.resources.length;
        }
        const evidence: Evidence = { calendarsQueried: ctx.state.window.size, windowDays: ctx.limits.windowDays, windowStatuses: statuses, resourcesInWindow: total };
        const pick = busiest(ctx);
        if (pick === undefined) {
            return { outcome: 'inconclusive', summary: prose`No event was found in the ±window in any calendar (run --write for a definitive test).`, evidence };
        }
        const now = ctx.now();
        const narrow = await countQuery(ctx, pick[0], calendarQueryBody({ start: now - 3 * DAY, end: now + 3 * DAY, calendarData: 'none' }));
        const wide = new Set(pick[1].resources.map((r) => r.href));
        const subset = narrow.hrefs.every((h) => wide.has(h));
        Object.assign(evidence, { wideCount: wide.size, narrowStatus: narrow.status, narrowCount: narrow.hrefs.length, narrowSubsetOfWide: subset });
        if (narrow.status !== 207) {
            return { outcome: isRefusal(narrow.status) ? 'refuted' : 'inconclusive', summary: prose`The narrow query answered HTTP ${narrow.status}.`, evidence };
        }
        if (!subset || narrow.hrefs.length > wide.size) {
            return { outcome: 'refuted', summary: prose`The narrow window returned resources the wide window did not.`, evidence };
        }
        if (narrow.hrefs.length < wide.size) {
            return { outcome: 'confirmed', summary: prose`Narrow window ${narrow.hrefs.length} of ${wide.size} resources.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`Both windows returned the same resources, so filtering cannot be distinguished from no filtering.`, evidence };
    },
};

export const freeBusyCheck: CheckDef = {
    id: 'free-busy-query',
    planItem: 'What iCloud provides: Free/busy query',
    claim: 'A CalDAV free-busy-query REPORT is rejected with HTTP 400.',
    needs: 'calendars',
    async run(ctx) {
        const cal = firstEventCalendar(ctx);
        const now = ctx.now();
        const body = xmlDoc(`<C:free-busy-query ${NS}><C:time-range start="${calDavUtc(now)}" end="${calDavUtc(now + 7 * DAY)}"/></C:free-busy-query>`);
        const res = await ctx.http.request({ method: 'REPORT', url: cal.href, headers: { depth: '1' }, body });
        stopOnThrottle(ctx, res);
        const evidence: Evidence = { status: res.status, contentTypeIsCalendar: /text\/calendar/i.test(res.headers.get('content-type') ?? ''), bodyHasVfreebusy: /BEGIN:VFREEBUSY/i.test(res.body) };
        if (res.status === 400) {
            return { outcome: 'confirmed', summary: prose`free-busy-query was rejected with HTTP 400.`, evidence };
        }
        if (isOk(res.status)) {
            return { outcome: 'refuted', summary: prose`free-busy-query answered HTTP ${res.status}.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`free-busy-query answered HTTP ${res.status}, not 400.`, evidence };
    },
};

export const expandReadCheck: CheckDef = {
    id: 'expand-read',
    planItem: 'What iCloud provides: Server-side recurrence expansion',
    claim: 'calendar-query with calendar-data/expand returns recurring events as RECURRENCE-ID instances without RRULE.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        const pick = busiest(ctx, (r) => r.recurring);
        if (pick === undefined) {
            return { outcome: 'inconclusive', summary: prose`No recurring event was found in the ±window (run --write for a definitive test).`, evidence: { recurringResourcesInWindow: 0 } };
        }
        const recurring = new Set(pick[1].resources.filter((r) => r.recurring).map((r) => r.href));
        const { start, end } = windowRange(ctx);
        const r = await dav(ctx, 'REPORT', pick[0], { depth: '1', body: calendarQueryBody({ start, end, calendarData: 'expand' }) });
        let instances = 0;
        let rrules = 0;
        let utcStarts = 0;
        for (const resource of toResources(r.ms, pick[0])) {
            if (!recurring.has(resource.href)) {
                continue;
            }
            for (const event of eventComponents(resource.ical)) {
                if (prop(event, 'RRULE') !== undefined) {
                    rrules++;
                }
                if (prop(event, 'RECURRENCE-ID') !== undefined) {
                    instances++;
                    if ((prop(event, 'DTSTART')?.value ?? '').endsWith('Z')) {
                        utcStarts++;
                    }
                }
            }
        }
        const evidence: Evidence = { recurringResourcesInWindow: recurring.size, expandStatus: r.res.status, instancesWithRecurrenceId: instances, componentsStillWithRrule: rrules, instanceStartsInUtc: utcStarts };
        if (r.res.status !== 207) {
            return { outcome: isRefusal(r.res.status) ? 'refuted' : 'inconclusive', summary: prose`The expand query answered HTTP ${r.res.status}.`, evidence };
        }
        if (rrules > 0) {
            return { outcome: 'refuted', summary: prose`Recurring events came back with RRULE, so expand was not applied.`, evidence };
        }
        if (instances > 0) {
            return { outcome: 'confirmed', summary: prose`${instances} expanded instance(s) without RRULE.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The expand query returned neither RRULE nor RECURRENCE-ID instances for the recurring events.`, evidence };
    },
};

/** A word that occurs in some but not all summaries of one calendar. Never reported. */
function pickToken(resources: WindowResource[]): { token: string; expected: number } | undefined {
    const counts = new Map<string, number>();
    for (const resource of resources) {
        const words = new Set(resource.summaries.flatMap((s) => s.split(/[^a-z]+/)).filter((w) => w.length >= 4));
        for (const word of words) {
            counts.set(word, (counts.get(word) ?? 0) + 1);
        }
    }
    let best: { token: string; expected: number } | undefined;
    for (const [token] of counts) {
        const expected = resources.filter((r) => r.summaries.some((s) => s.includes(token))).length;
        if (expected > 0 && expected < resources.length && (best === undefined || expected > best.expected || (expected === best.expected && token < best.token))) {
            best = { token, expected };
        }
    }
    return best;
}

export function textMatchFilter(token: string): string {
    return `<C:prop-filter name="SUMMARY"><C:text-match>${escapeXml(token)}</C:text-match></C:prop-filter>`;
}

export const textMatchReadCheck: CheckDef = {
    id: 'text-match-read',
    planItem: 'What iCloud provides: Server-side text search',
    claim: 'calendar-query with a SUMMARY text-match filter returns only matching resources.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        const pick = busiest(ctx);
        const resources = pick?.[1].resources ?? [];
        const choice = pickToken(resources);
        if (pick === undefined || choice === undefined) {
            return { outcome: 'inconclusive', summary: prose`No calendar had summaries suitable for a read-only text test (run --write for a definitive test).`, evidence: { totalInCalendar: resources.length } };
        }
        ctx.taint.add(choice.token);
        const { start, end } = windowRange(ctx);
        const matched = await countQuery(ctx, pick[0], calendarQueryBody({ start, end, calendarData: 'none', extraFilter: textMatchFilter(choice.token) }));
        const nonce = await countQuery(ctx, pick[0], calendarQueryBody({ start, end, calendarData: 'none', extraFilter: textMatchFilter(`zq${ctx.randomHex(6)}`) }));
        const evidence: Evidence = { totalInCalendar: resources.length, expectedMatches: choice.expected, status: matched.status, matched: matched.hrefs.length, nonceStatus: nonce.status, nonceMatched: nonce.hrefs.length };
        if (matched.status !== 207 || nonce.status !== 207) {
            return { outcome: isRefusal(matched.status) ? 'refuted' : 'inconclusive', summary: prose`The text-match query answered HTTP ${matched.status}.`, evidence };
        }
        if (matched.hrefs.length === choice.expected && nonce.hrefs.length === 0) {
            return { outcome: 'confirmed', summary: prose`The filter returned exactly the ${choice.expected} expected resource(s) and nothing for a random word.`, evidence };
        }
        if (matched.hrefs.length === resources.length && nonce.hrefs.length === resources.length) {
            return { outcome: 'refuted', summary: prose`The filter was ignored: every resource came back, including for a random word.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The filter returned an unexpected number of resources.`, evidence };
    },
};

export const uidFilterCheck: CheckDef = {
    id: 'uid-filter',
    planItem: 'Known quirks: a calendar-query filter on UID returns 412',
    claim: 'calendar-query with a UID prop-filter is answered with HTTP 412.',
    needs: 'calendars',
    async run(ctx) {
        const cal = firstEventCalendar(ctx);
        const uid = `caldav-mcp-probe-${ctx.randomHex(4)}-nouid`;
        const body = xmlDoc(`<C:calendar-query ${NS}><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:prop-filter name="UID"><C:text-match collation="i;octet">${uid}</C:text-match></C:prop-filter></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`);
        const r = await countQuery(ctx, cal.href, body);
        const evidence: Evidence = { status: r.status, preconditions: safeNames(r.errorElements, ctx.taint), matchedCount: r.hrefs.length };
        if (r.status === 412) {
            return { outcome: 'confirmed', summary: prose`The UID filter was answered with HTTP 412.`, evidence };
        }
        if (r.status === 207) {
            return { outcome: 'refuted', summary: prose`The UID filter worked (HTTP 207, ${r.hrefs.length} match(es) for a random UID).`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The UID filter answered HTTP ${r.status}.`, evidence };
    },
};

export const multigetCheck: CheckDef = {
    id: 'multiget',
    planItem: 'Known quirks: fetch by href or use calendar-multiget',
    claim: 'calendar-multiget returns calendar-data for every requested href.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        const pick = busiest(ctx);
        if (pick === undefined) {
            return { outcome: 'inconclusive', summary: prose`No event href was available.`, evidence: { requested: 0 } };
        }
        const chosen = pick[1].resources.slice(0, 5);
        const body = xmlDoc(`<C:calendar-multiget ${NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>${chosen.map((c) => `<D:href>${escapeXml(new URL(c.href).pathname)}</D:href>`).join('')}</C:calendar-multiget>`);
        const r = await dav(ctx, 'REPORT', pick[0], { depth: '1', body });
        const byHref = new Map(toResources(r.ms, pick[0]).map((res) => [res.href, res]));
        const withData = chosen.filter((c) => byHref.get(c.href)?.ical !== undefined).length;
        const etagsMatch = chosen.filter((c) => c.etag !== null && byHref.get(c.href)?.etag === c.etag).length;
        const evidence: Evidence = { requested: chosen.length, status: r.res.status, returnedWithCalendarData: withData, etagsMatchQuery: etagsMatch };
        if (r.res.status === 207 && withData === chosen.length) {
            return { outcome: 'confirmed', summary: prose`All ${chosen.length} requested resource(s) were returned with calendar-data.`, evidence };
        }
        if (r.res.status === 207 || isRefusal(r.res.status)) {
            return { outcome: 'refuted', summary: prose`multiget returned ${withData} of ${chosen.length} (HTTP ${r.res.status}).`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`multiget answered HTTP ${r.res.status}.`, evidence };
    },
};

export const etagCheck: CheckDef = {
    id: 'etag-shape',
    planItem: 'Write safety: every write carries the exact ETag from a prior read',
    claim: 'ETags are strong, quoted, and identical across REPORT, GET and PROPFIND for the same resource.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        const resource = busiest(ctx, (r) => r.etag !== null)?.[1].resources.find((r) => r.etag !== null);
        if (resource === undefined) {
            return { outcome: 'inconclusive', summary: prose`No event with an ETag was available.`, evidence: {} };
        }
        const get = await ctx.http.request({ method: 'GET', url: resource.href });
        stopOnThrottle(ctx, get);
        const getEtag = get.headers.get('etag');
        const pf = await dav(ctx, 'PROPFIND', resource.href, { depth: '0', body: propfindBody(['D:getetag']) });
        const pfEtag = pf.ms?.responses[0] === undefined ? null : okProp(pf.ms.responses[0], 'getetag')?.text ?? null;
        const shapes = [etagShape(resource.etag), etagShape(getEtag), etagShape(pfEtag)];
        const evidence: Evidence = {
            reportEtag: shapes[0] ?? null,
            getStatus: get.status,
            getEtag: shapes[1] ?? null,
            propfindStatus: pf.res.status,
            propfindEtag: shapes[2] ?? null,
            getMatchesReport: getEtag === resource.etag,
            propfindMatchesReport: pfEtag === resource.etag,
        };
        if (getEtag === null || pfEtag === null) {
            return { outcome: 'inconclusive', summary: prose`An ETag was missing from GET or PROPFIND.`, evidence };
        }
        const strong = shapes.every((s) => s !== null && s.quoted && !s.weak);
        if (strong && getEtag === resource.etag && pfEtag === resource.etag) {
            return { outcome: 'confirmed', summary: prose`Strong, quoted ETags that match across REPORT, GET and PROPFIND.`, evidence };
        }
        return { outcome: 'refuted', summary: strong ? prose`ETags differ between REPORT, GET and PROPFIND.` : prose`ETags are weak or unquoted.`, evidence };
    },
};
