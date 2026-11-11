import { describe, expect, test } from 'bun:test';
import { CalDavError } from '../src/caldav/contracts';
import { assertAllowedCalDavUrl, isAllowedCalDavUrl } from '../src/caldav/hosts';

describe('isAllowedCalDavUrl accepts only the fixed iCloud CalDAV hosts', () => {
    const allowed = [
        'https://caldav.icloud.com/',
        'https://caldav.icloud.com',
        'https://caldav.icloud.com/10000000001/principal/',
        'https://p1-caldav.icloud.com/',
        'https://p42-caldav.icloud.com/10000000001/calendars/',
        'https://p999-caldav.icloud.com/',
        'https://p007-caldav.icloud.com/',
        // DNS is case-insensitive and WHATWG URL lower-cases the host.
        'https://CALDAV.ICLOUD.COM/',
        'https://P12-CalDav.iCloud.com/x',
        // The default port written explicitly normalizes to port '' (same origin).
        // iCloud is reported to return calendar-home-set hrefs in this form.
        'https://caldav.icloud.com:443/',
        'https://p42-caldav.icloud.com:443/10000000001/calendars/',
        // A query or fragment does not change the destination host.
        'https://caldav.icloud.com/?x=1#y',
    ];
    for (const url of allowed) {
        test(url, () => {
            expect(isAllowedCalDavUrl(url)).toBe(true);
            expect(isAllowedCalDavUrl(new URL(url))).toBe(true);
        });
    }
});

describe('isAllowedCalDavUrl rejects everything else', () => {
    const rejected: [string, string][] = [
        ['plain http', 'http://caldav.icloud.com/'],
        ['http on per-account host', 'http://p1-caldav.icloud.com/'],
        ['other scheme', 'ftp://caldav.icloud.com/'],
        ['websocket scheme', 'wss://caldav.icloud.com/'],
        ['userinfo user', 'https://user@caldav.icloud.com/'],
        ['userinfo user and password', 'https://user:pass@caldav.icloud.com/'],
        ['userinfo empty user with password', 'https://:pass@caldav.icloud.com/'],
        ['host as userinfo before evil host', 'https://p1-caldav.icloud.com@evil.example/'],
        ['allowed host as userinfo with port', 'https://caldav.icloud.com:443@evil.example/'],
        ['explicit non-default port', 'https://caldav.icloud.com:8443/'],
        ['explicit port 80', 'https://caldav.icloud.com:80/'],
        ['explicit port on per-account host', 'https://p1-caldav.icloud.com:444/'],
        ['trailing-dot FQDN', 'https://caldav.icloud.com./'],
        ['trailing-dot per-account', 'https://p1-caldav.icloud.com./'],
        ['suffix attack', 'https://caldav.icloud.com.evil.example/'],
        ['per-account suffix attack', 'https://p1-caldav.icloud.com.evil.example/'],
        ['host in path', 'https://evil.example/caldav.icloud.com'],
        ['host in query', 'https://evil.example/?h=caldav.icloud.com'],
        ['host in fragment', 'https://evil.example/#caldav.icloud.com'],
        ['prefix attack', 'https://evilcaldav.icloud.com/'],
        ['sub-subdomain', 'https://x.caldav.icloud.com/'],
        ['sibling icloud host', 'https://www.icloud.com/'],
        ['bare icloud.com', 'https://icloud.com/'],
        ['other caldav-like host', 'https://p1-contacts.icloud.com/'],
        ['four-digit partition', 'https://p0000-caldav.icloud.com/'],
        ['four-digit partition 1234', 'https://p1234-caldav.icloud.com/'],
        ['empty partition', 'https://p-caldav.icloud.com/'],
        ['letters in partition', 'https://pab-caldav.icloud.com/'],
        ['negative partition', 'https://p-1-caldav.icloud.com/'],
        ['missing p', 'https://12-caldav.icloud.com/'],
        ['IPv4 literal', 'https://17.248.1.1/'],
        ['IPv4 decimal literal', 'https://301989888/'],
        ['IPv6 literal', 'https://[::1]/'],
        ['IPv6 mapped', 'https://[::ffff:11f8:101]/'],
        ['localhost', 'https://localhost/'],
        ['metadata service', 'https://169.254.169.254/latest/meta-data/'],
        // Cyrillic small letter o (U+043E) in "icloud" and "com": IDNA turns it into an xn-- label.
        ['IDN homograph in icloud', 'https://caldav.iclоud.com/'],
        ['IDN homograph in com', 'https://caldav.icloud.cоm/'],
        ['punycode label', 'https://xn--caldav-9za.icloud.com/'],
        ['punycode lookalike per-account', 'https://p1-caldav.xn--icloud-7ve.com/'],
        ['empty string', ''],
        ['relative path', '/10000000001/principal/'],
        ['protocol-relative', '//caldav.icloud.com/'],
        ['garbage', 'not a url'],
        ['javascript scheme', 'javascript:alert(1)'],
        ['data scheme', 'data:text/plain,caldav.icloud.com'],
        ['file scheme', 'file:///etc/passwd'],
    ];
    for (const [label, url] of rejected) {
        test(label, () => {
            expect(isAllowedCalDavUrl(url)).toBe(false);
        });
    }

    test('URL objects are checked the same way', () => {
        expect(isAllowedCalDavUrl(new URL('https://p1-caldav.icloud.com@evil.example/'))).toBe(false);
        expect(isAllowedCalDavUrl(new URL('http://caldav.icloud.com/'))).toBe(false);
    });

    test('a mutated URL object is re-read, not cached', () => {
        const url = new URL('https://caldav.icloud.com/');
        url.hostname = 'evil.example';
        expect(isAllowedCalDavUrl(url)).toBe(false);
    });

    test('non-string, non-URL values are rejected without throwing', () => {
        for (const value of [undefined, null, 42, {}, { href: 'https://caldav.icloud.com/' }]) {
            expect(isAllowedCalDavUrl(value as unknown as string)).toBe(false);
        }
    });
});

describe('IDNA normalization yields the real host, which is allowed', () => {
    test('full-width letters map to the ASCII host they name', () => {
        // WHATWG URL applies UTS #46 mapping, so the request goes to the genuine host.
        const url = 'https://ｃａｌｄａｖ.icloud.com/';
        expect(new URL(url).hostname).toBe('caldav.icloud.com');
        expect(isAllowedCalDavUrl(url)).toBe(true);
    });

    test('percent-encoded dots in the host decode to the real host', () => {
        expect(new URL('https://caldav%2eicloud.com/').hostname).toBe('caldav.icloud.com');
        expect(isAllowedCalDavUrl('https://caldav%2eicloud.com/')).toBe(true);
    });
});

describe('assertAllowedCalDavUrl', () => {
    test('returns the normalized URL for an allowed input', () => {
        const url = assertAllowedCalDavUrl('https://P42-CALDAV.icloud.com:443/10000000001/calendars/');
        expect(url).toBeInstanceOf(URL);
        expect(url.href).toBe('https://p42-caldav.icloud.com/10000000001/calendars/');
    });

    test('returns a copy, so mutating the input later cannot change it', () => {
        const input = new URL('https://caldav.icloud.com/');
        const checked = assertAllowedCalDavUrl(input);
        input.hostname = 'evil.example';
        expect(checked.hostname).toBe('caldav.icloud.com');
    });

    test('throws CalDavError forbidden_host for a disallowed input, without echoing it', () => {
        const secretish = 'https://user:hunter2@evil.example/secret-path';
        let caught: unknown;
        try {
            assertAllowedCalDavUrl(secretish);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CalDavError);
        expect((caught as CalDavError).code).toBe('forbidden_host');
        expect(String(caught)).not.toContain('evil.example');
        expect(String(caught)).not.toContain('hunter2');
        expect((caught as Error).stack ?? '').not.toContain('hunter2');
    });

    test('throws forbidden_host for an unparsable input', () => {
        expect(() => assertAllowedCalDavUrl('::::')).toThrow(CalDavError);
    });
});
