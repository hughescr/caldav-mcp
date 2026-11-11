import type { EvidenceValue, NotDeletedReason, Outcome, ProbeReport } from './types';

const STRICT_NAME = /^caldav-mcp-probe-[0-9a-f]{8}$/;
const BY_HAND = 'delete it by hand in Calendar (Calendar.app or icloud.com/calendar)';

const REASON_TEXT: Record<NotDeletedReason, string> = {
    url_not_probe_pattern: `found, not deleted: it is not at a caldav-mcp-probe- address, so --cleanup will not remove it; if it is a probe leftover, ${BY_HAND}`,
    server_chosen_url: `still present at an address the server chose: --cleanup will not remove it; ${BY_HAND}`,
    still_listed: 'still listed after deletion: run bun run probe -- --cleanup, or delete it by hand in Calendar',
    not_confirmed: 'found, not deleted: deletion was not confirmed (run --cleanup again and type delete)',
    not_calendar: `found, not deleted: it is not a calendar; ${BY_HAND} if it is yours to remove`,
    shared: `found, not deleted: it is shared; ${BY_HAND} if it is yours to remove`,
    subscribed: `found, not deleted: it is a subscription; ${BY_HAND} if it is yours to remove`,
    sharing_property: `found, not deleted: it carries sharing information; ${BY_HAND} if it is yours to remove`,
    not_owned: `found, not deleted: another account owns it; ${BY_HAND} if it is yours to remove`,
    foreign_resource: `found, not deleted: it holds something the probe did not write; ${BY_HAND} if it is yours to remove`,
    contents_unreadable: `found, not deleted: its contents could not be checked; ${BY_HAND} if it is yours to remove`,
    too_many_resources: `found, not deleted: it holds more items than the probe ever writes; ${BY_HAND} if it is yours to remove`,
    registration_refused: `found, not deleted: the safety check refused it; ${BY_HAND} if it is yours to remove`,
};

function shownName(name: string): string {
    return STRICT_NAME.test(name) ? name : 'caldav-mcp-probe-<non-standard>';
}

const AUTH_FIRST = 'Authentication failed (HTTP 401) on the first request, so nothing else was sent. Check the Apple ID and the app-specific password. Do not retry repeatedly: each attempt with a wrong password counts as a failed sign-in, and repeated failures can lock the Apple ID.';
const AUTH_LATER = 'The server stopped accepting the credentials (HTTP 401) during the run, so nothing further was sent apart from at most one attempt to delete each temporary calendar. Check the Apple ID and the app-specific password (it may have been revoked). Do not retry repeatedly.';

/** The fixed message for a run that a 401 stopped, or undefined. */
export function authMessage(report: ProbeReport): string | undefined {
    if (!report.auth.rejected) {
        return undefined;
    }
    return report.auth.onFirstRequest ? AUTH_FIRST : AUTH_LATER;
}

const LABEL: Record<Outcome, string> = {
    confirmed: 'CONFIRMED',
    refuted: 'REFUTED',
    inconclusive: 'INCONCLUSIVE',
    skipped: 'SKIPPED',
    error: 'ERROR',
};

function renderValue(value: EvidenceValue): string {
    if (value === null || typeof value !== 'object') {
        return String(value);
    }
    return JSON.stringify(value);
}

/** Lines warning about probe calendars that remain or could not be verified as removed. */
export function cleanupWarning(report: ProbeReport): string[] {
    const cleanup = report.cleanup;
    if (cleanup === null) {
        return [];
    }
    const explained = new Set(cleanup.notDeleted.map((n) => n.name));
    const unverified = cleanup.tempCalendars.filter((t) => !t.removalVerified && !explained.has(t.name));
    if (unverified.length === 0 && cleanup.notDeleted.length === 0) {
        return [];
    }
    return [
        report.mode.cleanup ? '!!! PROBE CALENDAR NOT REMOVED !!!' : '!!! TEMPORARY CALENDAR NOT REMOVED (removal could not be verified) !!!',
        ...unverified.map((t) => `!!!   ${shownName(t.name)}: removal not verified; run bun run probe -- --cleanup, or ${BY_HAND}`),
        ...cleanup.notDeleted.map((n) => `!!!   ${shownName(n.name)}: ${REASON_TEXT[n.reason]}`),
        `!!! ${cleanup.deleted} deleted and verified gone; ${unverified.length} not verified; ${cleanup.notDeleted.length} found but not deleted.`,
    ];
}

export function formatText(report: ProbeReport): string {
    const mode = report.mode.cleanup ? 'cleanup' : report.mode.invite ? 'write + invite' : report.mode.write ? 'write' : 'read-only';
    const o = report.totals.outcomes;
    const lines: string[] = [
        'caldav-mcp probe report',
        `  probe ${report.probeVersion}, schema ${report.schemaVersion}, generated ${report.generatedAt}`,
        `  run location: ${report.runLocation}${report.awsRegion === null ? '' : ` (${report.awsRegion})`}`,
        `  mode: ${mode}; requests: ${report.totals.requests}; duration: ${(report.totals.durationMs / 1000).toFixed(1)} s`,
        `  outcomes: ${o.confirmed} confirmed, ${o.refuted} refuted, ${o.inconclusive} inconclusive, ${o.skipped} skipped, ${o.error} error`,
        '',
    ];
    const warning = cleanupWarning(report);
    if (warning.length > 0) {
        lines.push(...warning, '');
    }
    for (const check of report.checks) {
        lines.push(`${LABEL[check.outcome].padEnd(13)} ${check.id}`);
        lines.push(`    plan:     ${check.planItem}`);
        lines.push(`    claim:    ${check.claim}`);
        lines.push(`    result:   ${check.summary}`);
        const entries = Object.entries(check.evidence);
        if (entries.length > 0) {
            lines.push(`    evidence: ${entries.map(([key, value]) => `${key}=${renderValue(value)}`).join('; ')}`);
        }
        lines.push('');
    }
    const auth = authMessage(report);
    if (auth !== undefined) {
        lines.push(`!!! ${auth}`, '');
    }
    if (report.cleanup !== null) {
        for (const temp of report.cleanup.tempCalendars) {
            lines.push(`${report.mode.cleanup ? 'Probe calendar' : 'Temporary calendar'} ${shownName(temp.name)}: ${temp.removalVerified ? 'removed (verified)' : 'NOT VERIFIED AS REMOVED'}`);
        }
        for (const entry of report.cleanup.notDeleted) {
            lines.push(`Probe calendar ${shownName(entry.name)}: NOT DELETED (${entry.reason})`);
        }
        lines.push(`Cleanup: ${report.cleanup.deleted} deleted and verified gone, ${report.cleanup.notDeleted.length} found but not deleted.`, '');
    }
    if (warning.length > 0) {
        lines.push(...warning, '');
    }
    if (report.checks.some((c) => c.id === 'write-invite' && c.outcome !== 'skipped')) {
        lines.push('Invite test: confirm by hand whether the invitation (and a cancellation) email arrived at the recipient.', '');
    }
    lines.push(
        'This report is designed to be safe to share: it holds no Apple ID, password, account numbers, calendar',
        'names, event text, ETags or sync tokens; hrefs appear only as shapes such as /<id>/calendars/<id>/.',
        `Values removed by the second redaction layer: ${report.redaction.scrubbedOccurrences}.`,
    );
    return `${lines.join('\n')}\n`;
}
