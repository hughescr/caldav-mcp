import { afterEach, beforeEach, expect, spyOn, test, type Mock } from 'bun:test';
import { CalDavError } from '../src/caldav/contracts';

let warn: Mock<(...args: unknown[]) => void>;
beforeEach(() => { warn = spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { expect(JSON.stringify(warn.mock.calls)).not.toContain(PASSWORD); warn.mockRestore(); });
import { ACCOUNT_ID, APPLE_ID, CALENDARS, PASSWORD, callTool, connect, issuer, post, rpc, setup, start, submit, tokenRequest } from './helpers/http-env';

test('MCP requests make no upstream validation call; the tool call itself reaches iCloud', async () => {
    const env = setup(); const { tokens } = await connect(env);
    const before = env.caldav.count('validate');
    for (let index = 0; index < 3; index++) {
        const response = await callTool(env, tokens.access_token, 'list_calendars');
        expect((await response.json()).result.structuredContent).toEqual({ calendars: CALENDARS, truncated: false });
    }
    const list = await env.app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(list.status).toBe(200);
    expect(env.caldav.count('validate')).toBe(before);
    expect(env.caldav.count('listCalendars')).toBe(3);
});

test('removing an account from the allowlist blocks MCP on the next request with zero upstream calls', async () => {
    const env = setup({ allowed: [ACCOUNT_ID] }); const { tokens } = await connect(env);
    const calls = env.caldav.count();
    (env.runtime.allowedAccountIds as Set<string>).delete(ACCOUNT_ID);
    const response = await callTool(env, tokens.access_token, 'list_calendars');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`);
    expect(env.caldav.count()).toBe(calls);
});

test('an iCloud 401 during a tool call marks the observed connection reconnect_required', async () => {
    const env = setup(); const { tokens } = await connect(env);
    const before = await env.store.get('connection', ACCOUNT_ID); if (before?.kind !== 'connection') { throw new Error('missing connection'); }
    env.caldav.setPassword(APPLE_ID, 'revoked-at-apple');
    const result = (await (await callTool(env, tokens.access_token, 'list_calendars')).json()).result;
    expect(result.isError).toBe(true); expect(result.structuredContent.error.code).toBe('reconnect_required');
    expect(result.content[0].text).toContain('Reconnect');
    expect(await env.store.get('connection', ACCOUNT_ID)).toEqual({ ...before, revision: before.revision + 1, status: 'reconnect_required' });
    const calls = env.caldav.count();
    const again = (await (await callTool(env, tokens.access_token, 'list_calendars')).json()).result;
    expect(again.structuredContent.error.code).toBe('reconnect_required');
    expect(env.caldav.count()).toBe(calls);
    // A fresh login restores service under a new credential generation, for a new grant only.
    const fresh = await connect(env, { password: 'revoked-at-apple' });
    expect((await callTool(env, tokens.access_token, 'list_calendars')).status).toBe(401);
    expect((await (await callTool(env, fresh.tokens.access_token, 'list_calendars')).json()).result.isError).toBeUndefined();
});

test('a stale 401 cannot overwrite a concurrent reconnect', async () => {
    const env = setup(); const { tokens } = await connect(env);
    let code = '';
    env.caldav.script('listCalendars', async () => {
        // While this request holds the old credentials, the user reconnects with a new password.
        env.caldav.setPassword(APPLE_ID, 'concurrent-new-pass');
        const reconnect = await submit(env, await start(env), { password: 'concurrent-new-pass' });
        expect(reconnect.status).toBe(302);
        code = new URL(reconnect.headers.get('location') ?? '').searchParams.get('code') ?? '';
        throw new CalDavError('unauthorized');
    });
    const result = (await (await callTool(env, tokens.access_token, 'list_calendars')).json()).result;
    expect(result.structuredContent.error.code).toBe('reconnect_required');
    expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ status: 'active', credentialGeneration: 2 });
    const exchanged = await tokenRequest(env, code);
    expect(exchanged.status).toBe(200);
    const fresh = await exchanged.json() as { access_token: string };
    expect((await (await callTool(env, fresh.access_token, 'list_calendars')).json()).result.isError).toBeUndefined();
});

async function damage(env: ReturnType<typeof setup>) {
    const record = await env.store.get('connection', ACCOUNT_ID); if (record?.kind !== 'connection') { throw new Error('missing connection'); }
    await env.store.transact({ conditions: [{ kind: 'connection', id: record.id, revision: record.revision }], puts: [{ ...record, revision: record.revision + 1, credentials: { ...record.credentials, tag: 'A'.repeat(22) } }], operationId: 'damage' });
}

test('initialize and tools/list never decrypt the stored credential', async () => {
    const env = setup(); const { tokens } = await connect(env);
    await damage(env);
    const open = spyOn(env.crypto, 'open');
    try {
        const initialize = await rpc(env, tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        expect(initialize.status).toBe(200);
        const list = await rpc(env, tokens.access_token, 'tools/list');
        expect(list.status).toBe(200);
        expect((await list.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_calendars']);
        expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); }
});

test('an undecryptable credential on an active connection asks the client to reconnect, and a new login replaces it', async () => {
    const env = setup(); const { tokens } = await connect(env);
    await damage(env);
    const calls = env.caldav.count();
    const response = await callTool(env, tokens.access_token, 'list_calendars');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(PASSWORD);
    expect(JSON.parse(body).result.structuredContent.error.code).toBe('reconnect_required');
    expect(env.caldav.count()).toBe(calls);
    expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ status: 'reconnect_required', credentialGeneration: 1 });
    const replaced = await connect(env);
    expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ status: 'active', credentialGeneration: 2 });
    expect((await (await callTool(env, replaced.tokens.access_token, 'list_calendars')).json()).result.structuredContent).toEqual({ calendars: CALENDARS, truncated: false });
});

test('refresh with an undecryptable active credential ends with invalid_grant and marks the connection', async () => {
    const env = setup(); const { tokens } = await connect(env);
    await damage(env);
    const response = await post(env.app, '/token', new URLSearchParams({ grant_type: 'refresh_token', client_id: env.params.get('client_id') ?? '', refresh_token: tokens.refresh_token, resource: `${issuer}/mcp` }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_grant');
    expect(await env.store.get('connection', ACCOUNT_ID)).toMatchObject({ status: 'reconnect_required' });
});

test('an inactive connection is never decrypted, so unreadable old credentials still report reconnect_required', async () => {
    const env = setup(); const { tokens } = await connect(env);
    const record = await env.store.get('connection', ACCOUNT_ID); if (record?.kind !== 'connection') { throw new Error('missing connection'); }
    await env.store.transact({ conditions: [{ kind: 'connection', id: record.id, revision: record.revision }], puts: [{ ...record, revision: record.revision + 1, status: 'reconnect_required', credentials: { ...record.credentials, tag: 'A'.repeat(22) } }], operationId: 'retire' });
    const response = await callTool(env, tokens.access_token, 'list_calendars');
    expect(response.status).toBe(200);
    expect((await response.json()).result.structuredContent.error.code).toBe('reconnect_required');
});

test('MCP rejects malformed bearer tokens and unconfigured issuers', async () => {
    const env = setup();
    for (const authorization of ['Bearer', 'Bearer a b', 'Basic abc', `Bearer ${'x'.repeat(43)}`]) {
        expect((await env.app.request('/mcp', { method: 'POST', headers: { authorization } })).status).toBe(401);
    }
    expect(env.caldav.count()).toBe(0);
});
