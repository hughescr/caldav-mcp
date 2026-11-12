import { isRefusal, type CheckDef, type WindowResource } from '../context';
import { NS, absolute, calendarQueryBody, dav, eventComponents, getResource, xmlDoc } from '../dav';
import { parseIcal, prop, props, type IcalComponent } from '../ical';
import { prose } from '../safe';
import type { Evidence } from '../types';
import { escapeXml, okProp } from '../xml';
import { Failures, attempt } from './census-helpers';
import { ensureExpanded, ensureWindow, queryWindow, windowRange } from './queries';

/** One cached expanded window and one bounded multiget; owner identifiers stay in memory. */
export const etagExpandVsMultigetCheck: CheckDef = {
    id: 'etag-expand-vs-multiget',
    planItem: 'Phase 2 read path: ETags of expanded query resources versus calendar-multiget',
    claim: 'For up to 20 resources in one expanded calendar-query window, calendar-multiget returns exactly one response per href with the same ETag.',
    needs: 'calendars',
    async run(ctx) {
        const counts = { compared: 0, equal: 0, different: 0, missing: 0 };
        const answer = (complete: boolean) => ({
            outcome: counts.different > 0 ? 'refuted' as const : complete && counts.compared > 0 ? 'confirmed' as const : 'inconclusive' as const,
            summary: prose`${counts.compared} ETag(s) compared: ${counts.equal} equal, ${counts.different} different, ${counts.missing} missing or ambiguous.`,
            evidence: counts,
        });
        await ensureWindow(ctx);
        const calendar = [...ctx.state.window].find(([, data]) => data.status === 207 && data.resources.some((r) => eventComponents(r.ical).length > 0));
        if (calendar === undefined) {
            return answer(false);
        }
        const expanded = await attempt(() => ensureExpanded(ctx, calendar[0]));
        if (!expanded.ok || expanded.value.status !== 207) {
            return answer(false);
        }
        const source = Map.groupBy(expanded.value.resources, (r) => r.href);
        const hrefs = [...source.keys()].slice(0, 20);
        if (hrefs.length === 0) {
            return answer(false);
        }
        const body = xmlDoc(`<C:calendar-multiget ${NS}><D:prop><D:getetag/></D:prop>${hrefs.map((href) => `<D:href>${escapeXml(new URL(href).pathname)}</D:href>`).join('')}</C:calendar-multiget>`);
        const got = await attempt(() => dav(ctx, 'REPORT', calendar[0], { depth: '1', body }));
        if (!got.ok || got.value.res.status !== 207 || got.value.ms === undefined || new URL(got.value.res.url).href !== new URL(calendar[0]).href) {
            counts.missing = hrefs.length;
            return answer(false);
        }
        const responses = Map.groupBy(got.value.ms.responses, (r) => absolute(r.href, calendar[0]));
        let complete = got.value.ms.responses.length === hrefs.length && [...responses.keys()].every((href) => href !== undefined && hrefs.includes(href));
        for (const href of hrefs) {
            const originals = source.get(href) ?? [];
            const matches = responses.get(href) ?? [];
            const match = matches[0];
            const before = originals[0]?.etag;
            const after = match === undefined ? undefined : okProp(match, 'getetag')?.text;
            if (originals.length !== 1 || matches.length !== 1 || !before || !after || (match?.status !== null && match?.status !== 200)) {
                counts.missing++;
                complete = false;
                continue;
            }
            counts.compared++;
            if (before === after) { counts.equal++; } else { counts.different++; }
        }
        return answer(complete);
    },
};

const MAX_BULK_HREFS = 100;
const MAX_COMPARED = 5;
const MAX_BULK_BYTES = 4 * 1024 * 1024;

function overrideCount(resource: { ical: WindowResource['ical'] }): number {
    return eventComponents(resource.ical).filter((e) => prop(e, 'RECURRENCE-ID') !== undefined).length;
}

const lineFeeds = (text: string): string => text.replace(/\r\n/g, '\n');

/** Identity stays in memory: the report receives only coverage and subset counters. */
function eventSignature(event: IcalComponent): string {
    return JSON.stringify([event.name, event.properties.map((p) => [p.name, Object.entries(p.params).toSorted(), p.value]).toSorted(), event.components.map(eventSignature).toSorted()]);
}

function limitCoverage(plain: readonly WindowResource[], limited: readonly WindowResource[]): { complete: boolean; retained: number; removed: number } {
    const originals = new Map(plain.map((r) => [r.href, r]));
    const answers = new Map(limited.map((r) => [r.href, r]));
    let complete = originals.size === plain.length && answers.size === limited.length && originals.size === answers.size;
    let retained = 0;
    let removed = 0;
    for (const r of plain) {
        const answer = answers.get(r.href);
        const original = eventComponents(r.ical);
        const returned = eventComponents(answer?.ical);
        if (r.ical?.name !== 'VCALENDAR' || answer?.ical?.name !== 'VCALENDAR' || original.length === 0 || returned.length === 0) { complete = false; continue; }
        const masters = original.filter((e) => prop(e, 'RECURRENCE-ID') === undefined);
        const gotMasters = returned.filter((e) => prop(e, 'RECURRENCE-ID') === undefined);
        const uids = new Set(masters.map((e) => prop(e, 'UID')?.value));
        if (uids.size !== masters.length || uids.has(undefined) || masters.length !== gotMasters.length || original.some((e) => props(e, 'UID').length !== 1 || !uids.has(prop(e, 'UID')?.value))) {
            complete = false;
        }
        if (masters.map(eventSignature).toSorted().join('\n') !== gotMasters.map(eventSignature).toSorted().join('\n')) {
            complete = false;
        }
        const overrides = original.filter((e) => prop(e, 'RECURRENCE-ID') !== undefined).map(eventSignature);
        const gotOverrides = returned.filter((e) => prop(e, 'RECURRENCE-ID') !== undefined).map(eventSignature);
        const remaining = new Map<string, number>();
        for (const key of overrides) {
            remaining.set(key, (remaining.get(key) ?? 0) + 1);
        }
        for (const key of gotOverrides) {
            const count = remaining.get(key) ?? 0;
            if (count === 0) {
                complete = false;
            } else {
                retained++;
                remaining.set(key, count - 1);
            }
        }
        removed += [...remaining.values()].reduce((a, b) => a + b, 0);
    }
    return { complete, retained, removed };
}

export const calendarDataVsGetCheck: CheckDef = {
    id: 'calendar-data-vs-get',
    planItem: 'Phase 2 read path: whether a calendar-query result can stand in for a GET (events, ETags, overrides)',
    claim: 'For a recurring resource, the calendar-data a calendar-query returns is byte-identical to a GET of the same href, with the same ETag and the same overrides.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        const candidates = [...ctx.state.window.values()]
            .flatMap((d) => d.resources)
            .filter((r) => r.recurring && r.calendarData !== null && r.ical !== undefined);
        const chosen = candidates.toSorted((a, b) => overrideCount(b) - overrideCount(a)).slice(0, MAX_COMPARED);
        const failures = new Failures();
        const tally = { compared: 0, getNotOk: 0, identical: 0, identicalLf: 0, etags: 0, countsEqual: 0, withOverrides: 0, inQuery: 0, inGet: 0 };
        for (const resource of chosen) {
            const got = await attempt(() => getResource(ctx, resource.href));
            if (!got.ok) {
                failures.record(got);
                if (got.stop) {
                    break;
                }
                continue;
            }
            if (got.value.status !== 200) {
                tally.getNotOk++;
                continue;
            }
            tally.compared++;
            const query = overrideCount(resource);
            const direct = overrideCount({ ical: got.value.ical });
            tally.identical += got.value.body === resource.calendarData ? 1 : 0;
            tally.identicalLf += lineFeeds(got.value.body) === lineFeeds(resource.calendarData ?? '') ? 1 : 0;
            tally.etags += resource.etag !== null && got.value.etag === resource.etag ? 1 : 0;
            tally.countsEqual += query === direct ? 1 : 0;
            tally.withOverrides += query > 0 || direct > 0 ? 1 : 0;
            tally.inQuery += query;
            tally.inGet += direct;
        }
        const evidence: Evidence = {
            recurringResourcesInWindow: candidates.length,
            resourcesCompared: tally.compared,
            getNotOk: tally.getNotOk,
            byteIdentical: tally.identical,
            identicalIgnoringLineEndings: tally.identicalLf,
            etagsEqual: tally.etags,
            resourcesWithOverrides: tally.withOverrides,
            overridesInQuery: tally.inQuery,
            overridesInGet: tally.inGet,
            overrideCountsEqual: tally.countsEqual,
            ...failures.evidence(),
        };
        if (failures.stopped || tally.compared === 0) {
            return { outcome: 'inconclusive', summary: prose`${tally.compared} recurring resource(s) could be compared${failures.stopped ? prose` before the check was stopped` : prose``}.`, evidence };
        }
        if (tally.identical === tally.compared && tally.etags === tally.compared && tally.countsEqual === tally.compared) {
            return { outcome: 'confirmed', summary: prose`All ${tally.compared} compared resource(s) were byte-identical with equal ETags and override counts.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`Of ${tally.compared} compared resource(s), ${tally.identical} were byte-identical and ${tally.etags} had equal ETags.`, evidence };
    },
};

export const limitRecurrenceSetCheck: CheckDef = {
    id: 'limit-recurrence-set',
    planItem: 'Phase 2 read path: returning only the overrides near the window (calendar-data/limit-recurrence-set)',
    claim: 'A calendar-query with calendar-data/limit-recurrence-set answers HTTP 207 and returns fewer overrides than the plain query for the same window.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        let best: { href: string; overrides: number; resources: number } | undefined;
        for (const [href, data] of ctx.state.window) {
            if (data.status !== 207 || !data.resources.some((r) => r.recurring)) {
                continue;
            }
            const overrides = data.resources.reduce((sum, r) => sum + overrideCount(r), 0);
            if (best === undefined || overrides > best.overrides) {
                best = { href, overrides, resources: data.resources.length };
            }
        }
        if (best === undefined) {
            return { outcome: 'inconclusive', summary: prose`No recurring resource was found in the ±window.`, evidence: { recurringCalendars: 0 } };
        }
        const plain = ctx.state.window.get(best.href);
        const { start, end } = windowRange(ctx);
        const limited = await queryWindow(ctx, best.href, calendarQueryBody({ start, end, calendarData: 'limit-recurrence-set' }));
        const limitedOverrides = limited.resources.reduce((sum, r) => sum + overrideCount(r), 0);
        const coverage = limitCoverage(plain?.resources ?? [], limited.resources);
        const evidence: Evidence = {
            status: limited.status,
            plainResources: plain?.resources.length ?? 0,
            limitedResources: limited.resources.length,
            plainOverrides: best.overrides,
            limitedOverrides,
            coverageComplete: coverage.complete,
            overridesVerifiedRetained: coverage.retained,
            overridesVerifiedRemoved: coverage.removed,
            plainMastersWithRrule: plain?.resources.filter((r) => r.recurring).length ?? 0,
            limitedMastersWithRrule: limited.resources.filter((r) => r.recurring).length,
            plainBytes: plain?.bytes ?? 0,
            limitedBytes: limited.bytes,
        };
        if (limited.status !== 207) {
            return { outcome: isRefusal(limited.status) ? 'refuted' : 'inconclusive', summary: prose`The limit-recurrence-set query answered HTTP ${limited.status}.`, evidence };
        }
        if (!coverage.complete) {
            return { outcome: 'inconclusive', summary: prose`The limited response did not provide verifiable resource, master and override coverage.`, evidence };
        }
        if (limitedOverrides > best.overrides) {
            return { outcome: 'refuted', summary: prose`The limited query returned more overrides (${limitedOverrides}) than the plain one (${best.overrides}).`, evidence };
        }
        if (best.overrides === 0 || limitedOverrides === best.overrides) {
            return { outcome: 'inconclusive', summary: prose`${best.overrides} override(s) in the plain form and ${limitedOverrides} in the limited form: nothing shows the limit being applied.`, evidence };
        }
        return { outcome: 'confirmed', summary: prose`The limited query returned ${limitedOverrides} of ${best.overrides} override(s).`, evidence };
    },
};

export const bulkMultigetCheck: CheckDef = {
    id: 'multiget-bulk',
    planItem: 'Phase 2 read path: fetching many resources by href in one calendar-multiget',
    claim: 'One calendar-multiget of up to 100 hrefs answers HTTP 207 with calendar-data and a 200 status for every requested href.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        let pick: [string, WindowResource[]] | undefined;
        for (const [href, data] of ctx.state.window) {
            if (data.status === 207 && data.resources.length > (pick?.[1].length ?? 0)) {
                pick = [href, data.resources];
            }
        }
        if (pick === undefined) {
            return { outcome: 'inconclusive', summary: prose`No event href was available.`, evidence: { requested: 0 } };
        }
        const [calendarHref, available] = pick;
        // Stay far below the response cap: the answer carries every resource's calendar-data, escaped.
        const budget = Math.min(MAX_BULK_BYTES, Math.floor(ctx.limits.maxBodyBytes / 2));
        const chosen: WindowResource[] = [];
        let bytes = 0;
        for (const resource of available.slice(0, MAX_BULK_HREFS)) {
            const size = Buffer.byteLength(resource.calendarData ?? '', 'utf8');
            if (chosen.length > 0 && bytes + size > budget) {
                break;
            }
            chosen.push(resource);
            bytes += size;
        }
        const trimmed = chosen.length < Math.min(available.length, MAX_BULK_HREFS);
        const body = xmlDoc(`<C:calendar-multiget ${NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>${chosen.map((c) => `<D:href>${escapeXml(new URL(c.href).pathname)}</D:href>`).join('')}</C:calendar-multiget>`);
        const failures = new Failures();
        const got = await attempt(() => dav(ctx, 'REPORT', calendarHref, { depth: '1', body }));
        const evidence: Evidence = { requested: chosen.length, requestTrimmedBySize: trimmed, hrefsAvailable: available.length };
        if (!got.ok) {
            failures.record(got);
            Object.assign(evidence, failures.evidence(), { bodyTooLarge: got.code === 'body_too_large' });
            return { outcome: 'inconclusive', summary: prose`The multiget could not be completed${got.stop ? prose` and the check was stopped` : prose``}.`, evidence };
        }
        const responses = got.value.ms?.responses ?? [];
        const withData = responses.filter((r) => okProp(r, 'calendar-data') !== undefined).length;
        const notOk = responses.filter((r) => (r.status !== null && r.status !== 200) || (r.status === null && okProp(r, 'calendar-data') === undefined && okProp(r, 'getetag') === undefined)).length;
        const status = got.value.res.status;
        Object.assign(evidence, { status, returned: responses.length, returnedWithCalendarData: withData, perHrefNon200: notOk, bodyTooLarge: false });
        const requested = new Set(chosen.map((r) => r.href));
        const hrefs = responses.map((r) => absolute(r.href, calendarHref));
        const unique = new Set(hrefs);
        const exact = requested.size === chosen.length && unique.size === responses.length && responses.length === requested.size && hrefs.every((href) => href !== undefined && requested.has(href));
        const readable = responses.every((r) => {
            const data = okProp(r, 'calendar-data');
            const root = data === undefined ? undefined : parseIcal(data.text);
            return root?.name === 'VCALENDAR' && eventComponents(root).length > 0;
        });
        Object.assign(evidence, { exactHrefCoverage: exact, readableCalendarData: readable, duplicateHrefs: responses.length - unique.size, unexpectedHrefs: hrefs.filter((href) => href === undefined || !requested.has(href)).length });
        if (status === 207 && (!exact || (notOk === 0 && !readable))) {
            return { outcome: 'inconclusive', summary: prose`The multiget response did not provide one readable response per requested href.`, evidence };
        }
        if (status === 207 && exact && readable && withData === chosen.length && notOk === 0 && responses.length === chosen.length) {
            return { outcome: 'confirmed', summary: prose`All ${chosen.length} requested resource(s) came back with calendar-data.`, evidence };
        }
        if (status === 207 || isRefusal(status)) {
            return { outcome: 'refuted', summary: prose`The multiget of ${chosen.length} href(s) returned ${responses.length} response(s), ${withData} with calendar-data (HTTP ${status}).`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The multiget answered HTTP ${status}.`, evidence };
    },
};
