import type { CheckDef, WindowResource } from '../context';
import { calendarQueryBody, eventComponents } from '../dav';
import { prose } from '../safe';
import type { Evidence } from '../types';
import { Failures, attempt } from './census-helpers';
import { ensureWindow, queryWindow } from './queries';

const DAY = 86_400_000;
const SHORT_WINDOW_DAYS = 31;
const BIG_BYTES = 256 * 1024;

type Record1 = Record<string, number | null>;

function sizes(resources: readonly WindowResource[]): { largestBytes: number; largestVevents: number; over: number } {
    let largestBytes = 0;
    let largestVevents = 0;
    let over = 0;
    for (const r of resources) {
        const bytes = Buffer.byteLength(r.calendarData ?? '', 'utf8');
        largestBytes = Math.max(largestBytes, bytes);
        largestVevents = Math.max(largestVevents, eventComponents(r.ical).length);
        over += bytes > BIG_BYTES ? 1 : 0;
    }
    return { largestBytes, largestVevents, over };
}

export const payloadSizesCheck: CheckDef = {
    id: 'payload-sizes',
    planItem: 'Phase 2 read path: response sizes of calendar-query, unexpanded and expanded (Lambda memory, response cap)',
    claim: 'No single resource’s calendar-data exceeds 256 KiB in the ±window.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        const now = ctx.now();
        const short = { start: now, end: now + SHORT_WINDOW_DAYS * DAY };
        const failures = new Failures();
        const evidence: Evidence = {};
        let measured = 0;
        let largestBytes = 0;
        let largestVevents = 0;
        let over = 0;
        let index = 0;
        let stopped = false;
        for (const [href, wide] of ctx.state.window) {
            const entry: Record1 = { windowStatus: wide.status, windowResources: wide.resources.length };
            evidence[`calendar${index++}`] = entry;
            if (wide.status !== 207 || wide.resources.length === 0 || stopped) {
                continue;
            }
            const plain = await attempt(() => queryWindow(ctx, href, calendarQueryBody({ ...short, calendarData: 'full' })));
            const expanded = plain.ok ? await attempt(() => queryWindow(ctx, href, calendarQueryBody({ ...short, calendarData: 'expand' }))) : plain;
            for (const result of [plain, expanded]) {
                if (!result.ok) {
                    failures.record(result);
                    stopped = stopped || result.stop;
                }
            }
            const wideSizes = sizes(wide.resources);
            const expandedWide = ctx.state.expanded.get(href);
            const expandedSizes = expandedWide === undefined ? undefined : sizes(expandedWide.resources);
            Object.assign(entry, {
                unexpanded31dStatus: plain.ok ? plain.value.status : null,
                unexpanded31dBytes: plain.ok ? plain.value.bytes : null,
                expanded31dStatus: expanded.ok ? expanded.value.status : null,
                expanded31dBytes: expanded.ok ? expanded.value.bytes : null,
                unexpandedWideBytes: wide.bytes,
                expandedWideBytes: expandedWide?.bytes ?? null,
                largestCalendarDataBytes: wideSizes.largestBytes,
                largestVeventCount: wideSizes.largestVevents,
                resourcesOver256KiB: wideSizes.over,
                expandedLargestCalendarDataBytes: expandedSizes?.largestBytes ?? null,
                expandedLargestVeventCount: expandedSizes?.largestVevents ?? null,
            });
            measured++;
            largestBytes = Math.max(largestBytes, wideSizes.largestBytes);
            largestVevents = Math.max(largestVevents, wideSizes.largestVevents);
            over += wideSizes.over;
        }
        Object.assign(evidence, {
            calendarsMeasured: measured,
            shortWindowDays: SHORT_WINDOW_DAYS,
            wideWindowDays: ctx.limits.windowDays * 2,
            largestCalendarDataBytes: largestBytes,
            largestVeventsInResource: largestVevents,
            resourcesOver256KiB: over,
            ...failures.evidence(),
        });
        if (measured === 0) {
            return { outcome: 'inconclusive', summary: prose`No calendar had events in the ±window to measure.`, evidence };
        }
        if (over > 0) {
            return { outcome: 'refuted', summary: prose`${over} resource(s) have calendar-data over 256 KiB (largest ${largestBytes} bytes).`, evidence };
        }
        return { outcome: 'confirmed', summary: prose`The largest calendar-data in ${measured} calendar(s) is ${largestBytes} bytes, under 256 KiB.`, evidence };
    },
};
