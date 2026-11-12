/**
 * Invite steps I2 to I10 (design §8.5) against the fake iCloud: what each step sends, the
 * per-step tags and timestamps, the waits, the confirmation gate and the CLI options. Nothing
 * here contacts a real server; every address is synthetic.
 */
import { describe, expect, test } from 'bun:test';
import { INVITE_STEPS, inviteBudget, parseInviteSteps, stepTag } from '../scripts/probe/checks/invite-steps';
import { normalizeInviteTemplate, runCli } from '../scripts/probe/cli';
import { runProbe } from '../scripts/probe/core';
import type { ProbeDeps, ProbeInput, ProbeReport } from '../scripts/probe/types';
import { ICLOUD_MEASURED, PLAIN, standardAccount, type FakeBehaviour, type FakeICloud } from './fixtures/probe/fake-icloud';
import { check, fakeDeps } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const TEMPLATE = 'owner.{tag}@mail.example.invalid';
const INVITE = { write: true, invite: true, cleanup: false };

async function run(steps: readonly string[], options: { behaviour?: Partial<FakeBehaviour>; template?: string; gap?: number; deps?: Partial<ProbeDeps> } = {}): Promise<{ fake: FakeICloud; report: ProbeReport; sleeps: number[] }> {
    const fake = standardAccount(PLAIN, options.behaviour ?? ICLOUD_MEASURED);
    const deps = fakeDeps(fake, options.deps);
    const input: ProbeInput = { ...creds, flags: INVITE, runLocation: 'local', inviteAttendee: options.template ?? TEMPLATE, inviteSteps: steps, inviteGapSeconds: options.gap ?? 90 };
    return { fake, report: await runProbe(input, deps), sleeps: deps.clock.sleeps };
}

/** Requests that carry or remove an invitation event (not the probe's other writes). */
const inviteRequests = (fake: FakeICloud) => fake.requests.filter((r) => /-inv[a-z0-9]*\.ics$/.test(r.url.pathname) || r.url.pathname.endsWith('-invite.ics'));

describe('step selection, tags and templates', () => {
    test('parseInviteSteps accepts all or a list, in canonical order, and refuses unknown names', () => {
        expect(parseInviteSteps('all')).toEqual([...INVITE_STEPS]);
        expect(parseInviteSteps('i3,I2,i2b,I3')).toEqual(['I2', 'I2b', 'I3']);
        expect(parseInviteSteps('I4')).toBeUndefined();
        expect(parseInviteSteps('')).toBeUndefined();
        expect(stepTag('caldav-mcp-probe-0a1b2c3d', 'I2b', 'a')).toBe('cmcp0a1b2c3di2ba');
    });

    test('a template has at most one {tag}, in the local part, and must still be a valid address', () => {
        expect(normalizeInviteTemplate(' Craig.{tag}@Example.com ')).toBe('craig.{tag}@example.com');
        expect(normalizeInviteTemplate('friend@example.invalid')).toBe('friend@example.invalid');
        expect(normalizeInviteTemplate('a.{tag}.{tag}@example.com')).toBeUndefined();
        expect(normalizeInviteTemplate('craig@{tag}.example.com')).toBeUndefined();
        expect(normalizeInviteTemplate('not an address {tag}')).toBeUndefined();
    });

    test('the budget: 36 mails at most for all steps, about 23.5 minutes of waiting at the default gap', () => {
        expect(inviteBudget([...INVITE_STEPS], 90)).toEqual({ mails: 36, waitSeconds: 9 * 90 + 20 * 30 + 3 });
        expect(inviteBudget(['I1'], 90)).toEqual({ mails: 2, waitSeconds: 3 });
    });
});

describe('all invite steps against the measured fake', () => {
    test('each step uses its own tagged address and event, stays within its request budget, and deletes what it made', async () => {
        const { fake, report, sleeps } = await run([...INVITE_STEPS]);
        const ids = report.checks.map((c) => c.id).filter((id) => id.startsWith('write-invite'));
        expect(ids).toEqual(['write-invite', 'write-invite-i2', 'write-invite-i2b', 'write-invite-i3', 'write-invite-i5', 'write-invite-i6', 'write-invite-i7', 'write-invite-i8', 'write-invite-i9', 'write-invite-i10']);
        for (const id of ids) {
            expect(check(report, id).outcome).toBe('confirmed');
        }
        const temp = report.cleanup?.tempCalendars[0]?.name ?? '';
        for (const step of ['I2', 'I2b', 'I3', 'I6', 'I7', 'I8']) {
            const result = check(report, `write-invite-${step.toLowerCase()}`);
            expect(result.evidence).toMatchObject({ tags: [stepTag(temp, step, 'a')] });
            const address = `owner.${stepTag(temp, step, 'a')}@mail.example.invalid`;
            const own = inviteRequests(fake).filter((r) => r.method === 'PUT' && r.body.includes(`mailto:${address}`));
            expect(own.length).toBeGreaterThan(0);
        }
        const budget = Object.fromEntries(ids.slice(1).map((id) => {
            const ev = check(report, id).evidence;
            const methods = Array.from({ length: Number(ev.requests) }, (_, i) => String(ev[`r${i + 1}Method`]));
            return [id, { writes: methods.filter((m) => m !== 'get').length, reads: methods.filter((m) => m === 'get').length }];
        }));
        for (const [id, counts] of Object.entries(budget)) {
            expect(counts.reads).toBeLessThanOrEqual(2);
            expect(counts.writes).toBeLessThanOrEqual(id === 'write-invite-i8' ? 5 : 4);
        }
        // Every event a step created was deleted again, before the calendar itself.
        const created = new Set(inviteRequests(fake).filter((r) => r.method === 'PUT' && r.headers.get('if-none-match') === '*').map((r) => r.url.pathname));
        const deleted = new Set(inviteRequests(fake).filter((r) => r.method === 'DELETE').map((r) => r.url.pathname));
        expect([...created].every((p) => deleted.has(p))).toBe(true);
        // Nine gaps of 90 s between ten steps, each waited in 1 s pieces, plus the pauses inside steps.
        expect(sleeps.filter((ms) => ms === 1000).length).toBe(9 * 90 + 20 * 30);
        expect(report.cleanup?.allRemoved).toBe(true);
        expect(report.redaction.scrubbedOccurrences).toBe(0);
    });

    test('what each step sends: the changes design §8.5 names', async () => {
        const { fake, report } = await run(['I2', 'I3', 'I5', 'I8', 'I9', 'I10']);
        const temp = report.cleanup?.tempCalendars[0]?.name ?? '';
        const bodies = (suffix: string): string[] => fake.requests.filter((r) => r.method === 'PUT' && r.url.pathname.endsWith(`-${suffix}.ics`)).map((r) => r.body);
        const [i2create, i2change] = bodies('invi2');
        expect(i2create).toContain('SEQUENCE:0');
        expect(i2change).toContain('SEQUENCE:1');
        expect(i2change).not.toBe(i2create);
        const i3 = bodies('invi3');
        expect(i3[1]).toContain('BEGIN:VALARM');
        expect(i3[1]).toContain('SEQUENCE:0');
        expect(i3[2]).toContain('TRANSP:TRANSPARENT');
        const [a, b] = ['a', 'b'].map((role) => `owner.${stepTag(temp, 'I5', role)}@mail.example.invalid`);
        const i5 = bodies('invi5');
        expect(i5[0]).toContain(a);
        expect(i5[1]).toContain(a);
        expect(i5[1]).toContain(b);
        expect(i5[2]).not.toContain(a);
        expect(bodies('invi8new')[0]).toContain('RRULE:FREQ=WEEKLY;COUNT=3');
        expect(bodies('invi8')[1]).toMatch(/RRULE:FREQ=WEEKLY;UNTIL=\d{8}T\d{6}Z/);
        const organizer = `owner.${stepTag(temp, 'I9', 'o')}@mail.example.invalid`;
        const i9 = bodies('invi9');
        expect(i9[0]).toContain(`ORGANIZER:mailto:${organizer}`);
        expect(i9[0]).toContain(`PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${PLAIN.appleId}`);
        expect(i9[1]).toContain(`PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:${PLAIN.appleId}`);
        expect(i9[2]).toContain('SUMMARY:caldav-mcp probe invitation I9 changed');
        expect(bodies('invi10c')[0]).toContain(';SCHEDULE-AGENT=CLIENT:mailto:');
        expect(bodies('invi10n')[0]).toContain(';SCHEDULE-AGENT=NONE:mailto:');
        // RFC 6638 (the fake's labelled guess): no SCHEDULE-STATUS for an attendee the server does not schedule.
        expect(check(report, 'write-invite-i10').evidence).toMatchObject({ r3ScheduleStatus_c: null, r4ScheduleStatus_n: null });
        expect(check(report, 'write-invite-i2').evidence).toMatchObject({ r1Label: 'create', r1Status: 201, r2ScheduleStatus_a: '1.2', r3Label: 'time-change', r5Label: 'delete', r5Status: 204, mailUpperBound: 3 });
        expect(String(check(report, 'write-invite-i2').evidence.r1At)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('a refused change is refuted, and the step still deletes its event', async () => {
        const { fake, report } = await run(['I2'], { behaviour: { ...ICLOUD_MEASURED, hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-invi2.ics') && req.headers.has('if-match') ? new Response(null, { status: 403 }) : undefined) } });
        expect(check(report, 'write-invite-i2')).toMatchObject({ outcome: 'refuted', evidence: { r3Status: 403, r4Label: 'delete', r4Status: 204 } });
        expect(fake.requests.filter((r) => r.method === 'DELETE' && r.url.pathname.endsWith('-invi2.ics'))).toHaveLength(1);
    });

    test('a template that expands to one of the account’s own addresses sends nothing', async () => {
        const { fake, report } = await run(['I1', 'I2'], { template: PLAIN.address });
        expect(check(report, 'write-invite').outcome).toBe('skipped');
        expect(check(report, 'write-invite-i2').outcome).toBe('skipped');
        expect(fake.requests.some((r) => r.method === 'PUT' && r.body.includes('ATTENDEE'))).toBe(false);
    });

    test('Ctrl-C during a gap stops the steps; the calendar is still removed', async () => {
        const controller = new AbortController();
        let sleeps = 0;
        const fake = standardAccount(PLAIN, ICLOUD_MEASURED);
        const deps = fakeDeps(fake, { signal: controller.signal });
        const sleep = deps.sleep;
        deps.sleep = async (ms) => {
            if (ms === 1000 && ++sleeps === 45) {
                controller.abort();
            }
            await sleep(ms);
        };
        const report = await runProbe({ ...creds, flags: INVITE, runLocation: 'local', inviteAttendee: TEMPLATE, inviteSteps: ['I1', 'I2', 'I3'], inviteGapSeconds: 90 }, deps);
        expect(check(report, 'write-invite').outcome).toBe('confirmed');
        expect(check(report, 'write-invite-i2')).toMatchObject({ outcome: 'inconclusive', evidence: { requestError: 'interrupted' } });
        expect(fake.requests.some((r) => r.url.pathname.endsWith('-invi2.ics'))).toBe(false);
        expect(report.cleanup?.allRemoved).toBe(true);
    });

    test('a template address never appears in the report; the tags do', async () => {
        const { report } = await run([...INVITE_STEPS], { template: 'canary.q7x2.{tag}@canary-domain.invalid' });
        const text = JSON.stringify(report);
        expect(text).not.toContain('canary');
        expect(text).not.toContain('q7x2');
        expect(text).toContain('cmcp');
        expect(report.redaction.scrubbedOccurrences).toBe(0);
    });
});

describe('the CLI options of the invite steps', () => {
    function harness(env: Record<string, string>) {
        const inputs: ProbeInput[] = [];
        const err: string[] = [];
        const io = { env, isTTY: false, promptLine: async () => undefined, promptHidden: async () => undefined, stdout: () => undefined, stderr: (t: string) => { err.push(t); } };
        const runtime = {
            probe: async (input: ProbeInput) => {
                inputs.push(input);
                return { schemaVersion: 2, probeVersion: '0.6.0', generatedAt: '', runLocation: 'local' as const, awsRegion: null, mode: { readOnly: false, write: true, invite: true, cleanup: false }, totals: { requests: 0, durationMs: 0, outcomes: { confirmed: 0, refuted: 0, inconclusive: 0, skipped: 0, error: 0 } }, cleanup: null, auth: { rejected: false, onFirstRequest: false }, environment: { extraCaCertsSet: false }, checks: [], redaction: { scrubbedOccurrences: 0 } };
            },
            invokeLambda: async () => ({ ok: false as const, code: 'x' }),
        };
        return { io, runtime, inputs, err };
    }
    const ENV = { PROBE_APPLE_ID: 'person@example.invalid', PROBE_APP_PASSWORD: 'abcd-efgh-ijkl-mnop', PROBE_INVITE_ATTENDEE: 'Owner.{tag}@Mail.Example.invalid', PROBE_INVITE_CONFIRM: 'send' };

    test('steps and gap reach the probe; the warning lists the steps and the mail bound; send is still required', async () => {
        const h = harness(ENV);
        expect(await runCli(['--write', '--invite', '--invite-steps=all', '--invite-gap=120'], h.io, h.runtime)).toBe(0);
        expect(h.inputs[0]).toMatchObject({ inviteAttendee: 'owner.{tag}@mail.example.invalid', inviteSteps: [...INVITE_STEPS], inviteGapSeconds: 120 });
        expect(h.err.join('')).toContain('I1, I2, I2b, I3, I5, I6, I7, I8, I9, I10');
        expect(h.err.join('')).toContain('up to 36 email(s)');
        const unconfirmed = harness({ ...ENV, PROBE_INVITE_CONFIRM: 'yes' });
        expect(await runCli(['--write', '--invite', '--invite-steps=I2'], unconfirmed.io, unconfirmed.runtime)).toBe(2);
        expect(unconfirmed.inputs).toHaveLength(0);
        const plain = harness(ENV);
        expect(await runCli(['--write', '--invite'], plain.io, plain.runtime)).toBe(0);
        expect(plain.inputs[0]).toMatchObject({ inviteSteps: ['I1'], inviteGapSeconds: 90 });
    });

    test('bad values, missing --invite and --lambda are refused before any prompt', async () => {
        for (const argv of [
            ['--write', '--invite', '--invite-steps=I4'], ['--write', '--invite', '--invite-gap=5'], ['--write', '--invite', '--invite-gap=abc'],
            ['--write', '--invite-steps=all'], ['--write', '--invite', '--invite-steps=all', '--invite-steps=I2'],
            ['--lambda', 'caldav-mcp-probe', '--write', '--invite', '--invite-steps=I2'],
        ]) {
            const h = harness({ ...ENV, AWS_REGION: 'us-west-2' });
            expect(await runCli(argv, h.io, h.runtime)).toBe(2);
            expect(h.inputs).toHaveLength(0);
        }
        const lambdaTemplate = harness({ ...ENV, AWS_REGION: 'us-west-2' });
        expect(await runCli(['--lambda', 'caldav-mcp-probe', '--write', '--invite'], lambdaTemplate.io, lambdaTemplate.runtime)).toBe(2);
        expect(lambdaTemplate.err.join('')).toContain('{tag}');
    });
});
