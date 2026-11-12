import { ClientError, matchesRedirectUri, type ClientRegistry, type ResolvedClient } from './clients';
import { OAuthError } from './contracts';
import { DEFAULT_SCOPE, SCOPES } from './scopes';
/** The scope list lives in ./scopes; the engine and the app import it through here. */
export { DEFAULT_SCOPE, SCOPES };
/** The parts of the runtime the OAuth request helpers need; structural to avoid an import cycle with the engine. */
export interface OAuthServices { clients: ClientRegistry; engine: { readonly resource: string } }
export function unique(params: URLSearchParams): Record<string, string> {
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of params) { if (Object.hasOwn(out, key)) { throw new OAuthError('invalid_request'); } out[key] = value; }
    return out;
}
export async function form(request: Request): Promise<Record<string, string>> { return unique(await formParams(request)); }
/** The bounded urlencoded body, before the duplicate check; for a form that has one repeatable field. */
export async function formParams(request: Request): Promise<URLSearchParams> {
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) { throw new OAuthError('invalid_request'); }
    return new URLSearchParams(await boundedText(request));
}
export async function boundedText(request: Request): Promise<string> {
    if (!request.body) { return ''; }
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) { break; } size += part.value.length; if (size > 16384) { throw new OAuthError('invalid_request'); } chunks.push(part.value); } }
    finally { await reader.cancel(); reader.releaseLock(); }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
export function required(fields: Record<string, string>, name: string): string { const value = fields[name]; if (!value) { throw new OAuthError('invalid_request'); } return value; }
export function scopes(value = DEFAULT_SCOPE): string[] { const parsed = value.split(' '); if (!parsed.length || parsed.some(scope => !SCOPES.includes(scope)) || new Set(parsed).size !== parsed.length) { throw new OAuthError('invalid_scope'); } return parsed; }
export interface Authorization { fields: Record<string, string>; client: ResolvedClient; redirectUri: string; resource: string; scopes: string[]; challenge: string }
export const AUTH_FIELDS = ['client_id', 'redirect_uri', 'response_type', 'resource', 'scope', 'code_challenge', 'code_challenge_method', 'state'];
export async function authorization(runtime: OAuthServices, input: Record<string, string>): Promise<Authorization> {
    const fields = Object.fromEntries(AUTH_FIELDS.filter(key => input[key] !== undefined).map(key => [key, required(input, key) ]));
    const client = await runtime.clients.resolve(required(fields, 'client_id'));
    const redirectUri = required(fields, 'redirect_uri');
    if (!matchesRedirectUri(client, redirectUri)) { throw new ClientError('invalid_redirect_uri'); }
    if (fields.response_type !== 'code' || fields.resource !== runtime.engine.resource || fields.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(fields.code_challenge ?? '') || (fields.state?.length ?? 0) > 1024) { throw new OAuthError('invalid_request'); }
    // A validated native loopback port is an authorized exact URI for this transaction only.
    return { fields, client: { ...client, redirectUris: [redirectUri] }, redirectUri, resource: fields.resource, scopes: scopes(fields.scope), challenge: required(fields, 'code_challenge') };
}
export async function authenticate(runtime: OAuthServices, request: Request, fields: Record<string, string>): Promise<ResolvedClient> {
    if (fields.client_assertion !== undefined || fields.client_assertion_type !== undefined) { throw new ClientError('invalid_client'); }
    const header = request.headers.get('authorization');
    let id = fields.client_id; let secret = fields.client_secret; let method: 'none' | 'client_secret_basic' | 'client_secret_post' = secret === undefined ? 'none' : 'client_secret_post';
    if (header !== null) {
        if (secret !== undefined || !/^Basic [A-Za-z0-9+/]+=*$/i.test(header)) { throw new ClientError('invalid_client'); }
        try { const raw = Buffer.from(header.slice(6), 'base64').toString('utf8'); const split = raw.indexOf(':'); if (split < 1) { throw new Error(); } const basicId = decodeURIComponent(raw.slice(0, split).replaceAll('+', ' ')); if (id !== undefined && id !== basicId) { throw new Error(); } id = basicId; secret = decodeURIComponent(raw.slice(split + 1).replace(/\+/g, ' ')); method = 'client_secret_basic'; }
        catch { throw new ClientError('invalid_client'); }
    }
    if (!id) { throw new ClientError('invalid_client'); }
    const client = await runtime.clients.resolve(id); runtime.clients.authenticate(client, method, secret); return client;
}
export function metadata(issuer: string) { return { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'], revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'], scopes_supported: [...SCOPES], authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true }; }
export function challenge(issuer: string): string { return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`; }
