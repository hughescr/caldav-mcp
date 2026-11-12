import { runCheck, type CheckContext, type CheckDef, type CheckRecord } from '../context';
import type { NotDeletedReport, TempCalendarReport } from '../types';
import { inviteCheck } from './invite';
import { rewritesCheck, roundTripChecks } from './roundtrip';
import { ATTACHMENT_WRITE_CHECKS } from './write-attachments';
import { DST_WRITE_CHECKS } from './write-dst';
import { EXPANSION_WRITE_CHECKS } from './write-expansion';
import { movedOverrideInSpanCheck, movedOverridesCheck } from './write-moved';
import {
    createCheck, duplicateUidCheck, expandWriteCheck, ifMatchExactCheck, ifMatchStaleCheck, ifMatchStarCheck, mkcalendarCheck,
    noEndCheck, syncLimitWriteCheck, syncWriteCheck, textMatchWriteCheck, timeRangeWriteCheck,
} from './write';
import { removeTempCalendars } from './write-helpers';

const WRITE_CHECKS: CheckDef[] = [
    createCheck, ifMatchExactCheck, ifMatchStaleCheck, ifMatchStarCheck, noEndCheck, duplicateUidCheck,
    ...roundTripChecks, rewritesCheck, expandWriteCheck, textMatchWriteCheck, timeRangeWriteCheck, syncWriteCheck, syncLimitWriteCheck,
    // Last: their events must not change the counts the earlier checks make.
    ...EXPANSION_WRITE_CHECKS,
    movedOverridesCheck, movedOverrideInSpanCheck,
    ...DST_WRITE_CHECKS,
    ...ATTACHMENT_WRITE_CHECKS,
];

/**
 * All writes happen inside calendars the probe creates; they are removed in `finally`,
 * with requests that are exempt from the cap reserve, the deadline and interruption
 * (and, after a 401, limited to one DELETE per calendar).
 */
export async function runWritePhase(ctx: CheckContext): Promise<{ results: CheckRecord[]; tempCalendars: TempCalendarReport[]; notDeleted: NotDeletedReport[] }> {
    const results: CheckRecord[] = [];
    let notDeleted: NotDeletedReport[] = [];
    try {
        results.push(await runCheck(mkcalendarCheck, ctx));
        for (const def of WRITE_CHECKS) {
            results.push(await runCheck(def, ctx));
        }
        if (ctx.flags.invite) {
            results.push(await runCheck(inviteCheck, ctx));
        }
    } finally {
        const removal = await removeTempCalendars(ctx);
        results.push(removal.result);
        notDeleted = removal.notDeleted;
    }
    return { results, tempCalendars: ctx.state.temp.map((t) => ({ name: t.name, removalVerified: t.removalVerified })), notDeleted };
}
