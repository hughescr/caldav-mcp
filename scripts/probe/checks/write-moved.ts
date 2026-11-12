/**
 * Write-mode evidence for overrides that are moved to another day than the instance they replace.
 * Two daily UTC series (COUNT=5, 10:00Z on days D to D+4) each carry one override: its
 * RECURRENCE-ID is a slot inside the series and its DTSTART is moved to a later day, past the
 * last instance of the series. A wide window first proves the server returns the whole series
 * (the sanity step); only then are the narrow windows read: the one that covers the moved
 * slot (RECURRENCE-ID outside, DTSTART inside) and the one that covers the original slot.
 * Every query is sent both with `<C:expand>` and as a plain time-range query that returns the
 * stored data. The events are the probe's own, so counts and tuples are published; they come
 * only from resources whose UID was validated by `windowResources`.
 */
import { isOk, type CheckContext, type CheckDef, type CheckOutput } from '../context';
import { icalDate, icalUtc } from '../ical';
import { dateShape } from '../ical-time';
import { prose, safeNames } from '../safe';
import type { Evidence } from '../types';
import { PLAN, windowResources, type Expanded } from './write-expansion';
import { DAY, HOUR, SUMMARY, baseDay, newEvent, primary, probeCalendar, putEvent } from './write-helpers';
import { compareInstances, describeResult, type Expected } from './write-instances';

interface SeriesSpec { key: string; suffix: string; ridDay: number; movedDay: number }

const SERIES: readonly SeriesSpec[] = [
    { key: 'movedIn', suffix: 'wmovein', ridDay: 1, movedDay: 20 },
    { key: 'movedOut', suffix: 'wmoveout', ridDay: 3, movedDay: 10 },
];

const COUNT = 5;

interface Queried { expand: Expanded | undefined; plain: Expanded | undefined }

/** Series C: a fixed future Tuesday, ten weeks, with the third instance moved within the span. */
export const movedOverrideInSpanCheck: CheckDef = {
    id: 'write-moved-override-in-span',
    planItem: `${PLAN}: an override moved inside a weekly series' span`,
    claim: 'After a wide sanity query returns all ten weekly instances and the stored master plus override, a Thursday-only expanded query finds exactly the third Tuesday instance moved two days later.',
    needs: 'temp',
    async run(ctx): Promise<CheckOutput> {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'wmovespan');
        const first = Date.UTC(2027, 0, 5);
        const at = (day: number): number => first + day * DAY + 10 * HOUR;
        const expected = (day: number): Expected => ({ start: icalUtc(at(day === 14 ? 16 : day)), rid: icalUtc(at(day)), ends: [icalUtc(at(day === 14 ? 16 : day) + HOUR)] });
        const moved = expected(14);
        const all = Array.from({ length: 10 }, (_, i) => expected(i * 7));
        const stored: Expected[] = [{ start: icalUtc(at(0)), rid: null, ends: [icalUtc(at(0) + HOUR)] }, moved];
        const evidence: Evidence = { firstDay: dateShape(icalDate(first)) };
        const put = await putEvent(ctx, url, probeCalendar(ctx, uid, [`DTSTART:${icalUtc(at(0))}`, `DTEND:${icalUtc(at(0) + HOUR)}`, 'RRULE:FREQ=WEEKLY;COUNT=10', `SUMMARY:${SUMMARY}`], {
            overrides: [[`RECURRENCE-ID:${icalUtc(at(14))}`, `DTSTART:${icalUtc(at(16))}`, `DTEND:${icalUtc(at(16) + HOUR)}`, `SUMMARY:${SUMMARY}`]],
        }), { 'if-none-match': '*' });
        evidence.putStatus = put.status;
        if (!isOk(put.status)) {
            evidence.preconditions = safeNames(put.errorElements, ctx.taint);
            return { outcome: 'inconclusive', summary: prose`The weekly in-span series was not accepted.`, evidence };
        }
        const ask = async (key: string, start: number, end: number): Promise<Queried> => {
            const expand = (await windowResources(ctx, temp, [url], first + start * DAY, first + end * DAY, 'expand')).get(url);
            const plain = (await windowResources(ctx, temp, [url], first + start * DAY, first + end * DAY, 'full')).get(url);
            Object.assign(evidence, describeResult(`${key}Expand`, expand), describeResult(`${key}Plain`, plain));
            return { expand, plain };
        };
        const wide = await ask('wide', -1, 64);
        const sanity = wide.expand?.status === 207 && wide.plain?.status === 207 && wide.plain.returned
            && compareInstances(wide.expand.events, all).full && compareInstances(wide.plain.events, stored).full;
        evidence.sanityPassed = sanity;
        evidence.narrowClaimsEvaluated = sanity;
        if (!sanity) { return { outcome: 'inconclusive', summary: prose`The wide window did not verify all ten instances and the stored master plus override.`, evidence }; }
        const thursday = await ask('thursday', 16, 17);
        await ask('tuesday', 14, 15);
        await ask('week', 13, 18); // Monday 00:00 through Saturday 00:00 (Monday-Friday inclusive).
        if (thursday.expand?.status !== 207) { return { outcome: 'inconclusive', summary: prose`The Thursday expanded query did not complete successfully.`, evidence }; }
        if (compareInstances(thursday.expand.events, [moved]).full) {
            return { outcome: 'confirmed', summary: prose`The Thursday-only expanded window returned exactly the moved instance inside the series span.`, evidence };
        }
        return thursday.expand.events.length === 0
            ? { outcome: 'refuted', summary: prose`The Thursday-only expanded window returned no instance, despite the verified wide series.`, evidence }
            : { outcome: 'inconclusive', summary: prose`The Thursday-only expanded window returned unexpected instances or times.`, evidence };
    },
};

export const movedOverridesCheck: CheckDef = {
    id: 'write-moved-overrides',
    planItem: `${PLAN}: overrides moved into or out of the query window`,
    claim: 'For a daily UTC series (COUNT=5) with one override moved past the end of the series, a wide window returns all 5 instances, the window around the moved slot returns the override (RECURRENCE-ID outside the window, DTSTART inside) and the window around the original slot returns nothing, both expanded and as a plain time-range query.',
    needs: 'temp',
    async run(ctx: CheckContext): Promise<CheckOutput> {
        const temp = primary(ctx);
        const first = baseDay(ctx) + 50 * DAY;
        const at = (day: number): number => first + day * DAY + 10 * HOUR;
        const dayWindow = (day: number): readonly [number, number] => [first + day * DAY, first + (day + 1) * DAY];
        const wide: readonly [number, number] = [first - DAY, first + 30 * DAY];
        const evidence: Evidence = { firstDay: dateShape(icalDate(first)), wideWindowDays: 31 };
        const written = SERIES.map((s) => ({ ...s, ...newEvent(temp, s.suffix) }));

        let accepted = true;
        for (const s of written) {
            const put = await putEvent(ctx, s.url, probeCalendar(ctx, s.uid, [`DTSTART:${icalUtc(at(0))}`, `DTEND:${icalUtc(at(0) + HOUR)}`, `RRULE:FREQ=DAILY;COUNT=${COUNT}`, `SUMMARY:${SUMMARY}`], {
                overrides: [[`RECURRENCE-ID:${icalUtc(at(s.ridDay))}`, `DTSTART:${icalUtc(at(s.movedDay))}`, `DTEND:${icalUtc(at(s.movedDay) + HOUR)}`, `SUMMARY:${SUMMARY}`]],
            }), { 'if-none-match': '*' });
            evidence[`${s.key}PutStatus`] = put.status;
            if (!isOk(put.status)) {
                evidence[`${s.key}Preconditions`] = safeNames(put.errorElements, ctx.taint);
                accepted = false;
            }
        }
        if (!accepted) {
            return { outcome: 'inconclusive', summary: prose`The server did not accept both test series.`, evidence };
        }

        /** Expected instants of the expanded series: the four plain days and the override at its moved slot (RECURRENCE-ID: the slot it replaces). */
        const expandedInstances = (s: SeriesSpec): Expected[] => [0, 1, 2, 3, 4].map((day) => (day === s.ridDay
            ? { start: icalUtc(at(s.movedDay)), rid: icalUtc(at(s.ridDay)), ends: [icalUtc(at(s.movedDay) + HOUR)] }
            : { start: icalUtc(at(day)), rid: icalUtc(at(day)), ends: [icalUtc(at(day) + HOUR)] }));
        /** The stored data: the master and the override. */
        const storedComponents = (s: SeriesSpec): Expected[] => [
            { start: icalUtc(at(0)), rid: null, ends: [icalUtc(at(0) + HOUR)] },
            { start: icalUtc(at(s.movedDay)), rid: icalUtc(at(s.ridDay)), ends: [icalUtc(at(s.movedDay) + HOUR)] },
        ];

        const hrefs = written.map((s) => s.url);
        /** One window, both ways. */
        const ask = async (window: readonly [number, number], only: readonly string[]): Promise<Map<string, Queried>> => {
            const expand = await windowResources(ctx, temp, only, window[0], window[1], 'expand');
            const plain = await windowResources(ctx, temp, only, window[0], window[1], 'full');
            return new Map(only.map((href) => [href, { expand: expand.get(href), plain: plain.get(href) }]));
        };
        const answered = (q: Queried | undefined): boolean => q?.expand?.status === 207 && q.plain?.status === 207;

        const wideAnswers = await ask(wide, hrefs);
        let sanity = true;
        for (const s of written) {
            const q = wideAnswers.get(s.url);
            Object.assign(evidence, describeResult(`${s.key}WideExpand`, q?.expand), describeResult(`${s.key}WidePlain`, q?.plain));
            const expandOk = q?.expand !== undefined && compareInstances(q.expand.events, expandedInstances(s)).full;
            const plainOk = q?.plain !== undefined && q.plain.returned && compareInstances(q.plain.events, storedComponents(s)).full;
            Object.assign(evidence, { [`${s.key}SanityExpandedAllFive`]: expandOk, [`${s.key}SanityPlainSelectsWithBothComponents`]: plainOk });
            sanity &&= answered(q) && expandOk && plainOk;
        }
        evidence.expandStatus = wideAnswers.get(hrefs[0] ?? '')?.expand?.status ?? 0;
        evidence.sanityPassed = sanity;
        if (!sanity) {
            evidence.narrowClaimsEvaluated = false;
            const statuses = written.flatMap((s) => [wideAnswers.get(s.url)?.expand?.status, wideAnswers.get(s.url)?.plain?.status]);
            const wrong = statuses.some((status) => status !== 207);
            return {
                outcome: 'inconclusive',
                summary: wrong
                    ? prose`A wide-window query was not answered with HTTP 207, so the narrow windows were not evaluated.`
                    : prose`The wide window did not return the whole of each series (the counts are recorded), so the narrow windows were not evaluated.`,
                evidence,
            };
        }

        evidence.narrowClaimsEvaluated = true;
        let narrowAnswered = true;
        let claimsHold = true;
        for (const s of written) {
            const moved = dayWindow(s.movedDay);
            const original = dayWindow(s.ridDay);
            const movedAnswers = (await ask(moved, [s.url])).get(s.url);
            const originalAnswers = (await ask(original, [s.url])).get(s.url);
            Object.assign(evidence,
                describeResult(`${s.key}MovedWindowExpand`, movedAnswers?.expand), describeResult(`${s.key}MovedWindowPlain`, movedAnswers?.plain),
                describeResult(`${s.key}OriginalWindowExpand`, originalAnswers?.expand), describeResult(`${s.key}OriginalWindowPlain`, originalAnswers?.plain));
            narrowAnswered &&= answered(movedAnswers) && answered(originalAnswers);
            const claims = {
                [`${s.key}MovedWindowExpandReturnsOverride`]: movedAnswers?.expand !== undefined && compareInstances(movedAnswers.expand.events, [{ start: icalUtc(at(s.movedDay)), rid: icalUtc(at(s.ridDay)), ends: [icalUtc(at(s.movedDay) + HOUR)] }]).full,
                [`${s.key}MovedWindowPlainSelects`]: movedAnswers?.plain?.returned === true,
                [`${s.key}OriginalWindowExpandEmpty`]: originalAnswers?.expand !== undefined && originalAnswers.expand.events.length === 0,
                [`${s.key}OriginalWindowPlainSelectsNothing`]: originalAnswers?.plain !== undefined && !originalAnswers.plain.returned,
            };
            Object.assign(evidence, claims);
            claimsHold &&= Object.values(claims).every(Boolean);
        }
        if (!narrowAnswered) {
            return { outcome: 'inconclusive', summary: prose`A narrow-window query was not answered with HTTP 207.`, evidence };
        }
        return claimsHold
            ? { outcome: 'confirmed', summary: prose`Both series were returned whole by the wide window; each override was found by its moved slot and not by the original one, expanded and plain.`, evidence }
            : { outcome: 'refuted', summary: prose`Both series were returned whole by the wide window, but an override was not found by its moved slot or was found by the original one (see the per-window counts).`, evidence };
    },
};
