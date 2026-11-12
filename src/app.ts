import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { version } from '../package.json';
import { handleMcp } from './mcp';
import { loadConfig, type Config } from './config';
import { createRuntimeProvider, type RuntimeProvider } from './auth/runtime';
import { authenticate, authorization, boundedText, challenge, form, metadata, required, scopes, unique, SCOPES } from './auth/http';
import { beginBrowser, postBrowser } from './auth/browser';
import { OAuthError } from './auth/contracts';
import { ClientError } from './auth/clients';
import { readCredentials } from './auth/caldav-session';
import { bindCalendarService, type DownloadBinding } from './calendar/service';
import type { DownloadStore } from './calendar/downloads';
import { createS3DownloadStore } from './calendar/s3-download-store';
export interface AppOptions { config?: Config; runtime?: RuntimeProvider; downloads?: DownloadBinding }
/** One staging store per app, created on the first download, never during startup or ordinary reads. */
function downloadBinding(config: Config): DownloadBinding {
    const bucketName = config.downloadBucketName;
    let store: DownloadStore | undefined;
    return { store: () => (bucketName === undefined ? undefined : (store ??= createS3DownloadStore({ bucketName }))) };
}
export function createApp(options: AppOptions = {}) {
    const config = options.config ?? loadConfig(); const runtime = options.runtime ?? createRuntimeProvider(config);
    const downloads = options.downloads ?? downloadBinding(config);
    const app = new Hono();
    app.use('*', secureHeaders({ referrerPolicy: false }));
    app.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); context.header('Referrer-Policy', 'no-referrer'); await next(); });
    app.use('/mcp', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: context => context.json({ error: 'payload_too_large' }, 413) }));
    app.use('*', async (context, next) => {
        if (context.req.method === 'OPTIONS') { context.header('Access-Control-Allow-Origin', '*'); context.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name'); context.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); return context.body(null, 204); }
        if (['/register', '/token', '/revoke', '/mcp'].includes(context.req.path) || context.req.path.startsWith('/.well-known/')) { context.header('Access-Control-Allow-Origin', '*'); context.header('Access-Control-Expose-Headers', 'WWW-Authenticate'); }
        await next();
    });
    app.get('/healthz', context => context.json({ service: 'caldav-mcp', version, status: 'oauth' }));
    app.get('/readyz', async context => { const ready = Boolean(await runtime()); return context.json({ ready }, ready ? 200 : 503); });
    app.get('/.well-known/oauth-authorization-server', context => config.publicBaseUrl ? context.json(metadata(config.publicBaseUrl)) : context.json({ error: 'service_not_ready' }, 503));
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        app.get(path, context => config.publicBaseUrl ? context.json({ resource: `${config.publicBaseUrl}/mcp`, authorization_servers: [config.publicBaseUrl], bearer_methods_supported: ['header'], scopes_supported: [...SCOPES] }) : context.json({ error: 'service_not_ready' }, 503));
    }
    app.get('/authorize', async context => { const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); } return beginBrowser(context, auth); });
    app.post('/auth/connect', async context => { if (new URL(context.req.url).search) { throw new OAuthError('invalid_request'); } const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); } return postBrowser(context, auth); });
    app.post('/register', async context => {
        const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); }
        if (!/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') ?? '')) { throw new OAuthError('invalid_request'); }
        let raw: unknown; try { raw = JSON.parse(await boundedText(context.req.raw)); } catch { throw new OAuthError('invalid_request'); }
        return context.json(auth.clients.register(raw), 201);
    });
    app.post('/token', async context => {
        const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); }
        unique(new URL(context.req.url).searchParams);
        if (new URL(context.req.url).search) { throw new OAuthError('invalid_request'); }
        const fields = await form(context.req.raw); const client = await authenticate(auth, context.req.raw, fields);
        const resource = required(fields, 'resource');
        if (fields.grant_type === 'authorization_code') {
            const request = await authorization(auth, { client_id: client.clientId, redirect_uri: required(fields, 'redirect_uri'), resource, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'x'.repeat(43) });
            return context.json(await auth.engine.exchange({ client: request.client, code: required(fields, 'code'), verifier: required(fields, 'code_verifier'), redirectUri: request.redirectUri, resource }));
        }
        if (fields.grant_type === 'refresh_token') { return context.json(await auth.engine.refresh({ client, refreshToken: required(fields, 'refresh_token'), resource, ...(fields.scope === undefined ? {} : { scopes: scopes(fields.scope) }) })); }
        return context.json({ error: 'unsupported_grant_type' }, 400);
    });
    app.post('/revoke', async context => { if (new URL(context.req.url).search) { throw new OAuthError('invalid_request'); } const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); } const fields = await form(context.req.raw); const client = await authenticate(auth, context.req.raw, fields); await auth.engine.revoke(required(fields, 'token'), client); return context.body(null, 200); });
    app.all('/mcp', async context => {
        if (!config.publicBaseUrl) { return context.json({ error: 'service_not_ready' }, 503); }
        const header = context.req.header('authorization');
        const unauthorized = () => { const value = challenge(config.publicBaseUrl ?? ''); context.header('WWW-Authenticate', value); return context.json({ error: 'invalid_token', _meta: { 'mcp/www_authenticate': [value] } }, 401); };
        if (!header || !/^Bearer [A-Za-z0-9._~-]+$/i.test(header)) { return unauthorized(); }
        const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); }
        try {
            // verifyAccess reads the grant, the connection and the consent record (strongly consistent, never
            // cached) and checks the grant against the connection's credential generation and the consent:
            // a replaced credential or a newer consent ends it. Its result carries that connection record,
            // so this request reads nothing twice.
            const token = header.slice(7); const identity = await auth.engine.verifyAccess(token);
            // Allowlist removal takes effect on the very next request, before any upstream access.
            if (!auth.allowedAccountIds.has(identity.accountId)) { return unauthorized(); }
            const record = identity.connection;
            // No upstream validation request here: the tool call itself reaches iCloud and reports a 401.
            // Credentials are decrypted lazily, only when a tool on an active connection needs iCloud,
            // and stay in the bound closure. initialize and tools/list never decrypt.
            const calendar = bindCalendarService({ caldav: auth.caldav, connectionStatus: identity.connectionStatus, credentials: () => readCredentials(auth.crypto, record), markReconnectRequired: () => auth.engine.markReconnectRequired(record), downloads });
            return handleMcp(context.req.raw, { token, clientId: identity.clientId, scopes: identity.scopes, resource: new URL(auth.engine.resource) }, calendar);
        } catch (error) { if (error instanceof OAuthError && error.error !== 'temporarily_unavailable') { return unauthorized(); } throw error; }
    });
    app.notFound(context => context.json({ error: 'not_found' }, 404));
    app.onError((error, context) => {
        if (error instanceof OAuthError || error instanceof ClientError) {
            const temporary = error.error === 'temporarily_unavailable';
            if (error.error === 'invalid_client') { context.header('WWW-Authenticate', 'Basic realm="oauth"'); }
            return context.json({ error: error.error, ...(error.error === 'invalid_grant' ? { error_description: 'Reconnect your iCloud account and authorize this client again.' } : {}) }, temporary ? 503 : error.error === 'invalid_client' ? 401 : 400);
        }
        return context.json({ error: 'temporarily_unavailable' }, 503);
    });
    return app;
}
