import { runCheck, type CheckContext, type CheckDef, type CheckRecord } from '../context';
import type { NotDeletedReport, TempCalendarReport } from '../types';
import { inviteCheck } from './invite';
import { INVITE_STEPS, INVITE_STEP_CHECKS } from './invite-steps';
import { WRITE_3A_CHECKS, errorBodiesCheck } from './write-3a';
import { WRITE_3B_CHECKS } from './write-3b';
import { WRITE_3C_CHECKS, WRITE_3D_CHECKS } from './write-3cd';
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
    // Phase 3 (probe 0.6.0), after every older check so their counts do not change.
    ...WRITE_3A_CHECKS,
    ...WRITE_3B_CHECKS,
    ...WRITE_3C_CHECKS,
    ...WRITE_3D_CHECKS,
    // Last: it describes the refusal bodies of every write above.
    errorBodiesCheck,
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
            // In the order of INVITE_STEPS, only the selected ones (default: I1 alone).
            for (const step of INVITE_STEPS.filter((s) => ctx.invite.steps.includes(s))) {
                const def = step === 'I1' ? inviteCheck : INVITE_STEP_CHECKS.get(step);
                if (def !== undefined) {
                    results.push(await runCheck(def, ctx));
                }
            }
        }
    } finally {
        const removal = await removeTempCalendars(ctx);
        results.push(removal.result);
        notDeleted = removal.notDeleted;
    }
    return { results, tempCalendars: ctx.state.temp.map((t) => ({ name: t.name, removalVerified: t.removalVerified })), notDeleted };
}
