import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage<string>();
/** Server-generated tool-call identifier; never use caller-supplied headers. */
export function withRequestId<T>(id: string, fn: () => T): T { return requests.run(id, fn); }
export function currentRequestId(): string | undefined { return requests.getStore(); }
