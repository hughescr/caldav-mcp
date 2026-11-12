import { describe, expect, test } from 'bun:test';
import { CalDavError, type CalendarSummary } from '../src/caldav/contracts';
import type { CalendarResource } from '../src/caldav/read-contracts';
import { createReadBudget } from '../src/calendar/budget';
import { getEvent, listEvents, searchEvents, type ReadDeps } from '../src/calendar/read';
import { FakeCalDavRead, FAKE_DISCOVERY } from './helpers/fake-caldav-read';
import moved from './fixtures/calendar/original-get/expected.json';
import movedWeekly from './fixtures/calendar/moved-weekly/expected.json';

const path = (name: string) => `/10000000001/calendars/${name}/`;
const calendar = (name: string): CalendarSummary => ({ id: path(name), displayName: name, components: ['VEVENT'], color: null });
const range = { start: '2027-01-01T00:00:00Z', end: '2027-03-01T00:00:00Z' };
const fixture = (name: string) => Bun.file(new URL(`./fixtures/calendar/${name}`, import.meta.url)).text();
const original = await fixture('original-get/original.ics');
const expanded = await fixture('original-get/expanded.ics');
const malformed = await fixture('parser/malformed.ics');
const detached = await fixture('original-get/detached.ics');
const resource = (calendarData = expanded, name = 'event.ics', cal = 'work', etag = '"v1"'): CalendarResource => ({ href: `${path(cal)}${name}`, etag, calendarData });
function setup(names = ['work'], now = () => 0): { backend: FakeCalDavRead; deps: ReadDeps } {
    const backend = new FakeCalDavRead().setCalendars(names.map(calendar));
    return { backend, deps: { backend, auth: { appleId: 'synthetic@example.test', appPassword: 'synthetic' }, discovery: FAKE_DISCOVERY, accountId: 'synthetic-account', budget: createReadBudget({ now, yieldFn: async () => {} }) } };
}
const flush = async () => { for (let index = 0; index < 100; index++) { await Promise.resolve(); } };
const getInput = { calendar_id: path('work'), resource_href: `${path('work')}event.ics` };

// Synthetic, from probe evidence; fake backends never access a network or credentials store.
describe('P3 batched multi-calendar reads', () => {
    for (const operation of ['list', 'search'] as const) {
        test(`${operation} performs exactly 1+N calls and never fetches originals, including cancelled events`, async () => {
            const { backend, deps } = setup(['work', 'home', 'other']);
            backend.scriptQuery(path('work'), [resource()]);
            const result = operation === 'list' ? await listEvents(deps, { range }) : await searchEvents(deps, { range, query: 'moved' });
            expect(backend.calls.map(call => call.method)).toEqual(['listCalendars', 'queryEvents', 'queryEvents', 'queryEvents']);
            expect(backend.count('multigetEvents')).toBe(0);
            expect(result.events).toHaveLength(1);
            expect(result.events[0]?.status).toBe('CANCELLED');
            expect(result.events[0]?.title).toBe(moved.occurrence_title);
            expect(result.events[0]?.recurrence_id).toBe(moved.token);
            expect(backend.calls.filter(call => call.method === 'queryEvents').map(call => call.range)).toEqual(Array.from({ length: 3 }, () => ({ startUtc: '20261201T000000Z', endUtc: '20270401T000000Z' })));
        });
    }
    test('cross-kind expanded override keeps literal DATE and nonmidnight opaque RID without original fetch', async () => {
        const { backend, deps } = setup();
        const crossKind = expanded.replace('DTSTART:20270201T100000Z', 'DTSTART;VALUE=DATE:20270201').replace('DTEND:20270201T110000Z', 'DTEND;VALUE=DATE:20270202');
        backend.scriptQuery(path('work'), [resource(crossKind)]);
        const result = await listEvents(deps, { range });
        expect(result.events[0]?.start).toEqual({ date: '2027-02-01', all_day: true });
        expect(result.events[0]?.recurrence_id).toBe(moved.token);
        expect(backend.count()).toBe(2);
        expect(backend.count('multigetEvents')).toBe(0);
    });
    test('omitted selection reads all member event calendars, not first20/public200', async () => {
        const names = Array.from({ length: 201 }, (_, i) => `c${String(i).padStart(3, '0')}`);
        const { backend, deps } = setup(names.toReversed());
        const result = await listEvents(deps, { range, limit: 1 });
        expect(result.calendars.map(item => item.calendar_id)).toEqual(names.map(path));
        expect(backend.count()).toBe(202);
        expect(backend.count('multigetEvents')).toBe(0);
    });
    test('explicit order retained; unknown calendar not_found gets no REPORT', async () => {
        const { backend, deps } = setup(['work', 'home']);
        const result = await listEvents(deps, { range, calendar_ids: [path('home'), path('missing'), path('work')] });
        expect(result.calendars.map(item => [item.calendar_id, item.status])).toEqual([[path('home'), 'ok'], [path('missing'), 'not_found'], [path('work'), 'ok']]);
        expect(backend.calls.filter(call => call.method === 'queryEvents').map(call => call.calendarId)).toEqual([path('home'), path('work')]);
    });
    test('calendar temporary/protocol failure discards only that calendar', async () => {
        const { backend, deps } = setup(['a', 'b', 'c']);
        backend.scriptQuery(path('a'), [resource(expanded, 'a.ics', 'a')]);
        backend.scriptQuery(path('b'), new CalDavError('temporary'));
        backend.scriptQuery(path('c'), new CalDavError('protocol'));
        const result = await listEvents(deps, { range });
        expect(result.calendars.map(item => item.status)).toEqual(['ok', 'temporarily_unavailable', 'upstream_error']);
        expect(result.events.map(item => item.calendar)).toEqual([0]);
    });
    test('one malformed resource degrades among good ones; search retains unreadable candidates', async () => {
        for (const search of [false, true]) {
            const { backend, deps } = setup();
            backend.scriptQuery(path('work'), [resource(), resource(malformed, 'bad.ics')]);
            const result = search ? await searchEvents(deps, { range, query: 'no readable match' }) : await listEvents(deps, { range });
            expect(result.calendars[0]?.status).toBe('ok');
            expect(result.events).toHaveLength(search ? 0 : 1);
            expect(result.unreadableCount).toBe(1);
            expect(result.unreadable).toEqual([{ calendar: 0, resource_href: `${path('work')}bad.ics`, recurrence_id: null, reason: 'malformed' }]);
        }
    });
    test('entirely unexpanded recurrence response fails calendar, individual retained rules degrade', async () => {
        const all = setup();
        all.backend.scriptQuery(path('work'), [resource(original)]);
        expect((await listEvents(all.deps, { range })).calendars[0]?.status).toBe('upstream_error');
        const mixed = setup();
        mixed.backend.scriptQuery(path('work'), [resource(), resource(original, 'retained.ics')]);
        const result = await listEvents(mixed.deps, { range });
        expect(result.calendars[0]?.status).toBe('ok');
        expect(result.events).toHaveLength(1);
        expect(result.unreadable[0]?.reason).toBe('unsupported_recurrence_data');
    });
    test('three complete calendar pipelines maximum, independent of result limit', async () => {
        const { backend, deps } = setup(['a', 'b', 'c', 'd']);
        const gates = ['a', 'b', 'c'].map(name => backend.holdQuery(path(name)));
        const run = listEvents(deps, { range, limit: 1 });
        try {
            await flush();
            expect(backend.count('queryEvents')).toBe(3);
            expect(backend.maxInFlight).toBe(3);
        } finally { for (const gate of gates) { gate.release([]); } }
        const result = await run;
        expect(backend.count('queryEvents')).toBe(4);
        expect(result.calendars.every(item => item.status === 'ok')).toBe(true);
        expect(backend.maxInFlight).toBe(3);
    });
    test('less than12s after membership leaves calendars not_read and dispatches none', async () => {
        let clock = 0;
        const { backend, deps } = setup(['a', 'b', 'c'], () => clock);
        backend.scriptList(() => { clock = 33_001; return ['a', 'b', 'c'].map(calendar); });
        const result = await listEvents(deps, { range });
        expect(result.calendars.map(item => item.status)).toEqual(['not_read', 'not_read', 'not_read']);
        expect(backend.count()).toBe(1);
    });
    test('20 slow calendars complete only9 in three10s waves after10s membership', async () => {
        let clock = 0;
        const names = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, '0')}`);
        const { backend, deps } = setup(names, () => clock);
        backend.scriptList(() => { clock = 10_000; return names.map(calendar); });
        const gates = names.map(name => backend.holdQuery(path(name)));
        const run = listEvents(deps, { range });
        try {
            for (let wave = 0; wave < 3; wave++) {
                await flush();
                expect(backend.count('queryEvents')).toBe((wave + 1) * 3);
                clock += 10_000;
                for (const gate of gates.slice(wave * 3, wave * 3 + 3)) { gate.release([]); }
            }
            await flush();
        } finally { for (const gate of gates) { gate.release([]); } }
        const result = await run;
        expect(result.calendars.filter(item => item.status === 'ok')).toHaveLength(9);
        expect(result.calendars.filter(item => item.status === 'not_read')).toHaveLength(11);
        expect(backend.count()).toBe(10);
    });
    test('401 preserves finalized calendars, stops queued dispatch and aborts unfinished requests', async () => {
        const { backend, deps } = setup(['a', 'b', 'c', 'd']);
        const fail = backend.holdQuery(path('b'));
        const unfinished = backend.holdQuery(path('c'));
        // Keep a occupied until b/c start, then let a finalize before b reports401; d is held to prevent a completed d.
        const first = backend.holdQuery(path('a'));
        const fourth = backend.holdQuery(path('d'));
        const run = listEvents(deps, { range });
        try {
            await flush();
            first.release([]);
            await flush();
            fail.fail(new CalDavError('unauthorized'));
            await flush();
        } finally { unfinished.release([]); fourth.release([]); }
        const result = await run;
        expect(result.calendars.map(item => item.status)).toEqual(['ok', 'reconnect_required', 'reconnect_required', 'reconnect_required']);
        for (const call of backend.calls.filter(call => call.calendarId === path('c') || call.calendarId === path('d'))) { expect(call.options?.signal?.aborted).toBe(true); }
    });
    test('immediate401 never dispatches a fourth calendar', async () => {
        const { backend, deps } = setup(['a', 'b', 'c', 'd']);
        backend.scriptQuery(path('a'), new CalDavError('unauthorized'));
        await listEvents(deps, { range });
        expect(backend.count('queryEvents')).toBeLessThanOrEqual(3);
    });
    test('shared byte exhaustion is sticky, charged failures are not refunded', async () => {
        const { backend, deps } = setup(['a', 'b', 'c', 'd']);
        backend.scriptQuery(path('a'), (_query, options) => { options?.charge?.chargeBytes(8 * 1024 * 1024); throw new CalDavError('temporary'); });
        backend.scriptQuery(path('b'), (_query, options) => { options?.charge?.chargeBytes(8 * 1024 * 1024 + 1); return []; });
        const result = await listEvents(deps, { range });
        expect(deps.budget.bytesCharged()).toBeGreaterThan(16 * 1024 * 1024);
        expect(deps.budget.exhausted()).toBe(true);
        expect(result.calendars.find(item => item.calendar_id === path('d'))?.status).toBe('result_too_large');
    });
    test('membership failures fail the whole call before any event dispatch', async () => {
        const { backend, deps } = setup();
        backend.scriptList(new CalDavError('temporary'));
        await expect(listEvents(deps, { range })).rejects.toMatchObject({ code: 'temporarily_unavailable' });
        expect(backend.count()).toBe(1);
    });
    test('over300 discovered calendars fails before dispatch, empty membership succeeds', async () => {
        const tooMany = setup(Array.from({ length: 301 }, (_, index) => `c${index}`));
        await expect(listEvents(tooMany.deps, { range })).rejects.toMatchObject({ code: 'result_too_large' });
        expect(tooMany.backend.count()).toBe(1);
        const empty = setup([]);
        const result = await listEvents(empty.deps, { range });
        expect(result.calendars).toEqual([]);
        expect(result.events).toEqual([]);
        expect(empty.backend.count()).toBe(1);
    });
    test('injected cross-calendar or duplicate hrefs fail entire calendar, not unreadable prefix', async () => {
        for (const resources of [[resource(), resource(expanded, 'foreign.ics', 'other')], [resource(), resource()]]) {
            const { backend, deps } = setup();
            backend.scriptQuery(path('work'), resources);
            const result = await listEvents(deps, { range });
            expect(result.calendars[0]?.status).toBe('upstream_error');
            expect(result.events).toEqual([]);
            expect(result.unreadableCount).toBe(0);
        }
    });
    test('over5000 expanded VEVENTs fails calendar even with injected backend and low result limit', async () => {
        const { backend, deps } = setup();
        const components = Array.from({ length: 5001 }, (_, index) => `BEGIN:VEVENT\nUID:synthetic-${index}\nDTSTART:20270111T100000Z\nDTEND:20270111T110000Z\nEND:VEVENT\n`);
        backend.scriptQuery(path('work'), components.map((component, index) => resource(`BEGIN:VCALENDAR\nVERSION:2.0\n${component}END:VCALENDAR\n`, `${index}.ics`)));
        const result = await listEvents(deps, { range, limit: 1 });
        expect(result.calendars[0]?.status).toBe('result_too_large');
        expect(result.events).toEqual([]);
    });
    test('failed calendars do not refund the shared10000 component work capacity', async () => {
        const { backend, deps } = setup(['a', 'b']);
        const cards = (cal: string) => Array.from({ length: 5001 }, (_, index) => resource(`BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:synthetic-${index}\nDTSTART:20270111T100000Z\nDTEND:20270111T110000Z\nEND:VEVENT\nEND:VCALENDAR\n`, `${index}.ics`, cal));
        backend.scriptQuery(path('a'), cards('a'));
        backend.scriptQuery(path('b'), cards('b'));
        const result = await listEvents(deps, { range });
        expect(result.calendars.map(item => item.status)).toEqual(['result_too_large', 'result_too_large']);
        expect(result.events).toEqual([]);
        expect(deps.budget.exhausted()).toBe(true);
        expect(backend.count()).toBe(3);
    });
    test('empty upstream report stays empty; never reconstructs moved/cancelled/EXDATE occurrences', async () => {
        const { backend, deps } = setup();
        const result = await listEvents(deps, { range });
        expect(result.events).toEqual([]);
        expect(result.unreadable).toEqual([]);
        expect(backend.count()).toBe(2);
    });
});

describe('P3 original-backed get', () => {
    test('null RID is exactly membership+one original multiget, returns old master and unmodified whole raw', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(original) }]);
        const result = await getEvent(deps, { ...getInput, recurrence_id: null, include_raw: true });
        expect(backend.calls.map(call => call.method)).toEqual(['listCalendars', 'multigetEvents']);
        expect(backend.calls[1]?.hrefs).toEqual([getInput.resource_href]);
        expect(result.event.view).toBe('series_master');
        expect(result.event.title).toBe(moved.master_title);
        expect(result.rawIcs).toBe(original);
    });
    test('non-null RID adds exactly one expanded query covering the original slot and the moved override interval', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(original) }]);
        backend.scriptQuery(path('work'), [resource()]);
        const result = await getEvent(deps, { ...getInput, recurrence_id: moved.token });
        expect(backend.calls.map(call => call.method)).toEqual(['listCalendars', 'multigetEvents', 'queryEvents']);
        // ORCHESTRATOR-RULING: union of original slot and moved interval, per probe Run 5
        // T0-DECISION: Run5's31day requested-range pad applies to list/search; get has no requested range and retains section3's24h occurrence-envelope pad.
        // Original slot 2027-01-12T10:00Z-11:00Z (RECURRENCE-ID plus the master's 1 h span) and moved interval 2027-02-01T10:00Z-11:00Z, each side padded 24 h.
        expect(backend.calls[2]?.range).toEqual({ startUtc: '20270111T100000Z', endUtc: '20270202T110000Z' });
        expect(result.event.view).toBe('occurrence');
        expect(result.event.start).toEqual(moved.moved_start);
        expect(result.event.status).toBe('CANCELLED');
        expect(result.rawIcs).toBeNull();
    });
    test('optional expected_version mismatch fails calendar_changed before expansion', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(original, 'event.ics', 'work', '"v2"') }]);
        await expect(getEvent(deps, { ...getInput, recurrence_id: moved.token, expected_version: '"v1"' })).rejects.toMatchObject({ code: 'calendar_changed' });
        expect(backend.count()).toBe(2);
    });
    for (const race of ['etag', 'uid', 'disappeared'] as const) {
        test(`occurrence ${race} race is calendar_changed, not a neighboring occurrence`, async () => {
            const { backend, deps } = setup();
            backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(original) }]);
            backend.scriptQuery(path('work'), race === 'disappeared' ? [] : [resource(race === 'uid' ? expanded.replaceAll('UID:synthetic-moved', 'UID:other') : expanded, 'event.ics', 'work', race === 'etag' ? '"v2"' : '"v1"')]);
            await expect(getEvent(deps, { ...getInput, recurrence_id: moved.token })).rejects.toMatchObject({ code: 'calendar_changed' });
        });
    }
    test('valid expanded href without target token is not_found; original404 is not_found', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(original) }]);
        backend.scriptQuery(path('work'), [resource(expanded.replace('RECURRENCE-ID:20270112T100000Z', 'RECURRENCE-ID:20270114T100000Z'))]);
        await expect(getEvent(deps, { ...getInput, recurrence_id: moved.token })).rejects.toMatchObject({ code: 'not_found' });
        const absent = setup();
        await expect(getEvent(absent.deps, getInput)).rejects.toMatchObject({ code: 'not_found' });
        expect(absent.backend.count()).toBe(2);
    });
    test('one detached override permits null token and returns occurrence without expanded query', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(detached) }]);
        const result = await getEvent(deps, getInput);
        expect(result.event.view).toBe('occurrence');
        expect<unknown>(result.event.start).toEqual(moved.detached_start);
        expect(backend.count()).toBe(2);
    });
    test('unknown-zone override conversion failure widens one window without creating a zone error', async () => {
        const { backend, deps } = setup();
        const unknown = original.replace('DTSTART:20270111T100000Z', 'DTSTART;TZID=Probe/Unknown:20270111T100000').replace('DTEND:20270111T110000Z', 'DTEND;TZID=Probe/Unknown:20270111T110000').replace('RECURRENCE-ID:20270112T100000Z', 'RECURRENCE-ID;TZID=Probe/Unknown:20270112T100000');
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(unknown) }]);
        backend.scriptQuery(path('work'), [resource()]);
        const result = await getEvent(deps, { ...getInput, recurrence_id: moved.token });
        expect(result.event.start).toEqual(moved.moved_start);
        expect(backend.count()).toBe(3);
        // Token nominal interval and unknown override actual interval share one conservative bounded query.
        expect(backend.calls[2]?.range).toEqual({ startUtc: '20270111T100000Z', endUtc: '20270202T110000Z' });
    });
    test('detached non-null token uses override DATE kind, original slot and own moved interval in one expansion', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(detached) }]);
        backend.scriptQuery(path('work'), [resource(detached.replace('RECURRENCE-ID;VALUE=DATE:20261211', 'RECURRENCE-ID:20261211T000000Z'))]);
        const result = await getEvent(deps, { ...getInput, recurrence_id: 'occ1_20261211T000000Z' });
        expect(result.event.view).toBe('occurrence');
        expect<unknown>(result.event.start).toEqual(moved.detached_start);
        // ORCHESTRATOR-RULING: union of original slot and moved interval, per probe Run 5
        // Original slot 2026-12-11T00:00Z and moved DATE 2026-12-14..15, each side padded 24 h.
        expect(backend.calls[2]?.range).toEqual({ startUtc: '20261210T000000Z', endUtc: '20261216T000000Z' });
        expect(backend.count()).toBe(3);
    });
    test('a moved occurrence whose original slot and new time are further apart than the transport cap is result_too_large, not a clipped query', async () => {
        const { backend, deps } = setup();
        const far = original.replace('DTSTART:20270201T100000Z', 'DTSTART:20280401T100000Z').replace('DTEND:20270201T110000Z', 'DTEND:20280401T110000Z');
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(far) }]);
        await expect(getEvent(deps, { ...getInput, recurrence_id: moved.token })).rejects.toMatchObject({ code: 'result_too_large' });
        expect(backend.count('queryEvents')).toBe(0);
    });
    test('DATE master nonmidnight token is not_found before expansion', async () => {
        const { backend, deps } = setup();
        const date = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:date\nDTSTART;VALUE=DATE:20261211\nDTEND;VALUE=DATE:20261212\nRRULE:FREQ=DAILY;COUNT=2\nEND:VEVENT\nEND:VCALENDAR\n';
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(date) }]);
        await expect(getEvent(deps, { ...getInput, recurrence_id: 'occ1_20261211T010000Z' })).rejects.toMatchObject({ code: 'not_found' });
        expect(backend.count('queryEvents')).toBe(0);
    });
});

describe('P3 range filter and civil order', () => {
    test('Run5 Tuesday RID moved to Thursday is returned for Thursday-only request using31day query pad', async () => {
        const { backend, deps } = setup();
        const movedCard = await fixture('moved-weekly/expanded.ics');
        backend.scriptQuery(path('work'), (query) => {
            // The provider needs both original and moved slots inside its query; a Thursday-only/24h query misses Tuesday.
            expect(query.range).toEqual(movedWeekly.transport_range);
            return [resource(movedCard)];
        });
        const result = await listEvents(deps, { range: movedWeekly.range });
        expect(result.events.map(({ title, recurrence_id, start, end }) => ({ title, recurrence_id, start, end }))).toEqual(movedWeekly.events);
        expect(backend.count()).toBe(2);
        expect(backend.count('multigetEvents')).toBe(0);
    });
    test('Run5 zoned event10days outside requested range is excluded despite wider provider query', async () => {
        const { backend, deps } = setup();
        backend.scriptQuery(path('work'), [resource(await fixture('moved-weekly/outside-zoned.ics'))]);
        const result = await listEvents(deps, { range: movedWeekly.range });
        expect(backend.calls[1]?.range).toEqual(movedWeekly.transport_range);
        expect(result.events).toHaveLength(movedWeekly.outside_zoned_returned_count);
        expect(result.unreadableCount).toBe(0);
        expect(result.calendars[0]?.status).toBe('ok');
    });
    test('Run5 DATE/floating values use only requested range plus24h, not the31day transport pad', async () => {
        const { backend, deps } = setup();
        const card = (start: string, end: string | null, uid: string) => `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:${uid}\nDTSTART${start}\n${end === null ? '' : `DTEND${end}\n`}SUMMARY:${uid}\nEND:VEVENT\nEND:VCALENDAR\n`;
        backend.scriptQuery(path('work'), [
            resource(card(';VALUE=DATE:20270120', ';VALUE=DATE:20270121', 'near-date'), 'near-date.ics'),
            resource(card(':20270120T230000', ':20270120T233000', 'near-floating'), 'near-floating.ics'),
            resource(card(';VALUE=DATE:20270131', ';VALUE=DATE:20270201', 'far-date'), 'far-date.ics'),
            resource(card(':20270131T100000', ':20270131T110000', 'far-floating'), 'far-floating.ics'),
            resource(card(';VALUE=DATE:20270119', ';VALUE=DATE:20270120', 'ends-at-civil-start'), 'edge-date.ics'),
            resource(card(':20270123T000000', null, 'point-at-civil-end'), 'edge-floating.ics'),
        ]);
        const result = await listEvents(deps, { range: movedWeekly.range });
        expect(result.events.map(event => event.title)).toEqual(['near-date', 'near-floating']);
        expect(result.unreadableCount).toBe(0);
        expect(backend.calls[1]?.range).toEqual(movedWeekly.transport_range);
    });
    test('DATE/floating24h edge candidates retained; UTC points and intervals obey half-open bounds', async () => {
        const { backend, deps } = setup();
        const card = (start: string, end: string | null, uid: string) => `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:${uid}\nDTSTART${start}\n${end === null ? '' : `DTEND${end}\n`}SUMMARY:${uid}\nEND:VEVENT\nEND:VCALENDAR\n`;
        backend.scriptQuery(path('work'), [
            resource(card(';VALUE=DATE:20270110', ';VALUE=DATE:20270111', 'date-pad'), 'a.ics'),
            resource(card(':20270110T230000', ':20270110T233000', 'floating-pad'), 'b.ics'),
            resource(card(':20270111T000000Z', null, 'point-start'), 'c.ics'),
            resource(card(':20270112T000000Z', null, 'point-end'), 'd.ics'),
            resource(card(':20270110T230000Z', ':20270111T000000Z', 'ends-at-start'), 'e.ics'),
            resource(card(':20270110T230000Z', ':20270111T003000Z', 'overlap'), 'f.ics'),
        ]);
        const result = await listEvents(deps, { range: { start: '2027-01-11T00:00:00Z', end: '2027-01-12T00:00:00Z' } });
        expect(result.events.map(event => event.title)).toEqual(['date-pad', 'floating-pad', 'overlap', 'point-start']);
    });
    test('ties use DATE/floating/TZID/UTC kind before calendar/href/token; later calendars may contain earlier rows', async () => {
        const { backend, deps } = setup(['a', 'b']);
        const card = (start: string, uid: string) => `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:${uid}\nDTSTART${start}\nSUMMARY:${uid}\nEND:VEVENT\nEND:VCALENDAR\n`;
        backend.scriptQuery(path('a'), [resource(card(':20270111T000000Z', 'utc'), 'z.ics', 'a')]);
        backend.scriptQuery(path('b'), [resource(card(';TZID=UTC:20270111T000000', 'zoned'), 'z.ics', 'b'), resource(card(':20270111T000000', 'floating'), 'y.ics', 'b'), resource(card(';VALUE=DATE:20270111', 'date'), 'x.ics', 'b')]);
        const result = await listEvents(deps, { range, limit: 1 });
        expect(result.events.map(event => event.title)).toEqual(['date', 'floating', 'zoned', 'utc']);
        expect(backend.count()).toBe(3);
    });
});
