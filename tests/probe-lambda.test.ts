import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { invokeProbeLambda, type InvokeDeps, type SpawnRequest } from '../scripts/probe/lambda-invoke';
import { createHandler, parseLambdaEvent, runLambdaEvent } from '../scripts/probe/lambda';
import { DEFAULT_HTTP_LIMITS, MAX_CLEANUP_REQUESTS, ProbeHttp } from '../scripts/probe/http';
import { Taint } from '../scripts/probe/safe';
import { PLAIN, standardAccount } from './fixtures/probe/fake-icloud';
import { fakeDeps } from './fixtures/probe/harness';

const VALID = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword, flags: { write: false } };

describe('Lambda event validation', () => {
    test('accepts only well-formed events', () => {
        expect(parseLambdaEvent(VALID)).toMatchObject({ appleId: PLAIN.appleId, flags: { write: false, invite: false, cleanup: false } });
        for (const event of [
            null, 'x', [], {}, { appleId: 'x', appPassword: 'y' }, { ...VALID, appPassword: '' }, { ...VALID, appPassword: 'x'.repeat(300) },
            { ...VALID, flags: { invite: true } }, { ...VALID, flags: { write: true, invite: true, inviteConfirmed: true } },
            { ...VALID, flags: { write: true, invite: true }, inviteAttendee: 'friend@example.invalid' },
            { ...VALID, flags: { cleanup: true, write: true } }, { ...VALID, flags: { write: 'yes' } }, { ...VALID, flags: 'write' },
        ]) {
            expect(parseLambdaEvent(event)).toBeUndefined();
        }
        expect(parseLambdaEvent({ ...VALID, flags: { write: true, invite: true, inviteConfirmed: true }, inviteAttendee: 'Friend@Example.invalid' })?.inviteAttendee).toBe('friend@example.invalid');
    });

    test('runs the same core, reports lambda and the region, and writes nothing to the console', async () => {
        const writes = spyOn(process.stdout, 'write');
        const errors = spyOn(process.stderr, 'write');
        try {
            const fake = standardAccount();
            const result = await runLambdaEvent(VALID, { ...fakeDeps(fake), awsRegion: 'eu-west-1' });
            expect(result).toMatchObject({ schemaVersion: 2, runLocation: 'lambda', awsRegion: 'eu-west-1' });
            const invalid = await runLambdaEvent({ appleId: 'secret@example.invalid' }, { ...fakeDeps(fake), awsRegion: 'eu-west-1' });
            expect(invalid).toEqual({ error: 'invalid_event' });
            expect(writes).not.toHaveBeenCalled();
            expect(errors).not.toHaveBeenCalled();
        } finally {
            writes.mockRestore();
            errors.mockRestore();
        }
    });

    test('a failing core returns a fixed error', async () => {
        const result = await runLambdaEvent(VALID, { ...fakeDeps(standardAccount()), now: () => { throw new Error('secret'); }, awsRegion: null });
        expect(result).toEqual({ error: 'probe_failed' });
    });

    test('m1: the handler refuses unsafe TLS or fetch-logging settings without touching the network', async () => {
        for (const env of [{ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { BUN_CONFIG_VERBOSE_FETCH: 'curl' }]) {
            let loaded = false;
            const handler = createHandler(async () => { loaded = true; return { status: 'absent' }; }, env);
            expect(await handler(VALID)).toEqual({ error: 'unsafe_environment' });
            expect(loaded).toBe(false);
        }
    });

    test('m1: NODE_EXTRA_CA_CERTS on Lambda is recorded in the report', async () => {
        const fake = standardAccount();
        const result = await runLambdaEvent(VALID, { ...fakeDeps(fake), awsRegion: 'eu-west-1', extraCaCertsSet: true });
        expect(result).toMatchObject({ environment: { extraCaCertsSet: true } });
    });
});

describe('m3: Lambda timing leaves room for cleanup', () => {
    test('the deadline reserve covers every cleanup request at the shorter cleanup timeout', () => {
        expect(DEFAULT_HTTP_LIMITS.cleanupTimeoutMs).toBeLessThanOrEqual(8_000);
        expect(DEFAULT_HTTP_LIMITS.deadlineReserveMs).toBeGreaterThanOrEqual((MAX_CLEANUP_REQUESTS + 1) * (DEFAULT_HTTP_LIMITS.cleanupTimeoutMs + DEFAULT_HTTP_LIMITS.maxEssentialWaitMs));
        expect(DEFAULT_HTTP_LIMITS.reserveRequests).toBeGreaterThanOrEqual(MAX_CLEANUP_REQUESTS);
    });

    test('when iCloud slows to just under the cleanup timeout mid-write, cleanup still finishes before a 300 s deadline', async () => {
        for (const slowFrom of [50, 70, 120]) {
            const fake = standardAccount();
            const deps = fakeDeps(fake);
            let now = deps.now();
            const deadline = now + 300_000;
            const remainingAtSend: number[] = [];
            const report = await runLambdaEvent({ ...VALID, flags: { write: true } }, {
                ...deps,
                awsRegion: 'us-west-2',
                now: () => now,
                sleep: async (ms) => { now += ms; },
                fetch: async (input, init) => {
                    remainingAtSend.push(deadline - now);
                    now += fake.requests.length >= slowFrom ? 7_900 : 500;
                    return fake.fetch(input, init);
                },
                remainingMs: () => deadline - now,
            });
            expect(fake.requests.some((r) => r.method === 'MKCALENDAR')).toBe(true);
            expect(report).toMatchObject({ cleanup: { allRemoved: true } });
            expect(Math.min(...remainingAtSend)).toBeGreaterThan(7_900);
            expect([...fake.calendars.keys()].filter((id) => id.startsWith('caldav-mcp-probe-'))).toEqual([]);
        }
    });

    test('an essential request uses the short cleanup timeout, a normal one never runs into the reserve', async () => {
        const hang = (_u: unknown, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
        });
        const http = new ProbeHttp({
            fetch: hang, now: () => Date.now(), sleep: async () => undefined, auth: { appleId: 'a@example.invalid', appPassword: 'x' }, mode: 'read', taint: new Taint(),
            limits: { timeoutMs: 60_000, cleanupTimeoutMs: 20, deadlineReserveMs: 1_000 }, remainingMs: () => 1_030,
        });
        const started = Date.now();
        await expect(http.request({ method: 'GET', url: 'https://caldav.icloud.com/', essential: true })).rejects.toMatchObject({ code: 'timeout' });
        await expect(http.request({ method: 'GET', url: 'https://caldav.icloud.com/' })).rejects.toMatchObject({ code: 'timeout' });
        expect(Date.now() - started).toBeLessThan(5_000);
    });
});

describe('invoking the Lambda through the AWS CLI', () => {
    function deps(behaviour: { exitCode?: number; stdout?: string; body?: string; throwOnRead?: boolean }): { calls: SpawnRequest[]; removed: string[]; deps: InvokeDeps } {
        const calls: SpawnRequest[] = [];
        const removed: string[] = [];
        let written: string | undefined;
        return {
            calls,
            removed,
            deps: {
                spawn: async (request: SpawnRequest) => {
                    calls.push(request);
                    written = request.argv.at(-1);
                    return { exitCode: behaviour.exitCode ?? 0, stdout: behaviour.stdout ?? '{"StatusCode": 200, "ExecutedVersion": "$LATEST"}' };
                },
                makeTempDir: async () => `${tmpdir()}/caldav-mcp-probe-test`,
                readFile: async (path: string) => {
                    if (behaviour.throwOnRead === true || path !== written) {
                        throw new Error('no file');
                    }
                    return behaviour.body ?? '{"schemaVersion":1}';
                },
                removeDir: async (path: string) => { removed.push(path); },
                env: { PATH: '/usr/bin', AWS_PROFILE: 'probe', PROBE_APP_PASSWORD: 'abcd-efgh-ijkl-mnop', PROBE_APPLE_ID: 'person@example.invalid' },
            },
        };
    }

    test('passes the payload on stdin only, outside the repository, and removes the response file', async () => {
        const d = deps({});
        const payload = JSON.stringify({ appleId: 'person@example.invalid', appPassword: 'abcd-efgh-ijkl-mnop' });
        expect(await invokeProbeLambda('caldav-mcp-probe', payload, 'us-west-2', d.deps)).toEqual({ ok: true, body: { schemaVersion: 1 } });
        const call = d.calls[0];
        expect(call?.argv).toEqual([
            'aws', 'lambda', 'invoke', '--function-name', 'caldav-mcp-probe', '--region', 'us-west-2', '--endpoint-url', 'https://lambda.us-west-2.amazonaws.com',
            '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt', '--cli-binary-format', 'raw-in-base64-out',
            '--payload', 'fileb:///dev/stdin', '--cli-read-timeout', '330', '--cli-connect-timeout', '30', `${tmpdir()}/caldav-mcp-probe-test/response.json`,
        ]);
        expect(call?.stdin).toBe(payload);
        expect(call?.argv.join(' ')).not.toContain('abcd-efgh');
        expect(call?.argv.join(' ')).not.toContain('person@');
        expect(call?.env.PROBE_APP_PASSWORD).toBeUndefined();
        expect(call?.env.PROBE_APPLE_ID).toBeUndefined();
        expect(call?.env).toMatchObject({ AWS_PROFILE: 'probe', AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' });
        expect(call?.argv.at(-1)?.startsWith(process.cwd())).toBe(false);
        expect(d.removed).toEqual([`${tmpdir()}/caldav-mcp-probe-test`]);
    });

    test('failures return fixed codes and still remove the temporary directory', async () => {
        for (const [behaviour, code] of [
            [{ exitCode: 255 }, 'aws_cli_failed'],
            [{ stdout: '{"StatusCode":200,"FunctionError":"Unhandled"}' }, 'function_error'],
            [{ stdout: '{"StatusCode":500}' }, 'lambda_status'],
            [{ stdout: 'not json' }, 'invoke_failed'],
            [{ throwOnRead: true }, 'invoke_failed'],
            [{ body: 'not json' }, 'invoke_failed'],
        ] as const) {
            const d = deps(behaviour);
            expect(await invokeProbeLambda('caldav-mcp-probe', '{}', 'us-west-2', d.deps)).toEqual({ ok: false, code });
            expect(d.removed.length).toBe(1);
        }
    });

    test('m2: endpoint overrides are removed from the child environment, output and paging are forced', async () => {
        const d = deps({});
        d.deps.env = {
            PATH: '/usr/bin', AWS_PROFILE: 'probe', AWS_ENDPOINT_URL: 'https://attacker.example', AWS_ENDPOINT_URL_LAMBDA: 'https://attacker.example',
            AWS_ENDPOINT_URL_STS: 'https://attacker.example', AWS_DEFAULT_OUTPUT: 'text', AWS_CLI_AUTO_PROMPT: 'on', PROBE_APP_PASSWORD: 'SECRET',
        };
        await invokeProbeLambda('caldav-mcp-probe', '{"appPassword":"SECRET"}', 'eu-west-1', d.deps);
        const call = d.calls[0];
        expect(Object.keys(call?.env ?? {}).filter((k) => k.startsWith('AWS_ENDPOINT_URL') || k.startsWith('PROBE_'))).toEqual([]);
        expect(call?.env).toMatchObject({ AWS_PROFILE: 'probe', AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' });
        expect(call?.env.AWS_DEFAULT_OUTPUT).toBeUndefined();
        expect(call?.env.AWS_CLI_AUTO_PROMPT).toBeUndefined();
        expect(call?.argv).toContain('https://lambda.eu-west-1.amazonaws.com');
        expect(call?.argv.join(' ')).not.toContain('SECRET');
    });

    test('m2: an invalid function name or region never reaches the AWS CLI', async () => {
        for (const [name, region] of [['fn', 'us-west-2'], ['--write', 'us-west-2'], ['caldav-mcp-probe', 'us-west-2 --debug'], ['caldav-mcp-probe', 'evil.example']] as const) {
            const d = deps({});
            expect(await invokeProbeLambda(name, '{}', region, d.deps)).toMatchObject({ ok: false });
            expect(d.calls.length).toBe(0);
        }
    });

    test('m4: an interrupt kills the AWS CLI and still removes the temporary directory', async () => {
        const d = deps({});
        const controller = new AbortController();
        let killed = false;
        d.deps.spawn = async (request: SpawnRequest) => {
            d.calls.push(request);
            controller.abort();
            await new Promise((resolve) => { setTimeout(resolve, 5); });
            return { exitCode: killed ? 130 : 0, stdout: '' };
        };
        d.deps.signal = controller.signal;
        d.deps.kill = () => { killed = true; };
        expect(await invokeProbeLambda('caldav-mcp-probe', '{}', 'us-west-2', d.deps)).toEqual({ ok: false, code: 'interrupted' });
        expect(killed).toBe(true);
        expect(d.removed.length).toBe(1);
    });

    test('m4: directories the default deps create are tracked and can be removed synchronously on a hard exit', async () => {
        const { defaultInvokeDeps, removeTempDirsNow } = await import('../scripts/probe/lambda-invoke');
        const real = defaultInvokeDeps();
        const dir = await real.makeTempDir();
        expect(existsSync(dir)).toBe(true);
        removeTempDirsNow();
        expect(existsSync(dir)).toBe(false);
    });

    test('the default temporary directory is outside the repository', async () => {
        const { defaultInvokeDeps } = await import('../scripts/probe/lambda-invoke');
        const real = defaultInvokeDeps();
        const dir = await real.makeTempDir();
        try {
            expect(dir.startsWith(process.cwd())).toBe(false);
            expect(existsSync(dir)).toBe(true);
        } finally {
            await real.removeDir(dir);
        }
        expect(existsSync(dir)).toBe(false);
    });
});
