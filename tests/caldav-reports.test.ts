import { describe, expect, test } from 'bun:test';
import { CalDavError } from '../src/caldav/contracts';
import { createICloudBackend } from '../src/caldav/icloud';
import { buildExpandedQuery, buildMultiget, extractEventReport } from '../src/caldav/reports';
import { BudgetError } from '../src/calendar/model';
import { parseXml } from '../src/caldav/xml';
import { createFakeFetch, redirectResponse, xmlResponse } from './fixtures/caldav/fake-fetch';
import expected from './fixtures/calendar/transport/expected.json';

const xml = await Bun.file(new URL('./fixtures/calendar/transport/report.xml', import.meta.url)).text();
const calendarId = '/10000000001/calendars/work/';
const homeUrl = 'https://p01-caldav.icloud.com/10000000001/calendars/';
const url = `https://p01-caldav.icloud.com${calendarId}`;
const auth = { appleId: 'synthetic@example.invalid', appPassword: 'synthetic-password' };
const discovery = { principalUrl: 'https://p01-caldav.icloud.com/10000000001/principal/', calendarHomeUrl: homeUrl };
const query = { calendarId, range: expected.transport_range };
const context = { calendarId, homeUrl, requestUrl: url };

test('the probe dynamic source loader still resolves the unchanged backend factory', async () => {
    const { loadBackendFromSource } = await import('../scripts/probe/backend-loader');
    const loaded = await loadBackendFromSource();
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') { throw new Error('source loader failed'); }
    expect(loaded.module['createICloudBackend']).toBe(createICloudBackend);
});

describe('iCloud read REPORT integration', () => {
    test('one expanded REPORT and one batched original multiget preserve headers and wire bodies', async () => {
        const fake = createFakeFetch({ [url]: () => xmlResponse(xml) });
        const backend = createICloudBackend({ fetch: fake.fetch });
        let charged = 0;
        const options = { charge: { chargeBytes(bytes: number) { charged += bytes; } } };
        expect(await backend.queryEvents(auth, discovery, query, options)).toEqual([expected.resource]);
        expect(await backend.multigetEvents(auth, discovery, { calendarId, hrefs: [expected.resource.href] }, options))
            .toEqual([{ kind: 'found', resource: expected.resource }]);
        expect(fake.calls).toHaveLength(2);
        expect(fake.calls.map((call) => call.body)).toEqual([buildExpandedQuery(query.range), buildMultiget([expected.resource.href])]);
        for (const call of fake.calls) {
            expect(call.method).toBe('REPORT');
            expect(call.headers.depth).toBe('1');
            expect(call.headers['content-type']).toBe('application/xml; charset=utf-8');
            expect(call.headers.accept).toBe('application/xml, text/xml');
            expect(call.headers.authorization).toBe(`Basic ${Buffer.from(`${auth.appleId}:${auth.appPassword}`).toString('base64')}`);
            expect(call.redirect).toBe('manual');
        }
        expect(charged).toBe(2 * Buffer.byteLength(xml));
    });

    for (const [label, response, code] of [
        ['303 method rewrite', () => redirectResponse(url, 303), 'protocol'],
        ['foreign host redirect', () => redirectResponse('https://evil.example/collect', 307), 'forbidden_host'],
        ['foreign account redirect', () => redirectResponse('https://p01-caldav.icloud.com/999/calendars/work/', 307), 'protocol'],
        ['foreign allowed host redirect', () => redirectResponse(`https://p02-caldav.icloud.com${calendarId}`, 307), 'protocol'],
        ['malformed UTF-8', () => new Response(new Uint8Array([0xC3, 0x28]), { status: 207 }), 'protocol'],
        ['507', () => xmlResponse('', 507), 'too_large'],
        ['401', () => xmlResponse('', 401), 'unauthorized'],
        ['404', () => xmlResponse('', 404), 'not_found'],
        ['403', () => xmlResponse('', 403), 'temporary'],
        ['over-cap streamed response', () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { status: 207 }), 'too_large'],
    ] as const) {
        test(`${label} fails with a sanitized code and no follow-up request`, async () => {
            const fake = createFakeFetch({ [url]: response });
            await expect(createICloudBackend({ fetch: fake.fetch }).queryEvents(auth, discovery, query))
                .rejects.toEqual(new CalDavError(code));
            expect(fake.calls).toHaveLength(1);
        });
    }

    test('an allowed same-collection 307 preserves the final REPORT method and replayed body', async () => {
        const target = 'https://p01-caldav.icloud.com/10000000001/calendars/%77ork/';
        const fake = createFakeFetch({ [url]: () => redirectResponse(target, 307), [target]: () => xmlResponse(xml) });
        expect(await createICloudBackend({ fetch: fake.fetch }).queryEvents(auth, discovery, query)).toEqual([expected.resource]);
        expect(fake.calls).toHaveLength(2);
        expect(fake.calls[1]?.method).toBe('REPORT');
        expect(fake.calls[1]?.body).toBe(fake.calls[0]?.body ?? '');
    });

    test('redirect retains REPORT and body within the selected collection', async () => {
        const target = `${url}./`;
        const fake = createFakeFetch({ [url]: () => redirectResponse(target, 307) });
        // A normalized redirect still reaches the same selected collection; refuse traversal spellings.
        await expect(createICloudBackend({ fetch: fake.fetch }).queryEvents(auth, discovery, query)).rejects.toEqual(new CalDavError('protocol'));
        expect(fake.calls).toHaveLength(1);
    });

    test('a response above the membership cap but below the REPORT cap is accepted', async () => {
        const largeXml = xml.replace('SUMMARY:A & B', `SUMMARY:${'a'.repeat(1024 * 1024)}`);
        const fake = createFakeFetch({ [url]: () => xmlResponse(largeXml) });
        expect(await createICloudBackend({ fetch: fake.fetch }).queryEvents(auth, discovery, query)).toHaveLength(1);
    });

    test('charges a rejected chunk and preserves shared BudgetError without remapping', async () => {
        const error = new BudgetError('aggregate_bytes');
        let charged = 0;
        let cancelled = false;
        const fake = createFakeFetch({ [url]: () => new Response(new ReadableStream<Uint8Array>({
            pull(controller) { controller.enqueue(new Uint8Array(32)); },
            cancel() { cancelled = true; },
        }), { status: 207 }) });
        await expect(createICloudBackend({ fetch: fake.fetch }).queryEvents(auth, discovery, query, {
            charge: { chargeBytes(bytes) { charged += bytes; throw error; } },
        })).rejects.toBe(error);
        expect(charged).toBe(32);
        expect(cancelled).toBe(true);
    });

    test('multiget maps explicit 404 replies to not_found and refuses missing replies', async () => {
        const missing = `${calendarId}missing.ics`;
        const body = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${missing}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>`;
        const fake = createFakeFetch({ [url]: () => xmlResponse(body) });
        const backend = createICloudBackend({ fetch: fake.fetch });
        expect(await backend.multigetEvents(auth, discovery, { calendarId, hrefs: [missing] })).toEqual([{ kind: 'not_found', href: missing }]);
        await expect(backend.multigetEvents(auth, discovery, { calendarId, hrefs: [expected.resource.href] })).rejects.toEqual(new CalDavError('protocol'));
    });

    test('a home stored without a trailing slash still supports event reads', async () => {
        const fake = createFakeFetch({ [url]: () => xmlResponse(xml) });
        expect(await createICloudBackend({ fetch: fake.fetch }).queryEvents(auth, { ...discovery, calendarHomeUrl: homeUrl.slice(0, -1) }, query)).toEqual([expected.resource]);
    });

    test('expired request deadlines send nothing and map to temporary', async () => {
        const fake = createFakeFetch();
        await expect(createICloudBackend({ fetch: fake.fetch }).queryEvents(auth, discovery, query, { deadlineMs: 0 }))
            .rejects.toEqual(new CalDavError('temporary'));
        expect(fake.calls).toHaveLength(0);
    });

    test('membership is canonical, charged, capped, and refuses partial/507 results', async () => {
        const body = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/10000000001/calendars/%77ork%20%7b1%7d/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
        let bytes = 0;
        const fake = createFakeFetch({ [homeUrl]: () => xmlResponse(body) });
        const calendars = await createICloudBackend({ fetch: fake.fetch }).listCalendars(auth, discovery, { charge: { chargeBytes(count) { bytes += count; } } });
        expect(calendars[0]?.id).toBe('/10000000001/calendars/work%20%7B1%7D/');
        expect(bytes).toBe(Buffer.byteLength(body));
        for (const invalid of [
            xmlResponse(body.replace('</d:multistatus>', '<d:error><d:number-of-matches-within-limits/></d:error></d:multistatus>')),
            xmlResponse(body.replace('HTTP/1.1 200 OK', 'HTTP/1.1 507 Insufficient Storage')),
            xmlResponse('x'.repeat(1024 * 1024 + 1)),
        ]) {
            const upstream = createFakeFetch({ [homeUrl]: () => invalid });
            await expect(createICloudBackend({ fetch: upstream.fetch }).listCalendars(auth, discovery)).rejects.toEqual(new CalDavError('too_large'));
        }
    });

    test('invalid collection and multiget scopes fail before dispatch', async () => {
        const fake = createFakeFetch();
        const backend = createICloudBackend({ fetch: fake.fetch });
        await expect(backend.queryEvents(auth, discovery, { ...query, calendarId: '/999/calendars/work/' })).rejects.toEqual(new CalDavError('protocol'));
        await expect(backend.multigetEvents(auth, discovery, { calendarId, hrefs: ['/10000000001/calendars/other/a.ics'] })).rejects.toEqual(new CalDavError('protocol'));
        expect(fake.calls).toHaveLength(0);
    });
});

test('REPORT extraction rejects ETags that are not strong quoted tags', () => {
    for (const etag of ['W/&quot;weak&quot;', 'unquoted', '*', '&quot;embedded&quot;quote&quot;', '&quot;space here&quot;']) {
        const body = xml.replace(/(<D:getetag>)[\s\S]*?(<\/D:getetag>)/u, `$1${etag}$2`);
        expect(() => extractEventReport(body, context)).toThrow(new CalDavError('protocol'));
    }
});

describe('strict event report additions', () => {
    for (const body of [
        xml.replace('</D:response>', '<D:unexpected/></D:response>'),
        xml.replace('</D:propstat>', '<D:prop/></D:propstat>'),
        xml.replace('</D:multistatus>', '<unexpected/></D:multistatus>'),
        xml.replace('</D:prop>', '<D:displayname>unexpected</D:displayname></D:prop>'),
        xml.replace('<D:href>', '<D:href extra="unexpected">'),
        xml.replace('</D:response>', '<D:responsedescription><unexpected/></D:responsedescription></D:response>'),
        xml.replace('</D:multistatus>', '<D:responsedescription><unexpected/></D:responsedescription></D:multistatus>'),
        xml.replace('</D:response>', '<D:responsedescription>first</D:responsedescription><D:responsedescription>second</D:responsedescription></D:response>'),
    ]) {
        test('unexpected structure is not ignored', () => {
            expect(() => extractEventReport(body, context)).toThrow(new CalDavError('protocol'));
        });
    }
    test('REPORT keeps its own XML element profile and overflow classification', () => {
        const many = `<d:multistatus xmlns:d="DAV:">${'<d:response><d:href>/10000000001/calendars/work/a.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>'.repeat(17_000)}</d:multistatus>`;
        expect(() => parseXml(many)).toThrow(new CalDavError('protocol'));
        expect(parseXml(many, 'report').children).toHaveLength(17_000);
        const deep = `<d:multistatus xmlns:d="DAV:">${'<d:x>'.repeat(70)}${'</d:x>'.repeat(70)}</d:multistatus>`;
        expect(() => extractEventReport(deep, context)).toThrow(new CalDavError('too_large'));
    });
    test('builder enforces ordered real dates and the multiget byte cap', () => {
        expect(() => buildExpandedQuery({ startUtc: '20270112T000000Z', endUtc: '20270111T000000Z' })).toThrow(new CalDavError('protocol'));
        expect(() => buildMultiget(Array.from({ length: 50 }, (_, i) => `${calendarId}${i}${'&'.repeat(2000)}.ics`))).toThrow(new CalDavError('protocol'));
    });
});
