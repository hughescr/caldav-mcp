/**
 * P3A-10, read-only: the recurrence shapes in the owner's data, counted from the wide unexpanded
 * responses that `strictness-census` already fetched (no request of its own). Only counts under
 * fixed keys are recorded: how RRULEs end, the forms of EXDATE values and whether they come as
 * separate lines or comma lists, the form of each override's RECURRENCE-ID next to its master's
 * DTSTART form, RDATE/EXRULE presence, RELATED-TO RELTYPE classes and SEQUENCE presence. Never a
 * value, a TZID, a UID or a rule.
 */
import type { CheckDef } from '../context';
import { eventComponents } from '../dav';
import { prop, props, type IcalComponent } from '../ical';
import { kindOf } from '../ical-time';
import { prose } from '../safe';
import type { Evidence } from '../types';

export const RRULE_END_KEYS = ['rruleEndNone', 'rruleEndCount', 'rruleEndUntilUtc', 'rruleEndUntilDate', 'rruleEndUntilLocal', 'rruleEndCountAndUntil', 'rruleEndInvalid'] as const;
const RELTYPES: Record<string, string> = { PARENT: 'relatedToParent', CHILD: 'relatedToChild', SIBLING: 'relatedToSibling', 'X-CALENDARSERVER-RECURRENCE-SET': 'relatedToRecurrenceSet' };

function bump(tally: Record<string, number>, key: string): void {
    tally[key] = (tally[key] ?? 0) + 1;
}

function untilKey(value: string): string {
    if (/^\d{8}$/.test(value)) {
        return 'rruleEndUntilDate';
    }
    if (/^\d{8}T\d{6}Z$/i.test(value)) {
        return 'rruleEndUntilUtc';
    }
    return /^\d{8}T\d{6}$/.test(value) ? 'rruleEndUntilLocal' : 'rruleEndInvalid';
}

/** How one RRULE value ends: never, by COUNT, or by an UNTIL of a given form (keys of the tally). */
export function rruleEnd(rule: string): string {
    const parts = new Map(rule.split(';').map((part) => {
        const eq = part.indexOf('=');
        return [part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim()] as const;
    }));
    const count = parts.get('COUNT');
    const until = parts.get('UNTIL');
    if (count !== undefined && until !== undefined) {
        return 'rruleEndCountAndUntil';
    }
    if (count !== undefined) {
        return /^\d+$/.test(count) ? 'rruleEndCount' : 'rruleEndInvalid';
    }
    return until === undefined ? 'rruleEndNone' : untilKey(until);
}

/** Adds the recurrence shapes of one parsed resource to the tally. Reads values; keeps only counts. */
export function addRecurrenceShapes(tally: Record<string, number>, root: IcalComponent | undefined): void {
    const events = eventComponents(root);
    const byUid = Map.groupBy(events, (e) => prop(e, 'UID')?.value ?? '');
    for (const group of byUid.values()) {
        const master = group.find((e) => prop(e, 'RECURRENCE-ID') === undefined);
        const overrides = group.filter((e) => prop(e, 'RECURRENCE-ID') !== undefined);
        for (const event of group) {
            for (const related of props(event, 'RELATED-TO')) {
                bump(tally, RELTYPES[(related.params.RELTYPE ?? 'PARENT').toUpperCase()] ?? 'relatedToOther');
            }
        }
        if (master === undefined) {
            tally.overridesWithoutMaster = (tally.overridesWithoutMaster ?? 0) + overrides.length;
            continue;
        }
        bump(tally, prop(master, 'SEQUENCE') === undefined ? 'mastersWithoutSequence' : 'mastersWithSequence');
        const rules = props(master, 'RRULE');
        if (props(master, 'RDATE').length > 0) {
            bump(tally, 'mastersWithRdate');
        }
        if (props(master, 'EXRULE').length > 0) {
            bump(tally, 'mastersWithExrule');
        }
        if (rules.length === 0 && overrides.length === 0) {
            continue;
        }
        if (rules.length > 0) {
            bump(tally, 'recurringMasters');
            bump(tally, prop(master, 'SEQUENCE') === undefined ? 'recurringMastersWithoutSequence' : 'recurringMastersWithSequence');
        }
        if (rules.length > 1) {
            bump(tally, 'mastersWithSeveralRrules');
        }
        for (const rule of rules) {
            bump(tally, rruleEnd(rule.value));
        }
        const start = prop(master, 'DTSTART');
        const masterKind = kindOf(start);
        const exdates = props(master, 'EXDATE');
        if (exdates.length > 1) {
            bump(tally, 'mastersWithSeveralExdateLines');
        }
        for (const exdate of exdates) {
            const values = exdate.value.split(',');
            bump(tally, values.length > 1 ? 'exdateCommaLists' : 'exdateSingleValueLines');
            for (const value of values) {
                const kind = kindOf({ ...exdate, value: value.trim() });
                bump(tally, `exdate:${masterKind}>${kind}`);
                if (kind === 'tzid' && masterKind === 'tzid') {
                    bump(tally, exdate.params.TZID === start?.params.TZID ? 'exdateTzidSameAsMaster' : 'exdateTzidOtherThanMaster');
                }
            }
        }
        for (const override of overrides) {
            const rid = prop(override, 'RECURRENCE-ID');
            const ridKind = kindOf(rid);
            bump(tally, `overrideRid:${masterKind}>${ridKind}`);
            if (ridKind === 'tzid' && masterKind === 'tzid') {
                bump(tally, rid?.params.TZID === start?.params.TZID ? 'overrideRidTzidSameAsMaster' : 'overrideRidTzidOtherThanMaster');
            }
            if (Object.keys(rid?.params ?? {}).some((name) => name !== 'TZID' && name !== 'VALUE')) {
                bump(tally, 'overrideRidOtherParameters');
            }
            const moved = prop(override, 'DTSTART')?.value !== rid?.value || prop(override, 'DTSTART')?.params.TZID !== rid?.params.TZID;
            bump(tally, moved ? 'overridesMovedOrReformed' : 'overridesAtTheirSlot');
        }
    }
}

/** Override RECURRENCE-IDs and EXDATE values whose form differs from their master's DTSTART form. */
function formMismatches(tally: Record<string, number>): number {
    return Object.entries(tally).filter(([key]) => {
        const match = /^(?:overrideRid|exdate):([a-z]+)>([a-z]+)$/.exec(key);
        return match !== null && match[1] !== match[2];
    }).reduce((sum, [, n]) => sum + n, 0) + (tally.overrideRidTzidOtherThanMaster ?? 0) + (tally.exdateTzidOtherThanMaster ?? 0);
}

export const recurrenceCensusCheck: CheckDef = {
    id: 'census-recurrence-shapes',
    planItem: 'Phase 3 (P3A-10, informs 3b to 3d): recurrence shapes in real data',
    claim: 'In the wide unexpanded query, every override’s RECURRENCE-ID and every EXDATE value has its master’s DTSTART form (and the same TZID text), and no master has an RDATE or EXRULE.',
    needs: 'calendars',
    // It reads only what the strictness census already fetched.
    offline: true,
    async run(ctx) {
        const census = ctx.state.recurrenceCensus;
        if (census === undefined) {
            return { outcome: 'inconclusive', summary: prose`The strictness census did not run, so there is nothing to count.`, evidence: {} };
        }
        const mismatches = formMismatches(census.tally);
        const extra = (census.tally.mastersWithRdate ?? 0) + (census.tally.mastersWithExrule ?? 0);
        const recurring = census.tally.recurringMasters ?? 0;
        const evidence: Evidence = { coverageComplete: census.coverageComplete, formMismatches: mismatches, ...census.tally };
        if (mismatches > 0 || extra > 0) {
            return { outcome: 'refuted', summary: prose`${mismatches} value(s) differ from their master’s form, and ${extra} master(s) have an RDATE or EXRULE.`, evidence };
        }
        if (!census.coverageComplete || recurring === 0) {
            return { outcome: 'inconclusive', summary: prose`${recurring} recurring master(s) were counted, without complete coverage of every calendar.`, evidence };
        }
        return { outcome: 'confirmed', summary: prose`All overrides and EXDATEs of ${recurring} recurring master(s) use their master’s form; no RDATE or EXRULE.`, evidence };
    },
};
