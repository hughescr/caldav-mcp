import { describe, expect, jest, test } from 'bun:test';
import { PROBE_FILE_TEXT } from '../scripts/probe/checks/write-attachments';
import { managedUrlShape } from '../scripts/probe/checks/managed-download';
import { ProbeHttp } from '../scripts/probe/http';
import { Taint } from '../scripts/probe/safe';
import { PLAIN, standardAccount, type FakeBehaviour } from './fixtures/probe/fake-icloud';
import { READ_ONLY, WRITE, check, probe } from './fixtures/probe/harness';

const credentials = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const URL_VALUE = 'https://p123-attachment.icloud.com/10000000001/attachments/abc/probe-attachment.txt';
const isFile = (url: URL): boolean => url.pathname.includes('/attachments/');

async function run(behaviour: Partial<FakeBehaviour> = {}, sleeps: number[] = []) {
    const fake = standardAccount(PLAIN, behaviour);
    const report = await probe(fake, WRITE, credentials, { sleep: async (ms) => { sleeps.push(ms); } });
    return { fake, report, result: check(report, 'write-attachment-managed') };
}

function transport(respond: (req: Request) => Response | Promise<Response>, limits = {}) {
    const requests: Request[] = [];
    const inits: (RequestInit | undefined)[] = [];
    const http = new ProbeHttp({
        fetch: async (input, init) => { const req = new Request(input, init); requests.push(req); inits.push(init); return respond(req); },
        now: () => 1000, sleep: async () => undefined, auth: credentials, mode: 'write', taint: new Taint(),
        limits: { minIntervalMs: 0, ...limits },
    });
    return { http, requests, inits };
}

test('0.6.0 standard fake request totals', async () => {
    for (const expand of [false, true]) {
        for (const flags of [READ_ONLY, WRITE]) {
            const fake = standardAccount(PLAIN, { expand });
            const report = await probe(fake, flags, credentials);
            const expected = flags.write ? expand ? 222 : 208 : 54;
            expect(report.totals.requests).toBe(expected);
            expect(fake.requests).toHaveLength(expected);
        }
    }
});

describe('scoped managed download transport', () => {
    test('refuses unsafe hosts, ports, protocols, credentials, fragments and unequal ATTACH values without sending', async () => {
        const { http, requests } = transport(() => new Response('x'));
        for (const url of ['http://p1-a.icloud.com/a', 'https://p1-a.icloud.com:8443/a', 'https://icloud.com/a', 'https://icloud.com.evil.invalid/a', 'https://x.icloud-content.com/a', 'https://user@x.icloud.com/a', `${URL_VALUE}#x`]) {
            await expect(http.attachmentDownload(url, url, 'anonymous')).rejects.toThrow('forbidden_host');
        }
        await expect(http.attachmentDownload(URL_VALUE, `${URL_VALUE}?different=1`, 'anonymous')).rejects.toThrow('forbidden_host');
        await expect(http.attachmentDownload(URL_VALUE, URL_VALUE, 'authenticated')).rejects.toThrow();
        await expect(http.attachmentDownload(URL_VALUE, 'https://x.icloud-content.com/a', 'redirect')).rejects.toThrow();
        expect(requests).toHaveLength(0);
    });

    test('anonymous challenge does not latch; authenticated 401 latches before a broken body and allows only cleanup', async () => {
        const { http, requests } = transport((req) => req.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(req.headers.has('authorization') ? new ReadableStream({ start(c) { c.error(new Error('broken')); } }) : 'login', { status: 401 }));
        const home = 'https://p42-caldav.icloud.com/1/calendars/';
        const calendar = `${home}caldav-mcp-probe-12345678/`;
        http.registerProbeCollection(calendar, home);
        expect((await http.attachmentDownload(URL_VALUE, URL_VALUE, 'anonymous')).status).toBe(401);
        expect(http.credentialsRejected).toBe(false);
        await expect(http.attachmentDownload(URL_VALUE, URL_VALUE, 'authenticated')).rejects.toThrow('network');
        expect(http.credentialsRejected).toBe(true);
        await expect(http.request({ method: 'GET', url: home })).rejects.toThrow('unauthorized');
        await http.request({ method: 'DELETE', url: calendar, essential: true });
        expect(requests.map((r) => r.method)).toEqual(['GET', 'GET', 'DELETE']);
        expect(requests[0]?.headers.has('authorization')).toBe(false);
        expect(requests[1]?.headers.get('authorization')).toStartWith('Basic ');
    });

    test('retains at most 64 KiB and accounts against the ordinary request cap', async () => {
        const { http, requests, inits } = transport(() => new Response('a'.repeat(100_000)), { maxRequests: 2, reserveRequests: 1 });
        const result = await http.attachmentDownload(URL_VALUE, URL_VALUE, 'anonymous');
        expect(result.body.length).toBe(65_536);
        expect(result.truncated).toBe(true);
        expect(requests[0]?.headers.get('range')).toBe('bytes=0-63');
        expect(requests[0]?.redirect).toBe('manual');
        expect(inits[0]?.credentials).toBe('omit');
        await expect(http.attachmentDownload(`${URL_VALUE}?next`, `${URL_VALUE}?next`, 'anonymous')).rejects.toThrow('request_cap');
        expect(http.stats().requests).toBe(1);
    });

    test('sequential steps cannot be repeated, bypass a successful anonymous response, or escape read-only mode', async () => {
        const { http, requests } = transport(() => new Response(PROBE_FILE_TEXT));
        await http.attachmentDownload(URL_VALUE, URL_VALUE, 'anonymous');
        await expect(http.attachmentDownload(URL_VALUE, URL_VALUE, 'authenticated')).rejects.toThrow('method_not_allowed');
        await expect(http.attachmentDownload(URL_VALUE, URL_VALUE, 'anonymous')).rejects.toThrow('method_not_allowed');
        expect(requests).toHaveLength(1);
        for (const mode of ['read', 'cleanup'] as const) {
            const restricted = new ProbeHttp({ fetch: async () => { throw new Error('must not send'); }, now: () => 0, sleep: async () => undefined, auth: credentials, mode, taint: new Taint() });
            await expect(restricted.attachmentDownload(URL_VALUE, URL_VALUE, 'anonymous')).rejects.toThrow('method_not_allowed');
        }
    });

    test('times out at ten seconds', async () => {
        jest.useFakeTimers();
        try {
            const { http } = transport(async () => new Promise<Response>(() => undefined));
            const pending = http.attachmentDownload(URL_VALUE, URL_VALUE, 'anonymous').then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : 'other');
            for (let i = 0; i < 10; i++) { await Promise.resolve(); }
            jest.advanceTimersByTime(10_000);
            expect(await pending).toBe('timeout');
        } finally { jest.useRealTimers(); }
    });
});

describe('managed URL shape reduction', () => {
    test('only fixed literals, classes, masked host and booleans; never identifiers or query values', () => {
        const value = 'https://p123-a45.icloud.com/calendars/123/attachments/abcdef/01234567-89ab-cdef-0123-456789abcdef/private.txt/private/attachment?token=private&managed-id=abc&secret=123';
        const evidence = JSON.parse(JSON.stringify(managedUrlShape(value, 'abc', 'https://p42-caldav.icloud.com/123/calendars/'))) as Record<string, unknown>;
        expect(evidence).toEqual({ urlHostMasked: 'pN-aN.icloud.com', pathSegmentCount: 8, pathSegmentClasses: ['literal:calendars', 'digits', 'literal:attachments', 'hex', 'uuid', 'filename', 'other', 'literal:attachment'], managedIdInPath: true, managedIdInQuery: true, principalIdPresent: true, queryPresent: true, queryParameterNames: ['managed-id', 'other', 'token'] });
        expect(JSON.stringify(evidence)).not.toMatch(/private|secret|123|abcdef/);
    });

    test('encoded identifiers count for booleans, but encoded or empty path segments are other', () => {
        const shape = managedUrlShape('https://p1-a.icloud.com/%31%32%33//%61%62%63?token=%61%62%63', 'abc', 'https://p42-caldav.icloud.com/123/calendars/');
        expect(shape).toMatchObject({ pathSegmentCount: 3, pathSegmentClasses: ['other', 'other', 'other'], managedIdInPath: true, managedIdInQuery: true, principalIdPresent: true });
    });

    test('nonconservative host shapes do not get a masked hostname', () => {
        for (const host of ['files.example.invalid', 'p1-file.icloud-content.com', 'xn--owner.icloud.com', 'bad_label.icloud.com', `${'a'.repeat(54)}.icloud.com`, '1-owner.icloud.com']) {
            expect(managedUrlShape(`https://${host}/a`, 'id', undefined)).not.toHaveProperty('urlHostMasked');
        }
    });
});

describe('probe-authored managed attachment evidence', () => {
    test('anonymous delivery, exact cap and errors have distinct verdicts', async () => {
        for (const [body, outcome] of [[PROBE_FILE_TEXT, 'confirmed'], [`﻿${PROBE_FILE_TEXT}`, 'refuted'], ['x'.repeat(65_536), 'refuted']] as const) {
            const { result } = await run({ hook: (r) => isFile(r.url) ? new Response(body) : undefined });
            expect(result.outcome).toBe(outcome);
            expect(result.evidence).toMatchObject({ anonymousBodyTruncated: false, matchedAnonymous: outcome === 'confirmed' });
        }
        const broken = await run({ hook: (r) => isFile(r.url) ? new Response(new ReadableStream({ start(c) { c.error(new Error('private')); } })) : undefined });
        expect(broken.result.outcome).toBe('inconclusive');
        expect(broken.result.evidence).toMatchObject({ downloadError: 'network' });
        expect(broken.report.cleanup?.allRemoved).toBe(true);
    });

    test('an anonymous redirect 401 never causes credentials to be sent or latches', async () => {
        const { fake, result, report } = await run({ hook: (r) => !isFile(r.url) ? undefined : r.url.hostname === 'p1-file.icloud.com'
            ? new Response('login', { status: 401 })
            : new Response(null, { status: 302, headers: { location: 'https://p1-file.icloud.com/attachments/file' } }) });
        expect(result.outcome).toBe('refuted');
        expect(report.auth.rejected).toBe(false);
        expect(fake.requests.filter((r) => isFile(r.url)).map((r) => r.headers.has('authorization'))).toEqual([false, false]);
    });

    test('successful event provenance plus missing add header still permits download', async () => {
        const { result } = await run({ attachmentAddHeaders: false });
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ managedIdEqualsHeader: null, attachmentProvenanceVerified: true });
    });
    for (const challenge of [401, 403]) {
        test(`only ${challenge} challenges permit Basic on the exact uploaded attachment`, async () => {
            const { fake, result, report } = await run({ attachmentHost: 'icloud-other', hook: (req) => isFile(req.url) && !req.headers.has('authorization') ? new Response('login', { status: challenge, headers: { 'www-authenticate': 'Basic realm="private", Bearer realm="secret", SecretScheme realm="x"' } }) : undefined });
            expect(result.outcome).toBe('confirmed');
            expect(result.evidence).toMatchObject({ attachmentProvenanceVerified: true, urlHostClass: 'icloud-other', urlHostMasked: 'pN-attachment.icloud.com', pathSegmentCount: 4, pathSegmentClasses: ['digits', 'literal:attachments', 'uuid', 'filename'], managedIdInPath: true, managedIdInQuery: false, principalIdPresent: true, queryPresent: false, queryParameterNames: [], anonymousStatus: challenge, anonymousAuthSchemes: ['basic', 'bearer', 'other'], authenticatedStatus: 206, matchedAnonymous: false, matchedAuthenticated: true, matchedRedirect: false });
            const gets = fake.requests.filter((r) => isFile(r.url));
            expect(gets).toHaveLength(2);
            expect(gets.map((r) => r.headers.has('authorization'))).toEqual([false, true]);
            expect(gets.map((r) => r.headers.get('range'))).toEqual(['bytes=0-63', 'bytes=0-63']);
            expect(report.auth.rejected).toBe(false);
        });
    }

    for (const status of [200, 404, 500]) {
        test(`no credential retry after ${status}`, async () => {
            const { fake, result } = await run({ hook: (req) => isFile(req.url) ? new Response(status === 200 ? PROBE_FILE_TEXT : 'no', { status }) : undefined });
            expect(fake.requests.filter((r) => isFile(r.url)).map((r) => r.headers.has('authorization'))).toEqual([false]);
            expect(result.outcome).toBe(status === 200 ? 'confirmed' : 'refuted');
        });
    }

    for (const challenged of [false, true]) {
        test(`one anonymous redirect hop, challenged=${challenged}`, async () => {
            const { fake, result } = await run({ hook: (req) => {
                if (!isFile(req.url)) { return undefined; }
                if (req.url.hostname === 'p9-file.icloud-content.com') { return new Response(PROBE_FILE_TEXT); }
                if (challenged && !req.headers.has('authorization')) { return new Response('login', { status: 403 }); }
                return new Response(null, { status: 302, headers: { location: 'https://p9-file.icloud-content.com/attachments/secret' } });
            } });
            expect(result.outcome).toBe('confirmed');
            expect(result.evidence).toMatchObject({ matchedAnonymous: false, matchedAuthenticated: false, matchedRedirect: true, redirectStatus: 200 });
            const gets = fake.requests.filter((r) => isFile(r.url));
            expect(gets.map((r) => r.headers.has('authorization'))).toEqual(challenged ? [false, true, false] : [false, false]);
            expect(gets.at(-1)?.headers.has('cookie')).toBe(false);
        });
    }

    test('blocked redirect is inconclusive; a second redirect is recorded but not followed', async () => {
        const blocked = await run({ hook: (r) => isFile(r.url) ? new Response(null, { status: 302, headers: { location: 'https://evil.invalid/a' } }) : undefined });
        expect(blocked.result.outcome).toBe('inconclusive');
        expect(blocked.fake.requests.filter((r) => isFile(r.url))).toHaveLength(1);
        const again = await run({ hook: (r) => isFile(r.url) ? new Response(null, { status: 302, headers: { location: 'https://p1-file.icloud.com/attachments/again' } }) : undefined });
        expect(again.result.outcome).toBe('refuted');
        expect(again.fake.requests.filter((r) => isFile(r.url))).toHaveLength(2);
    });

    for (const fault of ['uid', 'size', 'filename', 'managed-id', 'header-id'] as const) {
        test(`${fault} mismatch publishes no URL shape and fetches nothing`, async () => {
            const { fake, result } = await run({ transformResponse: async (req, res) => {
                if (req.method !== 'GET' || !req.url.pathname.endsWith('-attmanaged.ics')) { return res; }
                let text = await res.text();
                if (fault === 'uid') { text = text.replace(/UID:[^\r\n]+/, 'UID:foreign'); }
                if (fault === 'size') { text = text.replace('SIZE=32', 'SIZE=99'); }
                if (fault === 'filename') { text = text.replace('FILENAME=probe-attachment.txt', 'FILENAME=owner.txt'); }
                if (fault === 'managed-id') { text = text.replace(/;MANAGED-ID=[^;:]+/, ''); }
                if (fault === 'header-id') { text = text.replace(/;MANAGED-ID=[^;:]+/, ';MANAGED-ID=different'); }
                return new Response(text, { status: res.status, headers: res.headers });
            } });
            expect(result.outcome).toBe('inconclusive');
            expect(result.evidence).not.toHaveProperty('urlHostMasked');
            expect(result.evidence).not.toHaveProperty('urlHostClass');
            expect(result.evidence).not.toHaveProperty('pathSegmentClasses');
            expect(fake.requests.filter((r) => isFile(r.url))).toHaveLength(0);
        });
    }

    for (const delayed of [1, 2, 3]) {
        test(`removal read-back retries, delay=${delayed}`, async () => {
            let before = ''; let reads = 0; let removed = false;
            const sleeps: number[] = [];
            const { result } = await run({ transformResponse: async (req, res) => {
                if (req.method === 'POST' && req.url.search.includes('attachment-remove')) { removed = true; }
                if (req.method !== 'GET' || !req.url.pathname.endsWith('-attmanaged.ics')) { return res; }
                if (!removed) { before = await res.text(); return new Response(before, { status: res.status, headers: res.headers }); }
                return ++reads <= delayed ? new Response(before, { headers: res.headers }) : res;
            } }, sleeps);
            expect(result.evidence).toMatchObject({ afterRemoveReads: Math.min(delayed + 1, 3), attachGoneAfterRemove: delayed < 3, etagChangedAfterRemove: true });
            expect(sleeps.filter((ms) => ms === 2000)).toHaveLength(Math.min(delayed, 2));
        });
    }
});
