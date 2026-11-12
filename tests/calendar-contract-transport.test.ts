import { describe, expect, test } from 'bun:test';
import { CalDavError } from '../src/caldav/contracts';
import { canonicalizeCalendarPath, canonicalizeServerHref, isDirectChildResource } from '../src/caldav/identifiers';
import { buildExpandedQuery, buildMultiget, extractEventReport } from '../src/caldav/reports';
import { isCanonicalPath } from '../src/calendar/model';
import { MAX_RESOURCES_PER_REPORT, RESOURCE_ENVELOPE_LOWER_BOUND } from '../src/calendar/limits';
import expected from './fixtures/calendar/transport/expected.json';

const root = new URL('./fixtures/calendar/transport/', import.meta.url);
const xml = await Bun.file(new URL('report.xml', root)).text();
const calendarId = '/10000000001/calendars/work/';
const base = `https://p01-caldav.icloud.com${calendarId}`;
const context = { calendarId, requestUrl: base, homeUrl: 'https://p01-caldav.icloud.com/10000000001/calendars/' };
const rawHref = '/10000000001/calendars/work/%65vent%20%7b1%7d.ics';
// T0-DECISION: invalid internal builder arguments use CalDavError('protocol'); public invalid_input mapping belongs above this transport seam.
const protocol = (operation: () => unknown) => expect(operation).toThrow(new CalDavError('protocol'));

// All inputs are synthetic, from probe evidence. Negative variants are deliberate protocol attacks, not captures.
describe('P1 exact REPORT request contracts', () => {
    test('expanded query requests getetag, expand and identical VEVENT time-range bounds', () => {
        // T0-DECISION: XML has many equivalent spellings; pin compact lower-case d/c prefixes and declaration as the frozen wire spelling.
        expect(buildExpandedQuery(expected.transport_range)).toBe(expected.query_xml);
    });
    test('multiget is unexpanded and escapes canonical href XML characters', () => {
        // Raw <, > and double quote are not canonical Path characters; & and apostrophe exercise the reachable escaping cases.
        expect(buildMultiget([`${calendarId}a&b'(x).ics`])).toBe(expected.multiget_xml);
    });
    for (const range of [
        { startUtc: '20270110T240000Z', endUtc: '20270113T000000Z' },
        { startUtc: '20270230T000000Z', endUtc: '20270301T000000Z' },
        { startUtc: '20270110T000060Z', endUtc: '20270113T000000Z' },
        { startUtc: '20270110T000000Z"/><evil/>', endUtc: '20270113T000000Z' },
    ]) {
        test(`rejects invalid REPORT bound ${range.startUtc}`, () => protocol(() => buildExpandedQuery(range)));
    }
    test('multiget rejects duplicate, empty, noncanonical and over-50 href lists', () => {
        // T0-DECISION: reject empty multiget input as internal protocol misuse; a caller should issue no request instead.
        for (const hrefs of [[], [`${calendarId}a.ics`, `${calendarId}a.ics`], [`${calendarId}%61.ics`], Array.from({ length: 51 }, (_, i) => `${calendarId}${i}.ics`)]) {
            protocol(() => buildMultiget(hrefs));
        }
    });
    test('mandatory successful-resource markup proves the derived cap, independently of P0 markup arrays', () => {
        const minimal = '<response><href></href><propstat><prop><getetag></getetag><calendar-data></calendar-data></prop><status></status></propstat></response>';
        expect(Buffer.byteLength(minimal)).toBe(expected.minimal_markup_bytes);
        expect(RESOURCE_ENVELOPE_LOWER_BOUND).toBe(64);
        expect(MAX_RESOURCES_PER_REPORT).toBe(expected.resource_cap);
        expect(Buffer.byteLength(minimal)).toBeGreaterThan(RESOURCE_ENVELOPE_LOWER_BOUND);
    });
});

describe('P1 canonical href contract agrees with public Path', () => {
    for (const [source, path] of [
        [`${base}%65vent%20%7b1%7d.ics`, `${calendarId}event%20%7B1%7D.ics`],
        ['event%5e1.ics', `${calendarId}event%5E1.ics`],
        [`${calendarId}event%25.ics`, `${calendarId}event%25.ics`],
    ]) {
        test(`canonicalizes server spelling ${source}`, () => {
            const actual = canonicalizeServerHref(source ?? '', base);
            expect(actual).toBe(path ?? '');
            expect(isCanonicalPath(actual)).toBe(true);
        });
    }
    test('collection IDs use the same B2 canonicalizer as resource IDs', () => {
        const actual = canonicalizeCalendarPath('/10000000001/calendars/%77ork%20%7b1%7d/');
        expect(actual).toBe('/10000000001/calendars/work%20%7B1%7D/');
        expect(isCanonicalPath(actual)).toBe(true);
    });
    for (const href of [
        '../other/a.ics', `${calendarId}./a.ics`, `${calendarId}%2e%2e/a.ics`, `${calendarId}a%2fb.ics`,
        `${calendarId}a%5Cb.ics`, `${calendarId}a%00.ics`, `${calendarId}a%3Fb.ics`, `${calendarId}a%23b.ics`,
        `${calendarId}a%252f.ics`, `${calendarId}a%xx.ics`, `${calendarId}a.ics?query=1`, `${calendarId}a.ics#fragment`,
        `https://other.example.test${calendarId}a.ics`, `//other.example.test${calendarId}a.ics`,
    ]) {
        test(`rejects unsafe href ${href}`, () => protocol(() => canonicalizeServerHref(href, base)));
    }
    test('direct child containment is not a prefix check', () => {
        expect(isDirectChildResource(calendarId, `${calendarId}a.ics`)).toBe(true);
        for (const href of [calendarId, `${calendarId}nested/a.ics`, '/10000000001/calendars/work-other/a.ics', '/10000000002/calendars/work/a.ics']) {
            expect(isDirectChildResource(calendarId, href)).toBe(false);
        }
    });
});

describe('P1 strict namespace-aware REPORT extraction', () => {
    test('extracts exact ETag and LF decoded calendar-data with canonical href', () => {
        expect(extractEventReport(xml, context)).toEqual([expected.resource]);
        expect(extractEventReport(xml.replaceAll('\n', '\r\n'), context)).toEqual([expected.resource]);
    });
    const mutations: [string, string][] = [
        ['cross-calendar', xml.replace(rawHref, '/10000000001/calendars/personal/a.ics')],
        ['cross-account', xml.replace(rawHref, '/10000000002/calendars/work/a.ics')],
        ['nested child', xml.replace(rawHref, `${calendarId}nested/a.ics`)],
        ['duplicate canonical href', xml.replace('</D:multistatus>', `${xml.slice(xml.indexOf('<D:response>'), xml.indexOf('</D:multistatus>'))}</D:multistatus>`)],
        ['duplicate successful etag', xml.replace('</D:getetag>', '</D:getetag><D:getetag>"v2"</D:getetag>')],
        ['duplicate successful data', xml.replace('</D:prop>', '<C:calendar-data>extra</C:calendar-data></D:prop>')],
        ['missing successful etag', xml.replace('<D:getetag>&quot;v1&quot;</D:getetag>', '')],
        ['wrong namespace', xml.replace('xmlns:C="urn:ietf:params:xml:ns:caldav"', 'xmlns:C="urn:hostile"')],
        ['element in calendar-data', xml.replace('<![CDATA[BEGIN:VCALENDAR', '<evil/><![CDATA[BEGIN:VCALENDAR')],
        ['DTD', xml.replace('<D:multistatus', '<!DOCTYPE x [<!ENTITY x "injected">]><D:multistatus')],
        ['malformed XML', xml.replace('</D:response>', '</D:broken>')],
        ['contradictory response status', xml.replace('</D:response>', '<D:status>HTTP/1.1 404 Not Found</D:status></D:response>')],
    ];
    for (const [label, input] of mutations) {
        test(`rejects ${label} as whole-calendar protocol failure`, () => protocol(() => extractEventReport(input, context)));
    }
    test('validates hrefs even on failed resources', () => {
        const failed = '<D:response><D:href>/10000000002/calendars/work/a.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>';
        protocol(() => extractEventReport(xml.replace('</D:multistatus>', `${failed}</D:multistatus>`), context));
    });
    test('multiget rejects missing or unrequested replies', () => {
        protocol(() => extractEventReport(xml, { ...context, requestedHrefs: [`${calendarId}missing.ics`] }));
        protocol(() => extractEventReport(xml, { ...context, requestedHrefs: [expected.resource.href, `${calendarId}missing.ics`] }));
    });
    test('partial/507 is too_large, not a successful prefix', () => {
        for (const input of [
            xml.replace('HTTP/1.1 200 OK', 'HTTP/1.1 507 Insufficient Storage'),
            xml.replace('</D:multistatus>', '<D:error><D:number-of-matches-within-limits/></D:error></D:multistatus>'),
            xml.replace('</D:multistatus>', '<D:response><D:href>/10000000001/calendars/work/</D:href><D:status>HTTP/1.1 507 Insufficient Storage</D:status><D:error><D:number-of-matches-within-limits/></D:error></D:response></D:multistatus>'),
        ]) {
            // CalDavError's P0 code union does not yet include too_large; assert the required runtime error shape without a cast.
            expect(() => extractEventReport(input, context)).toThrow(expect.objectContaining({ code: 'too_large' }));
        }
    });
});
