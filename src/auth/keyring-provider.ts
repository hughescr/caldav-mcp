import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { TemporaryUnavailable } from './contracts';
import type { Keyring } from './crypto';
export interface SsmSender { send(command: GetParameterCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown> }
export interface KeyringProviderOptions { parameterName: string; client?: SsmSender; now?: () => number; cacheMs?: number; timeoutMs?: number }
function parseKeyring(raw: unknown): Keyring {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) { throw new TemporaryUnavailable(); }
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new TemporaryUnavailable(); }
    const data = value as Record<string, unknown>;
    if (Object.keys(data).sort().join(',') !== 'activeKeyId,keys' || typeof data.activeKeyId !== 'string' || data.keys === null || typeof data.keys !== 'object' || Array.isArray(data.keys)) { throw new TemporaryUnavailable(); }
    const entries = Object.entries(data.keys);
    if (entries.length < 1 || entries.length > 32) { throw new TemporaryUnavailable(); }
    const keys: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
    for (const [id, encoded] of entries) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) { throw new TemporaryUnavailable(); }
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== 32 || bytes.toString('base64') !== encoded) { throw new TemporaryUnavailable(); }
        keys[id] = bytes;
    }
    if (!Object.hasOwn(keys, data.activeKeyId)) { throw new TemporaryUnavailable(); }
    return { activeKeyId: data.activeKeyId, keys };
}
/** Lazy per-process cache. Config contains only an exact SecureString parameter name. */
export class SsmKeyringProvider {
    private readonly client: SsmSender;
    private readonly now: () => number;
    private readonly cacheMs: number;
    private readonly timeoutMs: number;
    private cached: { keyring: Keyring; until: number } | undefined;
    private pending: Promise<Keyring> | undefined;
    constructor(private readonly options: KeyringProviderOptions) {
        if (!/^\/(?!aws(?:\/|$)|ssm(?:\/|$))[A-Za-z0-9_./-]{1,1000}$/.test(options.parameterName) || options.parameterName.includes('//')) { throw new Error('Invalid keyring parameter name'); }
        this.now = options.now ?? Date.now;
        this.cacheMs = options.cacheMs ?? 300000;
        this.timeoutMs = options.timeoutMs ?? 5000;
        if (!Number.isInteger(this.cacheMs) || this.cacheMs < 0 || this.cacheMs > 300000 || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 10000) { throw new Error('Invalid keyring cache or timeout'); }
        this.client = options.client ?? new SSMClient({ maxAttempts: 3 });
    }
    async getKeyring(): Promise<Keyring> {
        if (this.cached && this.now() < this.cached.until) { return this.copy(this.cached.keyring); }
        this.pending ??= this.load().finally(() => { this.pending = undefined; });
        return this.copy(await this.pending);
    }
    private copy(keyring: Keyring): Keyring { return { activeKeyId: keyring.activeKeyId, keys: Object.fromEntries(Object.entries(keyring.keys).map(([id, key]) => [id, Uint8Array.from(key)])) }; }
    private async load(): Promise<Keyring> {
        this.cached = undefined;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([this.client.send(new GetParameterCommand({ Name: this.options.parameterName, WithDecryption: true }), { abortSignal: controller.signal }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TemporaryUnavailable()); }, this.timeoutMs); })]);
            const parameter = (result as { Parameter?: { Name?: string; Type?: string; Value?: string } }).Parameter;
            if (parameter?.Name !== this.options.parameterName || parameter.Type !== 'SecureString') { throw new TemporaryUnavailable(); }
            const keyring = parseKeyring(parameter.Value);
            this.cached = { keyring, until: this.now() + this.cacheMs };
            return keyring;
        } catch { throw new TemporaryUnavailable(); }
        finally { clearTimeout(timer); }
    }
}
