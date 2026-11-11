import type { Config } from '../config';
import type { CalDavBackend } from '../caldav/contracts';
import { createICloudBackend } from '../caldav/icloud';
import { AuthCrypto, digest } from './crypto';
import { AuthEngine } from './engine';
import { ClientRegistry } from './clients';
import { DynamoAtomicStore } from './dynamo-store';
import { SsmKeyringProvider } from './keyring-provider';
import { CalDavSessionValidator } from './caldav-session';
import type { AtomicStore } from './contracts';
export interface AuthRuntime {
    issuer: string; crypto: AuthCrypto; engine: AuthEngine; clients: ClientRegistry; store: AtomicStore;
    caldav: CalDavBackend;
    /** The only allowlist consulted at login, in the session validator and on every MCP request. */
    allowedAccountIds: ReadonlySet<string>;
}
export type RuntimeProvider = () => Promise<AuthRuntime | undefined>;
/** Refresh the keyring cache on every request; never pin retired keys in a singleton engine. */
export function createRuntimeProvider(config: Config): RuntimeProvider {
    if (!config.publicBaseUrl || !config.credentialTableName || !config.authKeyringParameter) { return async () => undefined; }
    const issuer = config.publicBaseUrl;
    const allowedAccountIds = config.allowedAccountIds;
    const provider = new SsmKeyringProvider({ parameterName: config.authKeyringParameter });
    const store = new DynamoAtomicStore({ tableName: config.credentialTableName });
    const caldav = createICloudBackend();
    let active: { fingerprint: string; runtime: AuthRuntime } | undefined;
    return async () => {
        const keyring = await provider.getKeyring();
        const fingerprint = digest(JSON.stringify([keyring.activeKeyId, Object.entries(keyring.keys).map(([id, key]) => [id, Buffer.from(key).toString('base64')])]));
        if (!active || active.fingerprint !== fingerprint) {
            const crypto = new AuthCrypto(keyring);
            const engine = new AuthEngine(store, crypto, new CalDavSessionValidator(caldav, crypto, allowedAccountIds), { issuer, refreshRetrySeconds: 10 });
            active = { fingerprint, runtime: { issuer, crypto, store, caldav, allowedAccountIds, engine, clients: new ClientRegistry({ crypto }) } };
        }
        return active.runtime;
    };
}
