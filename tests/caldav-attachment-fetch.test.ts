import { describe, expect, test } from 'bun:test';
import { AttachmentFetchError, byteLimit, createManagedAttachmentFetcher, readCappedBody, type ManagedFetchRequest } from '../src/caldav/attachment-fetch';
import type { ManagedAttachmentPolicy } from '../src/caldav/managed-attachment-policy';
import { MAX_DOWNLOAD_BYTES, MAX_EMPTY_STREAM_CHUNKS } from '../src/calendar/limits';

const MIB = 1024 * 1024;
const url = new URL('https://gateway.icloud.com/a/b/c/d/probe.txt/e');
const auth = { appleId: 'user@example.invalid', appPassword: 'fetch-canary-pass' };

interface Sent { url: string; init: RequestInit | undefined }

function recorder(...responses: (Response | Error | (() => Response | Promise<Response>))[]) {
    const sent: Sent[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        sent.push({ url: String(input), init });
        const next = responses.shift();
        if (next === undefined) { throw new Error('unexpected request'); }
        if (next instanceof Error) { throw next; }
        return typeof next === 'function' ? next() : next;
    };
    return { fetch, sent };
}

function request(overrides: Partial<ManagedFetchRequest> = {}): ManagedFetchRequest {
    return { url, declaredSize: null, signal: new AbortController().signal, credentials: () => auth, ...overrides };
}

async function code(promise: Promise<unknown>): Promise<string> {
    try { await promise; return 'resolved'; } catch (error) { return error instanceof AttachmentFetchError ? error.code : `other:${String(error)}`; }
}

/** A body of `total` bytes in `chunk`-sized pieces, produced lazily, recording whether it was cancelled. */
function lazyBody(total: number, chunk = 64 * 1024) {
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (produced >= total) { controller.close(); return; }
            const size = Math.min(chunk, total - produced);
            produced += size;
            controller.enqueue(new Uint8Array(size).fill(7));
        },
        cancel() { cancelled = true; },
    });
    return { stream, produced: () => produced, cancelled: () => cancelled };
}

/** A Response whose type and status are overridden: the Response constructor cannot make status 0 or opaqueredirect. */
function opaque(response: Response, type: ResponseType, status: number): Response {
    return Object.defineProperties(response, { type: { value: type }, status: { value: status } });
}

describe('streaming cap', () => {
    test('the cap is 20 MiB, or SIZE when smaller; SIZE above the cap is too large before anything is sent', () => {
        expect(byteLimit(null)).toEqual({ maxBytes: MAX_DOWNLOAD_BYTES, overflow: 'too_large' });
        expect(byteLimit(32)).toEqual({ maxBytes: 32, overflow: 'verification' });
        expect(byteLimit(MAX_DOWNLOAD_BYTES)).toEqual({ maxBytes: MAX_DOWNLOAD_BYTES, overflow: 'too_large' });
        expect(() => byteLimit(MAX_DOWNLOAD_BYTES + 1)).toThrow(AttachmentFetchError);
    });

    test('a body crossing 20 MiB is stopped at the crossing chunk and cancelled, never buffered whole', async () => {
        const body = lazyBody(30 * MIB);
        expect(await code(readCappedBody(body.stream, byteLimit(null), new AbortController().signal))).toBe('too_large');
        expect(body.cancelled()).toBe(true);
        // The crossing chunk plus at most one chunk the stream queued ahead of the read.
        expect(body.produced()).toBeLessThanOrEqual(MAX_DOWNLOAD_BYTES + 2 * 64 * 1024);
    });

    test('exactly 20 MiB is accepted', async () => {
        const body = lazyBody(MAX_DOWNLOAD_BYTES);
        expect((await readCappedBody(body.stream, byteLimit(null), new AbortController().signal)).byteLength).toBe(MAX_DOWNLOAD_BYTES);
    });

    test('a body longer than SIZE fails verification; shorter than SIZE is accepted (SIZE is an upper bound)', async () => {
        expect(await code(readCappedBody(lazyBody(33).stream, byteLimit(32), new AbortController().signal))).toBe('verification');
        expect((await readCappedBody(lazyBody(31).stream, byteLimit(32), new AbortController().signal)).byteLength).toBe(31);
    });

    test('a flood of empty chunks is refused', async () => {
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(0)); } });
        expect(await code(readCappedBody(stream, byteLimit(null), new AbortController().signal))).toBe('upstream');
        expect(pulls).toBeGreaterThan(MAX_EMPTY_STREAM_CHUNKS);
    });

    test('a non-byte chunk is refused', async () => {
        const stream = new ReadableStream<unknown>({ start(controller) { controller.enqueue('text'); controller.close(); } }) as unknown as ReadableStream<Uint8Array>;
        expect(await code(readCappedBody(stream, byteLimit(null), new AbortController().signal))).toBe('upstream');
    });

    test('the signal aborts a stalled body and cancels the source', async () => {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
        const controller = new AbortController();
        const pending = code(readCappedBody(stream, byteLimit(null), controller.signal));
        controller.abort();
        expect(await pending).toBe('temporary');
        expect(cancelled).toBe(true);
    });

    test('bytes arrive intact across buffer growth, with or without a Content-Length hint', async () => {
        const sizes = [1, 65_535, 2, 70_000, 131_072, 3, 400_000, 17];
        const total = sizes.reduce((sum, size) => sum + size, 0);
        const expected = new Uint8Array(total);
        for (let index = 0; index < total; index++) { expected[index] = (index * 31 + 7) % 251; }
        const stream = () => {
            let offset = 0;
            const queue = [...sizes];
            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    const size = queue.shift();
                    if (size === undefined) { controller.close(); return; }
                    controller.enqueue(expected.slice(offset, offset + size));
                    offset += size;
                },
            });
        };
        for (const hint of [null, total, 10, total * 2]) {
            const bytes = await readCappedBody(stream(), byteLimit(null), new AbortController().signal, hint);
            expect([hint, bytes.byteLength]).toEqual([hint, total]);
            expect(Buffer.from(bytes).equals(Buffer.from(expected))).toBe(true);
        }
    });

    test('the buffer never grows past the cap, even with a larger hint', async () => {
        const bytes = await readCappedBody(lazyBody(100).stream, byteLimit(100), new AbortController().signal, MAX_DOWNLOAD_BYTES);
        expect(bytes.byteLength).toBe(100);
        expect(bytes.buffer.byteLength).toBe(100);
        const capped = await readCappedBody(lazyBody(MAX_DOWNLOAD_BYTES, 1024 * 1024 - 1).stream, byteLimit(null), new AbortController().signal);
        expect(capped.byteLength).toBe(MAX_DOWNLOAD_BYTES);
        expect(capped.buffer.byteLength).toBe(MAX_DOWNLOAD_BYTES);
    });

    test('a null body is empty', async () => {
        expect((await readCappedBody(null, byteLimit(0), new AbortController().signal)).byteLength).toBe(0);
    });
});

describe('managed fetch', () => {
    test('one anonymous GET: no Authorization, no cookies, manual redirects, identity encoding', async () => {
        const r = recorder(new Response('0123456789abcdef0123456789abcdef', { status: 200 }));
        const bytes = await createManagedAttachmentFetcher({ fetch: r.fetch })(request({ declaredSize: 32 }));
        expect(new TextDecoder().decode(bytes)).toBe('0123456789abcdef0123456789abcdef');
        expect(r.sent).toHaveLength(1);
        const [sent] = r.sent;
        expect(sent?.url).toBe(url.href);
        expect(sent?.init?.method).toBe('GET');
        expect(sent?.init?.redirect).toBe('manual');
        expect(sent?.init?.credentials).toBe('omit');
        const headers = new Headers(sent?.init?.headers);
        expect(headers.get('authorization')).toBeNull();
        expect(headers.get('cookie')).toBeNull();
        expect(headers.get('accept-encoding')).toBe('identity');
        expect(JSON.stringify(r.sent)).not.toContain(auth.appPassword);
    });

    test('a redirect is a failure and is never followed', async () => {
        for (const status of [301, 302, 303, 307, 308]) {
            const r = recorder(new Response(null, { status, headers: { location: 'https://gateway.icloud.com/elsewhere' } }));
            expect(await code(createManagedAttachmentFetcher({ fetch: r.fetch })(request()))).toBe('redirect');
            expect(r.sent).toHaveLength(1);
        }
    });

    test('an opaqueredirect response (what fetch returns for a redirect under redirect: manual) is a redirect failure', async () => {
        const body = lazyBody(1024);
        const r = recorder(opaque(new Response(body.stream), 'opaqueredirect', 0));
        expect(await code(createManagedAttachmentFetcher({ fetch: r.fetch })(request()))).toBe('redirect');
        expect(r.sent).toHaveLength(1);
        expect(body.cancelled()).toBe(true);
    });

    test('a status 0 response is refused, whatever its type', async () => {
        const error = recorder(Response.error());
        expect(await code(createManagedAttachmentFetcher({ fetch: error.fetch })(request()))).toBe('upstream');
        const body = lazyBody(1024);
        const basic = recorder(opaque(new Response(body.stream), 'basic', 0));
        expect(await code(createManagedAttachmentFetcher({ fetch: basic.fetch })(request()))).toBe('upstream');
        expect(basic.sent).toHaveLength(1);
        expect(body.cancelled()).toBe(true);
    });

    test('statuses map to fixed codes', async () => {
        for (const [status, expected] of [[404, 'not_found'], [410, 'not_found'], [403, 'temporary'], [408, 'temporary'], [429, 'temporary'], [500, 'temporary'], [503, 'temporary'], [204, 'upstream'], [206, 'upstream'], [400, 'upstream']] as const) {
            const r = recorder(new Response(status === 204 ? null : 'upstream-text-canary', { status }));
            expect([status, await code(createManagedAttachmentFetcher({ fetch: r.fetch })(request()))]).toEqual([status, expected]);
        }
    });

    test('a network failure is temporary and does not echo its cause', async () => {
        const r = recorder(new Error('connect failed https://gateway.icloud.com/secret-capability'));
        const error = await createManagedAttachmentFetcher({ fetch: r.fetch })(request()).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AttachmentFetchError);
        expect(String((error as Error).message)).toBe('temporary');
    });

    test('a 401 Basic challenge from the shipped policy sends no credentials and fails as login_required', async () => {
        const r = recorder(new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="files"' } }));
        let read = 0;
        expect(await code(createManagedAttachmentFetcher({ fetch: r.fetch })(request({ credentials: () => { read++; return auth; } })))).toBe('login_required');
        expect(r.sent).toHaveLength(1);
        expect(read).toBe(0);
    });

    describe('with a test policy listing a credentialed host', () => {
        const fakeHost = 'login-required.icloud.example';
        const policy: ManagedAttachmentPolicy = { downloadHosts: ['gateway.icloud.com', fakeHost], credentialedHosts: [fakeHost] };
        const loginUrl = new URL(`https://${fakeHost}/a/file`);

        test('retries once with Basic credentials only after a 401 Basic challenge', async () => {
            const r = recorder(new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="files"' } }), new Response('ok', { status: 200 }));
            const bytes = await createManagedAttachmentFetcher({ fetch: r.fetch, policy })(request({ url: loginUrl }));
            expect(new TextDecoder().decode(bytes)).toBe('ok');
            expect(r.sent.map(sent => new Headers(sent.init?.headers).get('authorization'))).toEqual([null, `Basic ${Buffer.from(`${auth.appleId}:${auth.appPassword}`).toString('base64')}`]);
            expect(r.sent.map(sent => sent.url)).toEqual([loginUrl.href, loginUrl.href]);
            expect(r.sent[1]?.init?.redirect).toBe('manual');
        });

        test('a 401 without a Basic challenge sends no credentials', async () => {
            const r = recorder(new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="x"' } }));
            expect(await code(createManagedAttachmentFetcher({ fetch: r.fetch, policy })(request({ url: loginUrl })))).toBe('login_required');
            expect(r.sent).toHaveLength(1);
        });

        test('a 401 after credentials stops: no further attempt', async () => {
            const challenge = () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="files"' } });
            const r = recorder(challenge(), challenge());
            expect(await code(createManagedAttachmentFetcher({ fetch: r.fetch, policy })(request({ url: loginUrl })))).toBe('upstream');
            expect(r.sent).toHaveLength(2);
        });

        test('a redirect after credentials is still a failure and is not followed', async () => {
            const r = recorder(new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic' } }), new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));
            expect(await code(createManagedAttachmentFetcher({ fetch: r.fetch, policy })(request({ url: loginUrl })))).toBe('redirect');
            expect(r.sent).toHaveLength(2);
        });

        test('the download host that is not credentialed still never receives credentials', async () => {
            const r = recorder(new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic' } }));
            expect(await code(createManagedAttachmentFetcher({ fetch: r.fetch, policy })(request()))).toBe('login_required');
            expect(r.sent).toHaveLength(1);
        });
    });

    test('a non-identity Content-Encoding fails verification', async () => {
        const r = recorder(new Response('x', { status: 200, headers: { 'content-encoding': 'gzip' } }));
        expect(await code(createManagedAttachmentFetcher({ fetch: r.fetch })(request()))).toBe('verification');
    });

    test('Content-Length must be well formed, within the caps and equal to the bytes received', async () => {
        const fetcher = (response: Response) => createManagedAttachmentFetcher({ fetch: recorder(response).fetch });
        expect(await code(fetcher(new Response('abc', { headers: { 'content-length': 'abc' } }))(request()))).toBe('verification');
        expect(await code(fetcher(new Response('abc', { headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } }))(request()))).toBe('too_large');
        expect(await code(fetcher(new Response('abc', { headers: { 'content-length': '40' } }))(request({ declaredSize: 32 })))).toBe('verification');
        const short = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.close(); } }), { headers: { 'content-length': '4' } });
        expect(await code(fetcher(short)(request()))).toBe('verification');
    });

    test('a streamed body over SIZE fails verification; over 20 MiB is too large', async () => {
        const over = lazyBody(MAX_DOWNLOAD_BYTES + 1);
        expect(await code(createManagedAttachmentFetcher({ fetch: recorder(new Response(over.stream)).fetch })(request()))).toBe('too_large');
        expect(over.produced()).toBeLessThanOrEqual(MAX_DOWNLOAD_BYTES + 2 * 64 * 1024);
        expect(await code(createManagedAttachmentFetcher({ fetch: recorder(new Response('0123456789')).fetch })(request({ declaredSize: 4 })))).toBe('verification');
    });

    test('the signal bounds the request itself, not only the body', async () => {
        const controller = new AbortController();
        const fetch = () => new Promise<Response>(() => {});
        const pending = code(createManagedAttachmentFetcher({ fetch })(request({ signal: controller.signal })));
        controller.abort();
        expect(await pending).toBe('temporary');
        expect(await code(createManagedAttachmentFetcher({ fetch })(request({ signal: AbortSignal.abort() })))).toBe('temporary');
    });

    test('a declared SIZE over the cap fails before anything is sent', async () => {
        const r = recorder();
        expect(await code(createManagedAttachmentFetcher({ fetch: r.fetch })(request({ declaredSize: MAX_DOWNLOAD_BYTES + 1 })))).toBe('too_large');
        expect(r.sent).toHaveLength(0);
    });
});
