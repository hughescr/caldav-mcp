import { expect, test } from 'bun:test';
import { accountIdFor } from '../src/account';
import { AuthCrypto, connectionAAD } from '../src/auth/crypto';
import { CalDavSessionValidator, readCredentials } from '../src/auth/caldav-session';
import { UnreadableCredentials, type Connection, type UpstreamCredentials } from '../src/auth/contracts';
import { CalDavError } from '../src/caldav/contracts';
import { FAKE_DISCOVERY, FakeCalDav } from './helpers/fake-caldav';

const appleId = 'user@example.invalid';
const accountId = accountIdFor(appleId);
const crypto = new AuthCrypto({ activeKeyId: 'v1', keys: { v1: new Uint8Array(32).fill(7) } });
const credentials = (overrides: Partial<UpstreamCredentials> = {}): UpstreamCredentials => ({ accountId, appleId, appPassword: 'abcd-efgh-ijkl-mnop', ...FAKE_DISCOVERY, issuedAt: 1000, ...overrides });
function connection(value: unknown = credentials(), overrides: Partial<Connection> = {}): Connection {
    const base = { kind: 'connection' as const, id: accountId, accountId, credentialGeneration: 1, revision: 0, status: 'active' as const, expiresAt: 9_999_999_999, ...overrides };
    return { ...base, credentials: crypto.seal('upstream-credentials', connectionAAD(base), value) };
}
function fixture(allowed: string[] = [accountId]) {
    const caldav = new FakeCalDav().addAccount(appleId, 'abcd-efgh-ijkl-mnop');
    return { caldav, validator: new CalDavSessionValidator(caldav, crypto, new Set(allowed)) };
}

test('a valid stored connection is checked once against iCloud with the decrypted credentials', async () => {
    const f = fixture();
    expect(await f.validator.validate(connection())).toBe('valid');
    expect(f.caldav.calls).toEqual([{ method: 'validate', appleId, appPassword: 'abcd-efgh-ijkl-mnop', discovery: { ...FAKE_DISCOVERY } }]);
});

test('upstream results pass through; a throwing backend is temporary', async () => {
    for (const result of ['expired', 'temporary'] as const) {
        const f = fixture(); f.caldav.script('validate', result);
        expect(await f.validator.validate(connection())).toBe(result);
    }
    const f = fixture(); f.caldav.script('validate', new CalDavError('unauthorized'));
    expect(await f.validator.validate(connection())).toBe('temporary');
});

test('an account removed from the allowlist is expired without any upstream request', async () => {
    const f = fixture([]);
    expect(await f.validator.validate(connection())).toBe('expired');
    expect(f.caldav.count()).toBe(0);
});

test('isAllowed reads the allowlist without any upstream request', () => {
    const f = fixture();
    expect(f.validator.isAllowed(accountId)).toBe(true);
    expect(f.validator.isAllowed(accountIdFor('other@example.invalid'))).toBe(false);
    expect(f.caldav.count()).toBe(0);
});

test('an inactive or mis-keyed connection record is temporary and makes no upstream request', async () => {
    const other = accountIdFor('other@example.invalid');
    for (const value of [connection(credentials(), { status: 'reconnect_required' }), connection(credentials(), { id: other })]) {
        const f = fixture([accountId, other]);
        expect(await f.validator.validate(value)).toBe('temporary');
        expect(f.caldav.count()).toBe(0);
    }
});

test('a credential that cannot be opened or re-validated is expired and makes no upstream request', async () => {
    const other = accountIdFor('other@example.invalid');
    const retired = new AuthCrypto({ activeKeyId: 'v0', keys: { v0: new Uint8Array(32).fill(9) } });
    const base = { kind: 'connection' as const, id: accountId, accountId, credentialGeneration: 1, revision: 0, status: 'active' as const, expiresAt: 9_999_999_999 };
    const cases: Connection[] = [
        { ...base, credentials: retired.seal('upstream-credentials', connectionAAD(base), credentials()) },
        connection(credentials({ accountId: other })),
        connection(credentials({ appleId: 'other@example.invalid' })),
        connection(credentials({ appleId: 'User@Example.invalid' })),
        connection(credentials({ appPassword: '' })),
        connection(credentials({ principalUrl: 'https://attacker.example/principal/' })),
        connection(credentials({ calendarHomeUrl: 'http://p01-caldav.icloud.com/10000000001/calendars/' })),
        connection(credentials({ calendarHomeUrl: 'https://p01-caldav.icloud.com:8443/10000000001/calendars/' })),
        connection({ ...credentials(), appPassword: 7 }),
        connection('not an object'),
        { ...connection(), credentialGeneration: 2 },
        { ...connection(), credentials: { ...connection().credentials, tag: 'A'.repeat(22) } },
    ];
    for (const value of cases) {
        const f = fixture([accountId, other]);
        expect(await f.validator.validate(value)).toBe('expired');
        expect(f.caldav.count()).toBe(0);
    }
});

test('readCredentials reports every unreadable record as UnreadableCredentials', () => {
    const retired = new AuthCrypto({ activeKeyId: 'v0', keys: { v0: new Uint8Array(32).fill(9) } });
    for (const value of [connection(credentials({ appPassword: '' })), { ...connection(), credentialGeneration: 2 }, connection('not an object')]) {
        expect(() => readCredentials(crypto, value)).toThrow(UnreadableCredentials);
    }
    expect(() => readCredentials(retired, connection())).toThrow(UnreadableCredentials);
});

test('readCredentials returns exactly the stored projection and rejects tampering', () => {
    expect(readCredentials(crypto, connection())).toEqual(credentials());
    expect(() => readCredentials(crypto, connection(credentials({ principalUrl: 'https://p01-caldav.icloud.com.attacker.example/' })))).toThrow();
    expect(() => readCredentials(crypto, connection({ ...credentials(), extra: 'field' }))).toThrow();
});
