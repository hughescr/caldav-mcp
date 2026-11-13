/**
 * Shared byte and work charges, the live deadline, abort and event-loop yielding for one tool invocation
 * (design v3 section 4). Throws the model BudgetError; the service maps it to calendar statuses. Nothing is
 * ever refunded: a failed read still consumed what it consumed.
 */
import type { ReadCharge } from '../caldav/read-contracts';
import { remainingRequestTimeMs } from '../request-budget';
import {
    CLEANUP_ABORT_MS, DAV_LAMBDA_RESERVE_MS, DAV_REQUEST_MS, DOWNLOAD_CALL_MS, MAX_AGGREGATE_BYTES, MAX_EXPANDED_VEVENTS_PER_CALENDAR, MAX_EXPANDED_VEVENTS_PER_TOOL,
    MAX_LINES_PER_RESOURCE, MAX_LINES_PER_TOOL, MAX_PROPERTIES_PER_RESOURCE, MAX_PROPERTIES_PER_TOOL, MIN_CALENDAR_START_MS, READ_CALL_MS, READ_LAMBDA_RESERVE_MS, WRITE_CALL_MS, YIELD_EVERY_COMPONENTS,
} from './limits';
import { BudgetError } from './model';

export interface BudgetOptions {
    /** Monotonic milliseconds. Defaults to performance.now. */
    now?: () => number;
    /** Live Lambda remaining time; undefined means no Lambda context. Defaults to the request budget. */
    lambdaRemainingMs?: () => number | undefined;
    /** Yields to the event loop. Defaults to a macrotask. */
    yieldFn?: () => Promise<void>;
}

export interface CalendarWork {
    chargeComponents(count: number): void;
}
export interface ResourceWork {
    chargeLines(count: number): void;
    chargeProperties(count: number): void;
}

export interface ReadBudget extends ReadCharge {
    /** Aborted when the deadline is found expired or abort() is called. */
    readonly signal: AbortSignal;
    abort(): void;
    /** Milliseconds of work time left: min(call deadline, live Lambda remaining - reserve), never negative. */
    workRemainingMs(): number;
    /** Timeout for the next buffered DAV request, or BudgetError('deadline') when no time is left. */
    requestTimeoutMs(): number;
    /** True when a new calendar may start (at least 12 s of work time left). */
    canStartCalendar(): boolean;
    throwIfExpired(): void;
    /** Milliseconds a guarded download stream may be held: remaining work time minus the cleanup reserve. */
    streamLeaseMs(): number;
    /** Time cleanup may use, at most 1 s. */
    cleanupTimeoutMs(): number;
    /** Charges bytes against the shared aggregate. Sticky once exhausted. */
    chargeBytes(bytes: number): void;
    /** A per-response charge that also charges the shared aggregate first. Per-response overflow does not exhaust the aggregate. */
    responseCharge(maxBytes: number): ReadCharge;
    bytesCharged(): number;
    newCalendarWork(): CalendarWork;
    newResourceWork(): ResourceWork;
    /** True once shared bytes or shared work capacity is spent. */
    exhausted(): boolean;
    /** Counts normalized components and yields to the event loop every 32. */
    afterComponent(count?: number): Promise<void>;
}

interface Settings { callMs: number; lambdaReserveMs: number }

function validCount(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function createBudget(settings: Settings, options: BudgetOptions): ReadBudget {
    const now = options.now ?? (() => performance.now());
    const lambdaRemaining = options.lambdaRemainingMs ?? remainingRequestTimeMs;
    const yieldFn = options.yieldFn ?? (() => new Promise<void>(resolve => { setTimeout(resolve, 0); }));
    const controller = new AbortController();
    const deadline = now() + settings.callMs;
    let bytes = 0;
    let components = 0;
    let lines = 0;
    let properties = 0;
    let bytesSpent = false;
    let workSpent = false;
    let sinceYield = 0;

    const lambdaLimit = (reserveMs: number): number => {
        const remaining = lambdaRemaining();
        return remaining === undefined ? Number.POSITIVE_INFINITY : remaining - reserveMs;
    };
    const workRemainingMs = (): number => Math.max(0, Math.floor(Math.min(deadline - now(), lambdaLimit(settings.lambdaReserveMs))));
    const expire = (): never => {
        controller.abort();
        throw new BudgetError('deadline');
    };
    const chargeShared = (kind: 'work', counter: 'components' | 'lines' | 'properties', count: number): void => {
        if (!validCount(count) || workSpent) { workSpent = true; throw new BudgetError(kind); }
        if (counter === 'components') { components += count; if (components > MAX_EXPANDED_VEVENTS_PER_TOOL) { workSpent = true; throw new BudgetError(kind); } }
        if (counter === 'lines') { lines += count; if (lines > MAX_LINES_PER_TOOL) { workSpent = true; throw new BudgetError(kind); } }
        if (counter === 'properties') { properties += count; if (properties > MAX_PROPERTIES_PER_TOOL) { workSpent = true; throw new BudgetError(kind); } }
    };
    const chargeBytes = (count: number): void => {
        if (!validCount(count)) { throw new BudgetError('aggregate_bytes'); }
        if (bytesSpent) { throw new BudgetError('aggregate_bytes'); }
        bytes += count;
        if (bytes > MAX_AGGREGATE_BYTES) { bytesSpent = true; throw new BudgetError('aggregate_bytes'); }
    };

    return {
        signal: controller.signal,
        abort: () => controller.abort(),
        workRemainingMs,
        requestTimeoutMs: () => {
            const timeout = Math.floor(Math.min(DAV_REQUEST_MS, workRemainingMs(), lambdaLimit(DAV_LAMBDA_RESERVE_MS)));
            return timeout > 0 ? timeout : expire();
        },
        canStartCalendar: () => workRemainingMs() >= MIN_CALENDAR_START_MS,
        throwIfExpired: () => { if (workRemainingMs() <= 0) { expire(); } },
        streamLeaseMs: () => Math.max(0, workRemainingMs() - CLEANUP_ABORT_MS),
        cleanupTimeoutMs: () => Math.min(CLEANUP_ABORT_MS, Math.max(0, Math.floor(lambdaLimit(0)))),
        chargeBytes,
        responseCharge: (maxBytes: number): ReadCharge => {
            let response = 0;
            return {
                chargeBytes: (count: number): void => {
                    chargeBytes(count);
                    response += count;
                    if (response > maxBytes) { throw new BudgetError('response_bytes'); }
                },
            };
        },
        bytesCharged: () => bytes,
        newCalendarWork: (): CalendarWork => {
            let calendarComponents = 0;
            return {
                chargeComponents: (count: number): void => {
                    if (!validCount(count)) { throw new BudgetError('work'); }
                    calendarComponents += count;
                    // The shared tool total is charged first and never refunded, even when the per-calendar cap fails.
                    chargeShared('work', 'components', count);
                    if (calendarComponents > MAX_EXPANDED_VEVENTS_PER_CALENDAR) { throw new BudgetError('work'); }
                },
            };
        },
        newResourceWork: (): ResourceWork => {
            let resourceLines = 0;
            let resourceProperties = 0;
            return {
                chargeLines: (count: number): void => {
                    if (!validCount(count)) { throw new BudgetError('work'); }
                    resourceLines += count;
                    chargeShared('work', 'lines', count);
                    if (resourceLines > MAX_LINES_PER_RESOURCE) { throw new BudgetError('work'); }
                },
                chargeProperties: (count: number): void => {
                    if (!validCount(count)) { throw new BudgetError('work'); }
                    resourceProperties += count;
                    chargeShared('work', 'properties', count);
                    if (resourceProperties > MAX_PROPERTIES_PER_RESOURCE) { throw new BudgetError('work'); }
                },
            };
        },
        exhausted: () => bytesSpent || workSpent,
        afterComponent: async (count = 1): Promise<void> => {
            sinceYield += count;
            if (sinceYield >= YIELD_EVERY_COMPONENTS) {
                sinceYield %= YIELD_EVERY_COMPONENTS;
                await yieldFn();
            }
        },
    };
}

/** Budget for list/search/get: 45 s of work, ending 3 s before the live Lambda deadline. */
export function createReadBudget(options: BudgetOptions = {}): ReadBudget {
    return createBudget({ callMs: READ_CALL_MS, lambdaReserveMs: READ_LAMBDA_RESERVE_MS }, options);
}

/** Budget for download: 30 s for the whole call, which begins before membership. */
export function createDownloadBudget(options: BudgetOptions = {}): ReadBudget {
    return createBudget({ callMs: DOWNLOAD_CALL_MS, lambdaReserveMs: READ_LAMBDA_RESERVE_MS }, options);
}

/** Budget for create/update/delete: 40 s for the whole call, which begins before membership. */
export function createWriteBudget(options: BudgetOptions = {}): ReadBudget {
    return createBudget({ callMs: WRITE_CALL_MS, lambdaReserveMs: READ_LAMBDA_RESERVE_MS }, options);
}
