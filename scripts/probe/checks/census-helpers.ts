import { CheckStop } from '../context';
import { ProbeHttpError } from '../http';
import { fixed, sortedSafe } from '../safe';
import type { Evidence } from '../types';
import { RUN_LEVEL_STOPS } from './queries';

export type Attempt<T> =
    | { ok: true; value: T }
    | { ok: false; stop: boolean; code: string | null; status: number | null; retryAfterSeconds: number | null };

/**
 * Runs one request of a loop over calendars. A 429/503 or a run-level stop ends the loop
 * (`stop`); any other failure (timeout, oversized body, network) skips only this calendar.
 */
export async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
    try {
        return { ok: true, value: await fn() };
    } catch (error) {
        if (error instanceof CheckStop) {
            const status = error.evidence.status;
            const retry = error.evidence.retryAfterSeconds;
            return { ok: false, stop: true, code: null, status: typeof status === 'number' ? status : null, retryAfterSeconds: typeof retry === 'number' ? retry : null };
        }
        if (error instanceof ProbeHttpError) {
            return { ok: false, stop: RUN_LEVEL_STOPS.has(error.code), code: error.code, status: null, retryAfterSeconds: null };
        }
        throw error;
    }
}

/** What went wrong across the requests of one check, as fixed codes and numbers. */
export class Failures {
    stopped = false;
    count = 0;
    private readonly codes = new Set<string>();
    private status: number | null = null;
    private retryAfter: number | null = null;

    record(failed: Extract<Attempt<unknown>, { ok: false }>): void {
        this.count++;
        this.stopped = this.stopped || failed.stop;
        if (failed.code !== null) {
            this.codes.add(failed.code);
        }
        if (failed.status !== null) {
            this.status = failed.status;
            this.retryAfter = failed.retryAfterSeconds;
        }
    }

    evidence(): Evidence {
        return {
            requestFailures: this.count,
            stoppedEarly: this.stopped,
            requestErrors: sortedSafe([...this.codes].map(fixed)),
            ...(this.status === null ? {} : { stopStatus: this.status, retryAfterSeconds: this.retryAfter }),
        };
    }
}

export function bump(record: Record<string, number>, key: string, by = 1): void {
    record[key] = (record[key] ?? 0) + by;
}
