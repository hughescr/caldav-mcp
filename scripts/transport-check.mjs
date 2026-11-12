// Node transport check for the managed-attachment fetcher (run by `bun run smoke`, after the build).
//
// Production runs on Node, whose fetch differs from Bun's. This drives the built fetcher (dist/transport-check) with
// Node's real global fetch against a local HTTP server on 127.0.0.1. The fetcher takes a URL the policy has already
// approved, so the check calls it directly with a local http:// URL; the https and host rules stay in the policy, which
// this check also shows refuses that URL. Nothing here leaves the machine.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import {
    AttachmentFetchError, checkManagedAttachmentUrl, createManagedAttachmentFetcher, MANAGED_ATTACHMENT_POLICY, MAX_DOWNLOAD_BYTES,
} from '../dist/transport-check/attachment-fetch.mjs';

assert.equal(Number(process.versions.node.split('.')[0]), 26, 'The transport check must execute under Node 26');
assert.equal(MAX_DOWNLOAD_BYTES, 20 * 1024 * 1024, 'the built cap is 20 MiB');

const requests = [];
const closed = new Map();
const CHUNK = 64 * 1024;

/** Routes are the paths the check requests. Every request is recorded; `closed` records how each response ended. */
const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({ path, headers: request.headers });
    let sent = 0;
    response.on('close', () => { closed.set(path, { finished: response.writableFinished, sent }); });
    switch (path) {
        case '/ok':
            response.writeHead(200, { 'content-type': 'text/plain' }).end('0123456789abcdef');
            return;
        case '/redirect':
            response.writeHead(302, { location: '/target' }).end();
            return;
        case '/target':
            response.writeHead(200).end('followed');
            return;
        case '/challenge':
            response.writeHead(401, { 'www-authenticate': 'Basic realm="files"' }).end();
            return;
        case '/gzip':
            response.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(Buffer.from('compressed body')));
            return;
        case '/endless': {
            // No Content-Length; writes until the client goes away, respecting backpressure.
            response.writeHead(200);
            const block = Buffer.alloc(CHUNK, 7);
            const pump = () => {
                while (!response.destroyed) {
                    sent += block.byteLength;
                    if (!response.write(block)) { response.once('drain', pump); return; }
                }
            };
            pump();
            return;
        }
        case '/slow':
            response.writeHead(200);
            sent += 4;
            response.write('slow');
            // Then nothing more: the body stalls until the client gives up.
            return;
        default:
            response.writeHead(404).end();
    }
});

await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const fetchManaged = createManagedAttachmentFetcher();
const credentials = () => { throw new Error('credentials must never be read'); };
const get = (path, options = {}) => fetchManaged({
    url: new URL(path, base), declaredSize: null, signal: options.signal ?? AbortSignal.timeout(10_000), credentials,
});
const code = async (promise) => {
    try { await promise; return 'resolved'; } catch (error) { return error instanceof AttachmentFetchError ? error.code : `other:${String(error)}`; }
};
const requestsTo = (path) => requests.filter(request => request.path === path);
const waitFor = async (predicate, ms = 3000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > end) { return false; }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return true;
};
const results = [];
const check = async (name, run) => { await run(); results.push(name); };

try {
    // The policy, not the transport, refuses http and any host but the reviewed one.
    await check('policy refuses the local URL', () => {
        assert.deepEqual(checkManagedAttachmentUrl({ url: `${base}/ok`, managedId: 'm', calendarHomeUrl: 'https://p01-caldav.icloud.com/1/calendars/' }), { allowed: false, reason: 'not_https' });
        assert.deepEqual(checkManagedAttachmentUrl({ url: `https://127.0.0.1/ok`, managedId: 'm', calendarHomeUrl: 'https://p01-caldav.icloud.com/1/calendars/' }), { allowed: false, reason: 'host' });
        assert.deepEqual([...MANAGED_ATTACHMENT_POLICY.credentialedHosts], []);
    });

    await check('a plain 200 is read, with no Authorization or Cookie and identity encoding requested', async () => {
        const bytes = await get('/ok');
        assert.equal(Buffer.from(bytes).toString(), '0123456789abcdef');
        const [sent] = requestsTo('/ok');
        assert.ok(sent, 'the request reached the server');
        assert.equal(sent.headers.authorization, undefined);
        assert.equal(sent.headers.cookie, undefined);
        assert.equal(sent.headers['accept-encoding'], 'identity');
    });

    await check('a real 302 is not followed and makes no second request', async () => {
        assert.equal(await code(get('/redirect')), 'redirect');
        assert.equal(requestsTo('/redirect').length, 1);
        assert.equal(requestsTo('/target').length, 0, 'the redirect target must never be requested');
    });

    await check('a 401 Basic challenge sends no credentials and no second request', async () => {
        assert.equal(await code(get('/challenge')), 'login_required');
        assert.equal(requestsTo('/challenge').length, 1);
        assert.equal(requestsTo('/challenge')[0].headers.authorization, undefined);
    });

    await check('a gzip Content-Encoding is refused', async () => {
        assert.equal(await code(get('/gzip')), 'verification');
    });

    await check('a body over the 20 MiB cap is cut off and its connection cancelled', async () => {
        assert.equal(await code(get('/endless')), 'too_large');
        assert.ok(await waitFor(() => closed.has('/endless')), 'the server saw the connection close');
        const { finished, sent } = closed.get('/endless');
        assert.equal(finished, false, 'the response was cut off, not completed');
        // The cap, plus what the socket buffers and the stream's read-ahead held when the client stopped.
        assert.ok(sent > MAX_DOWNLOAD_BYTES && sent < MAX_DOWNLOAD_BYTES + 16 * 1024 * 1024, `sent ${sent} bytes`);
    });

    await check('a stalled body hits the deadline and its connection is cancelled', async () => {
        const started = performance.now();
        assert.equal(await code(get('/slow', { signal: AbortSignal.timeout(300) })), 'temporary');
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 250 && elapsed < 3000, `ended after ${Math.round(elapsed)} ms`);
        assert.ok(await waitFor(() => closed.has('/slow')), 'the server saw the connection close');
        assert.equal(closed.get('/slow').finished, false);
    });
} finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}

// eslint-disable-next-line no-console -- the check's own report: fixed names, no data.
console.log(`transport check passed under Node ${process.versions.node}: ${results.length} checks`);
