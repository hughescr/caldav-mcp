import { AuthCrypto, connectionAAD, digest, equal, randomId } from './crypto';
import { SCOPES } from './http';
import { OAuthError, TemporaryUnavailable, type AtomicStore, type AuthContext, type AuthorizationCode, type BackendSessionValidator, type ClientIdentity, type Connection, type Grant, type TokenResponse, type UpstreamCredentials } from './contracts';
export interface EngineConfig { issuer: string; accessSeconds?: number; grantSeconds?: number; refreshRetrySeconds?: 0 | 10 }
export interface CodeRequest { client: ClientIdentity; connectionId: string; redirectUri: string; resource: string; scopes: string[]; challenge: string }
export interface ExchangeRequest { client: ClientIdentity; code: string; verifier: string; redirectUri: string; resource: string }
export interface ConnectRequest { accountId: string; credentials: UpstreamCredentials; expiresAt: number; expectedCredentialGeneration?: number }
export interface RefreshRequest { client: ClientIdentity; refreshToken: string; resource: string; scopes?: string[] }
const scopesKey = (scopes: readonly string[]) => [...new Set(scopes)].sort().join(' ');
const condition = (record: Connection | Grant | AuthorizationCode) => ({ kind: record.kind, id: record.id, revision: record.revision });
const MAX_URL = 2048;
const boundedString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
/** Explicit projection: nothing but the contract fields is ever sealed. */
function project(credentials: UpstreamCredentials): UpstreamCredentials {
    const { accountId, appleId, appPassword, principalUrl, calendarHomeUrl, issuedAt } = credentials;
    return { accountId, appleId, appPassword, principalUrl, calendarHomeUrl, issuedAt };
}
function completeCredentials(credentials: UpstreamCredentials): boolean {
    return boundedString(credentials.appleId, 255) && boundedString(credentials.appPassword, 256) && boundedString(credentials.principalUrl, MAX_URL) && boundedString(credentials.calendarHomeUrl, MAX_URL) && Number.isSafeInteger(credentials.issuedAt);
}
export class AuthEngine {
    readonly resource: string;
    private readonly accessSeconds: number;
    private readonly grantSeconds: number;
    private readonly grace: number;
    constructor(private readonly store: AtomicStore, private readonly crypto: AuthCrypto, private readonly backend: BackendSessionValidator, config: EngineConfig, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
        const origin = new URL(config.issuer);
        if (origin.protocol !== 'https:' || origin.origin !== config.issuer) {throw new Error('Issuer must be a canonical HTTPS origin');}
        this.resource = `${config.issuer}/mcp`; this.accessSeconds = config.accessSeconds ?? 300;
        this.grantSeconds = config.grantSeconds ?? 180 * 86400; this.grace = config.refreshRetrySeconds ?? 0;
        if (!Number.isSafeInteger(this.accessSeconds) || this.accessSeconds < 1 || this.accessSeconds > 3600 || !Number.isSafeInteger(this.grantSeconds) || this.grantSeconds < this.accessSeconds || this.grantSeconds > 180 * 86400 || ![0, 10].includes(this.grace)) {throw new Error('Invalid token lifetime policy');}
    }
    /** Called only after real upstream authentication. Existing connections require explicit generation CAS. */
    async connectOrReconnect(request: ConnectRequest): Promise<Connection> {
        if (!request.accountId || request.credentials.accountId !== request.accountId || !completeCredentials(request.credentials) || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= this.now()) { throw new OAuthError('invalid_request'); }
        const existing = await this.store.get('connection', request.accountId);
        if (existing && (existing.kind !== 'connection' || existing.accountId !== request.accountId || existing.credentialGeneration !== request.expectedCredentialGeneration)) { throw new OAuthError('invalid_grant'); }
        if (!existing && request.expectedCredentialGeneration !== undefined) { throw new OAuthError('invalid_grant'); }
        const connection: Connection = {
            kind: 'connection', id: request.accountId, accountId: request.accountId,
            credentialGeneration: existing?.kind === 'connection' ? existing.credentialGeneration + 1 : 1,
            revision: existing ? existing.revision + 1 : 0, status: 'active', expiresAt: request.expiresAt,
            credentials: { keyId: '', nonce: '', ciphertext: '', tag: '' },
        };
        connection.credentials = this.crypto.seal('upstream-credentials', connectionAAD(connection), project(request.credentials));
        await this.validateConnection(connection, false);
        if (!await this.store.transact({ conditions: [{ kind: 'connection', id: connection.id, revision: existing?.revision ?? null }], puts: [connection], operationId: randomId() })) { throw new TemporaryUnavailable(); }
        return connection;
    }
    private async connection(id: string): Promise<Connection> {
        const record = await this.store.get('connection', id);
        if (record?.kind !== 'connection' || record.expiresAt <= this.now() || record.status !== 'active') {throw new OAuthError('invalid_grant');}
        return record;
    }
    private async validateConnection(connection: Connection, persisted = true): Promise<void> {
        let result: 'valid' | 'expired' | 'temporary';
        try { result = await this.backend.validate(connection); } catch { throw new TemporaryUnavailable(); }
        if (result === 'temporary') {throw new TemporaryUnavailable();}
        if (result === 'expired') {
            if (persisted) { await this.markReconnectRequired(connection); }
            throw new OAuthError('invalid_grant');
        }
    }
    /** Conditionally marks only the observed active revision; false when it already changed (for example a concurrent reconnect). */
    async markReconnectRequired(connection: Connection): Promise<boolean> {
        if (connection.status !== 'active') { return false; }
        return this.store.transact({ conditions: [condition(connection)], puts: [{ ...connection, revision: connection.revision + 1, status: 'reconnect_required' }], operationId: randomId() });
    }
    async issueCode(request: CodeRequest): Promise<string> {
        if (request.resource !== this.resource || !request.client.redirectUris.includes(request.redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(request.challenge) || request.scopes.length === 0 || request.scopes.some(s => !SCOPES.includes(s))) {throw new OAuthError('invalid_request');}
        const connection = await this.connection(request.connectionId);
        await this.validateConnection(connection);
        const code = this.crypto.sign('authorization-code', randomId());
        const record: AuthorizationCode = { kind: 'code', id: digest(code), revision: 0, expiresAt: this.now() + 120, clientId: request.client.clientId, connectionId: connection.id, accountId: connection.accountId, credentialGeneration: connection.credentialGeneration, redirectUri: request.redirectUri, resource: request.resource, scopes: scopesKey(request.scopes).split(' '), challenge: request.challenge };
        if (!await this.store.transact({ conditions: [condition(connection), { kind: 'code', id: record.id, revision: null }], puts: [record], operationId: randomId() })) {throw new TemporaryUnavailable();}
        return code;
    }
    private tokens(grant: Grant): TokenResponse {
        const now = this.now(); const expiresIn = Math.min(this.accessSeconds, grant.expiresAt - now);
        const common = { grantId: grant.id, version: grant.tokenVersion, expiresAt: grant.expiresAt };
        return { access_token: this.crypto.token({ ...common, kind: 'access', generation: grant.refreshGeneration, expiresAt: now + expiresIn, secret: randomId() }), refresh_token: this.crypto.token({ ...common, kind: 'refresh', generation: grant.refreshGeneration, secret: randomId() }), token_type: 'Bearer', expires_in: expiresIn, scope: scopesKey(grant.scopes) };
    }
    async exchange(request: ExchangeRequest): Promise<TokenResponse> {
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(request.verifier)) {throw new OAuthError('invalid_grant');}
        try { if (!/^[A-Za-z0-9_-]{43}$/.test(this.crypto.verify('authorization-code', request.code))) { throw new Error('Invalid code'); } } catch { throw new OAuthError('invalid_grant'); }
        const code = await this.store.get('code', digest(request.code));
        if (code?.kind !== 'code' || code.expiresAt <= this.now() || code.consumedGrantId || code.clientId !== request.client.clientId || code.redirectUri !== request.redirectUri || !request.client.redirectUris.includes(request.redirectUri) || code.resource !== request.resource || request.resource !== this.resource || !equal(code.challenge, digest(request.verifier))) {throw new OAuthError('invalid_grant');}
        const connection = await this.connection(code.connectionId);
        if (connection.accountId !== code.accountId || connection.credentialGeneration !== code.credentialGeneration) {throw new OAuthError('invalid_grant');}
        await this.validateConnection(connection);
        if (code.expiresAt <= this.now() || connection.expiresAt <= this.now()) { throw new OAuthError('invalid_grant'); }
        const grant: Grant = { kind: 'grant', id: randomId(), revision: 0, expiresAt: Math.min(this.now() + this.grantSeconds, connection.expiresAt), clientId: code.clientId, connectionId: code.connectionId, accountId: code.accountId, resource: code.resource, scopes: code.scopes, status: 'active', credentialGeneration: connection.credentialGeneration, tokenVersion: 0, refreshGeneration: 0, refreshHash: '' };
        const response = this.tokens(grant); grant.refreshHash = digest(response.refresh_token);
        if (!await this.store.transact({ conditions: [condition(code), condition(connection), { kind: 'grant', id: grant.id, revision: null }], puts: [{ ...code, revision: code.revision + 1, consumedGrantId: grant.id }, grant], operationId: randomId() })) {throw new OAuthError('invalid_grant');}
        return response;
    }
    private binding(request: RefreshRequest, grant: Grant): string {
        const scopes = request.scopes === undefined ? grant.scopes : request.scopes;
        if (scopes.length === 0 || scopes.some(scope => !grant.scopes.includes(scope))) {throw new OAuthError('invalid_scope');}
        return JSON.stringify([request.client.clientId, request.resource, scopesKey(scopes)]);
    }
    private async grant(token: string, kind: 'access' | 'refresh'): Promise<{ grant: Grant; generation: number }> {
        const envelope = this.crypto.readToken(token, kind, this.now());
        const record = await this.store.get('grant', envelope.grantId);
        if (record?.kind !== 'grant' || record.status !== 'active' || record.expiresAt <= this.now() || record.tokenVersion !== envelope.version) {throw new OAuthError('invalid_token');}
        return { grant: record, generation: envelope.generation };
    }
    private receiptAAD(grant: Grant, binding: string): string {
        return JSON.stringify(['caldav-mcp', 1, 'refresh-receipt', grant.id, grant.accountId, grant.connectionId, grant.credentialGeneration, grant.refreshGeneration, binding]);
    }
    private async recoverReceipt(grant: Grant, binding: string): Promise<TokenResponse | undefined> {
        if (this.grace === 0 || grant.status !== 'active' || !grant.receipt || grant.receiptUntil === undefined || this.now() >= grant.receiptUntil || grant.receiptBinding !== binding) { return undefined; }
        // No upstream request on a retry, but allowlist removal still ends the grant at once.
        if (!this.backend.isAllowed(grant.accountId)) { throw new OAuthError('invalid_grant'); }
        const connection = await this.connection(grant.connectionId);
        if (connection.accountId !== grant.accountId || connection.credentialGeneration !== grant.credentialGeneration) { throw new OAuthError('invalid_grant'); }
        // A check-only transaction establishes one authorization point for both records.
        // Its fresh operation ID is local to this recovery attempt; adapters retain it only
        // for bounded retries of the identical check, never for a later HTTP request.
        if (!await this.store.transact({ conditions: [condition(grant), condition(connection)], puts: [], operationId: randomId() })) {
            throw new OAuthError('invalid_grant');
        }
        const now = this.now();
        if (grant.expiresAt <= now || connection.expiresAt <= now) { throw new OAuthError('invalid_grant'); }
        if (now >= grant.receiptUntil) { return undefined; }
        return this.crypto.open<TokenResponse>('refresh-receipt', this.receiptAAD(grant, binding), grant.receipt);
    }
    async refresh(request: RefreshRequest): Promise<TokenResponse> {
        let found: { grant: Grant; generation: number };
        try { found = await this.grant(request.refreshToken, 'refresh'); } catch (error) { if (error instanceof OAuthError && error.error === 'invalid_token') { throw new OAuthError('invalid_grant'); } throw error; }
        const { grant, generation } = found;
        if (grant.clientId !== request.client.clientId || request.resource !== grant.resource || request.resource !== this.resource) {throw new OAuthError('invalid_grant');}
        const hash = digest(request.refreshToken);
        if (!equal(grant.refreshHash, hash) || generation !== grant.refreshGeneration) {
            if (generation < grant.refreshGeneration) {
                // A valid authenticated routing envelope proves this generation was issued by us.
                // Client and resource bindings have already been checked.
                if (grant.previousRefreshHash && equal(grant.previousRefreshHash, hash) && generation === grant.refreshGeneration - 1) {
                    // Scope errors restrict disclosure inside the grace window; they cannot
                    // conceal authenticated replay once the fixed window has elapsed.
                    if (this.grace > 0 && grant.receiptUntil !== undefined && this.now() < grant.receiptUntil) {
                        const binding = this.binding(request, grant);
                        const receipt = await this.recoverReceipt(grant, binding);
                        if (receipt) { return receipt; }
                        if (this.now() < grant.receiptUntil) { throw new OAuthError('invalid_grant'); }
                    }
                }
                if (!await this.store.transact({ conditions: [condition(grant)], puts: [{ ...grant, revision: grant.revision + 1, status: 'revoked', tokenVersion: grant.tokenVersion + 1 }], operationId: randomId() })) { throw new TemporaryUnavailable(); }
            }
            throw new OAuthError('invalid_grant');
        }
        const binding = this.binding(request, grant);
        const connection = await this.connection(grant.connectionId);
        // Never adopt a newer credential generation: a replaced credential ends this grant.
        if (connection.accountId !== grant.accountId || connection.credentialGeneration !== grant.credentialGeneration) {throw new OAuthError('invalid_grant');}
        await this.validateConnection(connection);
        if (grant.expiresAt <= this.now() || connection.expiresAt <= this.now()) { throw new OAuthError('invalid_grant'); }
        const next: Grant = { ...grant, revision: grant.revision + 1, refreshGeneration: grant.refreshGeneration + 1, scopes: (request.scopes === undefined ? grant.scopes : scopesKey(request.scopes).split(' ')), previousRefreshHash: hash, receiptBinding: binding, receiptUntil: this.now() + this.grace };
        const response = this.tokens(next); next.refreshHash = digest(response.refresh_token);
        next.receipt = this.crypto.seal('refresh-receipt', this.receiptAAD(next, binding), response);
        if (!await this.store.transact({ conditions: [condition(grant), condition(connection)], puts: [next], operationId: randomId() })) {
            // A concurrent winner may have committed the identical delivery receipt.
            const winner = await this.store.get('grant', grant.id);
            if (winner?.kind === 'grant' && winner.refreshGeneration === generation + 1 && winner.previousRefreshHash === hash) { const receipt = await this.recoverReceipt(winner, binding); if (receipt) { return receipt; } }
            throw new OAuthError('invalid_grant');
        }
        return response;
    }
    async verifyAccess(token: string, requiredScopes: readonly string[] = []): Promise<AuthContext> {
        const { grant } = await this.grant(token, 'access');
        if (grant.resource !== this.resource || requiredScopes.some(s => !grant.scopes.includes(s))) {throw new OAuthError('invalid_token');}
        const connection = await this.store.get('connection', grant.connectionId);
        if (connection?.kind !== 'connection' || connection.accountId !== grant.accountId || connection.credentialGeneration !== grant.credentialGeneration || connection.status === 'revoked') {throw new OAuthError('invalid_token');}
        return { grantId: grant.id, accountId: grant.accountId, connectionId: grant.connectionId, scopes: grant.scopes, connectionStatus: connection.expiresAt <= this.now() ? 'reconnect_required' : connection.status };
    }
    async revoke(token: string, client: ClientIdentity): Promise<void> {
        let found: { grant: Grant; generation: number };
        try { found = await this.grant(token, 'refresh'); } catch (error) {
            if (!(error instanceof OAuthError) || error.error !== 'invalid_token') { throw error; }
            try { found = await this.grant(token, 'access'); } catch (accessError) {
                if (accessError instanceof OAuthError && accessError.error === 'invalid_token') { return; }
                throw accessError;
            }
        }
        const { grant } = found;
        if (grant.clientId !== client.clientId) { return; }
        if (!await this.store.transact({ conditions: [condition(grant)], puts: [{ ...grant, revision: grant.revision + 1, status: 'revoked', tokenVersion: grant.tokenVersion + 1 }], operationId: randomId() })) {throw new TemporaryUnavailable();}
    }
}
