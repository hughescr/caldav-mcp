import type { AttachmentState } from './attachments';
import type { IcalComponent } from './ical';
import { ProbeHttpError, type ProbeHttp, type ProbeResponse } from './http';
import { fixed, parseRetryAfter, prose, type Prose, type Safe, type Taint } from './safe';
import type { BackendLoad, CheckResult, Evidence, Outcome, ProbeFlags, ProbeLimits } from './types';

export type CalendarKind = 'owned' | 'shared-with-me' | 'shared-by-me' | 'subscribed';

export interface CalendarInfo {
    /** Absolute URL. In memory only. */
    href: string;
    kind: CalendarKind;
    isCalendar: boolean;
    components: string[];
    writable: boolean;
    /** In memory only (cleanup compares it with the probe prefix). */
    displayName: string | null;
}

export interface WindowResource {
    href: string;
    etag: string | null;
    ical: IcalComponent | undefined;
    /** Lower-cased SUMMARY values of every component in the resource. In memory only. */
    summaries: string[];
    recurring: boolean;
    /** The calendar-data text exactly as the XML parser returned it. In memory only. */
    calendarData: string | null;
}

export interface WindowData {
    status: number;
    resources: WindowResource[];
    /** Decoded size of the response body in bytes (0 when no response was read). */
    bytes: number;
}

export interface TempCalendar {
    name: string;
    /** Where the write checks put events: the requested URL, or a registered server-chosen Location. */
    url: string;
    /** The URL the probe sent MKCALENDAR to (always caldav-mcp-probe-<hex>/ under the home). */
    requestedUrl: string;
    /** Every URL that is DELETEd at the end: `url` first, then `requestedUrl` if different. */
    deleteUrls: string[];
    removalVerified: boolean;
    deleteStatus: number | null;
    /** Whether a PROPFIND showed the calendar-timezone the probe set at MKCALENDAR (null: not set or not read). */
    calendarTimezoneKept?: boolean | null;
}

export interface RoundTripDiff {
    id: string;
    changed: string[];
    removed: string[];
    added: string[];
    prodidChanged: boolean;
    dtstampChanged: boolean;
    sequenceChanged: boolean;
}

export interface ProbeState {
    authStatus: number | null;
    principalUrl?: string;
    homeUrl?: string;
    /** calendar-user-address-set values, in memory only (the invite check needs the organizer). */
    addresses: string[];
    rootDav: { tokens: Safe[]; otherCount: number } | undefined;
    homeDav: { tokens: Safe[]; otherCount: number } | undefined;
    schedulingProps: Record<string, boolean>;
    calendars?: CalendarInfo[];
    window: Map<string, WindowData>;
    windowLoaded: boolean;
    /** The ±window the checks share, fixed on first use so every query covers the same days. */
    windowBounds?: { start: number; end: number };
    /** The same window queried with calendar-data/expand, per calendar (filled on demand). */
    expanded: Map<string, WindowData>;
    /** Depth header that sync-collection accepted (RFC 6578 requires 0; 1 is a recorded fallback). */
    syncDepth?: '0' | '1';
    /** Filled by the strictness census from its wide query; read by the attachment checks (in memory only). */
    attachments?: AttachmentState;
    temp: TempCalendar[];
    primaryTemp?: TempCalendar;
    created?: { href: string; etag: string | null; staleEtag?: string | null; uid: string } | undefined;
    roundTrips: RoundTripDiff[];
    eventCounter: number;
}

export interface CheckContext {
    http: ProbeHttp;
    taint: Taint;
    now(): number;
    sleep(ms: number): Promise<void>;
    randomHex(bytes: number): string;
    flags: ProbeFlags;
    credentials: { appleId: string; appPassword: string };
    inviteAttendee: string | undefined;
    state: ProbeState;
    limits: ProbeLimits;
    loadBackend: () => Promise<BackendLoad>;
}

export interface CheckOutput {
    outcome: Outcome;
    /** Fixed text with typed variable parts; rendered (and second-layer checked) when the report is built. */
    summary: Prose;
    evidence: Evidence;
}

/** A check result before the report is built: the summary is still `Prose`. */
export interface CheckRecord extends Omit<CheckResult, 'summary'> {
    summary: Prose;
}

export interface CheckDef {
    id: string;
    planItem: string;
    claim: string;
    needs?: 'home' | 'calendars' | 'temp' | 'created';
    /** Sends no request (reads only recorded state), so it still runs after a 401. */
    offline?: boolean;
    run(ctx: CheckContext): Promise<CheckOutput>;
}

const REJECTED = prose`Skipped: the server refused the credentials (HTTP 401), so no further requests were sent.`;

/** Ends a check early with a recorded outcome. */
export class CheckStop extends Error {
    constructor(public readonly outcome: Outcome, public readonly summary: Prose, public readonly evidence: Evidence = {}) {
        super('check stopped');
        this.name = 'CheckStop';
    }
}

/** A 429 or 503 stops the current check and records Retry-After. */
export function stopOnThrottle(ctx: CheckContext, res: ProbeResponse): void {
    if (res.status === 429 || res.status === 503) {
        throw new CheckStop('inconclusive', prose`Server answered HTTP ${res.status}; check stopped to stay gentle.`, {
            status: res.status,
            retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after'), ctx.now()),
        });
    }
}

export function isOk(status: number): boolean {
    return status >= 200 && status < 300;
}

/** A 4xx refusal that is not throttling. */
export function isRefusal(status: number): boolean {
    return status >= 400 && status < 500 && status !== 429;
}

const NEEDS_MESSAGE: Record<NonNullable<CheckDef['needs']>, Prose> = {
    home: prose`Skipped: discovery did not find a usable calendar home.`,
    calendars: prose`Skipped: the calendar list could not be read.`,
    temp: prose`Skipped: the temporary calendar could not be created.`,
    created: prose`Skipped: the test event could not be created.`,
};

function prerequisiteMet(ctx: CheckContext, needs: CheckDef['needs']): boolean {
    switch (needs) {
        case undefined:
            return true;
        case 'home':
            return ctx.state.homeUrl !== undefined;
        case 'calendars':
            return ctx.state.calendars !== undefined;
        case 'temp':
            return ctx.state.primaryTemp !== undefined;
        case 'created':
            return ctx.state.created !== undefined;
    }
}

/** Runs one check; every failure becomes a recorded outcome with a fixed summary. */
export async function runCheck(def: CheckDef, ctx: CheckContext): Promise<CheckRecord> {
    const base = { id: def.id, planItem: def.planItem, claim: def.claim };
    if (ctx.http.credentialsRejected && def.offline !== true) {
        return { ...base, outcome: 'skipped', summary: REJECTED, evidence: {} };
    }
    if (!prerequisiteMet(ctx, def.needs)) {
        return { ...base, outcome: 'skipped', summary: NEEDS_MESSAGE[def.needs ?? 'home'], evidence: {} };
    }
    try {
        return { ...base, ...(await def.run(ctx)) };
    } catch (error) {
        if (error instanceof CheckStop) {
            return { ...base, outcome: error.outcome, summary: error.summary, evidence: error.evidence };
        }
        if (error instanceof ProbeHttpError) {
            return { ...base, outcome: 'inconclusive', summary: prose`A request was not completed (${fixed(error.code)}).`, evidence: { requestError: fixed(error.code) } };
        }
        return { ...base, outcome: 'error', summary: prose`The check failed with an unexpected internal error.`, evidence: {} };
    }
}

export function newState(): ProbeState {
    return {
        authStatus: null,
        addresses: [],
        rootDav: undefined,
        homeDav: undefined,
        schedulingProps: {},
        window: new Map(),
        windowLoaded: false,
        expanded: new Map(),
        temp: [],
        roundTrips: [],
        eventCounter: 0,
    };
}
