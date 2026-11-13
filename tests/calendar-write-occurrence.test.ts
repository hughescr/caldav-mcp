import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createWriteBudget, type BudgetOptions } from '../src/calendar/budget';
import { deleteEvent, updateEvent, WriteError, type WriteDeps } from '../src/calendar/write';
import {
    deleteEventInputSchema, deleteEventResultSchema, GUEST_NOTICE, updateEventInputSchema, writeEventResultSchema, type DeleteEventArgs, type DeleteEventResult, type UpdateEventArgs, type WriteEventResult,
} from '../src/calendar/write-schemas';
import { describeEvents } from '../src/calendar/ics-edit';
import { parseOriginalResource } from '../src/calendar/ical';
import { truncation, type SeriesRead } from '../src/calendar/write-occurrence';
import { FAKE_DISCOVERY, FakeICloud } from './helpers/fake-caldav-write';

// The occurrence scopes against the stateful fake, which models iCloud's measured expansion (see its header). Expected
// request bodies are hand-written; tokens are derived here from the read path's documented format.

const ACCOUNT = 'A'.repeat(43);
const WORK = '/10000000001/calendars/work/';
const NOW_MS = Date.UTC(2026, 10, 13, 9, 0, 0);
const AUTH = { appleId: 'writer@example.invalid', appPassword: 'occurrence-test-canary-pass' };
const NY = 'America/New_York';
const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const occ2 = (local: string, tzid: string): string => `occ2_${local}_${Buffer.from(tzid, 'utf8').toString('base64url')}`;
const splitUid = (operationId: string): string => `cmcp1-${createHash('sha256').update(`caldav-mcp/split/v1\0${ACCOUNT}\0${operationId}`, 'utf8').digest('base64url').slice(0, 32)}`;
const unfold = (text: string): string[] => text.replaceAll(/\r?\n[ \t]/gu, '').split(/\r?\n/u).filter(line => line !== '');

interface Harness { fake: FakeICloud; deps: () => WriteDeps; clock: { ms: number } }

function harness(options: { scopes?: string[]; calendars?: string[] } = {}): Harness {
    const fake = new FakeICloud(options.calendars ?? [WORK]);
    const clock = { ms: 0 };
    const budget: BudgetOptions = { now: () => clock.ms };
    return {
        fake, clock,
        deps: () => ({
            backend: fake, auth: AUTH, discovery: FAKE_DISCOVERY, accountId: ACCOUNT, budget: createWriteBudget(budget),
            now: () => NOW_MS, scopes: options.scopes ?? ['calendar:read', 'calendar:write', 'calendar:delete'],
        }),
    };
}

const update = (h: Harness, input: Record<string, unknown>): Promise<WriteEventResult> => updateEvent(h.deps(), updateEventInputSchema.parse(input) as UpdateEventArgs);
const remove = (h: Harness, input: Record<string, unknown>): Promise<DeleteEventResult> => deleteEvent(h.deps(), deleteEventInputSchema.parse(input) as DeleteEventArgs);

async function failure(action: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try { await action(); } catch (error) {
        if (error instanceof WriteError) { return { code: error.code, ...error.extra }; }
        throw error;
    }
    throw new Error('expected a failure');
}

const methods = (fake: FakeICloud): string[] => fake.calls.map(call => call.method);
const puts = (fake: FakeICloud): { href?: string; precondition?: string; body?: string }[] => fake.calls.filter(call => call.method === 'putEvent');

/** DTSTART/DTEND/RECURRENCE-ID of each instance iCloud (the fake) would now show. */
async function instances(fake: FakeICloud, href: string, startUtc = '20261101T000000Z', endUtc = '20271231T000000Z'): Promise<string[]> {
    const resources = await fake.queryEvents(AUTH, FAKE_DISCOVERY, { calendarId: WORK, range: { startUtc, endUtc } });
    const text = resources.find(resource => resource.href === href)?.calendarData ?? '';
    // A window holding only deleted occurrences returns the stored master alone (measured): a master is not an instance.
    return text.split('BEGIN:VEVENT').slice(1).filter(block => !/\nRRULE[;:]/u.test(block)).map(block => {
        const value = (name: string): string => block.split('\n').find(line => line.startsWith(name))?.replace(/^[^:]*:/u, '') ?? '-';
        return `${value('DTSTART')}/${value('DTEND')}/${value('RECURRENCE-ID')}/${value('SUMMARY')}`;
    });
}

// ---- Stored series ----

const TZ_HREF = `${WORK}WEEKLY-TZ.ics`;
const TZ_SERIES = crlf([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
    'BEGIN:VTIMEZONE', `TZID:${NY}`, 'BEGIN:STANDARD', 'DTSTART:20071104T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:WEEKLY-TZ', 'DTSTAMP:20261101T120000Z', 'CREATED:20261101T120000Z', 'SEQUENCE:0',
    `DTSTART;TZID=${NY}:20261201T100000`, `DTEND;TZID=${NY}:20261201T103000`, 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'SUMMARY:Weekly sync',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
]);

const UTC_HREF = `${WORK}WEEKLY-UTC.ics`;
const UTC_MASTER = [
    'BEGIN:VEVENT', 'UID:WEEKLY-UTC', 'DTSTAMP:20261101T120000Z', 'CREATED:20261101T120000Z', 'SEQUENCE:2',
    'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'RRULE:FREQ=WEEKLY;COUNT=8', 'SUMMARY:Standup', 'LOCATION:Room 1',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
];
const UTC_SERIES = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN', ...UTC_MASTER, 'END:VCALENDAR']);
const withOverride = (text: string, lines: readonly string[]): string => text.replace('END:VCALENDAR\r\n', `${crlf(['BEGIN:VEVENT', ...lines, 'END:VEVENT'])}END:VCALENDAR\r\n`);

const GUESTS = ['ORGANIZER;CN=Owner:mailto:owner@example.test', 'ATTENDEE;CN=Guest;PARTSTAT=ACCEPTED;SCHEDULE-STATUS=1.1:mailto:guest@example.test'];
const withGuests = (text: string): string => text.replace('SUMMARY:Weekly sync\r\n', `SUMMARY:Weekly sync\r\n${crlf(GUESTS)}`);

describe('update_event, edit_scope this', () => {
    test('a new override of a zoned series: the exact body (master untouched), If-Match, six requests, the occurrence read back with its new occ2_ id', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, TZ_HREF, TZ_SERIES);
        const result = await update(h, {
            calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z',
            changes: { title: 'Weekly sync (moved)', start: { local: '2026-12-09T11:00', zone: NY }, end: { local: '2026-12-09T11:30', zone: NY } },
        });
        const [put] = puts(h.fake);
        expect(put?.precondition).toBe(`If-Match: ${etag}`);
        expect(put?.body).toBe(TZ_SERIES.replace('END:VCALENDAR\r\n', crlf([
            'BEGIN:VEVENT', 'UID:WEEKLY-TZ', 'CREATED:20261101T120000Z',
            `DTSTART;TZID=${NY}:20261209T110000`, `DTEND;TZID=${NY}:20261209T113000`, `RECURRENCE-ID;TZID=${NY}:20261208T100000`,
            'SUMMARY:Weekly sync (moved)', 'DTSTAMP:20261113T090000Z', 'LAST-MODIFIED:20261113T090000Z', 'SEQUENCE:1',
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
        ])));
        // Listing, multiget, expanded REPORT, PUT, read-back (multiget + REPORT for the occurrence view): design 5.6.
        expect(methods(h.fake)).toEqual(['listCalendars', 'multigetEvents', 'queryEvents', 'putEvent', 'multigetEvents', 'queryEvents']);
        const id = occ2('20261208T100000', NY);
        expect(writeEventResultSchema.parse(result)).toEqual(result);
        expect<unknown>([result.write_outcome, result.readback, result.recurrence_id, result.stored_differs_from_request, result.expected_version]).toEqual(['applied', 'ok', id, [], h.fake.get(WORK, TZ_HREF)?.etag]);
        expect<unknown>(result.event).toMatchObject({ view: 'occurrence', recurrence_id: id, title: 'Weekly sync (moved)', start: { local: '2026-12-09T11:00:00', zone: NY } });
        // iCloud (the fake) shows that occurrence moved, once, and the others unchanged.
        expect((await instances(h.fake, TZ_HREF, '20261201T000000Z', '20261216T000000Z'))).toEqual([
            '20261201T100000/20261201T103000/20261201T150000Z/Weekly sync', '20261209T110000/20261209T113000/20261208T100000/Weekly sync (moved)', '20261215T100000/20261215T103000/20261215T150000Z/Weekly sync',
        ]);
    });

    test('the same occurrence again by its occ2_ id: its override is patched in place, its RECURRENCE-ID and the master kept', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, TZ_HREF, TZ_SERIES);
        const first = await update(h, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z', changes: { title: 'Moved' } });
        const before = unfold(h.fake.get(WORK, TZ_HREF)?.text ?? '');
        const second = await update(h, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: first.expected_version, edit_scope: 'this', recurrence_id: first.recurrence_id, changes: { title: 'Moved again', location: 'Room 2' } });
        const after = unfold(puts(h.fake)[1]?.body ?? '');
        const master = (lines: string[]): string[] => lines.slice(lines.indexOf('BEGIN:VEVENT'), lines.indexOf('END:VEVENT') + 1);
        expect(master(after)).toEqual(master(before));
        const override = after.slice(after.lastIndexOf('BEGIN:VEVENT'));
        expect(override).toContain(`RECURRENCE-ID;TZID=${NY}:20261208T100000`);
        expect(override).toContain('SUMMARY:Moved again');
        expect(override).toContain('LOCATION:Room 2');
        expect(override).toContain('SEQUENCE:2');
        expect(after.filter(line => line.startsWith('RECURRENCE-ID'))).toHaveLength(1);
        expect<unknown>([second.write_outcome, second.recurrence_id, second.event?.title]).toEqual(['applied', first.recurrence_id, 'Moved again']);
    });

    test('UTC, all-day and floating series: the RECURRENCE-ID copies the master form; the id stays occ1_', async () => {
        const cases = [
            { master: ['DTSTART:20270407T150000Z', 'DTEND:20270407T160000Z'], token: 'occ1_20270414T150000Z', rid: 'RECURRENCE-ID:20270414T150000Z', times: ['DTSTART:20270414T150000Z', 'DTEND:20270414T160000Z'] },
            { master: ['DTSTART;VALUE=DATE:20270408', 'DTEND;VALUE=DATE:20270409'], token: 'occ1_20270415T000000Z', rid: 'RECURRENCE-ID;VALUE=DATE:20270415', times: ['DTSTART;VALUE=DATE:20270415', 'DTEND;VALUE=DATE:20270416'] },
            { master: ['DTSTART:20270409T090000', 'DTEND:20270409T100000'], token: 'occ1_20270416T090000Z', rid: 'RECURRENCE-ID:20270416T090000', times: ['DTSTART:20270416T090000', 'DTEND:20270416T100000'] },
        ];
        for (const item of cases) {
            const h = harness();
            const href = `${WORK}form.ics`;
            const etag = h.fake.seed(WORK, href, crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:FORM-1', ...item.master, 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Series', 'END:VEVENT', 'END:VCALENDAR']));
            const result = await update(h, { calendar_id: WORK, resource_href: href, expected_version: etag, edit_scope: 'this', recurrence_id: item.token, changes: { title: 'One' } });
            const body = unfold(puts(h.fake)[0]?.body ?? '');
            const added = body.slice(body.lastIndexOf('BEGIN:VEVENT'));
            expect<unknown>([item.rid, added.filter(line => /^(DTSTART|DTEND|RECURRENCE-ID)/u.test(line))]).toEqual([item.rid, [...item.times, item.rid]]);
            expect<unknown>([item.token, result.recurrence_id, result.event?.title, result.readback]).toEqual([item.token, item.token, 'One', 'ok']);
        }
    });

    test('DST: an occurrence in the repeated and in the skipped hour gets the expanded DTSTART text as RECURRENCE-ID and replaces exactly it (P3B-4)', async () => {
        for (const item of [
            { start: '20271031T013000', end: '20271031T023000', token: 'occ1_20271107T063000Z', rid: '20271107T013000', times: ['20271107T013000', '20271107T013000'] },
            { start: '20270307T023000', end: '20270307T033000', token: 'occ1_20270314T063000Z', rid: '20270314T013000', times: ['20270314T013000', '20270314T033000'] },
        ]) {
            const h = harness();
            const href = `${WORK}dst.ics`;
            const etag = h.fake.seed(WORK, href, crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:DST-1', `DTSTART;TZID=${NY}:${item.start}`, `DTEND;TZID=${NY}:${item.end}`, 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Night', 'END:VEVENT', 'END:VCALENDAR']));
            const result = await update(h, { calendar_id: WORK, resource_href: href, expected_version: etag, edit_scope: 'this', recurrence_id: item.token, changes: { title: 'Changed' } });
            const added = unfold(puts(h.fake)[0]?.body ?? '').slice(-12);
            expect(added).toContain(`RECURRENCE-ID;TZID=${NY}:${item.rid}`);
            expect(added).toContain(`DTSTART;TZID=${NY}:${item.times[0]}`);
            expect(added).toContain(`DTEND;TZID=${NY}:${item.times[1]}`);
            const shown = await instances(h.fake, href, '20270301T000000Z', '20271201T000000Z');
            expect<unknown>([shown.length, shown.filter(line => line.endsWith('/Changed'))]).toEqual([3, [`${item.times[0]}/${item.times[1]}/${item.rid}/Changed`]]);
            expect(result.recurrence_id).toBe(occ2(item.rid, NY));
        }
    });

    test('a UTC RECURRENCE-ID override on a zoned master (P3B-6) and a moved override of a UTC series are edited in place', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, TZ_HREF, withOverride(TZ_SERIES, ['UID:WEEKLY-TZ', 'RECURRENCE-ID:20261208T150000Z', `DTSTART;TZID=${NY}:20261208T100000`, `DTEND;TZID=${NY}:20261208T103000`, 'SUMMARY:Utc rid']));
        const result = await update(h, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z', changes: { title: 'Still utc rid' } });
        const body = unfold(puts(h.fake)[0]?.body ?? '');
        expect<unknown>([body.filter(line => line.startsWith('RECURRENCE-ID')), result.recurrence_id, result.event?.title]).toEqual([['RECURRENCE-ID:20261208T150000Z'], 'occ1_20261208T150000Z', 'Still utc rid']);

        const moved = harness();
        const movedEtag = moved.fake.seed(WORK, UTC_HREF, withOverride(UTC_SERIES, ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270119T150000Z', 'DTSTART:20270121T090000Z', 'DTEND:20270121T093000Z', 'SUMMARY:Moved']));
        const again = await update(moved, { calendar_id: WORK, resource_href: UTC_HREF, expected_version: movedEtag, edit_scope: 'this', recurrence_id: 'occ1_20270119T150000Z', changes: { description: 'Agenda' } });
        expect<unknown>([again.event?.start, again.event?.description, again.event?.title]).toEqual([{ utc: '2027-01-21T09:00:00Z' }, 'Agenda', 'Moved']);
        expect(unfold(puts(moved.fake)[0]?.body ?? '').filter(line => line.startsWith('RECURRENCE-ID'))).toEqual(['RECURRENCE-ID:20270119T150000Z']);
    });

    test('a change by another client between the expansion and the PUT: 412, re-read differs, calendar_changed, never re-sent', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        h.fake.failNextQuery(fake => { fake.externalEdit(WORK, UTC_HREF, text => text.replace('SUMMARY:Standup', 'SUMMARY:Theirs')); });
        expect(await failure(() => update(h, { calendar_id: WORK, resource_href: UTC_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20270112T150000Z', changes: { title: 'Mine' } }))).toEqual({ code: 'calendar_changed', reason: 'precondition_failed' });
        expect(h.fake.count('putEvent')).toBe(1);
        expect(unfold(h.fake.get(WORK, UTC_HREF)?.text ?? '')).toContain('SUMMARY:Theirs');
    });

    test('a change between the multiget and the expansion: the expansion is of another version, changed_between_reads, nothing sent', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const query = h.fake.queryEvents.bind(h.fake);
        h.fake.queryEvents = async (...args) => {
            h.fake.externalEdit(WORK, UTC_HREF, text => text.replace('SUMMARY:Standup', 'SUMMARY:Theirs'));
            return query(...args);
        };
        expect(await failure(() => update(h, { calendar_id: WORK, resource_href: UTC_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20270112T150000Z', changes: { title: 'Mine' } }))).toEqual({ code: 'calendar_changed', reason: 'changed_between_reads' });
        expect(h.fake.count('putEvent')).toBe(0);
    });

    test('an override added by another client since the read: the version check refuses; the occurrence\'s token is then occ2_', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, TZ_HREF, TZ_SERIES);
        h.fake.externalEdit(WORK, TZ_HREF, text => withOverride(text, ['UID:WEEKLY-TZ', `RECURRENCE-ID;TZID=${NY}:20261208T100000`, `DTSTART;TZID=${NY}:20261208T120000`, `DTEND;TZID=${NY}:20261208T123000`, 'SUMMARY:Theirs']));
        expect(await failure(() => update(h, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z', changes: { title: 'Mine' } }))).toEqual({ code: 'calendar_changed', reason: 'version_mismatch' });
        // With the current version, the old occ1_ id no longer names an instance: not_found, never a guess.
        const current = h.fake.get(WORK, TZ_HREF)?.etag;
        expect(await failure(() => update(h, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: current, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z', changes: { title: 'Mine' } }))).toEqual({ code: 'not_found' });
        expect(h.fake.count('putEvent')).toBe(0);
    });

    test('a repeated call reports desired_state_present by text (UTC series); a zoned series\' new override changed its id, so the old id is calendar_changed', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const request = { calendar_id: WORK, resource_href: UTC_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20270112T150000Z', changes: { title: 'Once' } };
        const first = await update(h, request);
        const second = await update(h, request);
        expect<unknown>([first.write_outcome, second.write_outcome, second.recurrence_id, second.event?.title, h.fake.count('putEvent')]).toEqual(['applied', 'desired_state_present', 'occ1_20270112T150000Z', 'Once', 1]);
        const zoned = harness();
        const zonedEtag = zoned.fake.seed(WORK, TZ_HREF, TZ_SERIES);
        const zonedRequest = { calendar_id: WORK, resource_href: TZ_HREF, expected_version: zonedEtag, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z', changes: { title: 'Once' } };
        await update(zoned, zonedRequest);
        expect(await failure(() => update(zoned, zonedRequest))).toEqual({ code: 'calendar_changed', reason: 'version_mismatch' });
    });

    test('lost answers: saved → desired_state_present; not saved → outcome_unknown; one PUT each', async () => {
        for (const apply of [true, false]) {
            const h = harness();
            const etag = h.fake.seed(WORK, TZ_HREF, TZ_SERIES);
            h.fake.failNextWrite({ kind: 'uncertain', apply });
            const request = { calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20261215T150000Z', changes: { title: 'Lost' } };
            if (apply) {
                const result = await update(h, request);
                expect<unknown>([result.write_outcome, result.recurrence_id, result.event?.title]).toEqual(['desired_state_present', occ2('20261215T100000', NY), 'Lost']);
            } else {
                expect(await failure(() => update(h, request))).toEqual({ code: 'outcome_unknown' });
            }
            expect(h.fake.count('putEvent')).toBe(1);
        }
    });

    test('input rules: recurrence_id required, recurrence not allowed, a single event has no occurrences, an occurrence that does not exist', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const base = { calendar_id: WORK, resource_href: UTC_HREF, expected_version: etag, edit_scope: 'this' };
        expect(await failure(() => update(h, { ...base, changes: { title: 'x' } }))).toEqual({ code: 'invalid_input', reason: 'recurrence_id_required', field: 'recurrence_id' });
        expect(await failure(() => update(h, { ...base, recurrence_id: 'occ1_20270112T150000Z', changes: { recurrence: { rrule: 'FREQ=DAILY' } } }))).toEqual({ code: 'invalid_input', reason: 'recurrence_not_allowed_here', field: 'recurrence' });
        expect(await failure(() => update(h, { ...base, edit_scope: 'all', recurrence_id: 'occ1_20270112T150000Z', changes: { title: 'x' } }))).toEqual({ code: 'invalid_input', reason: 'edit_scope_required', field: 'edit_scope' });
        expect(await failure(() => update(h, { ...base, recurrence_id: 'occ1_20270113T150000Z', changes: { title: 'x' } }))).toEqual({ code: 'not_found' });
        const single = h.fake.seed(WORK, `${WORK}single.ics`, crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:S-1', 'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'SUMMARY:One', 'END:VEVENT', 'END:VCALENDAR']));
        expect(await failure(() => update(h, { ...base, resource_href: `${WORK}single.ics`, expected_version: single, recurrence_id: 'occ1_20270105T150000Z', changes: { title: 'x' } }))).toEqual({ code: 'invalid_input', reason: 'not_repeating', field: 'edit_scope' });
        expect(h.fake.count('putEvent')).toBe(0);
    });

    test('guests: refused without calendar:invite; with it the new override copies the stored ATTENDEE/ORGANIZER lines unchanged', async () => {
        const denied = harness();
        const etag = denied.fake.seed(WORK, TZ_HREF, withGuests(TZ_SERIES));
        const request = { calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z', changes: { title: 'Guests' } };
        expect(await failure(() => update(denied, request))).toEqual({ code: 'attendees_present', reason: 'may_send_invitations' });
        expect(denied.fake.count('queryEvents')).toBe(0);
        const invited = harness({ scopes: ['calendar:read', 'calendar:write', 'calendar:invite'] });
        const invitedEtag = invited.fake.seed(WORK, TZ_HREF, withGuests(TZ_SERIES));
        const result = await update(invited, { ...request, expected_version: invitedEtag });
        const body = unfold(puts(invited.fake)[0]?.body ?? '');
        const added = body.slice(body.lastIndexOf('BEGIN:VEVENT'));
        expect(added.filter(line => /^(ATTENDEE|ORGANIZER)/u.test(line))).toEqual(GUESTS);
        expect(body.filter(line => /^(ATTENDEE|ORGANIZER)/u.test(line))).toEqual([...GUESTS, ...GUESTS]);
        expect<unknown>([result.guests_may_be_emailed, result.guest_notice]).toEqual([true, GUEST_NOTICE]);
    });
});

describe('delete_event, edit_scope this', () => {
    test('an unmoved occurrence: one EXDATE in master form, the exact body, five requests, the series kept with its new version', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const result = await remove(h, { calendar_id: WORK, resource_href: UTC_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20270119T150000Z' });
        expect(puts(h.fake)[0]?.body).toBe(crlf([
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
            'BEGIN:VEVENT', 'UID:WEEKLY-UTC', 'DTSTAMP:20261113T090000Z', 'CREATED:20261101T120000Z', 'SEQUENCE:3',
            'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'RRULE:FREQ=WEEKLY;COUNT=8', 'SUMMARY:Standup', 'LOCATION:Room 1', 'EXDATE:20270119T150000Z', 'LAST-MODIFIED:20261113T090000Z',
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
        ]));
        expect(methods(h.fake)).toEqual(['listCalendars', 'multigetEvents', 'queryEvents', 'putEvent', 'multigetEvents']);
        expect(deleteEventResultSchema.parse(result)).toEqual({
            write_outcome: 'applied', deleted: 'occurrence', calendar_id: WORK, resource_href: UTC_HREF, recurrence_id: 'occ1_20270119T150000Z',
            readback: 'ok', expected_version: h.fake.get(WORK, UTC_HREF)?.etag, stored_differs_from_request: [], calendars: [{ calendar_id: WORK, display_name: 'Calendar work', status: 'ok' }],
        });
        expect((await instances(h.fake, UTC_HREF)).map(line => line.slice(0, 16))).toEqual(['20270105T150000Z', '20270112T150000Z', '20270126T150000Z', '20270202T150000Z', '20270209T150000Z', '20270216T150000Z', '20270223T150000Z']);
        // Again: the occurrence is gone by text, desired_state_present without a request.
        const again = await remove(h, { calendar_id: WORK, resource_href: UTC_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20270119T150000Z' });
        expect<unknown>([again.write_outcome, again.expected_version, h.fake.count('putEvent')]).toEqual(['desired_state_present', h.fake.get(WORK, UTC_HREF)?.etag, 1]);
    });

    test('an occurrence with an override: the override removed, EXDATE in the master form; all-day form; a UTC override on a zoned master is refused (form)', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, TZ_HREF, withOverride(TZ_SERIES, ['UID:WEEKLY-TZ', `RECURRENCE-ID;TZID=${NY}:20261208T100000`, `DTSTART;TZID=${NY}:20261209T110000`, `DTEND;TZID=${NY}:20261209T113000`, 'SUMMARY:Moved']));
        const result = await remove(h, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: occ2('20261208T100000', NY) });
        const body = unfold(puts(h.fake)[0]?.body ?? '');
        expect<unknown>([body.filter(line => line.startsWith('EXDATE')), body.filter(line => line === 'BEGIN:VEVENT').length, result.stored_differs_from_request]).toEqual([[`EXDATE;TZID=${NY}:20261208T100000`], 1, []]);
        expect((await instances(h.fake, TZ_HREF, '20261205T000000Z', '20261212T000000Z'))).toEqual([]);

        const day = harness();
        const href = `${WORK}day.ics`;
        const dayEtag = day.fake.seed(WORK, href, crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:DAY-1', 'DTSTART;VALUE=DATE:20270603', 'DTEND;VALUE=DATE:20270604', 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Day', 'END:VEVENT', 'END:VCALENDAR']));
        await remove(day, { calendar_id: WORK, resource_href: href, expected_version: dayEtag, edit_scope: 'this', recurrence_id: 'occ1_20270617T000000Z' });
        expect(unfold(puts(day.fake)[0]?.body ?? '').filter(line => line.startsWith('EXDATE'))).toEqual(['EXDATE;VALUE=DATE:20270617']);

        const mixed = harness();
        const mixedEtag = mixed.fake.seed(WORK, TZ_HREF, withOverride(TZ_SERIES, ['UID:WEEKLY-TZ', 'RECURRENCE-ID:20261208T150000Z', `DTSTART;TZID=${NY}:20261208T100000`, `DTEND;TZID=${NY}:20261208T103000`, 'SUMMARY:Utc rid']));
        expect(await failure(() => remove(mixed, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: mixedEtag, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z' }))).toEqual({ code: 'occurrence_identity_unprovable', reason: 'form_mismatch' });
        expect(mixed.fake.count('putEvent')).toBe(0);
    });

    test('guests: an exclusion needs calendar:invite and keeps the guest lines', async () => {
        const denied = harness();
        const etag = denied.fake.seed(WORK, TZ_HREF, withGuests(TZ_SERIES));
        expect(await failure(() => remove(denied, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z' }))).toEqual({ code: 'attendees_present', reason: 'may_send_invitations' });
        const invited = harness({ scopes: ['calendar:read', 'calendar:delete', 'calendar:invite'] });
        const invitedEtag = invited.fake.seed(WORK, TZ_HREF, withGuests(TZ_SERIES));
        const result = await remove(invited, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: invitedEtag, edit_scope: 'this', recurrence_id: 'occ1_20261208T150000Z' });
        expect<unknown>([result.guests_may_be_emailed, unfold(puts(invited.fake)[0]?.body ?? '').filter(line => /^(ATTENDEE|ORGANIZER)/u.test(line))]).toEqual([true, GUESTS]);
    });
});

describe('delete_event, edit_scope this_and_future', () => {
    test('the exact truncated body (COUNT replaced by UNTIL = split - 1 s), expansion ends before the split, retry is desired_state_present', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const request = { calendar_id: WORK, resource_href: UTC_HREF, expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270126T150000Z' };
        const result = await remove(h, request);
        expect(puts(h.fake)[0]?.body).toBe(crlf([
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
            'BEGIN:VEVENT', 'UID:WEEKLY-UTC', 'DTSTAMP:20261113T090000Z', 'CREATED:20261101T120000Z', 'SEQUENCE:3',
            'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20270126T145959Z', 'SUMMARY:Standup', 'LOCATION:Room 1', 'LAST-MODIFIED:20261113T090000Z',
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
        ]));
        expect<unknown>([result.deleted, result.write_outcome, result.stored_differs_from_request]).toEqual(['following', 'applied', []]);
        expect((await instances(h.fake, UTC_HREF)).map(line => line.slice(0, 16))).toEqual(['20270105T150000Z', '20270112T150000Z', '20270119T150000Z']);
        expect((await remove(h, request)).write_outcome).toBe('desired_state_present');
        expect(h.fake.count('putEvent')).toBe(1);
    });

    test('overrides at or after the split are removed, earlier ones kept; zoned series use the expanded UTC instant; the first occurrence is refused', async () => {
        const h = harness();
        const text = withOverride(withOverride(TZ_SERIES, ['UID:WEEKLY-TZ', `RECURRENCE-ID;TZID=${NY}:20261208T100000`, `DTSTART;TZID=${NY}:20261208T100000`, `DTEND;TZID=${NY}:20261208T103000`, 'SUMMARY:Before']),
            ['UID:WEEKLY-TZ', `RECURRENCE-ID;TZID=${NY}:20261222T100000`, `DTSTART;TZID=${NY}:20261222T100000`, `DTEND;TZID=${NY}:20261222T103000`, 'SUMMARY:After']);
        const etag = h.fake.seed(WORK, TZ_HREF, text);
        await remove(h, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20261215T150000Z' });
        const body = unfold(puts(h.fake)[0]?.body ?? '');
        expect<unknown>([body.filter(line => line.startsWith('RRULE')), body.filter(line => line.startsWith('RECURRENCE-ID'))]).toEqual([['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z'], [`RECURRENCE-ID;TZID=${NY}:20261208T100000`]]);
        const first = harness();
        const firstEtag = first.fake.seed(WORK, TZ_HREF, TZ_SERIES);
        expect(await failure(() => remove(first, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: firstEtag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20261201T150000Z' }))).toEqual({ code: 'edit_not_supported', reason: 'split_at_series_start' });
        // A changed occurrence of a zoned series has no UTC instant in iCloud's text: refused, never computed.
        const changed = harness();
        const changedEtag = changed.fake.seed(WORK, TZ_HREF, text);
        expect(await failure(() => remove(changed, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: changedEtag, edit_scope: 'this_and_future', recurrence_id: occ2('20261222T100000', NY) }))).toEqual({ code: 'edit_not_supported', reason: 'split_at_changed_zoned_occurrence' });
    });

    test('RDATE and EXRULE series are refused', async () => {
        for (const [line, reason] of [['RDATE:20270301T150000Z', 'rdate_present'], ['EXRULE:FREQ=MONTHLY', 'exrule_present']] as const) {
            const h = harness();
            const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES.replace('SUMMARY:Standup', `${line}\r\nSUMMARY:Standup`));
            expect(await failure(() => remove(h, { calendar_id: WORK, resource_href: UTC_HREF, expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270126T150000Z' }))).toEqual({ code: 'edit_not_supported', reason });
        }
    });
});

describe('update_event, edit_scope this_and_future (split)', () => {
    const OP = 'op-split-0001';
    const NEW_HREF = `${WORK}${splitUid(OP)}.ics`;
    const splitRequest = (etag: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        calendar_id: WORK, resource_href: UTC_HREF, expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270126T150000Z', operation_id: OP, changes: { title: 'Standup (new format)' }, ...extra,
    });

    test('a COUNT series: the exact bodies, new series first (If-None-Match) then the original (If-Match); COUNT left from iCloud\'s expansion; both read back in one multiget', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const result = await update(h, splitRequest(etag));
        const [create, truncate] = puts(h.fake);
        expect<unknown>([create?.href, create?.precondition, truncate?.href, truncate?.precondition]).toEqual([NEW_HREF, 'If-None-Match: *', UTC_HREF, `If-Match: ${etag}`]);
        expect(create?.body).toBe(crlf([
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//caldav-mcp//EN', 'CALSCALE:GREGORIAN',
            'BEGIN:VEVENT', `UID:${splitUid(OP)}`, 'LOCATION:Room 1', 'DTSTART:20270126T150000Z', 'DTEND:20270126T153000Z', 'RRULE:FREQ=WEEKLY;COUNT=5', 'SUMMARY:Standup (new format)',
            'DTSTAMP:20261113T090000Z', 'CREATED:20261113T090000Z', 'LAST-MODIFIED:20261113T090000Z', 'SEQUENCE:0',
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
        ]));
        expect(truncate?.body).toBe(crlf([
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
            'BEGIN:VEVENT', 'UID:WEEKLY-UTC', 'DTSTAMP:20261113T090000Z', 'CREATED:20261101T120000Z', 'SEQUENCE:3',
            'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20270126T145959Z', 'SUMMARY:Standup', 'LOCATION:Room 1', 'LAST-MODIFIED:20261113T090000Z',
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
        ]));
        // Listing, multiget, REPORT (occurrence), REPORT (count), PUT new, PUT original, one multiget of both.
        expect(methods(h.fake)).toEqual(['listCalendars', 'multigetEvents', 'queryEvents', 'queryEvents', 'putEvent', 'putEvent', 'multigetEvents']);
        expect(h.fake.calls.at(-1)?.hrefs).toEqual([UTC_HREF, NEW_HREF]);
        expect(writeEventResultSchema.parse(result)).toEqual(result);
        expect<unknown>([result.write_outcome, result.resource_href, result.expected_version, result.created_series, result.stored_differs_from_request, result.event?.resource_href, result.event?.title]).toEqual([
            'applied', UTC_HREF, h.fake.get(WORK, UTC_HREF)?.etag, { resource_href: NEW_HREF, expected_version: h.fake.get(WORK, NEW_HREF)?.etag, write_outcome: 'applied' }, [], NEW_HREF, 'Standup (new format)',
        ]);
        // Together the two series show each slot once: 3 before, 5 from the split on.
        expect((await instances(h.fake, UTC_HREF)).length).toBe(3);
        expect((await instances(h.fake, NEW_HREF)).map(line => line.slice(0, 16))).toEqual(['20270126T150000Z', '20270202T150000Z', '20270209T150000Z', '20270216T150000Z', '20270223T150000Z']);
        // The same call again on the old version: the truncation removed the source of what the new series carried, so its
        // content cannot be proven by text; nothing is sent and the call says the event changed.
        expect(await failure(() => update(h, splitRequest(etag)))).toEqual({ code: 'calendar_changed', reason: 'version_mismatch' });
        expect(h.fake.count('putEvent')).toBe(2);
    });

    test('a stale retry of a split that dropped its exceptions is provable by text: desired_state_present; a changed new series is not', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, withOverride(UTC_SERIES, ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270202T150000Z', 'DTSTART:20270202T160000Z', 'DTEND:20270202T163000Z', 'SUMMARY:Late']));
        const request = splitRequest(etag, { exceptions: 'drop', changes: { title: 'Later', start: '2027-01-26T17:00:00Z', end: '2027-01-26T17:30:00Z', recurrence: { rrule: 'FREQ=WEEKLY;COUNT=5' } } });
        await update(h, request);
        const again = await update(h, request);
        expect<unknown>([again.write_outcome, again.created_series?.write_outcome, h.fake.count('putEvent')]).toEqual(['desired_state_present', 'desired_state_present', 2]);
        h.fake.externalEdit(WORK, NEW_HREF, body => body.replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:' + splitUid(OP) + '\r\nRECURRENCE-ID:20270209T170000Z\r\nDTSTART:20270209T180000Z\r\nDTEND:20270209T183000Z\r\nSUMMARY:Added\r\nEND:VEVENT\r\nEND:VCALENDAR'));
        expect(await failure(() => update(h, request))).toEqual({ code: 'calendar_changed', reason: 'version_mismatch' });
    });

    test('exceptions from the split on move to the new series (UID replaced); EXDATEs are copied; earlier ones stay (P3C-3)', async () => {
        const h = harness();
        const text = withOverride(withOverride(UTC_SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=8', 'RRULE:FREQ=WEEKLY;UNTIL=20270301T000000Z\r\nEXDATE:20270209T150000Z'),
            ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270112T150000Z', 'DTSTART:20270112T160000Z', 'DTEND:20270112T163000Z', 'SUMMARY:Early']),
            ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270202T150000Z', 'DTSTART:20270203T150000Z', 'DTEND:20270203T153000Z', 'SUMMARY:Late']);
        const etag = h.fake.seed(WORK, UTC_HREF, text);
        await update(h, splitRequest(etag));
        const created = unfold(puts(h.fake)[0]?.body ?? '');
        expect(created.filter(line => /^(RRULE|EXDATE|RECURRENCE-ID|UID)/u.test(line))).toEqual(['UID:' + splitUid(OP), 'RRULE:FREQ=WEEKLY;UNTIL=20270301T000000Z', 'EXDATE:20270209T150000Z', 'UID:' + splitUid(OP), 'RECURRENCE-ID:20270202T150000Z']);
        expect(unfold(puts(h.fake)[1]?.body ?? '').filter(line => line.startsWith('RECURRENCE-ID'))).toEqual(['RECURRENCE-ID:20270112T150000Z']);
        expect((await instances(h.fake, NEW_HREF)).map(line => line.split('/').slice(0, 3).join('/'))).toEqual(['20270126T150000Z/20270126T153000Z/20270126T150000Z', '20270203T150000Z/20270203T153000Z/20270202T150000Z', '20270216T150000Z/20270216T153000Z/20270216T150000Z', '20270223T150000Z/20270223T153000Z/20270223T150000Z']);
    });

    test('COUNT left unprovable (an EXDATE before the split): count_series_needs_rrule; with the agent\'s rule it is used as given', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=8', 'RRULE:FREQ=WEEKLY;COUNT=8\r\nEXDATE:20270112T150000Z'));
        expect(await failure(() => update(h, splitRequest(etag)))).toEqual({ code: 'edit_not_supported', reason: 'count_series_needs_rrule' });
        expect(h.fake.count('putEvent')).toBe(0);
        const result = await update(h, splitRequest(etag, { changes: { title: 'Standup (new format)', recurrence: { rrule: 'FREQ=WEEKLY;COUNT=5' } } }));
        expect<unknown>([result.write_outcome, unfold(puts(h.fake)[0]?.body ?? '').filter(line => line.startsWith('RRULE'))]).toEqual(['applied', ['RRULE:FREQ=WEEKLY;COUNT=5']]);
    });

    test('the second write refused: split_incomplete with created_series; the same call again finishes the split', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        h.fake.failNextWrite({ kind: 'none' }, { kind: 'status', status: 403, apply: false });
        const error = await failure(() => update(h, splitRequest(etag)));
        expect(error).toEqual({ code: 'split_incomplete', reason: 'second_write_refused', created_series: { resource_href: NEW_HREF, expected_version: h.fake.get(WORK, NEW_HREF)?.etag, write_outcome: 'applied' }, upstream: { status: 403, content_type: 'none', preconditions: [], detail: null } });
        expect<unknown>([h.fake.get(WORK, UTC_HREF)?.etag, h.fake.hrefs(WORK)]).toEqual([etag, [NEW_HREF, UTC_HREF].sort()]);
        const finished = await update(h, splitRequest(etag));
        expect<unknown>([finished.write_outcome, finished.created_series?.write_outcome, h.fake.count('putEvent')]).toEqual(['applied', 'desired_state_present', 4]);
        expect((await instances(h.fake, UTC_HREF)).length).toBe(3);
    });

    test('a retry never truncates when the new series lost a copied override or EXDATE: split_incomplete (created_series_differs)', async () => {
        const text = withOverride(UTC_SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=8', 'RRULE:FREQ=WEEKLY;COUNT=8\r\nEXDATE:20270209T150000Z'),
            ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270202T150000Z', 'DTSTART:20270202T160000Z', 'DTEND:20270202T163000Z', 'SUMMARY:Late']);
        const cases: [string, (body: string) => string][] = [
            ['override removed', body => body.replace(/BEGIN:VEVENT\r\nUID:[^\r]*\r\nRECURRENCE-ID[\s\S]*?END:VEVENT\r\n/u, '')],
            ['EXDATE removed', body => body.replace('EXDATE:20270209T150000Z\r\n', '')],
            ['override changed', body => body.replace('SUMMARY:Late', 'SUMMARY:Edited')],
        ];
        for (const [name, change] of cases) {
            const h = harness();
            const etag = h.fake.seed(WORK, UTC_HREF, text);
            h.fake.failNextWrite({ kind: 'none' }, { kind: 'status', status: 403, apply: false });
            expect<unknown>([name, (await failure(() => update(h, splitRequest(etag)))).reason]).toEqual([name, 'second_write_refused']);
            const before = h.fake.get(WORK, NEW_HREF)?.text ?? '';
            const edited = h.fake.externalEdit(WORK, NEW_HREF, change);
            expect<unknown>([name, h.fake.get(WORK, NEW_HREF)?.text !== before]).toEqual([name, true]);
            expect<unknown>([name, await failure(() => update(h, splitRequest(etag)))]).toEqual([name, { code: 'split_incomplete', reason: 'created_series_differs', created_series: { resource_href: NEW_HREF, expected_version: edited, write_outcome: 'unconfirmed' } }]);
            // The retry's create was refused (412) and nothing else was sent: the original still holds the exception.
            expect<unknown>([name, h.fake.count('putEvent'), h.fake.get(WORK, UTC_HREF)?.etag]).toEqual([name, 3, etag]);
        }

        // The new series intact: the retry finishes, and the read-back finds every exception in place.
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, text);
        h.fake.failNextWrite({ kind: 'none' }, { kind: 'status', status: 403, apply: false });
        await failure(() => update(h, splitRequest(etag)));
        const finished = await update(h, splitRequest(etag));
        expect<unknown>([finished.write_outcome, finished.created_series?.write_outcome, finished.stored_differs_from_request, h.fake.count('putEvent')]).toEqual(['applied', 'desired_state_present', [], 4]);
        expect(unfold(h.fake.get(WORK, UTC_HREF)?.text ?? '').some(line => line.startsWith('RECURRENCE-ID'))).toBe(false);
    });

    test('the read-back covers the copied exceptions: one lost after the write is reported as recurrence', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, withOverride(UTC_SERIES, ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270202T150000Z', 'DTSTART:20270202T160000Z', 'DTEND:20270202T163000Z', 'SUMMARY:Late']));
        const put = h.fake.putEvent.bind(h.fake);
        let sent = 0;
        h.fake.putEvent = async (...args) => {
            const answer = await put(...args);
            if (++sent === 2) { h.fake.externalEdit(WORK, NEW_HREF, body => body.replace('SUMMARY:Late', 'SUMMARY:Edited')); }
            return answer;
        };
        const result = await update(h, splitRequest(etag));
        expect<unknown>([result.write_outcome, result.stored_differs_from_request]).toEqual(['applied', ['recurrence']]);
    });

    test('the second write uncertain: observed → desired_state_present; not observed → outcome_unknown naming the new series; a concurrent edit → split_incomplete', async () => {
        const saved = harness();
        const savedEtag = saved.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        saved.fake.failNextWrite({ kind: 'none' }, { kind: 'uncertain', apply: true });
        const result = await update(saved, splitRequest(savedEtag));
        expect<unknown>([result.write_outcome, result.created_series?.write_outcome]).toEqual(['desired_state_present', 'applied']);

        const lost = harness();
        const lostEtag = lost.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        lost.fake.failNextWrite({ kind: 'none' }, { kind: 'uncertain', apply: false });
        expect(await failure(() => update(lost, splitRequest(lostEtag)))).toEqual({ code: 'outcome_unknown', created_series: { resource_href: NEW_HREF, expected_version: lost.fake.get(WORK, NEW_HREF)?.etag, write_outcome: 'applied' } });

        const raced = harness();
        const racedEtag = raced.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        raced.fake.failNextWrite({ kind: 'none' }, { kind: 'concurrent', change: fake => { fake.externalEdit(WORK, UTC_HREF, text => text.replace('SUMMARY:Standup', 'SUMMARY:Theirs')); } });
        expect(await failure(() => update(raced, splitRequest(racedEtag)))).toMatchObject({ code: 'split_incomplete', reason: 'original_changed_since', created_series: { resource_href: NEW_HREF, write_outcome: 'applied' } });
        expect(raced.fake.count('putEvent')).toBe(2);
    });

    test('no time for the second write after the first: split_incomplete; too little time for both before the first: nothing sent', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const put = h.fake.putEvent.bind(h.fake);
        h.fake.putEvent = async (...args) => {
            const answer = await put(...args);
            h.clock.ms += 19_000;
            return answer;
        };
        expect(await failure(() => update(h, splitRequest(etag)))).toMatchObject({ code: 'split_incomplete', reason: 'no_time_for_second_write', created_series: { resource_href: NEW_HREF } });
        expect(h.fake.count('putEvent')).toBe(1);

        const late = harness();
        const lateEtag = late.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const query = late.fake.queryEvents.bind(late.fake);
        late.fake.queryEvents = async (...args) => {
            late.clock.ms += 5_000;
            return query(...args);
        };
        expect(await failure(() => update(late, splitRequest(lateEtag)))).toEqual({ code: 'temporarily_unavailable' });
        expect(late.fake.count('putEvent')).toBe(0);
    });

    test('the first write: a different series already at the href is calendar_changed; operation_id is required; the first occurrence is refused', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        h.fake.seed(WORK, NEW_HREF, crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${splitUid(OP)}`, 'DTSTART:20270126T150000Z', 'DTEND:20270126T153000Z', 'SUMMARY:Other', 'END:VEVENT', 'END:VCALENDAR']));
        expect(await failure(() => update(h, splitRequest(etag)))).toEqual({ code: 'calendar_changed', reason: 'existing_resource_differs' });
        expect<unknown>([h.fake.count('putEvent'), h.fake.get(WORK, UTC_HREF)?.etag]).toEqual([1, etag]);
        expect(await failure(() => update(h, splitRequest(etag, { operation_id: undefined })))).toEqual({ code: 'invalid_input', reason: 'operation_id_required', field: 'operation_id' });
        expect(await failure(() => update(h, splitRequest(etag, { recurrence_id: 'occ1_20270105T150000Z', operation_id: 'op-split-0002' })))).toEqual({ code: 'edit_not_supported', reason: 'split_at_series_start' });
    });

    test('new times for the new series with exceptions after the split: a choice is required; drop leaves them out; shift is refused', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, withOverride(UTC_SERIES, ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270202T150000Z', 'DTSTART:20270203T150000Z', 'DTEND:20270203T153000Z', 'SUMMARY:Late']));
        const moved = { changes: { title: 'Later', start: '2027-01-26T17:00:00Z', end: '2027-01-26T17:30:00Z', recurrence: { rrule: 'FREQ=WEEKLY;COUNT=5' } } };
        expect(await failure(() => update(h, splitRequest(etag, moved)))).toEqual({ code: 'edit_not_supported', reason: 'exceptions_choice_required', exceptions: { changed_occurrences: 1, deleted_occurrences: 0 } });
        expect(await failure(() => update(h, splitRequest(etag, { ...moved, exceptions: 'shift' })))).toEqual({ code: 'edit_not_supported', reason: 'exceptions_shift_not_supported_for_split' });
        const result = await update(h, splitRequest(etag, { ...moved, exceptions: 'drop' }));
        const created = unfold(puts(h.fake)[0]?.body ?? '');
        expect<unknown>([created.filter(line => /^(DTSTART|DTEND|RECURRENCE-ID)/u.test(line)), result.write_outcome]).toEqual([['DTSTART:20270126T170000Z', 'DTEND:20270126T173000Z'], 'applied']);
        expect(unfold(puts(h.fake)[1]?.body ?? '').some(line => line.startsWith('RECURRENCE-ID'))).toBe(false);
    });

    test('a rule change for the new series is a move: exceptions from the split on need "drop"; earlier ones do not count', async () => {
        const h = harness();
        const text = withOverride(UTC_SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=8', 'RRULE:FREQ=WEEKLY;COUNT=8\r\nEXDATE:20270112T150000Z,20270216T150000Z'),
            ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270202T150000Z', 'DTSTART:20270202T160000Z', 'DTEND:20270202T163000Z', 'SUMMARY:Late']);
        const etag = h.fake.seed(WORK, UTC_HREF, text);
        // Every other week from Jan 26: Feb 2 and Feb 16 are no longer occurrences, so carrying them would orphan them.
        const ruled = { changes: { recurrence: { rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=3' } } };
        expect(await failure(() => update(h, splitRequest(etag, ruled)))).toEqual({ code: 'edit_not_supported', reason: 'exceptions_choice_required', exceptions: { changed_occurrences: 1, deleted_occurrences: 1 } });
        expect(h.fake.count('putEvent')).toBe(0);
        const result = await update(h, splitRequest(etag, { ...ruled, exceptions: 'drop' }));
        const created = unfold(puts(h.fake)[0]?.body ?? '');
        expect<unknown>([result.write_outcome, created.filter(line => /^(RRULE|EXDATE|RECURRENCE-ID)/u.test(line)), result.stored_differs_from_request]).toEqual(['applied', ['RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3'], []]);
        expect((await instances(h.fake, NEW_HREF)).map(line => line.slice(0, 16))).toEqual(['20270126T150000Z', '20270209T150000Z', '20270223T150000Z']);
        // iCloud stored the parts in its own order (measured); the read-back above still found the rule as requested.
        expect(unfold(h.fake.get(WORK, NEW_HREF)?.text ?? '')).toContain('RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=2');
        // The same call on the old version is provable by text (the exceptions were dropped).
        const again = await update(h, splitRequest(etag, { ...ruled, exceptions: 'drop' }));
        expect<unknown>([again.write_outcome, again.created_series?.write_outcome, h.fake.count('putEvent')]).toEqual(['desired_state_present', 'desired_state_present', 2]);
    });

    test('a split whose second write failed finishes on the same call although iCloud reordered the new rule\'s parts', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const request = splitRequest(etag, { changes: { recurrence: { rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=3' } } });
        h.fake.failNextWrite({ kind: 'none' }, { kind: 'status', status: 403, apply: false });
        expect((await failure(() => update(h, request))).code).toBe('split_incomplete');
        expect(unfold(h.fake.get(WORK, NEW_HREF)?.text ?? '')).toContain('RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=2');
        const finished = await update(h, request);
        expect<unknown>([finished.write_outcome, finished.created_series?.write_outcome, finished.stored_differs_from_request, h.fake.count('putEvent')]).toEqual(['applied', 'desired_state_present', [], 4]);
        expect((await instances(h.fake, UTC_HREF)).length).toBe(3);
    });

    test('a split that drops lists what it dropped (EXDATE values, not lines), in the result and in split_incomplete and outcome_unknown', async () => {
        const text = withOverride(UTC_SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=8', 'RRULE:FREQ=WEEKLY;COUNT=8\r\nEXDATE:20270112T150000Z\r\nEXDATE:20270209T150000Z,20270216T150000Z'),
            ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270202T150000Z', 'DTSTART:20270202T160000Z', 'DTEND:20270202T163000Z', 'SUMMARY:Late']);
        const dropped = {
            changed_occurrences: 1, deleted_occurrences: 2,
            changed: [{ original_start: { utc: '2027-02-02T15:00:00Z' }, start: { utc: '2027-02-02T16:00:00Z' }, title: 'Late' }],
            deleted: [{ utc: '2027-02-09T15:00:00Z' }, { utc: '2027-02-16T15:00:00Z' }],
        };
        const moved = { exceptions: 'drop', changes: { start: '2027-01-26T17:00:00Z', end: '2027-01-26T17:30:00Z', recurrence: { rrule: 'FREQ=WEEKLY;COUNT=5' } } };
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, text);
        expect(await failure(() => update(h, splitRequest(etag, { ...moved, exceptions: undefined })))).toEqual({ code: 'edit_not_supported', reason: 'exceptions_choice_required', exceptions: { changed_occurrences: 1, deleted_occurrences: 2 } });
        const result = await update(h, splitRequest(etag, moved));
        expect(writeEventResultSchema.parse(result)).toEqual(result);
        expect<unknown>([result.write_outcome, result.exceptions_dropped]).toEqual(['applied', dropped]);

        const refused = harness();
        const refusedEtag = refused.fake.seed(WORK, UTC_HREF, text);
        refused.fake.failNextWrite({ kind: 'none' }, { kind: 'status', status: 403, apply: false });
        expect(await failure(() => update(refused, splitRequest(refusedEtag, moved)))).toMatchObject({ code: 'split_incomplete', reason: 'second_write_refused', exceptions_dropped: dropped });

        const lost = harness();
        const lostEtag = lost.fake.seed(WORK, UTC_HREF, text);
        lost.fake.failNextWrite({ kind: 'none' }, { kind: 'uncertain', apply: false });
        expect(await failure(() => update(lost, splitRequest(lostEtag, moved)))).toMatchObject({ code: 'outcome_unknown', created_series: { resource_href: NEW_HREF }, exceptions_dropped: dropped });

        // Without anything dropped there is no inventory.
        const plain = harness();
        const plainEtag = plain.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        expect((await update(plain, splitRequest(plainEtag))).exceptions_dropped).toBeUndefined();
    });

    test('a split carrying many overrides does linear work: 250 vs 1,000 carried overrides', async () => {
        const href = `${WORK}BIG-SPLIT.ics`;
        const series = (count: number): string => {
            const overrides = Array.from({ length: count }, (_, index) => {
                const day = new Date(Date.UTC(2027, 0, 19) + index * 7 * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
                return ['BEGIN:VEVENT', 'UID:BIG-SPLIT', 'DTSTAMP:20261105T120000Z', `RECURRENCE-ID:${day}T150000Z`, `DTSTART:${day}T160000Z`, `DTEND:${day}T170000Z`, `SUMMARY:Weekly ${String(index)}`, 'END:VEVENT'];
            });
            return crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic//EN', 'BEGIN:VEVENT', 'UID:BIG-SPLIT', 'DTSTAMP:20261101T120000Z', 'SEQUENCE:1', 'DTSTART:20270105T150000Z', 'DTEND:20270105T160000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly', 'END:VEVENT', ...overrides.flat(), 'END:VCALENDAR']);
        };
        const timed = async (count: number): Promise<number> => {
            let best = Number.POSITIVE_INFINITY;
            for (let run = 0; run < 3; run++) {
                const h = harness();
                const etag = h.fake.seed(WORK, href, series(count));
                const started = performance.now();
                const result = await update(h, { calendar_id: WORK, resource_href: href, expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270112T150000Z', operation_id: `op-big-split-${String(count)}`, changes: { title: 'Renamed' } });
                best = Math.min(best, performance.now() - started);
                expect<unknown>([count, result.write_outcome, result.stored_differs_from_request]).toEqual([count, 'applied', []]);
                expect(unfold(puts(h.fake)[0]?.body ?? '').filter(line => line.startsWith('RECURRENCE-ID')).length).toBe(count);
            }
            return best;
        };
        const small = await timed(250);
        const large = await timed(1000);
        // Linear work is about 4x for 4x the overrides; per-override scans of every override are about 16x. Generous bound.
        expect<unknown>({ small, large, ratio: large / small, linear: large / small < 9 }).toMatchObject({ linear: true });

        // Within the 2 MiB cap a per-override scan costs too little to show in time, so count it: naming the RECURRENCE-ID
        // line of every carried override visits the overrides a constant number of times each, not once per override.
        const text = series(1000);
        let visits = 0;
        const parsed = parseOriginalResource(text, {});
        const overrides = new Proxy(parsed.overrides, { get: (items, key, receiver) => { if (typeof key === 'string' && /^\d+$/u.test(key)) { visits++; } return Reflect.get(items, key, receiver) as unknown; } });
        const read = { summary: {}, reporter: async () => {}, found: { href, etag: '"e"', calendarData: text }, original: { ...parsed, overrides }, guests: false, outlines: describeEvents(text) } as unknown as SeriesRead;
        const master = parsed.master;
        if (master === null) { throw new Error('master expected'); }
        const trunc = truncation(read, master, '20270112T150000Z', { kind: 'utc', utc: '20270112T150000Z' });
        expect<unknown>([trunc.removed.length, visits <= 4 * 1000]).toEqual([1000, true]);
    }, 60_000);

    test('shift is refused for every split, also without a time change; nothing is sent', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, UTC_HREF, withOverride(UTC_SERIES, ['UID:WEEKLY-UTC', 'RECURRENCE-ID:20270202T150000Z', 'DTSTART:20270203T150000Z', 'DTEND:20270203T153000Z', 'SUMMARY:Late']));
        expect(await failure(() => update(h, splitRequest(etag, { exceptions: 'shift' })))).toEqual({ code: 'edit_not_supported', reason: 'exceptions_shift_not_supported_for_split' });
        const plain = harness();
        const plainEtag = plain.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        expect(await failure(() => update(plain, splitRequest(plainEtag, { exceptions: 'shift' })))).toEqual({ code: 'edit_not_supported', reason: 'exceptions_shift_not_supported_for_split' });
        expect<unknown>([h.fake.count('putEvent'), plain.fake.count('putEvent')]).toEqual([0, 0]);
    });

    test('guests: the new series keeps the stored ATTENDEE/ORGANIZER lines, copied unchanged (invite only)', async () => {
        const denied = harness();
        const etag = denied.fake.seed(WORK, UTC_HREF, UTC_SERIES.replace('SUMMARY:Standup\r\n', `SUMMARY:Standup\r\n${crlf(GUESTS)}`));
        expect(await failure(() => update(denied, splitRequest(etag)))).toEqual({ code: 'attendees_present', reason: 'may_send_invitations' });
        const invited = harness({ scopes: ['calendar:read', 'calendar:write', 'calendar:invite'] });
        const invitedEtag = invited.fake.seed(WORK, UTC_HREF, UTC_SERIES.replace('SUMMARY:Standup\r\n', `SUMMARY:Standup\r\n${crlf(GUESTS)}`));
        const result = await update(invited, splitRequest(invitedEtag));
        expect<unknown>([unfold(puts(invited.fake)[0]?.body ?? '').filter(line => /^(ATTENDEE|ORGANIZER)/u.test(line)), result.guests_may_be_emailed]).toEqual([GUESTS, true]);
    });
});

describe('update_event, edit_scope all: moving a series', () => {
    const SHIFT_HREF = `${WORK}SHIFT.ics`;
    const SHIFT_SERIES = crlf([
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
        'BEGIN:VEVENT', 'UID:SHIFT-1', 'DTSTAMP:20261101T120000Z', 'SEQUENCE:1', 'DTSTART:20270208T150000Z', 'DTEND:20270208T160000Z', 'RRULE:FREQ=WEEKLY;COUNT=6', 'EXDATE:20270308T150000Z', 'SUMMARY:Review', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:SHIFT-1', 'RECURRENCE-ID:20270215T150000Z', 'DTSTAMP:20261101T120000Z', 'DTSTART:20270215T150000Z', 'DTEND:20270215T160000Z', 'SUMMARY:Review (agenda)', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:SHIFT-1', 'RECURRENCE-ID:20270222T150000Z', 'DTSTAMP:20261101T120000Z', 'DTSTART:20270223T150000Z', 'DTEND:20270223T160000Z', 'SUMMARY:Review (moved)', 'END:VEVENT',
        'END:VCALENDAR',
    ]);

    test('shift (UTC): the exact body; RECURRENCE-IDs and EXDATE move by the delta, an unmoved override\'s times too, a moved one keeps its own (P3D-2)', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, SHIFT_HREF, SHIFT_SERIES);
        const result = await update(h, { calendar_id: WORK, resource_href: SHIFT_HREF, expected_version: etag, edit_scope: 'all', exceptions: 'shift', changes: { start: '2027-02-09T16:00:00Z', end: '2027-02-09T17:00:00Z' } });
        expect(puts(h.fake)[0]?.body).toBe(crlf([
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
            'BEGIN:VEVENT', 'UID:SHIFT-1', 'DTSTAMP:20261113T090000Z', 'SEQUENCE:2', 'DTSTART:20270209T160000Z', 'DTEND:20270209T170000Z', 'RRULE:FREQ=WEEKLY;COUNT=6', 'EXDATE:20270309T160000Z', 'SUMMARY:Review', 'LAST-MODIFIED:20261113T090000Z', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:SHIFT-1', 'RECURRENCE-ID:20270216T160000Z', 'DTSTAMP:20261113T090000Z', 'DTSTART:20270216T160000Z', 'DTEND:20270216T170000Z', 'SUMMARY:Review (agenda)', 'LAST-MODIFIED:20261113T090000Z', 'SEQUENCE:1', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:SHIFT-1', 'RECURRENCE-ID:20270223T160000Z', 'DTSTAMP:20261113T090000Z', 'DTSTART:20270223T150000Z', 'DTEND:20270223T160000Z', 'SUMMARY:Review (moved)', 'LAST-MODIFIED:20261113T090000Z', 'SEQUENCE:1', 'END:VEVENT',
            'END:VCALENDAR',
        ]));
        expect<unknown>([result.write_outcome, result.exceptions_shifted, result.overrides_changed, result.stored_differs_from_request]).toEqual(['applied', { changed_occurrences: 2, deleted_occurrences: 1 }, 2, []]);
        // The measured result tuples of P3D-2 (UTC series).
        expect((await instances(h.fake, SHIFT_HREF)).map(line => line.split('/').slice(0, 3).join('/'))).toEqual([
            '20270209T160000Z/20270209T170000Z/20270209T160000Z', '20270216T160000Z/20270216T170000Z/20270216T160000Z', '20270223T150000Z/20270223T160000Z/20270223T160000Z',
            '20270302T160000Z/20270302T170000Z/20270302T160000Z', '20270316T160000Z/20270316T170000Z/20270316T160000Z',
        ]);
        // A stale retry of a shift cannot be judged by re-planning: calendar_changed, never a second shift.
        expect(await failure(() => update(h, { calendar_id: WORK, resource_href: SHIFT_HREF, expected_version: etag, edit_scope: 'all', exceptions: 'shift', changes: { start: '2027-02-09T16:00:00Z', end: '2027-02-09T17:00:00Z' } }))).toEqual({ code: 'calendar_changed', reason: 'version_mismatch' });
    });

    test('drop: overrides and EXDATEs removed and listed; a retry is desired_state_present (P3D-3)', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, SHIFT_HREF, SHIFT_SERIES);
        const request = { calendar_id: WORK, resource_href: SHIFT_HREF, expected_version: etag, edit_scope: 'all', exceptions: 'drop', changes: { start: { local: '2027-02-08T11:00', zone: NY }, end: { local: '2027-02-08T12:00', zone: NY } } };
        const result = await update(h, request);
        const body = unfold(puts(h.fake)[0]?.body ?? '');
        expect<unknown>([body.filter(line => line === 'BEGIN:VEVENT').length, body.some(line => line.startsWith('EXDATE')), body.filter(line => /^DT(START|END)/u.test(line))]).toEqual([1, false, [`DTSTART;TZID=${NY}:20270208T110000`, `DTEND;TZID=${NY}:20270208T120000`]]);
        expect(result.exceptions_dropped).toEqual({
            changed_occurrences: 2, deleted_occurrences: 1,
            changed: [{ original_start: { utc: '2027-02-15T15:00:00Z' }, start: { utc: '2027-02-15T15:00:00Z' }, title: 'Review (agenda)' }, { original_start: { utc: '2027-02-22T15:00:00Z' }, start: { utc: '2027-02-23T15:00:00Z' }, title: 'Review (moved)' }],
            deleted: [{ utc: '2027-03-08T15:00:00Z' }],
        });
        expect((await instances(h.fake, SHIFT_HREF)).length).toBe(6);
        const again = await update(h, request);
        expect<unknown>([again.write_outcome, h.fake.count('putEvent')]).toEqual(['desired_state_present', 1]);
    });

    test('a zoned series without exceptions moves; shift of a zoned series is refused; a kept UNTIL that no longer fits is invalid_input; recurrence null makes it single', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, TZ_HREF, TZ_SERIES);
        const result = await update(h, { calendar_id: WORK, resource_href: TZ_HREF, expected_version: etag, edit_scope: 'all', changes: { start: { local: '2026-12-01T11:00', zone: NY }, end: { local: '2026-12-01T12:00', zone: NY } } });
        expect<unknown>([result.write_outcome, result.event?.start]).toMatchObject(['applied', { local: '2026-12-01T11:00:00', zone: NY }]);
        expect((await instances(h.fake, TZ_HREF, '20261201T000000Z', '20261208T000000Z')).map(line => line.slice(0, 15))).toEqual(['20261201T110000']);

        const until = harness();
        const untilEtag = until.fake.seed(WORK, UTC_HREF, UTC_SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=8', 'RRULE:FREQ=WEEKLY;UNTIL=20270301T000000Z'));
        expect(await failure(() => update(until, { calendar_id: WORK, resource_href: UTC_HREF, expected_version: untilEtag, edit_scope: 'all', changes: { start: { date: '2027-01-05' }, end: { date: '2027-01-06' } } }))).toEqual({ code: 'invalid_input', reason: 'rrule_until_form', field: 'recurrence' });

        const single = harness();
        const singleEtag = single.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const made = await update(single, { calendar_id: WORK, resource_href: UTC_HREF, expected_version: singleEtag, edit_scope: 'all', changes: { recurrence: null } });
        expect<unknown>([made.event?.view, made.event?.recurring, unfold(puts(single.fake)[0]?.body ?? '').some(line => line.startsWith('RRULE'))]).toEqual(['single', false, false]);
    });

    test('a move counts and lists EXDATE values, not lines', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, SHIFT_HREF, SHIFT_SERIES.replace('EXDATE:20270308T150000Z', 'EXDATE:20270308T150000Z,20270315T150000Z'));
        const base = { calendar_id: WORK, resource_href: SHIFT_HREF, expected_version: etag, edit_scope: 'all', changes: { start: '2027-02-08T17:00:00Z', end: '2027-02-08T18:00:00Z' } };
        expect(await failure(() => update(h, base))).toEqual({ code: 'edit_not_supported', reason: 'exceptions_choice_required', exceptions: { changed_occurrences: 2, deleted_occurrences: 2 } });
        const result = await update(h, { ...base, exceptions: 'drop' });
        expect<unknown>([result.exceptions_dropped?.deleted_occurrences, result.exceptions_dropped?.deleted]).toEqual([2, [{ utc: '2027-03-08T15:00:00Z' }, { utc: '2027-03-15T15:00:00Z' }]]);
    });

    test('drop lists at most 50 exceptions by value, with complete counts and truncated; the list survives the 96 KiB shaping', async () => {
        const h = harness();
        const overrides = Array.from({ length: 60 }, (_, index) => {
            const day = new Date(Date.UTC(2027, 1, 8 + 7 * (index + 1), 15)).toISOString().replaceAll(/[-:]/gu, '').replace('.000', '');
            return crlf(['BEGIN:VEVENT', 'UID:SHIFT-1', `RECURRENCE-ID:${day}`, `DTSTART:${day}`, `DTEND:${day.replace('T15', 'T16')}`, `SUMMARY:${'Override '.repeat(40)}${String(index)}`, 'END:VEVENT']);
        }).join('');
        const text = SHIFT_SERIES.replace(/BEGIN:VEVENT\r\nUID:SHIFT-1\r\nRECURRENCE-ID[\s\S]*END:VEVENT\r\n/u, '').replace('RRULE:FREQ=WEEKLY;COUNT=6', 'RRULE:FREQ=WEEKLY;COUNT=70').replace('END:VCALENDAR\r\n', `${overrides}END:VCALENDAR\r\n`);
        const etag = h.fake.seed(WORK, SHIFT_HREF, text);
        const result = await update(h, { calendar_id: WORK, resource_href: SHIFT_HREF, expected_version: etag, edit_scope: 'all', exceptions: 'drop', changes: { start: '2027-02-08T17:00:00Z', end: '2027-02-08T18:00:00Z' } });
        expect<unknown>([result.exceptions_dropped?.changed_occurrences, result.exceptions_dropped?.changed.length, result.exceptions_dropped?.truncated, result.exceptions_dropped?.changed[0]?.title?.length]).toEqual([60, 50, true, 256]);
        expect(writeEventResultSchema.safeParse(result).success).toBe(true);
    });

    test('a rule change iCloud stores with its parts reordered (measured) reads back as requested; a retry is desired_state_present', async () => {
        const rule = { recurrence: { rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=3' } };
        // Without exceptions: the rule alone.
        const plain = harness();
        const plainEtag = plain.fake.seed(WORK, UTC_HREF, UTC_SERIES);
        const plainRequest = { calendar_id: WORK, resource_href: UTC_HREF, expected_version: plainEtag, edit_scope: 'all', changes: rule };
        const ruled = await update(plain, plainRequest);
        expect(unfold(plain.fake.get(WORK, UTC_HREF)?.text ?? '')).toContain('RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=2');
        expect<unknown>([ruled.write_outcome, ruled.stored_differs_from_request]).toEqual(['applied', []]);
        expect<unknown>([(await update(plain, plainRequest)).write_outcome, plain.fake.count('putEvent')]).toEqual(['desired_state_present', 1]);
        // With exceptions dropped, and a time change.
        const h = harness();
        const etag = h.fake.seed(WORK, SHIFT_HREF, SHIFT_SERIES);
        const request = { calendar_id: WORK, resource_href: SHIFT_HREF, expected_version: etag, edit_scope: 'all', exceptions: 'drop', changes: { ...rule, start: '2027-02-08T17:00:00Z', end: '2027-02-08T18:00:00Z' } };
        const moved = await update(h, request);
        expect(unfold(puts(h.fake)[0]?.body ?? '')).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3');
        expect(unfold(h.fake.get(WORK, SHIFT_HREF)?.text ?? '')).toContain('RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=2');
        expect<unknown>([moved.write_outcome, moved.stored_differs_from_request]).toEqual(['applied', []]);
        expect<unknown>([(await update(h, request)).write_outcome, h.fake.count('putEvent')]).toEqual(['desired_state_present', 1]);
    });

    test('shift only for a rule that provably moves with its start: FREQ up to WEEKLY with INTERVAL, COUNT, WKST; anything else refused, nothing sent', async () => {
        // A monthly series on the 30th: an override of Apr 30 would land on May 1, which the moved rule never produces.
        const monthly = crlf([
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
            'BEGIN:VEVENT', 'UID:MONTHLY-1', 'DTSTAMP:20261101T120000Z', 'SEQUENCE:1', 'DTSTART:20270130T150000Z', 'DTEND:20270130T160000Z', 'RRULE:FREQ=MONTHLY;COUNT=8', 'SUMMARY:Monthly', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:MONTHLY-1', 'RECURRENCE-ID:20270430T150000Z', 'DTSTAMP:20261101T120000Z', 'DTSTART:20270430T150000Z', 'DTEND:20270430T160000Z', 'SUMMARY:Monthly (agenda)', 'END:VEVENT',
            'END:VCALENDAR',
        ]);
        const refused = { code: 'edit_not_supported', reason: 'exceptions_shift_rule_not_supported' };
        const cases: [string, string, { start: string; end: string }][] = [
            ['monthly', monthly, { start: '2027-01-31T15:00:00Z', end: '2027-01-31T16:00:00Z' }],
            ['weekly BYDAY', SHIFT_SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=6', 'RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=MO'), { start: '2027-02-09T16:00:00Z', end: '2027-02-09T17:00:00Z' }],
            ['daily UNTIL', SHIFT_SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=6', 'RRULE:FREQ=DAILY;UNTIL=20270401T000000Z'), { start: '2027-02-09T16:00:00Z', end: '2027-02-09T17:00:00Z' }],
        ];
        for (const [name, text, changes] of cases) {
            const h = harness();
            const etag = h.fake.seed(WORK, SHIFT_HREF, text);
            expect<unknown>([name, await failure(() => update(h, { calendar_id: WORK, resource_href: SHIFT_HREF, expected_version: etag, edit_scope: 'all', exceptions: 'shift', changes }))]).toEqual([name, refused]);
            expect<unknown>([name, h.fake.count('putEvent')]).toEqual([name, 0]);
        }
        // Plain DAILY and WEEKLY with INTERVAL and COUNT still shift.
        for (const rule of ['FREQ=DAILY', 'FREQ=WEEKLY;INTERVAL=1;COUNT=6;WKST=MO']) {
            const h = harness();
            const etag = h.fake.seed(WORK, SHIFT_HREF, SHIFT_SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=6', `RRULE:${rule}`));
            const result = await update(h, { calendar_id: WORK, resource_href: SHIFT_HREF, expected_version: etag, edit_scope: 'all', exceptions: 'shift', changes: { start: '2027-02-09T16:00:00Z', end: '2027-02-09T17:00:00Z' } });
            expect<unknown>([rule, result.write_outcome, result.exceptions_shifted, unfold(puts(h.fake)[0]?.body ?? '').filter(line => line.startsWith('RECURRENCE-ID'))]).toEqual([rule, 'applied', { changed_occurrences: 2, deleted_occurrences: 1 }, ['RECURRENCE-ID:20270216T160000Z', 'RECURRENCE-ID:20270223T160000Z']]);
        }
    });

    test('a rule change: the new RRULE, exceptions must be dropped', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, SHIFT_HREF, SHIFT_SERIES);
        const result = await update(h, { calendar_id: WORK, resource_href: SHIFT_HREF, expected_version: etag, edit_scope: 'all', exceptions: 'drop', changes: { recurrence: { rrule: 'FREQ=DAILY;COUNT=3' } } });
        expect<unknown>([unfold(puts(h.fake)[0]?.body ?? '').filter(line => line.startsWith('RRULE')), result.exceptions_dropped?.changed_occurrences, (await instances(h.fake, SHIFT_HREF)).length]).toEqual([['RRULE:FREQ=DAILY;COUNT=3'], 2, 3]);
    });
});
