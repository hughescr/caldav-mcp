import { randomBytes } from 'node:crypto';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** This service's own keyring. Never shared with, or derived from, the wildduck-mcp keyring. */
export const AUTH_KEYRING_PARAMETER = '/caldav-mcp/prod/auth-keyring';

export interface KeyringParameterSender {
    send(command: PutParameterCommand): Promise<unknown>;
}

export interface ProvisionResult {
    name: string;
    state: 'created' | 'unchanged';
}

function validateName(name: string): void {
    // This one-time helper intentionally provisions only this service's production keyring.
    if (name !== AUTH_KEYRING_PARAMETER) {
        throw new Error('invalid_keyring_parameter');
    }
}

/** Never rotate or overwrite: persisted credentials depend on the original key. */
export async function provisionAuthKeyring(
    client: KeyringParameterSender,
    name = AUTH_KEYRING_PARAMETER,
): Promise<ProvisionResult> {
    validateName(name);
    try {
        await client.send(new PutParameterCommand({
            Name: name,
            Type: 'SecureString',
            Tier: 'Standard',
            KeyId: 'alias/aws/ssm',
            Overwrite: false,
            Value: JSON.stringify({
                activeKeyId: 'v1',
                keys: { v1: randomBytes(32).toString('base64') },
            }),
        }));
        return { name, state: 'created' };
    } catch (error) {
        if (error instanceof Error && error.name === 'ParameterAlreadyExists') {
            return { name, state: 'unchanged' };
        }
        // SDK errors can contain request data. Never forward their message, cause or metadata.
        throw new Error('keyring_provision_failed');
    }
}

export async function runProvisionAuthKeyring(
    args: readonly string[],
    output: { stdout: (value: string) => void; stderr: (value: string) => void },
    client?: KeyringParameterSender,
): Promise<number> {
    try {
        if (args.length > 1) {
            throw new Error('invalid_arguments');
        }
        const name = args[0] ?? AUTH_KEYRING_PARAMETER;
        validateName(name);
        // Construction is lazy: importing the module or rejecting arguments makes no AWS call.
        const sender = client ?? new SSMClient({ region: 'us-west-2', maxAttempts: 3 });
        try {
            const result = await provisionAuthKeyring(sender, name);
            output.stdout(`${JSON.stringify(result)}\n`);
            return 0;
        } finally {
            if (sender instanceof SSMClient) {
                sender.destroy();
            }
        }
    } catch {
        output.stderr('Auth keyring provisioning failed; no existing parameter was overwritten.\n');
        return 1;
    }
}

if (import.meta.main) {
    process.exitCode = await runProvisionAuthKeyring(process.argv.slice(2), {
        stdout: (value) => { process.stdout.write(value); },
        stderr: (value) => { process.stderr.write(value); },
    });
}
