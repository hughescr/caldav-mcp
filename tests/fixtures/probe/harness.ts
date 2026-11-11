import { runProbe } from '../../../scripts/probe/core';
import type { BackendLoad, CheckResult, ProbeDeps, ProbeFlags, ProbeReport } from '../../../scripts/probe/types';
import { FAKE_NOW, type FakeICloud } from './fake-icloud';

export interface Clock {
    now(): number;
    sleeps: number[];
}

export function fakeDeps(fake: FakeICloud, overrides: Partial<ProbeDeps> = {}): ProbeDeps & { clock: Clock } {
    let now = FAKE_NOW;
    const sleeps: number[] = [];
    let counter = 0;
    return {
        fetch: fake.fetch,
        now: () => now,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            now += ms;
            await Promise.resolve();
        },
        randomHex: (bytes: number) => {
            counter++;
            return (counter.toString(16).padStart(2, '0').repeat(bytes)).slice(0, bytes * 2).replace(/^./, 'a');
        },
        loadBackend: async (): Promise<BackendLoad> => ({ status: 'absent' }),
        clock: { now: () => now, sleeps },
        ...overrides,
    };
}

export const READ_ONLY: ProbeFlags = { write: false, invite: false, cleanup: false };
export const WRITE: ProbeFlags = { write: true, invite: false, cleanup: false };

export async function probe(fake: FakeICloud, flags: ProbeFlags, credentials: { appleId: string; appPassword: string }, overrides: Partial<ProbeDeps> = {}, inviteAttendee?: string): Promise<ProbeReport> {
    return runProbe({ ...credentials, flags, runLocation: 'local', ...(inviteAttendee === undefined ? {} : { inviteAttendee }) }, fakeDeps(fake, overrides));
}

export function check(report: ProbeReport, id: string): CheckResult {
    const found = report.checks.find((c) => c.id === id);
    if (found === undefined) {
        throw new Error(`check ${id} missing from report`);
    }
    return found;
}

export function outcomes(report: ProbeReport): Record<string, string> {
    return Object.fromEntries(report.checks.map((c) => [c.id, c.outcome]));
}

export const WRITE_METHODS = new Set(['PUT', 'DELETE', 'MKCALENDAR', 'POST', 'PROPPATCH', 'MOVE', 'COPY', 'PATCH', 'MKCOL', 'LOCK', 'UNLOCK', 'ACL']);
