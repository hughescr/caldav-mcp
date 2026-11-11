import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs scripts/setup-deployment.sh against stub aws, gh, bun and node executables placed first
 * on PATH (tests/fixtures/setup/stub.sh). Nothing here contacts AWS or GitHub.
 */

const SCRIPT = 'scripts/setup-deployment.sh';
const STUB = 'tests/fixtures/setup/stub.sh';
const REPO = 'hughescr/caldav-mcp';
const PLACEHOLDER = 'https://placeholder.lambda-url.us-west-2.on.aws';
const BOOTSTRAP = 'caldav-mcp-bootstrap';
const SERVICE = 'caldav-mcp-prod';

/** Distinctive 43-character account hashes and a secret, so any leak into output is obvious. */
const HASH_ONE = 'CANARY-ALLOWLIST-ONE-'.padEnd(43, 'a');
const HASH_TWO = 'CANARY-ALLOWLIST-TWO-'.padEnd(43, 'b');
const ALLOWLIST = `${HASH_ONE},${HASH_TWO}`;
const ACCESS_KEY = 'sls-access-key-CANARY-9f3b27c1';

const BOOTSTRAP_DEPLOY = [
    'aws', 'cloudformation', 'deploy', '--region', 'us-west-2', '--stack-name', BOOTSTRAP,
    '--template-file', 'infra/bootstrap.yml', '--capabilities', 'CAPABILITY_NAMED_IAM',
];
const DISABLED_MESSAGE = 'Deployment is still disabled. Re-run with --enable-deploy, then release to main.';

interface Call { tool: string; args: string[]; stdin: string; env: string }
interface Result { code: number; stdout: string; stderr: string; calls: Call[] }
interface Setup {
    args?: string[];
    env?: Record<string, string>;
    /** Stack names that already exist. */
    stacks?: string[];
    /** Names of existing repository variables and secrets. */
    variables?: string[];
    secrets?: string[];
    functionUrl?: string;
    /** Stub switches, such as aws-logged-out. */
    flags?: string[];
    /** Stubs to leave off PATH. */
    without?: string[];
}

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'setup-deployment-'));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function readCalls(state: string): Promise<Call[]> {
    const dir = join(state, 'calls');
    const names = await readdir(dir).catch(() => [] as string[]);
    const count = names.filter(name => name.endsWith('.argv')).length;
    const calls: Call[] = [];
    for (let n = 1; n <= count; n++) {
        const [tool = '', ...args] = (await readFile(join(dir, `${n}.argv`), 'utf8')).split('\0').slice(0, -1);
        calls.push({
            tool, args,
            stdin: await readFile(join(dir, `${n}.stdin`), 'utf8'),
            env: await readFile(join(dir, `${n}.env`), 'utf8'),
        });
    }
    return calls;
}

async function run(setup: Setup = {}): Promise<Result> {
    const bin = join(root, 'bin');
    const state = join(root, 'state');
    await mkdir(bin);
    await mkdir(state);
    for (const tool of ['aws', 'gh', 'bun', 'node'].filter(name => !setup.without?.includes(name))) {
        await copyFile(STUB, join(bin, tool));
        await chmod(join(bin, tool), 0o755);
    }
    const files: [string, string][] = [
        ...(setup.stacks ?? []).map((name): [string, string] => [`stack.${name}`, '']),
        ...(setup.flags ?? []).map((name): [string, string] => [name, '']),
        ['variables', (setup.variables ?? []).join('\n')],
        ['secrets', (setup.secrets ?? []).join('\n')],
    ];
    if (setup.functionUrl !== undefined) { files.push(['function-url', setup.functionUrl]); }
    for (const [name, content] of files) { await writeFile(join(state, name), content); }

    const child = Bun.spawn([Bun.which('bash') ?? 'bash', SCRIPT, ...(setup.args ?? [])], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, STUB_STATE: state, ...setup.env },
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { code, stdout, stderr, calls: await readCalls(state) };
}

const line = (call: Call): string => [call.tool, ...call.args].join(' ');

/** Commands that only read. Anything else is treated as a state change. */
function isReadOnly(call: Call): boolean {
    const text = line(call);
    return /^aws sts get-caller-identity\b/.test(text)
        || /^aws cloudformation describe-stacks\b/.test(text)
        || /^gh auth status\b/.test(text)
        || /^gh (variable|secret) list\b/.test(text);
}

const changes = (result: Result): Call[] => result.calls.filter(call => !isReadOnly(call));
const changeLines = (result: Result): string[] => changes(result).map(line);
const everything = (result: Result): string => `${result.stdout}\n${result.stderr}`;
const setVariable = (name: string, value: string): string => `gh variable set ${name} --repo ${REPO} --body ${value}`;

const OUTPUT_VARIABLES = [
    setVariable('AWS_DEPLOY_ROLE_ARN', 'arn:aws:iam::123456789012:role/caldav-mcp-github-deploy'),
    setVariable('AWS_DEPLOYMENT_BUCKET_NAME', 'caldav-mcp-bootstrap-artifactbucket-1a2b3c4d5e6f'),
    setVariable('AWS_EXECUTION_ROLE_ARN', 'arn:aws:iam::123456789012:role/caldav-mcp-prod-execution'),
    setVariable('AUTH_KEYRING_PARAMETER', '/caldav-mcp/prod/auth-keyring'),
];

/** Allowlist and secret both supplied through the environment, nothing exists yet. */
const fresh: Setup = { env: { ALLOWED_APPLE_ID_HASHES: ALLOWLIST, SERVERLESS_ACCESS_KEY: ACCESS_KEY } };

describe('argument and prerequisite checks', () => {
    test('refuses an unknown argument before running anything', async () => {
        const result = await run({ ...fresh, args: ['--bogus'] });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/Unknown argument/);
        expect(result.calls).toEqual([]);
    });

    test('refuses --finish together with --enable-deploy', async () => {
        const result = await run({ ...fresh, args: ['--finish', '--enable-deploy'] });
        expect(result.code).not.toBe(0);
        expect(result.calls).toEqual([]);
    });

    const cases: [string, Setup, RegExp][] = [
        ['aws is not installed', { without: ['aws'] }, /aws/],
        ['aws is not logged in', { flags: ['aws-logged-out'] }, /aws/],
        ['gh is not installed', { without: ['gh'] }, /gh/],
        ['gh is not logged in', { flags: ['gh-logged-out'] }, /gh/],
        ['bun is not installed', { without: ['bun'] }, /bun/],
    ];
    test.each(cases)('stops with one clear line when %s', async (_name, setup, pattern) => {
        const result = await run({ ...fresh, ...setup });
        expect(result.code).not.toBe(0);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toMatch(pattern);
        expect(changes(result)).toEqual([]);
    });

    test('--finish also needs node', async () => {
        const result = await run({ args: ['--finish'], without: ['node'], stacks: [SERVICE, BOOTSTRAP] });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/node/);
        expect(changes(result)).toEqual([]);
    });
});

describe('stage 1', () => {
    test('a fresh run issues the expected commands in order, with the placeholder origin', async () => {
        const result = await run(fresh);
        expect(result.code).toBe(0);
        expect(changeLines(result)).toEqual([
            [...BOOTSTRAP_DEPLOY, '--parameter-overrides', `FunctionUrlOrigin=${PLACEHOLDER}`].join(' '),
            ...OUTPUT_VARIABLES,
            `gh variable set ALLOWED_APPLE_ID_HASHES --repo ${REPO}`,
            'bun scripts/provision-auth-keyring.ts',
            `gh secret set SERVERLESS_ACCESS_KEY --repo ${REPO}`,
        ]);
        expect(result.stdout).toContain(DISABLED_MESSAGE);
    });

    test('a re-run on an existing stack does not pass FunctionUrlOrigin, so the stored value is kept', async () => {
        const result = await run({ ...fresh, stacks: [BOOTSTRAP] });
        expect(result.code).toBe(0);
        const deploys = result.calls.filter(call => call.args[1] === 'deploy');
        expect(deploys.map(line)).toEqual([BOOTSTRAP_DEPLOY.join(' ')]);
        expect(result.calls.map(line).join('\n')).not.toContain('FunctionUrlOrigin');
        expect(result.calls.map(line).join('\n')).not.toContain('--parameter-overrides');
    });

    test('sets the repository variables from the bootstrap stack outputs', async () => {
        const result = await run({ ...fresh, stacks: [BOOTSTRAP] });
        expect(changeLines(result).filter(text => text.startsWith('gh variable set') && text.includes('--body'))).toEqual(OUTPUT_VARIABLES);
    });

    test('stops when the stack has an output that is missing', async () => {
        const result = await run({ ...fresh, stacks: [BOOTSTRAP], flags: ['no-outputs'] });
        // The stub prints None for an absent output, as the aws CLI does for a null query result.
        expect(result.code).not.toBe(0);
        expect(changeLines(result).filter(text => text.startsWith('gh variable set'))).toEqual([]);
    });

    test('leaves an existing allowlist variable and secret alone when nothing new is supplied', async () => {
        const result = await run({
            stacks: [BOOTSTRAP], variables: ['ALLOWED_APPLE_ID_HASHES', 'DEPLOY_ENABLED'], secrets: ['SERVERLESS_ACCESS_KEY'],
        });
        expect(result.code).toBe(0);
        expect(changeLines(result)).toEqual([
            BOOTSTRAP_DEPLOY.join(' '),
            ...OUTPUT_VARIABLES,
            'bun scripts/provision-auth-keyring.ts',
        ]);
    });

    test('does not replace an existing secret even when the environment supplies one', async () => {
        const result = await run({ ...fresh, stacks: [BOOTSTRAP], secrets: ['SERVERLESS_ACCESS_KEY'] });
        expect(changeLines(result).some(text => text.startsWith('gh secret set'))).toBe(false);
    });

    test('stops before changing anything when the allowlist is unset and the variable is missing', async () => {
        const result = await run({ env: { SERVERLESS_ACCESS_KEY: ACCESS_KEY } });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/ALLOWED_APPLE_ID_HASHES/);
        expect(changes(result)).toEqual([]);
    });

    test('stops before changing anything when the secret is missing and cannot be prompted for', async () => {
        const result = await run({ env: { ALLOWED_APPLE_ID_HASHES: ALLOWLIST } });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/SERVERLESS_ACCESS_KEY/);
        expect(changes(result)).toEqual([]);
    });

    test('does not go on to the next step when the bootstrap deploy fails', async () => {
        const result = await run({ ...fresh, flags: ['deploy-fails'] });
        expect(result.code).not.toBe(0);
        expect(changeLines(result)).toHaveLength(1);
    });

    test('stops on an unexpected describe-stacks failure instead of treating it as a missing stack', async () => {
        const result = await run({ ...fresh, flags: ['describe-denied'] });
        expect(result.code).not.toBe(0);
        expect(changes(result)).toEqual([]);
    });
});

describe('the allowlist', () => {
    const bad = [
        ['too short', 'A'.repeat(42)],
        ['too long', 'A'.repeat(44)],
        ['an illegal character', `${'CANARY-BAD-ENTRY+'.padEnd(43, 'c')}`],
        ['a trailing comma', `${HASH_ONE},`],
        ['an empty entry', `${HASH_ONE},,${HASH_TWO}`],
        ['a space after the comma', `${HASH_ONE}, ${HASH_TWO}`],
        ['one good and one bad entry', `${HASH_ONE},${'CANARY-SHORT'}`],
        ['a newline', `${HASH_ONE}\n`],
    ] as const;

    test.each(bad)('refuses an allowlist with %s, before any state change and without printing it', async (_name, value) => {
        const result = await run({ env: { ALLOWED_APPLE_ID_HASHES: value, SERVERLESS_ACCESS_KEY: ACCESS_KEY } });
        expect(result.code).not.toBe(0);
        expect(changes(result)).toEqual([]);
        expect(everything(result)).not.toContain('CANARY');
        expect(result.stderr).toMatch(/ALLOWED_APPLE_ID_HASHES/);
    });

    test('is passed to gh on stdin, never on the command line', async () => {
        const result = await run(fresh);
        const set = result.calls.find(call => line(call).startsWith('gh variable set ALLOWED_APPLE_ID_HASHES'));
        expect(set?.stdin).toBe(ALLOWLIST);
        expect(result.calls.flatMap(call => call.args).join(' ')).not.toContain(HASH_ONE);
    });
});

describe('secrets in output', () => {
    test('the allowlist and the access key never appear in stdout or stderr, and the key reaches gh on stdin', async () => {
        const result = await run(fresh);
        expect(result.code).toBe(0);
        expect(everything(result)).not.toContain('CANARY');
        const set = result.calls.find(call => line(call).startsWith('gh secret set SERVERLESS_ACCESS_KEY'));
        expect(set?.stdin).toBe(ACCESS_KEY);
        expect(result.calls.flatMap(call => call.args).join(' ')).not.toContain('CANARY');
    });

    test('--dry-run shows <hidden> and never the values', async () => {
        const result = await run({ ...fresh, args: ['--dry-run', '--enable-deploy'] });
        expect(result.code).toBe(0);
        expect(everything(result)).not.toContain('CANARY');
        expect(result.stdout).toContain('<hidden>');
    });
});

describe('DEPLOY_ENABLED', () => {
    test('is not touched without --enable-deploy, and the script says what remains', async () => {
        const result = await run({ ...fresh, stacks: [BOOTSTRAP] });
        expect(result.calls.map(line).join('\n')).not.toContain('DEPLOY_ENABLED');
        expect(result.stdout).toContain(DISABLED_MESSAGE);
    });

    test('is set to true last with --enable-deploy', async () => {
        const result = await run({ ...fresh, stacks: [BOOTSTRAP], args: ['--enable-deploy'] });
        expect(result.code).toBe(0);
        expect(changeLines(result).at(-1)).toBe(setVariable('DEPLOY_ENABLED', 'true'));
        expect(result.stdout).not.toContain(DISABLED_MESSAGE);
    });
});

describe('--dry-run', () => {
    test.each([[[]], [[BOOTSTRAP]]] as const)('runs no state-changing command (existing stacks: %p)', async (stacks) => {
        const result = await run({ ...fresh, stacks: [...stacks], args: ['--dry-run', '--enable-deploy'] });
        expect(result.code).toBe(0);
        expect(changes(result)).toEqual([]);
    });

    test('prints every command it would run', async () => {
        const result = await run({ ...fresh, args: ['--dry-run', '--enable-deploy'] });
        expect(result.stdout).toContain(`+ ${[...BOOTSTRAP_DEPLOY, '--parameter-overrides', `FunctionUrlOrigin=${PLACEHOLDER}`].join(' ')}`);
        expect(result.stdout).toContain(`+ printf %s <hidden> | gh variable set ALLOWED_APPLE_ID_HASHES --repo ${REPO}`);
        expect(result.stdout).toContain('+ bun scripts/provision-auth-keyring.ts');
        expect(result.stdout).toContain(`+ printf %s <hidden> | gh secret set SERVERLESS_ACCESS_KEY --repo ${REPO}`);
        expect(result.stdout).toContain(`+ gh variable set DEPLOY_ENABLED --repo ${REPO} --body true`);
    });

    test('--finish --dry-run changes nothing either', async () => {
        const result = await run({ args: ['--finish', '--dry-run'], stacks: [BOOTSTRAP, SERVICE], functionUrl: 'https://abc123xyz.lambda-url.us-west-2.on.aws/' });
        expect(result.code).toBe(0);
        expect(changes(result)).toEqual([]);
        expect(result.stdout).toContain('FunctionUrlOrigin=https://abc123xyz.lambda-url.us-west-2.on.aws');
    });
});

describe('--finish', () => {
    const url = 'https://abc123xyz.lambda-url.us-west-2.on.aws';

    test('strips the trailing slash, updates the bootstrap stack and runs the verifier', async () => {
        const result = await run({ args: ['--finish'], stacks: [BOOTSTRAP, SERVICE], functionUrl: `${url}/` });
        expect(result.code).toBe(0);
        expect(result.calls.some(call => line(call).includes(`describe-stacks --region us-west-2 --stack-name ${SERVICE}`))).toBe(true);
        expect(changeLines(result)).toEqual([
            [...BOOTSTRAP_DEPLOY, '--parameter-overrides', `FunctionUrlOrigin=${url}`].join(' '),
            'node scripts/verify-deployment.mjs',
        ]);
        const verifier = result.calls.find(call => call.tool === 'node');
        expect(verifier?.env).toContain('AWS_REGION=us-west-2');
    });

    const malformed = [
        ['an http URL', 'http://abc123xyz.lambda-url.us-west-2.on.aws/'],
        ['another host', 'https://abc123xyz.example.com/'],
        ['a path', 'https://abc123xyz.lambda-url.us-west-2.on.aws/mcp'],
        ['two trailing slashes', 'https://abc123xyz.lambda-url.us-west-2.on.aws//'],
        ['uppercase letters', 'https://ABC123.lambda-url.us-west-2.on.aws/'],
        ['an absent output', 'None'],
    ] as const;
    test.each(malformed)('refuses %s and changes nothing', async (_name, functionUrl) => {
        const result = await run({ args: ['--finish'], stacks: [BOOTSTRAP, SERVICE], functionUrl });
        expect(result.code).not.toBe(0);
        expect(changes(result)).toEqual([]);
    });

    test('stops with a clear message when the service stack does not exist yet', async () => {
        const result = await run({ args: ['--finish'], stacks: [BOOTSTRAP] });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(SERVICE);
        expect(changes(result)).toEqual([]);
    });
});

describe('static checks', () => {
    test('bash -n accepts the script', async () => {
        const check = Bun.spawn([Bun.which('bash') ?? 'bash', '-n', SCRIPT], { stdout: 'pipe', stderr: 'pipe' });
        expect(await check.exited).toBe(0);
    });

    test.skipIf(Bun.which('shellcheck') === null)('shellcheck is clean', async () => {
        const check = Bun.spawn(['shellcheck', SCRIPT, STUB], { stdout: 'pipe', stderr: 'pipe' });
        const output = await new Response(check.stdout).text();
        expect({ code: await check.exited, output }).toEqual({ code: 0, output: '' });
    });
});
