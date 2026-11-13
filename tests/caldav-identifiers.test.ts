import { expect, test } from 'bun:test';
import { CalDavError } from '../src/caldav/contracts';
import { canonicalizeCalendarPath, canonicalizeServerHref, isDirectChildResource } from '../src/caldav/identifiers';

const base = 'https://p01-caldav.icloud.com/123/calendars/work/';
for (const href of ['a\\b.ics', ' a.ics', 'a.ics ', 'a\nb.ics', '%2e/a.ics', 'a//b.ics', 'https://user@p01-caldav.icloud.com/123/calendars/work/a.ics']) {
    test(`rejects lossy URL normalization ${JSON.stringify(href)}`, () => {
        expect(() => canonicalizeServerHref(href, base)).toThrow(new CalDavError('protocol'));
    });
}
test('raw server braces spaces and carets become canonical escapes', () => {
    expect(canonicalizeServerHref('a {b}^.ics', base)).toBe('/123/calendars/work/a%20%7Bb%7D%5E.ics');
    expect(canonicalizeCalendarPath('/123/calendars/{work}/')).toBe('/123/calendars/%7Bwork%7D/');
});
test('collection paths need a trailing slash; containment needs a canonical collection and keeps the name opaque', () => {
    expect(() => canonicalizeCalendarPath('/123/calendars/work')).toThrow(new CalDavError('protocol'));
    expect(isDirectChildResource('/123/calendars/%77ork/', '/123/calendars/%77ork/a.ics')).toBe(false);
    // A resource name is opaque: an escaped unreserved character is kept, not refused or decoded.
    expect(isDirectChildResource('/123/calendars/work/', '/123/calendars/work/%61.ics')).toBe(true);
});
