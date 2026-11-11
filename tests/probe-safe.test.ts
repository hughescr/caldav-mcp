import { describe, expect, test } from 'bun:test';
import { Taint, davTokens, etagShape, fixed, hrefShape as brandedShape, isVocabulary, parseRetryAfter, prose, renderProse, safeName as brandedName, scrubValue, tokenShape } from '../scripts/probe/safe';

// `Safe` is a compile-time brand; the assertions compare plain strings.
const hrefShape = (href: string): string => brandedShape(href);
const safeName = (value: string): string => brandedName(value);

describe('href shapes', () => {
    test('replace identifiers with placeholders and keep structural words', () => {
        expect(hrefShape('/10000000001/principal/')).toBe('/<id>/principal/');
        expect(hrefShape('https://p42-caldav.icloud.com:443/10000000001/calendars/')).toBe('/<id>/calendars/');
        expect(hrefShape('/10000000001/calendars/8F2A1C3E-0000-4000-8000-ABCDEF012345/')).toBe('/<id>/calendars/<id>/');
        expect(hrefShape('/10000000001/calendars/home/event-123.ics')).toBe('/<id>/calendars/<id>/<id>.ics');
        expect(hrefShape('/10000000001/calendars/caldav-mcp-probe-0a1b2c3d/')).toBe('/<id>/calendars/<probe>/');
        expect(hrefShape('/10000000001/calendars/caldav-mcp-probe-0a1b2c3d/caldav-mcp-probe-0a1b2c3d-4.ics')).toBe('/<id>/calendars/<probe>/<probe>.ics');
        expect(hrefShape('/')).toBe('/');
        expect(hrefShape('')).toBe('<none>');
        expect(hrefShape('mailto:someone@example.invalid')).toBe('<non-path>');
    });

    test('a personal word used as a segment is never kept', () => {
        expect(hrefShape('/1/calendars/Secret%20Diary/')).toBe('/<id>/calendars/<id>/');
        expect(hrefShape('/1/calendars/work/')).toBe('/<id>/calendars/<id>/');
    });
});

describe('value shapes', () => {
    test('etag shape reports only quoting, weakness and length', () => {
        expect(etagShape('"abc123"')).toEqual({ quoted: true, weak: false, length: 8 });
        expect(etagShape('W/"abc"')).toEqual({ quoted: true, weak: true, length: 7 });
        expect(etagShape('abc')).toEqual({ quoted: false, weak: false, length: 3 });
        expect(etagShape(null)).toBeNull();
    });

    test('token shape reports length and alphabet only', () => {
        expect(tokenShape('https://caldav.icloud.com/sync/abc')).toEqual({ length: 34, looksLikeUrl: true, base64Alphabet: false });
        expect(tokenShape('HwoQEgwAAAh4ZBvAAAA=')).toEqual({ length: 20, looksLikeUrl: false, base64Alphabet: true });
        expect(tokenShape('')).toEqual({ length: 0, looksLikeUrl: false, base64Alphabet: false });
    });

    test('safe names accept element and header names but not identifiers or text', () => {
        expect(safeName('calendar-home-set')).toBe('calendar-home-set');
        expect(safeName('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR')).toBe('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR');
        expect(safeName('retry-after')).toBe('retry-after');
        expect(safeName('10000000001')).toBe('<other>');
        expect(safeName('x10000000001')).toBe('<other>');
        expect(safeName('Lunch with Bob')).toBe('<other>');
        expect(safeName('a'.repeat(65))).toBe('<other>');
    });

    test('i3: names must start with a letter and use only name characters', () => {
        expect(safeName('caldav:supported-filter')).toBe('caldav:supported-filter');
        expect(safeName('x_y.z')).toBe('x_y.z');
        for (const bad of ['1abc', '-x', 'a b', 'a@b', 'a/b', 'é', 'a\u0000', '', 'a'.repeat(65), 'a<b']) {
            expect(safeName(bad)).toBe('<other>');
        }
    });

    test('i3: a name that contains a value seen from the server or the user is withheld, and a refused name is remembered', () => {
        const taint = new Taint();
        taint.add('CanaryCalendarId');
        expect(String(brandedName('x-canarycalendarid-trace', taint))).toBe('<other>');
        expect(String(brandedName('X-CANARYCALENDARID', taint))).toBe('<other>');
        expect(String(brandedName('content-type', taint))).toBe('content-type');
        expect(String(brandedName('weird name with secretword', taint))).toBe('<other>');
        expect(scrubValue({ s: 'weird name with secretword' }, taint).count).toBe(1);
    });

    test('DAV header tokens are split and coded URLs are counted but not kept', () => {
        const tokens = davTokens('1, 2, access-control, calendar-access, <https://caldav.icloud.com/10000000001/x>, calendar-auto-schedule');
        expect(tokens.tokens.map(String)).toEqual(['1', '2', 'access-control', 'calendar-access', 'calendar-auto-schedule']);
        expect(tokens.otherCount).toBe(1);
        expect(davTokens(null)).toEqual({ tokens: [], otherCount: 0 });
    });

    test('retry-after accepts seconds and HTTP dates', () => {
        const now = Date.parse('2026-11-11T12:00:00Z');
        expect(parseRetryAfter('120', now)).toBe(120);
        expect(parseRetryAfter('Wed, 11 Nov 2026 12:00:30 GMT', now)).toBe(30);
        expect(parseRetryAfter('soon', now)).toBeNull();
        expect(parseRetryAfter(null, now)).toBeNull();
    });
});

describe('taint and scrub', () => {
    test('scrubs raw, URL-encoded and base64 forms in nested values and counts them', () => {
        const taint = new Taint();
        taint.add('Secret Diary');
        taint.add('ab');
        const input = { a: 'x Secret Diary y', b: ['Secret%20Diary', btoa('Secret Diary')], c: { d: 3, e: true, f: 'ab' } };
        const { value, count } = scrubValue(input, taint);
        expect(count).toBe(3);
        expect(JSON.stringify(value)).not.toContain('Secret');
        expect(value.c).toEqual({ d: 3, e: true, f: 'ab' });
        // Whole-string replacement: the surrounding text is never kept, so nothing can be reconstructed from it.
        expect(value.a).toBe('<scrubbed>');
        expect(value.b).toEqual(['<scrubbed>', '<scrubbed>']);
    });

    test('never rewrites keys, probe codes, protocol names, href shapes or the probe’s own calendar names', () => {
        const taint = new Taint();
        for (const word of ['side', 'time', 'rang', 'calendars', 'probe', 'listed', 'access']) {
            taint.add(word);
        }
        const input = { insideStatus: 1, timeout: 'timeout', reason: 'still_listed', names: ['accept-ranges', 'calendar-access'], shape: '/<id>/calendars/<probe>/<id>.ics', name: 'caldav-mcp-probe-0a1b2c3d', other: '<other>', backend: 'probe_timeout' };
        expect(scrubValue(input, taint)).toEqual({ value: input, count: 0 });
        expect(isVocabulary('/<id>/calendars/<id>/')).toBe(true);
        expect(isVocabulary('/<id>/Secret/')).toBe(false);
        expect(isVocabulary('caldav-mcp-probe-0a1b2c3d-extra')).toBe(false);
    });

    test('prose: only slots are checked, a tainted slot goes as a whole, and fixed text must come from a template literal', () => {
        const taint = new Taint();
        taint.add('side');
        taint.add('Secret Diary');
        const sentence = prose`Inside: ${fixed('Secret Diary')}; beside ${fixed('timeout')}; ${2} item(s); ${prose`nested inside`}.`;
        expect(renderProse(sentence, taint)).toEqual({ text: 'Inside: <scrubbed>; beside timeout; 2 item(s); nested inside.', count: 1 });
        expect(renderProse(sentence)).toEqual({ text: 'Inside: Secret Diary; beside timeout; 2 item(s); nested inside.', count: 0 });
        const forged = ['side by side'] as unknown as TemplateStringsArray;
        expect(() => prose(forged)).toThrow(TypeError);
    });

    test('never taints the probe’s own synthetic names', () => {
        const taint = new Taint();
        taint.add('caldav-mcp-probe-0a1b2c3d');
        taint.add('caldav-mcp probe event');
        expect(taint.size).toBe(0);
    });
});
