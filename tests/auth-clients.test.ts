import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClientRegistry, matchesRedirectUri, type ClientAuthMethod } from '../src/auth/clients';
import { AuthCrypto } from '../src/auth/crypto';
const crypto = new AuthCrypto({ activeKeyId: 'v1', keys: { v1: Buffer.alloc(32, 1) } });
const publicMetadata = { client_name: 'Test client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none' };
const document = (clientId: string, extra = {}) => ({ ...publicMetadata, client_id: clientId, ...extra });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('stateless public DCR round trips across instances, rejects tampering and carries no unneeded metadata', async () => {
    const registry = new ClientRegistry({ crypto, now: () => 123000 });
    const registration = registry.register({ ...publicMetadata, logo_uri: 'http://169.254.169.254/secret' });
    expect(registration.client_secret).toBeUndefined(); expect(registration.client_id_issued_at).toBe(123);
    expect(registration.client_id.length).toBeLessThan(3073);
    expect(registry.register(publicMetadata).client_id).not.toBe(registration.client_id);
    const client = await new ClientRegistry({ crypto }).resolve(registration.client_id);
    expect(client.name).toBe('Test client'); expect(JSON.stringify(client)).not.toContain('169.254');
    registry.authenticate(client, 'none');
    expect(() => registry.authenticate(client, 'none', '')).toThrow('invalid_client');
    await expect(registry.resolve(registration.client_id + 'x')).rejects.toThrow('invalid_client');
    await expect(registry.resolve(crypto.sign('other-purpose', '{}'))).rejects.toThrow('invalid_client');
});

test('confidential methods cannot downgrade, interchange, or reuse another registration secret; rotation retains clients', async () => {
    const registry = new ClientRegistry({ crypto });
    for (const method of ['client_secret_basic', 'client_secret_post'] as ClientAuthMethod[]) {
        const registration = registry.register({ ...publicMetadata, token_endpoint_auth_method: method });
        const client = await registry.resolve(registration.client_id);
        registry.authenticate(client, method, registration.client_secret);
        expect(registration.client_secret_expires_at).toBe(0);
        for (const wrong of ['none', method === 'client_secret_basic' ? 'client_secret_post' : 'client_secret_basic'] as ClientAuthMethod[]) { expect(() => registry.authenticate(client, wrong, registration.client_secret)).toThrow('invalid_client'); }
        for (const wrong of [undefined, '', 'bad', registry.register({ ...publicMetadata, token_endpoint_auth_method: method }).client_secret]) { expect(() => registry.authenticate(client, method, wrong)).toThrow('invalid_client'); }
        const rotated = new ClientRegistry({ crypto: new AuthCrypto({ activeKeyId: 'v2', keys: { v1: Buffer.alloc(32, 1), v2: Buffer.alloc(32, 2) } }) });
        rotated.authenticate(await rotated.resolve(registration.client_id), method, registration.client_secret);
    }
    expect(registry.register({ redirect_uris: publicMetadata.redirect_uris }).token_endpoint_auth_method).toBe('client_secret_basic');
});

test('redirect registration refuses unsafe schemes, credentials, fragments, wildcards and excessive metadata', () => {
    const registry = new ClientRegistry({ crypto });
    for (const uri of ['http://evil.example/cb', 'file:///cb', 'javascript:alert(1)', 'myapp:/callback', 'https://user:password@client.example/cb', 'https://client.example/cb#', 'https://*.example/cb', 'https://client.example/ cb', 'http://127.0.0.2/cb', 'http://127.1/cb', 'http://2130706433/cb', 'http://localhost.evil/cb', 'https:\\evil.example/cb']) { expect(() => registry.register({ ...publicMetadata, redirect_uris: [uri] })).toThrow('invalid_redirect_uri'); }
    for (const extra of [{ redirect_uris: [] }, { redirect_uris: Array(4).fill('https://example.com/cb') }, { client_name: 'x'.repeat(121) }, { junk: 'x'.repeat(5120) }, { token_endpoint_auth_method: 'private_key_jwt' }, { response_types: ['token'] }, { response_types: ['code', 'token'] }, { grant_types: ['client_credentials'] }, { application_type: 'web', redirect_uris: ['http://localhost/cb'] }]) { expect(() => registry.register({ ...publicMetadata, ...extra })).toThrow(); }
    expect(() => registry.register({ ...publicMetadata, grant_types: ['authorization_code', 'refresh_token', 'client_credentials'] })).toThrow('invalid_client_metadata');
});

test('redirect matching is exact for web; native exception varies port only on the same loopback host/path/query', async () => {
    const registry = new ClientRegistry({ crypto });
    const web = await registry.resolve(registry.register(publicMetadata).client_id);
    for (const uri of ['https://client.example/callback/', 'https://CLIENT.example/callback', 'https://client.example:443/callback', 'https://client.example/callback?x=1']) { expect(matchesRedirectUri(web, uri)).toBe(false); }
    expect(matchesRedirectUri(web, publicMetadata.redirect_uris[0] ?? '')).toBe(true);
    for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
        const native = await registry.resolve(registry.register({ ...publicMetadata, redirect_uris: [`http://${host}:4000/cb?x=1`] }).client_id);
        expect(native.applicationType).toBe('native'); expect(matchesRedirectUri(native, `http://${host}:5000/cb?x=1`)).toBe(true);
        for (const uri of [`http://${host}:5000/cb?x=2`, `http://${host}:5000/other?x=1`, `http://${host}:5000/other/../cb?x=1`, `http://${host}:5000/cb?x=1#fragment`, 'http://127.0.0.2:5000/cb?x=1']) { expect(matchesRedirectUri(native, uri)).toBe(false); }
    }
});

test('CIMD identity is exact, presentation links never fetched, cache bounded and cloned, concurrency coalesced', async () => {
    let calls = 0; let now = 0;
    const registry = new ClientRegistry({ crypto, maxCacheEntries: 2, now: () => now, fetchMetadata: async input => { calls++; return json(document(String(input), { logo_uri: 'https://logos.example/x', jwks_uri: 'https://keys.example/x' })); } });
    const id = 'https://client.example/client.json';
    const clients = await Promise.all(Array.from({ length: 10 }, () => registry.resolve(id)));
    expect(calls).toBe(1); const first = clients[0]; if (first) { first.redirectUris = ['https://attacker.example/cb']; }
    expect((await registry.resolve(id)).redirectUris).toEqual(publicMetadata.redirect_uris);
    await registry.resolve('https://client.example/other.json'); await registry.resolve('https://client.example/third.json');
    await registry.resolve(id); expect(calls).toBe(4);
    now = 300000; await registry.resolve(id); expect(calls).toBe(5);
});

test('CIMD URL syntax rejects reserved literal destinations and special ports before transport', async () => {
    let calls = 0; const registry = new ClientRegistry({ crypto, fetchMetadata: async () => { calls++; return json({}); } });
    for (const id of ['https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://169.254.169.254/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[fc00::1]/x', 'https://[fe80::1]/x', 'https://localhost/x', 'https://metadata.google.internal/x', 'https://client.example:8443/x', 'https://client.example', 'https://client.example/../x', 'https://client.example/%2e%2e/x', 'https://client.example/x#', 'https://user@client.example/x']) { await expect(registry.resolve(id)).rejects.toThrow('invalid_client'); }
    expect(calls).toBe(0);
});

test('CIMD refuses redirects, mismatched IDs, unsupported authentication, compressed or oversized bodies', async () => {
    const id = 'https://client.example/client.json';
    const cases = [() => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } }), () => json(document('https://evil.example/id')), () => json(document(id, { token_endpoint_auth_method: 'private_key_jwt' })), () => json(document(id, { client_name: '' })), () => json(document(id, { client_uri: 'https://evil.example/' })), () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), () => new Response('x'.repeat(5121), { headers: { 'content-type': 'application/json' } }), () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '5121' } })];
    for (const response of cases) { await expect(new ClientRegistry({ crypto, fetchMetadata: async () => response() }).resolve(id)).rejects.toThrow('invalid_client_metadata'); }
});

test('global deadline bounds stalled DNS/headers and streamed body, aborts transport and caps in-flight work', async () => {
    const id = 'https://client.example/client.json'; let signal: AbortSignal | null | undefined;
    const registry = new ClientRegistry({ crypto, timeoutMs: 5, fetchMetadata: async (_input, options) => { signal = options?.signal; return new Promise(() => {}); } });
    await expect(registry.resolve(id)).rejects.toThrow('temporarily_unavailable'); expect(signal?.aborted).toBe(true);
    const pending = Promise.allSettled(Array.from({ length: 8 }, (_, index) => registry.resolve(`https://client.example/${index}.json`)));
    await expect(registry.resolve('https://client.example/ninth.json')).rejects.toThrow('temporarily_unavailable');
    for (const result of await pending) { expect(result.status).toBe('rejected'); if (result.status === 'rejected') { expect(String(result.reason)).toBe('Error: temporarily_unavailable'); } }
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } });
    await expect(new ClientRegistry({ crypto, timeoutMs: 5, fetchMetadata: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) }).resolve(id)).rejects.toThrow('temporarily_unavailable');
});

test('maintained transport source pins validated DNS answers and preserves TLS identity without redirects', () => {
    // Audit the installed transport rather than sending actual requests to private addresses.
    const source = readFileSync(new URL('../node_modules/@better-auth/cimd/dist/node.mjs', import.meta.url), 'utf8');
    expect(source.match(/await lookup\(/gu)?.length).toBe(1);
    expect(source).toContain('for (const result of addresses) if (!isPublicRoutableHost(result.address)) throw');
    expect(source).toContain('callback(null, [pinnedAddress])'); expect(source).toContain('callback(null, pinnedAddress.address, pinnedAddress.family)');
    expect(source).toContain('agent: false'); expect(source).toContain('headers.host = url.host'); expect(source).toContain('servername:');
    expect(source).not.toContain('rejectUnauthorized: false'); expect(source).not.toContain('fetch(');
});

test('CIMD SEP-3149 capabilities explicitly negotiate none; legacy preference alone never downgrades', async () => {
    const id = 'https://client.example/metadata.json';
    for (const extra of [{ token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] }, { token_endpoint_auth_methods_supported: ['none'] }]) {
        const registry = new ClientRegistry({ crypto, fetchMetadata: async () => json(document(id, extra)) });
        expect((await registry.resolve(id)).authMethod).toBe('none');
    }
    for (const extra of [{ token_endpoint_auth_method: 'private_key_jwt' }, { token_endpoint_auth_methods_supported: ['private_key_jwt'] }, { token_endpoint_auth_methods_supported: 'none' }, { token_endpoint_auth_methods_supported: [null, 'none'] }, { token_endpoint_auth_methods_supported: [] }, { token_endpoint_auth_methods_supported: ['bogus', 'none'] }]) {
        await expect(new ClientRegistry({ crypto, fetchMetadata: async () => json(document(id, extra)) }).resolve(id)).rejects.toThrow('invalid_client_metadata');
    }
});

test('underlying transport slots survive caller deadlines; late settlement frees exactly one and never caches', async () => {
    const transports: { id: string; signal: AbortSignal | null | undefined; settle: (response: Response) => void }[] = [];
    let cancelled = 0;
    const registry = new ClientRegistry({ crypto, timeoutMs: 10, fetchMetadata: (input, options) => new Promise<Response>(settle => { transports.push({ id: String(input), signal: options?.signal, settle }); }) });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => registry.resolve(`https://client.example/${index}.json`)));
    expect(transports.length).toBe(8);
    for (const result of results) { expect(result.status).toBe('rejected'); if (result.status === 'rejected') { expect(String(result.reason)).toBe('Error: temporarily_unavailable'); } }
    expect(transports.every(item => item.signal?.aborted)).toBe(true);
    for (let attempt = 0; attempt < 3; attempt++) { await expect(registry.resolve('https://client.example/ninth.json')).rejects.toThrow('temporarily_unavailable'); }
    expect(transports.length).toBe(8);
    const first = transports[0]; if (!first) { throw new Error('Missing transport'); }
    first.settle(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
    // Flush the settled underlying operation and its independent slot release.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled).toBe(1);
    const nextId = 'https://client.example/ninth.json';
    const next = registry.resolve(nextId);
    expect(transports.length).toBe(9);
    await expect(registry.resolve('https://client.example/tenth.json')).rejects.toThrow('temporarily_unavailable');
    const ninth = transports[8]; if (!ninth) { throw new Error('Missing ninth transport'); }
    ninth.settle(json(document(nextId)));
    expect((await next).clientId).toBe(nextId);
    // The expired first lookup must refetch, rather than yielding metadata from a late response.
    const retry = registry.resolve(first.id);
    expect(transports.length).toBe(10);
    const retryTransport = transports[9]; if (!retryTransport) { throw new Error('Missing retry transport'); }
    retryTransport.settle(json(document(first.id)));
    expect((await retry).clientId).toBe(first.id);
    // Release remaining controlled transports after the assertions.
    for (const transport of transports.slice(1, 8)) { transport.settle(json(document(transport.id))); }
});

test('DCR and CIMD require the complete v1 code plus refresh flow and default omitted grants consistently', async () => {
    const id = 'https://client.example/grants.json';
    const registry = new ClientRegistry({ crypto });
    for (const extra of [{}, { grant_types: ['authorization_code', 'refresh_token'] }, { grant_types: ['refresh_token', 'authorization_code'] }]) {
        const registration = registry.register({ ...publicMetadata, ...extra });
        expect(registration.grant_types).toEqual(['authorization_code', 'refresh_token']);
        expect((await registry.resolve(registration.client_id)).grantTypes).toEqual(['authorization_code', 'refresh_token']);
        const cimd = new ClientRegistry({ crypto, fetchMetadata: async () => json(document(id, extra)) });
        expect((await cimd.resolve(id)).grantTypes).toEqual(['authorization_code', 'refresh_token']);
    }
    for (const grants of [null, [], 'authorization_code', ['authorization_code'], ['refresh_token'], ['authorization_code', 'authorization_code'], ['authorization_code', 'refresh_token', 'refresh_token'], ['authorization_code', null]]) {
        expect(() => registry.register({ ...publicMetadata, grant_types: grants })).toThrow('invalid_client_metadata');
        await expect(new ClientRegistry({ crypto, fetchMetadata: async () => json(document(id, { grant_types: grants })) }).resolve(id)).rejects.toThrow('invalid_client_metadata');
    }
});

// Public snapshot fetched from this client_id on 2026-10-26; contains no user data or credentials.
const claudeMetadata = {"client_id":"https://claude.ai/oauth/mcp-oauth-client-metadata","client_name":"Claude","client_uri":"https://claude.ai","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"grant_types":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"response_types":["code"],"token_endpoint_auth_method":"none"};

test('public Claude CIMD and unrelated extension capabilities select only the supported grant pair', async () => {
    for (const metadata of [claudeMetadata, { ...claudeMetadata, grant_types: ['urn:example:custom-grant', 'refresh_token', 'authorization_code', 'client_credentials'] }]) {
        const registry = new ClientRegistry({ crypto, fetchMetadata: async () => json(metadata) });
        const client = await registry.resolve(metadata.client_id);
        expect(client.name).toBe('Claude'); expect(client.authMethod).toBe('none');
        expect(client.redirectUris).toEqual(claudeMetadata.redirect_uris);
        expect(client.grantTypes).toEqual(['authorization_code', 'refresh_token']);
        expect(() => registry.register(metadata)).toThrow('invalid_client_metadata');
    }
});

test('CIMD validates every grant capability before discarding unsupported grants', async () => {
    const pair = ['authorization_code', 'refresh_token'];
    for (const grant_types of [[...pair, null], [...pair, 1], [...pair, {}], [...pair, ''], [...pair, 'bad grant'], [...pair, 'bad\n'], [...pair, 'bad\u007f'], [...pair, 'x'.repeat(257)], [...pair, 'urn:example:grant', 'urn:example:grant'], [...pair, 'authorization_code'], [...pair, ...Array.from({ length: 15 }, (_, index) => 'urn:example:grant:' + index)], ['authorization_code', 'urn:example:grant'], ['refresh_token', 'urn:example:grant']]) {
        const registry = new ClientRegistry({ crypto, fetchMetadata: async () => json({ ...claudeMetadata, grant_types }) });
        await expect(registry.resolve(claudeMetadata.client_id)).rejects.toThrow('invalid_client_metadata');
    }
});
