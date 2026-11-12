import type { HttpLimits } from './http';
import type { AuthoredValue, EtagShape, Safe, TokenShape } from './safe';
import type { NOT_DELETED_REASONS } from './vocabulary';

export type Outcome = 'confirmed' | 'refuted' | 'inconclusive' | 'skipped' | 'error';

type Scalar = number | boolean | null | Safe | AuthoredValue;
/** AuthoredValue carries construction-time provenance until the report's final rendering. */
export type EvidenceValue = Scalar | readonly (Safe | AuthoredValue)[] | EtagShape | TokenShape | { readonly [key: string]: Scalar };
export type Evidence = Record<string, EvidenceValue>;

export interface CheckResult {
    id: string;
    /** The docs/plan.md item this check confirms or refutes. */
    planItem: string;
    /** The exact statement that `outcome` refers to. */
    claim: string;
    outcome: Outcome;
    summary: string;
    evidence: Evidence;
}

export interface ProbeFlags {
    write: boolean;
    invite: boolean;
    cleanup: boolean;
}

export type RunLocation = 'local' | 'lambda';

export interface ProbeInput {
    appleId: string;
    appPassword: string;
    flags: ProbeFlags;
    inviteAttendee?: string;
    runLocation: RunLocation;
    awsRegion?: string | null;
    /** NODE_EXTRA_CA_CERTS was set where the probe ran (recorded; the CLI also warns). */
    extraCaCertsSet?: boolean;
}

/** What the cleanup confirmation is shown: only names of the probe's exact form. */
export interface CleanupCandidates {
    names: string[];
}

export type BackendLoad =
    | { status: 'absent' }
    | { status: 'import_failed' }
    | { status: 'loaded'; module: Record<string, unknown> };

export interface ProbeLimits extends HttpLimits {
    windowDays: number;
    /** Half-width in days of the wide unexpanded query of the strictness census. */
    wideWindowDays: number;
    maxCalendarsQueried: number;
}

export interface ProbeDeps {
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    now(): number;
    sleep(ms: number): Promise<void>;
    randomHex(bytes: number): string;
    remainingMs?: () => number;
    signal?: AbortSignal;
    loadBackend?: () => Promise<BackendLoad>;
    limits?: Partial<ProbeLimits>;
    /**
     * `--cleanup` only: asked once with the deletion candidates; nothing is deleted unless it
     * resolves true. Absent means "not confirmed".
     */
    confirmCleanup?: (candidates: CleanupCandidates) => Promise<boolean>;
}

export interface TempCalendarReport {
    /** The probe's own synthetic display name, e.g. caldav-mcp-probe-0a1b2c3d. */
    name: string;
    removalVerified: boolean;
}

/**
 * Why a calendar with a probe-style name was found but not deleted.
 * --cleanup: url_not_probe_pattern, not_calendar, shared, subscribed, sharing_property, not_owned,
 * foreign_resource, contents_unreadable, too_many_resources, not_confirmed, registration_refused.
 * --write: still_listed (at a probe address), server_chosen_url (elsewhere).
 */
export type NotDeletedReason = (typeof NOT_DELETED_REASONS)[number];

export interface NotDeletedReport {
    /** Always of the exact form caldav-mcp-probe-<8 hex digits>. */
    name: string;
    reason: NotDeletedReason;
    /** True when a later `--cleanup` run can remove it; false means delete it by hand in Calendar. */
    cleanupCanRemove: boolean;
}

export interface CleanupReport {
    /** Calendars the probe deleted or tried to delete, each with the verification result. */
    tempCalendars: TempCalendarReport[];
    /** Calendars with a probe-style name that were found and not deleted. */
    notDeleted: NotDeletedReport[];
    /** How many calendars were deleted and verified gone. */
    deleted: number;
    /** True only when every entry in tempCalendars was verified gone and notDeleted is empty. */
    allRemoved: boolean;
}

export interface ProbeReport {
    schemaVersion: number;
    probeVersion: string;
    generatedAt: string;
    runLocation: RunLocation;
    awsRegion: string | null;
    mode: { readOnly: boolean; write: boolean; invite: boolean; cleanup: boolean };
    totals: { requests: number; durationMs: number; outcomes: Record<Outcome, number> };
    cleanup: CleanupReport | null;
    /** A 401 latches the run: nothing further is sent apart from bounded cleanup. */
    auth: { rejected: boolean; onFirstRequest: boolean };
    environment: { extraCaCertsSet: boolean };
    checks: CheckResult[];
    redaction: { scrubbedOccurrences: number };
}
