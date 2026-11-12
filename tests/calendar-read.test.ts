import { describe, expect, test } from 'bun:test';
import { CalDavError, type CalendarSummary } from '../src/caldav/contracts';
import type { CalendarResource } from '../src/caldav/read-contracts';
import { createReadBudget } from '../src/calendar/budget';
import { getEvent, listEvents, ReadError, searchEvents, type ReadDeps } from '../src/calendar/read';
import { FakeCalDavRead, FAKE_DISCOVERY } from './helpers/fake-caldav-read';

// Read orchestration cases the T0 contract does not pin. All calendar data is synthetic; the fake never touches a network.
const path = (name: string) => `/10000000001/calendars/${name}/`;
const calendar = (name: string, displayName: string | null = name): CalendarSummary => ({ id: path(name), displayName, components: ['VEVENT'], color: null });
const range = { start: '2027-01-01T00:00:00Z', end: '2027-03-01T00:00:00Z' };
const fixture = (name: string) => Bun.file(new URL(`./fixtures/calendar/${name}`, import.meta.url)).text();
const original = await fixture('original-get/original.ics');
const expanded = await fixture('original-get/expanded.ics');
const attachmentsOriginal = await fixture('attachments/original.ics');
const allDayDateRid = await fixture('icloud-expanded-shape/f-all-day-date-rid.ics');
const resource = (calendarData: string, name = 'event.ics', cal = 'work', etag = '"v1"'): CalendarResource => ({ href: `${path(cal)}${name}`, etag, calendarData });
const card = (lines: string[], uid = 'synthetic') => `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:${uid}\n${lines.join('\n')}\nEND:VEVENT\nEND:VCALENDAR\n`;

function setup(calendars: CalendarSummary[] = [calendar('work')], now = () => 0): { backend: FakeCalDavRead; deps: ReadDeps; unauthorized: () => number } {
    const backend = new FakeCalDavRead().setCalendars(calendars);
    let calls = 0;
    const deps: ReadDeps = {
        backend,
        auth: { appleId: 'synthetic@example.test', appPassword: 'synthetic' },
        discovery: FAKE_DISCOVERY,
        accountId: 'synthetic-account',
        budget: createReadBudget({ now, yieldFn: async () => {} }),
        onUnauthorized: async () => { calls++; },
    };
    return { backend, deps, unauthorized: () => calls };
}
const getInput = { calendar_id: path('work'), resource_href: `${path('work')}event.ics` };

test('a DATE expanded RID is readable, so it does not degrade its resource', async () => {
    const { backend, deps } = setup();
    backend.scriptQuery(path('work'), [
        resource(card(['DTSTART:20270111T100000Z', 'RECURRENCE-ID;VALUE=DATE:20270111']), 'bad-rid.ics'),
        resource(card(['DTSTART:20270111T100000Z', 'SUMMARY:readable']), 'single.ics'),
    ]);
    const result = await listEvents(deps, { range });
    expect(result.calendars[0]?.status).toBe('ok');
    // ORCHESTRATOR-RULING: iCloud emits VALUE=DATE recurrence ids in expanded data (measured)
    expect(result.events.map(event => event.title)).toEqual([null, 'readable']);
    expect(result.unreadable).toEqual([]);
});

test('non-server-form expanded RIDs (TZID) degrade only their resource, even without readable recurring siblings', async () => {
    const { backend, deps } = setup();
    backend.scriptQuery(path('work'), [
        resource(card(['DTSTART:20270111T100000Z', 'RECURRENCE-ID;TZID=America/New_York:20270111T100000']), 'bad-rid.ics'),
        resource(card(['DTSTART:20270111T100000Z', 'SUMMARY:readable']), 'single.ics'),
    ]);
    const result = await listEvents(deps, { range });
    expect(result.calendars[0]?.status).toBe('ok');
    expect(result.events.map(event => event.title)).toEqual(['readable']);
    expect(result.unreadable).toEqual([{ calendar: 0, resource_href: `${path('work')}bad-rid.ics`, recurrence_id: null, reason: 'malformed' }]);
});

describe('list/search details beyond the contract', () => {
    test('a zero-duration event is a readable point event, not an unreadable entry', async () => {
        const { backend, deps } = setup();
        backend.scriptQuery(path('work'), [
            resource(card(['DTSTART:20270111T100000Z', 'DURATION:PT0S', 'SUMMARY:point'], 'point'), 'point.ics'),
            resource(card(['DTSTART;VALUE=DATE:20270112', 'DURATION:P0D', 'SUMMARY:day'], 'day'), 'day.ics'),
        ]);
        const result = await listEvents(deps, { range });
        expect(result.unreadableCount).toBe(0);
        expect(result.events.map(event => [event.title, event.duration, event.end])).toEqual([['point', 'PT0S', null], ['day', 'P0D', null]]);
    });

    test('search matches the full parsed text before display truncation, only in the selected fields', async () => {
        const { backend, deps } = setup();
        const longDescription = `${'x'.repeat(500)} needle`;
        backend.scriptQuery(path('work'), [
            resource(card(['DTSTART:20270111T100000Z', 'SUMMARY:Plain', `DESCRIPTION:${longDescription}`], 'a'), 'a.ics'),
            resource(card(['DTSTART:20270112T100000Z', 'SUMMARY:NEEDLE in title'], 'b'), 'b.ics'),
        ]);
        const all = await searchEvents(deps, { range, query: '  Needle ' });
        expect(all.events.map(event => event.title)).toEqual(['Plain', 'NEEDLE in title']);
        expect(all.events[0]?.description_truncated).toBe(true);
        expect(all.events[0]?.description).not.toContain('needle');
        const titleOnly = setup();
        titleOnly.backend.scriptQuery(path('work'), [
            resource(card(['DTSTART:20270111T100000Z', 'SUMMARY:Plain', `DESCRIPTION:${longDescription}`], 'a'), 'a.ics'),
            resource(card(['DTSTART:20270112T100000Z', 'SUMMARY:NEEDLE in title'], 'b'), 'b.ics'),
        ]);
        const result = await searchEvents(titleOnly.deps, { range, query: 'needle', fields: ['title'] });
        expect(result.events.map(event => event.title)).toEqual(['NEEDLE in title']);
    });

    test('a 401 on several calendars reports onUnauthorized exactly once', async () => {
        const { backend, deps, unauthorized } = setup(['a', 'b', 'c'].map(name => calendar(name)));
        for (const name of ['a', 'b', 'c']) { backend.scriptQuery(path(name), new CalDavError('unauthorized')); }
        const result = await listEvents(deps, { range });
        expect(result.calendars.map(item => item.status)).toEqual(['reconnect_required', 'reconnect_required', 'reconnect_required']);
        expect(unauthorized()).toBe(1);
    });

    test('a 401 on membership is reconnect_required for the whole call and is reported once', async () => {
        const { backend, deps, unauthorized } = setup();
        backend.scriptList(new CalDavError('unauthorized'));
        const error = await listEvents(deps, { range }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ReadError);
        expect(error).toMatchObject({ code: 'reconnect_required', message: 'reconnect_required' });
        expect(unauthorized()).toBe(1);
    });

    test('a failing onUnauthorized callback never changes the result', async () => {
        const { backend, deps } = setup();
        deps.onUnauthorized = async () => { throw new Error('recording failed'); };
        backend.scriptQuery(path('work'), new CalDavError('unauthorized'));
        expect((await listEvents(deps, { range })).calendars[0]?.status).toBe('reconnect_required');
    });

    test('calendar display names are sanitized and capped with flags; ids and order are untouched', async () => {
        const { deps } = setup([calendar('work', `Work‮${'n'.repeat(300)}`), calendar('home', null)]);
        const result = await listEvents(deps, { range });
        expect(result.calendars.map(item => item.calendar_id)).toEqual([path('home'), path('work')]);
        expect(result.calendars[0]).toEqual({ calendar_id: path('home'), display_name: null, status: 'ok' });
        expect(result.calendars[1]?.display_name).toHaveLength(256);
        expect(result.calendars[1]?.display_name?.startsWith('Work�')).toBe(true);
        expect(result.calendars[1]).toMatchObject({ display_name_truncated: true, sanitized: true });
    });

    test('a weak or malformed ETag fails that calendar as upstream_error; a 404 calendar is not_found', async () => {
        const { backend, deps } = setup(['a', 'b', 'c'].map(name => calendar(name)));
        backend.scriptQuery(path('a'), [resource(expanded, 'event.ics', 'a', 'W/"weak"')]);
        backend.scriptQuery(path('b'), new CalDavError('not_found'));
        backend.scriptQuery(path('c'), [resource(expanded, 'event.ics', 'c')]);
        const result = await listEvents(deps, { range });
        expect(result.calendars.map(item => item.status)).toEqual(['upstream_error', 'not_found', 'ok']);
        expect(result.events.map(event => event.calendar)).toEqual([2]);
    });

    test('a membership id that is not canonical fails the whole call before dispatch', async () => {
        const { backend, deps } = setup([{ id: '/10000000001/calendars/../x/', displayName: null, components: ['VEVENT'], color: null }]);
        await expect(listEvents(deps, { range })).rejects.toMatchObject({ code: 'upstream_error' });
        expect(backend.count()).toBe(1);
    });

    test('membership collections without VEVENT are not selectable and are not_found when named', async () => {
        const { backend, deps } = setup([calendar('work'), { id: path('tasks'), displayName: 'Tasks', components: ['VTODO'], color: null }]);
        const all = await listEvents(deps, { range });
        expect(all.calendars.map(item => item.calendar_id)).toEqual([path('work')]);
        const named = await listEvents(deps, { range, calendar_ids: [path('tasks')] });
        expect(named.calendars.map(item => item.status)).toEqual(['not_found']);
        expect(backend.count('queryEvents')).toBe(1);
    });

    test('unreadable entries are deduplicated, sorted by calendar and href, capped at 50 with the exact count', async () => {
        const { backend, deps } = setup(['a', 'b'].map(name => calendar(name)));
        const bad = 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n';
        backend.scriptQuery(path('b'), Array.from({ length: 30 }, (_, index) => resource(bad, `${String(index).padStart(2, '0')}.ics`, 'b')).toReversed());
        backend.scriptQuery(path('a'), Array.from({ length: 30 }, (_, index) => resource(bad, `${String(index).padStart(2, '0')}.ics`, 'a')));
        const result = await listEvents(deps, { range });
        expect(result.unreadableCount).toBe(60);
        expect(result.unreadable).toHaveLength(50);
        expect(result.unreadable.slice(0, 30).every(item => item.calendar === 0)).toBe(true);
        expect(result.unreadable.slice(30).map(item => item.resource_href)).toEqual(Array.from({ length: 20 }, (_, index) => `${path('b')}${String(index).padStart(2, '0')}.ics`));
        expect(new Set(result.unreadable.map(item => item.reason))).toEqual(new Set(['malformed']));
    });

    test('a per-resource line cap makes only that resource unreadable, not the calendar', async () => {
        const { backend, deps } = setup();
        const huge = card(['DTSTART:20270111T100000Z', ...Array.from({ length: 50_001 }, (_, index) => `X-FILL-${index}:x`)], 'huge');
        backend.scriptQuery(path('work'), [resource(huge, 'huge.ics'), resource(expanded)]);
        const result = await listEvents(deps, { range });
        expect(result.calendars[0]?.status).toBe('ok');
        expect(result.events).toHaveLength(1);
        expect(result.unreadable).toEqual([{ calendar: 0, resource_href: `${path('work')}huge.ics`, recurrence_id: null, reason: 'resource_too_large' }]);
    });

    test('an expired work budget during a report makes calendars temporarily_unavailable, never ok with partial rows', async () => {
        let clock = 0;
        const { backend, deps } = setup(['a'].map(name => calendar(name)), () => clock);
        backend.scriptQuery(path('a'), () => { clock = 46_000; return [resource(expanded, 'event.ics', 'a')]; });
        const result = await listEvents(deps, { range });
        expect(result.calendars[0]?.status).toBe('temporarily_unavailable');
        expect(result.events).toEqual([]);
    });

    test('every request carries the budget signal, a shared charge and a bounded deadline', async () => {
        const { backend, deps } = setup();
        await listEvents(deps, { range });
        for (const call of backend.calls) {
            expect(call.options?.signal).toBeInstanceOf(AbortSignal);
            expect(typeof call.options?.charge?.chargeBytes).toBe('function');
            expect(call.options?.deadlineMs).toBe(10_000);
        }
    });

    test('a blank search query is invalid_input without any request', async () => {
        const { backend, deps } = setup();
        await expect(searchEvents(deps, { range, query: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(backend.count()).toBe(0);
    });
});

describe('iCloud all-day series: equivalent expanded RECURRENCE-ID forms share one occurrence token', () => {
    const dateForm = 'RECURRENCE-ID;VALUE=DATE:20261218';
    const zForm = 'RECURRENCE-ID:20261218T000000Z';
    const token = 'occ1_20261218T000000Z';
    const dayRange = { start: '2026-12-01T00:00:00Z', end: '2027-01-15T00:00:00Z' };
    const seriesOriginal = (override: boolean): string => `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:synthetic-icloud-f-0006\nDTSTART;VALUE=DATE:20261211\nDTEND;VALUE=DATE:20261212\nRRULE:FREQ=WEEKLY\nSUMMARY:Synthetic weekly all-day\nEND:VEVENT\n${override ? 'BEGIN:VEVENT\nUID:synthetic-icloud-f-0006\nRECURRENCE-ID;VALUE=DATE:20261218\nDTSTART;VALUE=DATE:20261218\nDTEND;VALUE=DATE:20261219\nSUMMARY:Synthetic weekly all-day\nEND:VEVENT\n' : ''}END:VCALENDAR\n`;

    for (const [label, returned] of [['the DATE form', dateForm], ['the Z form', zForm]] as const) {
        for (const override of [false, true]) {
            test(`list then get_event round-trips the DATE-form occurrence when the expanded query returns ${label}${override ? ' (stored override with VALUE=DATE)' : ''}`, async () => {
                const { backend, deps } = setup();
                backend.scriptQuery(path('work'), [resource(allDayDateRid)]);
                const listed = await listEvents(deps, { range: dayRange });
                expect(listed.unreadable).toEqual([]);
                expect(listed.events.map(event => event.recurrence_id)).toEqual(['occ1_20261211T000000Z', token, 'occ1_20261225T000000Z']);
                const picked = listed.events.find(event => event.recurrence_id === token);
                expect<unknown>(picked?.start).toEqual({ date: '2026-12-18', all_day: true });

                const second = setup();
                second.backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(seriesOriginal(override)) }]);
                second.backend.scriptQuery(path('work'), [resource(allDayDateRid.replace(dateForm, returned))]);
                const result = await getEvent(second.deps, { ...getInput, recurrence_id: picked?.recurrence_id });
                expect(result.event.view).toBe('occurrence');
                expect(result.event.recurrence_id).toBe(token);
                expect<unknown>(result.event.start).toEqual({ date: '2026-12-18', all_day: true });
                // Token slot midnight Z plus the one-day master span, padded 24 h; the stored DATE override maps to the same slot.
                expect(second.backend.calls[2]?.range).toEqual({ startUtc: '20261217T000000Z', endUtc: '20261220T000000Z' });
            });
        }
    }

    test('a floating-form expanded RECURRENCE-ID is found by the token of its wall digits', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(seriesOriginal(false)) }]);
        backend.scriptQuery(path('work'), [resource(allDayDateRid.replace(dateForm, 'RECURRENCE-ID:20261218T000000'))]);
        const result = await getEvent(deps, { ...getInput, recurrence_id: token });
        expect(result.event.recurrence_id).toBe(token);
    });
});

describe('get_event details beyond the contract', () => {
    test('a calendar outside membership is not_found after membership only', async () => {
        const { backend, deps } = setup();
        await expect(getEvent(deps, { calendar_id: path('missing'), resource_href: `${path('missing')}event.ics` })).rejects.toMatchObject({ code: 'not_found' });
        expect(backend.count()).toBe(1);
    });

    test('a resource that is not a direct child of the calendar is invalid_input with no request', async () => {
        const { backend, deps } = setup();
        await expect(getEvent(deps, { calendar_id: path('work'), resource_href: `${path('home')}event.ics` })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(backend.count()).toBe(0);
    });

    test('a multiget 401 is reconnect_required and is reported once', async () => {
        const { backend, deps, unauthorized } = setup();
        backend.scriptMultiget(path('work'), new CalDavError('unauthorized'));
        await expect(getEvent(deps, getInput)).rejects.toMatchObject({ code: 'reconnect_required' });
        expect(unauthorized()).toBe(1);
    });

    test('a matching expected_version proceeds; the multiget reply must name the requested href', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(original) }]);
        expect((await getEvent(deps, { ...getInput, expected_version: '"v1"' })).event.expected_version).toBe('"v1"');
        const wrong = setup();
        wrong.backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(original, 'other.ics') }]);
        await expect(getEvent(wrong.deps, getInput)).rejects.toMatchObject({ code: 'upstream_error' });
    });

    test('a single non-recurring event has no occurrences: a token is not_found without a query', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(card(['DTSTART:20270111T100000Z', 'SUMMARY:single'])) }]);
        await expect(getEvent(deps, { ...getInput, recurrence_id: 'occ1_20270111T100000Z' })).rejects.toMatchObject({ code: 'not_found' });
        expect(backend.count('queryEvents')).toBe(0);
        const plain = setup();
        plain.backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(card(['DTSTART:20270111T100000Z', 'SUMMARY:single'])) }]);
        const result = await getEvent(plain.deps, getInput);
        expect([result.event.view, result.event.recurring, result.event.recurrence_id]).toEqual(['single', false, null]);
    });

    test('a detached-only resource with several occurrences needs a token: none is guessed', async () => {
        const { backend, deps } = setup();
        const twoDetached = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:d\nRECURRENCE-ID:20270111T100000Z\nDTSTART:20270111T120000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:d\nRECURRENCE-ID:20270112T100000Z\nDTSTART:20270112T120000Z\nEND:VEVENT\nEND:VCALENDAR\n';
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(twoDetached) }]);
        await expect(getEvent(deps, getInput)).rejects.toMatchObject({ code: 'invalid_input' });
        expect(backend.count()).toBe(2);
    });

    test('a malformed original is unsupported_calendar_data, never a raw parser error', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n') }]);
        const error = await getEvent(deps, getInput).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ReadError);
        expect(error).toMatchObject({ code: 'unsupported_calendar_data' });
    });

    test('attachment metadata is resource-wide from the original, also for an occurrence, with no URL or bytes', async () => {
        for (const token of [null, 'occ1_20270112T100000Z'] as const) {
            const { backend, deps } = setup();
            backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(attachmentsOriginal) }]);
            backend.scriptQuery(path('work'), [resource('BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:synthetic-attachments\nRECURRENCE-ID:20270112T100000Z\nDTSTART:20270112T100000Z\nDTEND:20270112T110000Z\nEND:VEVENT\nEND:VCALENDAR\n')]);
            const result = await getEvent(deps, { ...getInput, recurrence_id: token });
            expect(result.attachments.map(item => item.form)).toEqual(['managed', 'inline', 'inline', 'external_url', 'inline', 'external_url']);
            expect(result.attachments.every(item => !item.download_supported)).toBe(true);
            expect(result.attachments.at(-1)).toMatchObject({ component: 'override', component_recurrence_id: { local: '2027-01-12T05:00:00', zone: 'America/New_York' } });
            const text = JSON.stringify(result.attachments);
            expect(text).not.toContain('https://');
            expect(text).not.toContain('SGk=');
            expect(result.rawIcs).toBeNull();
            expect(result.event.view).toBe(token === null ? 'series_master' : 'occurrence');
        }
    });

    test('an occurrence query with a foreign href fails as upstream_error, not calendar_changed', async () => {
        const { backend, deps } = setup();
        backend.scriptMultiget(path('work'), [{ kind: 'found', resource: resource(original) }]);
        backend.scriptQuery(path('work'), [resource(expanded), resource(expanded, 'event.ics', 'other')]);
        await expect(getEvent(deps, { ...getInput, recurrence_id: 'occ1_20270112T100000Z' })).rejects.toMatchObject({ code: 'upstream_error' });
    });

    test('no time left before the multiget is temporarily_unavailable without sending it', async () => {
        let clock = 0;
        const { backend, deps } = setup([calendar('work')], () => clock);
        backend.scriptList(() => { clock = 45_000; return [calendar('work')]; });
        await expect(getEvent(deps, getInput)).rejects.toMatchObject({ code: 'temporarily_unavailable' });
        expect(backend.count('multigetEvents')).toBe(0);
    });
});
