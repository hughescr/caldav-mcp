import { expect, test } from 'bun:test';
import { accountIdFor, normalizeAppleId } from '../src/account';

test('normalizeAppleId trims and lowercases', () => {
    expect(normalizeAppleId('  User@Example.INVALID \n')).toBe('user@example.invalid');
    expect(normalizeAppleId('a.b_c+d%e-f@x-y.example.invalid')).toBe('a.b_c+d%e-f@x-y.example.invalid');
});

test('normalizeAppleId rejects invalid shapes', () => {
    const invalid = [
        '',
        '   ',
        'no-at-sign.example.invalid',
        '@example.invalid',
        'user@',
        'us er@example.invalid',
        'user@exa mple.invalid',
        'us\ter@example.invalid',
        'üser@example.invalid',
        'user@exämple.invalid',
        'user@@example.invalid',
        `${'a'.repeat(65)}@example.invalid`,
        `user@${'a'.repeat(191)}`,
    ];
    for (const raw of invalid) {
        expect(normalizeAppleId(raw)).toBeUndefined();
    }
});

test('normalizeAppleId accepts the maximum lengths', () => {
    expect(normalizeAppleId(`${'a'.repeat(64)}@${'b'.repeat(190)}`)).toBeDefined();
});

test('accountIdFor is a 43-character base64url value', () => {
    expect(accountIdFor('user@example.invalid')).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test('accountIdFor is deterministic and distinguishes identities', () => {
    expect(accountIdFor('user@example.invalid')).toBe(accountIdFor('user@example.invalid'));
    expect(accountIdFor('user@example.invalid')).not.toBe(accountIdFor('other@example.invalid'));
});

test('accountIdFor matches an independently computed value', () => {
    // printf %s 'caldav-mcp/account/v1:user@example.invalid' | openssl dgst -sha256 -binary | basenc --base64url (padding stripped)
    expect(accountIdFor('user@example.invalid')).toBe('7qi6uXRosZZVGGrmSgDDG45G6nkjAoEbnHo-5fbzRR8');
});
