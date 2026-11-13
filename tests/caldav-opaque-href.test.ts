import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { createServer, type Server } from 'node:net';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { UpstreamCredentials } from '../src/auth/contracts';
import { CalDavError, type CalDavAuth, type Discovery } from '../src/caldav/contracts';
import { createICloudBackend } from '../src/caldav/icloud';
import { isDirectChildResource, resolveServerResourceHref } from '../src/caldav/identifiers';
import { buildMultiget, extractEventReport } from '../src/caldav/reports';
import { createWriteBackend } from '../src/caldav/write';
import { strongEtag, type StrongEtag } from '../src/caldav/write-contracts';
import { buildAttachmentIndex, prescanAttachProperties } from '../src/calendar/attachments';
import { createReadBudget } from '../src/calendar/budget';
import { eventsOutputSchema, unreadableSchema } from '../src/calendar/event-schemas';
import { parseOriginalResource } from '../src/calendar/ical';
import { PATH_MAX } from '../src/calendar/limits';
import { isCanonicalPath, isResourceHref, isResourceName } from '../src/calendar/model';
import { listEvents, type ReadDeps } from '../src/calendar/read';
import { bindCalendarService } from '../src/calendar/service';
import { handleMcp } from '../src/mcp';
import { createFakeFetch, xmlResponse } from './fixtures/caldav/fake-fetch';
import { FakeCalDavRead } from './helpers/fake-caldav-read';
import { FAKE_DISCOVERY, FakeICloud } from './helpers/fake-caldav-write';

// The measured shape (2026-11-13, one real event created from an Apple reminder): the UID is URL-like and iCloud's href
// carries `%3A` and a double-encoded slash `%252F`. Letters, digits and the UUIDs here are synthetic; the punctuation and
// escapes are exactly as measured.
const ORIGIN = 'https://p01-caldav.icloud.com';
const HOME = '/10000000001/calendars/';
const CAL = `${HOME}11111111-2222-4333-8444-555555555555/`;
const OTHER = `${HOME}work/`;
const MEASURED_NAME = 'x-apple-reminderkit%3A%252FSYNTHETICLIST%252F00000000-0000-4000-8000-000000000001.ics';
const MEASURED = `${CAL}${MEASURED_NAME}`;
const MEASURED_UID = 'x-apple-reminderkit://SYNTHETICLIST/00000000-0000-4000-8000-000000000001';
const DISCOVERY: Discovery = { principalUrl: `${ORIGIN}/10000000001/principal/`, calendarHomeUrl: `${ORIGIN}${HOME}` };
const AUTH: CalDavAuth = { appleId: 'synthetic@example.invalid', appPassword: 'synthetic-password' };
const ETAG = strongEtag('"v1"') as StrongEtag;

/** Names accepted as opaque: every escape is kept byte for byte, in its own case. */
const ACCEPTED_NAMES = [
    MEASURED_NAME, 'a%2Fb.ics', 'a%2fb.ics', 'a%252F.ics', 'a%3Ab.ics', 'a%3ab.ics', '..%2F..%2Fother', '..%2F..%2Fother%2Fx.ics', '%2E%2E%2F', '%2e%2e%2fx',
    '%65vent%20%7b1%7d.ics', 'a%25.ics', 'a%2525.ics', "a!$&'()*+,;=:@~-._b.ics", '...', '.ics', 'a.', 'a%FF.ics', '%2E%2E.ics', '%20',
];
/** Names refused: dot segments (also after one case-insensitive decode), escaped controls, bad escapes, and raw characters URL would change or that are not in a URI path. */
const REJECTED_NAMES = [
    '', '.', '..', '%2E%2E', '%2e%2e', '%2E%2e', '.%2E', '%2e.', '%2e', '%2E', '%00', 'a%00.ics', 'a%1F.ics', 'a%1f.ics', 'a%7F.ics', 'a%zz.ics', 'a%2.ics', 'a%', '%',
    'a b.ics', ' a.ics', 'a.ics ', 'a\tb.ics', 'a\nb.ics', 'a\u0000b.ics', 'a\u007Fb.ics', 'café.ics', 'a b.ics', 'a/b.ics', 'a\\b.ics', 'a?b.ics', 'a#b.ics',
    'a{b}.ics', 'a^b.ics', 'a|b.ics', 'a[b].ics', 'a"b.ics', 'a<b>.ics', 'a`b.ics',
];

describe('the resource href rule: a canonical calendar path plus one opaque name', () => {
    for (const name of ACCEPTED_NAMES) {
        test(`accepts ${JSON.stringify(name)} as an opaque name of this calendar`, () => {
            expect(isResourceName(name)).toBe(true);
            expect(isResourceHref(`${CAL}${name}`)).toBe(true);
            expect(isDirectChildResource(CAL, `${CAL}${name}`)).toBe(true);
            // It never becomes a name of another calendar.
            expect(isDirectChildResource(OTHER, `${CAL}${name}`)).toBe(false);
        });
    }
    for (const name of REJECTED_NAMES) {
        test(`rejects ${JSON.stringify(name)}`, () => {
            expect(isResourceName(name)).toBe(false);
            // `a/b.ics` is lexically a name in the collection `<calendar>a/`; it is never a child of this calendar.
            if (name !== 'a/b.ics') { expect(isResourceHref(`${CAL}${name}`)).toBe(false); }
            expect(isDirectChildResource(CAL, `${CAL}${name}`)).toBe(false);
        });
    }
    test('two segments, another calendar, a prefix look-alike, another account and the collection itself are not children', () => {
        for (const href of [`${CAL}nested/a.ics`, `${OTHER}a.ics`, `${CAL.slice(0, -1)}-x/a.ics`, '/10000000002/calendars/11111111-2222-4333-8444-555555555555/a.ics', CAL, CAL.slice(0, -1), `${CAL}../work/a.ics`]) {
            expect<unknown>([href, isDirectChildResource(CAL, href)]).toEqual([href, false]);
        }
    });
    test('the calendar id rule is unchanged: the collection part must itself be canonical', () => {
        expect(isResourceHref('/10000000001/calendars/w%2Fork/a.ics')).toBe(false);
        expect(isResourceHref('/10000000001/calendars/%77ork/a.ics')).toBe(false);
        expect(isResourceHref('/10000000001/calendars/w%2fork/a.ics')).toBe(false);
        expect(isDirectChildResource('/10000000001/calendars/%77ork/', '/10000000001/calendars/%77ork/a.ics')).toBe(false);
        // A calendar id is still the canonical Path, which refuses encoded slashes.
        expect(isCanonicalPath(`${CAL}`)).toBe(true);
        expect(isCanonicalPath(MEASURED)).toBe(false);
    });
    test('the existing length bound applies to the whole href', () => {
        const fill = (length: number) => `${CAL}${'a'.repeat(length - CAL.length)}`;
        expect(isResourceHref(fill(PATH_MAX))).toBe(true);
        expect(isResourceHref(fill(PATH_MAX + 1))).toBe(false);
        expect(isDirectChildResource(CAL, fill(PATH_MAX + 1))).toBe(false);
    });
});

describe('server hrefs resolve to their exact bytes, or are refused', () => {
    const base = `${ORIGIN}${CAL}`;
    const resolve = (href: string) => resolveServerResourceHref(href, base, CAL);
    test('the measured href, as an absolute path, an absolute URL or a relative name, is kept byte for byte', () => {
        for (const href of [MEASURED, `${ORIGIN}${MEASURED}`, MEASURED_NAME, `${ORIGIN}:443${MEASURED}`, `https://P01-CALDAV.icloud.com${MEASURED}`]) {
            expect<unknown>([href, resolve(href)]).toEqual([href, { kind: 'resource', href: MEASURED }]);
        }
        for (const name of ACCEPTED_NAMES) {
            expect<unknown>([name, resolve(`${CAL}${name}`)]).toEqual([name, { kind: 'resource', href: `${CAL}${name}` }]);
        }
    });
    test('a name of this calendar that the rule refuses is attributable to its own response', () => {
        for (const name of ['a%zz.ics', 'a b.ics', 'a{b}.ics', 'café.ics', 'a%00.ics', 'a.ics?x=1', 'a#b', 'a|b.ics', 'a\tb.ics']) {
            expect<unknown>([name, resolve(`${CAL}${name}`)]).toEqual([name, { kind: 'unsupported_name' }]);
        }
        expect(resolve(`${CAL}${'a'.repeat(PATH_MAX)}`)).toEqual({ kind: 'unsupported_name' });
    });
    for (const href of [
        `https://p02-caldav.icloud.com${MEASURED}`, `http://p01-caldav.icloud.com${MEASURED}`, `https://user@p01-caldav.icloud.com${MEASURED}`, `https://user:pw@p01-caldav.icloud.com${MEASURED}`,
        `//p01-caldav.icloud.com${MEASURED}`, `\\\\p01-caldav.icloud.com${MEASURED}`, `${OTHER}a.ics`, `/10000000002/calendars/11111111-2222-4333-8444-555555555555/a.ics`,
        `${CAL}nested/a.ics`, `${CAL}../work/a.ics`, '../work/a.ics', `${CAL}%2E%2E`, `${CAL}%2e`, `${CAL}.`, `${CAL}..`, `${CAL}%2e%2e?x`, CAL, CAL.slice(0, -1), `${CAL}a\\b.ics`,
        `${ORIGIN}`, 'mailto:a@example.test', 'https://p01-caldav.icloud.com?x', '',
    ]) {
        test(`refuses ${JSON.stringify(href)} as outside the calendar: the whole answer fails`, () => {
            expect(() => resolve(href)).toThrow(new CalDavError('protocol'));
        });
    }
});

const CARD = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Synthetic//EN\nBEGIN:VEVENT\nUID:${MEASURED_UID}\nDTSTART:20270111T100000Z\nDTEND:20270111T110000Z\nSUMMARY:Synthetic reminder\nEND:VEVENT\nEND:VCALENDAR\n`;
const xmlText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const response = (href: string, etag = '"v1"', data = CARD) => `<D:response><D:href>${xmlText(href)}</D:href><D:propstat><D:prop><D:getetag>${etag}</D:getetag><C:calendar-data><![CDATA[${data}]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const multistatus = (...responses: string[]) => `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses.join('')}</D:multistatus>`;
const context = { calendarId: CAL, homeUrl: `${ORIGIN}${HOME}`, requestUrl: `${ORIGIN}${CAL}` };
const resource = { href: MEASURED, etag: '"v1"', calendarData: CARD };

describe('REPORT extraction keeps the href opaque and isolates one bad response', () => {
    test('the measured shape is one resource with its href exactly as iCloud sent it', () => {
        expect(extractEventReport(multistatus(response(MEASURED)), context)).toEqual([resource]);
        expect(extractEventReport(multistatus(response(`${ORIGIN}${MEASURED}`)), context)).toEqual([resource]);
        expect(extractEventReport(multistatus(response(MEASURED)), { ...context, requestedHrefs: [MEASURED] })).toEqual([resource]);
    });
    test('one response with an unsupported name is one unaddressable entry; the others are kept, in order', () => {
        const xml = multistatus(response(`${CAL}a{b}.ics`, '"v2"'), response(MEASURED), response(`${CAL}café.ics`, '"v3"'));
        expect<unknown>(extractEventReport(xml, context)).toEqual([{ unaddressable: true }, resource, { unaddressable: true }]);
    });
    test('the bad response still has to be well formed: its own defects stay whole-answer failures', () => {
        expect(() => extractEventReport(multistatus(response(`${CAL}a{b}.ics`, 'W/"weak"'), response(MEASURED)), context)).toThrow(new CalDavError('protocol'));
        const twoHrefs = `<D:response><D:href>${CAL}a{b}.ics</D:href><D:href>${MEASURED}</D:href><D:status>HTTP/1.1 200 OK</D:status></D:response>`;
        expect(() => extractEventReport(multistatus(twoHrefs), context)).toThrow(new CalDavError('protocol'));
        const failed = `<D:response><D:href>${CAL}a{b}.ics</D:href><D:status>HTTP/1.1 503 Unavailable</D:status></D:response>`;
        expect(() => extractEventReport(multistatus(failed, response(MEASURED)), context)).toThrow(new CalDavError('temporary'));
    });
    test('the same unsupported href twice cannot be attributed to one response', () => {
        expect(() => extractEventReport(multistatus(response(`${CAL}a{b}.ics`), response(`${CAL}a{b}.ics`)), context)).toThrow(new CalDavError('protocol'));
        expect(() => extractEventReport(multistatus(response(MEASURED), response(MEASURED)), context)).toThrow(new CalDavError('protocol'));
    });
    test('an href outside the calendar, malformed XML, a wrong root and a truncation marker still fail the whole calendar', () => {
        for (const href of [`${OTHER}a.ics`, `${CAL}nested/a.ics`, `https://p02-caldav.icloud.com${MEASURED}`, `${CAL}%2E%2E`]) {
            expect(() => extractEventReport(multistatus(response(MEASURED), response(href)), context)).toThrow(new CalDavError('protocol'));
        }
        expect(() => extractEventReport(multistatus(response(MEASURED)).replace('</D:response>', '</D:broken>'), context)).toThrow(new CalDavError('protocol'));
        expect(() => extractEventReport(multistatus(response(MEASURED)).replaceAll('D:multistatus', 'D:prop'), context)).toThrow(new CalDavError('protocol'));
        const truncated = multistatus(response(MEASURED), `<D:response><D:href>${CAL}</D:href><D:status>HTTP/1.1 507 Insufficient Storage</D:status><D:error><D:number-of-matches-within-limits/></D:error></D:response>`);
        expect(() => extractEventReport(truncated, context)).toThrow(expect.objectContaining({ code: 'too_large' }));
    });
    test('a multiget answer must name exactly the hrefs asked for, byte for byte', () => {
        for (const answered of [`${CAL}a{b}.ics`, `${CAL}x-apple-reminderkit%3a%252FSYNTHETICLIST%252F00000000-0000-4000-8000-000000000001.ics`, `${CAL}x-apple-reminderkit%3A%2FSYNTHETICLIST%2F00000000-0000-4000-8000-000000000001.ics`]) {
            expect(() => extractEventReport(multistatus(response(answered)), { ...context, requestedHrefs: [MEASURED] })).toThrow(new CalDavError('protocol'));
        }
    });
    test('the multiget body carries the href with XML escaping only', () => {
        const body = buildMultiget([MEASURED, `${CAL}a&b'%2F.ics`]);
        expect(body).toContain(`<d:href>${MEASURED}</d:href>`);
        expect(body).toContain(`<d:href>${CAL}a&amp;b&apos;%2F.ics</d:href>`);
        for (const name of ['%2E%2E', 'a{b}.ics', 'a%zz.ics', '']) { expect(() => buildMultiget([`${CAL}${name}`])).toThrow(new CalDavError('protocol')); }
    });
});

describe('the iCloud backend sends the href byte for byte', () => {
    test('query and multiget: the request goes to the calendar, the href is in the body unchanged, the answer keeps it', async () => {
        const calendarUrl = `${ORIGIN}${CAL}`;
        const fake = createFakeFetch({ [calendarUrl]: request => xmlResponse(request.body?.includes('calendar-multiget') === true
            ? multistatus(response(MEASURED))
            : multistatus(response(MEASURED), response(`${CAL}a b.ics`, '"v2"'))) });
        const backend = createICloudBackend({ fetch: fake.fetch });
        expect<unknown>(await backend.queryEvents(AUTH, DISCOVERY, { calendarId: CAL, range: { startUtc: '20270101T000000Z', endUtc: '20270201T000000Z' } }))
            .toEqual([resource, { unaddressable: true }]);
        expect<unknown>(await backend.multigetEvents(AUTH, DISCOVERY, { calendarId: CAL, hrefs: [MEASURED] })).toEqual([{ kind: 'found', resource }]);
        expect(fake.calls.map(call => call.url)).toEqual([calendarUrl, calendarUrl]);
        expect(fake.calls[1]?.body).toContain(`<d:href>${MEASURED}</d:href>`);
    });

    const writer = (status = 204) => {
        const fake = createFakeFetch();
        const backend = createWriteBackend({ fetch: async (input, init) => { await fake.fetch(input, init); return new Response(null, { status, headers: { etag: '"v2"' } }); }, authorization: () => 'Basic c3ludGhldGlj' });
        return { fake, backend };
    };
    for (const name of [MEASURED_NAME, '..%2F..%2Fother', '..%2F..%2Fother%2Fx.ics', 'a%2fb.ics', 'a%2Fb.ics', '%65vent%7b1%7d.ics', 'a%3Ab%3ac.ics']) {
        test(`PUT and DELETE of ${name} go to exactly that URL, never decoded or re-encoded`, async () => {
            const { fake, backend } = writer();
            const href = `${CAL}${name}`;
            expect(await backend.putEvent(AUTH, DISCOVERY, { calendarId: CAL, href, body: CARD, precondition: { kind: 'match', etag: ETAG } })).toMatchObject({ kind: 'status', status: 204 });
            expect(await backend.deleteEvent(AUTH, DISCOVERY, { calendarId: CAL, href, etag: ETAG })).toMatchObject({ kind: 'status', status: 204 });
            expect(fake.calls.map(call => [call.method, call.url, call.headers['if-match']])).toEqual([['PUT', `${ORIGIN}${href}`, '"v1"'], ['DELETE', `${ORIGIN}${href}`, '"v1"']]);
            expect(new URL(fake.calls[0]?.url ?? '').pathname).toBe(href);
        });
    }
    test('a write to a refused name, another calendar or a nested path is never sent', async () => {
        const { fake, backend } = writer();
        const cases: [string, string][] = [
            ...['%2E%2E', '%2e', '..', 'a{b}.ics', 'a%zz.ics', 'a/b.ics', 'a b.ics', 'a%00.ics'].map((name): [string, string] => [CAL, `${CAL}${name}`]),
            [CAL, `${OTHER}a.ics`], [OTHER, MEASURED], [CAL, CAL], [`${HOME}a/b/`, `${HOME}a/b/c.ics`],
        ];
        for (const [calendarId, href] of cases) {
            await expect(backend.putEvent(AUTH, DISCOVERY, { calendarId, href, body: CARD, precondition: { kind: 'match', etag: ETAG } })).rejects.toEqual(new CalDavError('protocol'));
            await expect(backend.deleteEvent(AUTH, DISCOVERY, { calendarId, href, etag: ETAG })).rejects.toEqual(new CalDavError('protocol'));
        }
        expect(fake.calls).toHaveLength(0);
    });
    test('a write answered with a redirect is not followed', async () => {
        const fake = createFakeFetch();
        const backend = createWriteBackend({ fetch: async (input, init) => { await fake.fetch(input, init); return new Response(null, { status: 307, headers: { location: `${ORIGIN}${OTHER}a.ics` } }); }, authorization: () => 'Basic c3ludGhldGlj' });
        expect(await backend.deleteEvent(AUTH, DISCOVERY, { calendarId: CAL, href: MEASURED, etag: ETAG })).toEqual({ kind: 'redirected', status: 307 });
        expect(fake.calls.map(call => call.url)).toEqual([`${ORIGIN}${MEASURED}`]);
    });
});

describe('the bytes on the wire (Bun fetch, loopback only)', () => {
    let server: Server;
    let port = 0;
    const lines: string[] = [];
    const bodies: string[] = [];
    beforeEach(async () => {
        lines.length = 0;
        bodies.length = 0;
        server = createServer(socket => {
            let buffer = '';
            socket.on('data', chunk => {
                buffer += chunk.toString('latin1');
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) { return; }
                const length = Number(/\r\ncontent-length:\s*(\d+)/iu.exec(buffer.slice(0, end))?.[1] ?? '0');
                if (buffer.length < end + 4 + length) { return; }
                lines.push(buffer.slice(0, buffer.indexOf('\r\n')));
                const body = buffer.slice(end + 4, end + 4 + length);
                bodies.push(body);
                const reply = body.includes('calendar-multiget') ? multistatus(response(MEASURED)) : '';
                socket.end(`HTTP/1.1 ${reply === '' ? '204 No Content' : '207 Multi-Status'}\r\nETag: "v2"\r\nContent-Type: application/xml\r\nContent-Length: ${Buffer.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        port = typeof address === 'object' && address !== null ? address.port : 0;
    });
    afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
    /** The real global fetch, with only the iCloud origin swapped for the loopback server by plain string replacement. */
    const loopback = (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(String(input).replace(ORIGIN, `http://127.0.0.1:${port}`), init);

    test('PUT, DELETE and multiget carry the measured href and an encoded-slash traversal name unchanged', async () => {
        const backend = createICloudBackend({ fetch: loopback });
        const traversal = `${CAL}..%2F..%2Fother%2Fx.ics`;
        for (const href of [MEASURED, traversal]) {
            expect(await backend.putEvent(AUTH, DISCOVERY, { calendarId: CAL, href, body: CARD, precondition: { kind: 'match', etag: ETAG } })).toMatchObject({ status: 204 });
            expect(await backend.deleteEvent(AUTH, DISCOVERY, { calendarId: CAL, href, etag: ETAG })).toMatchObject({ status: 204 });
        }
        expect<unknown>(await backend.multigetEvents(AUTH, DISCOVERY, { calendarId: CAL, hrefs: [MEASURED] })).toEqual([{ kind: 'found', resource }]);
        expect(lines).toEqual([`PUT ${MEASURED} HTTP/1.1`, `DELETE ${MEASURED} HTTP/1.1`, `PUT ${traversal} HTTP/1.1`, `DELETE ${traversal} HTTP/1.1`, `REPORT ${CAL} HTTP/1.1`]);
        expect(bodies[4]).toContain(`<d:href>${MEASURED}</d:href>`);
    });
});

describe('the measured shape end to end through the MCP tools, on the in-memory iCloud', () => {
    let warn: Mock<(...args: unknown[]) => void>;
    beforeEach(() => { warn = spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warn.mockRestore(); });
    const credentials: UpstreamCredentials = { accountId: 'C'.repeat(43), appleId: 'synthetic@example.invalid', appPassword: 'synthetic-pass', ...FAKE_DISCOVERY, issuedAt: 1000 };
    const ORIGINAL = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic//EN', 'BEGIN:VEVENT', `UID:${MEASURED_UID}`, 'DTSTAMP:20261101T120000Z', 'SEQUENCE:0', 'DTSTART:20270111T150000Z', 'DTEND:20270111T160000Z', 'SUMMARY:Synthetic reminder', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const ALL = ['calendar:read', 'calendar:write', 'calendar:delete'];
    const range = { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' };

    function harness() {
        const fake = new FakeICloud([CAL, OTHER]);
        const service = bindCalendarService({ caldav: fake, connectionStatus: 'active', credentials: () => credentials, markReconnectRequired: async () => true, now: () => Date.UTC(2026, 10, 13, 9) });
        const call = async (name: string, args: unknown) => {
            const authInfo: AuthInfo = { token: 'synthetic', clientId: 'test', scopes: ALL };
            const reply = await handleMcp(new Request('https://service.example/mcp', {
                method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
            }), authInfo, service);
            return (await reply.json()).result as { isError?: boolean; structuredContent: Record<string, unknown> & { error?: { code: string } } };
        };
        return { fake, call };
    }

    test('list, search, get, update and delete address the stored resource by its exact href', async () => {
        const h = harness();
        h.fake.seed(CAL, MEASURED, ORIGINAL);
        const listed = await h.call('list_events', { calendar_ids: [CAL], range });
        const events = listed.structuredContent['events'] as { resource_href: string; expected_version: string; title: string }[];
        expect<unknown>([listed.isError, listed.structuredContent['complete'], events.map(event => [event.resource_href, event.title])]).toEqual([undefined, true, [[MEASURED, 'Synthetic reminder']]]);
        const searched = await h.call('search_events', { calendar_ids: [CAL], range, query: 'reminder' });
        expect((searched.structuredContent['events'] as { resource_href: string }[]).map(event => event.resource_href)).toEqual([MEASURED]);
        const got = await h.call('get_event', { calendar_id: CAL, resource_href: MEASURED });
        expect<unknown>([got.isError, (got.structuredContent['event'] as { uid: string; resource_href: string }).resource_href, (got.structuredContent['event'] as { uid: string }).uid]).toEqual([undefined, MEASURED, MEASURED_UID]);
        const updated = await h.call('update_event', { calendar_id: CAL, resource_href: MEASURED, expected_version: events[0]?.expected_version, changes: { title: 'Renamed' } });
        expect<unknown>([updated.isError, updated.structuredContent['write_outcome'], updated.structuredContent['resource_href']]).toEqual([undefined, 'applied', MEASURED]);
        expect(h.fake.hrefs(CAL)).toEqual([MEASURED]);
        expect(h.fake.get(CAL, MEASURED)?.text).toContain('SUMMARY:Renamed');
        const deleted = await h.call('delete_event', { calendar_id: CAL, resource_href: MEASURED, expected_version: updated.structuredContent['expected_version'] });
        expect<unknown>([deleted.isError, deleted.structuredContent['write_outcome'], deleted.structuredContent['resource_href']]).toEqual([undefined, 'applied', MEASURED]);
        expect(h.fake.hrefs(CAL)).toEqual([]);
        const writes = h.fake.calls.filter(call => call.method === 'putEvent' || call.method === 'deleteEvent' || call.method === 'multigetEvents');
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.every(call => call.calendarId === CAL && (call.href === undefined || call.href === MEASURED))).toBe(true);
    });

    test('a different spelling of the same name is a different, absent resource; nothing is decoded to find it', async () => {
        const h = harness();
        h.fake.seed(CAL, MEASURED, ORIGINAL);
        for (const href of [MEASURED.replace('%3A', '%3a'), MEASURED.replaceAll('%252F', '%2F'), MEASURED.replace('%3A', ':')]) {
            const got = await h.call('get_event', { calendar_id: CAL, resource_href: href });
            expect<unknown>([href, got.structuredContent.error?.code]).toEqual([href, 'not_found']);
        }
    });

    test('a refused href from a client is invalid input, with no upstream request', async () => {
        const h = harness();
        for (const href of [`${CAL}%2E%2E`, `${CAL}..`, `${CAL}a/b.ics`, `${OTHER}a.ics`, `${CAL}a%zz.ics`, `${CAL}a b.ics`, `${CAL}a{b}.ics`, `${CAL}café.ics`, CAL]) {
            for (const [name, args] of [
                ['get_event', { calendar_id: CAL, resource_href: href }],
                ['update_event', { calendar_id: CAL, resource_href: href, expected_version: '"v1"', changes: { title: 'x' } }],
                ['delete_event', { calendar_id: CAL, resource_href: href, expected_version: '"v1"' }],
            ] as const) {
                const result = await h.call(name, args);
                expect<unknown>([name, href, result.isError, result.structuredContent.error?.code]).toEqual([name, href, true, 'invalid_input']);
            }
        }
        expect(h.fake.calls).toEqual([]);
    });
});

describe('one unaddressable resource does not fail its calendar', () => {
    test('the rest of the calendar is listed; the bad one is counted with no href', async () => {
        const backend = new FakeCalDavRead().setCalendars([{ id: CAL, displayName: 'Reminders', components: ['VEVENT'], color: null }]);
        backend.scriptQuery(CAL, [resource, { unaddressable: true }, { unaddressable: true }]);
        const deps: ReadDeps = {
            backend, auth: AUTH, discovery: FAKE_DISCOVERY, accountId: 'synthetic-account', budget: createReadBudget({ now: () => 0, yieldFn: async () => {} }),
        };
        const result = await listEvents(deps, { range: { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' } });
        expect(result.calendars.map(calendar => calendar.status)).toEqual(['ok']);
        expect(result.events.map(event => event.resource_href)).toEqual([MEASURED]);
        const entry = { calendar: 0, resource_href: null, recurrence_id: null, reason: 'unsupported_resource_address' as const };
        expect<unknown>(result.unreadable).toEqual([entry, entry]);
        expect(result.unreadableCount).toBe(2);
        expect(unreadableSchema.parse(entry)).toEqual(entry);
    });
    test('the output schema ties a null href to its reason', () => {
        expect(() => unreadableSchema.parse({ calendar: 0, resource_href: null, recurrence_id: null, reason: 'malformed' })).toThrow();
        expect(() => unreadableSchema.parse({ calendar: 0, resource_href: MEASURED, recurrence_id: null, reason: 'unsupported_resource_address' })).toThrow();
        expect(unreadableSchema.parse({ calendar: 0, resource_href: MEASURED, recurrence_id: null, reason: 'malformed' }).resource_href).toBe(MEASURED);
        expect(eventsOutputSchema.shape.unreadable).toBeDefined();
    });
    test('unaddressable entries sort after named ones of the same calendar', async () => {
        const backend = new FakeCalDavRead().setCalendars([{ id: CAL, displayName: null, components: ['VEVENT'], color: null }]);
        backend.scriptQuery(CAL, [{ unaddressable: true }, { href: `${CAL}z.ics`, etag: '"v9"', calendarData: 'not a calendar' }]);
        const deps: ReadDeps = { backend, auth: AUTH, discovery: FAKE_DISCOVERY, accountId: 'synthetic-account', budget: createReadBudget({ now: () => 0, yieldFn: async () => {} }) };
        const result = await listEvents(deps, { range: { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' } });
        expect(result.unreadable.map(item => [item.resource_href, item.reason])).toEqual([[`${CAL}z.ics`, 'malformed'], [null, 'unsupported_resource_address']]);
    });
});

describe('values derived from an href', () => {
    test('attachment refs of differently escaped hrefs never collide', async () => {
        const ics = await Bun.file(new URL('./fixtures/calendar/attachments/original.ics', import.meta.url)).text();
        const refs = ['a%2Fb.ics', 'a%2fb.ics', 'a%252Fb.ics', 'a%3Ab.ics', 'a:b.ics', '..%2F..%2Fother'].map(name => buildAttachmentIndex({
            accountId: 'synthetic-account', calendarId: CAL, href: `${CAL}${name}`, resource: parseOriginalResource(ics, {}), prescan: prescanAttachProperties(ics),
        }).map(entry => entry.ref));
        const all = refs.flat();
        expect(all.length).toBeGreaterThan(refs.length);
        expect(new Set(all).size).toBe(all.length);
        for (const ref of all) { expect(ref).toMatch(/^a1_[A-Za-z0-9_-]{43}$/u); }
    });
});
