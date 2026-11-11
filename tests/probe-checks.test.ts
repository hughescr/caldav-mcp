import { describe, expect, test } from 'bun:test';
import type { BackendLoad } from '../scripts/probe/types';
import { PLAIN, standardAccount } from './fixtures/probe/fake-icloud';
import { READ_ONLY, WRITE_METHODS, check, outcomes, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };

describe('read-only probe against an iCloud-like fake', () => {
    test('confirms or refutes each plan item as the fake behaves', async () => {
        const fake = standardAccount();
        const report = await probe(fake, READ_ONLY, creds);
        expect(outcomes(report)).toEqual({
            discovery: 'confirmed',
            'auth-app-password': 'confirmed',
            'dav-capabilities': 'confirmed',
            'scheduling-properties': 'confirmed',
            'discovery-stability': 'confirmed',
            collections: 'confirmed',
            'time-range': 'confirmed',
            'free-busy-query': 'confirmed',
            'expand-read': 'refuted',
            'text-match-read': 'refuted',
            'uid-filter': 'confirmed',
            multiget: 'confirmed',
            'etag-shape': 'confirmed',
            'sync-collection': 'confirmed',
            'sync-limit': 'confirmed',
            'skeleton-backend': 'skipped',
            'request-pacing': 'confirmed',
        });
        expect(fake.requests.some((r) => WRITE_METHODS.has(r.method))).toBe(false);
        expect(fake.requests.every((r) => r.url.hostname === 'caldav.icloud.com' || r.url.hostname === 'p42-caldav.icloud.com')).toBe(true);
        expect(report.mode).toEqual({ readOnly: true, write: false, invite: false, cleanup: false });
        expect(report.cleanup).toBeNull();
        expect(report.totals.requests).toBeLessThan(120);
        expect(report.redaction.scrubbedOccurrences).toBe(0);
    });

    test('evidence holds shapes and counts', async () => {
        const report = await probe(standardAccount(), READ_ONLY, creds);
        const discovery = check(report, 'discovery').evidence;
        expect(String(discovery.principalPathShape)).toBe('/<id>/principal/');
        expect(String(discovery.homePathShape)).toBe('/<id>/calendars/');
        expect(discovery.homeHostMatchesPerAccountPattern).toBe(true);
        expect(discovery.homeHrefHasExplicitPort).toBe(true);
        expect(discovery.wellKnownRedirects).toBe(1);
        expect(check(report, 'auth-app-password').evidence).toEqual({ authSucceeded: true, passwordContainsHyphens: true, setCookieSeen: false });
        const dav = check(report, 'dav-capabilities').evidence;
        expect(dav.homeTokens).toContain('calendar-auto-schedule');
        expect(dav.homeOtherTokenCount).toBe(1);
        expect(check(report, 'scheduling-properties').evidence).toMatchObject({ 'schedule-outbox-URL': true, 'calendar-user-address-set': true, mailtoAddressCount: 2 });
        const collections = check(report, 'collections').evidence;
        expect(collections.byKind).toEqual({ owned: 3, sharedWithMe: 1, sharedByMe: 1, subscribed: 1 });
        expect(collections.byComponent).toEqual({ VEVENT: 5, VTODO: 2, none: 0 });
        expect(collections.privileges).toEqual({ writable: 4, readOnly: 2, unknown: 0 });
        expect(collections.otherCollectionTypes as readonly string[]).toEqual(['notification', 'schedule-inbox', 'schedule-outbox']);
        expect((collections.propertyReturnCounts as Record<string, number>)['calendar-timezone']).toBe(0);
        expect((collections.propertyReturnCounts as Record<string, number>).displayname).toBe(6);
        const text = check(report, 'text-match-read').evidence;
        expect(text).toMatchObject({ totalInCalendar: 4, expectedMatches: 2, matched: 4, nonceMatched: 4 });
        const sync = check(report, 'sync-collection').evidence;
        expect(sync.initialStatus).toBe(207);
        expect(sync.secondChangeCount).toBe(0);
        expect(sync.invalidTokenStatus).toBe(403);
        expect(sync.invalidTokenPreconditions as readonly string[]).toEqual(['valid-sync-token']);
        expect(check(report, 'etag-shape').evidence.getMatchesReport).toBe(true);
        expect(check(report, 'free-busy-query').evidence.status).toBe(400);
        expect(check(report, 'request-pacing').evidence.burstSequentialStatuses).toEqual({ 207: 10 });
        expect(check(report, 'request-pacing').evidence.burstParallelStatuses).toEqual({ 207: 5 });
    });

    test('the other behaviours flip the outcomes', async () => {
        const fake = standardAccount(PLAIN, { expand: true, textMatch: true, freeBusyStatus: 200, uidFilterStatus: 207, syncLimitHonoured: true, weakEtags: true });
        const report = await probe(fake, READ_ONLY, creds);
        expect(check(report, 'expand-read').outcome).toBe('confirmed');
        expect(check(report, 'text-match-read').outcome).toBe('confirmed');
        expect(check(report, 'text-match-read').evidence).toMatchObject({ expectedMatches: 2, matched: 2, nonceMatched: 0 });
        expect(check(report, 'free-busy-query').outcome).toBe('refuted');
        expect(check(report, 'uid-filter').outcome).toBe('refuted');
        expect(check(report, 'sync-limit').outcome).toBe('refuted');
        expect(check(report, 'etag-shape').outcome).toBe('refuted');
    });

    test('a server that refuses Depth: 0 on sync-collection gets one recorded Depth: 1 fallback', async () => {
        const report = await probe(standardAccount(PLAIN, { syncDepth: '1' }), READ_ONLY, creds);
        expect(check(report, 'sync-collection').outcome).toBe('confirmed');
        expect(check(report, 'sync-collection').evidence).toMatchObject({ depthAccepted: 1, invalidTokenStatus: 403 });
        expect(check(report, 'sync-limit').outcome).toBe('confirmed');
        const zero = await probe(standardAccount(), READ_ONLY, creds);
        expect(check(zero, 'sync-collection').evidence.depthAccepted).toBe(0);
    });

    test('one failing window query skips that calendar only', async () => {
        const fake = standardAccount(PLAIN, {
            hook: (req) => (req.method === 'REPORT' && req.url.pathname.endsWith('/home-work/') && req.body.includes('calendar-query') ? new Response('x'.repeat(64), { status: 207 }) : undefined),
        });
        const report = await probe(fake, READ_ONLY, creds);
        const evidence = check(report, 'time-range').evidence;
        expect(evidence.calendarsQueried).toBe(4);
        expect(check(report, 'time-range').outcome).toBe('confirmed');
        const oversized = standardAccount(PLAIN, {
            hook: (req) => (req.method === 'REPORT' && req.url.pathname.endsWith('/home/') && req.body.includes('calendar-data/>') ? new Response('y'.repeat(70_000), { status: 207 }) : undefined),
        });
        const second = await probe(oversized, READ_ONLY, creds, { limits: { maxBodyBytes: 65_536 } });
        expect(check(second, 'time-range').evidence.windowStatuses).toMatchObject({ 0: 1 });
        expect(check(second, 'time-range').evidence.calendarsQueried).toBe(4);
    });

    test('a rejected password stops after discovery with fixed codes', async () => {
        const fake = standardAccount();
        const report = await probe(fake, READ_ONLY, { appleId: creds.appleId, appPassword: 'wrongpassword' });
        expect(check(report, 'discovery').outcome).toBe('error');
        expect(check(report, 'discovery').summary).toContain('401');
        expect(check(report, 'auth-app-password').outcome).toBe('refuted');
        expect(check(report, 'auth-app-password').evidence.passwordContainsHyphens).toBe(false);
        expect(check(report, 'collections').outcome).toBe('skipped');
        expect(fake.requests.length).toBe(1);
    });

    test('a home on the discovery host refutes the per-account claim but still probes', async () => {
        const fake = standardAccount();
        Object.defineProperty(fake, 'host', { value: 'caldav.icloud.com' });
        const report = await probe(fake, READ_ONLY, creds);
        expect(check(report, 'discovery').outcome).toBe('refuted');
        expect(check(report, 'discovery').evidence.homeHostIsDiscoveryHost).toBe(true);
        expect(check(report, 'collections').outcome).toBe('confirmed');
    });

    test('a calendar home outside the fixed-host rule is never contacted', async () => {
        const fake = standardAccount(PLAIN, {
            hook: (req) => {
                if (req.url.pathname.endsWith('/principal/') && req.method === 'PROPFIND') {
                    return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/x/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>https://evil.example/10000000001/calendars/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 });
                }
                return undefined;
            },
        });
        const report = await probe(fake, READ_ONLY, creds);
        expect(check(report, 'discovery').outcome).toBe('refuted');
        expect(check(report, 'discovery').evidence.homeAllowedByHostRule).toBe(false);
        expect(check(report, 'collections').outcome).toBe('skipped');
        expect(fake.requests.every((r) => r.url.hostname.endsWith('.icloud.com'))).toBe(true);
    });

    test('throttling stops a check, records Retry-After, and the run continues', async () => {
        const fake = standardAccount(PLAIN, {
            hook: (req) => (req.method === 'REPORT' && req.body.includes('free-busy-query') ? new Response('busy', { status: 503, headers: { 'retry-after': '3' } }) : undefined),
        });
        const report = await probe(fake, READ_ONLY, creds);
        const freeBusy = check(report, 'free-busy-query');
        expect(freeBusy.outcome).toBe('inconclusive');
        expect(freeBusy.evidence).toMatchObject({ status: 503, retryAfterSeconds: 3 });
        expect(check(report, 'uid-filter').outcome).toBe('confirmed');
        expect(check(report, 'request-pacing').outcome).toBe('refuted');
    });
});

describe('tolerance of unexpected responses', () => {
    const chaos: [string, (n: number) => Response][] = [
        ['500', () => new Response('oops', { status: 500 })],
        ['404', () => new Response('nope', { status: 404 })],
        ['garbage 207', () => new Response('<<<not xml', { status: 207 })],
        ['empty multistatus', () => new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 })],
        ['wrong root', () => new Response('<d:error xmlns:d="DAV:"/>', { status: 207 })],
        ['200 text', () => new Response('hello', { status: 200 })],
        ['redirect without location', () => new Response(null, { status: 302 })],
        ['redirect to another host', () => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } })],
        ['redirect loop', () => new Response(null, { status: 307, headers: { location: '/loop' } })],
        ['network error', () => { throw new Error('boom'); }],
        ['alternating', (n) => (n % 2 === 0 ? new Response('x', { status: 400 }) : new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a/</d:href></d:response></d:multistatus>', { status: 207 }))],
    ];
    for (const [name, respond] of chaos) {
        for (const after of [0, 4, 9, 25]) {
            test(`${name} after ${after} requests never crashes or reports an internal error`, async () => {
                const fake = standardAccount(PLAIN, { hook: (_req, count) => (count > after ? respond(count) : undefined) });
                for (const flags of [READ_ONLY, { write: true, invite: false, cleanup: false }]) {
                    const report = await probe(fake, flags, creds);
                    const errors = report.checks.filter((c) => c.outcome === 'error' && !c.summary.includes('401'));
                    expect(errors.map((c) => c.id)).toEqual([]);
                    expect(fake.requests.every((r) => r.url.hostname.endsWith('.icloud.com'))).toBe(true);
                }
            });
        }
    }
});

describe('skeleton backend check', () => {
    const load = (impl: unknown): (() => Promise<BackendLoad>) => async () => ({ status: 'loaded', module: { createICloudBackend: impl } });

    test('runs discover and listCalendars through the guarded fetch', async () => {
        const fake = standardAccount();
        const seen: string[] = [];
        const factory = (options?: { fetch?: typeof fetch }) => {
            const f = options?.fetch;
            if (f === undefined) {
                throw new Error('no fetch');
            }
            return {
                discover: async () => {
                    const res = await f('https://caldav.icloud.com/', { method: 'PROPFIND', headers: { depth: '0' }, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', redirect: 'manual' });
                    seen.push(String(res.status));
                    return { principalUrl: 'https://caldav.icloud.com/10000000001/principal/', calendarHomeUrl: 'https://p42-caldav.icloud.com/10000000001/calendars/' };
                },
                validate: async () => 'valid',
                listCalendars: async () => [{ id: '/a/', displayName: 'secret', components: ['VEVENT'], color: null }],
            };
        };
        const report = await probe(fake, READ_ONLY, creds, { loadBackend: load(factory) });
        const result = check(report, 'skeleton-backend');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ discoverOk: true, listOk: true, calendarCount: 1, validateResult: 'valid', principalMatchesProbe: true, homeMatchesProbe: true, countMatchesProbe: false });
        expect(seen).toEqual(['207']);
    });

    test('a backend failure is reported by code only', async () => {
        class FakeCalDavError extends Error {
            constructor(public readonly code: string) { super('detail with secret'); }
        }
        const factory = () => ({
            discover: async () => { throw new FakeCalDavError('protocol'); },
            validate: async () => 'temporary',
            listCalendars: async () => [],
        });
        const report = await probe(standardAccount(), READ_ONLY, creds, { loadBackend: load(factory) });
        const result = check(report, 'skeleton-backend');
        expect(result.outcome).toBe('refuted');
        expect(String(result.evidence.discoverError)).toBe('protocol');
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    test('i2: a backend that calls the global fetch directly cannot reach the network, and the global is restored', async () => {
        const original = globalThis.fetch;
        let realCalls = 0;
        const spy = Object.assign(async () => { realCalls++; return new Response('x'); }, { preconnect: () => undefined }) as typeof fetch;
        globalThis.fetch = spy;
        try {
            let insideError = '';
            const factory = () => ({
                discover: async () => {
                    try {
                        await fetch('https://caldav.icloud.com/', { method: 'PROPFIND' });
                    } catch (error) {
                        insideError = error instanceof Error ? error.name : 'other';
                        throw error;
                    }
                    return { principalUrl: 'https://caldav.icloud.com/1/principal/', calendarHomeUrl: 'https://p42-caldav.icloud.com/1/calendars/' };
                },
                validate: async () => 'valid',
                listCalendars: async () => [],
            });
            const report = await probe(standardAccount(), READ_ONLY, creds, { loadBackend: load(factory) });
            expect(realCalls).toBe(0);
            expect(insideError).not.toBe('');
            expect(check(report, 'skeleton-backend').evidence).toMatchObject({ discoverOk: false });
            expect(globalThis.fetch).toBe(spy);
        } finally {
            globalThis.fetch = original;
        }
    });

    test('M1: the backend check does not run when discovery failed', async () => {
        let loaded = 0;
        const report = await probe(standardAccount(), READ_ONLY, { appleId: creds.appleId, appPassword: 'wrongpassword' }, { loadBackend: async () => { loaded++; return { status: 'absent' }; } });
        expect(loaded).toBe(0);
        expect(check(report, 'skeleton-backend').outcome).toBe('skipped');
    });

    test('a module that fails to import is an error, a missing export is an error', async () => {
        const failed = await probe(standardAccount(), READ_ONLY, creds, { loadBackend: async () => ({ status: 'import_failed' }) });
        expect(check(failed, 'skeleton-backend').outcome).toBe('error');
        const noExport = await probe(standardAccount(), READ_ONLY, creds, { loadBackend: async () => ({ status: 'loaded', module: {} }) });
        expect(check(noExport, 'skeleton-backend').outcome).toBe('error');
    });
});
