import { createHash } from 'node:crypto';
import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type GetCommandOutput, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TemporaryUnavailable, type AtomicStore, type AtomicWrite, type AuthRecord } from './contracts';
import { SCOPES } from './http';

export interface DynamoSender {
    send(command: GetCommand | TransactWriteCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}
export interface DynamoStoreOptions {
    tableName: string; client?: DynamoSender; timeoutMs?: number;
    /** Resolve identity, region and transport at SDK construction; retries remain adapter-owned. */
    clientConfig?: Pick<DynamoDBClientConfig, 'region' | 'credentials' | 'requestHandler'>;
}
const SK = 'STATE';
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
/** A SHA-256 digest or a random id: 43 base64url characters. */
const digestText = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sealed(value: unknown): boolean {
    return object(value) && Object.keys(value).sort().join(',') === 'ciphertext,keyId,nonce,tag' && safeId(value.keyId) && typeof value.nonce === 'string' && /^[A-Za-z0-9_-]{16}$/.test(value.nonce) && typeof value.tag === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value.tag) && typeof value.ciphertext === 'string' && /^[A-Za-z0-9_-]{1,32768}$/.test(value.ciphertext);
}
function record(value: unknown): value is AuthRecord {
    if (!object(value) || !safeId(value.id) || !integer(value.revision) || !integer(value.expiresAt)) { return false; }
    const common = ['kind', 'id', 'revision', 'expiresAt', 'accountId'];
    if (!text(value.accountId)) { return false; }
    let fields: string[];
    if (value.kind === 'connection') {
        fields = ['credentialGeneration', 'status', 'credentials'];
        if (!integer(value.credentialGeneration) || (typeof value.status !== 'string' || !['active', 'reconnect_required', 'revoked'].includes(value.status)) || !sealed(value.credentials)) { return false; }
    } else if (value.kind === 'grant' || value.kind === 'code') {
        common.push('clientId', 'connectionId', 'resource', 'scopes');
        if (!text(value.clientId) || !safeId(value.connectionId) || !text(value.resource) || !Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > 16 || value.scopes.some(scope => typeof scope !== 'string' || !SCOPES.includes(scope))) { return false; }
        if (value.kind === 'code') {
            // `epoch` is absent only on codes from before consent records, which exchange refuses.
            fields = ['credentialGeneration', 'redirectUri', 'challenge', 'consumedGrantId', 'epoch'];
            if (!integer(value.credentialGeneration) || !text(value.redirectUri) || typeof value.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.challenge) || (value.consumedGrantId !== undefined && !safeId(value.consumedGrantId)) || (value.epoch !== undefined && !digestText(value.epoch))) { return false; }
        } else {
            fields = ['credentialGeneration', 'status', 'tokenVersion', 'refreshGeneration', 'refreshHash', 'previousRefreshHash', 'receiptUntil', 'receipt', 'receiptBinding'];
            if (!integer(value.credentialGeneration) || (typeof value.status !== 'string' || !['active', 'revoked'].includes(value.status)) || !integer(value.tokenVersion) || !integer(value.refreshGeneration) || typeof value.refreshHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.refreshHash) || (value.previousRefreshHash !== undefined && (typeof value.previousRefreshHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.previousRefreshHash))) || (value.receiptUntil !== undefined && !integer(value.receiptUntil)) || (value.receipt !== undefined && !sealed(value.receipt)) || (value.receiptBinding !== undefined && !text(value.receiptBinding))) { return false; }
        }
    } else if (value.kind === 'consent') {
        fields = ['clientId', 'epoch', 'grantId'];
        if (!text(value.clientId) || !digestText(value.epoch) || (value.grantId !== undefined && !digestText(value.grantId))) { return false; }
    } else if (value.kind === 'throttle') {
        fields = ['windowStart', 'failures'];
        if (value.accountId !== value.id || !integer(value.windowStart) || !integer(value.failures) || (value.failures as number) > 1000) { return false; }
    } else { return false; }
    return Object.keys(value).every(key => value[key] !== undefined && [...common, ...fields].includes(key)) && Buffer.byteLength(JSON.stringify(value)) <= 65536;
}
function key(kind: AuthRecord['kind'], id: string): { pk: string; sk: string } {
    if (!['connection', 'grant', 'code', 'consent', 'throttle'].includes(kind) || !safeId(id)) { throw new Error('Invalid auth record key'); }
    return { pk: `caldav-mcp#${kind}#${id}`, sk: SK };
}
function conditionalConflict(error: unknown, count: number): boolean {
    return object(error) && error.name === 'TransactionCanceledException' && Array.isArray(error.CancellationReasons) && error.CancellationReasons.length === count && error.CancellationReasons.every(reason => object(reason) && ['None', 'ConditionalCheckFailed'].includes(String(reason.Code))) && error.CancellationReasons.some(reason => object(reason) && reason.Code === 'ConditionalCheckFailed');
}
/** Dedicated table: pk + sk strings, expiresAt Unix seconds TTL; no indexes required. */
export class DynamoAtomicStore implements AtomicStore {
    private readonly client: DynamoSender;
    private readonly timeoutMs: number;
    constructor(private readonly options: DynamoStoreOptions) {
        if (!/^[A-Za-z0-9_.-]{3,255}$/.test(options.tableName)) { throw new Error('Invalid auth table name'); }
        this.timeoutMs = options.timeoutMs ?? 5000;
        if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 10000) { throw new Error('Invalid auth timeout'); }
        // The outer transaction loop owns retries; nested SDK retries multiply writes.
        this.client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ ...options.clientConfig, maxAttempts: 1 }), { marshallOptions: { removeUndefinedValues: false } });
    }
    private async send(command: GetCommand | TransactWriteCommand): Promise<unknown> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const request = async () => {
                for (let attempt = 0; ; attempt++) {
                    try { return await this.client.send(command, { abortSignal: controller.signal }); }
                    catch (error) {
                        if (!(command instanceof TransactWriteCommand) || attempt >= 2 || controller.signal.aborted || conditionalConflict(error, command.input.TransactItems?.length ?? 0) || (object(error) && error.name === 'IdempotentParameterMismatchException')) { throw error; }
                        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
                        if (controller.signal.aborted) { throw new TemporaryUnavailable(); }
                    }
                }
            };
            return await Promise.race([request(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TemporaryUnavailable()); }, this.timeoutMs); })]);
        } finally { clearTimeout(timer); }
    }
    async get(kind: AuthRecord['kind'], id: string): Promise<AuthRecord | undefined> {
        const expectedKey = key(kind, id);
        try {
            const result = await this.send(new GetCommand({ TableName: this.options.tableName, Key: expectedKey, ConsistentRead: true })) as GetCommandOutput;
            if (result.Item === undefined) { return undefined; }
            const { pk, sk, ...value } = result.Item;
            if (pk !== expectedKey.pk || sk !== SK || !record(value) || value.kind !== kind || value.id !== id) { throw new TemporaryUnavailable(); }
            return value;
        } catch { throw new TemporaryUnavailable(); }
    }
    async transact(write: AtomicWrite): Promise<boolean> {
        // A check-only write (conditions, no puts) is the refresh-receipt authorization point.
        if (!safeId(write.operationId) || !Array.isArray(write.conditions) || !Array.isArray(write.puts) || write.conditions.length === 0) { throw new Error('Invalid auth transaction'); }
        const conditions = new Map<string, AtomicWrite['conditions'][number]>();
        for (const condition of write.conditions) {
            if (Object.keys(condition).sort().join(',') !== 'id,kind,revision' || (condition.revision !== null && !integer(condition.revision))) { throw new Error('Invalid auth condition'); }
            const pk = key(condition.kind, condition.id).pk;
            if (conditions.has(pk)) { throw new Error('Duplicate auth condition'); }
            conditions.set(pk, condition);
        }
        const puts = new Map<string, AuthRecord>();
        for (const value of write.puts) {
            if (!record(value)) { throw new Error('Invalid auth record'); }
            const pk = key(value.kind, value.id).pk;
            const condition = conditions.get(pk);
            if (puts.has(pk) || !condition || value.revision !== (condition.revision === null ? 0 : condition.revision + 1)) { throw new Error('Unsafe auth write'); }
            puts.set(pk, value);
        }
        if (conditions.size > 100 || Buffer.byteLength(JSON.stringify(write)) > 3500000) { throw new Error('Auth transaction too large'); }
        const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [];
        for (const [pk, condition] of conditions) {
            const expression = condition.revision === null ? { ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } } : { ConditionExpression: '#revision = :revision', ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': condition.revision } };
            const value = puts.get(pk);
            if (value) { items.push({ Put: { TableName: this.options.tableName, Item: { ...value, ...key(value.kind, value.id) }, ...expression } }); }
            else { items.push({ ConditionCheck: { TableName: this.options.tableName, Key: key(condition.kind, condition.id), ...expression } }); }
        }
        try {
            await this.send(new TransactWriteCommand({ TransactItems: items, ClientRequestToken: createHash('sha256').update(write.operationId).digest('hex').slice(0, 36) }));
            return true;
        } catch (error) {
            // A cancellation is a known conflict only when all reported reasons are
            // None/ConditionalCheckFailed and at least one is ConditionalCheckFailed.
            if (conditionalConflict(error, items.length)) { return false; }
            throw new TemporaryUnavailable();
        }
    }
}
