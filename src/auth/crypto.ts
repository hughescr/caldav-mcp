import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuthError, type Sealed } from './contracts';
export interface Keyring { activeKeyId: string; keys: Readonly<Record<string, Uint8Array>> }
export interface TokenEnvelope { kind: 'access' | 'refresh'; grantId: string; generation: number; version: number; expiresAt: number; secret: string }
const encode = (value: Uint8Array | string) => Buffer.from(value).toString('base64url');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export function equal(left: string, right: string): boolean {
    const a = Buffer.from(left); const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}
export function digest(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
export function randomId(): string { return randomBytes(32).toString('base64url'); }
export class AuthCrypto {
    constructor(private readonly keyring: Keyring) {
        if (Object.keys(keyring.keys).some(id => !/^[A-Za-z0-9_-]{1,64}$/.test(id)) || !Object.hasOwn(keyring.keys, keyring.activeKeyId) || Object.values(keyring.keys).some(key => key.byteLength !== 32)) {throw new Error('A versioned 256-bit keyring is required');}
    }
    private key(id: string, purpose: string): Buffer {
        const root = this.keyring.keys[id]; if (!root) {throw new OAuthError('invalid_token');}
        return Buffer.from(hkdfSync('sha256', root, 'caldav-mcp/auth/v1', purpose, 32));
    }
    sign(purpose: string, payload: string): string {
        const id = this.keyring.activeKeyId;
        return `${id}.${encode(payload)}.${createHmac('sha256', this.key(id, purpose)).update(`${id}.${encode(payload)}`).digest('base64url')}`;
    }
    verify(purpose: string, token: string): string {
        if (token.length > 16384) {throw new OAuthError('invalid_token');}
        const parts = token.split('.'); const [id, payload, mac] = parts;
        if (parts.length !== 3 || !id || !payload || !mac) {throw new OAuthError('invalid_token');}
        const expected = createHmac('sha256', this.key(id, purpose)).update(`${id}.${payload}`).digest('base64url');
        if (!equal(expected, mac)) {throw new OAuthError('invalid_token');}
        return Buffer.from(payload, 'base64url').toString('utf8');
    }
    token(value: TokenEnvelope): string { return this.sign('token-envelope', JSON.stringify(value)); }
    readToken(token: string, kind: TokenEnvelope['kind'], now: number): TokenEnvelope {
        let value: TokenEnvelope;
        try { value = JSON.parse(this.verify('token-envelope', token)) as TokenEnvelope; } catch { throw new OAuthError('invalid_token'); }
        if (value.kind !== kind || typeof value.grantId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.grantId) || typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.secret) || !Number.isSafeInteger(value.generation) || value.generation < 0 || !Number.isSafeInteger(value.version) || value.version < 0 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) {throw new OAuthError('invalid_token');}
        return value;
    }
    seal(purpose: string, aad: string, value: unknown): Sealed {
        const keyId = this.keyring.activeKeyId; const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv('aes-256-gcm', this.key(keyId, purpose), nonce, { authTagLength: TAG_BYTES });
        cipher.setAAD(Buffer.from(aad));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
        return { keyId, nonce: encode(nonce), ciphertext: encode(ciphertext), tag: encode(cipher.getAuthTag()) };
    }
    open<T>(purpose: string, aad: string, value: Sealed): T {
        // Pinned lengths: some runtimes otherwise accept a truncated (forgeable) tag.
        const nonce = Buffer.from(value.nonce, 'base64url'); const tag = Buffer.from(value.tag, 'base64url');
        if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) { throw new Error('Invalid sealed value'); }
        const decipher = createDecipheriv('aes-256-gcm', this.key(value.keyId, purpose), nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as T;
    }
}
export function connectionAAD(connection: { id: string; accountId: string; credentialGeneration: number }): string {
    return JSON.stringify(['caldav-mcp', 1, 'upstream-credentials', connection.accountId, connection.id, connection.credentialGeneration]);
}
