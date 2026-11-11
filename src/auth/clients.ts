import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { isPublicRoutableHost } from '@better-auth/core/utils/host';
import { type ClientIdentity } from './contracts';
import { AuthCrypto, equal, randomId } from './crypto';
export type ClientAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';
interface Metadata {
    name: string; redirectUris: string[]; authMethod: ClientAuthMethod; applicationType: 'web' | 'native';
    grantTypes: string[]; clientUri?: string;
}
export interface ResolvedClient extends ClientIdentity, Omit<Metadata, 'redirectUris'> {}
export interface RegistrationResponse {
    client_id: string; client_id_issued_at: number; client_secret?: string; client_secret_expires_at?: 0;
    client_name: string; redirect_uris: string[]; grant_types: string[]; response_types: ['code'];
    token_endpoint_auth_method: ClientAuthMethod; application_type: 'web' | 'native';
}
export class ClientError extends Error {
    constructor(public readonly error: 'invalid_client_metadata' | 'invalid_redirect_uri' | 'invalid_client' | 'temporarily_unavailable') { super(error); }
}
interface Options {
    crypto: AuthCrypto;
    /** Override only with a transport preserving public-IP DNS pinning, TLS identity and no redirects. */
    fetchMetadata?: typeof fetchClientMetadataResource;
    now?: () => number; maxCacheEntries?: number; timeoutMs?: number;
}
const MAX_BYTES = 5120;
const MAX_CLIENT_ID = 3072;
const loopback = (url: URL) => url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
const nativeHttp = (value: string) => /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::[0-9]+)?(?:[/?]|$)/u.test(value);
const withoutLoopbackPort = (value: string) => value.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost))(?::[0-9]+)?(?=[/?]|$)/u, '$1');
function parseUrl(value: unknown, max = 512): URL {
    if (typeof value !== 'string' || !value || value.length > max || /[\s\\*]/u.test(value) || value.includes('#')) { throw new ClientError('invalid_redirect_uri'); }
    let url: URL;
    try { url = new URL(value); } catch { throw new ClientError('invalid_redirect_uri'); }
    if (url.username || url.password || !/^https?:\/\//iu.test(value)) { throw new ClientError('invalid_redirect_uri'); }
    return url;
}
function normalize(raw: unknown, cimd = false): Metadata {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new ClientError('invalid_client_metadata'); }
    let serialized: string;
    try { serialized = JSON.stringify(raw); } catch { throw new ClientError('invalid_client_metadata'); }
    if (Buffer.byteLength(serialized) > MAX_BYTES) { throw new ClientError('invalid_client_metadata'); }
    const data = raw as Record<string, unknown>;
    const name = data.client_name ?? (cimd ? '' : 'OAuth client');
    if (typeof name !== 'string' || !name.trim() || name.length > 120 || Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) { throw new ClientError('invalid_client_metadata'); }
    if (!Array.isArray(data.redirect_uris) || !data.redirect_uris.length || data.redirect_uris.length > 3) { throw new ClientError('invalid_redirect_uri'); }
    const redirects = data.redirect_uris.map(value => { const url = parseUrl(value); if (url.protocol !== 'https:' && !(loopback(url) && nativeHttp(value as string))) { throw new ClientError('invalid_redirect_uri'); } return value as string; });
    const inferred = redirects.every(value => loopback(new URL(value))) ? 'native' : 'web';
    const applicationType = data.application_type ?? inferred;
    if (applicationType !== 'native' && applicationType !== 'web') { throw new ClientError('invalid_client_metadata'); }
    if (applicationType === 'web' && redirects.some(value => loopback(new URL(value)))) { throw new ClientError('invalid_redirect_uri'); }
    // RFC 7591 defaults omitted authentication to basic; public MCP clients request none explicitly.
    let authMethod = data.token_endpoint_auth_method ?? (cimd ? 'none' : 'client_secret_basic');
    if (cimd && data.token_endpoint_auth_methods_supported !== undefined) {
        // SEP-3149: plural capabilities are authoritative; singular is a legacy preference.
        // Select public authentication only when the document explicitly offers it.
        const methods = data.token_endpoint_auth_methods_supported;
        if (!Array.isArray(methods) || !methods.length || methods.length > 4 || methods.some(method => method !== 'none' && method !== 'private_key_jwt') || !methods.includes('none') || (data.token_endpoint_auth_method !== undefined && !['none', 'private_key_jwt'].includes(data.token_endpoint_auth_method as string))) { throw new ClientError('invalid_client_metadata'); }
        authMethod = 'none';
    }
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(authMethod as string) || (cimd && authMethod !== 'none')) { throw new ClientError('invalid_client_metadata'); }
    // V1 requires code plus refresh. CIMD describes client capabilities across servers,
    // so validate the whole list and select only our supported pair; DCR keeps its exact-pair policy.
    const grants = data.grant_types === undefined ? ['authorization_code', 'refresh_token'] : data.grant_types;
    if (!Array.isArray(grants) || !grants.length || grants.length > 16 || grants.some(value => typeof value !== 'string' || !value.length || value.length > 256 || !/^[!-~]+$/u.test(value)) || new Set(grants).size !== grants.length || !grants.includes('authorization_code') || !grants.includes('refresh_token') || (!cimd && grants.length !== 2)) { throw new ClientError('invalid_client_metadata'); }
    const responses = data.response_types ?? ['code'];
    if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code') { throw new ClientError('invalid_client_metadata'); }
    const result: Metadata = { name: name.trim(), redirectUris: [...new Set(redirects)], applicationType, authMethod: authMethod as ClientAuthMethod, grantTypes: ['authorization_code', 'refresh_token'] };
    if (data.client_uri !== undefined) {
        const uri = parseUrl(data.client_uri);
        if (uri.protocol !== 'https:' || !isPublicRoutableHost(uri.hostname)) { throw new ClientError('invalid_client_metadata'); }
        result.clientUri = data.client_uri as string;
    }
    // Presentation fields such as logos and policy URLs are never retained or fetched.
    return result;
}
function metadataUrl(clientId: string): void {
    let url: URL;
    try { url = parseUrl(clientId, 1024); } catch { throw new ClientError('invalid_client'); }
    if (url.protocol !== 'https:' || url.port || !isPublicRoutableHost(url.hostname) || !/^https:\/\/[^/?#]+\//iu.test(clientId) || /\/(?:\.|%2e)(?:\.|%2e)?(?:\/|$|\?)/iu.test(clientId)) { throw new ClientError('invalid_client'); }
}
/** Exact comparison except native HTTP loopback ports; host, path and query stay bound. */
export function matchesRedirectUri(client: ResolvedClient, requested: string): boolean {
    let candidate: URL;
    try { candidate = parseUrl(requested); } catch { return false; }
    return client.redirectUris.some(registered => {
        if (registered === requested) { return true; }
        if (client.applicationType !== 'native' || !loopback(candidate)) { return false; }
        const original = new URL(registered);
        if (!loopback(original) || original.hostname !== candidate.hostname) { return false; }
        return nativeHttp(registered) && nativeHttp(requested) && withoutLoopbackPort(registered) === withoutLoopbackPort(requested);
    });
}
/** No durable anonymous writes. IDs and secrets do not expire: retain signing keys while clients remain supported.
 * Metadata is untrusted identification; authorization still requires consent and PKCE. */
export class ClientRegistry {
    private readonly cache = new Map<string, { client: ResolvedClient; until: number }>();
    private readonly pending = new Map<string, Promise<ResolvedClient>>();
    // DNS lookup is not abortable: reserve capacity until the actual load settles, even after callers time out.
    private activeTransports = 0;
    private readonly now: () => number;
    private readonly capacity: number;
    private readonly timeout: number;
    constructor(private readonly options: Options) {
        this.now = options.now ?? Date.now; this.capacity = options.maxCacheEntries ?? 64; this.timeout = options.timeoutMs ?? 4000;
        if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > 1000 || !Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 10000) { throw new Error('Invalid client registry limits'); }
    }
    register(raw: unknown): RegistrationResponse {
        const metadata = normalize(raw); const issuedAt = Math.floor(this.now() / 1000);
        const clientId = this.options.crypto.sign('client-registration', JSON.stringify({ metadata, nonce: randomId(), issuedAt }));
        if (clientId.length > MAX_CLIENT_ID) { throw new ClientError('invalid_client_metadata'); }
        const result: RegistrationResponse = { client_id: clientId, client_id_issued_at: issuedAt, client_name: metadata.name, redirect_uris: metadata.redirectUris, grant_types: metadata.grantTypes, response_types: ['code'], token_endpoint_auth_method: metadata.authMethod, application_type: metadata.applicationType };
        if (metadata.authMethod !== 'none') { result.client_secret = this.options.crypto.sign('client-secret', clientId); result.client_secret_expires_at = 0; }
        return result;
    }
    async resolve(clientId: string): Promise<ResolvedClient> {
        if (!clientId || clientId.length > MAX_CLIENT_ID) { throw new ClientError('invalid_client'); }
        if (!clientId.startsWith('https://')) {
            try {
                const data = JSON.parse(this.options.crypto.verify('client-registration', clientId)) as { metadata: Metadata; nonce: string; issuedAt: number };
                if (!/^[A-Za-z0-9_-]{43}$/u.test(data.nonce) || !Number.isSafeInteger(data.issuedAt)) { throw new Error('Invalid registration'); }
                return { ...data.metadata, clientId };
            } catch { throw new ClientError('invalid_client'); }
        }
        metadataUrl(clientId);
        const cached = this.cache.get(clientId);
        if (cached && cached.until > this.now()) { this.cache.delete(clientId); this.cache.set(clientId, cached); return structuredClone(cached.client); }
        const existing = this.pending.get(clientId); if (existing) { return structuredClone(await existing); }
        if (this.activeTransports >= 8) { throw new ClientError('temporarily_unavailable'); }
        const work = this.fetch(clientId); this.pending.set(clientId, work);
        try { return structuredClone(await work); } finally { this.pending.delete(clientId); }
    }
    authenticate(client: ResolvedClient, method: ClientAuthMethod, secret?: string): void {
        if (method !== client.authMethod || (method === 'none' && secret !== undefined)) { throw new ClientError('invalid_client'); }
        if (method === 'none') { return; }
        try { if (!secret || !equal(this.options.crypto.verify('client-secret', secret), client.clientId)) { throw new Error('Invalid secret'); } } catch { throw new ClientError('invalid_client'); }
    }
    private async fetch(clientId: string): Promise<ResolvedClient> {
        this.activeTransports++;
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ClientError('temporarily_unavailable')); }, this.timeout); });
        const load = async () => {
            const response = await (this.options.fetchMetadata ?? fetchClientMetadataResource)(clientId, { signal: controller.signal, redirect: 'manual', headers: { accept: 'application/json', 'accept-encoding': 'identity' } });
            try {
                if (controller.signal.aborted) { await response.body?.cancel(); controller.signal.throwIfAborted(); }
                if (response.status !== 200 || response.redirected || (response.url && response.url !== clientId) || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') || !['', 'identity'].includes(response.headers.get('content-encoding') ?? '') || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES || !response.body) { throw new ClientError('invalid_client_metadata'); }
                const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
                try {
                    for (;;) { const { done, value } = await reader.read(); if (done) { break; } size += value.byteLength; if (size > MAX_BYTES) { throw new ClientError('invalid_client_metadata'); } chunks.push(value); }
                } finally { await reader.cancel(); reader.releaseLock(); }
                const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                if (!raw || raw.client_id !== clientId) { throw new ClientError('invalid_client_metadata'); }
                const metadata = normalize(raw, true);
                if (metadata.clientUri && new URL(metadata.clientUri).origin !== new URL(clientId).origin) { throw new ClientError('invalid_client_metadata'); }
                controller.signal.throwIfAborted();
                const client = { ...metadata, clientId };
                if (this.cache.size >= this.capacity) { const oldest = this.cache.keys().next().value; if (oldest) { this.cache.delete(oldest); } }
                this.cache.set(clientId, { client, until: this.now() + 300000 }); return client;
            } finally { controller.abort(); }
        };
        const loading = load();
        void loading.then(() => { this.activeTransports--; }, () => { this.activeTransports--; });
        try { return await Promise.race([loading, deadline]); }
        catch (error) { if (error instanceof ClientError) { throw error; } throw new ClientError('invalid_client_metadata'); }
        finally { clearTimeout(timer); }
    }
}
