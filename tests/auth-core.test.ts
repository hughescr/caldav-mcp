import { describe, expect, test } from 'bun:test';
import { createHmac, hkdfSync } from 'node:crypto';
import { AuthCrypto, connectionAAD, digest, randomId } from '../src/auth/crypto';
import { AuthEngine } from '../src/auth/engine';
import { MemoryStore } from '../src/auth/memory-store';
import { type AuthorizationCode, type BackendSessionValidator, type Connection, type Grant, TemporaryUnavailable, type UpstreamCredentials } from '../src/auth/contracts';
const VALID: BackendSessionValidator = { validate: async () => 'valid', isAllowed: () => true };
// Synthetic upstream credentials; the engine treats them as an opaque, sealed projection.
const upstream = (appPassword: string, overrides: Partial<UpstreamCredentials> = {}): UpstreamCredentials => ({ accountId: 'account', appleId: 'user@example.invalid', appPassword, principalUrl: 'https://p01-caldav.icloud.com/10000000001/principal/', calendarHomeUrl: 'https://p01-caldav.icloud.com/10000000001/calendars/', issuedAt: 1000, ...overrides });
function setup(grace: 0 | 10 = 10) {
    let now = 1000; let backend: 'valid' | 'expired' | 'temporary' = 'valid';
    const store = new MemoryStore(); const crypto = new AuthCrypto({ activeKeyId: 'k1', keys: { k1: new Uint8Array(32).fill(1) } });
    const engine = new AuthEngine(store, crypto, { validate: async () => backend, isAllowed: () => true }, { issuer: 'https://auth.example', refreshRetrySeconds: grace }, () => now);
    const client = { clientId: 'client', redirectUris: ['https://client.example/callback'] };
    const connection: Connection = { kind: 'connection', id: 'account', accountId: 'account', credentialGeneration: 1, revision: 0, status: 'active', expiresAt: 999999, credentials: crypto.seal('upstream-credentials', connectionAAD({ id: 'account', accountId: 'account', credentialGeneration: 1 }), upstream('upstream-secret')) };
    const seed = () => store.transact({ conditions: [{ kind: 'connection', id: connection.id, revision: null }], puts: [connection], operationId: randomId() });
    const verifier = 'a'.repeat(43);
    // Each call is a separate consent flow unless a flow id is passed.
    const code = (flowId = randomId()) => engine.issueCode({ client, connectionId: connection.id, redirectUri: 'https://client.example/callback', resource: engine.resource, scopes: ['calendar:read', 'calendar:write'], challenge: digest(verifier), flowId });
    const exchange = async () => engine.exchange({ client, code: await code(), verifier, redirectUri: 'https://client.example/callback', resource: engine.resource });
    return { store, crypto, engine, client, connection, seed, code, verifier, exchange, tick: (seconds: number) => { now += seconds; }, backend: (value: typeof backend) => { backend = value; } };
}
describe('sealed value lengths are pinned', () => {
    const crypto = new AuthCrypto({ activeKeyId: 'k1', keys: { k1: new Uint8Array(32).fill(7) } });
    const sealed = crypto.seal('browser-flow', 'aad', { value: 1 });
    const resized = (field: 'nonce' | 'tag', bytes: number) => ({ ...sealed, [field]: Buffer.concat([Buffer.from(sealed[field], 'base64url'), Buffer.alloc(16)]).subarray(0, bytes).toString('base64url') });
    test('a sealed value has a 12-byte nonce and a 16-byte tag', () => {
        expect(Buffer.from(sealed.nonce, 'base64url')).toHaveLength(12);
        expect(Buffer.from(sealed.tag, 'base64url')).toHaveLength(16);
        expect(crypto.open('browser-flow', 'aad', sealed)).toEqual({ value: 1 });
    });
    test.each([4, 8, 12, 15, 17])('a %i-byte tag is refused before decryption', bytes => {
        expect(() => crypto.open('browser-flow', 'aad', resized('tag', bytes))).toThrow();
    });
    test.each([8, 11, 13, 16])('a %i-byte nonce is refused before decryption', bytes => {
        expect(() => crypto.open('browser-flow', 'aad', resized('nonce', bytes))).toThrow();
    });
});
describe('auth foundation', () => {
    test('AES GCM binds tenant, purpose, generation, key version and uses fresh nonces', () => {
        const f = setup(); const aad = connectionAAD(f.connection); const sealed = f.crypto.seal('upstream-credentials', aad, { token: 'secret' });
        expect(f.crypto.open('upstream-credentials', aad, sealed)).toEqual({ token: 'secret' });
        expect(() => f.crypto.open('upstream-credentials', `${aad}x`, sealed)).toThrow();
        expect(() => f.crypto.open('other', aad, sealed)).toThrow();
        expect(f.crypto.seal('upstream-credentials', aad, {}).nonce).not.toBe(sealed.nonce);
        const rotated = new AuthCrypto({ activeKeyId: 'k2', keys: { k1: new Uint8Array(32).fill(1), k2: new Uint8Array(32).fill(2) } });
        expect(rotated.open('upstream-credentials', aad, sealed)).toEqual({ token: 'secret' });
    });
    test('code bindings are checked before atomic single use', async () => {
        const f = setup(); await f.seed(); const code = await f.code();
        const request = { client: f.client, code, verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: f.engine.resource };
        await expect(f.engine.exchange({ ...request, verifier: 'b'.repeat(43) })).rejects.toThrow('invalid_grant');
        const results = await Promise.allSettled([f.engine.exchange(request), f.engine.exchange(request)]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        await expect(f.engine.exchange(request)).rejects.toThrow('invalid_grant');
    });
    test('parallel refresh and lost response return identical receipt; replay revokes after grace', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        const request = { client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token };
        const responses = await Promise.all([f.engine.refresh(request), f.engine.refresh(request)]);
        expect(responses[0]).toEqual(responses[1]); expect(await f.engine.refresh(request)).toEqual(responses[0]);
        await expect(f.engine.verifyAccess(responses[0]?.access_token ?? '')).resolves.toMatchObject({ accountId: 'account' });
        f.tick(10); await expect(f.engine.refresh(request)).rejects.toThrow('invalid_grant');
        await expect(f.engine.verifyAccess(responses[0]?.access_token ?? '')).rejects.toThrow('invalid_token');
    });
    test('wrong client, resource, scope escalation and random tokens never revoke', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        const request = { client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token };
        await expect(f.engine.refresh({ ...request, client: { ...f.client, clientId: 'attacker' } })).rejects.toThrow('invalid_grant');
        await expect(f.engine.refresh({ ...request, resource: 'https://other/mcp' })).rejects.toThrow('invalid_grant');
        await expect(f.engine.refresh({ ...request, scopes: ['calendar:invite'] })).rejects.toThrow('invalid_scope');
        await f.engine.revoke(tokens.refresh_token, { ...f.client, clientId: 'attacker' });
        await expect(f.engine.refresh({ ...request, refreshToken: randomId() })).rejects.toThrow('invalid_grant');
        await expect(f.engine.verifyAccess(tokens.access_token)).resolves.toMatchObject({ accountId: 'account' });
    });
    test('backend temporary failure preserves code and refresh; expired sessions require reconnect', async () => {
        const f = setup(); await f.seed(); const code = await f.code();
        const request = { client: f.client, code, verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: f.engine.resource };
        f.backend('temporary'); await expect(f.engine.exchange(request)).rejects.toThrow(TemporaryUnavailable);
        f.backend('valid'); const tokens = await f.engine.exchange(request);
        f.backend('temporary'); await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow(TemporaryUnavailable);
        f.backend('expired'); await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow('invalid_grant');
        await expect(f.engine.verifyAccess(tokens.access_token)).resolves.toMatchObject({ connectionStatus: 'reconnect_required' });
    });
    test('TTL expiry is rejected while physical records remain', async () => {
        const f = setup(); await f.seed(); const code = await f.code(); f.tick(120);
        await expect(f.engine.exchange({ client: f.client, code, verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: f.engine.resource })).rejects.toThrow('invalid_grant');
        expect(await f.store.get('code', digest(code))).toBeDefined();
    });
});

test('reconnect requires same account credentials and expected generation; old receipt cannot cross reconnect', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    const credentials = upstream('new-secret');
    await expect(f.engine.connectOrReconnect({ accountId: 'account', credentials, expiresAt: 999999 })).rejects.toThrow('invalid_grant');
    await expect(f.engine.connectOrReconnect({ accountId: 'account', credentials: { ...credentials, accountId: 'other' }, expiresAt: 999999, expectedCredentialGeneration: 1 })).rejects.toThrow('invalid_request');
    const reconnected = await f.engine.connectOrReconnect({ accountId: 'account', credentials, expiresAt: 999999, expectedCredentialGeneration: 1 });
    expect(reconnected.credentialGeneration).toBe(2);
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('older generation replay and explicit revocation invalidate all outstanding access', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    const latest = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: next.refresh_token });
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
    await expect(f.engine.verifyAccess(latest.access_token)).rejects.toThrow('invalid_token');
    const fresh = await f.exchange(); await f.engine.revoke(fresh.refresh_token, f.client);
    await expect(f.engine.verifyAccess(fresh.access_token)).rejects.toThrow('invalid_token');
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: fresh.refresh_token })).rejects.toThrow('invalid_grant');
});
test('random signed-envelope failures do not perform database reads', async () => {
    const f = setup(); let reads = 0;
    const engine = new AuthEngine({ get: async () => { reads++; return undefined; }, transact: async () => { throw new Error('Unexpected write'); } }, f.crypto, VALID, { issuer: 'https://auth.example' });
    await expect(engine.verifyAccess(randomId())).rejects.toThrow('invalid_token');
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: randomId() })).rejects.toThrow('invalid_grant');
    await expect(engine.exchange({ client: f.client, resource: engine.resource, redirectUri: 'https://client.example/callback', code: randomId(), verifier: f.verifier })).rejects.toThrow('invalid_grant');
    expect(reads).toBe(0);
});
test('unknown transaction outcomes remain temporary errors and committed refresh is recoverable', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange(); let fail = true;
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => { const result = await f.store.transact(write); if (fail) { fail = false; throw new TemporaryUnavailable(); } return result; } }, f.crypto, VALID, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    const request = { client: f.client, resource: engine.resource, refreshToken: original.refresh_token };
    await expect(engine.refresh(request)).rejects.toThrow(TemporaryUnavailable);
    const recovered = await engine.refresh(request);
    await expect(engine.verifyAccess(recovered.access_token)).resolves.toMatchObject({ accountId: 'account' });
});
test('strong-read outages are temporary rather than invalid credentials', async () => {
    const f = setup(); await f.seed(); const tokens = await f.exchange();
    const engine = new AuthEngine({ get: async () => { throw new TemporaryUnavailable(); }, transact: f.store.transact.bind(f.store) }, f.crypto, VALID, { issuer: 'https://auth.example' }, () => 1000);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow(TemporaryUnavailable);
    await expect(engine.revoke(tokens.refresh_token, f.client)).rejects.toThrow(TemporaryUnavailable);
});
test('delayed expired reconnect candidate cannot overwrite a concurrent valid reconnect', async () => {
    const f = setup(); await f.seed();
    let releaseExpired: (result: 'expired') => void = () => { throw new Error('Barrier not installed'); };
    let signalStarted: () => void = () => { throw new Error('Barrier not installed'); };
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const pendingExpired = new Promise<'expired'>(resolve => { releaseExpired = resolve; });
    const engine = new AuthEngine(f.store, f.crypto, { validate: async connection => {
        const credentials = f.crypto.open<UpstreamCredentials>('upstream-credentials', connectionAAD(connection), connection.credentials);
        if (credentials.appPassword === 'expired-candidate') { signalStarted(); return pendingExpired; }
        return 'valid';
    }, isAllowed: () => true }, { issuer: 'https://auth.example' }, () => 1000);
    const common = { accountId: 'account', expiresAt: 999999, expectedCredentialGeneration: 1 };
    const failed = engine.connectOrReconnect({ ...common, credentials: upstream('expired-candidate') });
    const rejected = failed.catch(error => error as Error);
    await started;
    const winner = await engine.connectOrReconnect({ ...common, credentials: upstream('valid-candidate') });
    releaseExpired('expired'); const result = await rejected; expect(result).toBeInstanceOf(Error); if (result instanceof Error) { expect(result.message).toBe('invalid_grant'); }
    expect(await f.store.get('connection', 'account')).toEqual(winner);
    expect(winner.status).toBe('active');
});
test('old token replay after grace revokes despite a different allowed scope subset', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token, scopes: ['calendar:read'] })).rejects.toThrow('invalid_grant');
    await expect(f.engine.verifyAccess(next.access_token)).resolves.toMatchObject({ accountId: 'account' });
    f.tick(10);
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token, scopes: ['calendar:read'] })).rejects.toThrow('invalid_grant');
    await expect(f.engine.verifyAccess(next.access_token)).rejects.toThrow('invalid_token');
});
test('downscoping cannot conceal old-token replay with original explicit scopes after grace', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token, scopes: ['calendar:read'] });
    f.tick(10);
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token, scopes: ['calendar:read', 'calendar:write'] })).rejects.toThrow('invalid_grant');
    await expect(f.engine.verifyAccess(next.access_token)).rejects.toThrow('invalid_token');
});
test('receipt deadline is rechecked after awaited connection lookup before disclosure', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let now = 1000;
    const engine = new AuthEngine({ get: async (kind, id) => { const result = await f.store.get(kind, id); if (kind === 'connection') { now = 1010; } return result; }, transact: f.store.transact.bind(f.store) }, f.crypto, VALID, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => now);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
    await expect(engine.verifyAccess(next.access_token)).rejects.toThrow('invalid_token');
});
test('strict policy has a single refresh winner without a receipt retry exception', async () => {
    const f = setup(0); await f.seed(); const original = await f.exchange();
    const request = { client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token };
    const outcomes = await Promise.allSettled([f.engine.refresh(request), f.engine.refresh(request)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    await expect(f.engine.refresh(request)).rejects.toThrow('invalid_grant');
});
test('a subsequent rotation during receipt connection lookup prevents stale receipt disclosure', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let rotate = true;
    const engine = new AuthEngine({ get: async (kind, id) => { const record = await f.store.get(kind, id); if (kind === 'connection' && rotate) { rotate = false; await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: next.refresh_token }); } return record; }, transact: f.store.transact.bind(f.store) }, f.crypto, VALID, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('revocation during receipt connection lookup prevents receipt disclosure', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let revoke = true;
    const engine = new AuthEngine({ get: async (kind, id) => { const record = await f.store.get(kind, id); if (kind === 'connection' && revoke) { revoke = false; await f.engine.revoke(next.refresh_token, f.client); } return record; }, transact: f.store.transact.bind(f.store) }, f.crypto, VALID, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('receipt deadline is rechecked after the atomic authorization check completes', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let now = 1000; let checks = 0;
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => {
        const result = await f.store.transact(write);
        if (write.puts.length === 0) { checks++; now = 1010; }
        return result;
    } }, f.crypto, VALID, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => now);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
    expect(checks).toBe(1);
    await expect(engine.verifyAccess(next.access_token)).rejects.toThrow('invalid_token');
});
test('connection expiry during the atomic receipt check prevents disclosure', async () => {
    const f = setup(); await f.seed();
    await f.store.transact({ conditions: [{ kind: 'connection', id: 'account', revision: 0 }], puts: [{ ...f.connection, revision: 1, expiresAt: 1005 }], operationId: randomId() });
    const original = await f.exchange();
    await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let now = 1000;
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => {
        const result = await f.store.transact(write); if (write.puts.length === 0) { now = 1005; } return result;
    } }, f.crypto, VALID, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => now);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('grant and presented token expiry during the atomic receipt check prevents disclosure', async () => {
    const f = setup(); await f.seed();
    let now = 1000;
    const mintEngine = new AuthEngine(f.store, f.crypto, VALID, { issuer: 'https://auth.example', accessSeconds: 1, grantSeconds: 5, refreshRetrySeconds: 10 }, () => now);
    const code = await mintEngine.issueCode({ client: f.client, connectionId: 'account', redirectUri: 'https://client.example/callback', resource: mintEngine.resource, scopes: ['calendar:read'], challenge: digest(f.verifier), flowId: randomId() });
    const original = await mintEngine.exchange({ client: f.client, code, verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: mintEngine.resource });
    await mintEngine.refresh({ client: f.client, resource: mintEngine.resource, refreshToken: original.refresh_token });
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => {
        const result = await f.store.transact(write); if (write.puts.length === 0) { now = 1005; } return result;
    } }, f.crypto, VALID, { issuer: 'https://auth.example', accessSeconds: 1, grantSeconds: 5, refreshRetrySeconds: 10 }, () => now);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('receipt check temporary failure stays temporary and later recovery uses a fresh operation ID', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    const operationIds: string[] = []; let fail = true;
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => {
        if (write.puts.length === 0) { operationIds.push(write.operationId); if (fail) { fail = false; throw new TemporaryUnavailable(); } }
        return f.store.transact(write);
    } }, f.crypto, VALID, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    const request = { client: f.client, resource: engine.resource, refreshToken: original.refresh_token };
    await expect(engine.refresh(request)).rejects.toThrow(TemporaryUnavailable);
    expect(await engine.refresh(request)).toEqual(next);
    expect(operationIds).toHaveLength(2); expect(operationIds[0]).not.toBe(operationIds[1]);
});
test('reconnect during receipt connection lookup prevents old-generation receipt disclosure', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let reconnect = true;
    const engine = new AuthEngine({ get: async (kind, id) => {
        const record = await f.store.get(kind, id);
        if (kind === 'connection' && reconnect) {
            reconnect = false;
            await f.engine.connectOrReconnect({ accountId: 'account', credentials: upstream('reconnected-token'), expiresAt: 999999, expectedCredentialGeneration: 1 });
        }
        return record;
    }, transact: f.store.transact.bind(f.store) }, f.crypto, VALID, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
    const connection = await f.store.get('connection', 'account');
    expect(connection?.kind === 'connection' && connection.credentialGeneration).toBe(2);
});

describe('caldav-mcp engine adaptations', () => {
    test('domain separation pins the caldav-mcp HKDF info and AAD prefix', () => {
        const f = setup();
        const root = new Uint8Array(32).fill(1);
        const token = f.crypto.sign('test-purpose', 'payload');
        const [id, payload] = token.split('.');
        const key = Buffer.from(hkdfSync('sha256', root, 'caldav-mcp/auth/v1', 'test-purpose', 32));
        expect(token.split('.')[2]).toBe(createHmac('sha256', key).update(`${id}.${payload}`).digest('base64url'));
        const wildduckKey = Buffer.from(hkdfSync('sha256', root, 'wildduck-mcp/auth/v1', 'test-purpose', 32));
        expect(token.split('.')[2]).not.toBe(createHmac('sha256', wildduckKey).update(`${id}.${payload}`).digest('base64url'));
        expect(JSON.parse(connectionAAD(f.connection))).toEqual(['caldav-mcp', 1, 'upstream-credentials', 'account', 'account', 1]);
    });
    test('connect projects exactly the UpstreamCredentials fields and rejects incomplete credentials', async () => {
        const f = setup(); await f.seed();
        const extra = { ...upstream('fresh-secret'), injected: 'never-stored' } as UpstreamCredentials;
        const connection = await f.engine.connectOrReconnect({ accountId: 'account', credentials: extra, expiresAt: 999999, expectedCredentialGeneration: 1 });
        expect(f.crypto.open('upstream-credentials', connectionAAD(connection), connection.credentials)).toEqual(upstream('fresh-secret'));
        const invalid: Partial<UpstreamCredentials>[] = [{ appleId: '' }, { appPassword: '' }, { appPassword: 'x'.repeat(257) }, { principalUrl: '' }, { calendarHomeUrl: '' }, { principalUrl: `https://p01-caldav.icloud.com/${'x'.repeat(2048)}` }, { issuedAt: 1.5 }];
        for (const overrides of invalid) {
            await expect(f.engine.connectOrReconnect({ accountId: 'account', credentials: upstream('candidate', overrides), expiresAt: 999999, expectedCredentialGeneration: 2 })).rejects.toThrow('invalid_request');
        }
        const stored = await f.store.get('connection', 'account');
        expect(stored?.kind === 'connection' && stored.credentialGeneration).toBe(2);
    });
    test('codes accept only calendar scopes', async () => {
        const f = setup(); await f.seed();
        for (const scopes of [['mail:read'], ['profile'], ['calendar:read', 'calendar:admin'], []]) {
            await expect(f.engine.issueCode({ client: f.client, connectionId: 'account', redirectUri: 'https://client.example/callback', resource: f.engine.resource, scopes, challenge: digest(f.verifier), flowId: randomId() })).rejects.toThrow('invalid_request');
        }
        const tokens = await f.engine.exchange({ client: f.client, code: await f.engine.issueCode({ client: f.client, connectionId: 'account', redirectUri: 'https://client.example/callback', resource: f.engine.resource, scopes: ['calendar:invite', 'calendar:read'], challenge: digest(f.verifier), flowId: randomId() }), verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: f.engine.resource });
        expect(tokens.scope).toBe('calendar:invite calendar:read');
    });
    test('markReconnectRequired is a CAS on the observed connection revision', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        const observed = await f.store.get('connection', 'account'); if (observed?.kind !== 'connection') { throw new Error('missing connection'); }
        const reconnected = await f.engine.connectOrReconnect({ accountId: 'account', credentials: upstream('newer'), expiresAt: 999999, expectedCredentialGeneration: 1 });
        expect(await f.engine.markReconnectRequired(observed)).toBe(false);
        expect(await f.store.get('connection', 'account')).toEqual(reconnected);
        expect(await f.engine.markReconnectRequired(reconnected)).toBe(true);
        const marked = await f.store.get('connection', 'account');
        expect(marked).toMatchObject({ status: 'reconnect_required', credentialGeneration: 2, revision: reconnected.revision + 1 });
        await expect(f.engine.verifyAccess(tokens.access_token)).rejects.toThrow('invalid_token');
        if (marked?.kind !== 'connection') { throw new Error('missing connection'); }
        expect(await f.engine.markReconnectRequired(marked)).toBe(false);
    });
    test('a grant is valid only while its credential generation is the connection generation', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        await expect(f.engine.verifyAccess(tokens.access_token)).resolves.toMatchObject({ connectionStatus: 'active' });
        const observed = await f.store.get('connection', 'account'); if (observed?.kind !== 'connection') { throw new Error('missing connection'); }
        expect(await f.engine.markReconnectRequired(observed)).toBe(true);
        await expect(f.engine.verifyAccess(tokens.access_token)).resolves.toMatchObject({ connectionStatus: 'reconnect_required' });
        await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow('invalid_grant');
        await f.engine.connectOrReconnect({ accountId: 'account', credentials: upstream('replacement'), expiresAt: 999999, expectedCredentialGeneration: 1 });
        await expect(f.engine.verifyAccess(tokens.access_token)).rejects.toThrow('invalid_token');
        await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow('invalid_grant');
        const grant = await f.store.get('grant', f.crypto.readToken(tokens.refresh_token, 'refresh', 1000).grantId);
        expect(grant).toMatchObject({ status: 'active', credentialGeneration: 1, refreshGeneration: 0 });
        const fresh = await f.exchange();
        await expect(f.engine.verifyAccess(fresh.access_token)).resolves.toMatchObject({ connectionStatus: 'active' });
    });
    test('a grant never outlives the connection it was issued for', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        const envelope = f.crypto.readToken(tokens.refresh_token, 'refresh', 1000);
        expect(envelope.expiresAt).toBe(f.connection.expiresAt);
        expect(await f.store.get('grant', envelope.grantId)).toMatchObject({ expiresAt: f.connection.expiresAt });
    });
    test('refresh-receipt recovery is refused once the account leaves the allowlist', async () => {
        let allowed = true;
        const store = new MemoryStore(); const crypto = new AuthCrypto({ activeKeyId: 'k1', keys: { k1: new Uint8Array(32).fill(1) } });
        const engine = new AuthEngine(store, crypto, { validate: async () => 'valid', isAllowed: () => allowed }, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
        const client = { clientId: 'client', redirectUris: ['https://client.example/callback'] };
        const base = { id: 'account', accountId: 'account', credentialGeneration: 1 };
        await store.transact({ conditions: [{ kind: 'connection', id: 'account', revision: null }], puts: [{ kind: 'connection', ...base, revision: 0, status: 'active', expiresAt: 999999, credentials: crypto.seal('upstream-credentials', connectionAAD(base), upstream('secret')) }], operationId: randomId() });
        const verifier = 'a'.repeat(43);
        const code = await engine.issueCode({ client, connectionId: 'account', redirectUri: 'https://client.example/callback', resource: engine.resource, scopes: ['calendar:read'], challenge: digest(verifier), flowId: randomId() });
        const tokens = await engine.exchange({ client, code, verifier, redirectUri: 'https://client.example/callback', resource: engine.resource });
        const first = await engine.refresh({ client, resource: engine.resource, refreshToken: tokens.refresh_token });
        expect(await engine.refresh({ client, resource: engine.resource, refreshToken: tokens.refresh_token })).toEqual(first);
        allowed = false;
        await expect(engine.refresh({ client, resource: engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow('invalid_grant');
    });
});
describe('one current consent per client and account', () => {
    // Pins the stored key format: a change would orphan every consent record.
    const consentKey = (clientId: string) => digest(JSON.stringify(['caldav-mcp', 1, 'consent', 'account', clientId]));
    /** A grant exactly as the engine stored it before consent records existed, with live tokens. */
    async function legacyGrant(f: ReturnType<typeof setup>, clientId: string) {
        const grant: Grant = { kind: 'grant', id: randomId(), revision: 0, expiresAt: 999999, clientId, connectionId: 'account', accountId: 'account', resource: f.engine.resource, scopes: ['calendar:read'], status: 'active', credentialGeneration: 1, tokenVersion: 0, refreshGeneration: 0, refreshHash: '' };
        const common = { grantId: grant.id, version: 0, expiresAt: grant.expiresAt };
        const access = f.crypto.token({ ...common, kind: 'access', generation: 0, expiresAt: 1300, secret: randomId() });
        const refresh = f.crypto.token({ ...common, kind: 'refresh', generation: 0, secret: randomId() });
        grant.refreshHash = digest(refresh);
        await f.store.transact({ conditions: [{ kind: 'grant', id: grant.id, revision: null }], puts: [grant], operationId: randomId() });
        return { access, refresh };
    }
    test('a grant from before consent records stays valid until its client consents again; another client is unaffected', async () => {
        const f = setup(); await f.seed();
        const other = { clientId: 'other', redirectUris: ['https://client.example/callback'] };
        const mine = await legacyGrant(f, 'client'); const theirs = await legacyGrant(f, 'other');
        expect((await f.engine.verifyAccess(mine.access)).scopes).toEqual(['calendar:read']);
        const rotated = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: mine.refresh });
        await f.code();
        for (const token of [mine.access, rotated.access_token]) { await expect(f.engine.verifyAccess(token)).rejects.toThrow('invalid_token'); }
        await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: rotated.refresh_token })).rejects.toThrow('invalid_grant');
        expect((await f.engine.verifyAccess(theirs.access)).scopes).toEqual(['calendar:read']);
        expect((await f.engine.refresh({ client: other, resource: f.engine.resource, refreshToken: theirs.refresh })).scope).toBe('calendar:read');
    });
    test('a code issued before consent records existed is refused at exchange, with or without a current consent', async () => {
        const f = setup(); await f.seed();
        const legacyCode = async () => {
            const code = f.crypto.sign('authorization-code', randomId());
            const record: AuthorizationCode = { kind: 'code', id: digest(code), revision: 0, expiresAt: 1120, clientId: 'client', connectionId: 'account', accountId: 'account', credentialGeneration: 1, redirectUri: 'https://client.example/callback', resource: f.engine.resource, scopes: ['calendar:read'], challenge: digest(f.verifier) };
            await f.store.transact({ conditions: [{ kind: 'code', id: record.id, revision: null }], puts: [record], operationId: randomId() });
            return code;
        };
        const request = async () => ({ client: f.client, code: await legacyCode(), verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: f.engine.resource });
        await expect(f.engine.exchange(await request())).rejects.toThrow('invalid_grant');
        await f.code();
        await expect(f.engine.exchange(await request())).rejects.toThrow('invalid_grant');
    });
    test('a refresh retry inside the receipt window is refused once a newer consent replaced the grant', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        const request = { client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token };
        const first = await f.engine.refresh(request);
        expect(await f.engine.refresh(request)).toEqual(first);
        await f.code();
        await expect(f.engine.refresh(request)).rejects.toThrow('invalid_grant');
        await expect(f.engine.refresh({ ...request, refreshToken: first.refresh_token })).rejects.toThrow('invalid_grant');
    });
    test('the consent record stores the flow digest, outlives the connection generation and names the grant of the latest exchange', async () => {
        const f = setup(); await f.seed();
        const flowId = randomId();
        const code = await f.code(flowId);
        const issued = await f.store.get('consent', consentKey('client'));
        if (issued?.kind !== 'consent') { throw new Error('missing consent'); }
        expect(issued).toEqual({ kind: 'consent', id: consentKey('client'), revision: 0, expiresAt: f.connection.expiresAt, accountId: 'account', clientId: 'client', flow: digest(JSON.stringify(['caldav-mcp', 1, 'consent-flow', flowId])) });
        const tokens = await f.engine.exchange({ client: f.client, code, verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: f.engine.resource });
        const { grantId } = f.crypto.readToken(tokens.refresh_token, 'refresh', 1000);
        expect(await f.store.get('consent', consentKey('client'))).toEqual({ ...issued, revision: 1, grantId });
        // A redelivery of the same flow changes nothing; a new flow drops the grant at once.
        await f.code(flowId);
        expect(await f.store.get('consent', consentKey('client'))).toMatchObject({ revision: 1, grantId });
        await f.code();
        const replaced = await f.store.get('consent', consentKey('client'));
        expect(replaced).toMatchObject({ revision: 2, expiresAt: f.connection.expiresAt });
        expect(replaced?.kind === 'consent' && replaced.grantId).toBeUndefined();
        for (const bad of ['', 'short', 'a'.repeat(44), `${'a'.repeat(42)}=`]) { await expect(f.code(bad)).rejects.toThrow('invalid_request'); }
    });
    test('a record under the consent key that names another client is a store fault, never a pass', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        const record = await f.store.get('consent', consentKey('client'));
        const engine = new AuthEngine({ get: async (kind, id) => kind === 'consent' && record ? { ...record, clientId: 'other' } : f.store.get(kind, id), transact: write => f.store.transact(write) }, f.crypto, VALID, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
        await expect(engine.verifyAccess(tokens.access_token)).rejects.toBeInstanceOf(TemporaryUnavailable);
        await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: tokens.refresh_token })).rejects.toBeInstanceOf(TemporaryUnavailable);
    });
});
