import { CheckStop, isOk, isRefusal, type CheckDef } from '../context';
import { eventComponents, getIcal, requireSynthetic } from '../dav';
import { props } from '../ical';
import { fixed, prose, type Safe } from '../safe';
import type { Evidence } from '../types';
import { DAY, HOUR, baseDay, deleteEvent, newEvent, primary, probeCalendar, putEvent, utcSpan } from './write-helpers';

function scheduleCode(value: string | undefined): Safe | null {
    if (value === undefined) {
        return null;
    }
    return /^\d\.\d{1,2}(\.\d{1,2})?(,\d\.\d{1,2}(\.\d{1,2})?)*$/.test(value) ? fixed(value) : fixed('<other>');
}

export const inviteCheck: CheckDef = {
    id: 'write-invite',
    planItem: 'What iCloud provides: Invitations when an event with attendees is saved',
    claim: 'Saving an event with an ORGANIZER and an ATTENDEE makes iCloud deliver an invitation (server-side scheduling, RFC 6638).',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const organizer = ctx.state.addresses.find((a) => /^mailto:/i.test(a));
        const attendee = ctx.inviteAttendee?.trim().toLowerCase();
        if (organizer === undefined) {
            throw new CheckStop('skipped', prose`Skipped: calendar-user-address-set has no mailto address to act as organizer; nothing was sent.`);
        }
        if (attendee === undefined || attendee === '') {
            throw new CheckStop('skipped', prose`Skipped: no invite recipient was given; nothing was sent.`);
        }
        const own = new Set(ctx.state.addresses.map((a) => a.replace(/^mailto:/i, '').toLowerCase()));
        if (own.has(attendee) || attendee === ctx.credentials.appleId.toLowerCase()) {
            throw new CheckStop('skipped', prose`Skipped: the invite recipient is one of this account’s own addresses; nothing was sent.`);
        }
        ctx.taint.add(attendee);
        const { url, uid } = newEvent(temp, 'invite');
        const body = probeCalendar(ctx, uid, [
            ...utcSpan(baseDay(ctx) + 8 * DAY + 16 * HOUR),
            'SUMMARY:caldav-mcp probe invitation',
            `ORGANIZER:${organizer}`,
            `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=CHAIR;PARTSTAT=ACCEPTED:${organizer}`,
            `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee}`,
        ]);
        const put = await putEvent(ctx, url, body, { 'if-none-match': '*' });
        const evidence: Evidence = { putStatus: put.status, scheduleTagHeader: put.headers.has('schedule-tag'), etagHeader: put.etag !== null, confirmByHand: true };
        if (!isOk(put.status)) {
            return { outcome: isRefusal(put.status) ? 'refuted' : 'inconclusive', summary: prose`The event with an attendee was not accepted (HTTP ${put.status}). No invitation should have been sent.`, evidence };
        }
        const first = await getIcal(ctx, url);
        if (first.status === 200) {
            requireSynthetic(first.ical, first.url, temp.url, uid, first.status);
        }
        const invitee = eventComponents(first.ical).flatMap((e) => props(e, 'ATTENDEE')).find((p) => p.value.toLowerCase() === `mailto:${attendee}`);
        const code = scheduleCode(invitee?.params['SCHEDULE-STATUS']);
        evidence.attendeeScheduleStatusPresent = code !== null;
        evidence.scheduleStatus = code;
        await ctx.sleep(3000);
        const second = await getIcal(ctx, url);
        if (second.status === 200) {
            requireSynthetic(second.ical, second.url, temp.url, uid, second.status);
        }
        evidence.etagChangedAfterSave = first.etag !== null && second.etag !== null && first.etag !== second.etag;
        evidence.deleteStatus = await deleteEvent(ctx, url, second.etag ?? first.etag);
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
