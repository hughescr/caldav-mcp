import { describe, expect, test } from 'bun:test';
import { CalDavError, type CalDavErrorCode } from '../src/caldav/contracts';
import { MAX_REDIRECTS, MAX_RESPONSE_BYTES, createGuardedFetch } from '../src/caldav/hosts';
import { withRequestBudget } from '../src/request-budget';
import { createFakeFetch, hangUntilAborted, redirectResponse, xmlResponse } from './fixtures/caldav/fake-fetch';

const ROOT = 'https://caldav.icloud.com/';
const AUTH = 'Basic dXNlckBleGFtcGxlLmludmFsaWQ6YWJjZC1lZmdoLWlqa2wtbW5vcA==';

async function codeOf(promise: Promise<unknown>): Promise<CalDavErrorCode | 'resolved' | 'other'> {
    try {
        await promise;
        return 'resolved';
    } catch (error) {
        return error instanceof CalDavError ? error.code : 'other';
    }
}

function propfindInit(extra: RequestInit = {}): RequestInit {
    return {
        method: 'PROPFIND',
        headers: { authorization: AUTH, depth: '0', 'content-type': 'application/xml; charset=utf-8' },
        body: '<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>',
        ...extra,
    };
}

describe('initial request URL', () => {
    const blocked = [
        'http://caldav.icloud.com/',
        'https://user:pw@caldav.icloud.com/',
        'https://p1-caldav.icloud.com@evil.example/',
        'https://caldav.icloud.com.evil.example/',
        'https://evil.example/caldav.icloud.com',
        'https://caldav.icloud.com:8443/',
        'https://caldav.icloud.com./',
        'https://17.248.1.1/',
        'https://[::1]/',
        'https://p0000-caldav.icloud.com/',
    ];
    for (const url of blocked) {
        test(`blocks ${url} before any request`, async () => {
            const fake = createFakeFetch({ [url]: () => xmlResponse('<x/>') });
            const guarded = createGuardedFetch(fake.fetch);
            expect(await codeOf(guarded(url, propfindInit()))).toBe('forbidden_host');
            expect(await codeOf(guarded(new URL(url), propfindInit()))).toBe('forbidden_host');
            expect(fake.calls).toHaveLength(0);
        });
    }

    test('blocks a Request object for a disallowed host before any request', async () => {
        const fake = createFakeFetch();
        const guarded = createGuardedFetch(fake.fetch);
        const request = new Request('https://evil.example/', { method: 'PROPFIND', headers: { authorization: AUTH } });
        expect(await codeOf(guarded(request))).toBe('forbidden_host');
        expect(fake.calls).toHaveLength(0);
    });
});

describe('allowed requests', () => {
    test('passes method, headers and body through and forces redirect: manual', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${ROOT}`]: () => xmlResponse('<ok/>') });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect(response.status).toBe(207);
        expect(await response.text()).toBe('<ok/>');
        expect(response.url).toBe(ROOT);
        expect(fake.calls).toHaveLength(1);
        const [call] = fake.calls;
        expect(call?.method).toBe('PROPFIND');
        expect(call?.headers.authorization).toBe(AUTH);
        expect(call?.headers.depth).toBe('0');
        expect(call?.body).toContain('current-user-principal');
        expect(call?.redirect).toBe('manual');
        expect(call?.hadSignal).toBe(true);
    });

    test('sends the normalized URL (lower-case host, default port dropped)', async () => {
        const fake = createFakeFetch({ 'https://p42-caldav.icloud.com/10000000001/': () => xmlResponse('<ok/>') });
        const guarded = createGuardedFetch(fake.fetch);
        await guarded('https://P42-CALDAV.icloud.com:443/10000000001/', propfindInit());
        expect(fake.calls[0]?.url).toBe('https://p42-caldav.icloud.com/10000000001/');
    });

    for (const redirect of ['follow', 'error'] as const) {
        test(`a caller asking for redirect: '${redirect}' still gets manual`, async () => {
            const fake = createFakeFetch({ [ROOT]: () => xmlResponse('<ok/>') });
            const guarded = createGuardedFetch(fake.fetch);
            await guarded(ROOT, propfindInit({ redirect }));
            expect(fake.calls[0]?.redirect).toBe('manual');
        });
    }

    test('a Request object input is unpacked; its redirect: follow default is overridden', async () => {
        const fake = createFakeFetch({ [`PROPFIND ${ROOT}`]: () => xmlResponse('<ok/>') });
        const guarded = createGuardedFetch(fake.fetch);
        const request = new Request(ROOT, {
            method: 'PROPFIND',
            headers: { authorization: AUTH, depth: '1' },
            body: '<propfind xmlns="DAV:"/>',
        });
        expect(request.redirect).toBe('follow');
        const response = await guarded(request);
        expect(response.status).toBe(207);
        const [call] = fake.calls;
        expect(call?.method).toBe('PROPFIND');
        expect(call?.headers.authorization).toBe(AUTH);
        expect(call?.headers.depth).toBe('1');
        expect(call?.body).toBe('<propfind xmlns="DAV:"/>');
        expect(call?.redirect).toBe('manual');
    });

    test('init overrides fields of a Request object input', async () => {
        const fake = createFakeFetch({ [`REPORT ${ROOT}`]: () => xmlResponse('<ok/>') });
        const guarded = createGuardedFetch(fake.fetch);
        const request = new Request(ROOT, { method: 'PROPFIND', headers: { depth: '1' } });
        await guarded(request, { method: 'REPORT', headers: { depth: '0' } });
        expect(fake.calls[0]?.method).toBe('REPORT');
        expect(fake.calls[0]?.headers.depth).toBe('0');
    });

    test('non-2xx responses are returned to the caller for status mapping', async () => {
        const fake = createFakeFetch({ [ROOT]: () => new Response('nope', { status: 401 }) });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect(response.status).toBe(401);
    });

    test('a 204 response with no body is returned intact', async () => {
        const fake = createFakeFetch({ [ROOT]: () => new Response(null, { status: 204 }) });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
    });
});

describe('redirects', () => {
    test('follows a redirect to an allowed per-account host and re-sends the request', async () => {
        const target = 'https://p42-caldav.icloud.com/10000000001/principal/';
        const fake = createFakeFetch({
            [ROOT]: () => redirectResponse(target, 301),
            [target]: () => xmlResponse('<ok/>'),
        });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect(response.status).toBe(207);
        expect(response.url).toBe(target);
        expect(fake.calls.map((call) => call.url)).toEqual([ROOT, target]);
        expect(fake.calls[1]?.method).toBe('PROPFIND');
        expect(fake.calls[1]?.headers.authorization).toBe(AUTH);
        expect(fake.calls[1]?.body).toContain('current-user-principal');
        expect(fake.calls[1]?.redirect).toBe('manual');
    });

    test('resolves a relative Location against the current URL', async () => {
        const fake = createFakeFetch({
            'https://p42-caldav.icloud.com/a/b/': () => redirectResponse('../c/', 302),
            'https://p42-caldav.icloud.com/a/c/': () => xmlResponse('<ok/>'),
        });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded('https://p42-caldav.icloud.com/a/b/', propfindInit());
        expect(response.status).toBe(207);
        expect(fake.calls.map((call) => call.url)).toEqual([
            'https://p42-caldav.icloud.com/a/b/',
            'https://p42-caldav.icloud.com/a/c/',
        ]);
    });

    test('a relative Location cannot escape the host with a protocol-relative form', async () => {
        const fake = createFakeFetch({ [ROOT]: () => redirectResponse('//evil.example/x', 302) });
        const guarded = createGuardedFetch(fake.fetch);
        expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('forbidden_host');
        expect(fake.calls).toHaveLength(1);
    });

    const evilTargets = [
        'https://evil.example/collect',
        'http://caldav.icloud.com/',
        'https://p1-caldav.icloud.com@evil.example/',
        'https://caldav.icloud.com.evil.example/',
        'https://caldav.icloud.com:8443/',
        'https://169.254.169.254/latest/meta-data/',
        'https://p0000-caldav.icloud.com/',
        'http://[',
    ];
    for (const status of [301, 302, 303, 307, 308]) {
        for (const location of evilTargets) {
            test(`${status} to ${location} throws before a second request and leaks no Authorization`, async () => {
                const fake = createFakeFetch({ [ROOT]: () => redirectResponse(location, status) });
                const guarded = createGuardedFetch(fake.fetch);
                expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('forbidden_host');
                expect(fake.calls).toHaveLength(1);
                expect(fake.calls[0]?.url).toBe(ROOT);
                const authorizedElsewhere = fake.calls.filter(
                    (call) => !call.url.startsWith(ROOT) && call.headers.authorization !== undefined,
                );
                expect(authorizedElsewhere).toHaveLength(0);
            });
        }
    }

    test(`follows exactly ${MAX_REDIRECTS} redirects`, async () => {
        const hop = (n: number) => `https://p${n}-caldav.icloud.com/`;
        const fake = createFakeFetch({
            [ROOT]: () => redirectResponse(hop(1)),
            [hop(1)]: () => redirectResponse(hop(2)),
            [hop(2)]: () => redirectResponse(hop(3)),
            [hop(3)]: () => xmlResponse('<ok/>'),
        });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect(response.status).toBe(207);
        expect(fake.calls).toHaveLength(MAX_REDIRECTS + 1);
    });

    test('a chain longer than the limit throws without sending the extra request', async () => {
        const hop = (n: number) => `https://p${n}-caldav.icloud.com/`;
        const fake = createFakeFetch({
            [ROOT]: () => redirectResponse(hop(1)),
            [hop(1)]: () => redirectResponse(hop(2)),
            [hop(2)]: () => redirectResponse(hop(3)),
            [hop(3)]: () => redirectResponse(hop(4)),
            [hop(4)]: () => xmlResponse('<ok/>'),
        });
        const guarded = createGuardedFetch(fake.fetch);
        expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('forbidden_host');
        expect(fake.calls).toHaveLength(MAX_REDIRECTS + 1);
        expect(fake.calls.some((call) => call.url === hop(4))).toBe(false);
    });

    test('a redirect loop is cut off at the limit', async () => {
        const fake = createFakeFetch({ [ROOT]: () => redirectResponse(ROOT, 307) });
        const guarded = createGuardedFetch(fake.fetch);
        expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('forbidden_host');
        expect(fake.calls).toHaveLength(MAX_REDIRECTS + 1);
    });

    test('303 turns the follow-up into a bodiless GET', async () => {
        const target = 'https://p1-caldav.icloud.com/x/';
        const fake = createFakeFetch({
            [ROOT]: () => redirectResponse(target, 303),
            [`GET ${target}`]: () => xmlResponse('<ok/>', 200),
        });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect(response.status).toBe(200);
        expect(fake.calls[1]?.method).toBe('GET');
        expect(fake.calls[1]?.body).toBeNull();
        expect(fake.calls[1]?.headers['content-type']).toBeUndefined();
    });

    for (const status of [301, 302, 307, 308]) {
        test(`${status} keeps PROPFIND and its body`, async () => {
            const target = 'https://p1-caldav.icloud.com/x/';
            const fake = createFakeFetch({
                [ROOT]: () => redirectResponse(target, status),
                [`PROPFIND ${target}`]: () => xmlResponse('<ok/>'),
            });
            const guarded = createGuardedFetch(fake.fetch);
            await guarded(ROOT, propfindInit());
            expect(fake.calls[1]?.method).toBe('PROPFIND');
            expect(fake.calls[1]?.body).toContain('current-user-principal');
        });
    }

    test('a 3xx without Location is returned, not followed', async () => {
        const fake = createFakeFetch({ [ROOT]: () => new Response(null, { status: 302 }) });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect(response.status).toBe(302);
        expect(fake.calls).toHaveLength(1);
    });

    test('304 is not treated as a redirect', async () => {
        const fake = createFakeFetch({ [ROOT]: () => new Response(null, { status: 304, headers: { location: 'https://evil.example/' } }) });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect(response.status).toBe(304);
        expect(fake.calls).toHaveLength(1);
    });
});

describe('timeouts and network failures', () => {
    test('a request that does not answer within the timeout => temporary', async () => {
        const fake = createFakeFetch({ [ROOT]: (_request, signal) => hangUntilAborted(signal) });
        const guarded = createGuardedFetch(fake.fetch, { timeoutMs: 25 });
        const started = Date.now();
        expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('temporary');
        expect(Date.now() - started).toBeLessThan(2000);
    });

    test('a body that stalls mid-stream => temporary', async () => {
        const stalled = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('<multistatus'));
            },
        });
        const fake = createFakeFetch({ [ROOT]: () => new Response(stalled, { status: 207 }) });
        const guarded = createGuardedFetch(fake.fetch, { timeoutMs: 25 });
        expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('temporary');
    });

    test('the default timeout is clamped by the request budget minus 2 s', async () => {
        const fake = createFakeFetch({ [ROOT]: (_request, signal) => hangUntilAborted(signal) });
        const guarded = createGuardedFetch(fake.fetch);
        const started = Date.now();
        const code = await withRequestBudget(() => 2030, () => codeOf(guarded(ROOT, propfindInit())));
        expect(code).toBe('temporary');
        expect(Date.now() - started).toBeLessThan(2000);
        expect(fake.calls).toHaveLength(1);
    });

    test('an exhausted request budget sends nothing => temporary', async () => {
        const fake = createFakeFetch({ [ROOT]: () => xmlResponse('<ok/>') });
        const guarded = createGuardedFetch(fake.fetch);
        for (const remaining of [2000, 1500, 0]) {
            const code = await withRequestBudget(() => remaining, () => codeOf(guarded(ROOT, propfindInit())));
            expect(code).toBe('temporary');
        }
        expect(fake.calls).toHaveLength(0);
    });

    test('a network error => temporary, and the cause text is not carried', async () => {
        const guarded = createGuardedFetch(async () => {
            throw new TypeError('connect ECONNREFUSED secret-detail');
        });
        let caught: unknown;
        try {
            await guarded(ROOT, propfindInit());
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CalDavError);
        expect((caught as CalDavError).code).toBe('temporary');
        expect(String(caught)).not.toContain('secret-detail');
        expect((caught as Error).cause).toBeUndefined();
    });

    test('a caller signal that is already aborted => temporary', async () => {
        const fake = createFakeFetch({ [ROOT]: (_request, signal) => hangUntilAborted(signal) });
        const guarded = createGuardedFetch(fake.fetch);
        const controller = new AbortController();
        controller.abort();
        expect(await codeOf(guarded(ROOT, propfindInit({ signal: controller.signal })))).toBe('temporary');
    });

    test('rejects a non-positive timeout option at construction', () => {
        expect(() => createGuardedFetch(createFakeFetch().fetch, { timeoutMs: 0 })).toThrow();
        expect(() => createGuardedFetch(createFakeFetch().fetch, { timeoutMs: Number.NaN })).toThrow();
    });
});

describe('response size cap', () => {
    test(`a body of exactly ${MAX_RESPONSE_BYTES} bytes is accepted`, async () => {
        const body = 'a'.repeat(MAX_RESPONSE_BYTES);
        const fake = createFakeFetch({ [ROOT]: () => xmlResponse(body) });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect((await response.text()).length).toBe(MAX_RESPONSE_BYTES);
    });

    test('one byte over the cap => protocol', async () => {
        const body = 'a'.repeat(MAX_RESPONSE_BYTES + 1);
        const fake = createFakeFetch({ [ROOT]: () => xmlResponse(body) });
        const guarded = createGuardedFetch(fake.fetch);
        expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('protocol');
    });

    test('an oversize Content-Length is refused without reading the body', async () => {
        let pulled = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(16));
            },
        });
        const fake = createFakeFetch({
            [ROOT]: () => new Response(stream, { status: 207, headers: { 'content-length': String(MAX_RESPONSE_BYTES * 4) } }),
        });
        const guarded = createGuardedFetch(fake.fetch);
        expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('protocol');
        expect(pulled).toBeLessThanOrEqual(1);
    });

    test('an endless body is cut off at the cap => protocol', async () => {
        const chunk = new Uint8Array(64 * 1024);
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(chunk);
            },
        });
        const fake = createFakeFetch({ [ROOT]: () => new Response(endless, { status: 207 }) });
        const guarded = createGuardedFetch(fake.fetch);
        expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('protocol');
    });

    test('an endless stream of empty chunks => protocol (it cannot starve the timeout)', async () => {
        const empty = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(0));
            },
        });
        const fake = createFakeFetch({ [ROOT]: () => new Response(empty, { status: 207 }) });
        const guarded = createGuardedFetch(fake.fetch);
        expect(await codeOf(guarded(ROOT, propfindInit()))).toBe('protocol');
    });

    test('an oversize redirect body is not read (only the Location matters)', async () => {
        const target = 'https://p1-caldav.icloud.com/';
        const fake = createFakeFetch({
            [ROOT]: () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 10), { status: 301, headers: { location: target } }),
            [target]: () => xmlResponse('<ok/>'),
        });
        const guarded = createGuardedFetch(fake.fetch);
        const response = await guarded(ROOT, propfindInit());
        expect(response.status).toBe(207);
    });
});

describe('default base fetch', () => {
    test('without an injected fetch the global fetch is used, resolved at call time', async () => {
        const original = globalThis.fetch;
        const seen: string[] = [];
        const replacement = async (input: string | URL | Request): Promise<Response> => {
            seen.push(String(input));
            return xmlResponse('<ok/>');
        };
        globalThis.fetch = Object.assign(replacement, { preconnect: original.preconnect });
        try {
            const guarded = createGuardedFetch();
            const response = await guarded(ROOT, propfindInit());
            expect(response.status).toBe(207);
            expect(seen).toEqual([ROOT]);
            expect(await codeOf(guarded('https://evil.example/', propfindInit()))).toBe('forbidden_host');
            expect(seen).toEqual([ROOT]);
        } finally {
            globalThis.fetch = original;
        }
    });
});
