import { afterEach, beforeEach, expect, spyOn, test, type Mock } from 'bun:test';
import type { LambdaContext } from '@hono/aws-lambda';
import { createLambdaHandler } from '../src/handler';
import { AuthCrypto, connectionAAD } from '../src/auth/crypto';
import { AuthEngine } from '../src/auth/engine';
import { ClientRegistry } from '../src/auth/clients';
import { CalDavSessionValidator } from '../src/auth/caldav-session';
import type { UpstreamCredentials } from '../src/auth/contracts';
import { lambdaEvent } from './helpers/lambda';
import { FAKE_DISCOVERY } from './helpers/fake-caldav';
import { ACCOUNT_ID, APPLE_ID, CALENDARS, PASSWORD, callTool, connect, issuer, page, post, setup, start, submit, tokenRequest } from './helpers/http-env';

let warn: Mock<(...args: unknown[]) => void>;
beforeEach(() => { warn = spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { expect(JSON.stringify(warn.mock.calls)).not.toContain(PASSWORD); warn.mockRestore(); });

test('browser login, PKCE, native callback, rotating refresh and authenticated MCP', async () => {
    const env = setup(); const { tokens, fields } = await connect(env);
    expect((await post(env.app, '/token', fields)).status).toBe(400);
    const rpc = await callTool(env, tokens.access_token, 'list_calendars');
    expect(rpc.status).toBe(200); const result = await rpc.json();
    expect(result.result.structuredContent).toEqual({ calendars: CALENDARS, truncated: false }); expect(result.result._meta).toBeUndefined();
    const refresh = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.params.get('client_id') ?? '', resource: `${issuer}/mcp`, refresh_token: tokens.refresh_token });
    const rotated = await post(env.app, '/token', refresh); expect(rotated.status).toBe(200); const next = await rotated.json(); expect(next.refresh_token).not.toBe(tokens.refresh_token); expect(await (await post(env.app, '/token', refresh)).json()).toEqual(next);
    env.caldav.validateOverride = 'temporary'; const latest = new URLSearchParams(refresh); latest.set('refresh_token', next.refresh_token); expect((await post(env.app, '/token', latest)).status).toBe(503);
    env.caldav.validateOverride = undefined; expect((await post(env.app, '/token', latest)).status).toBe(200);
});
test('CSRF origin, tampered public fields and duplicate parameters never reach backend discovery', async () => {
    const env = setup(); const login = await start(env);
    const filled = new URLSearchParams(login.fields); filled.set('apple_id', APPLE_ID); filled.set('app_password', PASSWORD); filled.set('decision', 'allow');
    expect((await post(env.app, '/auth/connect', filled, login.cookie, 'https://attacker.example')).status).toBe(400);
    const noOrigin = await env.app.request('/auth/connect', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: login.cookie }, body: filled.toString() }); expect(noOrigin.status).toBe(400);
    const tamper = new URLSearchParams(filled); tamper.set('scope', 'calendar:read calendar:write'); expect((await post(env.app, '/auth/connect', tamper, login.cookie)).status).toBe(400);
    const duplicate = new URLSearchParams(filled); duplicate.append('csrf', 'other'); expect((await post(env.app, '/auth/connect', duplicate, login.cookie)).status).toBe(400);
    const wrongCsrf = new URLSearchParams(filled); wrongCsrf.set('csrf', 'x'.repeat(43)); expect((await post(env.app, '/auth/connect', wrongCsrf, login.cookie)).status).toBe(400);
    expect((await post(env.app, '/auth/connect', filled)).status).toBe(400);
    expect((await env.app.request('/auth/connect?x=1', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: issuer, cookie: login.cookie }, body: filled.toString() })).status).toBe(400);
    expect(env.caldav.count()).toBe(0);
    const invalid = new URLSearchParams(env.params); invalid.set('redirect_uri', 'https://attacker.example'); const bad = await env.app.request(`/authorize?${invalid}`); expect(bad.status).toBe(400); expect(bad.headers.get('location')).toBeNull();
});
test('token endpoint rejects duplicate fields, mixed authentication and wrong resource', async () => {
    const env = setup(); const { fields } = await connect(env); fields.set('code', 'bad'); fields.append('client_id', 'other'); expect((await post(env.app, '/token', fields)).status).toBe(400); fields.delete('client_id'); fields.set('client_id', env.params.get('client_id') ?? '');
    expect((await env.app.request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic dXNlcjpwYXNz' }, body: fields.toString() })).status).toBe(401);
    fields.set('resource', 'https://attacker.example/mcp'); expect((await post(env.app, '/token', fields)).status).toBe(400);
});
test('Lambda adapter carries browser cookies, redirects, metadata and token errors', async () => {
    const env = setup(); const handler = createLambdaHandler(env.app);
    const response = await handler(lambdaEvent(`/authorize?${env.params}`), {} as LambdaContext); expect(response.statusCode).toBe(200); expect(response.cookies?.[0]).toContain('__Host-caldav-flow='); expect(response.body).toContain('Connect your iCloud calendar');
    expect((await handler(lambdaEvent('/mcp'), {} as LambdaContext)).statusCode).toBe(401);
    const token = lambdaEvent('/token', 'POST', 'client_id=one&client_id=two'); token.headers['content-type'] = 'application/x-www-form-urlencoded'; expect((await handler(token, {} as LambdaContext)).statusCode).toBe(400);
});
test('upstream expiration makes refresh actionable and MCP reports reconnect without accepting static headers', async () => {
    const env = setup(); const { tokens } = await connect(env); env.caldav.validateOverride = 'expired';
    const refresh = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.params.get('client_id') ?? '', resource: `${issuer}/mcp`, refresh_token: tokens.refresh_token });
    const expired = await post(env.app, '/token', refresh); expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ error: 'invalid_grant', error_description: 'Reconnect your iCloud account and authorize this client again.' });
    const connection = await env.store.get('connection', ACCOUNT_ID); expect(connection?.kind === 'connection' && connection.status).toBe('reconnect_required');
    const calls = env.caldav.count('listCalendars');
    const tool = await (await callTool(env, tokens.access_token, 'list_calendars')).json();
    expect(tool.result.isError).toBe(true); expect(tool.result.structuredContent.error.code).toBe('reconnect_required'); expect(env.caldav.count('listCalendars')).toBe(calls);
    expect((await env.app.request('/mcp', { headers: { 'x-access-token': 'fabricated', authorization: `Basic ${Buffer.from(`${APPLE_ID}:${PASSWORD}`).toString('base64')}` } })).status).toBe(401);
});
test.each(['client_secret_basic', 'client_secret_post'])('registered confidential clients enforce %s across HTTP and revocation', async method => {
    const env = setup();
    const registration = await env.app.request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Confidential', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: method }) });
    expect(registration.status).toBe(201); expect(registration.headers.get('access-control-allow-origin')).toBe('*');
    const client = await registration.json();
    const fields = new URLSearchParams({ token: 'unrecognized' });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (method === 'client_secret_basic') { headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`; }
    else { fields.set('client_id', client.client_id); fields.set('client_secret', client.client_secret); }
    expect((await env.app.request('/revoke', { method: 'POST', headers, body: fields.toString() })).status).toBe(200);
    if (method === 'client_secret_basic') { headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:wrong`).toString('base64')}`; }
    else { fields.set('client_secret', 'wrong'); }
    expect((await env.app.request('/revoke', { method: 'POST', headers, body: fields.toString() })).status).toBe(401);
});
test('CIMD public client metadata resolves through HTTP and escapes presentation data', async () => {
    const env = setup(); const id = 'https://client.example/oauth/client.json';
    env.runtime.clients = new ClientRegistry({ crypto: env.runtime.crypto, fetchMetadata: async () => new Response(JSON.stringify({ client_id: id, client_name: '<Metadata client>', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_methods_supported: ['none'] }), { headers: { 'content-type': 'application/json' } }) });
    const params = new URLSearchParams(env.params); params.set('client_id', id); params.set('redirect_uri', 'https://client.example/callback');
    const response = await env.app.request(`/authorize?${params}`); expect(response.status).toBe(200); const html = await response.text();
    expect(html).toContain('&lt;Metadata client&gt;'); expect(html).not.toContain('<Metadata client>'); expect(html).toContain('client.example');
});
test('PKCE failure preserves code for the correct verifier and HTTP revocation invalidates access', async () => {
    const env = setup(); const login = await start(env); const callback = await submit(env, login);
    const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const fields = new URLSearchParams({ grant_type: 'authorization_code', client_id: env.params.get('client_id') ?? '', redirect_uri: env.params.get('redirect_uri') ?? '', resource: `${issuer}/mcp`, code, code_verifier: 'w'.repeat(43) });
    expect((await post(env.app, '/token', fields)).status).toBe(400); fields.set('code_verifier', env.verifier); const response = await post(env.app, '/token', fields); expect(response.status).toBe(200); const tokens = await response.json();
    expect((await post(env.app, '/revoke', new URLSearchParams({ client_id: env.params.get('client_id') ?? '', token: tokens.refresh_token }))).status).toBe(200);
    expect((await env.app.request('/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
});
test('matching Basic body client_id completes a confidential authorization-code exchange', async () => {
    const env = setup({ authMethod: 'client_secret_basic' }); const { tokens } = await connect(env); expect(tokens.refresh_token).toBeString();
    const body = new URLSearchParams({ grant_type: 'refresh_token', resource: `${issuer}/mcp`, refresh_token: tokens.refresh_token, client_id: env.registration.client_id });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${encodeURIComponent(env.registration.client_id)}:${encodeURIComponent(env.registration.client_secret ?? '')}`).toString('base64')}` };
    expect((await env.app.request('/token', { method: 'POST', headers, body: body.toString() })).status).toBe(200);
    body.set('client_id', 'mismatched'); expect((await env.app.request('/token', { method: 'POST', headers, body: body.toString() })).status).toBe(401);
    body.set('client_id', env.registration.client_id); body.set('client_secret', env.registration.client_secret ?? ''); expect((await env.app.request('/token', { method: 'POST', headers, body: body.toString() })).status).toBe(401);
    body.delete('client_secret'); body.set('client_assertion', 'unsupported'); expect((await env.app.request('/token', { method: 'POST', headers, body: body.toString() })).status).toBe(401);
    body.delete('client_assertion'); expect((await env.app.request('/token', { method: 'POST', headers: { ...headers, authorization: `${headers.authorization}, ${headers.authorization}` }, body: body.toString() })).status).toBe(401);
});
test('a duplicate connect delivery preserves the first callback credential generation', async () => {
    const env = setup(); const { tokens } = await connect(env, { duplicate: true }); expect(tokens.access_token).toBeString();
    const connection = await env.store.get('connection', ACCOUNT_ID); if (connection?.kind !== 'connection') { throw new Error('missing connection'); }
    expect(connection.credentialGeneration).toBe(1);
});
test.each(['expired', 'revoked', 'reconnect_required'])('identical credentials revive a %s connection only after fresh iCloud proof', async state => {
    const env = setup(); const login = await start(env); expect((await submit(env, login)).status).toBe(302);
    const previous = await env.store.get('connection', ACCOUNT_ID); if (previous?.kind !== 'connection') { throw new Error('missing connection'); }
    await env.store.transact({ conditions: [{ kind: 'connection', id: previous.id, revision: previous.revision }], puts: [{ ...previous, revision: previous.revision + 1, ...(state === 'expired' ? { expiresAt: Math.floor(Date.now() / 1000) - 1 } : { status: state as 'revoked' | 'reconnect_required' }) }], operationId: `test-${state}` });
    // A replay that iCloud now rejects cannot revive the record.
    env.caldav.setPassword(APPLE_ID, 'rotated-at-apple');
    expect((await submit(env, login)).status).toBe(400);
    const unchanged = await env.store.get('connection', ACCOUNT_ID); expect(unchanged).toMatchObject({ credentialGeneration: 1, revision: previous.revision + 1 });
    // The same password, freshly accepted by iCloud, replaces it under a new generation rather than reusing the dead record.
    env.caldav.setPassword(APPLE_ID, PASSWORD);
    expect((await submit(env, login)).status).toBe(302);
    expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ status: 'active', credentialGeneration: 2 });
});
test.each(['retired-key', 'damaged-ciphertext'])('fresh login replaces %s canonical credentials', async failure => {
    const env = setup();
    const credentials: UpstreamCredentials = { accountId: ACCOUNT_ID, appleId: APPLE_ID, appPassword: PASSWORD, ...FAKE_DISCOVERY, issuedAt: Math.floor(Date.now() / 1000) };
    const previous = await env.runtime.engine.connectOrReconnect({ accountId: ACCOUNT_ID, credentials, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (failure === 'damaged-ciphertext') {
        expect(await env.store.transact({ conditions: [{ kind: 'connection', id: previous.id, revision: previous.revision }], puts: [{ ...previous, revision: previous.revision + 1, credentials: { ...previous.credentials, tag: 'invalid' } }], operationId: 'damage-old-ciphertext' })).toBe(true);
    }
    const v2 = new AuthCrypto({ activeKeyId: 'v2', keys: { v2: new Uint8Array(32).fill(9), ...(failure === 'damaged-ciphertext' ? { v1: new Uint8Array(32).fill(3) } : {}) } });
    const fresh = 'fresh-app-password';
    env.caldav.setPassword(APPLE_ID, fresh);
    env.runtime.crypto = v2;
    env.runtime.clients = new ClientRegistry({ crypto: v2 });
    env.runtime.engine = new AuthEngine(env.store, v2, new CalDavSessionValidator(env.caldav, v2, env.runtime.allowedAccountIds), { issuer, refreshRetrySeconds: 10 });
    const registration = env.runtime.clients.register({ client_name: 'After rotation', redirect_uris: ['http://127.0.0.1/callback'], application_type: 'native', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    env.registration = registration; env.params.set('client_id', registration.client_id);
    expect((await post(env.app, '/auth/connect', new URLSearchParams({ ...Object.fromEntries(env.params), decision: 'allow', csrf: 'invented', apple_id: APPLE_ID, app_password: fresh }))).status).toBe(400);
    const validations = env.caldav.count('validate');
    const { tokens } = await connect(env, { password: fresh }); expect(tokens.access_token).toBeString();
    expect(env.caldav.count('validate') - validations).toBeGreaterThanOrEqual(3);
    const current = await env.store.get('connection', ACCOUNT_ID); if (current?.kind !== 'connection') { throw new Error('missing canonical connection'); }
    expect(current.id).toBe(previous.id); expect(current.credentialGeneration).toBe(previous.credentialGeneration + 1); expect(current.credentials.keyId).toBe('v2');
    expect(v2.open<UpstreamCredentials>('upstream-credentials', connectionAAD(current), current.credentials)).toMatchObject({ accountId: ACCOUNT_ID, appleId: APPLE_ID, appPassword: fresh, ...FAKE_DISCOVERY });
});
test('published Claude CIMD reaches login while extra JWT grant capabilities remain unsupported', async () => {
    const env = setup();
    // Exact public document snapshot, 2026-10-26; this test never calls account or upstream APIs.
    const metadata = {"client_id":"https://claude.ai/oauth/mcp-oauth-client-metadata","client_name":"Claude","client_uri":"https://claude.ai","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"grant_types":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"response_types":["code"],"token_endpoint_auth_method":"none"};
    let fetches = 0;
    env.runtime.clients = new ClientRegistry({ crypto: env.runtime.crypto, fetchMetadata: async input => { expect(String(input)).toBe(metadata.client_id); fetches++; return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } }); } });
    const params = new URLSearchParams(env.params); params.set('client_id', metadata.client_id); params.set('redirect_uri', metadata.redirect_uris[0] ?? '');
    const begin = await env.app.request('/authorize?' + params);
    expect(begin.status).toBe(200); const html = await begin.text();
    expect(html).toContain('Connect your iCloud calendar'); expect(html).toContain('Claude (claude.ai)');
    expect(begin.headers.get('set-cookie')).toContain('__Host-caldav-flow=');
    expect(env.caldav.count()).toBe(0); expect(fetches).toBe(1);
    const fields = new URLSearchParams({ client_id: metadata.client_id, resource: issuer + '/mcp', grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJmaXh0dXJlIiwic3ViIjoiZml4dHVyZSJ9.c2lnbmF0dXJl' });
    const unsupported = await post(env.app, '/token', fields);
    expect(unsupported.status).toBe(400); expect(await unsupported.json()).toEqual({ error: 'unsupported_grant_type' });
    fields.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'); fields.set('client_assertion', fields.get('assertion') ?? '');
    const wrongMethod = await post(env.app, '/token', fields);
    expect(wrongMethod.status).toBe(401); expect(await wrongMethod.json()).toEqual({ error: 'invalid_client' });
    const discovery = await (await env.app.request('/.well-known/oauth-authorization-server')).json();
    expect(discovery.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(discovery.token_endpoint_auth_methods_supported).not.toContain('private_key_jwt');
    expect(env.caldav.count()).toBe(0);
});
test('authenticated HTTP binds identity and permits multi-megabyte requests without exposing credentials', async () => {
    const env = setup(); const { tokens } = await connect(env);
    const listed = await callTool(env, tokens.access_token, 'list_calendars');
    expect(listed.status).toBe(200); const output = JSON.stringify(await listed.json());
    for (const secret of [PASSWORD, tokens.access_token, tokens.refresh_token, APPLE_ID, FAKE_DISCOVERY.principalUrl]) { expect(output).not.toContain(secret); }
    const call = env.caldav.calls.at(-1); expect(call).toEqual({ method: 'listCalendars', appleId: APPLE_ID, appPassword: PASSWORD, discovery: { ...FAKE_DISCOVERY } });
    const larger = await callTool(env, tokens.access_token, 'list_calendars', { padding: 'x'.repeat(2 * 1024 * 1024) });
    expect(larger.status).toBe(200); const denied = await larger.json(); expect(Boolean(denied.error || denied.result?.isError)).toBe(true);
    expect(env.caldav.count('listCalendars')).toBe(1);
});
test('invite permission needs its own explicit consent checkbox without granting extra scopes', async () => {
    const env = setup({ scope: 'calendar:read calendar:invite' });
    const login = await start(env); expect(login.html).toContain('name="allow_invite" value="yes" required');
    expect((await submit(env, login)).status).toBe(400); expect(env.caldav.count()).toBe(0);
    const approved = await submit(env, login, { extra: { allow_invite: 'yes' } }); expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get('location') ?? ''); const response = await tokenRequest(env, callback.searchParams.get('code') ?? '');
    expect(response.status).toBe(200); expect((await response.json()).scope).toBe('calendar:invite calendar:read');
    const plain = setup({ scope: 'calendar:read calendar:write' });
    const form = await start(plain); expect(form.html).not.toContain('allow_invite');
    expect((await submit(plain, form)).status).toBe(302);
});
// Keep the helper's page parser exercised for hidden-field escaping.
test('hidden public fields round-trip HTML escaping', async () => {
    const env = setup(); env.params.set('state', `"<&'>`);
    const response = await env.app.request(`/authorize?${env.params}`); const html = await response.text();
    expect(html).not.toContain(`"<&'>`); expect(page(response, html).fields.get('state')).toBe(`"<&'>`);
});
