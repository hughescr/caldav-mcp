import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { CalDavError, type CalDavAuth, type CalDavErrorCode, type CalendarSummary, type Discovery } from '../src/caldav/contracts';
import { createICloudBackend } from '../src/caldav/icloud';
import { withRequestBudget } from '../src/request-budget';
import { getEvent, listEvents, searchEvents } from '../src/calendar/read';
import { createReadBudget } from '../src/calendar/budget';
import {
    type FakeHandler,
    createFakeFetch,
    fixture,
    hangUntilAborted,
    redirectResponse,
    xmlResponse,
} from './fixtures/caldav/fake-fetch';

const ROOT = 'https://caldav.icloud.com/';
const PRINCIPAL = 'https://caldav.icloud.com/10000000001/principal/';
const HOME = 'https://p42-caldav.icloud.com/10000000001/calendars/';

const AUTH: CalDavAuth = { appleId: 'user@example.invalid', appPassword: 'abcd-efgh-ijkl-mnop' };
const BASIC = `Basic ${Buffer.from(`${AUTH.appleId}:${AUTH.appPassword}`, 'utf8').toString('base64')}`;
const DISCOVERY: Discovery = { principalUrl: PRINCIPAL, calendarHomeUrl: HOME };

const SECRETS = [AUTH.appPassword, AUTH.appleId, BASIC, BASIC.slice('Basic '.length)];

/** Everything an error could expose if it were logged or serialised. */
function exposedText(error: unknown): string {
    const parts = [String(error), Bun.inspect(error), JSON.stringify(error)];
    if (error instanceof Error) {
        parts.push(error.message, error.stack ?? '', String(error.cause ?? ''));
    }
    return parts.join('\n');
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
}

async function codeOf(promise: Promise<unknown>): Promise<CalDavErrorCode | 'resolved' | 'other'> {
    try {
        await promise;
        return 'resolved';
    } catch (error) {
        if (error instanceof CalDavError) {
            const text = exposedText(error);
            for (const secret of SECRETS) {
                expect(text).not.toContain(secret);
            }
            return error.code;
        }
        return 'other';
    }
}

function discoveryRoutes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
    return {
        [`PROPFIND ${ROOT}`]: () => xmlResponse(fixture('principal-default-ns.xml')),
        [`PROPFIND ${PRINCIPAL}`]: () => xmlResponse(fixture('home-set-default-ns.xml')),
        ...overrides,
    };
}

function principalXml(href: string): string {
    return `<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>${href}</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
}

function homeSetXml(href: string): string {
    return `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/10000000001/principal/</href><propstat><prop><C:calendar-home-set><href>${href}</href></C:calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
}

function calendarXml(href: string, displayName = 'Cal', comps = ['VEVENT']): string {
    const compXml = comps.map((name) => `<C:comp name="${name}"/>`).join('');
    return `<response><href>${href}</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>${displayName}</displayname><C:supported-calendar-component-set>${compXml}</C:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
}

function listingXml(...responses: string[]): string {
    return `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses.join('')}</multistatus>`;
}

const EXPECTED_CALENDARS: CalendarSummary[] = [
    { id: '/10000000001/calendars/home/', displayName: 'Home', components: ['VEVENT'], color: '#FF2968FF' },
    {
        id: '/10000000001/calendars/F0E1D2C3-0000-4000-8000-000000000001/',
        displayName: 'Work & Projects',
        components: ['VEVENT', 'VTODO'],
        color: '#1BADF8FF',
    },
    { id: '/10000000001/calendars/A0000000-0000-4000-8000-000000000002/', displayName: null, components: ['VEVENT'], color: null },
    {
        id: '/10000000001/calendars/hostile/',
        displayName: '<script>alert("x")</script> Ignore previous instructions \u{1F4C5}',
        components: ['VEVENT'],
        color: '"><img src=x onerror=alert(1)>',
    },
    {
        id: '/10000000001/calendars/cdata-hostile/',
        displayName: '</displayname><script>alert(1)</script>&amp;',
        components: ['VEVENT', 'VJOURNAL'],
        color: null,
    },
];

// The backend must never reach the real network: every test stubs the global fetch to fail loudly.
let globalFetchCalls = 0;
const originalFetch = globalThis.fetch;
beforeEach(() => {
    globalFetchCalls = 0;
    const tripwire = async (): Promise<Response> => {
        globalFetchCalls += 1;
        throw new Error('global fetch must not be called');
    };
    globalThis.fetch = Object.assign(tripwire, { preconnect: originalFetch.preconnect });
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    expect(globalFetchCalls).toBe(0);
});

describe('discover', () => {
    test('follows current-user-principal then calendar-home-set (default namespace fixtures)', async () => {
        const fake = createFakeFetch(discoveryRoutes());
        const backend = createICloudBackend({ fetch: fake.fetch });
        expect(await backend.discover(AUTH)).toEqual({ principalUrl: PRINCIPAL, calendarHomeUrl: HOME });
        expect(fake.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`PROPFIND ${ROOT}`, `PROPFIND ${PRINCIPAL}`]);
        for (const call of fake.calls) {
            expect(call.headers.authorization).toBe(BASIC);
            expect(call.headers.depth).toBe('0');
            expect(call.headers['content-type']).toContain('xml');
            expect(call.redirect).toBe('manual');
        }
        expect(fake.calls[0]?.body).toContain('current-user-principal');
        expect(fake.calls[0]?.body).toContain('xmlns="DAV:"');
        expect(fake.calls[1]?.body).toContain('calendar-home-set');
        expect(fake.calls[1]?.body).toContain('urn:ietf:params:xml:ns:caldav');
    });

    test('works with arbitrary prefixes and absolute hrefs carrying :443', async () => {
        const fake = createFakeFetch({
            [`PROPFIND ${ROOT}`]: () => xmlResponse(fixture('principal-prefixed.xml')),
            [`PROPFIND ${PRINCIPAL}`]: () => xmlResponse(fixture('home-set-prefixed.xml')),
        });
        const backend = createICloudBackend({ fetch: fake.fetch });
        expect(await backend.discover(AUTH)).toEqual({ principalUrl: PRINCIPAL, calendarHomeUrl: HOME });
    });

    test('the first request goes to https://caldav.icloud.com/ and nowhere else', async () => {
        const fake = createFakeFetch(discoveryRoutes());
        await createICloudBackend({ fetch: fake.fetch }).discover(AUTH);
        expect(fake.calls[0]?.url).toBe(ROOT);
    });

    test('a UTF-8 password is encoded as UTF-8 in Basic auth', async () => {
        const auth = { appleId: AUTH.appleId, appPassword: 'pässwörd-\u{1F511}' };
        const fake = createFakeFetch(discoveryRoutes());
        await createICloudBackend({ fetch: fake.fetch }).discover(auth);
        const expected = `Basic ${Buffer.from(`${auth.appleId}:${auth.appPassword}`, 'utf8').toString('base64')}`;
        expect(fake.calls[0]?.headers.authorization).toBe(expected);
    });

    test('an Apple ID containing a colon is refused before any request', async () => {
        const fake = createFakeFetch(discoveryRoutes());
        const backend = createICloudBackend({ fetch: fake.fetch });
        expect(await codeOf(backend.discover({ appleId: 'a:b@example.invalid', appPassword: 'x' }))).toBe('unauthorized');
        expect(await codeOf(backend.discover({ appleId: '', appPassword: 'x' }))).toBe('unauthorized');
        expect(await codeOf(backend.discover({ appleId: 'a\nb@example.invalid', appPassword: 'x' }))).toBe('unauthorized');
        expect(fake.calls).toHaveLength(0);
    });

    const forbiddenPrincipals = [
        'https://evil.example/10000000001/principal/',
        'http://caldav.icloud.com/10000000001/principal/',
        'https://p1-caldav.icloud.com@evil.example/principal/',
        'https://caldav.icloud.com.evil.example/principal/',
        'https://caldav.icloud.com:8443/principal/',
        '//evil.example/principal/',
        'https://169.254.169.254/latest/',
    ];
    for (const href of forbiddenPrincipals) {
        test(`a principal href of ${href} => forbidden_host, no further request`, async () => {
            const fake = createFakeFetch(discoveryRoutes({ [`PROPFIND ${ROOT}`]: () => xmlResponse(principalXml(href)) }));
            const backend = createICloudBackend({ fetch: fake.fetch });
            expect(await codeOf(backend.discover(AUTH))).toBe('forbidden_host');
            expect(fake.calls).toHaveLength(1);
        });
    }

    const forbiddenHomes = [
        'https://evil.example/10000000001/calendars/',
        'http://p42-caldav.icloud.com/10000000001/calendars/',
        'https://p0000-caldav.icloud.com/10000000001/calendars/',
        'https://user@p42-caldav.icloud.com/10000000001/calendars/',
        'https://[::1]/calendars/',
    ];
    for (const href of forbiddenHomes) {
        test(`a calendar-home-set href of ${href} => forbidden_host`, async () => {
            const fake = createFakeFetch(discoveryRoutes({ [`PROPFIND ${PRINCIPAL}`]: () => xmlResponse(homeSetXml(href)) }));
            const backend = createICloudBackend({ fetch: fake.fetch });
            expect(await codeOf(backend.discover(AUTH))).toBe('forbidden_host');
            expect(fake.calls).toHaveLength(2);
        });
    }

    test('a relative calendar-home-set href resolves against the principal URL', async () => {
        const fake = createFakeFetch(discoveryRoutes({
            [`PROPFIND ${PRINCIPAL}`]: () => xmlResponse(homeSetXml('../calendars/')),
        }));
        const discovery = await createICloudBackend({ fetch: fake.fetch }).discover(AUTH);
        expect(discovery.calendarHomeUrl).toBe('https://caldav.icloud.com/10000000001/calendars/');
    });

    test('a redirect from the root to a per-account host is followed and hrefs resolve against the final URL', async () => {
        const moved = 'https://p42-caldav.icloud.com/';
        const fake = createFakeFetch({
            [`PROPFIND ${ROOT}`]: () => redirectResponse(moved, 301),
            [`PROPFIND ${moved}`]: () => xmlResponse(principalXml('/10000000001/principal/')),
            'PROPFIND https://p42-caldav.icloud.com/10000000001/principal/': () =>
                xmlResponse(homeSetXml('/10000000001/calendars/')),
        });
        const discovery = await createICloudBackend({ fetch: fake.fetch }).discover(AUTH);
        expect(discovery).toEqual({
            principalUrl: 'https://p42-caldav.icloud.com/10000000001/principal/',
            calendarHomeUrl: HOME,
        });
        expect(fake.calls.every((call) => call.headers.authorization === BASIC)).toBe(true);
    });

    test('a redirect to a foreign host => forbidden_host without sending credentials there', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${ROOT}`]: () => redirectResponse('https://evil.example/', 302) });
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).discover(AUTH))).toBe('forbidden_host');
        expect(fake.calls.map((call) => call.url)).toEqual([ROOT]);
    });

    const statusCases: [number, CalDavErrorCode][] = [
        [401, 'unauthorized'],
        [403, 'temporary'],
        [408, 'temporary'],
        [429, 'temporary'],
        [500, 'temporary'],
        [502, 'temporary'],
        [503, 'temporary'],
        [504, 'temporary'],
        [400, 'protocol'],
        [404, 'protocol'],
        [405, 'protocol'],
        [302, 'protocol'],
        [204, 'protocol'],
    ];
    for (const [status, code] of statusCases) {
        test(`HTTP ${status} at the root => ${code}`, async () => {
            const fake = createFakeFetch({ [`PROPFIND ${ROOT}`]: () => new Response(status === 204 ? null : 'x', { status }) });
            expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).discover(AUTH))).toBe(code);
            expect(fake.calls).toHaveLength(1);
        });
        test(`HTTP ${status} at the principal => ${code}`, async () => {
            const fake = createFakeFetch(discoveryRoutes({
                [`PROPFIND ${PRINCIPAL}`]: () => new Response(status === 204 ? null : 'x', { status }),
            }));
            expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).discover(AUTH))).toBe(code);
        });
    }

    const protocolBodies: [string, string][] = [
        ['an HTML page with 207', '<html><body>Sign in</body></html>'],
        ['an empty body', ''],
        ['a non-multistatus root', '<error xmlns="DAV:"/>'],
        ['a 404 propstat for the property', '<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>'],
        ['an unauthenticated principal', '<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><unauthenticated/></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>'],
        ['an empty principal href', principalXml(' ')],
        ['two principals', `<multistatus xmlns="DAV:">${['/a/', '/b/'].map((href) => `<response><href>/</href><propstat><prop><current-user-principal><href>${href}</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response>`).join('')}</multistatus>`],
        ['two hrefs in one property', '<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/a/</href><href>/b/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>'],
        ['the property in the wrong namespace', '<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><x:current-user-principal xmlns:x="urn:x"><href>/10000000001/principal/</href></x:current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>'],
        ['a DOCTYPE', '<!DOCTYPE m [<!ENTITY e "x">]><multistatus xmlns="DAV:"/>'],
        ['an unparsable href', principalXml('https://[bad/')],
    ];
    for (const [label, body] of protocolBodies) {
        test(`${label} at the root => protocol`, async () => {
            const fake = createFakeFetch({ [`PROPFIND ${ROOT}`]: () => xmlResponse(body) });
            expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).discover(AUTH))).toBe('protocol');
            expect(fake.calls).toHaveLength(1);
        });
    }

    test('a missing calendar-home-set => protocol', async () => {
        const body = '<multistatus xmlns="DAV:"><response><href>/10000000001/principal/</href><propstat><prop><displayname>x</displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
        const fake = createFakeFetch(discoveryRoutes({ [`PROPFIND ${PRINCIPAL}`]: () => xmlResponse(body) }));
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).discover(AUTH))).toBe('protocol');
    });

    test('a calendar-home-set in the DAV: namespace (wrong) => protocol', async () => {
        const body = '<multistatus xmlns="DAV:"><response><href>/10000000001/principal/</href><propstat><prop><calendar-home-set><href>/10000000001/calendars/</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
        const fake = createFakeFetch(discoveryRoutes({ [`PROPFIND ${PRINCIPAL}`]: () => xmlResponse(body) }));
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).discover(AUTH))).toBe('protocol');
    });

    test('a network error => temporary', async () => {
        const backend = createICloudBackend({
            fetch: async () => {
                throw new TypeError(`fetch failed for ${BASIC}`);
            },
        });
        expect(await codeOf(backend.discover(AUTH))).toBe('temporary');
    });

    test('a timeout => temporary', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${ROOT}`]: (_request, signal) => hangUntilAborted(signal) });
        const backend = createICloudBackend({ fetch: fake.fetch });
        const started = Date.now();
        const code = await withRequestBudget(() => 2040, () => codeOf(backend.discover(AUTH)));
        expect(code).toBe('temporary');
        expect(Date.now() - started).toBeLessThan(2000);
    });

    test('an oversize response => protocol', async () => {
        const huge = `<multistatus xmlns="DAV:"><!--${'x'.repeat(1024 * 1024)}--></multistatus>`;
        const fake = createFakeFetch({ [`PROPFIND ${ROOT}`]: () => xmlResponse(huge) });
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).discover(AUTH))).toBe('protocol');
    });
});

describe('validate', () => {
    test('207 => valid, with one Depth 0 PROPFIND to the principal carrying Basic auth', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${PRINCIPAL}`]: () => xmlResponse(fixture('home-set-default-ns.xml')) });
        expect(await createICloudBackend({ fetch: fake.fetch }).validate(AUTH, DISCOVERY)).toBe('valid');
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]?.method).toBe('PROPFIND');
        expect(fake.calls[0]?.url).toBe(PRINCIPAL);
        expect(fake.calls[0]?.headers.depth).toBe('0');
        expect(fake.calls[0]?.headers.authorization).toBe(BASIC);
    });

    test('200 is not proof of authentication => temporary', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${PRINCIPAL}`]: () => xmlResponse('<multistatus xmlns="DAV:"/>', 200) });
        expect(await createICloudBackend({ fetch: fake.fetch }).validate(AUTH, DISCOVERY)).toBe('temporary');
    });

    test('401 => expired', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${PRINCIPAL}`]: () => new Response('no', { status: 401 }) });
        expect(await createICloudBackend({ fetch: fake.fetch }).validate(AUTH, DISCOVERY)).toBe('expired');
    });

    for (const status of [403, 404, 400, 429, 500, 503, 204, 302]) {
        test(`${status} => temporary`, async () => {
            const fake = createFakeFetch({
                [`PROPFIND ${PRINCIPAL}`]: () => new Response(status === 204 ? null : 'x', { status }),
            });
            expect(await createICloudBackend({ fetch: fake.fetch }).validate(AUTH, DISCOVERY)).toBe('temporary');
        });
    }

    test('a network error => temporary, never a throw', async () => {
        const backend = createICloudBackend({
            fetch: () => {
                throw new Error('synchronous explosion');
            },
        });
        expect(await backend.validate(AUTH, DISCOVERY)).toBe('temporary');
    });

    test('a timeout => temporary', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${PRINCIPAL}`]: (_request, signal) => hangUntilAborted(signal) });
        const backend = createICloudBackend({ fetch: fake.fetch });
        expect(await withRequestBudget(() => 2030, () => backend.validate(AUTH, DISCOVERY))).toBe('temporary');
    });

    test('a redirect to a foreign host => temporary, credentials not sent there', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${PRINCIPAL}`]: () => redirectResponse('https://evil.example/', 307) });
        expect(await createICloudBackend({ fetch: fake.fetch }).validate(AUTH, DISCOVERY)).toBe('temporary');
        expect(fake.calls).toHaveLength(1);
    });

    for (const principalUrl of ['https://evil.example/principal/', 'http://caldav.icloud.com/x/', 'not a url', '']) {
        test(`a stored principal URL of "${principalUrl}" => temporary with no request`, async () => {
            const fake = createFakeFetch();
            const backend = createICloudBackend({ fetch: fake.fetch });
            expect(await backend.validate(AUTH, { ...DISCOVERY, principalUrl })).toBe('temporary');
            expect(fake.calls).toHaveLength(0);
        });
    }

    test('malformed credentials => expired with no request', async () => {
        const fake = createFakeFetch();
        const backend = createICloudBackend({ fetch: fake.fetch });
        expect(await backend.validate({ appleId: 'a:b', appPassword: 'x' }, DISCOVERY)).toBe('expired');
        expect(fake.calls).toHaveLength(0);
    });
});

for (const mode of ['oversized', 'never-finishing'] as const) {
    test(`concurrent ${mode} 401 bodies stop dispatch and mark reconnect once`, async () => {
        jest.useFakeTimers();
        let cancelled = 0;
        let marked = 0;
        const ids = ['a', 'b', 'c', 'd', 'e'].map(name => `/10000000001/calendars/${name}/`);
        const fake = createFakeFetch({
            [`PROPFIND ${HOME}`]: () => xmlResponse(listingXml(...ids.map(id => calendarXml(id)))),
            ...Object.fromEntries(ids.map(id => [`REPORT ${new URL(id, HOME).href}`, () => new Response(new ReadableStream<Uint8Array>({
                start(controller) { if (mode === 'oversized') { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); } },
                cancel() { cancelled++; },
            }), { status: 401 })])),
        });
        const backend = createICloudBackend({ fetch: fake.fetch });
        const pending = listEvents({ backend, auth: AUTH, discovery: DISCOVERY, accountId: 'synthetic', budget: createReadBudget({ now: () => 0 }), onUnauthorized: async () => { marked++; } }, { range: { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' } });
        try {
            // Drain finite async transport chains; fake deadlines also let the unfixed implementation finish.
            for (let round = 0; round < 3; round++) {
                for (let step = 0; step < 100; step++) { await Promise.resolve(); }
                jest.advanceTimersByTime(10_000);
            }
            const result = await pending;
            expect(result.calendars.map(item => item.status)).toEqual(ids.map(() => 'reconnect_required'));
            expect(fake.calls.filter(call => call.method === 'REPORT')).toHaveLength(3);
            expect(cancelled).toBe(3);
            expect(marked).toBe(1);
        } finally { jest.useRealTimers(); }
    });
}

describe('listCalendars', () => {
    test('maps the default-namespace fixture, filtering non-calendar and VTODO-only collections', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(fixture('calendars-default-ns.xml')) });
        const calendars = await createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY);
        expect(calendars).toEqual(EXPECTED_CALENDARS);
        expect(fake.calls).toHaveLength(1);
        const [call] = fake.calls;
        expect(call?.method).toBe('PROPFIND');
        expect(call?.headers.depth).toBe('1');
        expect(call?.headers.authorization).toBe(BASIC);
        for (const needle of ['resourcetype', 'displayname', 'supported-calendar-component-set', 'calendar-color', 'http://apple.com/ns/ical/']) {
            expect(call?.body).toContain(needle);
        }
    });

    test('the prefixed fixture (swapped prefixes, decoy properties) gives the same result', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(fixture('calendars-prefixed.xml')) });
        const calendars = await createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY);
        expect(calendars).toEqual(EXPECTED_CALENDARS);
    });

    test('returns a very long display name intact', async () => {
        const long = 'A'.repeat(100_000);
        const fake = createFakeFetch({
            [`PROPFIND ${HOME}`]: () => xmlResponse(listingXml(calendarXml('/10000000001/calendars/long/', long))),
        });
        const [calendar] = await createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY);
        expect(calendar?.displayName).toBe(long);
    });

    test('an empty display name is null', async () => {
        const fake = createFakeFetch({
            [`PROPFIND ${HOME}`]: () => xmlResponse(listingXml(calendarXml('/10000000001/calendars/e/', ''))),
        });
        const [calendar] = await createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY);
        expect(calendar?.displayName).toBeNull();
    });

    test('a collection without supported-calendar-component-set fails membership closed', async () => {
        const body = listingXml('<response><href>/10000000001/calendars/x/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>');
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(body) });
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('temporary');
    });

    test('a response-level 404 entry fails membership closed', async () => {
        const body = listingXml(
            '<response><href>/10000000001/calendars/gone/</href><status>HTTP/1.1 404 Not Found</status></response>',
            calendarXml('/10000000001/calendars/ok/'),
        );
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(body) });
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('temporary');
    });

    for (const failure of ['response 500', 'component-set propstat 500', 'resourcetype propstat 500', 'all children failed']) {
        test(`membership ${failure} fails list/search and explicit selection before REPORT`, async () => {
            const id = '/10000000001/calendars/failed/';
            const property = failure.startsWith('resourcetype') ? '<resourcetype/>' : '<C:supported-calendar-component-set/>';
            const failed = failure.includes('propstat')
                ? `<response><href>${id}</href><propstat><prop>${failure.startsWith('resourcetype') ? '' : '<resourcetype><C:calendar/></resourcetype>'}</prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop>${property}</prop><status>HTTP/1.1 500 Failed</status></propstat></response>`
                : `<response><href>${id}</href><status>HTTP/1.1 500 Failed</status></response>`;
            const body = listingXml(failed, ...(failure === 'all children failed' ? [] : [calendarXml('/10000000001/calendars/ok/')]));
            const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(body) });
            const backend = createICloudBackend({ fetch: fake.fetch });
            expect(await codeOf(backend.listCalendars(AUTH, DISCOVERY))).toBe('temporary');
            const deps = () => ({ backend, auth: AUTH, discovery: DISCOVERY, accountId: 'synthetic', budget: createReadBudget(), onUnauthorized: async () => {} });
            const range = { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' };
            for (const call of [
                () => listEvents(deps(), { range }),
                () => searchEvents(deps(), { range, query: 'test' }),
                () => listEvents(deps(), { range, calendar_ids: [id] }),
                () => getEvent(deps(), { calendar_id: id, resource_href: `${id}e.ics` }),
            ]) {
                await expect(call()).rejects.toMatchObject({ code: 'temporarily_unavailable', message: 'temporarily_unavailable' });
            }
            expect(fake.calls.every(call => call.method === 'PROPFIND')).toBe(true);
        });
    }

    test('a successful membership property cannot hide a failed instance of the same property', async () => {
        for (const property of ['<resourcetype/>', '<C:supported-calendar-component-set/>']) {
            const entry = calendarXml('/10000000001/calendars/a/').replace('</response>', `<propstat><prop>${property}</prop><status>HTTP/1.1 500 Failed</status></propstat></response>`);
            const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(listingXml(entry)) });
            expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('temporary');
        }
    });

    test('duplicate component names are reported once', async () => {
        const fake = createFakeFetch({
            [`PROPFIND ${HOME}`]: () => xmlResponse(listingXml(calendarXml('/10000000001/calendars/d/', 'D', ['VEVENT', 'vevent', 'VTODO']))),
        });
        const [calendar] = await createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY);
        expect(calendar?.components).toEqual(['VEVENT', 'VTODO']);
    });

    test('a home URL stored without a trailing slash still bounds the children', async () => {
        const fake = createFakeFetch({
            'PROPFIND https://p42-caldav.icloud.com/10000000001/calendars': () =>
                xmlResponse(listingXml(calendarXml('/10000000001/calendars/'), calendarXml('/10000000001/calendars/a/'))),
        });
        const calendars = await createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, {
            ...DISCOVERY,
            calendarHomeUrl: 'https://p42-caldav.icloud.com/10000000001/calendars',
        });
        expect(calendars.map((calendar) => calendar.id)).toEqual(['/10000000001/calendars/a/']);
    });

    const escapingHrefs = [
        'https://evil.example/10000000001/calendars/x/',
        'https://p1-caldav.icloud.com/10000000001/calendars/x/',
        'https://caldav.icloud.com/10000000001/calendars/x/',
        'http://p42-caldav.icloud.com/10000000001/calendars/x/',
        // Same origin (origin ignores userinfo) but userinfo fails the host rule.
        'https://user@p42-caldav.icloud.com/10000000001/calendars/x/',
        'https://user:pw@p42-caldav.icloud.com:443/10000000001/calendars/x/',
        '//evil.example/10000000001/calendars/x/',
        '/10000000002/calendars/x/',
        '/10000000001/calendarsevil/',
        '/10000000001/calendars/../../10000000002/calendars/x/',
        '/10000000001/calendars/%2e%2e/%2e%2e/10000000002/calendars/x/',
        '../other/',
        '/10000000001/calendars/x/?q=1',
        '/10000000001/calendars/x/#frag',
        'https://[bad/',
    ];
    for (const href of escapingHrefs) {
        test(`a child href of ${href} => protocol`, async () => {
            const body = listingXml(calendarXml('/10000000001/calendars/ok/'), calendarXml(href));
            const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(body) });
            expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('protocol');
        });
    }

    test('an escaping href is refused even on a non-calendar entry', async () => {
        const body = listingXml('<response><href>https://evil.example/x/</href><status>HTTP/1.1 404 Not Found</status></response>');
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(body) });
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('protocol');
    });

    test('two entries for the same collection => protocol', async () => {
        const body = listingXml(
            calendarXml('/10000000001/calendars/a/'),
            calendarXml('https://P42-caldav.icloud.com:443/10000000001/calendars/x/../a/'),
        );
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(body) });
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('protocol');
    });

    for (const name of ['', 'V EVENT', '<script>', 'X'.repeat(65)]) {
        test(`a component name of ${JSON.stringify(name.slice(0, 12))} => protocol`, async () => {
            const escaped = name.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
            const body = listingXml(calendarXml('/10000000001/calendars/a/', 'A', [escaped]));
            const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(body) });
            expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('protocol');
        });
    }

    test('a comp element without a name => protocol', async () => {
        const body = listingXml('<response><href>/10000000001/calendars/a/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype><C:supported-calendar-component-set><C:comp/></C:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>');
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(body) });
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('protocol');
    });

    test('a display name with child elements => protocol', async () => {
        const body = listingXml(calendarXml('/10000000001/calendars/a/', '<b>bold</b>'));
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse(body) });
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('protocol');
    });

    test('an empty multistatus => no calendars', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse('<multistatus xmlns="DAV:"/>') });
        expect(await createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY)).toEqual([]);
    });

    for (const calendarHomeUrl of [
        'https://evil.example/10000000001/calendars/',
        'http://p42-caldav.icloud.com/10000000001/calendars/',
        'https://p42-caldav.icloud.com.evil.example/10000000001/calendars/',
        'garbage',
    ]) {
        test(`a stored home URL of ${calendarHomeUrl} => forbidden_host with no request`, async () => {
            const fake = createFakeFetch();
            const backend = createICloudBackend({ fetch: fake.fetch });
            expect(await codeOf(backend.listCalendars(AUTH, { ...DISCOVERY, calendarHomeUrl }))).toBe('forbidden_host');
            expect(fake.calls).toHaveLength(0);
        });
    }

    const statusCases: [number, CalDavErrorCode][] = [
        [401, 'unauthorized'],
        [403, 'temporary'],
        [429, 'temporary'],
        [500, 'temporary'],
        [503, 'temporary'],
        [404, 'protocol'],
        [200, 'protocol'],
    ];
    for (const [status, code] of statusCases) {
        test(`HTTP ${status} with a non-XML body => ${code}`, async () => {
            const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => new Response('<html>x</html>', { status }) });
            expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe(code);
        });
    }

    test('malformed XML => protocol', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${HOME}`]: () => xmlResponse('<multistatus xmlns="DAV:"><response>') });
        expect(await codeOf(createICloudBackend({ fetch: fake.fetch }).listCalendars(AUTH, DISCOVERY))).toBe('protocol');
    });

    test('a network error => temporary', async () => {
        const backend = createICloudBackend({
            fetch: async () => {
                throw new TypeError('socket hang up');
            },
        });
        expect(await codeOf(backend.listCalendars(AUTH, DISCOVERY))).toBe('temporary');
    });

    test('malformed credentials => unauthorized with no request', async () => {
        const fake = createFakeFetch();
        const backend = createICloudBackend({ fetch: fake.fetch });
        expect(await codeOf(backend.listCalendars({ appleId: 'a:b', appPassword: 'x' }, DISCOVERY))).toBe('unauthorized');
        expect(fake.calls).toHaveLength(0);
    });
});

describe('credential hygiene and isolation', () => {
    test('no error path exposes the password, Apple ID or Authorization value', async () => {
        const failures: FakeHandler[] = [
            () => new Response(`denied ${BASIC}`, { status: 401 }),
            () => new Response(`busy ${AUTH.appPassword}`, { status: 503 }),
            () => xmlResponse(`<html>${AUTH.appleId}</html>`),
            () => xmlResponse(principalXml(`https://evil.example/${AUTH.appPassword}/`)),
            () => redirectResponse(`https://evil.example/?u=${AUTH.appleId}`),
            () => {
                throw new Error(`boom ${BASIC} ${AUTH.appPassword}`);
            },
        ];
        for (const failure of failures) {
            const fake = createFakeFetch({ [`PROPFIND ${ROOT}`]: failure, [`PROPFIND ${HOME}`]: failure });
            const backend = createICloudBackend({ fetch: fake.fetch });
            for (const error of [await caught(backend.discover(AUTH)), await caught(backend.listCalendars(AUTH, DISCOVERY))]) {
                expect(error).toBeInstanceOf(CalDavError);
                const text = exposedText(error);
                for (const secret of SECRETS) {
                    expect(text).not.toContain(secret);
                }
            }
        }
    });

    test('the Authorization header appears only on outgoing requests, never in the request URL or body', async () => {
        const fake = createFakeFetch({
            ...discoveryRoutes(),
            [`PROPFIND ${HOME}`]: () => xmlResponse(fixture('calendars-default-ns.xml')),
        });
        const backend = createICloudBackend({ fetch: fake.fetch });
        await backend.discover(AUTH);
        await backend.validate(AUTH, DISCOVERY);
        await backend.listCalendars(AUTH, DISCOVERY);
        expect(fake.calls).toHaveLength(4);
        for (const call of fake.calls) {
            expect(call.headers.authorization).toBe(BASIC);
            for (const secret of SECRETS) {
                expect(call.url).not.toContain(secret);
                expect(call.body ?? '').not.toContain(secret);
            }
        }
    });

    test('with an injected fetch the global fetch is never called, on success or failure paths', async () => {
        const fake = createFakeFetch({
            ...discoveryRoutes(),
            [`PROPFIND ${HOME}`]: () => xmlResponse(fixture('calendars-default-ns.xml')),
        });
        const backend = createICloudBackend({ fetch: fake.fetch });
        await backend.discover(AUTH);
        await backend.validate(AUTH, DISCOVERY);
        await backend.listCalendars(AUTH, DISCOVERY);
        const failing = createICloudBackend({ fetch: createFakeFetch().fetch });
        await caught(failing.discover(AUTH));
        await failing.validate(AUTH, DISCOVERY);
        await caught(failing.listCalendars(AUTH, DISCOVERY));
        expect(globalFetchCalls).toBe(0);
    });

    test('without an injected fetch the global fetch is the transport (and stays host-guarded)', async () => {
        const backend = createICloudBackend();
        expect(await codeOf(backend.discover(AUTH))).toBe('temporary');
        expect(globalFetchCalls).toBe(1);
        globalFetchCalls = 0;
        expect(await codeOf(backend.listCalendars(AUTH, { ...DISCOVERY, calendarHomeUrl: 'https://evil.example/' }))).toBe('forbidden_host');
        expect(globalFetchCalls).toBe(0);
    });
});
