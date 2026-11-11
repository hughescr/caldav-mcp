export interface Config {
    readonly publicBaseUrl?: string;
    readonly credentialTableName?: string;
    readonly authKeyringParameter?: string;
    /** Account ids (see src/account.ts) allowed to connect. Empty means nobody (fail closed). */
    readonly allowedAccountIds: ReadonlySet<string>;
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{43}$/;
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const PARAMETER_NAME = /^\/(?!aws(?:\/|$)|ssm(?:\/|$))[A-Za-z0-9_./-]{1,1000}$/;

/** A set callers cannot widen: the allowlist is configuration, never runtime state. */
class FrozenSet<T> implements ReadonlySet<T> {
    readonly #items: Set<T>;
    constructor(items: Iterable<T>) { this.#items = new Set(items); }
    get size(): number { return this.#items.size; }
    has(value: T): boolean { return this.#items.has(value); }
    forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
        for (const value of this.#items) { callback.call(thisArg, value, value, this); }
    }
    entries(): SetIterator<[T, T]> { return this.#items.entries(); }
    keys(): SetIterator<T> { return this.#items.keys(); }
    values(): SetIterator<T> { return this.#items.values(); }
    [Symbol.iterator](): SetIterator<T> { return this.#items.values(); }
}

/** Never echoes the offending value: an allowlist entry may be a pasted Apple ID. */
function allowlist(raw: string | undefined): ReadonlySet<string> {
    if (raw === undefined || raw === '') { return new FrozenSet<string>([]); }
    const entries = raw.split(',').map(entry => entry.trim());
    if (entries.some(entry => !ACCOUNT_ID.test(entry))) {
        throw new Error('ALLOWED_APPLE_ID_HASHES must be a comma-separated list of account hashes from `bun run apple-id-hash`');
    }
    return new FrozenSet(entries);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
    // The fixed-host rule only keeps the iCloud password on Apple's hosts if TLS authenticates them.
    if (env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') { throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification; refusing to start'); }
    const raw = env['PUBLIC_BASE_URL'];
    let publicBaseUrl: string | undefined;
    if (raw) {
        let url: URL;
        try { url = new URL(raw); } catch { throw new Error('PUBLIC_BASE_URL must be an HTTPS origin'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || raw.includes('#') || url.pathname !== '/') { throw new Error('PUBLIC_BASE_URL must be an HTTPS origin'); }
        publicBaseUrl = url.origin;
    }
    const credentialTableName = env['CREDENTIAL_TABLE_NAME'] || undefined;
    if (credentialTableName !== undefined && !TABLE_NAME.test(credentialTableName)) { throw new Error('CREDENTIAL_TABLE_NAME is not a valid DynamoDB table name'); }
    const authKeyringParameter = env['AUTH_KEYRING_PARAMETER'] || undefined;
    if (authKeyringParameter !== undefined && (!PARAMETER_NAME.test(authKeyringParameter) || authKeyringParameter.includes('//'))) { throw new Error('AUTH_KEYRING_PARAMETER is not a valid SSM parameter name'); }
    return {
        allowedAccountIds: allowlist(env['ALLOWED_APPLE_ID_HASHES']),
        ...(publicBaseUrl ? { publicBaseUrl } : {}),
        ...(credentialTableName ? { credentialTableName } : {}),
        ...(authKeyringParameter ? { authKeyringParameter } : {}),
    };
}
