import { expect, test } from 'bun:test';
import type { PutParameterCommand } from '@aws-sdk/client-ssm';
import {
    AUTH_KEYRING_PARAMETER,
    provisionAuthKeyring,
    runProvisionAuthKeyring,
} from '../scripts/provision-auth-keyring';

function captureOutput() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { stdout, stderr, output: {
        stdout: (value: string) => { stdout.push(value); },
        stderr: (value: string) => { stderr.push(value); },
    } };
}

test('the provisioner is pinned to this service\'s own keyring, never the wildduck-mcp one', () => {
    expect(AUTH_KEYRING_PARAMETER).toBe('/caldav-mcp/prod/auth-keyring');
});

test('provisions one Standard SecureString using the free managed key and never overwrites', async () => {
    const commands: PutParameterCommand[] = [];
    const result = await provisionAuthKeyring({ async send(command) { commands.push(command); } });
    expect(result).toEqual({ name: AUTH_KEYRING_PARAMETER, state: 'created' });
    expect(commands).toHaveLength(1);
    const input = commands[0]?.input;
    expect(input).toMatchObject({
        Name: AUTH_KEYRING_PARAMETER, Type: 'SecureString', Tier: 'Standard',
        KeyId: 'alias/aws/ssm', Overwrite: false,
    });
    const keyring = JSON.parse(input?.Value ?? 'null') as { activeKeyId: string; keys: { v1: string } };
    expect(Object.keys(keyring).sort()).toEqual(['activeKeyId', 'keys']);
    expect(keyring.activeKeyId).toBe('v1');
    expect(Object.keys(keyring.keys)).toEqual(['v1']);
    const key = Buffer.from(keyring.keys.v1, 'base64');
    expect(key.byteLength).toBe(32);
    expect(keyring.keys.v1).toBe(key.toString('base64'));
    expect(keyring.keys.v1).toMatch(/^[A-Za-z0-9+/]{43}=$/);
});

test('existing durable parameter is unchanged with no retry, read, deletion or overwrite', async () => {
    let calls = 0;
    const error = new Error('sensitive AWS request body');
    error.name = 'ParameterAlreadyExists';
    const capture = captureOutput();
    const exit = await runProvisionAuthKeyring([], capture.output, { async send(command) {
        calls++;
        expect(command.input.Overwrite).toBe(false);
        throw error;
    } });
    expect(calls).toBe(1);
    expect(exit).toBe(0);
    expect(capture.stdout).toEqual([`${JSON.stringify({ name: AUTH_KEYRING_PARAMETER, state: 'unchanged' })}\n`]);
    expect(capture.stderr).toEqual([]);
});

test('successful CLI output contains metadata only, never generated key material', async () => {
    const capture = captureOutput();
    let secret = '';
    const exit = await runProvisionAuthKeyring([AUTH_KEYRING_PARAMETER], capture.output, { async send(command) {
        secret = command.input.Value ?? '';
    } });
    expect(exit).toBe(0);
    expect(capture.stdout).toEqual([`${JSON.stringify({ name: AUTH_KEYRING_PARAMETER, state: 'created' })}\n`]);
    expect(capture.stderr).toEqual([]);
    expect(capture.stdout.join('')).not.toContain(secret);
});

test('SDK failures never expose error messages, request values, causes or metadata', async () => {
    const capture = captureOutput();
    const client = { async send(command: PutParameterCommand) {
        throw new Error(`secret-request:${command.input.Value}`, { cause: command.input });
    } };
    expect(await runProvisionAuthKeyring([], capture.output, client)).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(['Auth keyring provisioning failed; no existing parameter was overwritten.\n']);
    await expect(provisionAuthKeyring(client)).rejects.toThrow('keyring_provision_failed');
});

test('unsafe or unrelated parameter names and excess arguments fail before AWS calls', async () => {
    let calls = 0;
    const client = { async send() { calls++; } };
    for (const name of ['', '/other-service/key', '/caldav-mcp/prod/auth-keyring/extra', '/caldav-mcp/dev/auth-keyring', '/caldav-mcp/prod/../auth-keyring', '/wildduck-mcp/prod/auth-keyring', 'secret-value']) {
        await expect(provisionAuthKeyring(client, name)).rejects.toThrow('invalid_keyring_parameter');
        const capture = captureOutput();
        expect(await runProvisionAuthKeyring([name], capture.output, client)).toBe(1);
        expect(capture.stdout).toEqual([]);
        expect(capture.stderr.join('')).not.toContain(name || 'secret-value');
    }
    expect(await runProvisionAuthKeyring([AUTH_KEYRING_PARAMETER, 'extra'], captureOutput().output, client)).toBe(1);
    expect(calls).toBe(0);
});
