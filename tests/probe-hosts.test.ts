import { describe, expect, test } from 'bun:test';
import { isAllowedProbeUrl, isPerAccountHost } from '../scripts/probe/hosts';

describe('probe fixed-host rule', () => {
    test('accepts the discovery host and per-account hosts over https', () => {
        expect(isAllowedProbeUrl('https://caldav.icloud.com/')).toBe(true);
        expect(isAllowedProbeUrl('https://caldav.icloud.com/.well-known/caldav')).toBe(true);
        expect(isAllowedProbeUrl('https://p01-caldav.icloud.com/10000000001/calendars/')).toBe(true);
        expect(isAllowedProbeUrl('https://p123-caldav.icloud.com:443/x/')).toBe(true);
        expect(isAllowedProbeUrl('https://P42-CALDAV.ICLOUD.COM/')).toBe(true);
    });

    test('rejects every other host, scheme, port and userinfo', () => {
        for (const url of [
            'http://caldav.icloud.com/',
            'https://caldav.icloud.com:8443/',
            'https://user:pw@caldav.icloud.com/',
            'https://user@caldav.icloud.com/',
            'https://p1234-caldav.icloud.com/',
            'https://p-caldav.icloud.com/',
            'https://px1-caldav.icloud.com/',
            'https://p01-caldav.icloud.com.evil.example/',
            'https://evil.example/p01-caldav.icloud.com/',
            'https://caldav.icloud.com.evil.example/',
            'https://icloud.com/',
            'https://p01-contacts.icloud.com/',
            'https://169.254.169.254/',
            'ftp://caldav.icloud.com/',
            'not a url',
            '',
        ]) {
            expect(isAllowedProbeUrl(url)).toBe(false);
        }
    });

    test('rejects encoded dot or slash path tricks and backslashes', () => {
        expect(isAllowedProbeUrl('https://caldav.icloud.com/a/%2e%2e/b')).toBe(false);
        expect(isAllowedProbeUrl('https://caldav.icloud.com/a%2Fb')).toBe(false);
        expect(isAllowedProbeUrl('https://caldav.icloud.com/a\\b')).toBe(false);
    });

    test('per-account host pattern is exact', () => {
        expect(isPerAccountHost('p07-caldav.icloud.com')).toBe(true);
        expect(isPerAccountHost('caldav.icloud.com')).toBe(false);
        expect(isPerAccountHost('p0007-caldav.icloud.com')).toBe(false);
    });
});
