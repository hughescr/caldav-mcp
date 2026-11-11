import type { CheckDef } from '../context';
import { propfindBody } from '../dav';
import { ProbeHttpError } from '../http';
import { prose, safeNames } from '../safe';
import type { Evidence } from '../types';

const RATE_HEADER = /rate|limit|retry|throttl|quota|backoff/i;

function latencySummary(values: number[]): { count: number; min: number; median: number; max: number } {
    const sorted = values.toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
    return { count: sorted.length, min: sorted[0] ?? 0, median, max: sorted.at(-1) ?? 0 };
}

export const pacingCheck: CheckDef = {
    id: 'request-pacing',
    planItem: 'What iCloud provides: Rate limits, behaviour from AWS addresses',
    claim: 'No throttling (HTTP 429/503) was observed at this run’s volume, including a short burst of 10 sequential and 5 parallel PROPFIND requests. Nothing is claimed about limits beyond what was observed.',
    async run(ctx) {
        const sequential: Record<string, number> = {};
        const parallel: Record<string, number> = {};
        const errors: string[] = [];
        const home = ctx.state.homeUrl;
        if (home !== undefined) {
            const body = propfindBody(['D:resourcetype']);
            for (let i = 0; i < 10; i++) {
                try {
                    const res = await ctx.http.request({ method: 'PROPFIND', url: home, headers: { depth: '0' }, body, paced: false });
                    sequential[String(res.status)] = (sequential[String(res.status)] ?? 0) + 1;
                    if (res.status === 429 || res.status === 503) {
                        break;
                    }
                } catch (error) {
                    errors.push(error instanceof ProbeHttpError ? error.code : 'other');
                    break;
                }
            }
            if (sequential['429'] === undefined && sequential['503'] === undefined && errors.length === 0) {
                const settled = await Promise.allSettled(Array.from({ length: 5 }, () => ctx.http.request({ method: 'PROPFIND', url: home, headers: { depth: '0' }, body, paced: false })));
                for (const result of settled) {
                    if (result.status === 'fulfilled') {
                        parallel[String(result.value.status)] = (parallel[String(result.value.status)] ?? 0) + 1;
                    } else {
                        errors.push(result.reason instanceof ProbeHttpError ? result.reason.code : 'other');
                    }
                }
            }
        }
        const stats = ctx.http.stats();
        const evidence: Evidence = {
            totalRequests: stats.requests,
            latencyMs: latencySummary(stats.latencies.map((l) => l.ms)),
            statusCounts: stats.statuses,
            burstSequentialStatuses: sequential,
            burstParallelStatuses: parallel,
            burstErrors: safeNames(errors),
            throttleResponses: stats.throttles.length,
            retryAfterSeen: stats.throttles.some((t) => t.retryAfterSeconds !== null),
            maxRetryAfterSeconds: stats.throttles.reduce<number | null>((max, t) => (t.retryAfterSeconds === null ? max : Math.max(max ?? 0, t.retryAfterSeconds)), null),
            rateLimitHeaderNames: safeNames(stats.headerNames.filter((n) => RATE_HEADER.test(n)), ctx.taint),
            responseHeaderNames: safeNames(stats.headerNames, ctx.taint),
        };
        if (home === undefined) {
            return { outcome: stats.throttles.length > 0 ? 'refuted' : 'inconclusive', summary: prose`No burst was run because discovery did not complete.`, evidence };
        }
        if (stats.throttles.length > 0) {
            return { outcome: 'refuted', summary: prose`${stats.throttles.length} throttling response(s) were seen during the run.`, evidence };
        }
        return { outcome: 'confirmed', summary: prose`No 429/503 in ${stats.requests} request(s), including the burst.`, evidence };
    },
};
