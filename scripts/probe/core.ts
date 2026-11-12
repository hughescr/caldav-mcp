import { attachmentCensusCheck, attachmentFetchCheck } from './checks/attachments';
import { authCheck, davCapabilitiesCheck, discoveryCheck, schedulingPropsCheck, stabilityCheck } from './checks/discovery';
import { backendCheck } from './checks/backend';
import { runCleanup } from './checks/cleanup';
import { collectionsCheck } from './checks/collections';
import { expandFormsCheck } from './checks/expand-forms';
import { bulkMultigetCheck, calendarDataVsGetCheck, etagExpandVsMultigetCheck, limitRecurrenceSetCheck } from './checks/fetch-forms';
import { pacingCheck } from './checks/pacing';
import { payloadSizesCheck } from './checks/payload';
import { strictnessCheck } from './checks/strictness';
import { etagCheck, expandReadCheck, freeBusyCheck, multigetCheck, textMatchReadCheck, timeRangeCheck, uidFilterCheck } from './checks/queries';
import { syncCheck, syncLimitCheck } from './checks/sync';
import { runWritePhase } from './checks/write-phase';
import { newState, runCheck, type CheckContext, type CheckDef, type CheckRecord } from './context';
import { DEFAULT_HTTP_LIMITS, ProbeHttp } from './http';
import { Taint, recheckNames, renderProse, scrubValue } from './safe';
import type { CheckResult, CleanupReport, Outcome, ProbeDeps, ProbeInput, ProbeLimits, ProbeReport } from './types';
import { PROBE_VERSION, REPORT_SCHEMA_VERSION } from './version';

export const DEFAULT_PROBE_LIMITS: ProbeLimits = { ...DEFAULT_HTTP_LIMITS, windowDays: 60, wideWindowDays: 1095, maxCalendarsQueried: 10 };

const READ_CHECKS: CheckDef[] = [
    davCapabilitiesCheck, schedulingPropsCheck, stabilityCheck, collectionsCheck, timeRangeCheck, freeBusyCheck, expandReadCheck,
    expandFormsCheck, etagExpandVsMultigetCheck, textMatchReadCheck, uidFilterCheck, multigetCheck, etagCheck, calendarDataVsGetCheck, limitRecurrenceSetCheck,
    bulkMultigetCheck, payloadSizesCheck, strictnessCheck, attachmentCensusCheck, attachmentFetchCheck, syncCheck, syncLimitCheck, backendCheck,
];

export class ProbeConfigError extends Error {
    constructor() {
        super('invalid_flags');
        this.name = 'ProbeConfigError';
    }
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** Runs every check for the given flags and returns a report that holds no personal data. */
export async function runProbe(input: ProbeInput, deps: ProbeDeps): Promise<ProbeReport> {
    const { flags } = input;
    if ((flags.invite && !flags.write) || (flags.cleanup && (flags.write || flags.invite))) {
        throw new ProbeConfigError();
    }
    const started = deps.now();
    const limits: ProbeLimits = { ...DEFAULT_PROBE_LIMITS, ...deps.limits };
    const taint = new Taint();
    taint.add(input.inviteAttendee);
    const http = new ProbeHttp({
        fetch: deps.fetch,
        now: deps.now,
        sleep: deps.sleep,
        auth: { appleId: input.appleId, appPassword: input.appPassword },
        mode: flags.cleanup ? 'cleanup' : flags.write ? 'write' : 'read',
        taint,
        limits,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        ...(deps.remainingMs === undefined ? {} : { remainingMs: deps.remainingMs }),
    });
    const ctx: CheckContext = {
        http,
        taint,
        now: deps.now,
        sleep: deps.sleep,
        randomHex: deps.randomHex,
        flags,
        credentials: { appleId: input.appleId, appPassword: input.appPassword },
        inviteAttendee: input.inviteAttendee,
        state: newState(),
        limits,
        loadBackend: deps.loadBackend ?? (async () => ({ status: 'absent' })),
    };

    const checks: CheckRecord[] = [];
    let cleanupReport: CleanupReport | null = null;
    checks.push(await runCheck(discoveryCheck, ctx));
    checks.push(await runCheck(authCheck, ctx));
    if (flags.cleanup) {
        const cleanup = await runCleanup(ctx, {
            ...(deps.confirmCleanup === undefined ? {} : { confirm: deps.confirmCleanup }),
            ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        });
        checks.push(cleanup.result);
        cleanupReport = cleanup.report;
    } else {
        for (const def of READ_CHECKS) {
            checks.push(await runCheck(def, ctx));
        }
        if (flags.write) {
            const phase = await runWritePhase(ctx);
            checks.push(...phase.results);
            const deleted = phase.tempCalendars.filter((t) => t.removalVerified).length;
            cleanupReport = {
                tempCalendars: phase.tempCalendars,
                notDeleted: phase.notDeleted,
                deleted,
                allRemoved: deleted === phase.tempCalendars.length && phase.notDeleted.length === 0,
            };
        }
        checks.push(await runCheck(pacingCheck, ctx));
    }

    const outcomes: Record<Outcome, number> = { confirmed: 0, refuted: 0, inconclusive: 0, skipped: 0, error: 0 };
    for (const c of checks) {
        outcomes[c.outcome]++;
    }
    const region = input.awsRegion ?? null;
    const report: ProbeReport = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        probeVersion: PROBE_VERSION,
        generatedAt: new Date(deps.now()).toISOString(),
        runLocation: input.runLocation,
        awsRegion: input.runLocation === 'lambda' && region !== null && REGION.test(region) ? region : null,
        mode: { readOnly: !flags.write && !flags.cleanup, write: flags.write, invite: flags.invite, cleanup: flags.cleanup },
        totals: { requests: http.stats().requests, durationMs: deps.now() - started, outcomes },
        cleanup: cleanupReport,
        auth: { rejected: http.credentialsRejected, onFirstRequest: http.rejectedOnFirstRequest },
        environment: { extraCaCertsSet: input.extraCaCertsSet === true },
        checks: [],
        redaction: { scrubbedOccurrences: 0 },
    };
    // First layer, late pass: names recorded early are re-checked against everything seen
    // by the end of the run. Then the second layer looks at the variable parts only (summary
    // slots, evidence values that are not probe vocabulary) and replaces a tainted one as a
    // whole. `id`, `planItem`, `claim`, the summaries' fixed text and evidence keys are code
    // constants and are never changed.
    let scrubbedOccurrences = 0;
    report.checks = checks.map((c): CheckResult => {
        const summary = renderProse(c.summary, taint);
        const evidence = scrubValue(recheckNames(c.evidence, taint), taint);
        scrubbedOccurrences += summary.count + evidence.count;
        return { id: c.id, planItem: c.planItem, claim: c.claim, outcome: c.outcome, summary: summary.text, evidence: evidence.value };
    });
    if (report.cleanup !== null) {
        const cleanup = scrubValue(report.cleanup, taint);
        scrubbedOccurrences += cleanup.count;
        report.cleanup = cleanup.value;
    }
    report.redaction.scrubbedOccurrences = scrubbedOccurrences;
    return report;
}
