import { createHash } from 'node:crypto';

const APPLE_ID_PATTERN = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}$/;
const ACCOUNT_ID_PREFIX = 'caldav-mcp/account/v1:';

/** Trims and lowercases an Apple ID; undefined when it is not a plain ASCII address. */
export function normalizeAppleId(raw: string): string | undefined {
    const normalized = raw.trim().toLowerCase();
    return APPLE_ID_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * Immutable account id and connection id: base64url(sha256(prefix + normalized Apple ID)).
 * A pseudonym, not a secret.
 */
export function accountIdFor(normalizedAppleId: string): string {
    return createHash('sha256').update(`${ACCOUNT_ID_PREFIX}${normalizedAppleId}`).digest('base64url');
}
