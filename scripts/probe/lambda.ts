import { normalizeAppleId } from '../../src/account';
import { loadBackendFromSource } from './backend-loader';
import { runProbe } from './core';
import { extraCaCertsSet, unsafeSetting } from './env-check';
import type { BackendLoad, ProbeDeps, ProbeFlags } from './types';

/**
 * AWS Lambda entry for the probe. Credentials arrive only in the invocation event; they
 * are never read from environment variables and nothing is written to the console, so
 * neither the event nor the report reaches CloudWatch Logs.
 */
export interface LambdaProbeEvent {
    appleId: string;
    appPassword: string;
    flags: ProbeFlags;
    inviteAttendee?: string;
    /** `flags.cleanupConfirmed`: must be the boolean true for a cleanup event. */
    cleanupConfirmed: boolean;
}

export interface LambdaContext {
    getRemainingTimeInMillis?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function flag(value: unknown): boolean | undefined {
    if (value === undefined) {
        return false;
    }
    return typeof value === 'boolean' ? value : undefined;
}

export function parseLambdaEvent(event: unknown): LambdaProbeEvent | undefined {
    if (!isRecord(event) || typeof event.appleId !== 'string' || typeof event.appPassword !== 'string' || !isRecord(event.flags)) {
        return undefined;
    }
    const appleId = normalizeAppleId(event.appleId);
    const appPassword = event.appPassword.trim();
    const write = flag(event.flags.write);
    const invite = flag(event.flags.invite);
    const cleanup = flag(event.flags.cleanup);
    const confirmed = flag(event.flags.inviteConfirmed);
    const cleanupConfirmed = flag(event.flags.cleanupConfirmed);
    if (appleId === undefined || appPassword === '' || appPassword.length > 256 || write === undefined || invite === undefined || cleanup === undefined || confirmed === undefined || cleanupConfirmed === undefined) {
        return undefined;
    }
    if (cleanup && (write || invite)) {
        return undefined;
    }
    // A cleanup event must say, explicitly, that the owner typed delete.
    if (cleanup && event.flags.cleanupConfirmed !== true) {
        return undefined;
    }
    const flags = { write, invite, cleanup };
    if (!invite) {
        return { appleId, appPassword, flags, cleanupConfirmed: cleanup && cleanupConfirmed };
    }
    const attendee = typeof event.inviteAttendee === 'string' ? normalizeAppleId(event.inviteAttendee) : undefined;
    if (!write || !confirmed || attendee === undefined) {
        return undefined;
    }
    return { appleId, appPassword, flags, inviteAttendee: attendee, cleanupConfirmed: false };
}

export type LambdaDeps = ProbeDeps & { awsRegion: string | null; extraCaCertsSet?: boolean };

export async function runLambdaEvent(event: unknown, deps: LambdaDeps): Promise<unknown> {
    const parsed = parseLambdaEvent(event);
    if (parsed === undefined) {
        return { error: 'invalid_event' };
    }
    const { cleanupConfirmed, ...input } = parsed;
    try {
        return await runProbe(
            { ...input, runLocation: 'lambda', awsRegion: deps.awsRegion, extraCaCertsSet: deps.extraCaCertsSet === true },
            { ...deps, confirmCleanup: async () => cleanupConfirmed },
        );
    } catch {
        return { error: 'probe_failed' };
    }
}

function randomHex(bytes: number): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

export function createHandler(loadBackend: () => Promise<BackendLoad>, env: Readonly<Record<string, string | undefined>> = process.env): (event: unknown, context?: LambdaContext) => Promise<unknown> {
    // Captured once: the skeleton-backend check replaces the global fetch while it runs.
    const realFetch = globalThis.fetch;
    return async (event, context) => {
        if (unsafeSetting(env) !== undefined) {
            return { error: 'unsafe_environment' };
        }
        const remaining = context?.getRemainingTimeInMillis;
        return runLambdaEvent(event, {
            fetch: (input, init) => realFetch(input, init),
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
            randomHex,
            loadBackend,
            awsRegion: env.AWS_REGION ?? null,
            extraCaCertsSet: extraCaCertsSet(env),
            ...(typeof remaining === 'function' ? { remainingMs: () => remaining.call(context) } : {}),
        });
    };
}

export const handler = createHandler(loadBackendFromSource);
