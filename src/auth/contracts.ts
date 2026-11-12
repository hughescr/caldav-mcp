/** Internal auth contracts. Times are Unix seconds; TTL never grants validity. */
export type ConnectionStatus = 'active' | 'reconnect_required' | 'revoked';
export interface Sealed { keyId: string; nonce: string; ciphertext: string; tag: string }
export interface BaseRecord { kind: string; id: string; revision: number; expiresAt: number }
export interface Connection extends BaseRecord {
    kind: 'connection'; accountId: string; credentialGeneration: number;
    status: ConnectionStatus; credentials: Sealed;
}
/**
 * The only upstream secret this service persists, always sealed under the connection AAD.
 * The app-specific password is needed on every CalDAV request: iCloud offers no session token.
 */
export interface UpstreamCredentials {
    /** Must equal the connection's accountId. */
    accountId: string;
    /** Normalized Apple ID. */
    appleId: string;
    /** App-specific password exactly as iCloud accepted it at login (surrounding whitespace trimmed only). */
    appPassword: string;
    /** https URL on a fixed iCloud CalDAV host; re-checked every time it is used after decryption. */
    principalUrl: string;
    /** https URL on a fixed iCloud CalDAV host; re-checked every time it is used after decryption. */
    calendarHomeUrl: string;
    issuedAt: number;
}
/**
 * A grant is valid only while `credentialGeneration` equals its connection's: any replacement of
 * the stored credential ends every grant issued before it. It is also valid only while its client's
 * consent record for the account names it (see Consent): a new consent by the same client ends it.
 * `expiresAt` never exceeds the expiry of
 * the connection generation it was issued for, so a generation number reused after the connection
 * record is deleted can never match a live grant.
 */
export interface Grant extends BaseRecord {
    kind: 'grant'; clientId: string; connectionId: string; accountId: string;
    resource: string; scopes: string[]; status: 'active' | 'revoked';
    credentialGeneration: number; tokenVersion: number; refreshGeneration: number; refreshHash: string;
    previousRefreshHash?: string; receiptUntil?: number; receipt?: Sealed;
    receiptBinding?: string;
}
/**
 * `epoch` is the authorization epoch of the accepted consent submission that issued the code; the
 * code can be exchanged only while that epoch is its client's current one. Codes issued before
 * consent records existed have none and are refused.
 */
export interface AuthorizationCode extends BaseRecord {
    kind: 'code'; clientId: string; connectionId: string; accountId: string;
    credentialGeneration: number; redirectUri: string; resource: string; scopes: string[];
    challenge: string; consumedGrantId?: string; epoch?: string;
}
/**
 * The latest accepted consent of one client for one account; id = consentId(accountId, clientId).
 * Every accepted consent submission is its own authorization epoch: a fresh random `epoch`, never
 * reused, written here in the same transaction as the one code it issues, replacing the previous
 * epoch and dropping `grantId`. So every earlier grant and outstanding code of that client ends at that
 * moment, a resubmission of the same browser flow included. While the record exists, the only valid
 * grant of that client for that account is `grantId`, created by the exchange of the current epoch's
 * code. `expiresAt` never falls below the expiry of the connection generation it was written under,
 * so the record outlives every grant it can refuse. Grants that predate consent records are valid only
 * while no record exists for their client.
 */
export interface Consent extends BaseRecord {
    kind: 'consent'; accountId: string; clientId: string; epoch: string; grantId?: string;
}
/** Fixed-window count of upstream-rejected logins for one allowlisted account; id = accountId. */
export interface LoginThrottle extends BaseRecord {
    kind: 'throttle'; accountId: string; windowStart: number; failures: number;
}
export type AuthRecord = Connection | Grant | AuthorizationCode | Consent | LoginThrottle;
export interface Condition { kind: AuthRecord['kind']; id: string; revision: number | null }
export interface AtomicWrite { conditions: Condition[]; puts: AuthRecord[]; operationId: string }
export interface AtomicStore {
    /** Must be strongly consistent. Implementations reject expired records at callers. */
    get(kind: AuthRecord['kind'], id: string): Promise<AuthRecord | undefined>;
    /** All conditions and writes commit together. false means a known condition conflict.
     * Each operationId binds the exact write payload; identical retries return the original success.
     * Adapters retry unknown outcomes with the SAME operationId and payload within the bounded deadline.
     * Exhausted unknown outcomes MUST throw TemporaryUnavailable, never claim a conflict.
     * DynamoDB ClientRequestToken deduplication lasts ten minutes; never retry beyond that window.
     * Every put must have its revision/absence condition; reject duplicate key operations.
     * A write with conditions and no puts is a check-only authorization point. */
    transact(write: AtomicWrite): Promise<boolean>;
}
export interface ClientIdentity { clientId: string; redirectUris: readonly string[] }
export interface BackendSessionValidator {
    /** Implementations decrypt using connection AAD and re-check identity, allowlist and hosts. */
    validate(connection: Connection): Promise<'valid' | 'expired' | 'temporary'>;
    /** Local allowlist check with no upstream request, for paths that must not call iCloud (refresh-receipt recovery). */
    isAllowed(accountId: string): boolean;
}
export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }
/** `connection` is the record verifyAccess checked the grant against, so a caller need not read it again. */
export interface AuthContext { grantId: string; clientId: string; accountId: string; connectionId: string; scopes: string[]; connectionStatus: ConnectionStatus; connection: Connection }
export class OAuthError extends Error {
    constructor(public readonly error: 'invalid_grant' | 'invalid_request' | 'invalid_scope' | 'invalid_token' | 'temporarily_unavailable') { super(error); }
}
export class TemporaryUnavailable extends OAuthError { constructor() { super('temporarily_unavailable'); } }
/**
 * A stored credential that can never be used: authenticated decryption failed (tag or AAD mismatch,
 * a key no longer in the keyring), the plaintext is malformed, or it fails the identity or host
 * re-checks. Definitive for that record; only a new login can replace it. Carries no record data.
 */
export class UnreadableCredentials extends Error { constructor() { super('unreadable_credentials'); } }
