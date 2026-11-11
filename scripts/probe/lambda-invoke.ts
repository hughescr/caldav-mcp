import { rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LambdaInvokeResult } from './cli';

/**
 * Invokes the probe Lambda with the AWS CLI v2. The payload (which holds the credentials)
 * goes to the CLI on stdin, never in argv or a file; the response is written to a private
 * temporary directory outside the repository, read, and removed.
 *
 * So that the credentials can only reach the intended function: the function name must be
 * caldav-mcp-probe[...], the endpoint is pinned to https://lambda.<region>.amazonaws.com for
 * a validated region, and every AWS_ENDPOINT_URL* variable is removed from the child's
 * environment. Output format, pager and auto-prompt are forced so the CLI behaves the same
 * whatever the caller's AWS configuration says.
 */
export const LAMBDA_FUNCTION_NAME = /^caldav-mcp-probe[A-Za-z0-9_-]{0,40}$/;
export const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;

export interface SpawnRequest {
    argv: string[];
    stdin: string;
    env: Record<string, string | undefined>;
}

export interface InvokeDeps {
    spawn(request: SpawnRequest): Promise<{ exitCode: number; stdout: string }>;
    makeTempDir(): Promise<string>;
    readFile(path: string): Promise<string>;
    removeDir(path: string): Promise<void>;
    env: Readonly<Record<string, string | undefined>>;
    /** Interrupt: kills the AWS CLI (the remote run itself continues). */
    signal?: AbortSignal;
    kill?: () => void;
}

/** The region the CLI should use: AWS_REGION, else AWS_DEFAULT_REGION, if well formed. */
export function invokeRegion(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    return region !== undefined && AWS_REGION_PATTERN.test(region) ? region : undefined;
}

function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
    const dropped = (key: string): boolean => key.startsWith('PROBE_') || key === 'AWS_ENDPOINT_URL' || key.startsWith('AWS_ENDPOINT_URL_')
        || key === 'AWS_DEFAULT_OUTPUT' || key === 'AWS_CLI_AUTO_PROMPT' || key === 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS';
    const out: Record<string, string | undefined> = Object.fromEntries(Object.entries(env).filter(([key]) => !dropped(key)));
    out.AWS_PAGER = '';
    // One attempt only: a retried invoke would run the probe twice.
    out.AWS_MAX_ATTEMPTS = '1';
    // Configured endpoint_url entries in ~/.aws/config are ignored too.
    out.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'true';
    return out;
}

export async function invokeProbeLambda(functionName: string, payload: string, region: string, deps: InvokeDeps): Promise<LambdaInvokeResult> {
    if (!LAMBDA_FUNCTION_NAME.test(functionName)) {
        return { ok: false, code: 'invalid_function_name' };
    }
    if (!AWS_REGION_PATTERN.test(region)) {
        return { ok: false, code: 'invalid_region' };
    }
    const dir = await deps.makeTempDir();
    const out = join(dir, 'response.json');
    const onAbort = (): void => {
        deps.kill?.();
    };
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const result = await deps.spawn({
            argv: [
                'aws', 'lambda', 'invoke', '--function-name', functionName, '--region', region, '--endpoint-url', `https://lambda.${region}.amazonaws.com`,
                '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt', '--cli-binary-format', 'raw-in-base64-out',
                '--payload', 'fileb:///dev/stdin', '--cli-read-timeout', '330', '--cli-connect-timeout', '30', out,
            ],
            stdin: payload,
            env: childEnv(deps.env),
        });
        if (deps.signal?.aborted === true) {
            return { ok: false, code: 'interrupted' };
        }
        if (result.exitCode !== 0) {
            return { ok: false, code: 'aws_cli_failed' };
        }
        const meta: unknown = JSON.parse(result.stdout);
        if (meta === null || typeof meta !== 'object') {
            return { ok: false, code: 'invoke_failed' };
        }
        if ('FunctionError' in meta && meta.FunctionError !== undefined) {
            return { ok: false, code: 'function_error' };
        }
        if (!('StatusCode' in meta) || meta.StatusCode !== 200) {
            return { ok: false, code: 'lambda_status' };
        }
        const body: unknown = JSON.parse(await deps.readFile(out));
        return { ok: true, body };
    } catch {
        return { ok: false, code: deps.signal?.aborted === true ? 'interrupted' : 'invoke_failed' };
    } finally {
        deps.signal?.removeEventListener('abort', onAbort);
        await deps.removeDir(dir).catch(() => undefined);
    }
}

/** Temporary directories made by defaultInvokeDeps and not yet removed. */
const liveTempDirs = new Set<string>();

/** For exit paths that cannot wait (a second Ctrl-C, a fatal error): removes them synchronously. */
export function removeTempDirsNow(): void {
    for (const dir of liveTempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // Nothing more can be done on the way out.
        }
        liveTempDirs.delete(dir);
    }
}

export function defaultInvokeDeps(signal?: AbortSignal): InvokeDeps {
    let child: ReturnType<typeof Bun.spawn> | undefined;
    return {
        spawn: async (request) => {
            const spawned = Bun.spawn(request.argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: request.env });
            child = spawned;
            spawned.stdin.write(request.stdin);
            await spawned.stdin.end();
            const [stdout, exitCode] = await Promise.all([new Response(spawned.stdout).text(), spawned.exited]);
            return { exitCode, stdout };
        },
        makeTempDir: async () => {
            const dir = await mkdtemp(join(tmpdir(), 'caldav-mcp-probe-'));
            liveTempDirs.add(dir);
            return dir;
        },
        readFile: (path) => readFile(path, 'utf8'),
        removeDir: async (path) => {
            await rm(path, { recursive: true, force: true });
            liveTempDirs.delete(path);
        },
        env: process.env,
        ...(signal === undefined ? {} : { signal }),
        kill: () => {
            child?.kill();
        },
    };
}
