import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { accountIdFor } from '../src/account';
import { connectionAAD } from '../src/auth/crypto';
import { TemporaryUnavailable, type Sealed, type UpstreamCredentials } from '../src/auth/contracts';
import { CalDavError } from '../src/caldav/contracts';
import { PAGE_STYLE_SOURCE } from '../src/auth/page-style';
import { FAKE_DISCOVERY } from './helpers/fake-caldav';
import { ACCOUNT_ID, APPLE_ID, OTHER_APPLE_ID, PASSWORD, callTool, connect, everything, issuer, setup, start, submit, tokenRequest, type Env } from './helpers/http-env';

const FAILURE_TEXT = 'Sign-in failed. Check the Apple ID and app-specific password, then start the connection again.';
const WRONG = 'wrong-pass-word-0000';

let spies: Mock<(...args: unknown[]) => void>[] = [];
beforeEach(() => {
    spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => spyOn(console, method).mockImplementation(() => {}));
});
afterEach(() => {
    for (const spy of spies) { spy.mockRestore(); }
});
function logged(): string {
    return JSON.stringify(spies.map(spy => spy.mock.calls));
}

async function fail(env: Env, count: number, password = WRONG) {
    for (let index = 0; index < count; index++) {
        const form = await start(env);
        expect((await submit(env, form, { password })).status).toBe(400);
    }
}

describe('single-page login and consent', () => {
    test('one page shows client, identity, redirect, scopes and both credential fields with safe autocomplete', async () => {
        const env = setup({ scope: 'calendar:read calendar:write' });
        const { html, response } = await start(env);
        expect(response.headers.get('content-security-policy')).toBe(`default-src 'none'; style-src ${PAGE_STYLE_SOURCE}; form-action 'self' http://127.0.0.1:5678; frame-ancestors 'none'; base-uri 'none'`);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(html).toContain('<strong>&lt;Client&gt;</strong> (Registered OAuth client)');
        expect(html).toContain('Redirect destination · <span class="host">127.0.0.1</span>');
        expect(html).toContain('<li class="permission"><span>Read your calendars and events (always included)<small>calendar:read</small></span></li>');
        expect(html).toContain('<label class="permission"><input type="checkbox" name="grant" value="calendar:write" checked><span>Create and change events<small>calendar:write</small></span></label>');
        expect(html).not.toMatch(/<li[^>]*>(?:(?!<\/li>)[^])*<input/);
        expect(html).toContain('<form method="post" action="/auth/connect">');
        expect(html).toMatch(/<input id="apple" name="apple_id" type="email" autocomplete="username"[^>]* required/);
        expect(html).toMatch(/<input id="password" name="app_password" type="password" autocomplete="off"[^>]* maxlength="256"[^>]* required/);
        expect(html).toContain('Never use your main Apple Account password.');
        expect(html).toContain('only for this connector');
        expect(html).toContain('Your password is stored encrypted and used only to talk to iCloud.');
        expect(html).toContain('<button class="primary" name="decision" value="allow">Connect and allow</button>');
        expect(html).toContain('<button class="secondary" name="decision" value="cancel" formnovalidate>Cancel</button>');
        expect(html.indexOf('value="allow"')).toBeLessThan(html.indexOf('value="cancel"'));
        expect(html).not.toContain('totp');
        expect(html).not.toContain('allow_invite');
        expect(html).not.toMatch(/<script|<link|<img/);
    });

    test('the flow cookie is a sealed, Secure, HttpOnly, SameSite=Lax value holding only deadline, csrf, flowId and binding', async () => {
        const env = setup();
        const { response, cookie } = await start(env);
        const header = response.headers.get('set-cookie') ?? '';
        expect(header).toMatch(/^__Host-caldav-flow=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
        const sealed = JSON.parse(Buffer.from(cookie.slice('__Host-caldav-flow='.length), 'base64url').toString('utf8')) as Sealed;
        const flow = env.crypto.open<Record<string, unknown>>('browser-flow', JSON.stringify([issuer, 1]), sealed);
        expect(Object.keys(flow).sort()).toEqual(['binding', 'csrf', 'deadline', 'flowId']);
    });

    test('a canary app password never appears in any response, redirect, cookie or log on any path', async () => {
        const responses: Response[] = [];
        // Success, then token exchange and an MCP call.
        const env = setup();
        const form = await start(env); responses.push(form.response);
        const success = await submit(env, form); responses.push(success);
        const code = new URL(success.headers.get('location') ?? '').searchParams.get('code') ?? '';
        const token = await tokenRequest(env, code); responses.push(token);
        const tokens = await token.clone().json();
        responses.push(await callTool(env, tokens.access_token, 'list_calendars'));
        // Wrong password: the canary is submitted for the right Apple ID but iCloud has another password.
        const wrong = setup(); wrong.caldav.setPassword(APPLE_ID, 'something-else-entirely');
        responses.push(await submit(wrong, await start(wrong)));
        // Temporary failure, including an upstream error object that (wrongly) carries the password.
        const temporary = setup(); temporary.caldav.script('discover', new CalDavError('temporary'), new Error(`upstream echoed ${PASSWORD}`));
        responses.push(await submit(temporary, await start(temporary)), await submit(temporary, await start(temporary)));
        // Throttled after five failures.
        const throttled = setup(); await fail(throttled, 5);
        const refused = await submit(throttled, await start(throttled)); expect(refused.status).toBe(429); responses.push(refused);
        // Cancel with the password still in the submitted form.
        const cancelled = setup(); const cancel = await submit(cancelled, await start(cancelled), { decision: 'cancel' });
        expect(cancel.status).toBe(302); expect(new URL(cancel.headers.get('location') ?? '').searchParams.get('error')).toBe('access_denied');
        expect(cancelled.caldav.count()).toBe(0); responses.push(cancel);
        expect(responses.map(response => response.status)).toEqual([200, 302, 200, 200, 400, 503, 503, 429, 302]);
        for (const response of responses) {
            const text = await everything(response);
            expect(text).not.toContain(PASSWORD);
            expect(text).not.toContain(encodeURIComponent(PASSWORD));
            expect(text).not.toContain(Buffer.from(PASSWORD).toString('base64'));
        }
        expect(logged()).not.toContain(PASSWORD);
        for (const store of [env.store, wrong.store, temporary.store, throttled.store, cancelled.store]) { expect(store.dump()).not.toContain(PASSWORD); }
    });

    test('the stored record holds the password only inside the sealed credential', async () => {
        const env = setup(); await connect(env);
        expect(env.store.dump()).not.toContain(PASSWORD);
        expect(env.store.dump()).not.toContain(APPLE_ID);
        const connection = await env.store.get('connection', ACCOUNT_ID); if (connection?.kind !== 'connection') { throw new Error('missing connection'); }
        expect(JSON.stringify(connection)).not.toContain(PASSWORD);
        expect(env.crypto.open<UpstreamCredentials>('upstream-credentials', connectionAAD(connection), connection.credentials)).toEqual({ accountId: ACCOUNT_ID, appleId: APPLE_ID, appPassword: PASSWORD, ...FAKE_DISCOVERY, issuedAt: expect.any(Number) as unknown as number });
    });

    test('a non-allowlisted Apple ID makes zero backend calls and looks exactly like a wrong password', async () => {
        const env = setup(); env.caldav.addAccount(OTHER_APPLE_ID, PASSWORD);
        const wrong = await submit(env, await start(env), { password: WRONG });
        const writes = env.store.writes.length; const calls = env.caldav.count();
        const outsider = await submit(env, await start(env), { appleId: OTHER_APPLE_ID });
        const syntax = await submit(env, await start(env), { appleId: 'not an apple id' });
        const empty = await submit(env, await start(env), { password: '   ' });
        const long = await submit(env, await start(env), { password: 'x'.repeat(257) });
        expect(env.caldav.count()).toBe(calls);
        expect(env.store.writes.length).toBe(writes);
        expect(await env.store.get('throttle', accountIdFor(OTHER_APPLE_ID))).toBeUndefined();
        const expected = await everything(wrong);
        expect(wrong.status).toBe(400); expect(expected).toContain(FAILURE_TEXT);
        for (const response of [outsider, syntax, empty, long]) { expect(await everything(response)).toBe(expected); }
    });

    test('an empty allowlist lets nobody connect', async () => {
        const env = setup({ allowed: [] });
        expect((await submit(env, await start(env))).status).toBe(400);
        expect(env.caldav.count()).toBe(0);
    });

    test('Apple ID is normalized and the password trimmed only of surrounding whitespace', async () => {
        const env = setup();
        const response = await submit(env, await start(env), { appleId: '  Calendar.User@Example.INVALID ', password: `  ${PASSWORD}\t` });
        expect(response.status).toBe(302);
        expect(env.caldav.calls[0]).toEqual({ method: 'discover', appleId: APPLE_ID, appPassword: PASSWORD });
        const hyphenless = setup(); hyphenless.caldav.setPassword(APPLE_ID, PASSWORD.replaceAll('-', ''));
        expect((await submit(hyphenless, await start(hyphenless))).status).toBe(400);
        expect(hyphenless.caldav.calls[0]?.appPassword).toBe(PASSWORD);
    });

    test('temporary upstream failures render 503 and do not count toward the throttle', async () => {
        const env = setup();
        for (let index = 0; index < 6; index++) { env.caldav.script('discover', new CalDavError(index % 2 ? 'protocol' : 'temporary')); }
        for (let index = 0; index < 6; index++) { expect((await submit(env, await start(env))).status).toBe(503); }
        expect(await env.store.get('throttle', ACCOUNT_ID)).toMatchObject({ failures: 0 });
        expect((await submit(env, await start(env))).status).toBe(302);
    });

    test('discovered URLs outside the fixed iCloud hosts are refused and nothing is stored', async () => {
        for (const discovery of [{ principalUrl: 'https://attacker.example/principal/', calendarHomeUrl: FAKE_DISCOVERY.calendarHomeUrl }, { principalUrl: FAKE_DISCOVERY.principalUrl, calendarHomeUrl: 'https://p01-caldav.icloud.com.attacker.example/home/' }]) {
            const env = setup(); env.caldav.script('discover', discovery);
            const response = await submit(env, await start(env));
            // Refused by the login flow itself, before the engine (whose validator would also refuse it).
            expect(response.status).toBe(503);
            expect(response.headers.get('content-type')).toContain('text/html');
            expect(await response.text()).toContain('iCloud sign-in is temporarily unavailable.');
            expect(await env.store.get('connection', ACCOUNT_ID)).toBeUndefined();
            const kinds = env.store.writes.flatMap(write => (JSON.parse(write) as { puts: { kind: string }[] }).puts.map(put => put.kind));
            expect(new Set(kinds)).toEqual(new Set(['throttle']));
            expect(await env.store.get('throttle', ACCOUNT_ID)).toMatchObject({ failures: 0 });
            expect(env.caldav.count('validate')).toBe(0);
        }
    });

    test('failures after discovery render the static pages and clear the flow cookie', async () => {
        const rejected = setup(); rejected.caldav.validateOverride = 'expired';
        const failed = await submit(rejected, await start(rejected));
        expect(failed.status).toBe(400);
        expect(failed.headers.get('content-type')).toContain('text/html');
        expect(await failed.clone().text()).toContain(FAILURE_TEXT);
        expect(failed.headers.get('set-cookie')).toContain('Max-Age=0');
        const unavailable = setup(); unavailable.store.failTransact = write => write.puts.some(put => put.kind === 'connection') ? new TemporaryUnavailable() : undefined;
        const temporary = await submit(unavailable, await start(unavailable));
        expect(temporary.status).toBe(503);
        expect(temporary.headers.get('content-type')).toContain('text/html');
        expect(await temporary.clone().text()).toContain('iCloud sign-in is temporarily unavailable.');
        for (const response of [failed, temporary]) { expect(await everything(response)).not.toContain(PASSWORD); }
    });

    test('cancel needs no credentials and makes no backend call', async () => {
        const env = setup(); const form = await start(env);
        const fields = new URLSearchParams(form.fields); fields.set('decision', 'cancel');
        const response = await env.app.request('/auth/connect', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: issuer, cookie: form.cookie }, body: fields.toString() });
        expect(response.status).toBe(302);
        const target = new URL(response.headers.get('location') ?? '');
        expect(Object.fromEntries(target.searchParams)).toEqual({ error: 'access_denied', iss: issuer, state: 'original-state' });
        expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
        expect(env.caldav.count()).toBe(0);
    });

    test('a missing or unknown decision is rejected before any backend call', async () => {
        const env = setup(); const form = await start(env);
        for (const decision of ['', 'approve']) { expect((await submit(env, form, { decision })).status).toBe(400); }
        expect(env.caldav.count()).toBe(0);
    });
});

describe('login throttle', () => {
    test('the sixth failure in the window is refused without a backend call, even with the right password', async () => {
        const env = setup(); await fail(env, 5);
        expect(env.caldav.count('discover')).toBe(5);
        const refused = await submit(env, await start(env));
        expect(refused.status).toBe(429);
        expect(await refused.text()).toContain('Too many failed sign-in attempts');
        expect(env.caldav.count('discover')).toBe(5);
        expect(await env.store.get('throttle', ACCOUNT_ID)).toMatchObject({ kind: 'throttle', id: ACCOUNT_ID, accountId: ACCOUNT_ID, failures: 5 });
    });

    test('window expiry re-allows sign-in and starts a fresh window', async () => {
        const env = setup(); await fail(env, 5);
        const record = await env.store.get('throttle', ACCOUNT_ID); if (record?.kind !== 'throttle') { throw new Error('missing throttle'); }
        const past = Math.floor(Date.now() / 1000) - 1;
        expect(await env.store.transact({ conditions: [{ kind: 'throttle', id: ACCOUNT_ID, revision: record.revision }], puts: [{ ...record, revision: record.revision + 1, windowStart: past - 900, expiresAt: past }], operationId: 'expire-window' })).toBe(true);
        await fail(env, 1);
        expect(await env.store.get('throttle', ACCOUNT_ID)).toMatchObject({ failures: 1, revision: record.revision + 2 });
        expect((await submit(env, await start(env))).status).toBe(302);
    });

    test('a store failure while reserving an attempt fails closed before any backend call', async () => {
        const env = setup(); env.store.failTransact = write => write.puts.some(put => put.kind === 'throttle') ? new TemporaryUnavailable() : undefined;
        const response = await submit(env, await start(env), { password: WRONG });
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain(FAILURE_TEXT);
        expect(env.caldav.count()).toBe(0);
    });

    test('forty concurrent wrong-password posts on one replayed flow reach iCloud at most five times', async () => {
        const env = setup(); const form = await start(env);
        const slow = () => new Promise<never>((_resolve, reject) => setTimeout(() => reject(new CalDavError('unauthorized')), 20));
        env.caldav.script('discover', ...Array.from({ length: 40 }, () => slow));
        const results = await Promise.all(Array.from({ length: 40 }, () => submit(env, form, { password: WRONG })));
        expect(env.caldav.count('discover')).toBeLessThanOrEqual(5);
        expect(results.filter(response => response.status === 400)).toHaveLength(env.caldav.count('discover'));
        for (const response of results) { expect([400, 429, 503]).toContain(response.status); }
        expect(await env.store.get('throttle', ACCOUNT_ID)).toMatchObject({ failures: env.caldav.count('discover') });
    });

    test('concurrent temporary upstream outcomes never put more than five attempts in flight', async () => {
        const env = setup(); const form = await start(env);
        let inFlight = 0; let peak = 0; let burst = true;
        const slow = () => {
            if (!burst) { return { ...FAKE_DISCOVERY }; }
            inFlight++; peak = Math.max(peak, inFlight);
            return new Promise<never>((_resolve, reject) => setTimeout(() => { inFlight--; reject(new CalDavError('temporary')); }, 20));
        };
        env.caldav.script('discover', ...Array.from({ length: 41 }, () => slow));
        const results = await Promise.all(Array.from({ length: 40 }, () => submit(env, form)));
        expect(peak).toBeLessThanOrEqual(5);
        expect(env.caldav.count('discover')).toBeLessThanOrEqual(5);
        for (const response of results) { expect([429, 503]).toContain(response.status); }
        expect(await env.store.get('throttle', ACCOUNT_ID)).toMatchObject({ failures: 0 });
        burst = false;
        expect((await submit(env, await start(env))).status).toBe(302);
    });

    test('successful sign-ins do not consume the budget', async () => {
        const env = setup();
        for (let index = 0; index < 8; index++) { expect((await submit(env, await start(env))).status).toBe(302); }
        expect(await env.store.get('throttle', ACCOUNT_ID)).toMatchObject({ failures: 0 });
        await fail(env, 5);
        expect((await submit(env, await start(env))).status).toBe(429);
    });

    test('a store failure while releasing after a successful sign-in does not fail the login', async () => {
        const env = setup();
        let throttleWrites = 0;
        env.store.failTransact = write => write.puts.some(put => put.kind === 'throttle') && ++throttleWrites > 1 ? new TemporaryUnavailable() : undefined;
        expect((await submit(env, await start(env))).status).toBe(302);
        expect(throttleWrites).toBe(2);
        expect(await env.store.get('throttle', ACCOUNT_ID)).toMatchObject({ failures: 1 });
    });

    test('a store failure while reading the throttle fails closed before any backend call', async () => {
        const env = setup(); env.store.failGet = kind => kind === 'throttle' ? new TemporaryUnavailable() : undefined;
        expect((await submit(env, await start(env))).status).toBe(503);
        expect(env.caldav.count()).toBe(0);
    });
});

describe('duplicate delivery and reconnect', () => {
    test('a duplicate delivery re-proves with iCloud and keeps the generation, but is a new consent: only the later code is valid', async () => {
        const env = setup(); const form = await start(env);
        const first = await submit(env, form); const second = await submit(env, form);
        expect([first.status, second.status]).toEqual([302, 302]);
        expect(env.caldav.count('discover')).toBe(2);
        // The identical credential is not re-encrypted under a new generation.
        expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ credentialGeneration: 1, revision: 0 });
        const codeOf = (response: Response) => new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
        const refused = await tokenRequest(env, codeOf(first));
        expect(refused.status).toBe(400);
        expect((await refused.json()).error).toBe('invalid_grant');
        expect((await tokenRequest(env, codeOf(second))).status).toBe(200);
    });

    test('a reconnect with a new password replaces the credential under the next generation and ends earlier grants', async () => {
        const env = setup(); const old = await connect(env);
        env.caldav.setPassword(APPLE_ID, 'brand-new-app-pass');
        const { tokens } = await connect(env, { password: 'brand-new-app-pass' });
        const connection = await env.store.get('connection', ACCOUNT_ID); if (connection?.kind !== 'connection') { throw new Error('missing connection'); }
        expect(connection.credentialGeneration).toBe(2);
        expect(env.crypto.open<UpstreamCredentials>('upstream-credentials', connectionAAD(connection), connection.credentials).appPassword).toBe('brand-new-app-pass');
        expect(env.store.dump()).not.toContain('brand-new-app-pass');
        expect((await callTool(env, old.tokens.access_token, 'list_calendars')).status).toBe(401);
        expect((await callTool(env, tokens.access_token, 'list_calendars')).status).toBe(200);
        expect(env.caldav.calls.at(-1)).toMatchObject({ method: 'listCalendars', appPassword: 'brand-new-app-pass' });
    });

    test('the old allow_invite acknowledgment is gone: it neither is required nor grants anything', async () => {
        const env = setup({ scope: 'calendar:invite' });
        const form = await start(env);
        expect(form.html).not.toContain('allow_invite');
        expect(form.html).not.toContain(' required><span>');
        // Unticked invite alone is an empty grant; the stale field cannot stand in for the tick.
        const stale = await submit(env, form, { extra: { allow_invite: 'yes' } });
        expect(stale.status).toBe(400);
        expect(await stale.text()).toContain('Choose at least one permission');
        expect(env.caldav.count()).toBe(0);
        expect((await submit(env, form, { grants: ['calendar:invite'] })).status).toBe(302);
    });
});
