import { CheckStop, type CheckContext, type CheckDef, type CheckOutput } from '../context';
import { absolute } from '../dav';
import { ProbeHttpError } from '../http';
import { DISCOVERY_URL } from '../hosts';
import { fixed, prose, type Safe } from '../safe';
import type { Evidence } from '../types';
import { BACKEND_CODES as BACKEND_CODE_LIST, VALIDATE_RESULTS as VALIDATE_RESULT_LIST } from '../vocabulary';

const BACKEND_CODES: ReadonlySet<string> = new Set(BACKEND_CODE_LIST);
const VALIDATE_RESULTS: ReadonlySet<string> = new Set(VALIDATE_RESULT_LIST);
const POLICY_CODES = new Set(['probe_forbidden_host', 'probe_method_not_allowed', 'probe_write_outside_probe_calendar']);

function errorCode(error: unknown): Safe {
    if (error instanceof ProbeHttpError) {
        return fixed(`probe_${error.code}`);
    }
    if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && BACKEND_CODES.has(error.code)) {
        return fixed(error.code);
    }
    return fixed('other');
}

function method(target: unknown, name: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
    if (target === null || typeof target !== 'object') {
        return undefined;
    }
    const fn: unknown = Reflect.get(target, name);
    return typeof fn === 'function' ? (...args: unknown[]) => Promise.resolve(Reflect.apply(fn, target, args)) : undefined;
}

function same(a: unknown, b: string | undefined): boolean {
    if (typeof a !== 'string' || b === undefined) {
        return false;
    }
    const x = absolute(a, DISCOVERY_URL);
    const y = absolute(b, DISCOVERY_URL);
    const slash = (u: string | undefined): string | undefined => (u === undefined || u.endsWith('/') ? u : `${u}/`);
    return x !== undefined && slash(x) === slash(y);
}

async function runBackend(ctx: CheckContext): Promise<CheckOutput> {
    const load = await ctx.loadBackend();
    if (load.status === 'absent') {
        return { outcome: 'skipped', summary: prose`src/caldav/icloud.ts is not part of this build.`, evidence: {} };
    }
    if (load.status === 'import_failed') {
        return { outcome: 'error', summary: prose`src/caldav/icloud.ts exists but could not be imported.`, evidence: {} };
    }
    const factory: unknown = load.module.createICloudBackend;
    if (typeof factory !== 'function') {
        return { outcome: 'error', summary: prose`src/caldav/icloud.ts does not export createICloudBackend.`, evidence: {} };
    }
    let backend: unknown;
    try {
        backend = Reflect.apply(factory, undefined, [{ fetch: ctx.http.fetchAdapter() }]);
    } catch (error) {
        return { outcome: 'error', summary: prose`createICloudBackend threw.`, evidence: { constructError: errorCode(error) } };
    }
    const discover = method(backend, 'discover');
    const listCalendars = method(backend, 'listCalendars');
    const validate = method(backend, 'validate');
    if (discover === undefined || listCalendars === undefined || validate === undefined) {
        return { outcome: 'error', summary: prose`The backend lacks discover, validate or listCalendars.`, evidence: {} };
    }
    const auth = { appleId: ctx.credentials.appleId, appPassword: ctx.credentials.appPassword };
    const evidence: Evidence = { discoverOk: false, listOk: false };
    let discovery: unknown;
    try {
        discovery = await discover(auth);
        evidence.discoverOk = true;
    } catch (error) {
        evidence.discoverError = errorCode(error);
    }
    if (discovery !== null && typeof discovery === 'object') {
        evidence.principalMatchesProbe = same(Reflect.get(discovery, 'principalUrl'), ctx.state.principalUrl);
        evidence.homeMatchesProbe = same(Reflect.get(discovery, 'calendarHomeUrl'), ctx.state.homeUrl);
        try {
            const list = await listCalendars(auth, discovery);
            evidence.listOk = Array.isArray(list);
            if (Array.isArray(list)) {
                evidence.calendarCount = list.length;
                const probeCount = (ctx.state.calendars ?? []).filter((c) => c.isCalendar && c.components.includes('VEVENT')).length;
                evidence.countMatchesProbe = ctx.state.calendars === undefined ? null : list.length === probeCount;
            }
        } catch (error) {
            evidence.listError = errorCode(error);
        }
        try {
            const result = await validate(auth, discovery);
            evidence.validateResult = typeof result === 'string' && VALIDATE_RESULTS.has(result) ? fixed(result) : fixed('<other>');
        } catch (error) {
            evidence.validateError = errorCode(error);
        }
    }
    if (evidence.discoverOk === true && evidence.listOk === true) {
        const count = evidence.calendarCount;
        return { outcome: 'confirmed', summary: prose`discover and listCalendars succeeded (${typeof count === 'number' ? count : 0} calendar(s)).`, evidence };
    }
    const codes = [evidence.discoverError, evidence.listError];
    // A probe limit (cap, deadline, timeout, throttling) is not the backend's fault; a
    // refused host or method is.
    const transient = (c: unknown): boolean => c === 'temporary' || (typeof c === 'string' && c.startsWith('probe_') && !POLICY_CODES.has(c));
    if (codes.some(transient)) {
        throw new CheckStop('inconclusive', prose`The backend hit a temporary failure or a probe limit.`, evidence);
    }
    return { outcome: 'refuted', summary: prose`The backend failed against the server.`, evidence };
}

/** Thrown by the global fetch while the backend runs; never sent anywhere. */
async function blockedFetch(): Promise<Response> {
    throw new ProbeHttpError('forbidden_host');
}

export const backendCheck: CheckDef = {
    id: 'skeleton-backend',
    planItem: 'Phase 1: list_calendars through src/caldav/icloud.ts (createICloudBackend)',
    claim: 'The skeleton backend discovers the account and lists calendars against the real server, through the probe’s guarded fetch.',
    // Only after the probe's own discovery succeeded, so a wrong password is never retried here.
    needs: 'home',
    async run(ctx) {
        // While the backend runs, the global fetch throws: every request it makes must go
        // through the injected adapter (host rule, method policy, pacing, 401 latch).
        const original = globalThis.fetch;
        globalThis.fetch = Object.assign(blockedFetch, { preconnect: () => undefined }) as unknown as typeof fetch;
        try {
            return await runBackend(ctx);
        } finally {
            globalThis.fetch = original;
        }
    },
};
