import { expect, test } from 'bun:test';
import type { LambdaContext } from '@hono/aws-lambda';
import { version } from '../package.json';
import { createApp } from '../src/app';
import { handler } from '../src/handler';
import { SCOPES } from '../src/auth/http';
import { lambdaEvent } from './helpers/lambda';

const config = { publicBaseUrl: 'https://service.example', allowedAccountIds: new Set<string>() };

test('unconfigured production Lambda fails closed without consulting AWS', async () => {
    expect((await handler(lambdaEvent('/healthz'), {} as LambdaContext)).statusCode).toBe(200);
    for (const path of ['/readyz', '/mcp', '/authorize', '/.well-known/oauth-authorization-server']) {
        expect((await handler(lambdaEvent(path), {} as LambdaContext)).statusCode).toBe(503);
    }
});

test('health identifies this service and version', async () => {
    const response = await createApp({ config }).request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: 'caldav-mcp', version, status: 'oauth' });
});

test('configured discovery and missing bearer need no secret access', async () => {
    const app = createApp({ config, runtime: async () => { throw new Error('must not load'); } });
    expect((await app.request('/.well-known/oauth-authorization-server')).status).toBe(200);
    const result = await app.request('/mcp');
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toContain('https://service.example/.well-known/oauth-protected-resource/mcp');
});

test('discovery advertises exactly the calendar scopes from the single SCOPES source', async () => {
    expect(SCOPES).toEqual(['calendar:read', 'calendar:write', 'calendar:delete', 'calendar:invite']);
    const app = createApp({ config, runtime: async () => { throw new Error('must not load'); } });
    const metadata = await (await app.request('/.well-known/oauth-authorization-server')).json();
    expect(metadata.scopes_supported).toEqual(SCOPES);
    expect(metadata.issuer).toBe('https://service.example');
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const resource = await (await app.request(path)).json();
        expect(resource).toEqual({ resource: 'https://service.example/mcp', authorization_servers: ['https://service.example'], bearer_methods_supported: ['header'], scopes_supported: SCOPES });
    }
});

test('issuer is never derived from Host or forwarded headers', async () => {
    const app = createApp({ config, runtime: async () => { throw new Error('must not load'); } });
    const headers = { host: 'attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http', forwarded: 'host=attacker.example' };
    const metadata = await (await app.request('https://attacker.example/.well-known/oauth-authorization-server', { headers })).json();
    expect(JSON.stringify(metadata)).not.toContain('attacker');
    const challenge = (await app.request('https://attacker.example/mcp', { headers })).headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('https://service.example/');
    expect(challenge).not.toContain('attacker');
});

test('removed wildduck and multi-step login routes do not exist', async () => {
    const app = createApp({ config, runtime: async () => { throw new Error('must not load'); } });
    for (const path of ['/auth/login', '/auth/mfa', '/auth/consent']) {
        expect((await app.request(path, { method: 'POST' })).status).toBe(404);
    }
});

test('oversized MCP bodies are bounded', async () => {
    expect((await createApp({ config }).request('/mcp', { method: 'POST', body: 'x'.repeat(5 * 1024 * 1024 + 1) })).status).toBe(413);
});
