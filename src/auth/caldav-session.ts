import { accountIdFor, normalizeAppleId } from '../account';
import type { CalDavBackend } from '../caldav/contracts';
import { isAllowedCalDavUrl } from '../caldav/hosts';
import { UnreadableCredentials, type BackendSessionValidator, type Connection, type UpstreamCredentials } from './contracts';
import { AuthCrypto, connectionAAD } from './crypto';

const FIELDS = ['accountId', 'appPassword', 'appleId', 'calendarHomeUrl', 'issuedAt', 'principalUrl'].join(',');

/**
 * Decrypts a connection's credentials and re-checks everything they will be used for:
 * the exact field set, the account identity (appleId must hash to the connection's accountId)
 * and the fixed-host rule on both stored URLs. Throws UnreadableCredentials on any failure, which is
 * definitive for this record (the keyring itself is loaded, or has already failed, before this runs).
 * The returned object holds the app-specific password: keep it in request-local closures only.
 */
export function readCredentials(crypto: AuthCrypto, connection: Connection): UpstreamCredentials {
    let value: unknown;
    try { value = crypto.open('upstream-credentials', connectionAAD(connection), connection.credentials); } catch { throw new UnreadableCredentials(); }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== FIELDS) { throw new UnreadableCredentials(); }
    const credentials = value as UpstreamCredentials;
    const valid = credentials.accountId === connection.accountId
        && typeof credentials.appleId === 'string' && normalizeAppleId(credentials.appleId) === credentials.appleId
        && accountIdFor(credentials.appleId) === connection.accountId
        && typeof credentials.appPassword === 'string' && credentials.appPassword.length > 0 && credentials.appPassword.length <= 256
        && typeof credentials.principalUrl === 'string' && isAllowedCalDavUrl(credentials.principalUrl)
        && typeof credentials.calendarHomeUrl === 'string' && isAllowedCalDavUrl(credentials.calendarHomeUrl)
        && Number.isSafeInteger(credentials.issuedAt);
    if (!valid) { throw new UnreadableCredentials(); }
    return credentials;
}

/** Backend session check used by the engine at connect, code issue, exchange and refresh. */
export class CalDavSessionValidator implements BackendSessionValidator {
    constructor(
        private readonly caldav: Pick<CalDavBackend, 'validate'>,
        private readonly crypto: AuthCrypto,
        private readonly allowedAccountIds: ReadonlySet<string>,
    ) {}

    isAllowed(accountId: string): boolean {
        return this.allowedAccountIds.has(accountId);
    }

    async validate(connection: Connection): Promise<'valid' | 'expired' | 'temporary'> {
        if (connection.id !== connection.accountId || connection.status !== 'active') { return 'temporary'; }
        // Removal from the allowlist is definitive: the grant must not outlive it.
        if (!this.allowedAccountIds.has(connection.accountId)) { return 'expired'; }
        // So is a credential that can never be opened: the connection needs a new login.
        let credentials: UpstreamCredentials;
        try { credentials = readCredentials(this.crypto, connection); } catch { return 'expired'; }
        try {
            const result = await this.caldav.validate(
                { appleId: credentials.appleId, appPassword: credentials.appPassword },
                { principalUrl: credentials.principalUrl, calendarHomeUrl: credentials.calendarHomeUrl },
            );
            return result === 'valid' || result === 'expired' ? result : 'temporary';
        } catch { return 'temporary'; }
    }
}
