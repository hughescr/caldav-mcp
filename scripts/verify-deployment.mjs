import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const stack = JSON.parse(execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', process.env.STACK_NAME ?? 'caldav-mcp-prod', '--output', 'json'], { encoding: 'utf8', timeout: 30_000 }));
const outputs = stack.Stacks[0].Outputs;
const deployed = JSON.parse(execFileSync('aws', ['lambda', 'get-function-configuration', '--function-name', 'caldav-mcp-prod-api', '--output', 'json'], { encoding: 'utf8', timeout: 30_000 }));
// The allowlist is checked only for presence and shape. Its value is never printed or placed in a message.
const liveAllowlist = deployed.Environment?.Variables?.ALLOWED_APPLE_ID_HASHES;
assert.ok(typeof liveAllowlist === 'string' && liveAllowlist.trim() !== '', 'Live Lambda must have a non-empty ALLOWED_APPLE_ID_HASHES (an empty allowlist lets nobody connect)');
assert.ok(liveAllowlist.split(',').every(entry => /^[A-Za-z0-9_-]{43}$/.test(entry)), 'Live Lambda ALLOWED_APPLE_ID_HASHES must contain only well-formed account hashes');
const base = outputs.find(entry => entry.OutputKey === 'PublicBaseUrl')?.OutputValue;
assert.ok(base, 'Canonical CloudFront origin must be a stack output');
const issuer = new URL(base).origin;
const request = (path, options = {}) => fetch(new URL(path, base), { ...options, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
const health = await request('/healthz');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { service: 'caldav-mcp', version, status: 'oauth' }, 'Live service must serve the checked-out release');
const ready = await request('/readyz');
assert.equal(ready.status, 200);
assert.deepEqual(await ready.json(), { ready: true });
const challenge = `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`;
for (const authorization of [undefined, 'Bearer fabricated']) {
    const mcp = await request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { authorization } : {}) }, body: '{}' });
    assert.equal(mcp.status, 401);
    assert.equal(mcp.headers.get('www-authenticate'), challenge, 'The public endpoint must preserve the real standard OAuth challenge header');
    assert.ok(mcp.headers.get('access-control-expose-headers')?.toLowerCase().split(',').map(value => value.trim()).includes('www-authenticate'));
    assert.deepEqual((await mcp.json())._meta['mcp/www_authenticate'], [challenge]);
}
const invalidClient = await request('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code' });
assert.equal(invalidClient.status, 401);
assert.equal(invalidClient.headers.get('www-authenticate'), 'Basic realm="oauth"');
// A malformed bearer fails with or without forwarding, so it cannot prove that
// CloudFront preserves Authorization. Correct confidential Basic authentication
// must succeed while absent/wrong authentication fails. Keep the generated secret
// in this process only; the fabricated revocation token causes no database write.
const confidentialRegistration = await request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Deployment authorization-header check', application_type: 'native', redirect_uris: ['http://127.0.0.1:1/callback'], token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code', 'refresh_token'] }) });
assert.equal(confidentialRegistration.status, 201);
const confidential = await confidentialRegistration.json();
assert.ok(typeof confidential.client_id === 'string' && typeof confidential.client_secret === 'string', 'Confidential registration must return credentials');
const basic = secret => `Basic ${Buffer.from(`${encodeURIComponent(confidential.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
for (const [authorization, expected] of [[undefined, 401], [basic('wrong-secret'), 401], [basic(confidential.client_secret), 200]]) {
    const revoke = await request('/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(authorization ? { Authorization: authorization } : {}) }, body: new URLSearchParams({ client_id: confidential.client_id, token: 'fabricated' }).toString() });
    assert.equal(revoke.status, expected, 'The public endpoint must forward correct Basic credentials and reject missing/wrong credentials');
    if (expected === 401) { assert.equal(revoke.headers.get('www-authenticate'), 'Basic realm="oauth"'); }
}
const metadata = await request('/.well-known/oauth-authorization-server');
assert.equal(metadata.status, 200);
assert.equal((await metadata.json()).issuer, issuer);
for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const resource = await request(path); assert.equal(resource.status, 200);
    const document = await resource.json(); assert.equal(document.resource, `${issuer}/mcp`); assert.deepEqual(document.authorization_servers, [issuer]);
}
// Stateless anonymous registration + login-page cancel exercise the actual gateway's
// form, query, cookie and redirect translation without a real account or DynamoDB write.
// The cancel decision is handled before any Apple ID or password is read, so no
// credentials are sent and nothing is looked up or stored.
const registration = await request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Deployment protocol check', application_type: 'native', redirect_uris: ['http://127.0.0.1:1/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }) });
assert.equal(registration.status, 201);
const client = await registration.json();
const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], resource: `${issuer}/mcp`, scope: 'calendar:read', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'), state: 'deployment-cancel' });
const login = await request(`/authorize?${params}`); assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie()[0];
assert.ok(cookie && /; Secure(?:;|$)/i.test(cookie) && /; HttpOnly(?:;|$)/i.test(cookie) && /; SameSite=Lax(?:;|$)/i.test(cookie), 'Browser flow cookie flags must survive the gateway');
const html = await login.text();
const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1]; assert.ok(csrf, 'Login form must include a CSRF token');
const denied = new URLSearchParams(params); denied.set('csrf', csrf); denied.set('decision', 'cancel');
const cancelled = await request('/auth/connect', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: issuer, Cookie: cookie.split(';')[0] }, body: denied.toString() });
assert.equal(cancelled.status, 302);
assert.equal(cancelled.headers.get('referrer-policy'), 'no-referrer');
const callback = new URL(cancelled.headers.get('location'));
assert.equal(callback.origin, 'http://127.0.0.1:1'); assert.equal(callback.searchParams.get('error'), 'access_denied'); assert.equal(callback.searchParams.get('state'), 'deployment-cancel'); assert.equal(callback.searchParams.get('iss'), issuer);
