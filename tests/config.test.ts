import { expect, test } from 'bun:test';
import { loadConfig } from '../src/config';
import { accountIdFor } from '../src/account';

const first = accountIdFor('first@example.invalid');
const second = accountIdFor('second@example.invalid');

test('an empty environment is a safe, fail-closed configuration', () => {
    const config = loadConfig({});
    expect(config.publicBaseUrl).toBeUndefined();
    expect(config.credentialTableName).toBeUndefined();
    expect(config.authKeyringParameter).toBeUndefined();
    expect(config.allowedAccountIds.size).toBe(0);
});

test('a canonical HTTPS origin, table and keyring parameter are accepted', () => {
    const config = loadConfig({ PUBLIC_BASE_URL: 'https://calendar.example.invalid/', CREDENTIAL_TABLE_NAME: 'caldav-mcp-prod-state', AUTH_KEYRING_PARAMETER: '/caldav-mcp/prod/auth-keyring' });
    expect(config).toMatchObject({ publicBaseUrl: 'https://calendar.example.invalid', credentialTableName: 'caldav-mcp-prod-state', authKeyringParameter: '/caldav-mcp/prod/auth-keyring' });
});

test.each(['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?secret=value', 'https://example.com/#fragment', 'not a url'])('reject unsafe issuer %s', value => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: value })).toThrow();
});

test('the allowlist parses comma-separated account ids', () => {
    expect([...loadConfig({ ALLOWED_APPLE_ID_HASHES: first }).allowedAccountIds]).toEqual([first]);
    expect([...loadConfig({ ALLOWED_APPLE_ID_HASHES: `${first},${second}` }).allowedAccountIds]).toEqual([first, second]);
    expect([...loadConfig({ ALLOWED_APPLE_ID_HASHES: ` ${first} , ${second} ` }).allowedAccountIds]).toEqual([first, second]);
    expect(loadConfig({ ALLOWED_APPLE_ID_HASHES: '' }).allowedAccountIds.size).toBe(0);
});

test('the allowlist is read-only to callers', () => {
    const allowed = loadConfig({ ALLOWED_APPLE_ID_HASHES: first }).allowedAccountIds;
    expect(() => (allowed as Set<string>).add(second)).toThrow();
    expect(allowed.has(second)).toBe(false);
});

test.each([
    ['a raw Apple ID', 'first@example.invalid'],
    ['a short hash', first.slice(1)],
    ['a long hash', `${first}A`],
    ['a non-base64url character', `${first.slice(1)}=`],
    ['an empty entry', `${first},,${second}`],
    ['a trailing comma', `${first},`],
    ['whitespace only', '   '],
])('a malformed allowlist (%s) throws at load', (_label, value) => {
    expect(() => loadConfig({ ALLOWED_APPLE_ID_HASHES: value })).toThrow('ALLOWED_APPLE_ID_HASHES');
});

test('a malformed allowlist error does not echo the offending value', () => {
    try {
        loadConfig({ ALLOWED_APPLE_ID_HASHES: 'private.person@example.invalid' });
        throw new Error('expected rejection');
    } catch (error) {
        expect(String(error)).not.toContain('private.person');
    }
});

test.each([
    ['CREDENTIAL_TABLE_NAME', 'bad table name!'],
    ['AUTH_KEYRING_PARAMETER', 'not/a/path'],
    ['AUTH_KEYRING_PARAMETER', '/aws/reserved'],
])('malformed %s throws at load', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
});

test('disabled TLS certificate verification refuses to start', () => {
    expect(() => loadConfig({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(() => loadConfig({ NODE_TLS_REJECT_UNAUTHORIZED: '0', ALLOWED_APPLE_ID_HASHES: first, PUBLIC_BASE_URL: 'https://calendar.example.invalid' })).toThrow('NODE_TLS_REJECT_UNAUTHORIZED');
    for (const value of [undefined, '1', '']) {
        expect(loadConfig({ NODE_TLS_REJECT_UNAUTHORIZED: value }).allowedAccountIds.size).toBe(0);
    }
});

test('removed wildduck settings are not part of the configuration', () => {
    const config = loadConfig({ WILDDUCK_DOT_AS_PLUS: 'true', DOWNLOAD_BUCKET_NAME: 'bucket' }) as unknown as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(['allowedAccountIds']);
});
