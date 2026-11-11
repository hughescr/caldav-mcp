import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { digest } from '../src/auth/crypto';
import { ACCOUNT_ID, APPLE_ID, CALENDARS, PASSWORD, callTool, connect, issuer, post, setup, submit, start, type Env } from './helpers/http-env';

let spies: Mock<(...args: unknown[]) => void>[] = [];
beforeEach(() => { spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => spyOn(console, method).mockImplementation(() => {})); });
afterEach(() => { for (const spy of spies) { spy.mockRestore(); } });

const NEW_PASSWORD = 'brand-new-pass-word-1';

function refresh(env: Env, clientId: string, refreshToken: string) {
    return post(env.app, '/token', new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: `${issuer}/mcp` }));
}

/** A second, separately registered client completing the whole browser flow. */
async function connectOtherClient(env: Env, password = PASSWORD) {
    const redirect = 'https://other-client.example/callback';
    const registration = env.runtime.clients.register({ client_name: 'Other client', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    const verifier = 'o'.repeat(43);
    const params = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirect, resource: `${issuer}/mcp`, scope: 'calendar:read', code_challenge_method: 'S256', code_challenge: digest(verifier), state: 'other-state' });
    const response = await submit(env, await start(env, params), { password });
    expect(response.status).toBe(302);
    const code = new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const exchanged = await post(env.app, '/token', new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: redirect, resource: `${issuer}/mcp`, code, code_verifier: verifier }));
    expect(exchanged.status).toBe(200);
    return { clientId: registration.client_id, tokens: await exchanged.json() as { access_token: string; refresh_token: string } };
}

async function expectChallenge(response: Response) {
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`);
}

async function expectCalendars(env: Env, accessToken: string) {
    const response = await callTool(env, accessToken, 'list_calendars');
    expect(response.status).toBe(200);
    expect((await response.json()).result.structuredContent).toEqual({ calendars: CALENDARS, truncated: false });
}

describe('a credential replacement ends every earlier grant for the account', () => {
    test('revoking the password at Apple and reconnecting with a new one refuses the old refresh and access tokens', async () => {
        const env = setup();
        const clientId = env.params.get('client_id') ?? '';
        const old = await connect(env);
        env.caldav.setPassword(APPLE_ID, NEW_PASSWORD);
        expect((await refresh(env, clientId, old.tokens.refresh_token)).status).toBe(400);
        expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ status: 'reconnect_required', credentialGeneration: 1 });

        const owner = await connectOtherClient(env, NEW_PASSWORD);
        expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ status: 'active', credentialGeneration: 2 });

        const revived = await refresh(env, clientId, old.tokens.refresh_token);
        expect(revived.status).toBe(400);
        expect((await revived.json()).error).toBe('invalid_grant');
        await expectChallenge(await callTool(env, old.tokens.access_token, 'list_calendars'));
        await expectCalendars(env, owner.tokens.access_token);
        expect((await refresh(env, owner.clientId, owner.tokens.refresh_token)).status).toBe(200);
    });

    test('the same client reconnecting must use its new grant; the earlier grant stays dead', async () => {
        const env = setup();
        const clientId = env.params.get('client_id') ?? '';
        const old = await connect(env);
        env.caldav.setPassword(APPLE_ID, NEW_PASSWORD);
        const current = await connect(env, { password: NEW_PASSWORD });
        expect((await refresh(env, clientId, old.tokens.refresh_token)).status).toBe(400);
        await expectChallenge(await callTool(env, old.tokens.access_token, 'list_calendars'));
        await expectCalendars(env, current.tokens.access_token);
    });

    test('removal from and re-adding to the allowlist, then reconnecting, refuses the old tokens', async () => {
        const env = setup();
        const clientId = env.params.get('client_id') ?? '';
        const old = await connect(env);
        const allowed = env.runtime.allowedAccountIds as Set<string>;
        allowed.delete(ACCOUNT_ID);
        expect((await refresh(env, clientId, old.tokens.refresh_token)).status).toBe(400);
        allowed.add(ACCOUNT_ID);
        const owner = await connectOtherClient(env);
        expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ status: 'active', credentialGeneration: 2 });
        expect((await refresh(env, clientId, old.tokens.refresh_token)).status).toBe(400);
        await expectChallenge(await callTool(env, old.tokens.access_token, 'list_calendars'));
        await expectCalendars(env, owner.tokens.access_token);
    });
});

describe('identical credentials on an active connection end nothing', () => {
    test('two clients connecting with the same active credential both keep working', async () => {
        const env = setup();
        const clientId = env.params.get('client_id') ?? '';
        const first = await connect(env);
        const second = await connectOtherClient(env);
        expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ status: 'active', credentialGeneration: 1 });
        await expectCalendars(env, first.tokens.access_token);
        await expectCalendars(env, second.tokens.access_token);
        expect((await refresh(env, clientId, first.tokens.refresh_token)).status).toBe(200);
        expect((await refresh(env, second.clientId, second.tokens.refresh_token)).status).toBe(200);
    });

    test('a duplicate delivery keeps the generation and the resulting grant refreshes', async () => {
        const env = setup();
        const { tokens } = await connect(env, { duplicate: true });
        expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ credentialGeneration: 1 });
        expect((await refresh(env, env.params.get('client_id') ?? '', tokens.refresh_token)).status).toBe(200);
        await expectCalendars(env, tokens.access_token);
    });
});

test('a refresh retry inside the receipt window is refused once the account leaves the allowlist', async () => {
    const env = setup();
    const clientId = env.params.get('client_id') ?? '';
    const { tokens } = await connect(env);
    expect((await refresh(env, clientId, tokens.refresh_token)).status).toBe(200);
    (env.runtime.allowedAccountIds as Set<string>).delete(ACCOUNT_ID);
    const retry = await refresh(env, clientId, tokens.refresh_token);
    expect(retry.status).toBe(400);
    expect((await retry.json()).error).toBe('invalid_grant');
});
