/**
 * `update_event` with `edit_scope: "this_and_future"`: a split (phase 3 design v2 section 3.5, ORCH-R, arbitration B1/B2;
 * probe Run 7 P3C-1..4 confirmed, Run 8 I8: the new series sends a new invitation and the shortened one an update).
 *
 * The original series is ended before the split occurrence (the truncation of write-occurrence.ts) and a NEW resource holds
 * the occurrences from it on: UID and href derive from (account, operation_id) in the `split` domain, so a retry hits the
 * same href, and it is created with `If-None-Match: *`. Its body: this server's VCALENDAR header, every VTIMEZONE of the
 * original line for line, a new master (the original master's lines copied, except identity, rule, times and stamps; the
 * requested changes; DTSTART/DTEND the agent's, else the split occurrence's slot and its expanded end from iCloud; the rule
 * the agent's, else the stored rule copied, or with COUNT the remaining count taken from iCloud's expansion; the EXDATE lines
 * copied) and the overrides from the split on copied whole but for their UID line (P3C-3). The exceptions are carried only
 * when neither the time nor the rule changes: otherwise an override or EXDATE from the split on could match no occurrence
 * of the new series, so `exceptions: "drop"` is required (`exceptions_choice_required`) and `shift` is always refused
 * (`exceptions_shift_not_supported_for_split`). No RELATED-TO is written: how
 * Apple Calendar links split series (P3C-5) is not measured.
 *
 * Two writes, in this order (design 3.5): (1) PUT the new series, `If-None-Match: *`; (2) PUT the original, exact
 * `If-Match`. Creating first means a failure between them shows the later occurrences twice (visible; nothing lost);
 * truncating first could lose them. Before the first write there must be time for both and a re-read. What the caller is told:
 *
 * | Step 1                                  | Step 2                                   | Result                                              |
 * |-----------------------------------------|------------------------------------------|-----------------------------------------------------|
 * | refused, or not sent                    | not sent                                 | that error; nothing was saved by this call          |
 * | 412, the stored new series differs      | not sent                                 | calendar_changed (existing_resource_differs)        |
 * | 412, nothing at the href                | not sent                                 | create_conflict                                     |
 * | uncertain, the new series not observed  | not sent                                 | outcome_unknown (the original is unchanged)         |
 * | 2xx, or the new series observed         | 2xx                                      | applied (created_series.write_outcome per step 1)   |
 * | 2xx, or observed                        | uncertain, the truncation observed       | desired_state_present for the original              |
 * | 2xx, or observed                        | uncertain, not observed                  | outcome_unknown with created_series                 |
 * | 2xx, or observed                        | 412 / 404 (the original changed)         | split_incomplete (original_changed_since)           |
 * | 2xx, or observed                        | refused (4xx, 403, 3xx)                  | split_incomplete (second_write_refused), upstream   |
 * | 2xx, or observed                        | no time left, 401, temporary             | split_incomplete (no_time_for_second_write / second_write_not_sent) |
 *
 * split_incomplete always carries created_series and says that the new series WAS saved and the original was not shortened,
 * so occurrences from the split on show twice; the agent can retry the same call (same operation_id) to finish, with the
 * original's current expected_version, or delete the new series to undo. A stale expected_version is answered by text: both
 * halves observed → desired_state_present; only the new series → split_incomplete; else calendar_changed.
 */
import type { CalendarResource } from '../caldav/read-contracts';
import type { StrongEtag } from '../caldav/write-contracts';
import { buildDerivedResource, type ComponentPlan, type NewComponentItem, type ResourceEdit } from './ics-edit';
import { DERIVED_NOT_COPIED, verifyDerivedOutcome, type DerivedExpectation, type EditExpectation, type PropertyExpectation } from './ics-verify';
import { parseRrule, rruleProperty, sequenceProperty, timeProperty, uidProperty, type IcsTime, type RrulePart, type StartForm, type WrittenProperty } from './ics-write';
import { DAV_LAMBDA_RESERVE_MS, DAV_REQUEST_MS } from './limits';
import type { EventComponent, Interval } from './model';
import { droppedExceptions } from './write-move';
import { exdateValues, occurrencesBefore, sameSlot, sideOf, slotOf } from './occurrence-target';
import { calendarStatus, originalEventView, readStoredResources } from './read';
import { eventSpan, padTransportWindow } from './time-core';
import { normaliseLine, storedEvents, type ComponentRequest, type FieldLine, type StoredExpectation } from './write-compare';
import {
    builderError, classify, componentRequest, deterministicUid, etagOf, expectedTime, GUEST_FIELDS, holds, invalid, nextSequence, notSupported, orderedFields, parseStored, parseWork, putIfMatch,
    readFailure, readOriginalText, refusal, requireMaster, requireVerified, reread, resourceTarget, sendOnce, stampExpectations, stampOf, storedDiffers, unsupported, upstreamOf, WRITE_SEND_RESERVE_MS,
    WriteError, type ChangePlan, type CreatedSeries, type WriteDeps, type WriteErrorExtra,
} from './write-core';
import { editVerified, expandFor, readSeries, resolve, splitAt, staleTruncationHolds, storedRuleOf, tokenOf, truncation, truncationStored, type ScopeTarget, type SeriesRead } from './write-occurrence';
import type { StoredField, UpdateEventArgs, WriteEventResult } from './write-schemas';

/** Time for both writes and one re-read must remain before the first is sent. */
export const SPLIT_SEND_RESERVE_MS = 3 * DAV_REQUEST_MS + DAV_LAMBDA_RESERVE_MS;

const untilGroup = (kind: StartForm): string => (kind === 'utc' || kind === 'zoned' ? 'utc' : kind);

interface NewSeries {
    href: string;
    uid: string;
    body: string;
    /** What the stored new series must hold (requested fields, times, the rule line), for re-reads and the read-back. */
    stored: StoredExpectation;
}

/** The new series' master holds the requested lines and our UID. */
function holdsNew(resource: CalendarResource, series: { uid: string; stored: StoredExpectation }): boolean {
    const master = storedEvents(resource.calendarData)?.find(event => event.rid === null);
    return master !== undefined && master.lines.filter(line => line.name === 'UID').map(line => line.text).join('\n') === `UID:${series.uid}` && holds(resource, series.stored);
}

const incomplete = (reason: NonNullable<WriteErrorExtra['reason']>, created: CreatedSeries, extra: Omit<WriteErrorExtra, 'reason' | 'created_series'> = {}): WriteError => new WriteError('split_incomplete', { reason, created_series: created, ...extra });

/** Changes an occurrence and every later one by splitting the series (two writes, see the module comment). */
export async function updateFollowing(deps: WriteDeps, input: UpdateEventArgs, plan: ChangePlan, target: ScopeTarget): Promise<WriteEventResult> {
    if (plan.recurrence === null) { throw invalid('recurrence_not_allowed_here', 'recurrence'); }
    const operationId = input.operation_id;
    if (operationId === undefined) { throw invalid('operation_id_required', 'operation_id'); }
    const token = tokenOf(input.recurrence_id);
    const stamp = stampOf(deps);
    const uid = deterministicUid(deps.accountId, operationId, 'split');
    const { href: newHref } = resourceTarget(target.calendarId, `${target.calendarId}${uid}.ics`);
    if (newHref === target.href) { throw unsupported('stored_data_not_editable'); }
    const read = await readSeries(deps, target.calendarId, target.href);
    const { found, original, guests, reporter } = read;
    const master = requireMaster(original);
    const masterOutline = read.outlines.find(outline => outline.recurrenceId === null);
    if (masterOutline === undefined) { throw unsupported('stored_data_not_editable'); }
    const storedRule = storedRuleOf(master, masterOutline);
    const zoneDropped = plan.span?.zoneDropped ?? [];

    // The request-only part of the new series' expectation (a stale version cannot see the split occurrence's slot).
    const requestLines: ComponentRequest = componentRequest(null, plan);
    if (found.etag !== target.expected) {
        const trunc = staleTruncationHolds(read, master, token);
        let existing: CalendarResource | null;
        try { existing = await readOriginalText(deps, reporter, target.calendarId, newHref); } catch (error) { throw readFailure(error); }
        const series = { uid, stored: { kind: 'components' as const, requests: [requestLines] } };
        if (existing !== null && holdsNew(existing, series)) {
            const created: CreatedSeries = { resource_href: newHref, expected_version: existing.etag as StrongEtag, write_outcome: 'desired_state_present' };
            if (trunc !== null) { return splitResult(deps, read, target, { href: newHref, uid, stored: series.stored }, truncationStored(trunc), 'desired_state_present', created, null, zoneDropped, [found, existing]); }
            throw incomplete('original_changed_since', created);
        }
        throw new WriteError('calendar_changed', { reason: 'version_mismatch' });
    }

    const resolved = resolve(original, token, await expandFor(deps, read, target.calendarId, token));
    const { point, slot } = splitAt(master, token, resolved);
    const trunc = truncation(read, master, point, slot);

    // The new series' times: the agent's, else the split occurrence's slot and iCloud's expanded end of it.
    const instance = resolved.instance;
    let start: { property: WrittenProperty; expected: PropertyExpectation; time: IcsTime };
    let end: { property: WrittenProperty; expected: PropertyExpectation };
    let moved = false;
    try {
        if (plan.span !== undefined) {
            const [first, second] = plan.times;
            if (first?.property === undefined || first.property === null || second?.property === undefined || second.property === null) { throw unsupported('self_verification_failed'); }
            start = { property: first.property, expected: first.expected, time: plan.span.start };
            end = { property: second.property, expected: second.expected };
            moved = !(sameSlot(plan.span.start, slot) && instance.end !== null && sameSlot(plan.span.end, slotOf(instance.end)));
        } else {
            // A changed split occurrence has no slot-relative end in iCloud's text (design 3.5).
            if (resolved.kind === 'existing' && !sameSlot(slotOf(resolved.override.start), resolved.slot)) { throw notSupported('split_occurrence_changed_supply_times'); }
            if (instance.end === null) { throw notSupported('occurrence_end_not_copyable'); }
            const endSlot = slotOf(instance.end);
            start = { property: timeProperty('DTSTART', slot, 'start', { overrideCopy: true }), expected: expectedTime('DTSTART', slot), time: slot };
            end = { property: timeProperty('DTEND', endSlot, 'end', { overrideCopy: true }), expected: expectedTime('DTEND', endSlot) };
        }
    } catch (error) {
        throw builderError(error);
    }
    const newForm: StartForm = start.time.kind;

    // The exceptions from the split on: carried over unchanged only when neither the time nor the rule changes (a carried
    // override or EXDATE could then match no occurrence of the new series); else they must be dropped. Never shifted.
    if (input.exceptions === 'shift') { throw notSupported('exceptions_shift_not_supported_for_split'); }
    const exdateLines = masterOutline.properties.filter(line => line.name === 'exdate');
    const exdates = exdateValues(master);
    if (exdates === null) { throw unsupported('stored_data_not_editable'); }
    // An EXDATE whose side of the split the text cannot prove counts as after it (it may be carried).
    const exdatesAfter = exdates.filter(value => sideOf(value, master.start, point, slot) !== 'before');
    if ((moved || plan.recurrence !== undefined) && (trunc.removed.length > 0 || exdatesAfter.length > 0) && input.exceptions !== 'drop') {
        throw notSupported('exceptions_choice_required', { exceptions: { changed_occurrences: trunc.removed.length, deleted_occurrences: exdatesAfter.length } });
    }
    const carry = input.exceptions !== 'drop';
    // What a drop leaves out of the new series: the overrides and EXDATE values from the split on (earlier EXDATEs stay in
    // the original). Part of every answer once the new series was or may have been saved.
    const dropped: Pick<WriteErrorExtra, 'exceptions_dropped'> = !carry && (trunc.removed.length > 0 || exdatesAfter.length > 0)
        ? { exceptions_dropped: droppedExceptions(trunc.removedOverrides, exdatesAfter) } : {};

    // The new series' rule: the agent's; else the stored one copied; with COUNT, the count left after the split, from iCloud.
    let rule: { written: WrittenProperty; text: string } | null = null;
    const ruleLine = masterOutline.properties.find(line => line.name === 'rrule');
    try {
        if (plan.recurrence !== undefined) {
            rule = { written: rruleProperty(plan.recurrence.rrule, newForm, 'rrule'), text: plan.recurrence.rrule };
        } else if (storedRule.parsed.parts.some(part => part.key === 'COUNT')) {
            const count = Number(storedRule.parsed.parts.find(part => part.key === 'COUNT')?.value);
            const left = await countLeft(deps, read, target.calendarId, token, master, { point, slot, count });
            const parts: RrulePart[] = storedRule.parsed.parts.map(part => (part.key === 'COUNT' ? { key: 'COUNT', value: String(left) } : part));
            const written = rruleProperty({ parts }, newForm, 'rrule');
            rule = { written, text: written.line.slice(6) };
        } else if (untilGroup(newForm) !== untilGroup(master.start.kind)) {
            parseRrule(storedRule.text, newForm, 'rrule');
        }
    } catch (error) {
        throw builderError(error);
    }

    // The new resource.
    const changed = new Set(plan.fields.map(field => field.name.toLowerCase()));
    const companions = new Set(plan.companions.map(name => name.toLowerCase()));
    const notCopied = new Set(DERIVED_NOT_COPIED.map(name => name.toLowerCase()));
    const items: NewComponentItem[] = [
        ...masterOutline.properties.filter(line => !notCopied.has(line.name) && !changed.has(line.name) && !companions.has(line.name)).map(line => ({ copy_line: line.index })),
        start.property, end.property,
        ...(rule === null ? (ruleLine === undefined ? [] : [{ copy_line: ruleLine.index }]) : [rule.written]),
        ...(carry ? exdateLines.map(line => ({ copy_line: line.index })) : []),
        ...plan.fields.flatMap(field => (field.property === null ? [] : [field.property])),
    ];
    const alarms = plan.alarms === undefined ? { kind: 'copied' as const } : plan.alarms === null ? { kind: 'removed' as const } : { kind: 'replaced' as const, alarms: plan.alarms.expected };
    let body: string;
    try {
        items.push(
            timeProperty('DTSTAMP', { kind: 'utc', utc: stamp.basic }), timeProperty('CREATED', { kind: 'utc', utc: stamp.basic }), timeProperty('LAST-MODIFIED', { kind: 'utc', utc: stamp.basic }), sequenceProperty(0),
            ...(plan.alarms === undefined ? masterOutline.alarms.map(alarm => ({ copy_component: alarm.begin })) : plan.alarms === null ? [] : plan.alarms.components),
        );
        const overrides = carry ? trunc.removed : [];
        body = buildDerivedResource(found.calendarData, { uid: uidProperty(uid), master: items, overrides }, { work: parseWork(deps) });
        const expectation: DerivedExpectation = {
            uid,
            master: {
                properties: [start.expected, end.expected, ...plan.fields.map(field => field.expected), { name: 'DTSTAMP', type: 'date-time', values: [stamp.jcal] }, { name: 'CREATED', type: 'date-time', values: [stamp.jcal] }, { name: 'LAST-MODIFIED', type: 'date-time', values: [stamp.jcal] }, { name: 'SEQUENCE', type: 'integer', values: [0] }],
                companionsRemoved: plan.companions,
                rrule: rule === null ? { kind: 'copied' } : rule.text,
                exdates: carry ? 'copied' : 'none',
                alarms,
            },
            overrides,
            // The one exception to "no new ATTENDEE/ORGANIZER": the new series keeps the stored guests, copied unaltered (I8).
            schedulingCopied: guests,
        };
        requireVerified(verifyDerivedOutcome(found.calendarData, body, expectation, { work: parseWork(deps) }));
    } catch (error) {
        throw builderError(error);
    }
    const ruleFor: FieldLine = { field: 'recurrence', name: 'RRULE', line: rule === null ? (ruleLine === undefined ? null : normaliseLine(ruleLine.text)) : rule.written.line };
    const series: NewSeries = {
        href: newHref, uid, body,
        stored: { kind: 'components', requests: [componentRequest(null, plan, [{ field: 'start', name: 'DTSTART', line: start.property.line }, { field: 'end', name: 'DTEND', line: end.property.line }, ruleFor], false)] },
    };

    // The truncation of the original.
    let truncated: string;
    try {
        const sequence = nextSequence(master);
        const plans: ComponentPlan[] = [{ target: { kind: 'master' }, edits: [{ op: 'set', property: trunc.rrule }, { op: 'set', property: timeProperty('DTSTAMP', { kind: 'utc', utc: stamp.basic }) }, { op: 'set', property: timeProperty('LAST-MODIFIED', { kind: 'utc', utc: stamp.basic }) }, { op: 'set', property: sequenceProperty(sequence) }] }];
        const resource: ResourceEdit[] = trunc.removed.map(recurrenceId => ({ op: 'remove_component', target: { kind: 'override', recurrenceId } }));
        const expectation: EditExpectation = { target: { component: { kind: 'master' }, properties: stampExpectations(stamp, sequence), rrule: trunc.ruleText }, removeOverrides: trunc.removed.map(recurrenceId => ({ recurrenceId })) };
        truncated = editVerified(deps, found.calendarData, plans, resource, expectation).body;
    } catch (error) {
        throw builderError(error);
    }
    const originalStored = truncationStored(trunc);

    // Step 1: the new series, If-None-Match: *, only with time for both writes.
    const first = await sendOnce(deps, reporter, options => deps.backend.putEvent(deps.auth, deps.discovery, { calendarId: target.calendarId, href: newHref, body, precondition: { kind: 'create' } }, options), SPLIT_SEND_RESERVE_MS);
    const answer = classify(first);
    let created: CreatedSeries;
    if (answer === 'applied') {
        created = { resource_href: newHref, expected_version: etagOf(first), write_outcome: 'applied' };
    } else {
        const refused = refusal(answer, first);
        if (refused !== undefined) { throw refused; }
        if (answer === 'not_found') {
            const upstream = upstreamOf(first);
            throw new WriteError('write_refused', upstream === undefined ? {} : { upstream });
        }
        const after = await reread(deps, reporter, target.calendarId, newHref);
        if (after.kind === 'found' && holdsNew(after.resource, series)) {
            created = { resource_href: newHref, expected_version: after.resource.etag as StrongEtag, write_outcome: 'desired_state_present' };
        } else if (answer === 'precondition' && after.kind === 'found') {
            throw new WriteError('calendar_changed', { reason: 'existing_resource_differs' });
        } else if (answer === 'precondition' && after.kind === 'absent') {
            throw new WriteError('create_conflict');
        } else {
            // Nothing of the original was sent; the new series may or may not exist (a retry of the same call is safe).
            throw new WriteError('outcome_unknown', dropped);
        }
    }

    // Step 2: the original, exact If-Match. From here on the new series exists: no answer may claim nothing was saved.
    if (deps.budget.workRemainingMs() < WRITE_SEND_RESERVE_MS) { throw incomplete('no_time_for_second_write', created, dropped); }
    let second: Awaited<ReturnType<typeof putIfMatch>>;
    try {
        second = await putIfMatch(deps, reporter, { calendarId: target.calendarId, href: target.href, body: truncated, expected: target.expected }, resource => holds(resource, originalStored));
    } catch (error) {
        if (!(error instanceof WriteError)) { throw incomplete('second_write_not_sent', created, dropped); }
        switch (error.code) {
            case 'outcome_unknown': throw new WriteError('outcome_unknown', { created_series: created, ...dropped });
            case 'calendar_changed':
            case 'not_found': throw incomplete('original_changed_since', created, dropped);
            case 'write_refused':
            case 'forbidden':
            case 'read_only_calendar':
            case 'upstream_error': throw incomplete('second_write_refused', created, { ...dropped, ...(error.extra.upstream === undefined ? {} : { upstream: error.extra.upstream }) });
            default: throw incomplete('second_write_not_sent', created, dropped);
        }
    }
    const outcome = second.kind === 'applied' ? 'applied' : 'desired_state_present';
    return splitResult(deps, read, target, series, originalStored, outcome, created, second.kind === 'applied' ? second.etag : null, zoneDropped, null, dropped);
}

/**
 * The count of occurrences left from the split on, for a COUNT rule: COUNT minus the occurrences before it in iCloud's
 * expansion of [series start, split] (never computed from the rule; occurrence-target.ts says when the expansion proves it).
 * Refused (`count_series_needs_rrule`: the agent gives the new series' rule) when it cannot be proven or the window is too
 * wide.
 */
async function countLeft(deps: WriteDeps, read: SeriesRead, calendarId: string, token: Parameters<typeof expandFor>[3], master: EventComponent, split: { point: string; slot: IcsTime; count: number }): Promise<number> {
    const { point, slot, count } = split;
    const refuse = (): WriteError => notSupported('count_series_needs_rrule');
    let window: { startUtc: string; endUtc: string };
    try {
        const span = eventSpan(master.start, master.end, master.duration);
        const intervals: Interval[] = [{ startNs: span.civil.startNs, endNs: token.ns + 1_000_000_000n }, ...(span.instant === null ? [] : [span.instant])];
        for (const override of read.original.overrides) {
            const own = eventSpan(override.start, override.end, override.duration);
            intervals.push(own.civil, ...(own.instant === null ? [] : [own.instant]));
        }
        window = padTransportWindow(intervals, 24);
    } catch {
        throw refuse();
    }
    let expanded: Awaited<ReturnType<typeof expandFor>>;
    try { expanded = await expandFor(deps, read, calendarId, token, window); } catch (error) {
        if (error instanceof WriteError && (error.code === 'not_found' || error.code === 'occurrence_identity_unprovable')) { throw refuse(); }
        throw error;
    }
    const before = occurrencesBefore(read.original, expanded, point, slot);
    if (before === null || !Number.isSafeInteger(count) || count - before < 1) { throw refuse(); }
    return count - before;
}

/** The split's result: the original (shortened) at the top level, the new series in created_series and as `event`. */
async function splitResult(
    deps: WriteDeps, read: SeriesRead, target: ScopeTarget, series: Pick<NewSeries, 'href' | 'uid' | 'stored'>, originalStored: StoredExpectation, outcome: WriteEventResult['write_outcome'],
    created: CreatedSeries, answerEtag: StrongEtag | null, zoneDropped: readonly ('start' | 'end')[], known: [CalendarResource, CalendarResource] | null,
    dropped: Pick<WriteEventResult, 'exceptions_dropped'> = {},
): Promise<WriteEventResult> {
    let pair: (CalendarResource | null)[] = known ?? [null, null];
    if (known === null) {
        try { pair = await readStoredResources(deps, read.reporter, target.calendarId, [target.href, series.href]); } catch { pair = [null, null]; }
    }
    const [shortened, next] = pair;
    const base = {
        write_outcome: outcome, calendar_id: target.calendarId, resource_href: target.href,
        request_warnings: zoneDropped.map(field => ({ field, timezone_warning: 'timezone_dropped_from_date' as const })),
        removed_dependent_properties: [],
        ...dropped,
        ...(read.guests ? GUEST_FIELDS : {}),
        calendars: [calendarStatus(target.calendarId, read.summary, 'ok')] as [ReturnType<typeof calendarStatus>],
    };
    const createdSeries: CreatedSeries = { ...created, expected_version: next?.etag as StrongEtag | undefined ?? created.expected_version };
    if (shortened !== null && shortened !== undefined && next !== null && next !== undefined) {
        try {
            const parsed = parseStored(deps, next.calendarData);
            const event = originalEventView(target.calendarId, read.summary, next, parsed).event;
            const differs: StoredField[] = orderedFields([...storedDiffers(shortened.calendarData, originalStored), ...storedDiffers(next.calendarData, series.stored)]);
            return { ...base, readback: 'ok', expected_version: shortened.etag as StrongEtag, created_series: createdSeries, stored_differs_from_request: differs, event };
        } catch {
            // Both writes stand; only their presentation failed.
        }
    }
    return { ...base, readback: 'unavailable', expected_version: shortened?.etag as StrongEtag | undefined ?? answerEtag, created_series: createdSeries, stored_differs_from_request: null, event: null };
}
