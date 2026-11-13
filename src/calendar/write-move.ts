/**
 * A whole-series move or rule change (`update_event`, `edit_scope: "all"` with `start`/`end` or `recurrence`; phase 3
 * design v2 section 3.6, ORCH-R; probe P3D-1..3, all confirmed). Plans ONE edit pass; write.ts sends it.
 *
 * - The master's DTSTART and DTEND become the agent's values (DURATION removed); `recurrence` replaces the RRULE, or with
 *   `null` removes it (the series becomes a single event). A kept RRULE whose UNTIL no longer fits the new start's form is
 *   `invalid_input` (`rrule_until_form`): the agent sends a new rule.
 * - Exceptions (overrides and EXDATEs) make the agent choose `exceptions` (`exceptions_choice_required`, with counts):
 *   `drop` removes every override and every EXDATE line and lists what it removed (P3D-3: no orphan); `shift` moves every
 *   override's RECURRENCE-ID and every EXDATE value by the same UTC delta, and the times of an override that sat at its own
 *   slot, keeping a moved override's own times (P3D-2) — only when the old start, the new start and every shifted value are
 *   UTC instants (ORCH-R: "only if both old and new values are UTC-computable instants"; zone-free arithmetic on UTC only;
 *   DATE and floating series are refused here although P3D-2 measured a DATE shift, because the arbitration and the build
 *   brief allow UTC only; `exceptions_shift_not_utc`), never with a rule change (`exceptions_shift_with_rule_change`), and only
 *   when the stored rule provably moves with its start: FREQ SECONDLY to WEEKLY with no part but INTERVAL, COUNT and WKST
 *   (no BY* part, no UNTIL; `exceptions_shift_rule_not_supported`: use drop and re-apply the listed exceptions).
 *   There is no "keep": an override whose RECURRENCE-ID no longer matches an instance is hidden by iCloud (P3C-4).
 * - The other requested fields apply to the master and to every kept override, as for `all` without a move.
 * - RDATE (`rdate_present`) and EXRULE (`exrule_present`) series are refused: their values would need moving too.
 */
import { describeEvents, type ComponentEdit, type ComponentPlan, type ComponentSelector, type ResourceEdit } from './ics-edit';
import type { EditExpectation, ExpectedValue, PropertyExpectation, TargetExpectation } from './ics-verify';
import { exdateListProperty, parseRrule, rruleProperty, sequenceProperty, timeProperty, type IcsTime, type StartForm, type WrittenProperty } from './ics-write';
import type { EventComponent, OriginalResource, StoredTime } from './model';
import { sanitizeDisplayText } from './normalize';
import { exdateValues, sameSlot, shiftUtc, slotOf, utcDelta } from './occurrence-target';
import { toEventTime } from './time-core';
import type { FieldLine, StoredExpectation } from './write-compare';
import {
    builderError, componentRequest, expectedValue, nextSequence, notSupported, parseWork, stampExpectations, unsupported, type ChangePlan, type ResultContext, type Stamp, type WriteDeps,
} from './write-core';
import { MAX_LISTED_EXCEPTIONS, type WriteEventResult } from './write-schemas';

export interface SeriesMovePlan {
    plans: ComponentPlan[];
    resource: ResourceEdit[];
    expectation: EditExpectation;
    /** For the read-back and for "desired state present". */
    stored: StoredExpectation;
    fields: ResultContext['fields'];
    /**
     * False when a stale version cannot be judged: re-planning a shift on a resource that may already be shifted would shift
     * again, so the call reports calendar_changed instead of guessing.
     */
    staleProvable: boolean;
}

/** UNTIL forms per start kind: DATE, floating, or UTC (for UTC and zoned starts). */
const untilGroup = (kind: StartForm): string => (kind === 'utc' || kind === 'zoned' ? 'utc' : kind);

const ruleText = (line: string): string | null => (/^RRULE:/iu.test(line) ? line.slice(6) : null);

/**
 * The bounded inventory of dropped exceptions (a series move's `drop`, a split's dropped exceptions from the split on):
 * complete counts, at most {@link MAX_LISTED_EXCEPTIONS} of each kind listed by value. Deleted occurrences are EXDATE
 * VALUES (a line can hold several), never lines.
 */
export function droppedExceptions(overrides: readonly EventComponent[], exdates: readonly StoredTime[]): NonNullable<WriteEventResult['exceptions_dropped']> {
    const changed = overrides.slice(0, MAX_LISTED_EXCEPTIONS).flatMap(override => {
        if (override.recurrenceId === null) { return []; }
        const summary = override.properties.get('summary')?.[0]?.values[0];
        return [{ original_start: toEventTime(override.recurrenceId.time), start: toEventTime(override.start), title: typeof summary === 'string' ? sanitizeDisplayText(summary, 256).text : null }];
    });
    const truncated = overrides.length > MAX_LISTED_EXCEPTIONS || exdates.length > MAX_LISTED_EXCEPTIONS;
    return {
        changed_occurrences: overrides.length, deleted_occurrences: exdates.length, changed,
        deleted: exdates.slice(0, MAX_LISTED_EXCEPTIONS).map(toEventTime), ...(truncated ? { truncated: true as const } : {}),
    };
}

/** Plans the move. Throws WriteError (invalid_input, edit_not_supported, unsupported_calendar_data). */
export function planSeriesMove(input: { deps: WriteDeps; original: OriginalResource; text: string; plan: ChangePlan; stamp: Stamp; exceptions: 'drop' | 'shift' | undefined }): SeriesMovePlan {
    const { deps, original, text, plan, stamp } = input;
    const master = original.master;
    if (master === null) { throw notSupported('occurrence_only_resource'); }
    if (master.properties.has('rdate')) { throw notSupported('rdate_present'); }
    if (master.properties.has('exrule')) { throw notSupported('exrule_present'); }
    let outlines: ReturnType<typeof describeEvents>;
    try { outlines = describeEvents(text, { work: parseWork(deps) }); } catch (error) { throw builderError(error); }
    const masterOutline = outlines.find(outline => outline.recurrenceId === null);
    const overrideOutlines = outlines.filter(outline => outline.recurrenceId !== null);
    if (masterOutline === undefined || overrideOutlines.length !== original.overrides.length) { throw unsupported('stored_data_not_editable'); }

    const span = plan.span;
    const newForm: StartForm = span?.start.kind ?? master.start.kind;
    const oldStart = slotOf(master.start);
    const timeChange = span !== undefined && !(sameSlot(span.start, oldStart) && master.end !== null && sameSlot(span.end, slotOf(master.end)));
    const ruleChange = plan.recurrence !== undefined;

    // The rule: replaced, removed, or kept (and then its UNTIL must fit the new start's form).
    let rrule: WrittenProperty | null = null;
    if (plan.recurrence !== undefined && plan.recurrence !== null) {
        try { rrule = rruleProperty(plan.recurrence.rrule, newForm, 'rrule'); } catch (error) { throw builderError(error); }
    } else if (plan.recurrence === undefined && untilGroup(newForm) !== untilGroup(master.start.kind)) {
        const lines = masterOutline.properties.filter(line => line.name === 'rrule').map(line => ruleText(line.text));
        const stored = lines[0];
        if (lines.length !== 1 || stored === null || stored === undefined) { throw notSupported('rrule_not_editable'); }
        try {
            parseRrule(stored, newForm, 'rrule');
        } catch (error) {
            const mapped = builderError(error);
            throw mapped.extra.reason === 'rrule_until_form' ? mapped : notSupported('rrule_not_editable');
        }
    }

    const exdates = exdateValues(master);
    if (exdates === null) { throw unsupported('stored_data_not_editable'); }
    const exdateLines = master.properties.get('exdate') ?? [];
    const counts = { changed_occurrences: original.overrides.length, deleted_occurrences: exdates.length };
    const hasExceptions = original.overrides.length > 0 || exdateLines.length > 0;
    const moving = timeChange || ruleChange;
    // "drop" always drops what is there (so a repeated call proves "no exceptions" by text); "shift" only matters for a move.
    let mode: 'none' | 'drop' | 'shift' = input.exceptions === 'drop' && hasExceptions ? 'drop' : 'none';
    if (moving && hasExceptions) {
        if (input.exceptions === undefined) { throw notSupported('exceptions_choice_required', { exceptions: counts }); }
        mode = input.exceptions;
    }
    // A series that stops repeating keeps no occurrence exceptions.
    if (plan.recurrence === null && hasExceptions && mode !== 'drop') { throw notSupported(mode === 'shift' ? 'exceptions_shift_with_rule_change' : 'exceptions_choice_required', { exceptions: counts }); }
    if (mode === 'shift' && ruleChange) { throw notSupported('exceptions_shift_with_rule_change'); }

    let delta = 0n;
    if (mode === 'shift') {
        const found = span === undefined ? null : utcDelta(oldStart, span.start);
        const allUtc = found !== null
            && exdates.every(value => value.kind === 'utc')
            && original.overrides.every(override => override.recurrenceId?.time.kind === 'utc' && (!atSlot(override) || override.start.kind === 'utc') && (!atSlot(override) || override.end === null || override.end.kind === 'utc'));
        if (!allUtc || found === null) { throw notSupported('exceptions_shift_not_utc'); }
        if (!shiftInvariant(masterOutline, master)) { throw notSupported('exceptions_shift_rule_not_supported'); }
        delta = found;
    }
    const shift = (time: IcsTime): IcsTime => {
        if (time.kind !== 'utc') { throw notSupported('exceptions_shift_not_utc'); }
        const moved = shiftUtc(time.utc, delta);
        if (moved === null) { throw notSupported('exceptions_shift_not_utc'); }
        return { kind: 'utc', utc: moved };
    };

    const plans: ComponentPlan[] = [];
    const targets: TargetExpectation[] = [];
    const resource: ResourceEdit[] = [];
    const requests: ReturnType<typeof componentRequest>[] = [];
    const stampEdits = (): ComponentEdit[] => [
        { op: 'set', property: timeProperty('DTSTAMP', { kind: 'utc', utc: stamp.basic }) },
        { op: 'set', property: timeProperty('LAST-MODIFIED', { kind: 'utc', utc: stamp.basic }) },
    ];
    try {
        const fieldEdits: ComponentEdit[] = plan.fields.map(field => (field.property === null ? { op: 'remove', name: field.name } : { op: 'set', property: field.property }));
        const fieldExpectations: PropertyExpectation[] = plan.fields.map(field => field.expected);
        const alarmEdits: ComponentEdit[] = plan.alarms === undefined ? [] : [{ op: 'remove_alarms' }, ...(plan.alarms?.components ?? []).map(alarm => ({ op: 'add_alarm' as const, alarm }))];
        const alarms = plan.alarms === undefined ? {} : { alarms: plan.alarms === null ? { kind: 'removed' as const } : { kind: 'replaced' as const, alarms: plan.alarms.expected } };

        // The master.
        const masterSequence = nextSequence(master);
        const masterEdits: ComponentEdit[] = [...fieldEdits, ...alarmEdits];
        const masterProperties: PropertyExpectation[] = [...fieldExpectations];
        for (const time of plan.times) {
            if (time.property !== null) { masterEdits.push({ op: 'set', property: time.property }); }
            masterProperties.push(time.expected);
        }
        if (span !== undefined) {
            masterEdits.push({ op: 'remove', name: 'DURATION' });
            masterProperties.push({ name: 'DURATION', absent: true });
        }
        if (rrule !== null) { masterEdits.push({ op: 'set', property: rrule }); }
        if (plan.recurrence === null) { masterEdits.push({ op: 'remove', name: 'RRULE' }); }
        const masterExtra: FieldLine[] = [];
        if (rrule !== null) { masterExtra.push({ field: 'recurrence', name: 'RRULE', line: rrule.line }); }
        if (plan.recurrence === null) { masterExtra.push({ field: 'recurrence', name: 'RRULE', line: null }); }
        let exdateExpectation: TargetExpectation['exdates'];
        if (mode === 'drop' && exdateLines.length > 0) {
            masterEdits.push({ op: 'remove_all', name: 'EXDATE' });
            exdateExpectation = { kind: 'removed_all' };
            masterExtra.push({ field: 'recurrence', name: 'EXDATE', line: null });
        }
        if (mode === 'shift' && exdateLines.length > 0) {
            masterEdits.push({ op: 'remove_all', name: 'EXDATE' });
            const lines: ExpectedValue[] = [];
            const written: string[] = [];
            for (const property of exdateLines) {
                const values = property.values.map(value => shift({ kind: 'utc', utc: typeof value === 'string' ? value.replaceAll(/[-:]/gu, '') : '' }));
                const line = exdateListProperty(values);
                masterEdits.push({ op: 'add', property: line });
                written.push(line.line);
                lines.push({ type: 'date-time', values: values.map(value => expectedValue(value).values[0] ?? '') });
            }
            exdateExpectation = { kind: 'replaced', lines };
            masterExtra.push({ field: 'recurrence', name: 'EXDATE', line: null, lines: written });
        }
        masterEdits.push(...stampEdits(), { op: 'set', property: sequenceProperty(masterSequence) });
        plans.push({ target: { kind: 'master' }, edits: masterEdits });
        targets.push({
            component: { kind: 'master' }, properties: [...masterProperties, ...stampExpectations(stamp, masterSequence)], companionsRemoved: plan.companions, ...alarms,
            ...(rrule !== null && plan.recurrence !== undefined && plan.recurrence !== null ? { rrule: plan.recurrence.rrule } : {}), ...(plan.recurrence === null ? { rrule: null } : {}),
            ...(exdateExpectation === undefined ? {} : { exdates: exdateExpectation }),
        });
        requests.push(componentRequest(null, plan, masterExtra));

        // The overrides: removed, shifted, or kept with the other requested fields.
        for (const [index, override] of original.overrides.entries()) {
            const rid = overrideOutlines[index]?.recurrenceId;
            if (rid === null || rid === undefined || override.recurrenceId === null) { throw unsupported('stored_data_not_editable'); }
            const selector: ComponentSelector = { kind: 'override', recurrenceId: rid };
            if (mode === 'drop') {
                resource.push({ op: 'remove_component', target: selector });
                continue;
            }
            const sequence = nextSequence(override);
            const edits: ComponentEdit[] = [...fieldEdits, ...alarmEdits];
            const properties: PropertyExpectation[] = [...fieldExpectations];
            const extra: FieldLine[] = [];
            let ridLine = rid;
            let newRid: ExpectedValue | undefined;
            if (mode === 'shift') {
                const slot = shift(slotOf(override.recurrenceId.time));
                const property = timeProperty('RECURRENCE-ID', slot);
                edits.push({ op: 'replace_recurrence_id', property });
                newRid = expectedValue(slot);
                ridLine = property.line;
                if (atSlot(override)) {
                    const start = timeProperty('DTSTART', shift(slotOf(override.start)));
                    edits.push({ op: 'set', property: start });
                    properties.push({ name: 'DTSTART', ...expectedValue(shift(slotOf(override.start))) });
                    extra.push({ field: 'start', name: 'DTSTART', line: start.line });
                    if (override.end !== null) {
                        const end = timeProperty('DTEND', shift(slotOf(override.end)));
                        edits.push({ op: 'set', property: end });
                        properties.push({ name: 'DTEND', ...expectedValue(shift(slotOf(override.end))) });
                        extra.push({ field: 'end', name: 'DTEND', line: end.line });
                    }
                }
            }
            edits.push(...stampEdits(), { op: 'set', property: sequenceProperty(sequence) });
            plans.push({ target: selector, edits });
            targets.push({ component: selector, properties: [...properties, ...stampExpectations(stamp, sequence)], companionsRemoved: plan.companions, ...alarms, ...(newRid === undefined ? {} : { recurrenceId: newRid }) });
            requests.push(componentRequest(ridLine, plan, extra, false));
        }
    } catch (error) {
        throw builderError(error);
    }

    const fields: ResultContext['fields'] = mode === 'drop' ? { exceptions_dropped: droppedExceptions(original.overrides, exdates) }
        : mode === 'shift' ? { exceptions_shifted: counts, overrides_changed: original.overrides.length }
        : original.overrides.length > 0 ? { overrides_changed: original.overrides.length } : {};
    const expectation: EditExpectation = {
        targets,
        ...(mode === 'drop' && original.overrides.length > 0 ? { removeOverrides: overrideOutlines.map(outline => ({ recurrenceId: outline.recurrenceId ?? '' })) } : {}),
    };
    return {
        plans, resource, expectation,
        stored: { kind: 'components', requests, exclusive: mode === 'drop' },
        fields,
        // Exceptions that a shift would move (again) cannot be judged on another version: calendar_changed, never a guess.
        staleProvable: !(input.exceptions === 'shift' && hasExceptions),
    };
}

const SHIFT_FREQUENCIES: ReadonlySet<string> = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY']);
const SHIFT_PARTS: ReadonlySet<string> = new Set(['FREQ', 'INTERVAL', 'COUNT', 'WKST']);

/**
 * Whether moving the start moves every occurrence by the same UTC difference, proven from the rule's text alone (ORCH ruling
 * on review finding 2): exactly one stored RRULE, FREQ up to WEEKLY, and no part but INTERVAL, COUNT and WKST (no BY* part,
 * no UNTIL). Then each occurrence is the start plus a whole multiple of a fixed period, so shifted exceptions stay
 * occurrences. Anything else (a MONTHLY rule on the 30th moved to the 31st, a BYDAY list, an UNTIL that cuts the shifted
 * series) could leave a shifted override or EXDATE on no occurrence, so it is refused.
 */
function shiftInvariant(outline: ReturnType<typeof describeEvents>[number], master: EventComponent): boolean {
    const lines = outline.properties.filter(line => line.name === 'rrule').map(line => ruleText(line.text));
    const text = lines[0];
    if (lines.length !== 1 || text === null || text === undefined) { return false; }
    let parts: readonly { key: string; value: string }[];
    try { parts = parseRrule(text, master.start.kind, 'rrule').parts; } catch { return false; }
    const freq = parts.find(part => part.key === 'FREQ')?.value;
    return freq !== undefined && SHIFT_FREQUENCIES.has(freq) && parts.every(part => SHIFT_PARTS.has(part.key));
}

/** An override that sits at its own slot: its DTSTART is its RECURRENCE-ID, same form and text (it was not moved). */
function atSlot(override: EventComponent): boolean {
    return override.recurrenceId !== null && sameSlot(slotOf(override.start), slotOf(override.recurrenceId.time));
}
