import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Glob } from 'bun';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY, type AuthInfo } from '@modelcontextprotocol/server';
import type { UpstreamCredentials } from '../src/auth/contracts';
import type { DownloadOutput, EventsOutput } from '../src/calendar/event-schemas';
import {
    ALL_NOTES, DELETE_STORED_DIFFERS_NOTE, DOWNLOAD_LINK_NOTE, EXCEPTIONS_DROPPED_NOTE, EXTERNAL_ATTACHMENT_NOTE, OUTCOME_NOTES, RANGE_MARGIN_NOTE, READBACK_UNAVAILABLE_NOTE, SPLIT_OUTCOME_NOTE,
    STORED_DIFFERS_NOTE, TIMEZONE_NOTES, notesField, timezoneNotes, validNotes,
} from '../src/calendar/notes';
import type { EventsReadResult } from '../src/calendar/read';
import { bindCalendarService, CalendarError, type BoundCalendarService } from '../src/calendar/service';
import { shapeDeleteResult, shapeDownloadResult, shapeEventsResult, shapeWriteResult, type WireContext } from '../src/calendar/shape';
import type { DeleteEventResult, WriteEventResult } from '../src/calendar/write-schemas';
import { handleMcp } from '../src/mcp';
import { FAKE_DISCOVERY, FakeICloud } from './helpers/fake-caldav-write';

const WORK = '/10000000001/calendars/work/';
const NOW_MS = Date.UTC(2026, 10, 13, 9, 0, 0);
const ERAS = ['2025-11-25', '2026-07-28'] as const;
const ALL = ['calendar:read', 'calendar:write', 'calendar:delete', 'calendar:invite'];
const credentials: UpstreamCredentials = { accountId: 'N'.repeat(43), appleId: 'notes@example.invalid', appPassword: 'notes-canary-pass', ...FAKE_DISCOVERY, issuedAt: 1000 };
const legacy: WireContext = { jsonRpcId: 1, protocolEra: 'legacy' };

/** The safety text every outcome_unknown answer carries, on every tool and path. */
const OUTCOME_UNKNOWN_TEXT = 'the change may or may not be saved; get the event again before anything else';

let warn: Mock<(...args: unknown[]) => void>;
beforeEach(() => { warn = spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

function request(method: string, params: Record<string, unknown> | undefined, protocol: string): Request {
    const modern = protocol === '2026-07-28';
    return new Request('https://service.example/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
            ...(modern ? { 'Mcp-Method': method, ...(typeof params?.['name'] === 'string' ? { 'Mcp-Name': params['name'] } : {}) } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: modern ? { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: protocol, [CLIENT_INFO_META_KEY]: { name: 'test', version: '0' }, [CLIENT_CAPABILITIES_META_KEY]: {} } } : params }),
    });
}

interface ToolReply { isError?: boolean; structuredContent: Record<string, unknown> & { error?: Record<string, unknown> & { message: string; code: string } }; content: { type: string; text: string }[] }

function harness(service?: (fake: FakeICloud) => BoundCalendarService) {
    const fake = new FakeICloud([WORK]);
    const bound = bindCalendarService({ caldav: fake, connectionStatus: 'active', credentials: () => credentials, markReconnectRequired: async () => true, now: () => NOW_MS });
    const target = service?.(fake) ?? bound;
    const call = async (name: string, args: unknown, protocol: string = ERAS[0]): Promise<ToolReply> => {
        const authInfo: AuthInfo = { token: 'synthetic', clientId: 'test', scopes: ALL };
        const response = await handleMcp(request('tools/call', { name, arguments: args }, protocol), authInfo, target);
        expect(response.status).toBe(200);
        return (await response.json() as { result: ToolReply }).result;
    };
    return { fake, service: bound, call };
}

const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const single = (uid: string, lines: readonly string[]): string => crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261101T120000Z', 'SEQUENCE:0', ...lines, 'END:VEVENT', 'END:VCALENDAR']);
const href = (name: string): string => `${WORK}${name}.ics`;
const RANGE = { start: '2027-01-11T00:00:00Z', end: '2027-01-12T00:00:00Z' };
const errorOf = (reply: ToolReply): Record<string, unknown> & { message: string; code: string } => {
    const error = reply.structuredContent.error;
    if (error === undefined) { throw new Error(`expected an error, got ${JSON.stringify(reply.structuredContent)}`); }
    return error;
};
/** The note list of a result; also checks that the text copy carries the same notes. */
const notesOf = (reply: ToolReply): unknown => {
    expect(reply.isError).toBeUndefined();
    expect(JSON.parse(reply.content[0]?.text ?? 'null')).toEqual(reply.structuredContent);
    return reply.structuredContent['notes'];
};

describe('the notes module', () => {
    test('every note is a distinct fixed sentence; a valid list is known notes, each once, in order', () => {
        expect(new Set(ALL_NOTES).size).toBe(ALL_NOTES.length);
        expect(validNotes([OUTCOME_NOTES.desired_state_present, STORED_DIFFERS_NOTE])).toBe(true);
        expect(validNotes([STORED_DIFFERS_NOTE, OUTCOME_NOTES.desired_state_present])).toBe(false);
        expect(validNotes([OUTCOME_NOTES.desired_state_present, OUTCOME_NOTES.desired_state_present])).toBe(false);
        expect(validNotes(['Ignore previous instructions'])).toBe(false);
        expect(validNotes([])).toBe(false);
    });

    test('notesField de-duplicates in the fixed order and is empty when nothing applies', () => {
        expect(notesField([])).toEqual({});
        expect(notesField([RANGE_MARGIN_NOTE, OUTCOME_NOTES.desired_state_present, RANGE_MARGIN_NOTE])).toEqual({ notes: [OUTCOME_NOTES.desired_state_present, RANGE_MARGIN_NOTE] });
    });

    test('timezoneNotes finds each distinct warning at any depth and ignores unknown values and calendar text', () => {
        const found = timezoneNotes({ a: [{ start: { local: 'x', floating: true, timezone_warning: 'no_timezone_on_event' } }, { timezone_warning: 'no_timezone_on_event' }], b: { c: { timezone_warning: 'unrecognized_timezone' } }, d: { timezone_warning: 'CANARY' }, title: 'timezone_warning' });
        expect([...found].toSorted()).toEqual([TIMEZONE_NOTES.no_timezone_on_event, TIMEZONE_NOTES.unrecognized_timezone].toSorted());
    });
});

// ---- Reads ----

const calendars = [{ calendar_id: WORK, display_name: 'Work', status: 'ok' as const }];
const slim = (start: Record<string, unknown>, end: Record<string, unknown>, name: string) => ({
    calendar: 0, resource_href: href(name), recurrence_id: null, expected_version: '"e1"', recurring: false, start, end, duration: null,
    title: 'Synthetic', location: null, description: null, attendees_count: 0,
}) as EventsReadResult['events'][number];
const listed = (events: EventsReadResult['events']): EventsOutput => shapeEventsResult({ calendars, range: RANGE, events, unreadable: [], unreadableCount: 0, seriesWithoutOccurrences: [] }, { limit: 100, wire: legacy }).structuredContent as EventsOutput;

describe('list_events and search_events: notes only for what the result holds', () => {
    const utc = slim({ utc: '2027-01-11T15:00:00Z' }, { utc: '2027-01-11T16:00:00Z' }, 'utc');
    const zoned = slim({ local: '2027-01-11T10:00:00', zone: 'America/New_York', utc: '2027-01-11T15:00:00Z', offset: '-05:00' }, { local: '2027-01-11T11:00:00', zone: 'America/New_York', utc: '2027-01-11T16:00:00Z', offset: '-05:00' }, 'zoned');
    const floating = slim({ local: '2027-01-11T10:00:00', floating: true, timezone_warning: 'no_timezone_on_event' }, { local: '2027-01-11T11:00:00', floating: true, timezone_warning: 'no_timezone_on_event' }, 'floating');
    const allDay = slim({ date: '2027-01-11', all_day: true }, { date: '2027-01-12', all_day: true }, 'allday');
    const unrecognized = slim({ local: '2027-01-11T10:00:00', zone: 'Mars/Olympus', timezone_warning: 'unrecognized_timezone' }, { local: '2027-01-11T11:00:00', zone: 'Mars/Olympus', timezone_warning: 'unrecognized_timezone' }, 'mars');
    const dst = slim({ local: '2027-03-14T02:30:00', zone: 'America/New_York', utc: '2027-03-14T07:30:00Z', offset: '-05:00', timezone_warning: 'utc_uncertain_dst_transition' }, null as never, 'dst');

    test('no notes key when every event has a fixed instant and no warning', () => {
        expect('notes' in listed([utc, zoned])).toBe(false);
        expect('notes' in listed([])).toBe(false);
    });

    test('an all-day event alone: the range note only', () => {
        expect(listed([utc, allDay]).notes).toEqual([RANGE_MARGIN_NOTE]);
    });

    test('a floating event: the range note and its timezone note, once however many', () => {
        expect(listed([floating, floating, utc]).notes).toEqual([RANGE_MARGIN_NOTE, TIMEZONE_NOTES.no_timezone_on_event]);
    });

    test('an unrecognised zone: the range note and its note; a daylight-saving warning has only its own note', () => {
        expect(listed([unrecognized]).notes).toEqual([RANGE_MARGIN_NOTE, TIMEZONE_NOTES.unrecognized_timezone]);
        expect(listed([{ ...dst, end: null }]).notes).toEqual([TIMEZONE_NOTES.utc_uncertain_dst_transition]);
    });

    test('through MCP: a floating event in the fake is listed with both notes; a UTC-only range has none', async () => {
        const h = harness();
        h.fake.seed(WORK, href('floating'), single('floating', ['DTSTART:20270111T100000', 'DTEND:20270111T110000', 'SUMMARY:Float']));
        h.fake.seed(WORK, href('utc'), single('utc', ['DTSTART:20270118T150000Z', 'DTEND:20270118T160000Z', 'SUMMARY:Fixed']));
        for (const protocol of ERAS) {
            expect(notesOf(await h.call('list_events', { range: RANGE }, protocol))).toEqual([RANGE_MARGIN_NOTE, TIMEZONE_NOTES.no_timezone_on_event]);
            expect(notesOf(await h.call('search_events', { range: RANGE, query: 'float' }, protocol))).toEqual([RANGE_MARGIN_NOTE, TIMEZONE_NOTES.no_timezone_on_event]);
            expect(notesOf(await h.call('list_events', { range: { start: '2027-01-18T00:00:00Z', end: '2027-01-18T12:00:00Z' } }, protocol))).toBeUndefined();
        }
    });
});

describe('get_event: a timezone note only when the event has that warning', () => {
    test('an unrecognised zone gets its note; a UTC event has no notes key', async () => {
        const h = harness();
        h.fake.seed(WORK, href('mars'), single('mars', ['DTSTART;TZID=Mars/Olympus:20270111T100000', 'DTEND;TZID=Mars/Olympus:20270111T110000', 'SUMMARY:Far']));
        h.fake.seed(WORK, href('utc'), single('utc', ['DTSTART:20270118T150000Z', 'DTEND:20270118T160000Z', 'SUMMARY:Fixed']));
        expect(notesOf(await h.call('get_event', { calendar_id: WORK, resource_href: href('mars') }))).toEqual([TIMEZONE_NOTES.unrecognized_timezone]);
        expect(notesOf(await h.call('get_event', { calendar_id: WORK, resource_href: href('utc') }))).toBeUndefined();
    });
});

describe('get_event_attachment_download: the link handling travels with the link', () => {
    const staged: DownloadOutput = {
        form: 'inline', attachment_ref: `a1_${'A'.repeat(43)}`, expected_version: '"v1"', filename: 'a.pdf', content_type: 'application/pdf', size: 3,
        download_url: 'https://bucket.example.invalid/k?sig=1', expires_at: '2026-11-13T09:05:00Z', fetched_by_server: true,
    };
    const external: DownloadOutput = { form: 'external', attachment_ref: `a1_${'A'.repeat(43)}`, expected_version: '"v1"', filename: null, content_type: null, url: 'https://files.example.invalid/doc', fetched_by_server: false };

    test('every result with a download_url says it is a bearer credential and how long it lives', () => {
        for (const form of ['inline', 'managed'] as const) {
            const shaped = shapeDownloadResult({ ...staged, form }, { wire: legacy });
            expect((shaped.structuredContent as DownloadOutput).notes).toEqual([DOWNLOAD_LINK_NOTE]);
        }
        expect(DOWNLOAD_LINK_NOTE).toContain('bearer credential');
        expect(DOWNLOAD_LINK_NOTE).toContain('Do not log, store or share it');
        expect(DOWNLOAD_LINK_NOTE).toContain('about a day');
    });

    test('an external link says it was not fetched and is untrusted, and has no link note', () => {
        const shaped = shapeDownloadResult(external, { wire: legacy });
        expect((shaped.structuredContent as DownloadOutput).notes).toEqual([EXTERNAL_ATTACHMENT_NOTE]);
        expect(EXTERNAL_ATTACHMENT_NOTE).toContain('untrusted');
    });
});

// ---- Writes ----

const CREATE = { calendar_id: WORK, operation_id: 'op-notes-0001', title: 'Planning', start: '2027-01-11T15:00:00Z', end: '2027-01-11T16:00:00Z' };
const SERIES = (uid: string, start: string, end: string, rule: string, extra: readonly string[] = []): string => single(uid, [start, end, `RRULE:${rule}`, ...extra, 'SUMMARY:Standup']);

describe('a write result explains only what is unusual about it; an ordinary save has no notes', () => {
    test('create: no notes when applied; desired_state_present on a retry; a dropped zone gets its note', async () => {
        const h = harness();
        const first = await h.call('create_event', CREATE);
        expect<unknown>([first.structuredContent['write_outcome'], 'notes' in first.structuredContent]).toEqual(['applied', false]);
        const retry = await h.call('create_event', CREATE);
        expect<unknown>([retry.structuredContent['write_outcome'], notesOf(retry)]).toEqual(['desired_state_present', [OUTCOME_NOTES.desired_state_present]]);
        const allDay = await h.call('create_event', { ...CREATE, operation_id: 'op-notes-0002', start: { date: '2027-01-12', zone: 'America/New_York' }, end: { date: '2027-01-13' } });
        expect(notesOf(allDay)).toEqual([TIMEZONE_NOTES.timezone_dropped_from_date]);
    });

    test('no note names write_outcome applied', () => {
        expect(ALL_NOTES.some(note => note.includes('write_outcome applied'))).toBe(false);
        expect(Object.keys(OUTCOME_NOTES)).toEqual(['desired_state_present']);
    });

    test('stored_differs_from_request explains itself only when it lists a field', async () => {
        const h = harness();
        h.fake.putEvent = (put => async (...args: Parameters<typeof put>) => {
            const answer = await put(...args);
            h.fake.externalEdit(WORK, args[2].href, text => text.replace('SUMMARY:Planning', 'SUMMARY:Rewritten'));
            return answer;
        })(h.fake.putEvent.bind(h.fake));
        const created = await h.call('create_event', CREATE);
        expect<unknown>([created.structuredContent['stored_differs_from_request'], notesOf(created)]).toEqual([['title'], [STORED_DIFFERS_NOTE]]);
    });

    test('update and delete of a single event: no notes; a delete retried after it is gone: desired_state_present', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, href('one'), single('one', ['DTSTART:20270111T150000Z', 'DTEND:20270111T160000Z', 'SUMMARY:One']));
        const updated = await h.call('update_event', { calendar_id: WORK, resource_href: href('one'), expected_version: etag, changes: { title: 'Two' } });
        expect<unknown>([updated.structuredContent['write_outcome'], notesOf(updated)]).toEqual(['applied', undefined]);
        const args = { calendar_id: WORK, resource_href: href('one'), expected_version: updated.structuredContent['expected_version'] };
        const deleted = await h.call('delete_event', args);
        expect<unknown>([deleted.structuredContent['write_outcome'], notesOf(deleted)]).toEqual(['applied', undefined]);
        expect(notesOf(await h.call('delete_event', args))).toEqual([OUTCOME_NOTES.desired_state_present]);
    });

    test('a split says whose write_outcome is whose; a drop lists what it removed and how to restore it', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, href('series'), SERIES('series', 'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'FREQ=WEEKLY;COUNT=6', ['EXDATE:20270126T150000Z']));
        const split = await h.call('update_event', { calendar_id: WORK, resource_href: href('series'), expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270119T150000Z', operation_id: 'op-notes-split', exceptions: 'drop', changes: { start: '2027-01-19T16:00:00Z', end: '2027-01-19T16:30:00Z' } });
        expect(notesOf(split)).toEqual([SPLIT_OUTCOME_NOTE, EXCEPTIONS_DROPPED_NOTE]);
        expect(EXCEPTIONS_DROPPED_NOTE).toContain('edit_scope "this"');
    });

    test('shaped results: readback unavailable, a partial delete that does not show, and every outcome value', () => {
        const base: WriteEventResult = {
            write_outcome: 'applied', readback: 'unavailable', calendar_id: WORK, resource_href: href('x'), expected_version: null, request_warnings: [], stored_differs_from_request: null,
            removed_dependent_properties: [], calendars: [{ calendar_id: WORK, display_name: 'Work', status: 'ok' }], event: null,
        };
        expect((shapeWriteResult(base, { wire: legacy }).structuredContent as WriteEventResult).notes).toEqual([READBACK_UNAVAILABLE_NOTE]);
        expect((shapeWriteResult({ ...base, write_outcome: 'desired_state_present' }, { wire: legacy }).structuredContent as WriteEventResult).notes).toEqual([OUTCOME_NOTES.desired_state_present, READBACK_UNAVAILABLE_NOTE]);
        const partial: DeleteEventResult = {
            write_outcome: 'applied', deleted: 'occurrence', calendar_id: WORK, resource_href: href('x'), recurrence_id: 'occ1_20270119T150000Z', readback: 'ok', expected_version: '"e2"',
            stored_differs_from_request: ['recurrence'], calendars: [{ calendar_id: WORK, display_name: 'Work', status: 'ok' }],
        };
        expect((shapeDeleteResult(partial, { wire: legacy }).structuredContent as DeleteEventResult).notes).toEqual([DELETE_STORED_DIFFERS_NOTE]);
        expect('notes' in (shapeDeleteResult({ ...partial, stored_differs_from_request: [] }, { wire: legacy }).structuredContent as DeleteEventResult)).toBe(false);
        expect((shapeDeleteResult({ ...partial, readback: 'unavailable', expected_version: null, stored_differs_from_request: null }, { wire: legacy }).structuredContent as DeleteEventResult).notes).toEqual([READBACK_UNAVAILABLE_NOTE]);
    });
});

describe('iCloud applied this call but its answer was lost: desired_state_present says only what was observed', () => {
    const NOTE = OUTCOME_NOTES.desired_state_present;
    const ONE = single('one', ['DTSTART:20270111T150000Z', 'DTEND:20270111T160000Z', 'SUMMARY:One']);

    test('the note states the observation and names every possible saver; it never says nothing was saved', () => {
        expect(NOTE).toContain('found in the calendar');
        for (const saver of ['this call', 'an earlier attempt', 'another client']) { expect<unknown>([saver, NOTE.includes(saver)]).toEqual([saver, true]); }
        for (const claim of ['nothing', 'already']) { expect<unknown>([claim, NOTE.toLowerCase().includes(claim)]).toEqual([claim, false]); }
    });

    for (const protocol of ERAS) {
        test(`${protocol}: create, update and delete, end to end through the real pipeline`, async () => {
            const cases: { tool: string; method: 'putEvent' | 'deleteEvent'; seed: boolean; args: (etag: string) => Record<string, unknown>; saved: (fake: FakeICloud) => boolean }[] = [
                { tool: 'create_event', method: 'putEvent', seed: false, args: () => CREATE, saved: fake => fake.hrefs(WORK).some(at => fake.get(WORK, at)?.text.includes('SUMMARY:Planning') === true) },
                { tool: 'update_event', method: 'putEvent', seed: true, args: etag => ({ calendar_id: WORK, resource_href: href('one'), expected_version: etag, changes: { title: 'Two' } }), saved: fake => fake.get(WORK, href('one'))?.text.includes('SUMMARY:Two') === true },
                { tool: 'delete_event', method: 'deleteEvent', seed: true, args: etag => ({ calendar_id: WORK, resource_href: href('one'), expected_version: etag }), saved: fake => fake.get(WORK, href('one')) === undefined },
            ];
            for (const item of cases) {
                const h = harness();
                const etag = item.seed ? h.fake.seed(WORK, href('one'), ONE) : '';
                h.fake.failNextWrite({ kind: 'uncertain', apply: true });
                const reply = await h.call(item.tool, item.args(etag), protocol);
                const notes = notesOf(reply);
                expect<unknown>([item.tool, reply.structuredContent['write_outcome'], notes, h.fake.count(item.method), item.saved(h.fake)]).toEqual([item.tool, 'desired_state_present', [NOTE], 1, true]);
                const text = (notes as string[]).join(' ').toLowerCase();
                for (const claim of ['nothing', 'already']) { expect<unknown>([item.tool, claim, text.includes(claim)]).toEqual([item.tool, claim, false]); }
            }
        });
    }
});

// ---- Errors that explain themselves ----

describe('error messages carry what the descriptions no longer say', () => {
    test('get_event and the download with a stale expected_version: get the event again and decide', async () => {
        const h = harness();
        h.fake.seed(WORK, href('one'), single('one', ['DTSTART:20270111T150000Z', 'DTEND:20270111T160000Z', 'SUMMARY:One']));
        const stale = '"stale"';
        for (const [name, args] of [
            ['get_event', { calendar_id: WORK, resource_href: href('one'), expected_version: stale }],
            ['get_event_attachment_download', { calendar_id: WORK, resource_href: href('one'), attachment_ref: `a1_${'A'.repeat(43)}`, expected_version: stale }],
        ] as const) {
            const error = errorOf(await h.call(name, args));
            expect<unknown>([name, error.code, error.message.includes('expected_version'), error.message.includes('Get the event again and decide')]).toEqual([name, 'calendar_changed', true, true]);
        }
    });

    test('create_event with a reused operation_id and other values says how to use operation_id', async () => {
        const h = harness();
        await h.call('create_event', CREATE);
        const error = errorOf(await h.call('create_event', { ...CREATE, title: 'Other' }));
        expect<unknown>([error.code, error.reason, error.differs]).toEqual(['calendar_changed', 'existing_resource_differs', ['title']]);
        for (const phrase of ['already exists for this operation_id', 'new random UUID', 'only to retry', 'update_event', 'Nothing was saved']) { expect<unknown>([phrase, error.message.includes(phrase)]).toEqual([phrase, true]); }
    });

    test('a rule whose UNTIL has the wrong form says what form it must have; other invalid input does not', async () => {
        const h = harness();
        const until = errorOf(await h.call('create_event', { ...CREATE, recurrence: { rrule: 'FREQ=DAILY;UNTIL=20270201' } }));
        expect<unknown>([until.code, until.reason, until.field]).toEqual(['invalid_input', 'rrule_until_form', 'recurrence']);
        for (const phrase of ['UNTIL must have the form of the start', 'UTC time ending in Z', 'for an all-day start']) { expect<unknown>([phrase, until.message.includes(phrase)]).toEqual([phrase, true]); }
        const other = errorOf(await h.call('create_event', { ...CREATE, recurrence: { rrule: 'FREQ=NEVER' } }));
        expect<unknown>([other.code, other.message.includes('UNTIL')]).toEqual(['invalid_input', false]);
    });

    const SERIES_HREF = href('series');
    const seeded = (text: string) => {
        const h = harness();
        return { h, etag: h.fake.seed(WORK, SERIES_HREF, text) };
    };
    const utcSeries = SERIES('series', 'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'FREQ=WEEKLY;COUNT=6', ['EXDATE:20270119T150000Z']);
    const move = { start: '2027-01-05T16:00:00Z', end: '2027-01-05T16:30:00Z' };

    test('exceptions_choice_required explains both choices, what drop removes and where, and when shift is allowed', async () => {
        const { h, etag } = seeded(utcSeries);
        const error = errorOf(await h.call('update_event', { calendar_id: WORK, resource_href: SERIES_HREF, expected_version: etag, edit_scope: 'all', changes: move }));
        expect<unknown>([error.code, error.reason, error.exceptions]).toEqual(['edit_not_supported', 'exceptions_choice_required', { changed_occurrences: 0, deleted_occurrences: 1 }]);
        for (const phrase of ['exceptions: "drop"', 'exceptions_dropped', 'edit_scope "this"', '"shift"', 'edit_scope "all" only', 'stored in UTC', 'no rule change', 'FREQ up to WEEKLY', 'INTERVAL, COUNT and WKST', 'Nothing was saved']) {
            expect<unknown>([phrase, error.message.includes(phrase)]).toEqual([phrase, true]);
        }
        expect(h.fake.count('putEvent')).toBe(0);
    });

    test('each refused shift says why, and offers drop', async () => {
        const zoned = SERIES('series', 'DTSTART;TZID=America/New_York:20270105T100000', 'DTEND;TZID=America/New_York:20270105T103000', 'FREQ=WEEKLY;COUNT=6', ['EXDATE;TZID=America/New_York:20270119T100000']);
        const byDay = SERIES('series', 'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'FREQ=WEEKLY;BYDAY=TU;COUNT=6', ['EXDATE:20270119T150000Z']);
        const cases: [string, string, Record<string, unknown>, string][] = [
            [zoned, 'exceptions_shift_not_utc', { edit_scope: 'all', exceptions: 'shift', changes: { start: { local: '2027-01-05T11:00:00', zone: 'America/New_York' }, end: { local: '2027-01-05T11:30:00', zone: 'America/New_York' } } }, 'stored in UTC'],
            [utcSeries, 'exceptions_shift_with_rule_change', { edit_scope: 'all', exceptions: 'shift', changes: { ...move, recurrence: { rrule: 'FREQ=DAILY;COUNT=3' } } }, 'rule change'],
            [byDay, 'exceptions_shift_rule_not_supported', { edit_scope: 'all', exceptions: 'shift', changes: move }, 'FREQ up to WEEKLY'],
            [utcSeries, 'exceptions_shift_not_supported_for_split', { edit_scope: 'this_and_future', recurrence_id: 'occ1_20270112T150000Z', operation_id: 'op-notes-shift', exceptions: 'shift', changes: { start: '2027-01-12T16:00:00Z', end: '2027-01-12T16:30:00Z' } }, 'edit_scope "all" only'],
        ];
        for (const [text, reason, args, why] of cases) {
            const { h, etag } = seeded(text);
            const error = errorOf(await h.call('update_event', { calendar_id: WORK, resource_href: SERIES_HREF, expected_version: etag, ...args }));
            expect<unknown>([reason, error.code, error.reason, error.message.includes(why), error.message.includes('exceptions "drop"'), error.message.includes('edit_scope "this"')]).toEqual([reason, 'edit_not_supported', reason, true, true, true]);
            expect(h.fake.count('putEvent')).toBe(0);
        }
    });

    test('a split at the first occurrence says to use edit_scope "all" instead, for update and delete', async () => {
        const plain = SERIES('series', 'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'FREQ=WEEKLY;COUNT=6');
        for (const [name, args] of [
            ['update_event', { edit_scope: 'this_and_future', recurrence_id: 'occ1_20270105T150000Z', operation_id: 'op-notes-first', changes: { title: 'New' } }],
            ['delete_event', { edit_scope: 'this_and_future', recurrence_id: 'occ1_20270105T150000Z' }],
        ] as const) {
            const { h, etag } = seeded(plain);
            const error = errorOf(await h.call(name, { calendar_id: WORK, resource_href: SERIES_HREF, expected_version: etag, ...args }));
            expect<unknown>([name, error.reason, error.message.includes('first occurrence'), error.message.includes('edit_scope "all"'), error.message.includes('Nothing was saved')]).toEqual([name, 'split_at_series_start', true, true, true]);
        }
    });

    test('split_incomplete is complete on its own: two saves, the new series first, and how to finish or undo', async () => {
        const service = (fake: FakeICloud): BoundCalendarService => ({
            ...bindCalendarService({ caldav: fake, connectionStatus: 'active', credentials: () => credentials, markReconnectRequired: async () => true, now: () => NOW_MS }),
            update_event: async () => { throw new CalendarError('split_incomplete', undefined, { reason: 'second_write_refused', created_series: { resource_href: href('new'), expected_version: '"e9"', write_outcome: 'applied' } }); },
        });
        const error = errorOf(await harness(service).call('update_event', { calendar_id: WORK, resource_href: SERIES_HREF, expected_version: '"e1"', changes: { title: 'x' } }));
        for (const phrase of ['two saves, the new series first', 'WAS saved', 'show twice', 'same operation_id', 'delete_event the new series']) { expect<unknown>([phrase, error.message.includes(phrase)]).toEqual([phrase, true]); }
    });

    test('created_series_differs after this call\'s own create was applied with its answer lost: no claim about who saved it', async () => {
        const { h, etag } = seeded(SERIES('series', 'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'FREQ=WEEKLY;UNTIL=20270301T000000Z', ['EXDATE:20270202T150000Z']));
        h.fake.failNextWrite({ kind: 'uncertain', apply: true });
        h.fake.putEvent = (put => async (...args: Parameters<typeof put>) => {
            const answer = await put(...args);
            // Another client removes the carried EXDATE from the new series right after this call's create.
            h.fake.externalEdit(WORK, args[2].href, text => text.replace('EXDATE:20270202T150000Z\r\n', ''));
            return answer;
        })(h.fake.putEvent.bind(h.fake));
        const error = errorOf(await h.call('update_event', { calendar_id: WORK, resource_href: SERIES_HREF, expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270126T150000Z', operation_id: 'op-notes-differs', changes: { title: 'New' } }));
        expect<unknown>([error.code, error.reason, (error['created_series'] as { write_outcome?: string } | undefined)?.write_outcome, h.fake.count('putEvent'), h.fake.get(WORK, SERIES_HREF)?.etag]).toEqual(['split_incomplete', 'created_series_differs', 'unconfirmed', 1, etag]);
        for (const phrase of ['this call did not change the original series', 'Do not repeat this call']) { expect<unknown>([phrase, error.message.includes(phrase)]).toEqual([phrase, true]); }
        for (const claim of ['earlier call', 'Nothing was saved', 'nothing was saved']) { expect<unknown>([claim, error.message.includes(claim)]).toEqual([claim, false]); }
    });
});

// ---- A series iCloud returns without the asked occurrence ----

describe('an occurrence iCloud expands as the series alone is not_found, never unsupported data; nothing is written', () => {
    const LA = 'America/Los_Angeles';
    const SERIES_HREF = href('SYNTH-NOTES-SWO');
    const text = crlf([
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic//EN', 'BEGIN:VEVENT', 'UID:SYNTH-NOTES-SWO', 'DTSTAMP:20261101T120000Z', 'SEQUENCE:0',
        `DTSTART;TZID=${LA}:20270608T110000`, `DTEND;TZID=${LA}:20270608T120000`, 'RRULE:FREQ=WEEKLY;INTERVAL=12;UNTIL=20271231T235959Z', `EXDATE;TZID=${LA}:20270608T110000`,
        'SUMMARY:Synthetic standup', 'END:VEVENT', 'END:VCALENDAR',
    ]);
    const DELETED = 'occ1_20270608T180000Z';
    const MESSAGE = ['iCloud returned the series without this occurrence', 'probably deleted', 'without recurrence_id'];

    test('get_event, update_event and delete_event with edit_scope this', async () => {
        const h = harness();
        const etag = h.fake.seed(WORK, SERIES_HREF, text);
        const target = { calendar_id: WORK, resource_href: SERIES_HREF };
        for (const [name, args, write] of [
            ['get_event', { ...target, recurrence_id: DELETED }, false],
            ['update_event', { ...target, expected_version: etag, edit_scope: 'this', recurrence_id: DELETED, changes: { title: 'Changed' } }, true],
            ['delete_event', { ...target, expected_version: etag, edit_scope: 'this', recurrence_id: DELETED }, true],
        ] as const) {
            const error = errorOf(await h.call(name, args));
            expect<unknown>([name, error.code]).toEqual([name, 'not_found']);
            for (const phrase of [...MESSAGE, ...(write ? ['Nothing was saved'] : [])]) { expect<unknown>([name, phrase, error.message.includes(phrase)]).toEqual([name, phrase, true]); }
        }
        expect(h.fake.count('putEvent') + h.fake.count('deleteEvent')).toBe(0);
        expect(h.fake.get(WORK, SERIES_HREF)?.text).toBe(text);
        // Any other not_found keeps the plain message.
        const missing = errorOf(await h.call('get_event', { calendar_id: WORK, resource_href: href('missing') }));
        expect<unknown>([missing.code, MESSAGE.some(phrase => missing.message.includes(phrase))]).toEqual(['not_found', false]);
    });
});

// ---- outcome_unknown: every site, every tool ----

describe('every outcome_unknown answer carries the safety text', () => {
    /**
     * Every place the server decides outcome_unknown. A new site fails this test until it is added here AND to the
     * end-to-end table below, so no path can answer outcome_unknown without the text being checked.
     */
    const SITES: Record<string, number> = {
        'src/calendar/write-core.ts': 2, // putIfMatch: a 412 whose re-read failed; an uncertain answer, state not observed
        'src/calendar/write.ts': 3, // create: uncertain, another event at the href; uncertain, nothing there; delete of a resource: uncertain, still there
        'src/calendar/write-split.ts': 2, // the split's first write uncertain, not observed; its second write's putIfMatch outcome_unknown
    };

    test('the outcome_unknown sites in the source are exactly the enumerated ones', async () => {
        const found: Record<string, number> = {};
        for await (const file of new Glob('src/**/*.ts').scan('.')) {
            const text = await Bun.file(file).text();
            const count = text.match(/(?:WriteError|CalendarError|ReadError)\(\s*'outcome_unknown'/gu)?.length ?? 0;
            if (count > 0) { found[file] = count; }
        }
        expect(found).toEqual(SITES);
    });

    const series = SERIES('series', 'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'FREQ=WEEKLY;UNTIL=20270301T000000Z');
    const one = single('one', ['DTSTART:20270111T150000Z', 'DTEND:20270111T160000Z', 'SUMMARY:One']);
    type Site = { site: string; tool: string; seed: [string, string] | null; arrange: (fake: FakeICloud) => void; args: (etag: string) => Record<string, unknown>; created?: boolean };
    const afterPut = (fake: FakeICloud, then: () => void): void => {
        fake.putEvent = (put => async (...args: Parameters<typeof put>) => {
            const answer = await put(...args);
            then();
            return answer;
        })(fake.putEvent.bind(fake));
    };
    const sites: Site[] = [
        { site: 'write-core putIfMatch: 412, re-read failed (update)', tool: 'update_event', seed: [href('one'), one], arrange: fake => { fake.failNextWrite({ kind: 'status', status: 412, apply: false }); afterPut(fake, () => fake.failNextRead(new Error('lost'))); }, args: etag => ({ calendar_id: WORK, resource_href: href('one'), expected_version: etag, changes: { title: 'x' } }) },
        { site: 'write-core putIfMatch: uncertain, not observed (update single)', tool: 'update_event', seed: [href('one'), one], arrange: fake => { fake.failNextWrite({ kind: 'uncertain', apply: false }); }, args: etag => ({ calendar_id: WORK, resource_href: href('one'), expected_version: etag, changes: { title: 'x' } }) },
        { site: 'write-core putIfMatch: uncertain, not observed (update this)', tool: 'update_event', seed: [href('series'), series], arrange: fake => { fake.failNextWrite({ kind: 'uncertain', apply: false }); }, args: etag => ({ calendar_id: WORK, resource_href: href('series'), expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20270112T150000Z', changes: { title: 'x' } }) },
        { site: 'write-core putIfMatch: uncertain, not observed (delete this)', tool: 'delete_event', seed: [href('series'), series], arrange: fake => { fake.failNextWrite({ kind: 'uncertain', apply: false }); }, args: etag => ({ calendar_id: WORK, resource_href: href('series'), expected_version: etag, edit_scope: 'this', recurrence_id: 'occ1_20270112T150000Z' }) },
        { site: 'write-core putIfMatch: uncertain, not observed (delete this_and_future)', tool: 'delete_event', seed: [href('series'), series], arrange: fake => { fake.failNextWrite({ kind: 'uncertain', apply: false }); }, args: etag => ({ calendar_id: WORK, resource_href: href('series'), expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270119T150000Z' }) },
        { site: 'write create: uncertain, another event at the href', tool: 'create_event', seed: null, arrange: fake => { fake.failNextWrite({ kind: 'uncertain', apply: true }); afterPut(fake, () => { for (const at of fake.hrefs(WORK)) { fake.externalEdit(WORK, at, text => text.replace('SUMMARY:Planning', 'SUMMARY:Theirs')); } }); }, args: () => CREATE },
        { site: 'write create: uncertain, nothing there', tool: 'create_event', seed: null, arrange: fake => { fake.failNextWrite({ kind: 'uncertain', apply: false }); }, args: () => CREATE },
        { site: 'write delete of a resource: uncertain, still there', tool: 'delete_event', seed: [href('one'), one], arrange: fake => { fake.failNextWrite({ kind: 'uncertain', apply: false }); }, args: etag => ({ calendar_id: WORK, resource_href: href('one'), expected_version: etag }) },
        { site: 'write-split first write: uncertain, not observed', tool: 'update_event', seed: [href('series'), series], arrange: fake => { fake.failNextWrite({ kind: 'uncertain', apply: false }); }, args: etag => ({ calendar_id: WORK, resource_href: href('series'), expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270126T150000Z', operation_id: 'op-notes-unknown', changes: { title: 'New' } }) },
        { site: 'write-split second write: outcome_unknown, the new series saved', tool: 'update_event', seed: [href('series'), series], arrange: fake => { fake.failNextWrite({ kind: 'none' }, { kind: 'uncertain', apply: false }); }, args: etag => ({ calendar_id: WORK, resource_href: href('series'), expected_version: etag, edit_scope: 'this_and_future', recurrence_id: 'occ1_20270126T150000Z', operation_id: 'op-notes-unknown', changes: { title: 'New' } }), created: true },
    ];

    for (const protocol of ERAS) {
        test(`${protocol}: each site, end to end through the real pipeline`, async () => {
            for (const item of sites) {
                const h = harness();
                const etag = item.seed === null ? '' : h.fake.seed(WORK, item.seed[0], item.seed[1]);
                item.arrange(h.fake);
                const reply = await h.call(item.tool, item.args(etag), protocol);
                const error = errorOf(reply);
                expect<unknown>([item.site, error.code, error.message.includes(OUTCOME_UNKNOWN_TEXT), reply.content.some(block => block.text.includes(OUTCOME_UNKNOWN_TEXT))]).toEqual([item.site, 'outcome_unknown', true, true]);
                if (item.created === true) { expect<unknown>([item.site, error.message.includes('The new series for the occurrences from the split on was saved')]).toEqual([item.site, true]); }
            }
        });
    }

    test('every write tool, with every extra an outcome_unknown can carry: the text is always there', async () => {
        const created = { resource_href: href('new'), expected_version: '"e9"', write_outcome: 'applied' as const };
        const dropped = { changed_occurrences: 1, deleted_occurrences: 0, changed: [], deleted: [], truncated: true as const };
        for (const extra of [{}, { created_series: created }, { created_series: created, exceptions_dropped: dropped }, { exceptions_dropped: dropped }, { upstream: { status: 500, content_type: 'none' as const, preconditions: [], detail: null } }]) {
            for (const tool of ['create_event', 'update_event', 'delete_event'] as const) {
                const throwing = async (): Promise<never> => { throw new CalendarError('outcome_unknown', undefined, extra); };
                const service = (fake: FakeICloud): BoundCalendarService => ({
                    ...bindCalendarService({ caldav: fake, connectionStatus: 'active', credentials: () => credentials, markReconnectRequired: async () => true, now: () => NOW_MS }),
                    [tool]: throwing,
                });
                const args = tool === 'create_event' ? CREATE : { calendar_id: WORK, resource_href: href('one'), expected_version: '"e1"', ...(tool === 'update_event' ? { changes: { title: 'x' } } : {}) };
                const reply = await harness(service).call(tool, args);
                const error = errorOf(reply);
                expect<unknown>([tool, Object.keys(extra), error.code, error.message.includes(OUTCOME_UNKNOWN_TEXT), reply.content[0]?.text.includes(OUTCOME_UNKNOWN_TEXT)]).toEqual([tool, Object.keys(extra), 'outcome_unknown', true, true]);
            }
        }
    });
});
