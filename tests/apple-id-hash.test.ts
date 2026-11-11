import { expect, test } from 'bun:test';
import { accountIdFor } from '../src/account';
import { runAppleIdHash } from '../scripts/apple-id-hash';

interface Harness {
    out: string[];
    err: string[];
    prompts: number;
    io: Parameters<typeof runAppleIdHash>[1];
}

function harness(line: string | undefined, isTTY: boolean): Harness {
    const h: Harness = {
        out: [],
        err: [],
        prompts: 0,
        io: {
            isTTY,
            readLine: async () => {
                await Promise.resolve();
                return line;
            },
            stdout: (value: string) => { h.out.push(value); },
            stderr: (value: string) => { h.err.push(value); },
        },
    };
    return h;
}

test('piped input prints only the account id', async () => {
    const h = harness('  User@Example.invalid\n', false);
    expect(await runAppleIdHash([], h.io)).toBe(0);
    expect(h.out.join('')).toBe(`${accountIdFor('user@example.invalid')}\n`);
    expect(h.out.join('')).toBe('7qi6uXRosZZVGGrmSgDDG45G6nkjAoEbnHo-5fbzRR8\n');
    expect(h.err.join('')).toBe('');
});

test('a TTY gets a prompt on stderr and nothing but the id on stdout', async () => {
    const h = harness('user@example.invalid', true);
    expect(await runAppleIdHash([], h.io)).toBe(0);
    expect(h.err.join('')).toBe('Apple ID: ');
    expect(h.out.join('')).toBe(`${accountIdFor('user@example.invalid')}\n`);
});

test('any command-line argument is rejected without reading input or echoing it', async () => {
    const h = harness('user@example.invalid', false);
    expect(await runAppleIdHash(['secret.person@example.invalid'], h.io)).toBe(1);
    expect(h.out.join('')).toBe('');
    expect(h.err.join('')).toContain('arguments are not accepted');
    expect(h.err.join('')).not.toContain('secret.person');
});

test('invalid input fails with a fixed message that does not echo it', async () => {
    for (const line of ['not an apple id with secret-token', '', undefined, 'üser@example.invalid']) {
        const h = harness(line, false);
        expect(await runAppleIdHash([], h.io)).toBe(1);
        expect(h.out.join('')).toBe('');
        expect(h.err.join('')).toBe('Invalid Apple ID.\n');
    }
});

test('a failing reader fails closed without leaking its message', async () => {
    const h = harness('x', false);
    h.io.readLine = () => Promise.reject(new Error('secret reader failure'));
    expect(await runAppleIdHash([], h.io)).toBe(1);
    expect(h.out.join('')).toBe('');
    expect(h.err.join('')).not.toContain('secret');
});
