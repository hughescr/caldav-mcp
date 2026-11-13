// Node transport check for the managed-attachment fetcher (run by `bun run smoke`, after the build).
//
// Production runs on Node, whose fetch differs from Bun's. This drives the built fetcher (dist/transport-check) with
// Node's real global fetch against a local HTTP server on 127.0.0.1. The fetcher takes a URL the policy has already
// approved, so the check calls it directly with a local http:// URL; the https and host rules stay in the policy, which
// this check also shows refuses that URL. Nothing here leaves the machine.
//
// It also drives the built iCloud backend's PUT, DELETE and multiget under Node's fetch, against a raw TCP server on
// 127.0.0.1 that records each request line exactly as received: a resource href is opaque and must arrive byte for byte
// (no decoding, re-encoding or case change of its escapes). Only the iCloud origin is swapped for the local one, by plain
// string replacement in the injected transport, after every URL check of the backend has run.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import {
    AttachmentFetchError, checkManagedAttachmentUrl, createICloudBackend, createManagedAttachmentFetcher, MANAGED_ATTACHMENT_POLICY, MAX_DOWNLOAD_BYTES,
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

    await check('a resource href reaches the wire byte for byte: PUT, DELETE and the multiget body', async () => {
        // Synthetic ids; the name has the measured shape (a URL-like UID: %3A and a double-encoded slash %252F).
        const calendar = '/10000000001/calendars/11111111-2222-4333-8444-555555555555/';
        const measured = `${calendar}x-apple-reminderkit%3A%252FSYNTHETICLIST%252F00000000-0000-4000-8000-000000000001.ics`;
        const names = [measured, `${calendar}..%2F..%2Fother%2Fx.ics`, `${calendar}a%2fb%2Fc%3a.ics`, `${calendar}%65vent%7b1%7d.ics`];
        const card = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:synthetic\nDTSTART:20270111T100000Z\nDTEND:20270111T110000Z\nEND:VEVENT\nEND:VCALENDAR\n';
        const multistatus = `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>${measured}</D:href><D:propstat><D:prop><D:getetag>"v1"</D:getetag><C:calendar-data><![CDATA[${card}]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
        const seen = [];
        const tcp = createTcpServer(socket => {
            let buffer = '';
            socket.on('data', chunk => {
                buffer += chunk.toString('latin1');
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) { return; }
                const length = Number(/\r\ncontent-length:\s*(\d+)/iu.exec(buffer.slice(0, end))?.[1] ?? '0');
                if (buffer.length < end + 4 + length) { return; }
                const body = buffer.slice(end + 4, end + 4 + length);
                seen.push({ line: buffer.slice(0, buffer.indexOf('\r\n')), body });
                const reply = body.includes('calendar-multiget') ? multistatus : '';
                socket.end(`HTTP/1.1 ${reply === '' ? '204 No Content' : '207 Multi-Status'}\r\nETag: "v2"\r\nContent-Type: application/xml\r\nContent-Length: ${Buffer.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`);
            });
        });
        await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
        try {
            const origin = 'https://p01-caldav.icloud.com';
            const local = `http://127.0.0.1:${tcp.address().port}`;
            const backend = createICloudBackend({ fetch: (input, init) => fetch(String(input).replace(origin, local), init) });
            const auth = { appleId: 'synthetic@example.invalid', appPassword: 'synthetic-password' };
            const discovery = { principalUrl: `${origin}/10000000001/principal/`, calendarHomeUrl: `${origin}/10000000001/calendars/` };
            for (const href of names) {
                assert.equal((await backend.putEvent(auth, discovery, { calendarId: calendar, href, body: card, precondition: { kind: 'match', etag: '"v1"' } })).status, 204);
                assert.equal((await backend.deleteEvent(auth, discovery, { calendarId: calendar, href, etag: '"v1"' })).status, 204);
            }
            const [found] = await backend.multigetEvents(auth, discovery, { calendarId: calendar, hrefs: [measured] });
            assert.equal(found.kind, 'found');
            assert.equal(found.resource.href, measured);
            assert.deepEqual(seen.map(request => request.line), [...names.flatMap(href => [`PUT ${href} HTTP/1.1`, `DELETE ${href} HTTP/1.1`]), `REPORT ${calendar} HTTP/1.1`]);
            assert.ok(seen.at(-1).body.includes(`<d:href>${measured}</d:href>`), 'the multiget body names the href unchanged');
        } finally {
            await new Promise(resolve => tcp.close(resolve));
        }
    });
} finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}

// eslint-disable-next-line no-console -- the check's own report: fixed names, no data.
console.log(`transport check passed under Node ${process.versions.node}: ${results.length} checks`);
