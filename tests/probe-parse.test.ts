import { describe, expect, test } from 'bun:test';
import { comps, parseIcal, prop, props } from '../scripts/probe/ical';
import { descendants, escapeXml, parseMultistatus, parseXml } from '../scripts/probe/xml';

describe('XML', () => {
    test('parses a prefixed multistatus with propstats, entities and a sync token', () => {
        const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/1/calendars/a/</d:href>
  <d:propstat><d:prop><d:displayname>A &amp; B</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:getctag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
 <d:response><d:href>/1/calendars/b.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
 <d:sync-token>tok</d:sync-token>
</d:multistatus>`;
        const ms = parseMultistatus(body);
        expect(ms).toBeDefined();
        expect(ms?.responses.length).toBe(2);
        const first = ms?.responses[0];
        expect(first?.href).toBe('/1/calendars/a/');
        expect(first?.props.get('displayname')?.status).toBe(200);
        expect(first?.props.get('displayname')?.text).toBe('A & B');
        expect(first?.props.get('getctag')?.status).toBe(404);
        expect(first?.props.get('resourcetype')?.node.children.map((c) => c.name)).toEqual(['collection', 'calendar']);
        expect(ms?.responses[1]?.status).toBe(404);
        expect(ms?.syncToken).toBe('tok');
    });

    test('malformed XML, DOCTYPE and non-multistatus roots are refused', () => {
        expect(parseXml('<a><b></a>')).toBeUndefined();
        expect(parseXml('')).toBeUndefined();
        expect(parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toBeUndefined();
        expect(parseMultistatus('<d:error xmlns:d="DAV:"/>')).toBeUndefined();
        expect(parseMultistatus('plain text')).toBeUndefined();
    });

    test('descendants and escaping', () => {
        const root = parseXml('<d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:no-uid-conflict><d:href>/x</d:href></c:no-uid-conflict></d:error>');
        expect(root?.name).toBe('error');
        expect(descendants(root, 'href').length).toBe(1);
        expect(escapeXml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
    });
});

describe('iCalendar', () => {
    test('unfolds lines, parses params with quotes and nested components', () => {
        const text = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:u1',
            'SUMMARY:Long',
            '  folded',
            'DTSTART;TZID="America/New_York":20261121T100000',
            'ATTENDEE;CN="Doe, Jane";SCHEDULE-STATUS=1.2:mailto:jane@example.invalid',
            'BEGIN:VALARM',
            'TRIGGER:-PT15M',
            'END:VALARM',
            'END:VEVENT',
            'END:VCALENDAR',
            '',
        ].join('\r\n');
        const cal = parseIcal(text);
        expect(cal?.name).toBe('VCALENDAR');
        const ev = cal ? comps(cal, 'VEVENT')[0] : undefined;
        expect(ev).toBeDefined();
        if (ev === undefined) {
            return;
        }
        expect(prop(ev, 'SUMMARY')?.value).toBe('Long folded');
        expect(prop(ev, 'DTSTART')?.params.TZID).toBe('America/New_York');
        expect(prop(ev, 'ATTENDEE')?.params.CN).toBe('Doe, Jane');
        expect(prop(ev, 'ATTENDEE')?.params['SCHEDULE-STATUS']).toBe('1.2');
        expect(prop(ev, 'ATTENDEE')?.value).toBe('mailto:jane@example.invalid');
        expect(comps(ev, 'VALARM').length).toBe(1);
        expect(props(ev, 'UID').length).toBe(1);
    });

    test('accepts LF-only text and refuses unbalanced components', () => {
        expect(parseIcal('BEGIN:VCALENDAR\nEND:VCALENDAR\n')?.name).toBe('VCALENDAR');
        expect(parseIcal('BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VCALENDAR\n')).toBeUndefined();
        expect(parseIcal('garbage')).toBeUndefined();
    });
});
