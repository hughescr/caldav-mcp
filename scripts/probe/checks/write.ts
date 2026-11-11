import { CheckStop, isOk, isRefusal, type CheckContext, type CheckDef } from '../context';
import { absolute, calendarQueryBody, dav, eventComponents, getIcal } from '../dav';
import { icalUtc, prop } from '../ical';
import { etagShape, prose, safeNames, tokenShape } from '../safe';
import type { Evidence } from '../types';
import { textMatchFilter, toResources } from './queries';
import { sync } from './sync';
import {
    DAY, HOUR, SUMMARY, baseDay, createOrStop, createTempCalendar, deleteEvent, newEvent, primary, probeCalendar, propfindEtag, putEvent, utcSpan,
} from './write-helpers';

const PLAN_WRITE = 'Write safety';

export const mkcalendarCheck: CheckDef = {
    id: 'write-mkcalendar',
    planItem: 'Phase 0 write tests: a temporary calendar created and removed by the probe',
    claim: 'MKCALENDAR creates a VEVENT calendar that a PROPFIND then shows.',
    needs: 'home',
    async run(ctx) {
        const made = await createTempCalendar(ctx);
        const evidence: Evidence = {
            mkcalendarStatus: made.status, visibleAfterCreate: made.visible, displayNameKept: made.displayNameKept, declaresVevent: made.declaresVevent,
            locationHeader: made.locationHeader, locationUsed: made.locationUsed,
        };
        if (isOk(made.status) && made.visible) {
            ctx.state.primaryTemp = made.temp;
            return { outcome: 'confirmed', summary: prose`MKCALENDAR answered HTTP ${made.status}; the calendar is visible.`, evidence };
        }
        return { outcome: isRefusal(made.status) ? 'refuted' : 'inconclusive', summary: prose`MKCALENDAR answered HTTP ${made.status}; write tests are skipped.`, evidence };
    },
};

export const createCheck: CheckDef = {
    id: 'write-create-if-none-match',
    planItem: `${PLAN_WRITE}: a create derives the UID from operation_id and iCloud refuses the second PUT`,
    claim: 'A PUT with If-None-Match: * creates the event, and a second identical PUT with If-None-Match: * is refused.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, '1');
        const body = probeCalendar(ctx, uid, [...utcSpan(baseDay(ctx) + 15 * HOUR), `SUMMARY:${SUMMARY}`]);
        const first = await putEvent(ctx, url, body, { 'if-none-match': '*' });
        const evidence: Evidence = { createStatus: first.status, etagHeaderOnCreate: first.etag !== null, createEtag: etagShape(first.etag) };
        if (!isOk(first.status)) {
            throw new CheckStop(isRefusal(first.status) ? 'refuted' : 'inconclusive', prose`The create was not accepted (HTTP ${first.status}).`, evidence);
        }
        const stored = await propfindEtag(ctx, url);
        evidence.etagHeaderMatchesPropfind = first.etag === null ? null : first.etag === stored;
        ctx.state.created = { href: url, etag: stored ?? first.etag, uid };
        const second = await putEvent(ctx, url, body, { 'if-none-match': '*' });
        evidence.secondCreateStatus = second.status;
        evidence.secondCreatePreconditions = safeNames(second.errorElements, ctx.taint);
        if (isRefusal(second.status)) {
            return { outcome: 'confirmed', summary: prose`The repeated create was refused with HTTP ${second.status}.`, evidence };
        }
        if (isOk(second.status)) {
            return { outcome: 'refuted', summary: prose`The repeated create succeeded (HTTP ${second.status}); create retries could overwrite.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The repeated create answered HTTP ${second.status}.`, evidence };
    },
};

function createdOrStop(ctx: CheckContext): { href: string; etag: string; uid: string; staleEtag?: string | null } {
    const created = ctx.state.created;
    if (created === undefined || created.etag === null) {
        throw new CheckStop('inconclusive', prose`No ETag was available for the test event.`);
    }
    return { ...created, etag: created.etag };
}

function updateBody(ctx: CheckContext, uid: string, note: string): string {
    return probeCalendar(ctx, uid, [...utcSpan(baseDay(ctx) + 15 * HOUR), `SUMMARY:${SUMMARY}`, `DESCRIPTION:caldav-mcp probe ${note}`, 'SEQUENCE:1']);
}

export const ifMatchExactCheck: CheckDef = {
    id: 'write-if-match-exact',
    planItem: `${PLAN_WRITE}: expected_version sent as an exact If-Match`,
    claim: 'An update with the exact current ETag in If-Match succeeds.',
    needs: 'created',
    async run(ctx) {
        const created = createdOrStop(ctx);
        const put = await putEvent(ctx, created.href, updateBody(ctx, created.uid, 'update'), { 'if-match': created.etag });
        const evidence: Evidence = { status: put.status, etagHeaderOnUpdate: put.etag !== null };
        if (isOk(put.status)) {
            const fresh = await propfindEtag(ctx, created.href);
            evidence.etagChanged = fresh !== null && fresh !== created.etag;
            ctx.state.created = { href: created.href, uid: created.uid, etag: fresh ?? put.etag, staleEtag: created.etag };
            return { outcome: 'confirmed', summary: prose`The exact If-Match update answered HTTP ${put.status}.`, evidence };
        }
        return { outcome: isRefusal(put.status) ? 'refuted' : 'inconclusive', summary: prose`The exact If-Match update answered HTTP ${put.status}.`, evidence };
    },
};

export const ifMatchStaleCheck: CheckDef = {
    id: 'write-if-match-stale',
    planItem: `${PLAN_WRITE}: a mismatch is a conflict error`,
    claim: 'A PUT or DELETE carrying a stale ETag in If-Match is refused with HTTP 412 and the event is unchanged.',
    needs: 'created',
    async run(ctx) {
        const created = createdOrStop(ctx);
        const stale = created.staleEtag;
        if (stale === undefined || stale === null || stale === created.etag) {
            throw new CheckStop('inconclusive', prose`No stale ETag was available (the update did not change the ETag).`);
        }
        const put = await putEvent(ctx, created.href, updateBody(ctx, created.uid, 'stale'), { 'if-match': stale });
        const del = await deleteEvent(ctx, created.href, stale);
        const after = await getIcal(ctx, created.href);
        const evidence: Evidence = { staleUpdateStatus: put.status, staleDeleteStatus: del, resourceStillPresent: after.status === 200 };
        if (after.status !== 200) {
            ctx.state.created = undefined;
        } else if (isOk(put.status)) {
            ctx.state.created = { ...created, etag: after.etag };
        }
        if (put.status === 412 && del === 412 && after.status === 200) {
            return { outcome: 'confirmed', summary: prose`Both the stale update and the stale delete were refused with HTTP 412.`, evidence };
        }
        if (isOk(put.status) || isOk(del)) {
            return { outcome: 'refuted', summary: prose`A write with a stale ETag succeeded.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`Stale writes answered HTTP ${put.status} (PUT) and ${del} (DELETE).`, evidence };
    },
};

export const ifMatchStarCheck: CheckDef = {
    id: 'write-if-match-star',
    planItem: 'Known quirks: If-Match: * is broken',
    claim: 'If-Match: * does not behave as RFC 9110 says (succeed on an existing resource, 412 on a missing one).',
    needs: 'created',
    async run(ctx) {
        const created = createdOrStop(ctx);
        const temp = primary(ctx);
        const existing = await putEvent(ctx, created.href, updateBody(ctx, created.uid, 'star'), { 'if-match': '*' });
        if (isOk(existing.status)) {
            ctx.state.created = { ...created, etag: await propfindEtag(ctx, created.href) };
        }
        const missing = newEvent(temp, 'star');
        const missingPut = await putEvent(ctx, missing.url, probeCalendar(ctx, missing.uid, [...utcSpan(baseDay(ctx) + DAY + 15 * HOUR), `SUMMARY:${SUMMARY}`]), { 'if-match': '*' });
        const evidence: Evidence = { existingStatus: existing.status, missingStatus: missingPut.status };
        if (isOk(missingPut.status)) {
            evidence.missingResourceCreated = true;
            await deleteEvent(ctx, missing.url, missingPut.etag ?? (await propfindEtag(ctx, missing.url)));
        }
        const rfc = isOk(existing.status) && missingPut.status === 412;
        if (rfc) {
            return { outcome: 'refuted', summary: prose`If-Match: * behaved as RFC 9110 specifies.`, evidence };
        }
        if (isRefusal(existing.status) || isOk(missingPut.status)) {
            return { outcome: 'confirmed', summary: prose`If-Match: * misbehaved (existing: HTTP ${existing.status}, missing: HTTP ${missingPut.status}).`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`If-Match: * answered HTTP ${existing.status} and ${missingPut.status}.`, evidence };
    },
};

export const noEndCheck: CheckDef = {
    id: 'write-no-end',
    planItem: 'Known quirks: an event without DTEND or DURATION is refused',
    claim: 'A VEVENT with DTSTART but neither DTEND nor DURATION is refused.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'noend');
        const put = await putEvent(ctx, url, probeCalendar(ctx, uid, [`DTSTART:${icalUtc(baseDay(ctx) + 18 * HOUR)}`, `SUMMARY:${SUMMARY}`]), { 'if-none-match': '*' });
        const evidence: Evidence = { status: put.status, preconditions: safeNames(put.errorElements, ctx.taint) };
        if (isOk(put.status)) {
            const stored = await getIcal(ctx, url);
            const event = eventComponents(stored.ical)[0];
            evidence.serverAddedDtend = event !== undefined && prop(event, 'DTEND') !== undefined;
            evidence.serverAddedDuration = event !== undefined && prop(event, 'DURATION') !== undefined;
            await deleteEvent(ctx, url, stored.etag);
            return { outcome: 'refuted', summary: prose`The event without an end was accepted (HTTP ${put.status}).`, evidence };
        }
        if (isRefusal(put.status)) {
            return { outcome: 'confirmed', summary: prose`The event without an end was refused (HTTP ${put.status}).`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The PUT answered HTTP ${put.status}.`, evidence };
    },
};

export const duplicateUidCheck: CheckDef = {
    id: 'write-duplicate-uid',
    planItem: 'Known quirks: the same UID cannot exist in two calendars',
    claim: 'A PUT of an event whose UID already exists in another calendar is refused.',
    needs: 'created',
    async run(ctx) {
        const created = createdOrStop(ctx);
        const temp = primary(ctx);
        const body = probeCalendar(ctx, created.uid, [...utcSpan(baseDay(ctx) + 15 * HOUR), `SUMMARY:${SUMMARY}`]);
        const sameCal = newEvent(temp, 'dupsame');
        const same = await putEvent(ctx, sameCal.url, body, { 'if-none-match': '*' });
        const evidence: Evidence = { sameCalendarOtherNameStatus: same.status, sameCalendarPreconditions: safeNames(same.errorElements, ctx.taint) };
        if (isOk(same.status)) {
            await deleteEvent(ctx, sameCal.url, same.etag ?? (await propfindEtag(ctx, sameCal.url)));
        }
        const second = await createTempCalendar(ctx);
        evidence.secondCalendarStatus = second.status;
        if (!isOk(second.status) || !second.visible) {
            throw new CheckStop('inconclusive', prose`A second temporary calendar could not be created (HTTP ${second.status}).`, evidence);
        }
        const other = await putEvent(ctx, `${second.temp.url}${created.uid}.ics`, body, { 'if-none-match': '*' });
        evidence.otherCalendarStatus = other.status;
        evidence.otherCalendarPreconditions = safeNames(other.errorElements, ctx.taint);
        if (isRefusal(other.status)) {
            return { outcome: 'confirmed', summary: prose`The duplicate UID in another calendar was refused (HTTP ${other.status}).`, evidence };
        }
        if (isOk(other.status)) {
            return { outcome: 'refuted', summary: prose`The duplicate UID was accepted in another calendar.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The duplicate PUT answered HTTP ${other.status}.`, evidence };
    },
};

async function count(ctx: CheckContext, url: string, start: number, end: number, extraFilter?: string): Promise<{ status: number; hrefs: string[] }> {
    const r = await dav(ctx, 'REPORT', url, { depth: '1', body: calendarQueryBody({ start, end, calendarData: 'none', ...(extraFilter === undefined ? {} : { extraFilter }) }) });
    return { status: r.res.status, hrefs: (r.ms?.responses ?? []).map((resp) => absolute(resp.href, url) ?? '').filter((h) => h !== '' && h !== url) };
}

export const expandWriteCheck: CheckDef = {
    id: 'write-expand',
    planItem: 'What iCloud provides: Server-side recurrence expansion (definitive)',
    claim: 'For a weekly series with one RECURRENCE-ID override and one EXDATE, calendar-query with expand returns exactly the 5 expected instances, applying both.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'series');
        const start = baseDay(ctx) + 2 * DAY + 15 * HOUR;
        const body = probeCalendar(ctx, uid, [...utcSpan(start), 'RRULE:FREQ=WEEKLY;COUNT=6', `EXDATE:${icalUtc(start + 14 * DAY)}`, `SUMMARY:${SUMMARY} series`], {
            overrides: [[`RECURRENCE-ID:${icalUtc(start + 7 * DAY)}`, ...utcSpan(start + 7 * DAY + 2 * HOUR), `SUMMARY:${SUMMARY} override`]],
        });
        const evidence: Evidence = {};
        await createOrStop(ctx, url, body, evidence);
        const r = await dav(ctx, 'REPORT', temp.url, { depth: '1', body: calendarQueryBody({ start: baseDay(ctx), end: baseDay(ctx) + 45 * DAY, calendarData: 'expand' }) });
        const series = toResources(r.ms, temp.url).find((res) => res.href === url);
        const events = eventComponents(series?.ical);
        const instances = events.filter((e) => prop(e, 'RECURRENCE-ID') !== undefined);
        const overrideId = icalUtc(start + 7 * DAY);
        const exdate = icalUtc(start + 14 * DAY);
        Object.assign(evidence, {
            expandStatus: r.res.status,
            seriesReturned: series !== undefined,
            instancesReturned: instances.length,
            expectedInstances: 5,
            rrulePresent: events.some((e) => prop(e, 'RRULE') !== undefined),
            overrideApplied: instances.some((e) => prop(e, 'RECURRENCE-ID')?.value === overrideId && prop(e, 'DTSTART')?.value === icalUtc(start + 7 * DAY + 2 * HOUR)),
            exdateRespected: instances.length > 0 && !instances.some((e) => prop(e, 'RECURRENCE-ID')?.value === exdate || prop(e, 'DTSTART')?.value === exdate),
            instanceStartsInUtc: instances.filter((e) => (prop(e, 'DTSTART')?.value ?? '').endsWith('Z')).length,
        });
        if (r.res.status !== 207) {
            return { outcome: isRefusal(r.res.status) ? 'refuted' : 'inconclusive', summary: prose`The expand query answered HTTP ${r.res.status}.`, evidence };
        }
        if (evidence.rrulePresent === true) {
            return { outcome: 'refuted', summary: prose`The series came back with RRULE: expand was not applied.`, evidence };
        }
        if (instances.length === 5 && evidence.overrideApplied === true && evidence.exdateRespected === true) {
            return { outcome: 'confirmed', summary: prose`Expansion returned the 5 expected instances with the override and EXDATE applied.`, evidence };
        }
        if (instances.length > 0) {
            return { outcome: 'refuted', summary: prose`Expansion returned ${instances.length} instance(s) but not the expected set.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The series was not returned.`, evidence };
    },
};

export const textMatchWriteCheck: CheckDef = {
    id: 'write-text-match',
    planItem: 'What iCloud provides: Server-side text search (definitive)',
    claim: 'A SUMMARY text-match finds exactly the one event containing the word, case-insensitively, and nothing for a random word.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const base = baseDay(ctx);
        const evidence: Evidence = {};
        for (const [word, day] of [['alpha', 5], ['bravo', 6]] as const) {
            const { url, uid } = newEvent(temp, word);
            await createOrStop(ctx, url, probeCalendar(ctx, uid, [...utcSpan(base + day * DAY + 10 * HOUR), `SUMMARY:${SUMMARY} ${word}`]), evidence);
        }
        const start = base - DAY;
        const end = base + 45 * DAY;
        const total = await count(ctx, temp.url, start, end);
        const lower = await count(ctx, temp.url, start, end, textMatchFilter('bravo'));
        const upper = await count(ctx, temp.url, start, end, textMatchFilter('BRAVO'));
        const nonce = await count(ctx, temp.url, start, end, textMatchFilter(`zq${ctx.randomHex(6)}`));
        Object.assign(evidence, { status: lower.status, totalInRange: total.hrefs.length, expected: 1, matched: lower.hrefs.length, upperCaseMatched: upper.hrefs.length, nonceMatched: nonce.hrefs.length });
        if (lower.status !== 207) {
            return { outcome: isRefusal(lower.status) ? 'refuted' : 'inconclusive', summary: prose`The text-match query answered HTTP ${lower.status}.`, evidence };
        }
        if (lower.hrefs.length === 1 && nonce.hrefs.length === 0) {
            return { outcome: 'confirmed', summary: prose`The filter found the one matching event (upper-case query: ${upper.hrefs.length}).`, evidence };
        }
        if (lower.hrefs.length === total.hrefs.length && total.hrefs.length > 1) {
            return { outcome: 'refuted', summary: prose`The filter was ignored: every event in the range came back.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`The filter returned ${lower.hrefs.length} event(s) instead of 1.`, evidence };
    },
};

export const timeRangeWriteCheck: CheckDef = {
    id: 'write-time-range',
    planItem: 'Tools: list_events relies on calendar-query time-range filtering (definitive)',
    claim: 'A time-range query returns the one event inside the range and nothing for an adjacent empty range.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const at = baseDay(ctx) + 4 * DAY + 8 * HOUR;
        const { url, uid } = newEvent(temp, 'range');
        const evidence: Evidence = {};
        await createOrStop(ctx, url, probeCalendar(ctx, uid, [...utcSpan(at), `SUMMARY:${SUMMARY}`]), evidence);
        const inside = await count(ctx, temp.url, at - HOUR / 2, at + 1.5 * HOUR);
        const outside = await count(ctx, temp.url, at + 4 * HOUR, at + 5 * HOUR);
        Object.assign(evidence, { insideStatus: inside.status, insideCount: inside.hrefs.length, insideHasEvent: inside.hrefs.includes(url), outsideStatus: outside.status, outsideCount: outside.hrefs.length });
        if (inside.status === 207 && outside.status === 207 && inside.hrefs.length === 1 && inside.hrefs.includes(url) && outside.hrefs.length === 0) {
            return { outcome: 'confirmed', summary: prose`The time range selected exactly the event inside it.`, evidence };
        }
        if (inside.status === 207 && outside.status === 207) {
            return { outcome: 'refuted', summary: prose`The time ranges returned the wrong events.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The queries answered HTTP ${inside.status} and ${outside.status}.`, evidence };
    },
};

export const syncWriteCheck: CheckDef = {
    id: 'write-sync-changes',
    planItem: 'Phase 0: sync-collection (definitive)',
    claim: 'After a change and a deletion, sync-collection with the earlier token reports the changed href (with an ETag) and the deleted href (404).',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const base = baseDay(ctx);
        const evidence: Evidence = {};
        const a = newEvent(temp, 'synca');
        const b = newEvent(temp, 'syncb');
        const etagA = await createOrStop(ctx, a.url, probeCalendar(ctx, a.uid, [...utcSpan(base + 7 * DAY + 10 * HOUR), `SUMMARY:${SUMMARY}`]), evidence);
        const etagB = await createOrStop(ctx, b.url, probeCalendar(ctx, b.uid, [...utcSpan(base + 7 * DAY + 12 * HOUR), `SUMMARY:${SUMMARY}`]), evidence);
        const initial = await sync(ctx, temp.url, '');
        Object.assign(evidence, { initialStatus: initial.status, initialItems: initial.items.length, tokenShape: initial.token === null ? null : tokenShape(initial.token) });
        if (initial.status !== 207 || initial.token === null || initial.token === '') {
            return { outcome: 'inconclusive', summary: prose`The initial sync answered HTTP ${initial.status} ${initial.token === null ? prose`without` : prose`with`} a token.`, evidence };
        }
        ctx.taint.add(initial.token);
        const modify = await putEvent(ctx, a.url, probeCalendar(ctx, a.uid, [...utcSpan(base + 7 * DAY + 10 * HOUR), `SUMMARY:${SUMMARY}`, 'DESCRIPTION:caldav-mcp probe changed', 'SEQUENCE:1']), etagA === null ? {} : { 'if-match': etagA });
        const removed = await deleteEvent(ctx, b.url, etagB);
        const delta = await sync(ctx, temp.url, initial.token);
        if (delta.token !== null) {
            ctx.taint.add(delta.token);
        }
        const changed = delta.items.find((i) => i.href === a.url);
        const deleted = delta.items.find((i) => i.href === b.url);
        Object.assign(evidence, {
            modifyStatus: modify.status,
            deleteStatus: removed,
            deltaStatus: delta.status,
            deltaItems: delta.items.length,
            changeReported: changed !== undefined && changed.status !== 404,
            changeHasEtag: changed?.hasEtag ?? false,
            deletionReported: deleted?.status === 404,
            tokenChanged: delta.token !== null && delta.token !== initial.token,
        });
        if (delta.status !== 207) {
            return { outcome: 'inconclusive', summary: prose`The delta sync answered HTTP ${delta.status}.`, evidence };
        }
        if (evidence.changeReported === true && evidence.deletionReported === true) {
            return { outcome: 'confirmed', summary: prose`The delta sync reported both the change and the deletion.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`The delta sync missed the change or the deletion.`, evidence };
    },
};

export const syncLimitWriteCheck: CheckDef = {
    id: 'write-sync-limit',
    planItem: 'Known quirks: the sync-collection limit is ignored (definitive)',
    claim: 'sync-collection with DAV:limit/nresults=2 on a calendar with more than 2 events returns more than 2 items.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const full = await sync(ctx, temp.url, '');
        const limited = await sync(ctx, temp.url, '', 2);
        for (const token of [full.token, limited.token]) {
            ctx.taint.add(token);
        }
        const evidence: Evidence = { fullStatus: full.status, totalItems: full.items.length, status: limited.status, nresultsRequested: 2, itemsReturned: limited.items.length, truncationMarker507: limited.truncated };
        if (full.items.length <= 2 || limited.status !== 207) {
            return { outcome: 'inconclusive', summary: prose`Not enough items (${full.items.length}) or the limited sync answered HTTP ${limited.status}.`, evidence };
        }
        if (limited.items.length > 2) {
            return { outcome: 'confirmed', summary: prose`Asked for 2 results, received ${limited.items.length}.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`The limit was honoured (${limited.items.length} items, truncation marker ${limited.truncated ? prose`present` : prose`absent`}).`, evidence };
    },
};
