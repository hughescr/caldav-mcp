import { CheckStop, isOk, isRefusal, type CheckDef } from '../context';
import { eventComponents, getIcal, requireSynthetic } from '../dav';
import { props } from '../ical';
import { AuthoredValue, fixed, prose } from '../safe';
import type { Evidence } from '../types';
import { absorbStepError, expandTemplate, gapBeforeStep, scheduleCode, stepTag } from './invite-steps';
import { DAY, HOUR, baseDay, deleteEvent, newEvent, primary, probeCalendar, putEvent, utcSpan } from './write-helpers';

const at = (now: number): AuthoredValue => new AuthoredValue(fixed(new Date(now).toISOString()));

/** Invite step I1 (and I4, the cancellation on delete): the original invite check. */
export const inviteCheck: CheckDef = {
    id: 'write-invite',
    planItem: 'What iCloud provides: Invitations when an event with attendees is saved',
    claim: 'Saving an event with an ORGANIZER and an ATTENDEE makes iCloud deliver an invitation (server-side scheduling, RFC 6638).',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const organizer = ctx.state.addresses.find((a) => /^mailto:/i.test(a));
        const template = ctx.inviteAttendee?.trim().toLowerCase();
        if (organizer === undefined) {
            throw new CheckStop('skipped', prose`Skipped: calendar-user-address-set has no mailto address to act as organizer; nothing was sent.`);
        }
        if (template === undefined || template === '') {
            throw new CheckStop('skipped', prose`Skipped: no invite recipient was given; nothing was sent.`);
        }
        const tag = stepTag(temp.name, 'I1');
        const attendee = expandTemplate(template, tag);
        const own = new Set(ctx.state.addresses.map((a) => a.replace(/^mailto:/i, '').toLowerCase()));
        if (own.has(attendee) || attendee === ctx.credentials.appleId.toLowerCase()) {
            throw new CheckStop('skipped', prose`Skipped: the invite recipient is one of this account’s own addresses; nothing was sent.`);
        }
        ctx.taint.add(attendee);
        await gapBeforeStep(ctx);
        const { url, uid } = newEvent(temp, 'invite');
        const body = probeCalendar(ctx, uid, [
            ...utcSpan(baseDay(ctx) + 8 * DAY + 16 * HOUR),
            'SUMMARY:caldav-mcp probe invitation',
            `ORGANIZER:${organizer}`,
            `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=CHAIR;PARTSTAT=ACCEPTED:${organizer}`,
            `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee}`,
        ]);
        const evidence: Evidence = { step: fixed('I1'), tags: [new AuthoredValue(fixed(tag))], putAt: at(ctx.now()) };
        const put = await putEvent(ctx, url, body, { 'if-none-match': '*' });
        Object.assign(evidence, { putStatus: put.status, scheduleTagHeader: put.headers.has('schedule-tag'), etagHeader: put.etag !== null, confirmByHand: true });
        ctx.state.lastInviteStepAt = ctx.now();
        if (!isOk(put.status)) {
            return { outcome: isRefusal(put.status) ? 'refuted' : 'inconclusive', summary: prose`The event with an attendee was not accepted (HTTP ${put.status}). No invitation should have been sent.`, evidence };
        }
        let code: ReturnType<typeof scheduleCode> = null;
        try {
            const first = await getIcal(ctx, url);
            if (first.status === 200) {
                requireSynthetic(first.ical, first.url, temp.url, uid, first.status);
            }
            const invitee = eventComponents(first.ical).flatMap((e) => props(e, 'ATTENDEE')).find((p) => p.value.toLowerCase() === `mailto:${attendee}`);
            code = scheduleCode(invitee?.params['SCHEDULE-STATUS']);
            evidence.attendeeScheduleStatusPresent = code !== null;
            evidence.scheduleStatus = code;
            await ctx.sleep(3000);
            const second = await getIcal(ctx, url);
            if (second.status === 200) {
                requireSynthetic(second.ical, second.url, temp.url, uid, second.status);
            }
            evidence.etagChangedAfterSave = first.etag !== null && second.etag !== null && first.etag !== second.etag;
            evidence.deleteAt = at(ctx.now());
            evidence.deleteStatus = await deleteEvent(ctx, url, second.etag ?? first.etag);
        } catch (error) {
            // The invitation may already have been sent: keep what was recorded, with a fixed code.
            return { outcome: absorbStepError(error, evidence), summary: prose`The invite step stopped after the event was saved; what was sent is recorded. Check the mailbox by hand.`, evidence };
        } finally {
            ctx.state.lastInviteStepAt = ctx.now();
        }
        const byHand = prose`Check the invitee’s mailbox by hand to confirm whether an invitation email arrived; deleting the event may also have sent a cancellation.`;
        if (code !== null && code.startsWith('1.')) {
            return { outcome: 'confirmed', summary: prose`iCloud reported SCHEDULE-STATUS ${code} for the attendee. ${byHand}`, evidence };
        }
        if (code !== null && /^[35]\./.test(code)) {
            return { outcome: 'refuted', summary: prose`iCloud reported a delivery failure (SCHEDULE-STATUS ${code}). ${byHand}`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`iCloud gave no delivery status for the attendee. ${byHand}`, evidence };
    },
};
