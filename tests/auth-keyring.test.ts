import { expect, test } from 'bun:test';
import { AuthCrypto } from '../src/auth/crypto';
import { SsmKeyringProvider } from '../src/auth/keyring-provider';
const old = Buffer.alloc(32, 1).toString('base64');
const next = Buffer.alloc(32, 2).toString('base64');
const PARAMETER = '/caldav-mcp/prod/auth-keyring';
const response = (Value: string) => ({ Parameter: { Name: PARAMETER, Type: 'SecureString', Value } });
test('SSM provider is lazy, coalesces concurrent cold loads, caches at most five minutes and isolates returned key bytes', async () => {
    let calls = 0; let now = 0;
    const provider = new SsmKeyringProvider({ parameterName: PARAMETER, now: () => now, client: { async send(command) { calls++; expect(command.input).toEqual({ Name: PARAMETER, WithDecryption: true }); return response(JSON.stringify({ activeKeyId: 'v1', keys: { v1: old } })); } } });
    expect(calls).toBe(0);
    const rings = await Promise.all(Array.from({ length: 25 }, () => provider.getKeyring()));
    expect(calls).toBe(1);
    rings[0]?.keys.v1?.fill(0);
    expect((await provider.getKeyring()).keys.v1?.[0]).toBe(1);
    now = 299999; await provider.getKeyring(); expect(calls).toBe(1);
    now = 300000; await provider.getKeyring(); expect(calls).toBe(2);
});
test('rotation signs with new key while retaining old readers', async () => {
    let now = 0; let activeKeyId = 'v1';
    const provider = new SsmKeyringProvider({ parameterName: PARAMETER, now: () => now, client: { async send() { return response(JSON.stringify({ activeKeyId, keys: { v1: old, v2: next } })); } } });
    const original = new AuthCrypto(await provider.getKeyring()).sign('test', 'payload');
    now = 300001; activeKeyId = 'v2';
    const rotated = new AuthCrypto(await provider.getKeyring());
    expect(rotated.verify('test', original)).toBe('payload');
    expect(rotated.sign('test', 'new').startsWith('v2.')).toBe(true);
});
test('secret failures are sanitized, are not cached, and expired keys fail closed', async () => {
    let now = 0; let calls = 0;
    const provider = new SsmKeyringProvider({ parameterName: PARAMETER, now: () => now, client: { async send() { calls++; if (calls === 1) { return response(JSON.stringify({ activeKeyId: 'v1', keys: { v1: old } })); } throw new Error(`sensitive-value-${old}`); } } });
    await provider.getKeyring(); now = 300001;
    for (let attempt = 0; attempt < 2; attempt++) { try { await provider.getKeyring(); throw new Error('expected rejection'); } catch (error) { expect(String(error)).toBe('Error: temporarily_unavailable'); } }
    expect(calls).toBe(3);
});
test('strict keyring parser rejects malformed, oversized, missing, noncanonical or unsafe keys', async () => {
    const invalid = ['not json', ' '.repeat(4097), JSON.stringify({ activeKeyId: 'v1', keys: {} }), JSON.stringify({ activeKeyId: 'missing', keys: { v1: old } }), JSON.stringify({ activeKeyId: 'v1', keys: { v1: 'bad' } }), JSON.stringify({ activeKeyId: 'v1', keys: { v1: old.replace('=', '') } }), JSON.stringify({ activeKeyId: 'v1', keys: { v1: old }, extra: true }), '{"activeKeyId":"__proto__","keys":{"__proto__":"' + old + '"}}'];
    for (const raw of invalid) {
        const provider = new SsmKeyringProvider({ parameterName: PARAMETER, client: { async send() { return response(raw); } } });
        await expect(provider.getKeyring()).rejects.toThrow('temporarily_unavailable');
    }
    for (const result of [{ Parameter: { ...response('{}').Parameter, Type: 'String' } }, { Parameter: { ...response('{}').Parameter, Name: '/different' } }, {}]) {
        await expect(new SsmKeyringProvider({ parameterName: PARAMETER, client: { async send() { return result; } } }).getKeyring()).rejects.toThrow('temporarily_unavailable');
    }
});
test('configuration and stalled requests are bounded', async () => {
    for (const parameterName of ['', 'not/a/path', '/aws/secret', '/ssm/secret', '/caldav-mcp//key']) { expect(() => new SsmKeyringProvider({ parameterName })).toThrow(); }
    expect(() => new SsmKeyringProvider({ parameterName: '/valid', cacheMs: 300001 })).toThrow();
    let signal: AbortSignal | undefined;
    const provider = new SsmKeyringProvider({ parameterName: '/valid', timeoutMs: 5, client: { send(_command, options) { signal = options?.abortSignal; return new Promise(() => {}); } } });
    await expect(provider.getKeyring()).rejects.toThrow('temporarily_unavailable');
    expect(signal?.aborted).toBe(true);
});
