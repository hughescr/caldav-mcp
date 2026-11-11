import { describe, expect, test } from 'bun:test';
import { runCli, type CliIo, type CliRuntime } from '../scripts/probe/cli';
import type { Safe } from '../scripts/probe/safe';
import type { ProbeInput, ProbeReport } from '../scripts/probe/types';

function fakeReport(overrides: Partial<ProbeReport> = {}): ProbeReport {
    return {
        schemaVersion: 2,
        probeVersion: '0.1.0',
        generatedAt: '2026-11-11T12:00:00.000Z',
        runLocation: 'local',
        awsRegion: null,
        mode: { readOnly: true, write: false, invite: false, cleanup: false },
        totals: { requests: 3, durationMs: 10, outcomes: { confirmed: 1, refuted: 0, inconclusive: 0, skipped: 0, error: 0 } },
        cleanup: null,
        auth: { rejected: false, onFirstRequest: false },
        environment: { extraCaCertsSet: false },
        checks: [{ id: 'discovery', planItem: 'p', claim: 'c', outcome: 'confirmed', summary: 's', evidence: { status: 207 } }],
        redaction: { scrubbedOccurrences: 0 },
        ...overrides,
    };
}

interface Harness {
    io: CliIo;
    runtime: CliRuntime;
    out: string[];
    err: string[];
    prompts: { kind: 'line' | 'hidden'; question: string }[];
    inputs: ProbeInput[];
    payloads: { name: string; payload: string; region: string }[];
    cleanupAnswers: boolean[];
}

function harness(options: { env?: Record<string, string>; tty?: boolean; answers?: (string | undefined)[]; report?: ProbeReport; lambdaBody?: unknown; probeThrows?: boolean; cleanupNames?: string[] } = {}): Harness {
    const answers = [...(options.answers ?? [])];
    const h: Harness = {
        out: [], err: [], prompts: [], inputs: [], payloads: [], cleanupAnswers: [],
        io: {
            env: options.env ?? {},
            isTTY: options.tty ?? false,
            promptLine: async (question) => {
                h.prompts.push({ kind: 'line', question });
                return answers.shift();
            },
            promptHidden: async (question) => {
                h.prompts.push({ kind: 'hidden', question });
                return answers.shift();
            },
            stdout: (t) => { h.out.push(t); },
            stderr: (t) => { h.err.push(t); },
        },
        runtime: {
            probe: async (input, hooks) => {
                h.inputs.push(input);
                if (options.probeThrows === true) {
                    throw new Error(`boom ${input.appPassword}`);
                }
                if (options.cleanupNames !== undefined) {
                    h.cleanupAnswers.push(await hooks.confirmCleanup({ names: options.cleanupNames }));
                }
                return options.report ?? fakeReport();
            },
            invokeLambda: async (name, payload, region) => {
                h.payloads.push({ name, payload, region });
                return { ok: true, body: options.lambdaBody ?? fakeReport({ runLocation: 'lambda', awsRegion: 'us-west-2' }) };
            },
        },
    };
    return h;
}

const ENV = { PROBE_APPLE_ID: 'Person@Example.invalid', PROBE_APP_PASSWORD: ' abcd-efgh-ijkl-mnop ' };

describe('arguments', () => {
    test('anything unknown or credential-like is refused with exit 2 and never echoed', async () => {
        for (const argv of [
            ['--password', 'hunter2secret'], ['person@example.invalid'], ['--apple-id=person@example.invalid'], ['-p'],
            ['--write', 'hunter2secret'], ['--lambda'], ['--lambda', 'person@example.invalid'], ['--lambda', 'name with space'],
            ['--lambda=fn'], ['--JSON'], ['abcd-efgh-ijkl-mnop'],
            // m2: only caldav-mcp-probe* function names; a following flag is never taken as the name.
            ['--lambda', '--write'], ['--lambda', 'fn'], ['--lambda', 'caldav-probe-test'], ['--lambda', 'arn:aws:lambda:us-west-2:123456789012:function:caldav-mcp-probe'],
            ['--lambda', `caldav-mcp-probe${'x'.repeat(41)}`], ['--lambda', 'caldav-mcp-probe.x'], ['--lambda', '-caldav-mcp-probe'],
        ]) {
            const h = harness({ env: ENV });
            expect(await runCli(argv, h.io, h.runtime)).toBe(2);
            const all = h.err.join('') + h.out.join('');
            expect(all).not.toContain('hunter2secret');
            expect(all).not.toContain('person@example');
            expect(all).not.toContain('abcd-efgh');
            expect(all).toContain('never accepted on the command line');
            expect(h.inputs.length + h.payloads.length + h.prompts.length).toBe(0);
        }
    });

    test('flag combinations are validated', async () => {
        for (const argv of [['--invite'], ['--cleanup', '--write'], ['--cleanup', '--invite', '--write']]) {
            const h = harness({ env: ENV });
            expect(await runCli(argv, h.io, h.runtime)).toBe(2);
            expect(h.inputs.length).toBe(0);
        }
    });

    test('--help prints usage without asking for credentials', async () => {
        const h = harness();
        expect(await runCli(['--help'], h.io, h.runtime)).toBe(0);
        expect(h.out.join('')).toContain('--write');
        expect(h.prompts.length).toBe(0);
    });
});

describe('credentials', () => {
    test('come from the environment, normalised and trimmed', async () => {
        const h = harness({ env: ENV });
        expect(await runCli([], h.io, h.runtime)).toBe(0);
        expect(h.inputs[0]).toMatchObject({ appleId: 'person@example.invalid', appPassword: 'abcd-efgh-ijkl-mnop', runLocation: 'local', flags: { write: false, invite: false, cleanup: false } });
        expect(h.prompts.length).toBe(0);
    });

    test('are prompted for on a TTY, with the password prompt hidden', async () => {
        const h = harness({ tty: true, answers: ['person@example.invalid', 'abcd-efgh-ijkl-mnop'] });
        expect(await runCli([], h.io, h.runtime)).toBe(0);
        expect(h.prompts.map((p) => p.kind)).toEqual(['line', 'hidden']);
        expect(h.inputs[0]?.appPassword).toBe('abcd-efgh-ijkl-mnop');
    });

    test('without a TTY or environment the probe stops with a fixed message', async () => {
        const h = harness({ tty: false });
        expect(await runCli([], h.io, h.runtime)).toBe(2);
        expect(h.err.join('')).toContain('PROBE_APPLE_ID');
        expect(h.prompts.length).toBe(0);
        const partial = harness({ tty: false, env: { PROBE_APPLE_ID: 'person@example.invalid' } });
        expect(await runCli([], partial.io, partial.runtime)).toBe(2);
        expect(partial.inputs.length).toBe(0);
    });

    test('invalid input is refused without echo', async () => {
        const bad = harness({ env: { PROBE_APPLE_ID: 'not-an-address secretword', PROBE_APP_PASSWORD: 'x' } });
        expect(await runCli([], bad.io, bad.runtime)).toBe(2);
        expect(bad.err.join('')).not.toContain('secretword');
        const empty = harness({ tty: true, answers: ['person@example.invalid', undefined] });
        expect(await runCli([], empty.io, empty.runtime)).toBe(2);
        const long = harness({ env: { PROBE_APPLE_ID: 'person@example.invalid', PROBE_APP_PASSWORD: 'x'.repeat(300) } });
        expect(await runCli([], long.io, long.runtime)).toBe(2);
    });
});

describe('invite confirmation', () => {
    test('requires typing send', async () => {
        const refused = harness({ env: ENV, tty: true, answers: ['friend@example.invalid', 'yes'] });
        expect(await runCli(['--write', '--invite'], refused.io, refused.runtime)).toBe(2);
        expect(refused.inputs.length).toBe(0);
        expect(refused.err.join('')).toContain('invitation email');
        const ok = harness({ env: ENV, tty: true, answers: ['friend@example.invalid', 'send'] });
        expect(await runCli(['--write', '--invite'], ok.io, ok.runtime)).toBe(0);
        expect(ok.inputs[0]).toMatchObject({ inviteAttendee: 'friend@example.invalid', flags: { write: true, invite: true, cleanup: false } });
    });

    test('accepts PROBE_INVITE_ATTENDEE and PROBE_INVITE_CONFIRM=send without a TTY', async () => {
        const h = harness({ env: { ...ENV, PROBE_INVITE_ATTENDEE: 'friend@example.invalid', PROBE_INVITE_CONFIRM: 'send' } });
        expect(await runCli(['--invite', '--write'], h.io, h.runtime)).toBe(0);
        const missing = harness({ env: { ...ENV, PROBE_INVITE_ATTENDEE: 'friend@example.invalid' } });
        expect(await runCli(['--invite', '--write'], missing.io, missing.runtime)).toBe(2);
    });
});

describe('output', () => {
    test('text plus JSON by default, only JSON with --json', async () => {
        const h = harness({ env: ENV });
        await runCli([], h.io, h.runtime);
        expect(h.out.join('')).toContain('caldav-mcp probe report');
        expect(h.out.join('')).toContain('"schemaVersion": 2');
        const j = harness({ env: ENV });
        await runCli(['--json'], j.io, j.runtime);
        expect(JSON.parse(j.out.join(''))).toMatchObject({ schemaVersion: 2 });
    });

    test('an unverified cleanup exits 1 and is shown prominently', async () => {
        const report = fakeReport({ cleanup: { tempCalendars: [{ name: 'caldav-mcp-probe-0a1b2c3d', removalVerified: false }], notDeleted: [], deleted: 0, allRemoved: false } });
        const h = harness({ env: ENV, report });
        expect(await runCli(['--write'], h.io, h.runtime)).toBe(1);
        const text = h.out.join('');
        expect(text).toContain('NOT REMOVED');
        expect(text).toContain('caldav-mcp-probe-0a1b2c3d');
        expect(h.err.join('')).toContain('caldav-mcp-probe-0a1b2c3d');
    });

    test('an unexpected failure prints only a fixed message', async () => {
        const h = harness({ env: ENV, probeThrows: true });
        expect(await runCli([], h.io, h.runtime)).toBe(1);
        expect(h.err.join('')).not.toContain('abcd-efgh');
        expect(h.err.join('')).toContain('internal error');
    });
});

const LAMBDA_ENV = { ...ENV, AWS_REGION: 'us-west-2' };

describe('--lambda', () => {
    test('sends credentials only in the payload and prints the returned report', async () => {
        const h = harness({ env: LAMBDA_ENV });
        expect(await runCli(['--lambda', 'caldav-mcp-probe', '--write'], h.io, h.runtime)).toBe(0);
        expect(h.inputs.length).toBe(0);
        expect(h.payloads[0]).toMatchObject({ name: 'caldav-mcp-probe', region: 'us-west-2' });
        expect(JSON.parse(h.payloads[0]?.payload ?? '{}')).toEqual({ appleId: 'person@example.invalid', appPassword: 'abcd-efgh-ijkl-mnop', flags: { write: true, invite: false, cleanup: false, inviteConfirmed: false, cleanupConfirmed: false } });
        expect(h.out.join('')).toContain('lambda');
    });

    test('a malformed or leaky Lambda response is refused or scrubbed', async () => {
        const bad = harness({ env: LAMBDA_ENV, lambdaBody: { error: 'invalid_event' } });
        expect(await runCli(['--lambda', 'caldav-mcp-probe'], bad.io, bad.runtime)).toBe(1);
        const leaky = harness({ env: LAMBDA_ENV, lambdaBody: fakeReport({ checks: [{ id: 'x', planItem: 'p', claim: 'c', outcome: 'confirmed', summary: 'person@example.invalid abcd-efgh-ijkl-mnop', evidence: {} }] }) });
        expect(await runCli(['--lambda', 'caldav-mcp-probe-test_1'], leaky.io, leaky.runtime)).toBe(0);
        expect(leaky.out.join('')).not.toContain('person@example.invalid');
        expect(leaky.out.join('')).not.toContain('abcd-efgh-ijkl-mnop');
    });

    test('the local re-scrub never edits fixed prose around a credential fragment, replaces a leaking string whole, and counts it', async () => {
        const fixedText = [
            'Deleted 1 leftover probe calendar(s); all verified gone.',
            'The time range selected exactly the event inside it.',
            'Strong, quoted ETags that match across REPORT, GET and PROPFIND.',
        ];
        const body = fakeReport({
            runLocation: 'lambda',
            awsRegion: 'us-west-2',
            checks: [
                ...fixedText.map((summary, i) => ({ id: `fixed-${i}`, planItem: 'Probe hygiene: the event is inside the range', claim: 'even the probe’s own words stay', outcome: 'confirmed' as const, summary, evidence: { insideStatus: 207 } })),
                { id: 'leak', planItem: 'p', claim: 'c', outcome: 'confirmed', summary: 'The organizer probe@even.invalid was seen.', evidence: { attendee: 'side@time.invalid' as Safe } },
            ],
            redaction: { scrubbedOccurrences: 0 },
        });
        const env = { ...LAMBDA_ENV, PROBE_APPLE_ID: 'probe@even.invalid', PROBE_INVITE_ATTENDEE: 'side@time.invalid', PROBE_INVITE_CONFIRM: 'send' };
        const h = harness({ env, lambdaBody: body });
        expect(await runCli(['--lambda', 'caldav-mcp-probe', '--write', '--invite', '--json'], h.io, h.runtime)).toBe(0);
        const printed = JSON.parse(h.out.join('')) as ProbeReport;
        expect(printed.checks.slice(0, 3)).toEqual(body.checks.slice(0, 3));
        expect(printed.checks[3]).toMatchObject({ summary: '<scrubbed>', evidence: { attendee: '<scrubbed>' } });
        expect(printed.redaction.scrubbedOccurrences).toBe(2);
        expect(h.out.join('')).not.toMatch(/probe@even|side@time/);
    });

    test('m2: a valid region is required before anything is prompted for', async () => {
        for (const env of [{}, { AWS_REGION: 'us-west-2; echo' }, { AWS_REGION: 'US-WEST-2' }, { AWS_REGION: 'us-west-22' }, { AWS_DEFAULT_REGION: 'lambda.evil.example' }]) {
            const h = harness({ env: { ...ENV, ...env }, tty: true, answers: ['person@example.invalid', 'abcd-efgh-ijkl-mnop'] });
            expect(await runCli(['--lambda', 'caldav-mcp-probe'], h.io, h.runtime)).toBe(2);
            expect(h.prompts.length + h.payloads.length).toBe(0);
            expect(h.err.join('')).toContain('AWS_REGION');
        }
        const fallback = harness({ env: { ...ENV, AWS_DEFAULT_REGION: 'eu-central-1' } });
        expect(await runCli(['--lambda', 'caldav-mcp-probe'], fallback.io, fallback.runtime)).toBe(0);
        expect(fallback.payloads[0]?.region).toBe('eu-central-1');
        const gov = harness({ env: { ...ENV, AWS_REGION: 'us-gov-west-1' } });
        expect(await runCli(['--lambda', 'caldav-mcp-probe'], gov.io, gov.runtime)).toBe(0);
    });

    test('B1: --lambda --cleanup asks for typed confirmation first and sends an explicit boolean', async () => {
        const refused = harness({ env: LAMBDA_ENV, tty: true, answers: ['yes'] });
        expect(await runCli(['--lambda', 'caldav-mcp-probe', '--cleanup'], refused.io, refused.runtime)).toBe(2);
        expect(refused.payloads.length).toBe(0);
        const ok = harness({ env: LAMBDA_ENV, tty: true, answers: ['delete'] });
        expect(await runCli(['--lambda', 'caldav-mcp-probe', '--cleanup'], ok.io, ok.runtime)).toBe(0);
        expect(JSON.parse(ok.payloads[0]?.payload ?? '{}').flags).toEqual({ write: false, invite: false, cleanup: true, inviteConfirmed: false, cleanupConfirmed: true });
        const env = harness({ env: { ...LAMBDA_ENV, PROBE_CLEANUP_CONFIRM: 'delete' } });
        expect(await runCli(['--lambda', 'caldav-mcp-probe', '--cleanup'], env.io, env.runtime)).toBe(0);
        expect(JSON.parse(env.payloads[0]?.payload ?? '{}').flags.cleanupConfirmed).toBe(true);
    });
});

describe('B1: local --cleanup confirmation', () => {
    const NAMES = ['caldav-mcp-probe-0a0a0a0a', 'caldav-mcp-probe-1b1b1b1b'];

    test('lists the candidates and needs delete typed at the prompt', async () => {
        const yes = harness({ env: ENV, tty: true, answers: ['delete'], cleanupNames: NAMES });
        await runCli(['--cleanup'], yes.io, yes.runtime);
        expect(yes.cleanupAnswers).toEqual([true]);
        expect(yes.err.join('')).toContain('2 calendar(s)');
        expect(yes.err.join('')).toContain('caldav-mcp-probe-0a0a0a0a');
        expect(yes.prompts.at(-1)?.question).toContain('delete');
        for (const answer of ['yes', 'DELETE', ' delete x', undefined]) {
            const no = harness({ env: ENV, tty: true, answers: [answer], cleanupNames: NAMES });
            await runCli(['--cleanup'], no.io, no.runtime);
            expect(no.cleanupAnswers).toEqual([false]);
        }
    });

    test('without a terminal only PROBE_CLEANUP_CONFIRM=delete confirms', async () => {
        const yes = harness({ env: { ...ENV, PROBE_CLEANUP_CONFIRM: 'delete' }, cleanupNames: NAMES });
        await runCli(['--cleanup'], yes.io, yes.runtime);
        expect(yes.cleanupAnswers).toEqual([true]);
        for (const value of [undefined, 'yes', '1']) {
            const no = harness({ env: { ...ENV, ...(value === undefined ? {} : { PROBE_CLEANUP_CONFIRM: value }) }, cleanupNames: NAMES });
            await runCli(['--cleanup'], no.io, no.runtime);
            expect(no.cleanupAnswers).toEqual([false]);
            expect(no.prompts.length).toBe(0);
            expect(no.err.join('')).toContain('PROBE_CLEANUP_CONFIRM=delete');
        }
    });
});

describe('m1: unsafe runtime settings are refused before any prompt', () => {
    for (const env of [{ BUN_CONFIG_VERBOSE_FETCH: 'curl' }, { BUN_CONFIG_VERBOSE_FETCH: '1' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) {
        test(JSON.stringify(env), async () => {
            for (const argv of [[], ['--write'], ['--lambda', 'caldav-mcp-probe']]) {
                const h = harness({ env: { ...LAMBDA_ENV, ...env }, tty: true, answers: ['person@example.invalid', 'abcd-efgh-ijkl-mnop'] });
                expect(await runCli(argv, h.io, h.runtime)).toBe(2);
                expect(h.prompts.length + h.inputs.length + h.payloads.length).toBe(0);
                expect(h.err.join('')).toContain(Object.keys(env)[0] ?? '');
            }
        });
    }

    test('NODE_EXTRA_CA_CERTS only warns', async () => {
        const h = harness({ env: { ...ENV, NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem' } });
        expect(await runCli([], h.io, h.runtime)).toBe(0);
        expect(h.err.join('')).toContain('NODE_EXTRA_CA_CERTS');
        expect(h.err.join('')).not.toContain('/etc/ssl/extra.pem');
        expect(h.inputs[0]?.extraCaCertsSet).toBe(true);
    });
});
