import { expect, spyOn, test } from 'bun:test';
import { bindCalendarService } from '../src/calendar/service';
import { CalDavError } from '../src/caldav/contracts';
import { BudgetError } from '../src/calendar/model';
import { ReadError } from '../src/calendar/read';
import { UnreadableCredentials, type UpstreamCredentials } from '../src/auth/contracts';
import { withRequestBudget } from '../src/request-budget';
import { FAKE_DISCOVERY, FakeCalDavRead } from './helpers/fake-caldav-read';

const calendarId = '/10000000001/calendars/work/';
const href = `${calendarId}e.ics`;
const range = { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' };
const credentials: UpstreamCredentials = { accountId: 'bound-account', appleId: 'bound@example.invalid', appPassword: 'private-canary', ...FAKE_DISCOVERY, issuedAt: 1000 };
const ics = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:one\nDTSTART:20270111T100000Z\nSUMMARY:Needle\nATTACH:https://example.invalid/private-link\nEND:VEVENT\nEND:VCALENDAR\n';
function setup(status: 'active' | 'reconnect_required' = 'active', load = () => credentials) {
    const backend = new FakeCalDavRead().setCalendars([{ id: calendarId, displayName: 'Work', components: ['VEVENT'], color: null }]);
    backend.scriptQuery(calendarId, [{ href, etag: '"v1"', calendarData: ics }]);
    backend.scriptMultiget(calendarId, [{ kind: 'found', resource: { href, etag: '"v1"', calendarData: ics } }]);
    let loads = 0; let marks = 0;
    const service = bindCalendarService({ caldav: backend, connectionStatus: status, credentials: () => { loads++; return load(); }, markReconnectRequired: async () => { marks++; return true; } });
    return { backend, service, loads: () => loads, marks: () => marks };
}

test('all read closures bind the stored credentials and discovery once and share a per-call budget', async () => {
    for (const name of ['list_events', 'search_events', 'get_event'] as const) {
        const f = setup();
        const list = spyOn(f.backend, 'listCalendars');
        const query = spyOn(f.backend, 'queryEvents');
        const get = spyOn(f.backend, 'multigetEvents');
        const result = name === 'get_event' ? await f.service.get_event({ calendar_id: calendarId, resource_href: href, include_raw: true })
            : name === 'search_events' ? await f.service.search_events({ range, query: 'needle' }) : await f.service.list_events({ range });
        expect(f.loads()).toBe(1);
        expect(f.marks()).toBe(0);
        const calls = [...list.mock.calls, ...query.mock.calls, ...get.mock.calls];
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect(call[0]).toEqual({ appleId: credentials.appleId, appPassword: credentials.appPassword });
            expect(call[1]).toEqual(FAKE_DISCOVERY);
        }
        expect(f.backend.calls.every(call => call.options?.signal !== undefined && !call.options.signal.aborted)).toBe(true);
        expect(f.backend.calls[0]?.options?.charge).toBeDefined();
        expect(f.backend.calls[0]?.options?.deadlineMs).toBeGreaterThan(0);
        if ('rawIcs' in result) { expect(result.rawIcs).toBe(ics); }
        else { expect(result.events.map(event => event.title)).toEqual(['Needle']); }
    }
});

test('read credentials remain lazy, inactive or unreadable connections cannot reach the backend', async () => {
    for (const name of ['list_events', 'search_events', 'get_event'] as const) {
        for (const unreadable of [false, true]) {
            const f = unreadable ? setup('active', () => { throw new UnreadableCredentials(); }) : setup('reconnect_required');
            expect(f.loads()).toBe(0);
            const pending = name === 'get_event' ? f.service.get_event({ calendar_id: calendarId, resource_href: href })
                : name === 'search_events' ? f.service.search_events({ range, query: 'x' }) : f.service.list_events({ range });
            await expect(pending).rejects.toMatchObject({ code: 'reconnect_required' });
            expect(f.backend.count()).toBe(0);
            expect(f.loads()).toBe(unreadable ? 1 : 0);
            expect(f.marks()).toBe(unreadable ? 1 : 0);
        }
    }
});

test('parallel read 401s mark the bound credential generation exactly once per invocation', async () => {
    const f = setup();
    const ids = ['a', 'b', 'c'].map(name => `/10000000001/calendars/${name}/`);
    f.backend.setCalendars(ids.map(id => ({ id, displayName: null, components: ['VEVENT'], color: null })));
    for (const id of ids) { f.backend.scriptQuery(id, new CalDavError('unauthorized')); }
    const result = await f.service.list_events({ range });
    expect(result.calendars.map(calendar => calendar.status)).toEqual(ids.map(() => 'reconnect_required'));
    expect(f.marks()).toBe(1);
});

test('read whole-tool failures map all transport, read and budget errors to fixed public codes', async () => {
    for (const [error, code] of [
        [new CalDavError('unauthorized'), 'reconnect_required'], [new CalDavError('temporary'), 'temporarily_unavailable'],
        [new CalDavError('protocol'), 'upstream_error'], [new CalDavError('forbidden_host'), 'upstream_error'],
        [new CalDavError('not_found'), 'not_found'], [new CalDavError('too_large'), 'result_too_large'],
        [new BudgetError('deadline'), 'temporarily_unavailable'], [new BudgetError('work'), 'result_too_large'],
        [new BudgetError('response_bytes'), 'result_too_large'], [new BudgetError('aggregate_bytes'), 'result_too_large'],
        [new ReadError('calendar_changed'), 'calendar_changed'], [new Error('private-canary'), 'temporarily_unavailable'],
    ] as const) {
        const f = setup(); f.backend.scriptList(error);
        await expect(f.service.list_events({ range })).rejects.toMatchObject({ code, message: code });
        expect(f.marks()).toBe(code === 'reconnect_required' ? 1 : 0);
    }
});

test('read calls share aggregate charges across calendars and get a fresh budget on the next invocation', async () => {
    const f = setup();
    const ids = ['a', 'b'].map(name => `/10000000001/calendars/${name}/`);
    const members = ids.map(id => ({ id, displayName: null, components: ['VEVENT'], color: null }));
    for (let invocation = 0; invocation < 2; invocation++) {
        let overflow: unknown;
        f.backend.scriptList((_query, options) => { options?.charge?.chargeBytes(1); return members; });
        for (const id of ids) {
            f.backend.scriptQuery(id, (_query, options) => {
                try { options?.charge?.chargeBytes(8 * 1024 * 1024); } catch (error) { overflow = error; throw error; }
                return [];
            });
        }
        await f.service.list_events({ range });
        expect(overflow).toEqual(new BudgetError('aggregate_bytes'));
    }
    expect(f.backend.count('queryEvents')).toBe(4);
    expect(f.loads()).toBe(2);
});

test('a backend without the event-read capability fails closed without changing list_calendars', async () => {
    let calls = 0;
    const service = bindCalendarService({ caldav: { listCalendars: async () => { calls++; return []; } }, connectionStatus: 'active', credentials: () => credentials, markReconnectRequired: async () => false });
    await expect(service.list_events({ range })).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(await service.list_calendars({})).toEqual({ calendars: [], truncated: false });
    expect(calls).toBe(1);
});

test('the read budget observes the live server-owned Lambda deadline before membership dispatch', async () => {
    const f = setup();
    await expect(withRequestBudget(() => 2999, () => f.service.list_events({ range }))).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(f.backend.count()).toBe(0);
});
