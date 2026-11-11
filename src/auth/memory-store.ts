import type { AtomicStore, AtomicWrite, AuthRecord } from './contracts';
/** Test model only. Synchronous condition/write section models serializable transactions. */
export class MemoryStore implements AtomicStore {
    private readonly records = new Map<string, AuthRecord>();
    private readonly operations = new Map<string, string>();
    private key(kind: string, id: string): string { return `${kind}:${id}`; }
    async get(kind: AuthRecord['kind'], id: string): Promise<AuthRecord | undefined> {
        const value = this.records.get(this.key(kind, id)); return value && structuredClone(value);
    }
    async transact(write: AtomicWrite): Promise<boolean> {
        const conditionKeys = write.conditions.map(c => this.key(c.kind, c.id));
        const putKeys = write.puts.map(record => this.key(record.kind, record.id));
        if (new Set(conditionKeys).size !== conditionKeys.length || new Set(putKeys).size !== putKeys.length || putKeys.some(key => !conditionKeys.includes(key))) { throw new Error('Every unique put requires a unique condition'); }
        const payload = JSON.stringify({ conditions: write.conditions, puts: write.puts });
        const previous = this.operations.get(write.operationId);
        if (previous !== undefined) {
            if (previous !== payload) {throw new Error('Idempotency key reused with different transaction');}
            return true;
        }
        if (!write.conditions.every(c => (this.records.get(this.key(c.kind, c.id))?.revision ?? null) === c.revision)) {return false;}
        for (const value of write.puts) {this.records.set(this.key(value.kind, value.id), structuredClone(value));}
        this.operations.set(write.operationId, payload); return true;
    }
}
