import { normalizeAppleId } from '../../src/account';
import { ProbeConfigError } from './core';
import { EXTRA_CA_WARNING, UNSAFE_MESSAGE, extraCaCertsSet, unsafeSetting } from './env-check';
import { LAMBDA_FUNCTION_NAME, invokeRegion } from './lambda-invoke';
import { authMessage, cleanupWarning, formatText } from './report';
import { Taint, scrubValue } from './safe';
import type { CleanupCandidates, ProbeFlags, ProbeInput, ProbeReport } from './types';

export interface CliIo {
    env: Readonly<Record<string, string | undefined>>;
    /** True when prompts can be shown (stdin is a terminal). */
    isTTY: boolean;
    promptLine(question: string): Promise<string | undefined>;
    /** Reads a line with echo disabled. */
    promptHidden(question: string): Promise<string | undefined>;
    stdout(text: string): void;
    stderr(text: string): void;
}

export type LambdaInvokeResult = { ok: true; body: unknown } | { ok: false; code: string };

/** Called by the probe while it runs. */
export interface ProbeHooks {
    /** `--cleanup`: shown the candidates; resolves true only when the user typed delete. */
    confirmCleanup(candidates: CleanupCandidates): Promise<boolean>;
}

export interface CliRuntime {
    probe(input: ProbeInput, hooks: ProbeHooks): Promise<ProbeReport>;
    invokeLambda(functionName: string, payload: string, region: string): Promise<LambdaInvokeResult>;
}

const USAGE = `Usage: bun run probe [-- options]

Checks what Apple iCloud's CalDAV server really does. Read-only unless --write is given.

Options:
  --write              Also run write tests inside a temporary calendar the probe creates and deletes.
  --invite             With --write: save one event with an attendee (may send a real invitation).
  --cleanup            Only delete calendars the probe itself left behind, after you type delete.
  --json               Print only the JSON report.
  --lambda <function>  Run the probe inside an AWS Lambda function named caldav-mcp-probe...
                       (needs AWS_REGION; credentials go in the payload).
  --help               Show this help.

Credentials are prompted for (the password with echo off), or read from PROBE_APPLE_ID and
PROBE_APP_PASSWORD. They are never accepted on the command line. See docs/probe.md.
`;

const REFUSED = 'Unrecognised or disallowed argument. Credentials are never accepted on the command line; use PROBE_APPLE_ID and PROBE_APP_PASSWORD or the prompts. Run with --help for usage.\n';
const NO_TTY = 'No terminal for prompts. Set PROBE_APPLE_ID and PROBE_APP_PASSWORD in the environment (see docs/probe.md).\n';
const NO_REGION = '--lambda needs AWS_REGION (or AWS_DEFAULT_REGION) set to a region such as us-west-2.\n';

interface CliOptions { flags: ProbeFlags; json: boolean; help: boolean; lambda?: string }

function parseArgs(argv: readonly string[]): CliOptions | undefined {
    const options: CliOptions = { flags: { write: false, invite: false, cleanup: false }, json: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--write':
                options.flags.write = true;
                break;
            case '--invite':
                options.flags.invite = true;
                break;
            case '--cleanup':
                options.flags.cleanup = true;
                break;
            case '--json':
                options.json = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--lambda': {
                const name = argv[i + 1];
                if (name === undefined || !LAMBDA_FUNCTION_NAME.test(name) || options.lambda !== undefined) {
                    return undefined;
                }
                options.lambda = name;
                i++;
                break;
            }
            default:
                return undefined;
        }
    }
    return options;
}

function isReport(value: unknown): value is ProbeReport {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const r = value as Partial<ProbeReport>;
    const objects = [r.mode, r.totals, r.auth, r.environment];
    return typeof r.schemaVersion === 'number' && Array.isArray(r.checks) && objects.every((o) => o !== null && typeof o === 'object')
        && (r.cleanup === null || (typeof r.cleanup === 'object' && Array.isArray(r.cleanup.tempCalendars) && Array.isArray(r.cleanup.notDeleted)));
}

async function readCredential(io: CliIo, envName: string, question: string, hidden: boolean): Promise<string | undefined | 'no_tty'> {
    const fromEnv = io.env[envName];
    if (fromEnv !== undefined && fromEnv !== '') {
        return fromEnv;
    }
    if (!io.isTTY) {
        return 'no_tty';
    }
    return hidden ? io.promptHidden(question) : io.promptLine(question);
}

async function collectInvite(io: CliIo): Promise<string | number> {
    io.stderr([
        '',
        'WARNING: --invite saves one event that lists the recipient as an ATTENDEE.',
        'iCloud may deliver a real invitation: by email, or, for an iCloud recipient, inside their Calendar app',
        'rather than as an invitation email. The recipient sees your address and name as the organizer.',
        'Deleting the event afterwards may or may not send them a cancellation.',
        'Use an address you control.',
        '',
    ].join('\n'));
    const raw = await readCredential(io, 'PROBE_INVITE_ATTENDEE', 'Invitation recipient email: ', false);
    if (raw === 'no_tty') {
        io.stderr('No terminal for prompts. Set PROBE_INVITE_ATTENDEE and PROBE_INVITE_CONFIRM=send in the environment.\n');
        return 2;
    }
    const attendee = raw === undefined ? undefined : normalizeAppleId(raw);
    if (attendee === undefined) {
        io.stderr('Invalid invitation recipient address.\n');
        return 2;
    }
    const confirm = await readCredential(io, 'PROBE_INVITE_CONFIRM', 'Type send to continue: ', false);
    if (confirm === 'no_tty' || confirm?.trim() !== 'send') {
        io.stderr('Invitation not confirmed; nothing was sent.\n');
        return 2;
    }
    return attendee;
}

const CLEANUP_QUESTION = 'Type delete to remove them: ';

/** Typed confirmation: PROBE_CLEANUP_CONFIRM=delete, else the word delete at a prompt. */
async function cleanupConfirmed(io: CliIo): Promise<boolean> {
    const answer = await readCredential(io, 'PROBE_CLEANUP_CONFIRM', CLEANUP_QUESTION, false);
    if (answer === 'no_tty') {
        io.stderr('No terminal for the confirmation. Set PROBE_CLEANUP_CONFIRM=delete to allow the deletion.\n');
        return false;
    }
    if (answer?.trim() !== 'delete') {
        io.stderr('Deletion not confirmed; nothing was deleted. (Without a terminal, set PROBE_CLEANUP_CONFIRM=delete.)\n');
        return false;
    }
    return true;
}

function localHooks(io: CliIo): ProbeHooks {
    return {
        confirmCleanup: async (candidates) => {
            // Only names of the exact probe form ever reach this point.
            io.stderr([
                '',
                `Found ${candidates.names.length} calendar(s) that the probe made and can delete (exact probe name and address, not shared, holding only probe events):`,
                ...candidates.names.map((name) => `  ${name}`),
                '',
            ].join('\n'));
            return cleanupConfirmed(io);
        },
    };
}

/** The probe command line. Returns the exit code: 0 done, 1 failure or unverified cleanup, 2 usage. */
export async function runCli(argv: readonly string[], io: CliIo, runtime: CliRuntime): Promise<number> {
    const options = parseArgs(argv);
    if (options === undefined) {
        io.stderr(REFUSED);
        return 2;
    }
    if (options.help) {
        io.stdout(USAGE);
        return 0;
    }
    const { flags } = options;
    if (flags.invite && !flags.write) {
        io.stderr('--invite requires --write.\n');
        return 2;
    }
    if (flags.cleanup && (flags.write || flags.invite)) {
        io.stderr('--cleanup cannot be combined with --write or --invite.\n');
        return 2;
    }
    const unsafe = unsafeSetting(io.env);
    if (unsafe !== undefined) {
        io.stderr(UNSAFE_MESSAGE[unsafe]);
        return 2;
    }
    const extraCa = extraCaCertsSet(io.env);
    if (extraCa) {
        io.stderr(EXTRA_CA_WARNING);
    }
    const region = options.lambda === undefined ? undefined : invokeRegion(io.env);
    if (options.lambda !== undefined && region === undefined) {
        io.stderr(NO_REGION);
        return 2;
    }
    try {
        const rawId = await readCredential(io, 'PROBE_APPLE_ID', 'Apple ID: ', false);
        if (rawId === 'no_tty') {
            io.stderr(NO_TTY);
            return 2;
        }
        const appleId = rawId === undefined ? undefined : normalizeAppleId(rawId);
        if (appleId === undefined) {
            io.stderr('Invalid Apple ID.\n');
            return 2;
        }
        const rawPassword = await readCredential(io, 'PROBE_APP_PASSWORD', 'App-specific password (input hidden): ', true);
        if (rawPassword === 'no_tty') {
            io.stderr(NO_TTY);
            return 2;
        }
        const appPassword = rawPassword?.trim();
        if (appPassword === undefined || appPassword === '' || appPassword.length > 256) {
            io.stderr('No usable app-specific password was entered.\n');
            return 2;
        }
        let inviteAttendee: string | undefined;
        if (flags.invite) {
            const invite = await collectInvite(io);
            if (typeof invite === 'number') {
                return invite;
            }
            inviteAttendee = invite;
        }
        if (flags.write) {
            io.stderr('Write mode: temporary calendars named caldav-mcp-probe-<random> are created and deleted. Existing calendars are not modified.\n');
        }

        let report: ProbeReport;
        if (options.lambda === undefined || region === undefined) {
            report = await runtime.probe({ appleId, appPassword, flags, runLocation: 'local', extraCaCertsSet: extraCa, ...(inviteAttendee === undefined ? {} : { inviteAttendee }) }, localHooks(io));
        } else {
            let cleanupOk = false;
            if (flags.cleanup) {
                // The Lambda cannot ask, so the confirmation comes first and travels as a boolean.
                io.stderr('\n--cleanup on Lambda deletes every calendar that passes the probe’s safety rules (exact probe name and address, not shared, holding only probe events) without listing them first.\n');
                cleanupOk = await cleanupConfirmed(io);
                if (!cleanupOk) {
                    return 2;
                }
            }
            const payload = JSON.stringify({ appleId, appPassword, flags: { ...flags, inviteConfirmed: flags.invite, cleanupConfirmed: cleanupOk }, ...(inviteAttendee === undefined ? {} : { inviteAttendee }) });
            io.stderr('Invoking the Lambda function (this can take up to five minutes)...\n');
            const result = await runtime.invokeLambda(options.lambda, payload, region);
            if (!result.ok) {
                io.stderr(`Lambda invocation failed (${result.code}). The AWS CLI output is not shown because it can contain account details.\n`);
                return 1;
            }
            if (!isReport(result.body)) {
                io.stderr('The Lambda function did not return a probe report.\n');
                return 1;
            }
            // The remote report is scrubbed again against the local credentials. Only the whole
            // values are tainted (and their URL-encoded and base64 forms, which are no shorter);
            // nothing shorter, such as an Apple ID's local part, is derived from them. A string
            // that contains one is replaced as a whole, never in part, and counted.
            const taint = new Taint();
            for (const secret of [appleId, appPassword, inviteAttendee]) {
                taint.add(secret);
            }
            const rescrubbed = scrubValue(result.body, taint);
            report = rescrubbed.value;
            if (rescrubbed.count > 0) {
                const previous = report.redaction?.scrubbedOccurrences;
                report.redaction = { scrubbedOccurrences: (typeof previous === 'number' ? previous : 0) + rescrubbed.count };
            }
        }
        io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatText(report)}\nJSON report:\n${JSON.stringify(report, null, 2)}\n`);
        const auth = authMessage(report);
        if (auth !== undefined) {
            io.stderr(`${auth}\n`);
        }
        const warning = cleanupWarning(report);
        if (warning.length > 0) {
            io.stderr(`${warning.join('\n')}\n`);
        }
        return auth !== undefined || warning.length > 0 ? 1 : 0;
    } catch (error) {
        if (error instanceof ProbeConfigError) {
            io.stderr('Invalid flag combination.\n');
            return 2;
        }
        io.stderr('probe failed: internal error. No details are printed, so that no credential can leak.\n');
        return 1;
    }
}
