import { describe, expect, test } from 'bun:test';
import {
    checkManagedAttachmentUrl, credentialRetryAllowed, MANAGED_ATTACHMENT_POLICY, offersBasicChallenge, type ManagedAttachmentPolicy, type ManagedDenial,
} from '../src/caldav/managed-attachment-policy';
import { FAKE_DISCOVERY } from './helpers/fake-caldav';

const home = FAKE_DISCOVERY.calendarHomeUrl;
const good = 'https://gateway.icloud.com/a1/b2/c3/d4/probe.txt/e5';
const check = (url: string, managedId: string | null = 'synthetic-managed') => checkManagedAttachmentUrl({ url, managedId, calendarHomeUrl: home });
const reason = (url: string, managedId?: string | null) => {
    const decision = check(url, managedId);
    return decision.allowed ? 'allowed' : decision.reason;
};

describe('managed attachment policy', () => {
    test('ships exactly gateway.icloud.com and an empty credentialed-host list', () => {
        expect(MANAGED_ATTACHMENT_POLICY.downloadHosts).toEqual(['gateway.icloud.com']);
        expect(MANAGED_ATTACHMENT_POLICY.credentialedHosts).toEqual([]);
        expect(Object.isFrozen(MANAGED_ATTACHMENT_POLICY)).toBe(true);
        expect(Object.isFrozen(MANAGED_ATTACHMENT_POLICY.downloadHosts)).toBe(true);
        expect(Object.isFrozen(MANAGED_ATTACHMENT_POLICY.credentialedHosts)).toBe(true);
    });

    test('accepts the measured shape, with an explicit default port or a query, and returns the normalized URL', () => {
        for (const url of [good, 'https://gateway.icloud.com:443/a/b/c/d/x.pdf/e', 'https://GATEWAY.icloud.com/a/x', 'https://gateway.icloud.com/a/x?signature=abc']) {
            const decision = check(url);
            expect(decision.allowed).toBe(true);
            if (decision.allowed) {
                expect(decision.url.hostname).toBe('gateway.icloud.com');
                expect(decision.url.port).toBe('');
            }
        }
    });

    const denials: [string, string, string | null, ManagedDenial][] = [
        ['no MANAGED-ID', good, null, 'missing_managed_id'],
        ['an empty MANAGED-ID', good, '', 'missing_managed_id'],
        ['an unparseable URL', 'https://', 'm', 'invalid_url'],
        ['an empty value', '', 'm', 'invalid_url'],
        ['a space', 'https://gateway.icloud.com/a b', 'm', 'invalid_url'],
        ['a tab', 'https://gateway.icloud.com/a\tb', 'm', 'invalid_url'],
        ['a newline', 'https://gateway.icloud.com/a\nb', 'm', 'invalid_url'],
        ['a backslash', 'https://gateway.icloud.com\\a\\b', 'm', 'invalid_url'],
        ['plain http', 'http://gateway.icloud.com/a/x', 'm', 'not_https'],
        ['a file URL', 'file:///etc/passwd', 'm', 'not_https'],
        ['a data URL', 'data:text/plain,hi', 'm', 'not_https'],
        ['a username', 'https://user@gateway.icloud.com/a/x', 'm', 'userinfo'],
        ['a password', 'https://user:pw@gateway.icloud.com/a/x', 'm', 'userinfo'],
        ['another port', 'https://gateway.icloud.com:8443/a/x', 'm', 'port'],
        ['a fragment', 'https://gateway.icloud.com/a/x#frag', 'm', 'fragment'],
        ['an empty fragment', 'https://gateway.icloud.com/a/x#', 'm', 'fragment'],
        ['a CalDAV host', 'https://p01-caldav.icloud.com/a/x', 'm', 'host'],
        ['the root CalDAV host', 'https://caldav.icloud.com/a/x', 'm', 'host'],
        ['another icloud host', 'https://p01-content.icloud.com/a/x', 'm', 'host'],
        ['a suffix lookalike', 'https://gateway.icloud.com.evil.example/a/x', 'm', 'host'],
        ['a prefix lookalike', 'https://evilgateway.icloud.com/a/x', 'm', 'host'],
        ['a subdomain', 'https://x.gateway.icloud.com/a/x', 'm', 'host'],
        ['a trailing dot', 'https://gateway.icloud.com./a/x', 'm', 'host'],
        ['an IPv4 literal', 'https://17.0.0.1/a/x', 'm', 'host'],
        ['an IPv6 literal', 'https://[::1]/a/x', 'm', 'host'],
        ['localhost', 'https://localhost/a/x', 'm', 'host'],
        ['an IDNA lookalike', 'https://gatewаy.icloud.com/a/x', 'm', 'host'],
        ['an encoded slash', 'https://gateway.icloud.com/a%2Fb/x', 'm', 'ambiguous_path'],
        ['an encoded backslash', 'https://gateway.icloud.com/a%5cb/x', 'm', 'ambiguous_path'],
        ['an encoded dot', 'https://gateway.icloud.com/a/x%2etxt', 'm', 'ambiguous_path'],
        ['an encoded dot segment resolved back into the home', 'https://gateway.icloud.com/x/%2e%2e/10000000001/calendars/home/e', 'm', 'calendar_home_path'],
        ['an encoded NUL', 'https://gateway.icloud.com/a/x%00', 'm', 'ambiguous_path'],
        ['a malformed escape', 'https://gateway.icloud.com/a/x%zz', 'm', 'ambiguous_path'],
        ['an empty segment', 'https://gateway.icloud.com/a//x', 'm', 'ambiguous_path'],
        ['the calendar-home path', 'https://gateway.icloud.com/10000000001/calendars/home/x', 'm', 'calendar_home_path'],
        ['the calendar-home path itself', 'https://gateway.icloud.com/10000000001/calendars', 'm', 'calendar_home_path'],
        ['the calendar-home path in another case', 'https://gateway.icloud.com/10000000001/CALENDARS/home/x', 'm', 'calendar_home_path'],
        ['the calendar-home path percent-encoded', 'https://gateway.icloud.com/10000000001/%63alendars/home/x', 'm', 'calendar_home_path'],
        ['a dot segment back into the home', 'https://gateway.icloud.com/x/../10000000001/calendars/home/e', 'm', 'calendar_home_path'],
        ['an .ics object', 'https://gateway.icloud.com/a/event.ics', 'm', 'ics_path'],
        ['an .ICS object in upper case', 'https://gateway.icloud.com/a/EVENT.ICS', 'm', 'ics_path'],
        ['an encoded .ics object', 'https://gateway.icloud.com/a/event.%69cs', 'm', 'ics_path'],
        ['an .ics segment in the middle', 'https://gateway.icloud.com/a/e.ics/x', 'm', 'ics_path'],
        ['a collection path', 'https://gateway.icloud.com/a/b/', 'm', 'collection_path'],
        ['the host root', 'https://gateway.icloud.com/', 'm', 'collection_path'],
        ['no path at all', 'https://gateway.icloud.com', 'm', 'collection_path'],
    ];
    for (const [label, url, managedId, expected] of denials) {
        test(`denies ${label}`, () => { expect(reason(url, managedId)).toBe(expected); });
    }

    test('a host added to a test policy is still bound by every generic denial', () => {
        const policy: ManagedAttachmentPolicy = { downloadHosts: ['p01-caldav.icloud.com'], credentialedHosts: [] };
        const decide = (url: string) => {
            const decision = checkManagedAttachmentUrl({ url, managedId: 'm', calendarHomeUrl: home }, policy);
            return decision.allowed ? 'allowed' : decision.reason;
        };
        expect(decide('https://p01-caldav.icloud.com/10000000001/calendars/home/e.ics')).toBe('calendar_home_path');
        expect(decide('https://p01-caldav.icloud.com/10000000001/principal/')).toBe('collection_path');
        expect(decide('https://p01-caldav.icloud.com/other/e.ics')).toBe('ics_path');
        expect(decide('https://p01-caldav.icloud.com/other/blob')).toBe('allowed');
    });

    test('an unparseable calendar-home URL denies rather than skipping the home check', () => {
        expect(checkManagedAttachmentUrl({ url: good, managedId: 'm', calendarHomeUrl: 'not a url' })).toEqual({ allowed: false, reason: 'ambiguous_path' });
    });
});

describe('credential retry (OD9)', () => {
    const fakeHost = 'login-required.icloud.example';
    const withLogin: ManagedAttachmentPolicy = { downloadHosts: ['gateway.icloud.com', fakeHost], credentialedHosts: [fakeHost] };
    const url = new URL(`https://${fakeHost}/a/x`);
    const basic = { status: 401, wwwAuthenticate: 'Basic realm="files"' };

    test('the shipped policy never allows credentials, even on a 401 Basic challenge from the download host', () => {
        expect(credentialRetryAllowed(new URL(good), basic)).toBe(false);
    });
    test('a listed credentialed host may receive credentials only after 401 with a Basic challenge', () => {
        expect(credentialRetryAllowed(url, basic, withLogin)).toBe(true);
        expect(credentialRetryAllowed(url, { status: 403, wwwAuthenticate: 'Basic realm="x"' }, withLogin)).toBe(false);
        expect(credentialRetryAllowed(url, { status: 401, wwwAuthenticate: null }, withLogin)).toBe(false);
        expect(credentialRetryAllowed(url, { status: 401, wwwAuthenticate: 'Bearer realm="x"' }, withLogin)).toBe(false);
        expect(credentialRetryAllowed(new URL('https://gateway.icloud.com/a/x'), basic, withLogin)).toBe(false);
    });
    test('a credentialed host that is not also a download host never receives credentials', () => {
        expect(credentialRetryAllowed(url, basic, { downloadHosts: ['gateway.icloud.com'], credentialedHosts: [fakeHost] })).toBe(false);
    });
    test('Basic challenge detection reads every challenge, not lookalike tokens', () => {
        expect(offersBasicChallenge('Basic')).toBe(true);
        expect(offersBasicChallenge('basic realm="x"')).toBe(true);
        expect(offersBasicChallenge('Bearer realm="a", Basic realm="b"')).toBe(true);
        expect(offersBasicChallenge('Bearer realm="Basic"')).toBe(false);
        expect(offersBasicChallenge('BasicX realm="x"')).toBe(false);
        expect(offersBasicChallenge('')).toBe(false);
        expect(offersBasicChallenge(null)).toBe(false);
    });
});
