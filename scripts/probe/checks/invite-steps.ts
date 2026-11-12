/**
 * Invite steps I2 to I10 (design §8.5), an extension of `write-invite` (I1/I4) under `--invite`.
 * Every step sends REAL mail through iCloud's server-side scheduling to the address the owner
 * gave (and, for I9, receives the owner's reply at an organizer address made from the same
 * owner-controlled template); the owner authorised this by typing `send`. Each step uses its own
 * event in the probe's temporary calendar, deletes it at the end, and records, per request, what
 * was sent and when (UTC), the status, ETag and Schedule-Tag header presence, and the
 * SCHEDULE-STATUS codes iCloud wrote, so mails can be matched to steps afterwards by the tag in
 * the recipient address (`{tag}` in PROBE_INVITE_ATTENDEE), the SUMMARY and the time.
 */
import { CheckStop, isOk, isRefusal, type CheckContext, type CheckDef, type CheckOutput } from '../context';
import { dav, eventComponents, getIcal, requireSynthetic } from '../dav';
import { ProbeHttpError } from '../http';
import { icalUtc, prop, props } from '../ical';
import { AuthoredValue, fixed, prose, type Safe } from '../safe';
import type { Evidence } from '../types';
import { DAY, HOUR, baseDay, newEvent, primary } from './write-helpers';
import { calendarText, stampNow, vevent } from './phase3-helpers';

export const INVITE_STEPS = ['I1', 'I2', 'I2b', 'I3', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10'] as const;
export type InviteStep = (typeof INVITE_STEPS)[number];
/** Without `--invite-steps`, only I1 (the original invite check: one invitation and one cancellation). */
export const DEFAULT_INVITE_STEPS: readonly string[] = ['I1'];
export const DEFAULT_INVITE_GAP_SECONDS = 90;
export const MIN_INVITE_GAP_SECONDS = 10;
export const MAX_INVITE_GAP_SECONDS = 900;

/** The most mails a step can cause if iCloud mails every change (each recipient address counted). */
export const MAIL_UPPER_BOUND: Record<InviteStep, number> = { I1: 2, I2: 3, I2b: 3, I3: 4, I5: 6, I6: 3, I7: 3, I8: 5, I9: 3, I10: 4 };

/** Waits inside a step between successive changes (a third of the gap, at least 5 s), so each change can be told apart in the mailbox. */
export const pauseWithinStepMs = (gapMs: number): number => Math.max(5000, Math.round(gapMs / 3));

/** How many waits a step makes inside itself (the pauses between its changes). */
export const PAUSES_WITHIN: Record<InviteStep, number> = { I1: 0, I2: 2, I2b: 2, I3: 3, I5: 3, I6: 2, I7: 2, I8: 2, I9: 3, I10: 1 };

/** `all`, or a comma list of step names (case-insensitive); undefined when any name is unknown. Canonical order, no duplicates. */
export function parseInviteSteps(text: string): InviteStep[] | undefined {
    if (text.trim().toLowerCase() === 'all') {
        return [...INVITE_STEPS];
    }
    const wanted = text.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
    if (wanted.length === 0 || wanted.some((w) => !INVITE_STEPS.some((s) => s.toLowerCase() === w))) {
        return undefined;
    }
    return INVITE_STEPS.filter((s) => wanted.includes(s.toLowerCase()));
}

/** The address for one tag: the template with `{tag}` replaced (a template without `{tag}` is the address itself). */
export function expandTemplate(template: string, tag: string): string {
    return template.replace('{tag}', tag);
}

/** The per-step tag: `cmcp` + the temporary calendar's hex + the step (+ a role letter), all lower case. */
export function stepTag(calendarName: string, step: string, role = ''): string {
    return `cmcp${calendarName.slice(-8)}${step.toLowerCase()}${role}`;
}

/** A SCHEDULE-STATUS value as a code (`1.1`, `3.7,5.1`), `<other>` for anything else, null when absent. */
export function scheduleCode(value: string | undefined): Safe | null {
    if (value === undefined) {
        return null;
    }
    return /^\d\.\d{1,2}(\.\d{1,2})?(,\d\.\d{1,2}(\.\d{1,2})?)*$/.test(value) ? fixed(value) : fixed('<other>');
}

/** Waits in 1 s pieces so that Ctrl-C ends a long wait (the next request then fails with `interrupted` and cleanup runs). */
export async function pause(ctx: CheckContext, ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 1000) {
        if (ctx.http.interrupted) {
            throw new ProbeHttpError('interrupted');
        }
        await ctx.sleep(Math.min(1000, left));
    }
}

/** The configured gap before every step except the first that ran in this run. */
export async function gapBeforeStep(ctx: CheckContext): Promise<void> {
    if (ctx.state.lastInviteStepAt !== undefined) {
        await pause(ctx, ctx.invite.gapMs);
    }
}

interface Recipients { organizer: string; addresses: Map<string, string> }

/** The organizer (the account's own mailto) and the expanded recipient address of each role; every one must not be the account's own. */
function recipients(ctx: CheckContext, step: InviteStep, roles: readonly string[]): Recipients {
    const organizer = ctx.state.addresses.find((a) => /^mailto:/i.test(a));
    const template = ctx.inviteAttendee?.trim().toLowerCase();
    if (organizer === undefined) {
        throw new CheckStop('skipped', prose`Skipped: calendar-user-address-set has no mailto address to act as organizer; nothing was sent.`);
    }
    if (template === undefined || template === '') {
        throw new CheckStop('skipped', prose`Skipped: no invite recipient was given; nothing was sent.`);
    }
    const temp = primary(ctx);
    const own = new Set([...ctx.state.addresses.map((a) => a.replace(/^mailto:/i, '').toLowerCase()), ctx.credentials.appleId.toLowerCase()]);
    const addresses = new Map<string, string>();
    for (const role of roles) {
        const address = expandTemplate(template, stepTag(temp.name, step, role));
        if (own.has(address)) {
            throw new CheckStop('skipped', prose`Skipped: an invite address is one of this account’s own addresses; nothing was sent.`);
        }
        ctx.taint.add(address);
        addresses.set(role, address);
    }
    return { organizer, addresses };
}

/** Records every request of a step under `r<n>…` keys: label, method, status, UTC time and header presence. */
class StepLog {
    private n = 0;
    writesRefused = 0;
    writesFailed = 0;
    constructor(private readonly ctx: CheckContext, readonly evidence: Evidence) {}

    private record(label: string, method: string): string {
        this.n++;
        const key = `r${this.n}`;
        Object.assign(this.evidence, { [`${key}Label`]: fixed(label), [`${key}Method`]: fixed(method.toLowerCase()), [`${key}At`]: new AuthoredValue(fixed(new Date(this.ctx.now()).toISOString())) });
        this.evidence.requests = this.n;
        return key;
    }

    async write(label: string, method: 'PUT' | 'DELETE', url: string, body?: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; etag: string | null }> {
        const key = this.record(label, method);
        const r = await dav(this.ctx, method, url, { ...(body === undefined ? {} : { body }), headers: body === undefined ? headers : { 'content-type': 'text/calendar; charset=utf-8', ...headers } });
        const etag = r.res.headers.get('etag');
        Object.assign(this.evidence, { [`${key}Status`]: r.res.status, [`${key}EtagHeader`]: etag !== null, [`${key}ScheduleTagHeader`]: r.res.headers.has('schedule-tag') });
        this.writesRefused += isRefusal(r.res.status) ? 1 : 0;
        this.writesFailed += !isOk(r.res.status) && !isRefusal(r.res.status) ? 1 : 0;
        return { ok: isOk(r.res.status), etag };
    }

    /** GET of the step's event: the SCHEDULE-STATUS of each role's ATTENDEE (and of ORGANIZER), and whether the ETag changed since `previous`. */
    async read(label: string, url: string, uid: string, roles: Map<string, string>, previous: string | null): Promise<string | null> {
        const key = this.record(label, 'GET');
        const got = await getIcal(this.ctx, url);
        if (got.status === 200) {
            requireSynthetic(got.ical, got.url, primary(this.ctx).url, uid, got.status);
        }
        const events = eventComponents(got.ical);
        const attendees = events.flatMap((e) => props(e, 'ATTENDEE'));
        Object.assign(this.evidence, { [`${key}Status`]: got.status, [`${key}EtagChanged`]: previous === null || got.etag === null ? null : previous !== got.etag });
        for (const [role, address] of roles) {
            const line = attendees.find((p) => p.value.toLowerCase() === `mailto:${address}`);
            this.evidence[`${key}ScheduleStatus_${role}`] = scheduleCode(line?.params['SCHEDULE-STATUS']);
        }
        const organizer = events.map((e) => prop(e, 'ORGANIZER')).find((p) => p !== undefined);
        this.evidence[`${key}ScheduleStatus_organizerProperty`] = scheduleCode(organizer?.params['SCHEDULE-STATUS']);
        return got.etag;
    }
}

const SUMMARY_OF = (step: string): string => `caldav-mcp probe invitation ${step}`;
const attendeeLine = (address: string, extra = ''): string => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${extra}:mailto:${address}`;
const chairLine = (organizer: string): string => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=CHAIR;PARTSTAT=ACCEPTED:${organizer}`;

interface StepSpec {
    step: Exclude<InviteStep, 'I1'>;
    question: string;
    sequence: string;
    roles: readonly string[];
    run(ctx: CheckContext, log: StepLog, who: Recipients, at: number): Promise<void>;
}

/** A single event as the probe's organizer writes it, to the given attendees. */
function organizerEvent(ctx: CheckContext, uid: string, step: string, who: Recipients, attendees: readonly string[], start: number, lines: readonly string[], sequence: number): string[] {
    return vevent(uid, stampNow(ctx), [
        `DTSTART:${icalUtc(start)}`, `DTEND:${icalUtc(start + HOUR)}`, `SUMMARY:${SUMMARY_OF(step)}`, `ORGANIZER:${who.organizer}`, chairLine(who.organizer),
        ...attendees.map((a) => attendeeLine(a)), `SEQUENCE:${sequence}`, ...lines,
    ]);
}

const addr = (who: Recipients, role: string): string => who.addresses.get(role) ?? '';

/** create → read → pause → each change (with pauses between) → read → pause → delete. The delete is attempted whatever happened before. */
async function simpleFlow(ctx: CheckContext, log: StepLog, step: string, who: Recipients, at: number, changes: readonly { label: string; body: (uid: string) => string }[], create: (uid: string) => string): Promise<void> {
    const temp = primary(ctx);
    const { url, uid } = newEvent(temp, `inv${step.toLowerCase()}`);
    const wait = pauseWithinStepMs(ctx.invite.gapMs);
    const created = await log.write('create', 'PUT', url, create(uid), { 'if-none-match': '*' });
    if (!created.ok) {
        return;
    }
    try {
        let etag = await log.read('read', url, uid, who.addresses, created.etag);
        for (const change of changes) {
            await pause(ctx, wait);
            const put = await log.write(change.label, 'PUT', url, change.body(uid), etag === null ? {} : { 'if-match': etag });
            if (!put.ok) {
                return;
            }
            etag = put.etag;
        }
        if (changes.length > 0) {
            await log.read('read', url, uid, who.addresses, etag);
        }
        await pause(ctx, wait);
    } finally {
        if (!ctx.http.credentialsRejected) {
            await log.write('delete', 'DELETE', url);
        }
    }
}

const STEPS: readonly StepSpec[] = [
    {
        step: 'I2', question: 'Does iCloud mail an update for a time change?', sequence: 'create; PUT moving it one hour later with SEQUENCE+1 and a new DTSTAMP; delete', roles: ['a'],
        run: (ctx, log, who, at) => simpleFlow(ctx, log, 'I2', who, at, [{ label: 'time-change', body: (uid) => calendarText([organizerEvent(ctx, uid, 'I2', who, [addr(who, 'a')], at + HOUR, [], 1)]) }], (uid) => calendarText([organizerEvent(ctx, uid, 'I2', who, [addr(who, 'a')], at, [], 0)])),
    },
    {
        step: 'I2b', question: 'Does iCloud mail for a DESCRIPTION-only change?', sequence: 'create; PUT changing only DESCRIPTION with SEQUENCE+1; delete', roles: ['a'],
        run: (ctx, log, who, at) => simpleFlow(ctx, log, 'I2b', who, at, [{ label: 'description-only', body: (uid) => calendarText([organizerEvent(ctx, uid, 'I2b', who, [addr(who, 'a')], at, ['DESCRIPTION:caldav-mcp probe description change'], 1)]) }], (uid) => calendarText([organizerEvent(ctx, uid, 'I2b', who, [addr(who, 'a')], at, [], 0)])),
    },
    {
        step: 'I3', question: 'Does iCloud mail for personal properties (an alarm, TRANSP)?', sequence: 'create; PUT adding only a VALARM (SEQUENCE unchanged); PUT changing only TRANSP; delete', roles: ['a'],
        run: (ctx, log, who, at) => {
            const alarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:caldav-mcp probe alarm', 'TRIGGER:-PT15M', 'END:VALARM'];
            return simpleFlow(ctx, log, 'I3', who, at, [
                { label: 'alarm-only', body: (uid) => calendarText([organizerEvent(ctx, uid, 'I3', who, [addr(who, 'a')], at, alarm, 0)]) },
                { label: 'transp-only', body: (uid) => calendarText([organizerEvent(ctx, uid, 'I3', who, [addr(who, 'a')], at, ['TRANSP:TRANSPARENT', ...alarm], 0)]) },
            ], (uid) => calendarText([organizerEvent(ctx, uid, 'I3', who, [addr(who, 'a')], at, [], 0)]));
        },
    },
    {
        step: 'I5', question: 'Is attendee B invited when added, and attendee A sent a cancellation when removed?', sequence: 'create with attendee A; PUT adding attendee B; PUT removing A; delete', roles: ['a', 'b'],
        run: (ctx, log, who, at) => simpleFlow(ctx, log, 'I5', who, at, [
            { label: 'add-attendee', body: (uid) => calendarText([organizerEvent(ctx, uid, 'I5', who, [addr(who, 'a'), addr(who, 'b')], at, [], 1)]) },
            { label: 'remove-attendee', body: (uid) => calendarText([organizerEvent(ctx, uid, 'I5', who, [addr(who, 'b')], at, [], 2)]) },
        ], (uid) => calendarText([organizerEvent(ctx, uid, 'I5', who, [addr(who, 'a')], at, [], 0)])),
    },
    {
        step: 'I6', question: 'Does a this-occurrence override (instance 2 moved) send a per-instance update?', sequence: 'weekly series (COUNT=4) with the attendee; PUT adding an override that moves instance 2 by two hours; delete', roles: ['a'],
        run: (ctx, log, who, at) => {
            const master = (uid: string): string[] => organizerEvent(ctx, uid, 'I6', who, [addr(who, 'a')], at, ['RRULE:FREQ=WEEKLY;COUNT=4'], 0);
            const override = (uid: string): string[] => vevent(uid, stampNow(ctx), [
                `RECURRENCE-ID:${icalUtc(at + 7 * DAY)}`, `DTSTART:${icalUtc(at + 7 * DAY + 2 * HOUR)}`, `DTEND:${icalUtc(at + 7 * DAY + 3 * HOUR)}`, `SUMMARY:${SUMMARY_OF('I6')}`,
                `ORGANIZER:${who.organizer}`, chairLine(who.organizer), attendeeLine(addr(who, 'a')), 'SEQUENCE:1',
            ]);
            return simpleFlow(ctx, log, 'I6', who, at, [{ label: 'override', body: (uid) => calendarText([master(uid), override(uid)]) }], (uid) => calendarText([master(uid)]));
        },
    },
    {
        step: 'I7', question: 'Does an EXDATE for instance 2 send a per-instance cancellation?', sequence: 'weekly series (COUNT=4) with the attendee; PUT adding an EXDATE for instance 2 (SEQUENCE+1); delete', roles: ['a'],
        run: (ctx, log, who, at) => simpleFlow(ctx, log, 'I7', who, at, [
            { label: 'exdate', body: (uid) => calendarText([organizerEvent(ctx, uid, 'I7', who, [addr(who, 'a')], at, ['RRULE:FREQ=WEEKLY;COUNT=4', `EXDATE:${icalUtc(at + 7 * DAY)}`], 1)]) },
        ], (uid) => calendarText([organizerEvent(ctx, uid, 'I7', who, [addr(who, 'a')], at, ['RRULE:FREQ=WEEKLY;COUNT=4'], 0)])),
    },
    {
        step: 'I8', question: 'Does a split (design §3.5) send an invitation for the new series and an update for the truncated one?', sequence: 'weekly series (COUNT=6) with the attendee; PUT of a new-UID series from instance 4 (COUNT=3, If-None-Match); PUT truncating the original with UNTIL (If-Match); delete both', roles: ['a'],
        async run(ctx, log, who, at) {
            const temp = primary(ctx);
            const { url, uid } = newEvent(temp, 'invi8');
            const next = newEvent(temp, 'invi8new');
            const wait = pauseWithinStepMs(ctx.invite.gapMs);
            const created = await log.write('create', 'PUT', url, calendarText([organizerEvent(ctx, uid, 'I8', who, [addr(who, 'a')], at, ['RRULE:FREQ=WEEKLY;COUNT=6'], 0)]), { 'if-none-match': '*' });
            if (!created.ok) {
                return;
            }
            let made = false;
            try {
                const etag = await log.read('read', url, uid, who.addresses, created.etag);
                await pause(ctx, wait);
                const split = await log.write('split-new', 'PUT', next.url, calendarText([organizerEvent(ctx, next.uid, 'I8', who, [addr(who, 'a')], at + 21 * DAY, ['RRULE:FREQ=WEEKLY;COUNT=3'], 0)]), { 'if-none-match': '*' });
                made = split.ok;
                if (split.ok) {
                    const truncated = await log.write('split-truncate', 'PUT', url, calendarText([organizerEvent(ctx, uid, 'I8', who, [addr(who, 'a')], at, [`RRULE:FREQ=WEEKLY;UNTIL=${icalUtc(at + 21 * DAY - 1000)}`], 1)]), etag === null ? {} : { 'if-match': etag });
                    if (truncated.ok) {
                        await log.read('read', url, uid, who.addresses, truncated.etag);
                    }
                }
                await pause(ctx, wait);
            } finally {
                if (!ctx.http.credentialsRejected) {
                    if (made) {
                        await log.write('delete', 'DELETE', next.url);
                    }
                    await log.write('delete', 'DELETE', url);
                }
            }
        },
    },
    {
        step: 'I9', question: 'With the owner as an ATTENDEE of an organizer address under the owner’s control, does accepting, changing SUMMARY or deleting mail the organizer (a REPLY or a decline)?', sequence: 'event with ORGANIZER = the owner-controlled template address and the owner as ATTENDEE (NEEDS-ACTION); PUT setting the owner’s PARTSTAT=ACCEPTED; PUT changing SUMMARY; DELETE', roles: ['o'],
        run: (ctx, log, who, at) => {
            const owner = who.organizer;
            const external = `mailto:${addr(who, 'o')}`;
            const event = (uid: string, partstat: string, summary: string): string => calendarText([vevent(uid, stampNow(ctx), [
                `DTSTART:${icalUtc(at)}`, `DTEND:${icalUtc(at + HOUR)}`, `SUMMARY:${summary}`, `ORGANIZER:${external}`,
                `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=CHAIR;PARTSTAT=ACCEPTED:${external}`, `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat};RSVP=TRUE:${owner}`, 'SEQUENCE:0',
            ])]);
            const roles = new Map([...who.addresses, ['owner', owner.replace(/^mailto:/i, '').toLowerCase()]]);
            return simpleFlow(ctx, log, 'I9', { organizer: owner, addresses: roles }, at, [
                { label: 'partstat-accepted', body: (uid) => event(uid, 'ACCEPTED', SUMMARY_OF('I9')) },
                { label: 'summary-change', body: (uid) => event(uid, 'ACCEPTED', `${SUMMARY_OF('I9')} changed`) },
            ], (uid) => event(uid, 'NEEDS-ACTION', SUMMARY_OF('I9')));
        },
    },
    {
        step: 'I10', question: 'Does SCHEDULE-AGENT=CLIENT or NONE on the ATTENDEE suppress the invitation and the cancellation?', sequence: 'create one event with ATTENDEE;SCHEDULE-AGENT=CLIENT and one with SCHEDULE-AGENT=NONE; delete both', roles: ['c', 'n'],
        async run(ctx, log, who, at) {
            const temp = primary(ctx);
            const events = [{ role: 'c', agent: 'CLIENT', label: 'create-client', ...newEvent(temp, 'invi10c') }, { role: 'n', agent: 'NONE', label: 'create-none', ...newEvent(temp, 'invi10n') }];
            const made: typeof events = [];
            try {
                for (const e of events) {
                    const body = calendarText([vevent(e.uid, stampNow(ctx), [
                        `DTSTART:${icalUtc(at)}`, `DTEND:${icalUtc(at + HOUR)}`, `SUMMARY:${SUMMARY_OF('I10')} ${e.agent.toLowerCase()}`, `ORGANIZER:${who.organizer}`, chairLine(who.organizer),
                        attendeeLine(addr(who, e.role), `;SCHEDULE-AGENT=${e.agent}`), 'SEQUENCE:0',
                    ])]);
                    if ((await log.write(e.label, 'PUT', e.url, body, { 'if-none-match': '*' })).ok) {
                        made.push(e);
                    }
                }
                for (const e of made) {
                    await log.read('read', e.url, e.uid, who.addresses, null);
                }
                await pause(ctx, pauseWithinStepMs(ctx.invite.gapMs));
            } finally {
                if (!ctx.http.credentialsRejected) {
                    for (const e of made) {
                        await log.write('delete', 'DELETE', e.url);
                    }
                }
            }
        },
    },
];

function stepCheck(spec: StepSpec, index: number): CheckDef {
    return {
        id: `write-invite-${spec.step.toLowerCase()}`,
        planItem: `Phase 3i invite step ${spec.step} (design §8.5; sends real mail)`,
        claim: `Every request of invite step ${spec.step} (${spec.sequence}) is accepted by iCloud. The question, ${spec.question} is answered by hand from the mailbox, matched by the recorded tag, SUMMARY and UTC times.`,
        needs: 'temp',
        async run(ctx): Promise<CheckOutput> {
            const who = recipients(ctx, spec.step, spec.roles);
            await gapBeforeStep(ctx);
            const temp = primary(ctx);
            const evidence: Evidence = {
                step: fixed(spec.step),
                tags: spec.roles.map((role) => new AuthoredValue(fixed(stepTag(temp.name, spec.step, role)))),
                recipientAddresses: who.addresses.size, mailUpperBound: MAIL_UPPER_BOUND[spec.step], confirmByHand: true,
                startedAt: new AuthoredValue(fixed(new Date(ctx.now()).toISOString())),
            };
            const log = new StepLog(ctx, evidence);
            try {
                await spec.run(ctx, log, who, baseDay(ctx) + (9 + index) * DAY + 16 * HOUR);
            } finally {
                ctx.state.lastInviteStepAt = ctx.now();
                evidence.endedAt = new AuthoredValue(fixed(new Date(ctx.now()).toISOString()));
            }
            const byHand = prose`Check the mailbox by hand against the recorded tags and times.`;
            if (log.writesRefused > 0) {
                return { outcome: 'refuted', summary: prose`${log.writesRefused} write(s) of step ${fixed(spec.step)} were refused. ${byHand}`, evidence };
            }
            if (log.writesFailed > 0 || evidence.requests === undefined) {
                return { outcome: 'inconclusive', summary: prose`Step ${fixed(spec.step)} did not complete. ${byHand}`, evidence };
            }
            return { outcome: 'confirmed', summary: prose`Every write of step ${fixed(spec.step)} was accepted. ${byHand}`, evidence };
        },
    };
}

/** I2 to I10 as checks, in the order of INVITE_STEPS. */
export const INVITE_STEP_CHECKS: ReadonlyMap<string, CheckDef> = new Map(STEPS.map((spec, i) => [spec.step, stepCheck(spec, i)]));

/** Upper bound of mails and the expected duration (seconds of waiting) of a selection of steps. */
export function inviteBudget(steps: readonly string[], gapSeconds: number): { mails: number; waitSeconds: number } {
    const chosen = INVITE_STEPS.filter((s) => steps.includes(s));
    const pauseSeconds = pauseWithinStepMs(gapSeconds * 1000) / 1000;
    return {
        mails: chosen.reduce((n, s) => n + MAIL_UPPER_BOUND[s], 0),
        waitSeconds: Math.max(0, chosen.length - 1) * gapSeconds + chosen.reduce((n, s) => n + PAUSES_WITHIN[s] * pauseSeconds, 0) + (chosen.includes('I1') ? 3 : 0),
    };
}
