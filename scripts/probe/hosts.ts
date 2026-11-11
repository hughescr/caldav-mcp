/**
 * The probe's own copy of the fixed-host rule. Credentials may only ever be sent to
 * Apple's discovery host or to a per-account host of the form pNN-caldav.icloud.com.
 * Kept separate from src/caldav/hosts.ts on purpose so the probe stands alone.
 */
export const DISCOVERY_HOST = 'caldav.icloud.com';
export const DISCOVERY_URL = 'https://caldav.icloud.com/';
const PER_ACCOUNT_HOST = /^p\d{1,3}-caldav\.icloud\.com$/;

export function isPerAccountHost(hostname: string): boolean {
    return PER_ACCOUNT_HOST.test(hostname);
}

export function isAllowedProbeUrl(raw: string): boolean {
    // Encoded dots/slashes and backslashes are refused before parsing so that
    // path normalisation can never change which collection a write targets.
    if (/%2e|%2f|%5c|\\/i.test(raw)) {
        return false;
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
        return false;
    }
    const host = url.hostname.toLowerCase();
    return host === DISCOVERY_HOST || isPerAccountHost(host);
}
