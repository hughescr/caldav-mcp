import type { CheckDef, WindowResource } from '../context';
import { eventComponents } from '../dav';
import { comps, prop, props } from '../ical';
import { kindOf, type KindOrNone } from '../ical-time';
import { prose } from '../safe';
import type { Evidence } from '../types';
import { Failures, attempt, bump } from './census-helpers';
import { ensureExpanded, ensureWindow } from './queries';

const TZ_PROPS = ['DTSTART', 'DTEND', 'RECURRENCE-ID'] as const;

type Table = Record<string, number>;
interface Tables { dtstart: Table; recurrenceId: Table; dtend: Table }

/** Cells of a cross-tab whose two kinds differ. */
function changed(table: Table): number {
    return Object.entries(table).reduce((sum, [key, n]) => sum + (key.split('>')[0] === key.split('>')[1] ? 0 : n), 0);
}

export const expandFormsCheck: CheckDef = {
    id: 'expand-forms',
    planItem: 'What iCloud provides: Server-side recurrence expansion (the form of expanded values); Datetime rules: TZID, DATE and floating values',
    claim: 'Expanded instances keep the form of the original (UTC, TZID, DATE, floating) in DTSTART, DTEND and RECURRENCE-ID, every expanded TZID has a VTIMEZONE in the same resource, and no non-recurring resource gains a RECURRENCE-ID.',
    needs: 'calendars',
    async run(ctx) {
        await ensureWindow(ctx);
        const failures = new Failures();
        const recurring: Tables = { dtstart: {}, recurrenceId: {}, dtend: {} };
        const plain: Tables = { dtstart: {}, recurrenceId: {}, dtend: {} };
        let calendars = 0;
        let resources = 0;
        let matched = 0;
        let instances = 0;
        let withoutMaster = 0;
        let ambiguous = 0;
        let compared = 0;
        let incomplete = 0;
        let notExpanded = 0;
        let vtimezonesExpanded = 0;
        let vtimezonesOriginal = 0;
        let tzidWithoutVtimezone = 0;
        let resourcesMissingVtimezone = 0;
        let withDuration = 0;
        let withDtend = 0;
        let withBoth = 0;
        let withNeither = 0;
        let mastersWithDuration = 0;
        let badStatus = 0;
        for (const [href, original] of ctx.state.window) {
            if (original.status !== 207) {
                incomplete++;
                continue;
            }
            if (original.resources.length === 0) {
                continue;
            }
            const got = await attempt(() => ensureExpanded(ctx, href));
            if (!got.ok) {
                failures.record(got);
                if (got.stop) {
                    break;
                }
                continue;
            }
            if (got.value.status !== 207) {
                badStatus++;
                continue;
            }
            calendars++;
            const originals = new Map<string, WindowResource>(original.resources.map((r) => [r.href, r]));
            incomplete += original.resources.length - originals.size;
            incomplete += original.resources.filter((r) => !got.value.resources.some((e) => e.href === r.href)).length;
            incomplete += got.value.resources.length - new Set(got.value.resources.map((r) => r.href)).size;
            for (const expanded of got.value.resources) {
                resources++;
                const source = originals.get(expanded.href);
                if (source === undefined) {
                    notExpanded++;
                    continue;
                }
                matched++;
                const sourceEvents = eventComponents(source.ical);
                const byUid = Map.groupBy(sourceEvents, (e) => prop(e, 'UID')?.value ?? '');
                mastersWithDuration += sourceEvents.filter((e) => prop(e, 'RECURRENCE-ID') === undefined && prop(e, 'DURATION') !== undefined).length;
                const expandedEvents = eventComponents(expanded.ical);
                if (sourceEvents.length === 0 || expandedEvents.length === 0) {
                    incomplete++;
                }
                const returnedUids = new Set(expandedEvents.map((e) => prop(e, 'UID')?.value ?? ''));
                incomplete += [...byUid.keys()].filter((uid) => !returnedUids.has(uid)).length;
                const zones = expanded.ical === undefined ? [] : comps(expanded.ical, 'VTIMEZONE');
                const defined = new Set(zones.map((tz) => prop(tz, 'TZID')?.value ?? ''));
                vtimezonesOriginal += source.ical === undefined ? 0 : comps(source.ical, 'VTIMEZONE').length;
                vtimezonesExpanded += zones.length;
                let missing = 0;
                for (const event of eventComponents(expanded.ical)) {
                    instances++;
                    const uid = prop(event, 'UID')?.value ?? '';
                    const own = byUid.get(uid) ?? [];
                    const masters = own.filter((e) => prop(e, 'RECURRENCE-ID') === undefined);
                    const master = masters[0];
                    if (uid === '' || props(event, 'UID').length !== 1 || masters.length > 1 || own.some((e) => props(e, 'UID').length !== 1)) {
                        ambiguous++;
                    } else if (master === undefined) {
                        withoutMaster++;
                    } else {
                        compared++;
                        const tables = own.some((e) => prop(e, 'RRULE') !== undefined || prop(e, 'RDATE') !== undefined || prop(e, 'RECURRENCE-ID') !== undefined) ? recurring : plain;
                        const startKind: KindOrNone = kindOf(prop(master, 'DTSTART'));
                        bump(tables.dtstart, `${startKind}>${kindOf(prop(event, 'DTSTART'))}`);
                        bump(tables.recurrenceId, `${startKind}>${kindOf(prop(event, 'RECURRENCE-ID'))}`);
                        bump(tables.dtend, `${kindOf(prop(master, 'DTEND'))}>${kindOf(prop(event, 'DTEND'))}`);
                    }
                    const hasEnd = prop(event, 'DTEND') !== undefined;
                    const hasDuration = prop(event, 'DURATION') !== undefined;
                    withDuration += hasDuration && !hasEnd ? 1 : 0;
                    withDtend += hasEnd && !hasDuration ? 1 : 0;
                    withBoth += hasEnd && hasDuration ? 1 : 0;
                    withNeither += !hasEnd && !hasDuration ? 1 : 0;
                    for (const name of TZ_PROPS) {
                        missing += props(event, name).filter((p) => p.params.TZID !== undefined && !defined.has(p.params.TZID)).length;
                    }
                }
                tzidWithoutVtimezone += missing;
                resourcesMissingVtimezone += missing > 0 ? 1 : 0;
            }
        }
        // A RECURRENCE-ID should mirror the master's DTSTART in a recurring resource and be absent in a plain one.
        const plainRidMismatch = Object.entries(plain.recurrenceId).reduce((sum, [key, n]) => sum + (key.endsWith('>none') ? 0 : n), 0);
        const mismatches = changed(recurring.dtstart) + changed(recurring.recurrenceId) + changed(recurring.dtend) + changed(plain.dtstart) + changed(plain.dtend) + plainRidMismatch + tzidWithoutVtimezone;
        const evidence: Evidence = {
            calendarsExpanded: calendars,
            calendarsWithBadStatus: badStatus,
            expandedResources: resources,
            matchedToOriginal: matched,
            expandedWithoutOriginal: notExpanded,
            expandedInstances: instances,
            instancesWithoutOriginalMaster: withoutMaster,
            instancesWithAmbiguousMaster: ambiguous,
            instancesCompared: compared,
            incompleteResources: incomplete,
            recurringDtstart: recurring.dtstart,
            recurringRecurrenceId: recurring.recurrenceId,
            recurringDtend: recurring.dtend,
            nonrecurringDtstart: plain.dtstart,
            nonrecurringRecurrenceId: plain.recurrenceId,
            nonrecurringDtend: plain.dtend,
            vtimezoneComponentsOriginal: vtimezonesOriginal,
            vtimezoneComponentsExpanded: vtimezonesExpanded,
            expandedTzidWithoutVtimezone: tzidWithoutVtimezone,
            resourcesWithTzidWithoutVtimezone: resourcesMissingVtimezone,
            originalMastersWithDuration: mastersWithDuration,
            instancesWithDuration: withDuration,
            instancesWithDtend: withDtend,
            instancesWithBoth: withBoth,
            instancesWithNeither: withNeither,
            changedForms: mismatches,
            ...failures.evidence(),
        };
        if (failures.stopped) {
            return { outcome: 'inconclusive', summary: prose`The check was stopped after ${calendars} calendar(s); the counts so far are partial.`, evidence };
        }
        if (compared === 0) {
            return { outcome: 'inconclusive', summary: prose`No expanded instance could be compared with its original (${calendars} calendar(s) expanded).`, evidence };
        }
        if (mismatches > 0) {
            return { outcome: 'refuted', summary: prose`${mismatches} value(s) in ${instances} expanded instance(s) changed form or lack a VTIMEZONE.`, evidence };
        }
        if (withoutMaster + ambiguous + incomplete + notExpanded + badStatus + failures.count > 0) {
            return { outcome: 'inconclusive', summary: prose`Only ${compared} of ${instances} expanded instance(s) could be compared with complete coverage.`, evidence };
        }
        return { outcome: 'confirmed', summary: prose`All ${compared} expanded instance(s) kept their forms and every TZID has its VTIMEZONE.`, evidence };
    },
};
