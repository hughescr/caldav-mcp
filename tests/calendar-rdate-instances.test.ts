import { describe, expect, test } from 'bun:test';
import { createReadBudget, createWriteBudget } from '../src/calendar/budget';
import { parseExpandedResource } from '../src/calendar/ical';
import { IcalError } from '../src/calendar/model';
import { normalizeFullEvent } from '../src/calendar/normalize';
import { getEvent, listEvents, type ReadDeps } from '../src/calendar/read';
import { deleteEvent, updateEvent, WriteError, type WriteDeps } from '../src/calendar/write';
import { deleteEventInputSchema, updateEventInputSchema, type DeleteEventArgs, type UpdateEventArgs } from '../src/calendar/write-schemas';
import { FAKE_DISCOVERY, FakeICloud } from './helpers/fake-caldav-write';

// A series whose master has RRULE and RDATE. iCloud's expanded answer (measured read-only, 2026-11) leaves the master's
// RDATE line on EVERY expanded instance, each of which also has a RECURRENCE-ID; no instance keeps the RRULE. All data
// here is synthetic: the shape is the measured one, the UID, summary and dates are not.

const LA = 'America/Los_Angeles';
const lf = (lines: readonly string[]): string => `${lines.join('\n')}\n`;
const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const ALARM = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM'];

/** One expanded instance in the measured shape: RDATE (floating) on every instance, X-RECURRENCE-MASTER only on the first. */
const measuredInstance = (start: string, rid: string, first: boolean): string[] => [
    'BEGIN:VEVENT', 'UID:SYNTH-RDATE-0001', 'SEQUENCE:0', 'RDATE:20220503T180001', ...(first ? ['X-RECURRENCE-MASTER:True'] : []),
    `DTSTART;TZID=${LA}:${start}`, `DTEND;TZID=${LA}:${start}`, `RECURRENCE-ID:${rid}`, 'SUMMARY:Synthetic club', ...ALARM, 'END:VEVENT',
];
const MEASURED_SLOTS: [string, string][] = [
    ['20220419T180000', '20220420T010000Z'], ['20220426T180000', '20220427T010000Z'], ['20220503T110001', '20220503T180001Z'], ['20220503T180000', '20220504T010000Z'],
    ['20220510T180000', '20220511T010000Z'], ['20220517T180000', '20220518T010000Z'], ['20220524T180000', '20220525T010000Z'], ['20220531T180000', '20220601T010000Z'],
];
const MEASURED = lf([
    'BEGIN:VCALENDAR', 'X-EXPANDED:TRUE', 'X-MASTER-DTSTART:20220419T180000', 'X-MASTER-RRULE:FREQ=WEEKLY\\;UNTIL=20220606T235959Z',
    ...MEASURED_SLOTS.flatMap(([start, rid], index) => measuredInstance(start, rid, index === 0)), 'END:VCALENDAR',
]);

const instance = (extra: readonly string[], rid: string | null = '20270111T100000Z'): string => lf([
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:synthetic', 'DTSTART:20270111T100000Z', 'DTEND:20270111T110000Z', ...(rid === null ? [] : [`RECURRENCE-ID:${rid}`]), ...extra, 'SUMMARY:Good', 'END:VEVENT', 'END:VCALENDAR',
]);

describe('parseExpandedResource: leftover RDATE/EXDATE on an expanded instance', () => {
    test('the measured iCloud shape is read: every instance, the RDATE-generated one included, each with its own token', () => {
        const { components, vtimezoneCount } = parseExpandedResource(MEASURED, {});
        expect(vtimezoneCount).toBe(0);
        expect<unknown>(components.map(component => component.recurrenceId?.token)).toEqual(MEASURED_SLOTS.map(([, rid]) => `occ1_${rid}`));
        const generated = components.find(component => component.recurrenceId?.token === 'occ1_20220503T180001Z');
        expect<unknown>(generated?.start).toEqual({ kind: 'zoned', local: '2022-05-03T11:00:01', tzid: LA });
        expect(components.every(component => component.alarmCount === 1)).toBe(true);
    });

    test('an instance with a leftover RDATE shapes exactly as the same instance without it (pass-through, no recurrence leak)', () => {
        const context = { calendar: 0, resourceHref: '/10000000001/calendars/work/e.ics', etag: '"v1"', recurring: true, calendarId: '/10000000001/calendars/work/', view: 'occurrence' as const };
        const withRdate = parseExpandedResource(instance(['RDATE:20270118T100000']), {}).components[0];
        const without = parseExpandedResource(instance([]), {}).components[0];
        if (withRdate === undefined || without === undefined) { throw new Error('missing instance'); }
        expect<unknown>(normalizeFullEvent(withRdate, context)).toEqual(normalizeFullEvent(without, context));
        // The structural flag still says what survived expansion; nothing on the read path consumes it for an instance.
        expect([withRdate.retainsRecurrenceRules, without.retainsRecurrenceRules]).toEqual([true, false]);
    });

    test('EXDATE, and RDATE with EXDATE, on an instance with a RECURRENCE-ID are accepted', () => {
        expect(parseExpandedResource(instance(['EXDATE:20270118T100000Z']), {}).components).toHaveLength(1);
        expect(parseExpandedResource(instance(['RDATE:20270125T100000Z', 'EXDATE:20270118T100000Z']), {}).components).toHaveLength(1);
    });

    const refused: [string, string][] = [
        ['RRULE on an instance', instance(['RRULE:FREQ=WEEKLY;COUNT=3'])],
        ['RRULE without a RECURRENCE-ID', instance(['RRULE:FREQ=WEEKLY;COUNT=3'], null)],
        ['RDATE without a RECURRENCE-ID (an unexpanded master)', instance(['RDATE:20270118T100000Z'], null)],
        ['EXDATE without a RECURRENCE-ID (an unexpanded master)', instance(['EXDATE:20270118T100000Z'], null)],
    ];
    for (const [label, text] of refused) {
        test(`still refuses ${label} as unsupported_recurrence_data`, () => {
            expect<unknown>(() => parseExpandedResource(text, {})).toThrow(new IcalError('unsupported_recurrence_data'));
        });
    }

    test('one unexpanded master among instances still makes the resource unreadable', () => {
        const text = MEASURED.replace('END:VCALENDAR\n', lf(['BEGIN:VEVENT', 'UID:SYNTH-RDATE-0001', 'DTSTART:20220419T180000Z', 'DTEND:20220419T180000Z', 'RDATE:20220503T180001', 'END:VEVENT', 'END:VCALENDAR']));
        expect<unknown>(() => parseExpandedResource(text, {})).toThrow(new IcalError('unsupported_recurrence_data'));
    });
});

// ---- End to end through the stateful fake (which models the leftover RDATE and the RDATE-generated instance) ----

const ACCOUNT = 'A'.repeat(43);
const WORK = '/10000000001/calendars/work/';
const AUTH = { appleId: 'rdate@example.invalid', appPassword: 'rdate-test-canary-pass' };
const HREF = `${WORK}SYNTH-RDATE.ics`;
const SERIES = crlf([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 15.4//EN',
    'BEGIN:VEVENT', 'UID:SYNTH-RDATE', 'DTSTAMP:20261101T120000Z', 'CREATED:20261101T120000Z', 'SEQUENCE:0',
    `DTSTART;TZID=${LA}:20270406T180000`, `DTEND;TZID=${LA}:20270406T190000`, 'RRULE:FREQ=WEEKLY;UNTIL=20270524T235959Z', 'RDATE:20270420T180001', 'SUMMARY:Synthetic club',
    ...ALARM, 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:SYNTH-RDATE', 'DTSTAMP:20261101T120000Z', 'SEQUENCE:0',
    `RECURRENCE-ID;TZID=${LA}:20270427T180000`, `DTSTART;TZID=${LA}:20270427T190000`, `DTEND;TZID=${LA}:20270427T200000`, 'SUMMARY:Synthetic club (late)',
    'END:VEVENT', 'END:VCALENDAR',
]);
const OVERRIDE_TOKEN = `occ2_20270427T180000_${Buffer.from(LA, 'utf8').toString('base64url')}`;

function setup(): { fake: FakeICloud; etag: string; read: () => ReadDeps; write: () => WriteDeps } {
    const fake = new FakeICloud([WORK]);
    const etag = fake.seed(WORK, HREF, SERIES);
    return {
        fake, etag,
        read: () => ({ backend: fake, auth: AUTH, discovery: FAKE_DISCOVERY, accountId: ACCOUNT, budget: createReadBudget({ now: () => 0, yieldFn: async () => {} }) }),
        write: () => ({
            backend: fake, auth: AUTH, discovery: FAKE_DISCOVERY, accountId: ACCOUNT, budget: createWriteBudget({ now: () => 0 }),
            now: () => Date.UTC(2026, 10, 13, 9, 0, 0), scopes: ['calendar:read', 'calendar:write', 'calendar:delete'],
        }),
    };
}

async function failure(action: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try { await action(); } catch (error) {
        if (error instanceof WriteError) { return { code: error.code, ...error.extra }; }
        throw error;
    }
    throw new Error('expected a failure');
}

const range = { start: '2027-04-01T00:00:00Z', end: '2027-06-01T00:00:00Z' };

describe('a series with RDATE through the read path', () => {
    test('the fake leaves the RDATE line on every expanded instance and adds the RDATE-generated one (floating read as UTC)', async () => {
        const { fake } = setup();
        const [resource] = await fake.queryEvents(AUTH, FAKE_DISCOVERY, { calendarId: WORK, range: { startUtc: '20270401T000000Z', endUtc: '20270601T000000Z' } });
        const blocks = (resource?.calendarData ?? '').split('BEGIN:VEVENT').slice(1);
        expect(blocks).toHaveLength(8);
        expect(blocks.every(block => block.includes('\nRRULE') === false)).toBe(true);
        expect(blocks.filter(block => block.includes('\nRDATE:20270420T180001\n'))).toHaveLength(7);
        expect(blocks.some(block => block.includes(`DTSTART;TZID=${LA}:20270420T110001\n`) && block.includes('RECURRENCE-ID:20270420T180001Z\n'))).toBe(true);
    });

    test('list_events lists every instance of the series; nothing unreadable; the calendar is ok', async () => {
        const { read } = setup();
        const result = await listEvents(read(), { range });
        expect(result.calendars.map(calendar => calendar.status)).toEqual(['ok']);
        expect<unknown>(result.unreadable).toEqual([]);
        expect(result.unreadableCount).toBe(0);
        expect(result.events.map(event => [event.recurrence_id, event.recurring, event.title])).toEqual([
            ['occ1_20270407T010000Z', true, 'Synthetic club'], ['occ1_20270414T010000Z', true, 'Synthetic club'], ['occ1_20270420T180001Z', true, 'Synthetic club'],
            ['occ1_20270421T010000Z', true, 'Synthetic club'], [OVERRIDE_TOKEN, true, 'Synthetic club (late)'], ['occ1_20270505T010000Z', true, 'Synthetic club'],
            ['occ1_20270512T010000Z', true, 'Synthetic club'], ['occ1_20270519T010000Z', true, 'Synthetic club'],
        ]);
    });

    test('get_event with an occurrence token answers that occurrence, the RDATE-generated one included', async () => {
        const { read, etag } = setup();
        for (const [token, local] of [['occ1_20270414T010000Z', '2027-04-13T18:00:00'], ['occ1_20270420T180001Z', '2027-04-20T11:00:01'], [OVERRIDE_TOKEN, '2027-04-27T19:00:00']] as const) {
            const { event, calendars } = await getEvent(read(), { calendar_id: WORK, resource_href: HREF, recurrence_id: token });
            expect(calendars.map(calendar => calendar.status)).toEqual(['ok']);
            expect<unknown>(event).toMatchObject({ view: 'occurrence', recurring: true, recurrence_id: token, expected_version: etag, start: { local, zone: LA } });
        }
    });

    test('get_event without a token answers the master', async () => {
        const { read } = setup();
        const { event } = await getEvent(read(), { calendar_id: WORK, resource_href: HREF });
        expect<unknown>(event).toMatchObject({ view: 'series_master', recurring: true, recurrence_id: null });
    });
});

describe('a series with RDATE through the write path', () => {
    const update = (deps: WriteDeps, input: Record<string, unknown>) => updateEvent(deps, updateEventInputSchema.parse(input) as UpdateEventArgs);
    const remove = (deps: WriteDeps, input: Record<string, unknown>) => deleteEvent(deps, deleteEventInputSchema.parse(input) as DeleteEventArgs);
    const mutations = (fake: FakeICloud): number => fake.count('putEvent') + fake.count('deleteEvent');

    test('update and delete with edit_scope this are refused with rdate_present before any expansion, PUT or DELETE', async () => {
        for (const token of ['occ1_20270414T010000Z', 'occ1_20270420T180001Z', OVERRIDE_TOKEN]) {
            for (const stale of [false, true]) {
                const { fake, etag, write } = setup();
                const expected_version = stale ? '"e-stale00"' : etag;
                const request = { calendar_id: WORK, resource_href: HREF, expected_version, edit_scope: 'this', recurrence_id: token };
                expect(await failure(() => update(write(), { ...request, changes: { title: 'Changed' } }))).toEqual({ code: 'edit_not_supported', reason: 'rdate_present' });
                expect(await failure(() => remove(write(), request))).toEqual({ code: 'edit_not_supported', reason: 'rdate_present' });
                expect([mutations(fake), fake.count('queryEvents')]).toEqual([0, 0]);
                expect(fake.get(WORK, HREF)?.text).toBe(SERIES);
            }
        }
    });

    test('this_and_future (update and delete) and a series move are refused with rdate_present; nothing is written', async () => {
        const { fake, etag, write } = setup();
        const base = { calendar_id: WORK, resource_href: HREF, expected_version: etag };
        const following = { ...base, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270505T010000Z' };
        expect(await failure(() => update(write(), { ...following, operation_id: 'op-rdate-0001', changes: { title: 'Changed' } }))).toEqual({ code: 'edit_not_supported', reason: 'rdate_present' });
        expect(await failure(() => remove(write(), following))).toEqual({ code: 'edit_not_supported', reason: 'rdate_present' });
        expect(await failure(() => update(write(), {
            ...base, edit_scope: 'all', exceptions: 'drop', changes: { start: { local: '2027-04-06T19:00', zone: LA }, end: { local: '2027-04-06T20:00', zone: LA } },
        }))).toEqual({ code: 'edit_not_supported', reason: 'rdate_present' });
        expect(mutations(fake)).toBe(0);
        expect(fake.get(WORK, HREF)?.text).toBe(SERIES);
    });

    test('edit_scope all without a time or rule change is unchanged: every VEVENT is edited in place and the RDATE line is kept', async () => {
        const { fake, etag, write } = setup();
        const result = await update(write(), { calendar_id: WORK, resource_href: HREF, expected_version: etag, edit_scope: 'all', changes: { location: 'Hall 2' } });
        expect(result.write_outcome).toBe('applied');
        const stored = fake.get(WORK, HREF)?.text ?? '';
        expect(stored).toContain('\r\nRDATE:20270420T180001\r\n');
        expect(stored.match(/\r\nLOCATION:Hall 2\r\n/gu)).toHaveLength(2);
        expect(fake.count('putEvent')).toBe(1);
    });
});
