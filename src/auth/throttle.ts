import { randomId } from './crypto';
import { TemporaryUnavailable, type AtomicStore, type LoginThrottle as ThrottleRecord } from './contracts';

export const MAX_LOGIN_FAILURES = 5;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
/** Enough for a burst to settle on a strongly consistent store; beyond it the login fails closed. */
const MAX_CAS_ATTEMPTS = 8;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{43}$/;

/** One reserved sign-in attempt, tied to the window it was counted in. */
export interface LoginReservation {
    readonly accountId: string;
    readonly windowStart: number;
}

/**
 * Fixed-window budget of sign-in attempts per allowlisted account. An attempt is reserved
 * (counted) by a conditional write BEFORE any upstream request, so concurrent requests can
 * never put more than MAX_LOGIN_FAILURES attempts in flight or failed in one window.
 * A failed sign-in keeps its reservation; a success or a temporary upstream outcome releases it.
 * Only call it for accounts that passed the allowlist, so unknown Apple IDs never create records.
 * Every store problem throws TemporaryUnavailable: the caller must fail closed.
 */
export class LoginThrottle {
    constructor(private readonly store: AtomicStore, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

    private async current(accountId: string): Promise<ThrottleRecord | undefined> {
        if (!ACCOUNT_ID.test(accountId)) { throw new Error('Invalid throttle account id'); }
        let record;
        try { record = await this.store.get('throttle', accountId); } catch { throw new TemporaryUnavailable(); }
        if (record === undefined) { return undefined; }
        if (record.kind !== 'throttle' || record.id !== accountId || record.accountId !== accountId) { throw new TemporaryUnavailable(); }
        return record;
    }

    private async write(existing: ThrottleRecord | undefined, next: ThrottleRecord): Promise<boolean> {
        try {
            return await this.store.transact({ conditions: [{ kind: 'throttle', id: next.id, revision: existing?.revision ?? null }], puts: [next], operationId: randomId() });
        } catch { throw new TemporaryUnavailable(); }
    }

    /** Counts one attempt if the window has room; 'throttled' when it is full. */
    async reserve(accountId: string): Promise<LoginReservation | 'throttled'> {
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            const existing = await this.current(accountId);
            const now = this.now();
            const open = existing !== undefined && existing.expiresAt > now;
            if (open && existing.failures >= MAX_LOGIN_FAILURES) { return 'throttled'; }
            const windowStart = open ? existing.windowStart : now;
            const next: ThrottleRecord = {
                kind: 'throttle', id: accountId, accountId,
                revision: existing ? existing.revision + 1 : 0,
                windowStart, expiresAt: windowStart + LOGIN_WINDOW_SECONDS,
                failures: open ? existing.failures + 1 : 1,
            };
            if (await this.write(existing, next)) { return { accountId, windowStart }; }
        }
        throw new TemporaryUnavailable();
    }

    /** Returns a reservation's slot. A no-op once its window has ended. Throws TemporaryUnavailable when the store fails. */
    async release(reservation: LoginReservation): Promise<void> {
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            const existing = await this.current(reservation.accountId);
            if (existing === undefined || existing.windowStart !== reservation.windowStart || existing.expiresAt <= this.now() || existing.failures <= 0) { return; }
            if (await this.write(existing, { ...existing, revision: existing.revision + 1, failures: existing.failures - 1 })) { return; }
        }
        throw new TemporaryUnavailable();
    }
}
