import { expect, test } from 'bun:test';
import { LoginThrottle, MAX_LOGIN_FAILURES, LOGIN_WINDOW_SECONDS, type LoginReservation } from '../src/auth/throttle';
import { TemporaryUnavailable, type AtomicStore } from '../src/auth/contracts';
import { MemoryStore } from '../src/auth/memory-store';
import { accountIdFor } from '../src/account';

const account = accountIdFor('user@example.invalid');

function fixture() {
    let now = 1_000_000;
    const store = new MemoryStore();
    const throttle = new LoginThrottle(store, () => now);
    return { store, throttle, tick: (seconds: number) => { now += seconds; }, now: () => now };
}

async function reserved(throttle: LoginThrottle, accountId = account): Promise<LoginReservation> {
    const result = await throttle.reserve(accountId);
    if (result === 'throttled') { throw new Error('unexpectedly throttled'); }
    return result;
}

test('policy is five attempts per fifteen minutes', () => {
    expect(MAX_LOGIN_FAILURES).toBe(5);
    expect(LOGIN_WINDOW_SECONDS).toBe(900);
});

test('five kept reservations throttle the account for the rest of the fixed window', async () => {
    const f = fixture();
    for (let index = 0; index < 5; index++) {
        await reserved(f.throttle);
        f.tick(60);
    }
    expect(await f.throttle.reserve(account)).toBe('throttled');
    expect(await f.store.get('throttle', account)).toEqual({ kind: 'throttle', id: account, accountId: account, revision: 4, windowStart: 1_000_000, expiresAt: 1_000_900, failures: 5 });
    f.tick(899 - 300);
    expect(await f.throttle.reserve(account)).toBe('throttled');
    f.tick(1);
    expect(await f.throttle.reserve(account)).toEqual({ accountId: account, windowStart: 1_000_900 });
    expect(await f.store.get('throttle', account)).toEqual({ kind: 'throttle', id: account, accountId: account, revision: 5, windowStart: 1_000_900, expiresAt: 1_001_800, failures: 1 });
});

test('a released reservation returns its slot, so successes and temporary outcomes consume nothing', async () => {
    const f = fixture();
    for (let index = 0; index < 12; index++) {
        await f.throttle.release(await reserved(f.throttle));
    }
    expect(await f.store.get('throttle', account)).toMatchObject({ failures: 0, windowStart: 1_000_000 });
});

test('in-flight and failed attempts together never exceed five', async () => {
    const f = fixture();
    const inFlight = await Promise.all(Array.from({ length: 5 }, () => reserved(f.throttle)));
    expect(await f.throttle.reserve(account)).toBe('throttled');
    await f.throttle.release(inFlight[0] as LoginReservation);
    await f.throttle.release(inFlight[1] as LoginReservation);
    await reserved(f.throttle);
    await reserved(f.throttle);
    expect(await f.throttle.reserve(account)).toBe('throttled');
    expect(await f.store.get('throttle', account)).toMatchObject({ failures: 5 });
});

test('a release after the window ended leaves the new window untouched', async () => {
    const f = fixture();
    const old = await reserved(f.throttle);
    f.tick(900);
    await reserved(f.throttle);
    await f.throttle.release(old);
    expect(await f.store.get('throttle', account)).toMatchObject({ windowStart: 1_000_900, failures: 1 });
});

test('a release never takes the count below zero', async () => {
    const f = fixture();
    const reservation = await reserved(f.throttle);
    await f.throttle.release(reservation);
    await f.throttle.release(reservation);
    expect(await f.store.get('throttle', account)).toMatchObject({ failures: 0 });
});

test('forty concurrent reservations grant at most five', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 40 }, () => f.throttle.reserve(account).catch((error: unknown) => error)));
    const granted = results.filter(result => typeof result === 'object' && result !== null && !(result instanceof Error));
    expect(granted.length).toBeGreaterThan(0);
    expect(granted.length).toBeLessThanOrEqual(5);
    for (const result of results) {
        expect(result === 'throttled' || result instanceof TemporaryUnavailable || granted.includes(result)).toBe(true);
    }
    expect(await f.store.get('throttle', account)).toMatchObject({ failures: granted.length });
});

test('accounts are counted independently', async () => {
    const f = fixture(); const other = accountIdFor('other@example.invalid');
    for (let index = 0; index < 5; index++) { await reserved(f.throttle); }
    expect(await f.throttle.reserve(other)).toEqual({ accountId: other, windowStart: 1_000_000 });
});

test('persistent conflicts, store errors and foreign records fail closed', async () => {
    const conflicting: AtomicStore = { get: async () => undefined, transact: async () => false };
    await expect(new LoginThrottle(conflicting).reserve(account)).rejects.toThrow(TemporaryUnavailable);
    const broken: AtomicStore = { get: async () => { throw new Error('private store failure'); }, transact: async () => { throw new Error('private store failure'); } };
    await expect(new LoginThrottle(broken).reserve(account)).rejects.toThrow(TemporaryUnavailable);
    await expect(new LoginThrottle(broken).release({ accountId: account, windowStart: 0 })).rejects.toThrow(TemporaryUnavailable);
    const unknownOutcome: AtomicStore = { get: async () => undefined, transact: async () => { throw new TemporaryUnavailable(); } };
    await expect(new LoginThrottle(unknownOutcome).reserve(account)).rejects.toThrow(TemporaryUnavailable);
    const foreign: AtomicStore = { get: async () => ({ kind: 'throttle', id: 'someone-else', accountId: 'someone-else', revision: 0, windowStart: 0, expiresAt: 9_999_999_999, failures: 0 }), transact: async () => true };
    await expect(new LoginThrottle(foreign).reserve(account)).rejects.toThrow(TemporaryUnavailable);
    await expect(new LoginThrottle(foreign).release({ accountId: account, windowStart: 0 })).rejects.toThrow(TemporaryUnavailable);
});

test('only well-formed account ids are accepted', async () => {
    const f = fixture();
    for (const id of ['', 'user@example.invalid', 'x'.repeat(42), `${account}#grant`]) {
        await expect(f.throttle.reserve(id)).rejects.toThrow();
        await expect(f.throttle.release({ accountId: id, windowStart: 1_000_000 })).rejects.toThrow();
    }
});
