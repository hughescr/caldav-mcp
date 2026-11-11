import { AsyncLocalStorage } from 'node:async_hooks';
interface RequestBudget { readonly getRemainingMs: () => number }
const budgets = new AsyncLocalStorage<RequestBudget>();
/** Internal server-owned scope, never populated from HTTP input. Do not cache a
 * deadline: authentication and prior dispatches consume this same live budget. */
export function withRequestBudget<T>(getRemainingMs: () => number, fn: () => T): T {
    return budgets.run({ getRemainingMs }, fn);
}
/** Read at each dispatch, after authentication. Absent Lambda context is undefined;
 * an invalid/exhausted/throwing supplied callback fails closed at zero. */
export function remainingRequestTimeMs(): number | undefined {
    const budget = budgets.getStore();
    if (!budget) { return undefined; }
    try {
        const remaining = budget.getRemainingMs();
        return typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 ? Math.floor(remaining) : 0;
    } catch { return 0; }
}
