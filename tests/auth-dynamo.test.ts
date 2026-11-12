import { describe, expect, test } from 'bun:test';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoAtomicStore } from '../src/auth/dynamo-store';
import type { AtomicWrite, AuthorizationCode, Connection, Consent, LoginThrottle } from '../src/auth/contracts';
import { AuthCrypto, connectionAAD } from '../src/auth/crypto';
const connection = (id = 'conn', revision = 0): Connection => ({ kind: 'connection', id, revision, expiresAt: 2000000000, accountId: 'account', credentialGeneration: 0, status: 'active', credentials: { keyId: 'v1', nonce: 'a'.repeat(16), tag: 'a'.repeat(22), ciphertext: 'abc' } });
const write = (): AtomicWrite => ({ operationId: 'a'.repeat(43), conditions: [{ kind: 'connection', id: 'conn', revision: null }], puts: [connection()] });
/**
 * Models DynamoDB's ClientRequestToken rule: a token reused with different transaction items is
 * refused with IdempotentParameterMismatchException, so a test can reuse an operation id only for an
 * identical retry.
 */
function fixture(handler: (command: GetCommand | TransactWriteCommand) => Promise<unknown> = async () => ({}), timeoutMs = 5000) {
    const calls: (GetCommand | TransactWriteCommand)[] = [];
    const tokens = new Map<string, string>();
    const store = new DynamoAtomicStore({ tableName: 'AuthTable', timeoutMs, client: { async send(command) {
        calls.push(command);
        if (command instanceof TransactWriteCommand) {
            const token = command.input.ClientRequestToken ?? ''; const items = JSON.stringify(command.input.TransactItems);
            if ((tokens.get(token) ?? items) !== items) { throw { name: 'IdempotentParameterMismatchException' }; }
            tokens.set(token, items);
        }
        return handler(command);
    } } });
    return { calls, store };
}
describe('DynamoDB auth store', () => {
    test('strong reads use exact namespace, validate stored shape and do not write', async () => {
        const { store, calls } = fixture(async () => ({ Item: { ...connection(), pk: 'caldav-mcp#connection#conn', sk: 'STATE' } }));
        expect(await store.get('connection', 'conn')).toEqual(connection());
        expect(calls).toHaveLength(1);
        expect(calls[0]).toBeInstanceOf(GetCommand);
        expect(calls[0]?.input).toEqual({ TableName: 'AuthTable', Key: { pk: 'caldav-mcp#connection#conn', sk: 'STATE' }, ConsistentRead: true });
        for (const item of [{ ...connection(), pk: 'other', sk: 'STATE' }, { ...connection(), revision: NaN, pk: 'caldav-mcp#connection#conn', sk: 'STATE' }, { ...connection(), extra: 'injected', pk: 'caldav-mcp#connection#conn', sk: 'STATE' }]) {
            await expect(fixture(async () => ({ Item: item })).store.get('connection', 'conn')).rejects.toThrow('temporarily_unavailable');
        }
        expect(await fixture().store.get('connection', 'conn')).toBeUndefined();
        await expect(store.get('connection', 'x#grant#id')).rejects.toThrow('Invalid auth record key');
        expect(calls).toHaveLength(1);
    });
    test('mixed transactions combine put conditions without duplicate keys; stable AWS idempotency token', async () => {
        const { store, calls } = fixture();
        const transaction = write();
        transaction.conditions.push({ kind: 'connection', id: 'reader', revision: 4 });
        expect(await store.transact(transaction)).toBe(true);
        expect(await store.transact(transaction)).toBe(true);
        const first = calls[0] as TransactWriteCommand;
        expect(first.input).toEqual((calls[1] as TransactWriteCommand).input);
        expect(first.input.ClientRequestToken).toHaveLength(36);
        expect(first.input.TransactItems).toHaveLength(2);
        expect(first.input.TransactItems?.[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(#pk)');
        expect(first.input.TransactItems?.[1]?.ConditionCheck?.Key).toEqual({ pk: 'caldav-mcp#connection#reader', sk: 'STATE' });
        const update = { operationId: 'u'.repeat(43), conditions: [{ kind: 'connection' as const, id: 'conn', revision: 0 }], puts: [connection('conn', 1)] };
        expect(await store.transact(update)).toBe(true);
        // A different transaction under an operation id already used is refused, as DynamoDB refuses it.
        await expect(store.transact({ ...update, operationId: transaction.operationId })).rejects.toThrow('temporarily_unavailable');
        expect((calls[2] as TransactWriteCommand).input.TransactItems?.[0]?.Put?.ExpressionAttributeValues).toEqual({ ':revision': 0 });
    });
    test('rejects blind overwrites, duplicates and unsupported record fields before sending', async () => {
        const { store, calls } = fixture();
        const transactions = [
            { ...write(), conditions: [] },
            { ...write(), puts: [connection(), connection()] },
            { ...write(), conditions: [...write().conditions, ...write().conditions] },
            { ...write(), puts: [{ ...connection(), revision: 1 }] },
            { ...write(), puts: [{ ...connection(), pk: 'other' }] },
            { ...write(), puts: [{ ...connection(), expiresAt: Infinity }] },
        ];
        for (const transaction of transactions) { await expect(store.transact(transaction)).rejects.toThrow(); }
        expect(calls).toHaveLength(0);
    });
    test('only explicit conditional cancellation is false; throttles and unknown outcomes remain temporary', async () => {
        const failure = (value: unknown) => fixture(async () => { throw value; }).store.transact(write());
        expect(await failure({ name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] })).toBe(false);
        for (const error of [
            { name: 'TransactionCanceledException' },
            { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }] },
            { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] },
            { name: 'ThrottlingException' }, { name: 'ProvisionedThroughputExceededException' },
            { name: 'IdempotentParameterMismatchException' }, new Error('unknown commit outcome'),
        ]) { await expect(failure(error)).rejects.toThrow('temporarily_unavailable'); }
        const mixed = fixture(async () => { throw { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ProvisionedThroughputExceeded' }] }; }).store;
        await expect(mixed.transact({ ...write(), conditions: [...write().conditions, { kind: 'connection', id: 'other', revision: 1 }] })).rejects.toThrow('temporarily_unavailable');
    });
    test('a stalled SDK call is bounded and aborted', async () => {
        let signal: AbortSignal | undefined;
        const store = new DynamoAtomicStore({ tableName: 'AuthTable', timeoutMs: 5, client: { send(_command, options) { signal = options?.abortSignal; return new Promise(() => {}); } } });
        await expect(store.transact(write())).rejects.toThrow('temporarily_unavailable');
        expect(signal?.aborted).toBe(true);
    });
});

test('ambiguous delivery retries the identical transaction token and payload before success', async () => {
    let attempts = 0;
    const { store, calls } = fixture(async () => { if (++attempts === 1) { throw new Error('socket closed after commit'); } return {}; });
    expect(await store.transact(write())).toBe(true);
    expect(calls).toHaveLength(2);
    expect((calls[0] as TransactWriteCommand).input).toEqual((calls[1] as TransactWriteCommand).input);
});

test.skipIf(process.env.DYNAMO_LOCAL_AUTH_TEST !== '1')('actual DynamoDB Local: atomic CAS, mixed read conditions, 1/1 capacity and idempotent retry', async () => {
    const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, DeleteTableCommand, UpdateTimeToLiveCommand } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    // Endpoint and dummy credentials are hardcoded: this test can never reach AWS.
    const client = new DynamoDBClient({ endpoint: 'http://127.0.0.1:18765', region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, maxAttempts: 1 });
    const tableName = `AuthTest${Date.now()}`;
    try {
        await client.send(new CreateTableCommand({ TableName: tableName, AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }));
        await client.send(new UpdateTimeToLiveCommand({ TableName: tableName, TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } }));
        const store = new DynamoAtomicStore({ tableName, client: DynamoDBDocumentClient.from(client) });
        const create = write();
        expect(await store.transact(create)).toBe(true);
        expect(await store.transact(create)).toBe(true);
        expect(await store.get('connection', 'conn')).toEqual(connection());
        expect(await store.transact({ ...create, operationId: 'another-create' })).toBe(false);
        const mixed: AtomicWrite = { operationId: 'mixed-update', conditions: [{ kind: 'connection', id: 'conn', revision: 0 }, { kind: 'connection', id: 'new', revision: null }], puts: [connection('new')] };
        expect(await store.transact(mixed)).toBe(true);
        expect(await store.transact({ operationId: 'update', conditions: [{ kind: 'connection', id: 'conn', revision: 0 }], puts: [connection('conn', 1)] })).toBe(true);
        expect(await store.transact({ ...mixed, operationId: 'stale-mixed', conditions: [{ kind: 'connection', id: 'conn', revision: 0 }, { kind: 'connection', id: 'blocked', revision: null }], puts: [connection('blocked')] })).toBe(false);
        expect(await store.get('connection', 'blocked')).toBeUndefined();
        expect(await store.transact({ operationId: 'check-only', conditions: [{ kind: 'connection', id: 'conn', revision: 1 }, { kind: 'connection', id: 'new', revision: 0 }], puts: [] })).toBe(true);
        expect(await store.transact({ operationId: 'stale-check-only', conditions: [{ kind: 'connection', id: 'conn', revision: 0 }], puts: [] })).toBe(false);
        await expect(store.transact({ ...create, puts: [{ ...connection(), status: 'revoked' }] })).rejects.toThrow('temporarily_unavailable');
        const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
        expect(table.Table?.ProvisionedThroughput?.ReadCapacityUnits).toBe(1);
        expect(table.Table?.ProvisionedThroughput?.WriteCapacityUnits).toBe(1);
    } finally { await client.send(new DeleteTableCommand({ TableName: tableName })); client.destroy(); }
});

test('real SDK throttling consumes only the unified three-attempt HTTP budget', async () => {
    const { Readable } = await import('node:stream');
    let attempts = 0;
    const payloads: string[] = [];
    let failure = { __type: 'com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException', message: 'local synthetic throttle' } as Record<string, unknown>;
    // Provide transport and identity before SDK construction: its middleware
    // captures resolved providers, so mutating config later can still read the
    // host AWS configuration and fail before reaching the HTTP handler.
    const store = new DynamoAtomicStore({ tableName: 'AuthTable', timeoutMs: 5000, clientConfig: {
        region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, requestHandler: {
            async handle(request: { body?: unknown }) {
                attempts++;
                payloads.push(typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array).toString('utf8'));
                return { response: { statusCode: 400, headers: { 'content-type': 'application/x-amz-json-1.0' }, body: Readable.from([JSON.stringify(failure)]) } };
            },
        },
    } });
    await expect(store.transact(write())).rejects.toThrow('temporarily_unavailable');
    expect(attempts).toBe(3);
    expect(new Set(payloads).size).toBe(1);
    attempts = 0;
    failure = { __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] };
    expect(await store.transact(write())).toBe(false);
    expect(attempts).toBe(1);
});

describe('caldav-mcp record kinds and limits', () => {
    const accountId = 'A'.repeat(43);
    const throttle = (overrides: Record<string, unknown> = {}): LoginThrottle => ({ kind: 'throttle', id: accountId, accountId, revision: 0, expiresAt: 2000000900, windowStart: 2000000000, failures: 1, ...overrides }) as LoginThrottle;
    const code = (scopes: string[]): AuthorizationCode => ({ kind: 'code', id: 'c'.repeat(43), revision: 0, expiresAt: 2000000000, clientId: 'client', connectionId: accountId, accountId, credentialGeneration: 1, redirectUri: 'https://client.example/cb', resource: 'https://service.example/mcp', scopes, challenge: 'x'.repeat(43) });
    test('throttle records use the namespace, round-trip and are strictly validated', async () => {
        const { store, calls } = fixture(async command => command instanceof GetCommand ? { Item: { ...throttle(), pk: `caldav-mcp#throttle#${accountId}`, sk: 'STATE' } } : {});
        expect(await store.get('throttle', accountId)).toEqual(throttle());
        expect(calls[0]?.input).toMatchObject({ Key: { pk: `caldav-mcp#throttle#${accountId}`, sk: 'STATE' } });
        expect(await store.transact({ operationId: 'b'.repeat(43), conditions: [{ kind: 'throttle', id: accountId, revision: null }], puts: [throttle()] })).toBe(true);
        expect((calls[1] as TransactWriteCommand).input.TransactItems?.[0]?.Put?.Item?.pk).toBe(`caldav-mcp#throttle#${accountId}`);
        for (const bad of [throttle({ failures: -1 }), throttle({ failures: 1.5 }), throttle({ failures: 1001 }), throttle({ windowStart: 'x' }), throttle({ extra: true }), throttle({ accountId: '' }), throttle({ credentials: { keyId: 'v1', nonce: 'a'.repeat(16), tag: 'a'.repeat(22), ciphertext: 'abc' } })]) {
            await expect(store.transact({ operationId: 'b'.repeat(43), conditions: [{ kind: 'throttle', id: accountId, revision: null }], puts: [bad] })).rejects.toThrow();
        }
        expect(calls).toHaveLength(2);
    });
    test('grant and code scopes accept only calendar scopes', async () => {
        const { store, calls } = fixture();
        expect(await store.transact({ operationId: 'b'.repeat(43), conditions: [{ kind: 'code', id: 'c'.repeat(43), revision: null }], puts: [code(['calendar:read', 'calendar:write', 'calendar:invite'])] })).toBe(true);
        for (const scopes of [['mail:read'], ['profile'], ['calendar:read', 'calendar:admin'], []]) {
            await expect(store.transact({ operationId: 'b'.repeat(43), conditions: [{ kind: 'code', id: 'c'.repeat(43), revision: null }], puts: [code(scopes)] })).rejects.toThrow('Invalid auth record');
        }
        expect(calls).toHaveLength(1);
    });
    test('consent records and code epochs use the namespace, round-trip and are strictly validated', async () => {
        const id = 'k'.repeat(43);
        const consent = (overrides: Record<string, unknown> = {}): Consent => ({ kind: 'consent', id, revision: 0, expiresAt: 2000000000, accountId, clientId: 'https://client.example/metadata.json', epoch: 'e'.repeat(43), ...overrides }) as Consent;
        const { store, calls } = fixture(async command => command instanceof GetCommand ? { Item: { ...consent({ grantId: 'g'.repeat(43) }), pk: `caldav-mcp#consent#${id}`, sk: 'STATE' } } : {});
        expect(await store.get('consent', id)).toEqual(consent({ grantId: 'g'.repeat(43) }));
        expect(calls[0]?.input).toMatchObject({ Key: { pk: `caldav-mcp#consent#${id}`, sk: 'STATE' } });
        // Distinct operations use distinct operation ids; DynamoDB refuses a reused token with other items.
        expect(await store.transact({ operationId: 'b'.repeat(43), conditions: [{ kind: 'consent', id, revision: null }], puts: [consent()] })).toBe(true);
        expect(await store.transact({ operationId: 'd'.repeat(43), conditions: [{ kind: 'consent', id, revision: 0 }], puts: [consent({ revision: 1, grantId: 'g'.repeat(43) })] })).toBe(true);
        expect(await store.transact({ operationId: 'f'.repeat(43), conditions: [{ kind: 'code', id: 'c'.repeat(43), revision: null }], puts: [{ ...code(['calendar:read']), epoch: 'e'.repeat(43) }] })).toBe(true);
        // A code from before consent records has no epoch and still reads (exchange refuses it).
        expect(await store.transact({ operationId: 'h'.repeat(43), conditions: [{ kind: 'code', id: 'c'.repeat(43), revision: null }], puts: [code(['calendar:read'])] })).toBe(true);
        // The `flow` field of the superseded design is an unknown field now, on both kinds.
        for (const bad of [consent({ epoch: 'short' }), consent({ epoch: undefined }), consent({ epoch: undefined, flow: 'f'.repeat(43) }), consent({ flow: 'f'.repeat(43) }), consent({ grantId: '' }), consent({ grantId: 'g'.repeat(44) }), consent({ clientId: '' }), consent({ clientId: 'x'.repeat(4097) }), consent({ scopes: ['calendar:read'] }), consent({ extra: true })]) {
            await expect(store.transact({ operationId: 'b'.repeat(43), conditions: [{ kind: 'consent', id, revision: null }], puts: [bad] })).rejects.toThrow();
        }
        for (const bad of [{ ...code(['calendar:read']), epoch: 'short' }, { ...code(['calendar:read']), flow: 'f'.repeat(43) }]) {
            await expect(store.transact({ operationId: 'f'.repeat(43), conditions: [{ kind: 'code', id: 'c'.repeat(43), revision: null }], puts: [bad as AuthorizationCode] })).rejects.toThrow('Invalid auth record');
        }
        expect(calls).toHaveLength(5);
        for (const item of [(calls[1] as TransactWriteCommand).input.TransactItems?.[0]?.Put, (calls[3] as TransactWriteCommand).input.TransactItems?.[0]?.Put]) {
            expect(item?.ConditionExpression).toBe('attribute_not_exists(#pk)');
        }
        expect((calls[2] as TransactWriteCommand).input.TransactItems?.[0]?.Put?.ExpressionAttributeValues).toEqual({ ':revision': 0 });
    });
    test('a "record must be absent" condition with no put is sent as a ConditionCheck on that key with attribute_not_exists', async () => {
        const { store, calls } = fixture();
        const id = 'k'.repeat(43);
        expect(await store.transact({ operationId: 'b'.repeat(43), conditions: [{ kind: 'grant', id: 'g'.repeat(43), revision: 0 }, { kind: 'consent', id, revision: null }], puts: [] })).toBe(true);
        const items = (calls[0] as TransactWriteCommand).input.TransactItems ?? [];
        expect(items).toEqual([
            { ConditionCheck: { TableName: 'AuthTable', Key: { pk: `caldav-mcp#grant#${'g'.repeat(43)}`, sk: 'STATE' }, ConditionExpression: '#revision = :revision', ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': 0 } } },
            { ConditionCheck: { TableName: 'AuthTable', Key: { pk: `caldav-mcp#consent#${id}`, sk: 'STATE' }, ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } } },
        ]);
    });
    test('check-only transactions (refresh receipt authorization) are sent as condition checks', async () => {
        const { store, calls } = fixture();
        expect(await store.transact({ operationId: 'b'.repeat(43), conditions: [{ kind: 'grant', id: 'g'.repeat(43), revision: 3 }, { kind: 'connection', id: 'conn', revision: 1 }], puts: [] })).toBe(true);
        const items = (calls[0] as TransactWriteCommand).input.TransactItems ?? [];
        expect(items).toHaveLength(2);
        expect(items.every(item => item.ConditionCheck !== undefined && item.Put === undefined)).toBe(true);
        await expect(store.transact({ operationId: 'b'.repeat(43), conditions: [], puts: [] })).rejects.toThrow('Invalid auth transaction');
        expect(calls).toHaveLength(1);
    });
    test('a maximum-size sealed iCloud credential fits the record validation bounds', async () => {
        const crypto = new AuthCrypto({ activeKeyId: 'v1', keys: { v1: new Uint8Array(32).fill(5) } });
        const base = { id: accountId, accountId, credentialGeneration: 1 };
        // Worst case: maximum Apple ID, a 256-character password of characters JSON escapes to six bytes, and 2048-character URLs.
        const credentials = { accountId, appleId: `${'a'.repeat(64)}@${'b'.repeat(190)}`, appPassword: '\u0001'.repeat(256), principalUrl: `https://p01-caldav.icloud.com/${'p'.repeat(2017)}`, calendarHomeUrl: `https://p01-caldav.icloud.com/${'h'.repeat(2017)}`, issuedAt: 2000000000 };
        const sealed = crypto.seal('upstream-credentials', connectionAAD(base), credentials);
        const record: Connection = { kind: 'connection', ...base, revision: 0, expiresAt: 2000000000, status: 'active', credentials: sealed };
        const { store } = fixture();
        expect(await store.transact({ operationId: 'b'.repeat(43), conditions: [{ kind: 'connection', id: accountId, revision: null }], puts: [record] })).toBe(true);
        expect(crypto.open('upstream-credentials', connectionAAD(base), sealed)).toEqual(credentials);
    });
});
