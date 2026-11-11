import { expect, test } from 'bun:test';
import { remainingRequestTimeMs, withRequestBudget } from '../src/request-budget';

test('absent budget is undefined, while live callbacks reflect prior authentication and dispatch time', async () => {
    expect(remainingRequestTimeMs()).toBeUndefined(); let remaining = 30_000; let reads = 0;
    await withRequestBudget(() => { reads++; return remaining; }, async () => {
        expect(reads).toBe(0); remaining = 12_500; await Promise.resolve();
        expect(remainingRequestTimeMs()).toBe(12_500); remaining = 1900; expect(remainingRequestTimeMs()).toBe(1900);
        remaining = 0; expect(remainingRequestTimeMs()).toBe(0); expect(reads).toBe(3);
    });
    expect(remainingRequestTimeMs()).toBeUndefined();
});
test('invalid or throwing provided callbacks fail closed without becoming an absent budget', () => {
    for (const value of [NaN, Infinity, -Infinity, -1, undefined, null, '30000']) {
        withRequestBudget(() => value as number, () => expect(remainingRequestTimeMs()).toBe(0));
    }
    withRequestBudget(() => { throw new Error('private callback error'); }, () => expect(remainingRequestTimeMs()).toBe(0));
    withRequestBudget(undefined as unknown as () => number, () => expect(remainingRequestTimeMs()).toBe(0));
    withRequestBudget(() => 2.9, () => expect(remainingRequestTimeMs()).toBe(2));
});
test('overlapping async requests and nested scopes keep independent live callbacks', async () => {
    const firstEntered = Promise.withResolvers<void>(), releaseFirst = Promise.withResolvers<void>(); let firstRemaining = 20_000;
    const first = withRequestBudget(() => firstRemaining, async () => { firstEntered.resolve(); await releaseFirst.promise; expect(remainingRequestTimeMs()).toBe(7000); return remainingRequestTimeMs(); });
    await firstEntered.promise;
    const second = withRequestBudget(() => 4000, async () => { await Promise.resolve(); expect(remainingRequestTimeMs()).toBe(4000); withRequestBudget(() => 12, () => expect(remainingRequestTimeMs()).toBe(12)); expect(remainingRequestTimeMs()).toBe(4000); firstRemaining = 7000; releaseFirst.resolve(); });
    await Promise.all([first, second]); expect(remainingRequestTimeMs()).toBeUndefined();
});
