import { MemoryStore } from '../../src/auth/memory-store';
import type { AtomicStore, AtomicWrite, AuthRecord } from '../../src/auth/contracts';

/**
 * MemoryStore wrapper for tests: records the serialized form of every write so tests can
 * inspect exactly what would be persisted, and lets a test inject store failures.
 */
export class RecordingStore implements AtomicStore {
    readonly inner = new MemoryStore();
    /** JSON of every transaction passed to transact, in order, including failed ones. */
    readonly writes: string[] = [];
    failGet: ((kind: AuthRecord['kind'], id: string) => Error | undefined) | undefined;
    failTransact: ((write: AtomicWrite) => Error | undefined) | undefined;
    /** Runs before a transaction reaches the store; a returned promise suspends it at its commit point. */
    beforeTransact: ((write: AtomicWrite) => Promise<void> | undefined) | undefined;

    async get(kind: AuthRecord['kind'], id: string): Promise<AuthRecord | undefined> {
        const failure = this.failGet?.(kind, id);
        if (failure) {
            throw failure;
        }
        return this.inner.get(kind, id);
    }

    async transact(write: AtomicWrite): Promise<boolean> {
        this.writes.push(JSON.stringify(write));
        const failure = this.failTransact?.(write);
        if (failure) {
            throw failure;
        }
        await this.beforeTransact?.(write);
        return this.inner.transact(write);
    }

    /** Everything this store has been asked to persist, as one string. */
    dump(): string {
        return this.writes.join('\n');
    }
}
