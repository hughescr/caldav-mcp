/**
 * The single-PUT occurrence scopes (phase 3 design v2 sections 3.2-3.4 and 3.7, ORCH B3, ORCH-R and the delete constraints;
 * probe Run 7 P3B-1..6, P3C-1/2/4):
 * - `update_event` `this`: an existing override is patched in place (its RECURRENCE-ID line byte-kept, the master
 *   untouched); otherwise one override VEVENT is added whose RECURRENCE-ID is the instance's slot in the master's form, as
 *   iCloud's own expansion of THIS version renders it (occurrence-target.ts), with the master's lines copied (P3B-1).
 * - `delete_event` `this`: one EXDATE line in the master's form for that slot; an existing override of it is removed
 *   (P3B-5). Existing EXDATE lines are kept byte for byte.
 * - `delete_event` `this_and_future`: the master's RRULE ends before the occurrence (UNTIL = its UTC instant from iCloud's
 *   expansion minus one second, zone-free; a COUNT is replaced, which needs no counting: P3C-2), and every override at or
 *   after it is removed (P3C-1). EXDATEs are kept (those after UNTIL are inert).
 *
 * Each call reads the original, expands exactly that version (href, UID and ETag must match; else calendar_changed with
 * `changed_between_reads`), names the occurrence or fails closed, builds ONE edit, verifies it against the request-derived
 * expectation, and sends ONE PUT with the exact If-Match. A stale expected_version is answered from the stored text alone:
 * `desired_state_present` only when the requested state is provable by text (the occurrence's token still names the same
 * stored override or EXDATE), else `calendar_changed` (`version_mismatch`).
 */
import type { CalendarResource } from '../caldav/read-contracts';
import type { StrongEtag } from '../caldav/write-contracts';
import { describeEvents, editResource, type ComponentEdit, type ComponentPlan, type EventOutline, type NewComponentItem, type ResourceEdit } from './ics-edit';
import { OVERRIDE_NOT_COPIED, verifyEditOutcome, type Companion, type EditExpectation, type PropertyExpectation } from './ics-verify';
import { parseRrule, rruleProperty, sequenceProperty, timeProperty, type ParsedRrule, type RrulePart, type WrittenProperty } from './ics-write';
import type { EventComponent, OccurrenceId, OriginalResource } from './model';
import { inMasterForm, lexicalSlot, resolveOccurrence, sameSlot, sideOf, slotOf, splitPoint, untilBefore, type ResolvedOccurrence } from './occurrence-target';
import { calendarStatus, expandStoredResource, occurrenceWindow, ReadError, resourceUid, type UnauthorizedReporter } from './read';
import { parseOccurrenceId, type ParsedOccurrenceId } from './time-core';
import { normaliseLine, type ComponentRequest, type StoredExpectation } from './write-compare';
import {
    attendeeGate, builderError, componentRequest, eventResult, expectedTime, expectedValue, GUEST_FIELDS, holds, invalid, membership, nextSequence, notSupported, occurrenceTokenOf, parseStored,
    parseWork, putIfMatch, readBack, readFailure, readOriginalText, requireMaster, requireVerified, reread, stampExpectations, stampOf, storedDiffers, unsupported, WriteError,
    type ChangePlan, type ResultContext, type Stamp, type WriteDeps,
} from './write-core';
import type { DeleteEventArgs, DeleteEventResult, UpdateEventArgs, WriteEventResult } from './write-schemas';

export interface ScopeTarget { calendarId: string; href: string; expected: StrongEtag }

// ---- Shared reads ----

export interface SeriesRead {
    summary: Parameters<typeof calendarStatus>[1] & object;
    reporter: UnauthorizedReporter;
    found: CalendarResource;
    original: OriginalResource;
    guests: boolean;
    outlines: EventOutline[];
}

/** Membership, the original, the attendee gate; a non-repeating event has no occurrences (`not_repeating`). */
export async function readSeries(deps: WriteDeps, calendarId: string, href: string): Promise<SeriesRead> {
    const { summary, reporter } = await membership(deps, calendarId);
    const found = await readOriginalText(deps, reporter, calendarId, href);
    if (found === null) { throw new WriteError('not_found'); }
    const original = parseStored(deps, found.calendarData);
    const guests = attendeeGate(deps, found.calendarData);
    if (original.kind === 'single') { throw invalid('not_repeating', 'edit_scope'); }
    let outlines: EventOutline[];
    try { outlines = describeEvents(found.calendarData, { work: parseWork(deps) }); } catch (error) { throw builderError(error); }
    if (outlines.filter(outline => outline.recurrenceId !== null).length !== original.overrides.length) { throw unsupported('stored_data_not_editable'); }
    return { summary, reporter, found, original, guests, outlines };
}

export function tokenOf(text: string | undefined): ParsedOccurrenceId {
    const token = text === undefined ? null : parseOccurrenceId(text);
    if (token === null) { throw invalid('schema'); }
    return token;
}

/**
 * iCloud's expansion of exactly the version read, over a window (default: the token's, as get_event chooses it).
 * Throws WriteError: `not_found` when no instance of the resource is in the window, `calendar_changed`
 * (`changed_between_reads`) when the expansion is of another version or UID.
 */
export async function expandFor(deps: WriteDeps, read: SeriesRead, calendarId: string, token: ParsedOccurrenceId, window?: { startUtc: string; endUtc: string }): Promise<readonly EventComponent[]> {
    let range: { startUtc: string; endUtc: string };
    try { range = window ?? occurrenceWindow(read.original, token); } catch (error) {
        if (error instanceof ReadError && error.code === 'result_too_large') { throw new WriteError('occurrence_identity_unprovable', { reason: 'window_too_wide' }); }
        throw readFailure(error);
    }
    let lookup: Awaited<ReturnType<typeof expandStoredResource>>;
    try {
        lookup = await expandStoredResource(deps, read.reporter, { calendarId, href: read.found.href, etag: read.found.etag, uid: resourceUid(read.original), window: range });
    } catch (error) {
        if (error instanceof ReadError && error.code === 'calendar_changed') { throw new WriteError('calendar_changed', { reason: 'changed_between_reads' }); }
        throw readFailure(error);
    }
    if (lookup.kind === 'absent') { throw new WriteError('not_found'); }
    return lookup.components;
}

export function resolve(original: OriginalResource, token: ParsedOccurrenceId, components: readonly EventComponent[]): ResolvedOccurrence {
    try { return resolveOccurrence(original, token, components); } catch (error) { throw builderError(error); }
}

/** The exact RECURRENCE-ID line text of a stored override (the editor's and the verifier's selector). */
export function ridLineOf(read: SeriesRead, override: EventComponent): string {
    const index = read.original.overrides.indexOf(override);
    const rid = read.outlines.filter(outline => outline.recurrenceId !== null)[index]?.recurrenceId;
    if (rid === undefined || rid === null) { throw unsupported('stored_data_not_editable'); }
    return rid;
}

const stampEdits = (stamp: Stamp): ComponentEdit[] => [
    { op: 'set', property: timeProperty('DTSTAMP', { kind: 'utc', utc: stamp.basic }) },
    { op: 'set', property: timeProperty('LAST-MODIFIED', { kind: 'utc', utc: stamp.basic }) },
];

/** ONE edit pass and ONE verification against the request-derived expectation; the Apple companions it removed. */
export function editVerified(deps: WriteDeps, text: string, plans: ComponentPlan[], resource: ResourceEdit[], expectation: EditExpectation): { body: string; removed: Companion[] } {
    try {
        const work = parseWork(deps);
        const next = editResource(text, { targets: plans, resource }, { work });
        requireVerified(verifyEditOutcome(text, next.text, expectation, { work }));
        const removed = new Set<Companion>();
        for (const change of next.report.changes) {
            if (change.reason === 'paired' && (change.name === 'X-APPLE-STRUCTURED-LOCATION' || change.name === 'X-ALT-DESC')) { removed.add(change.name); }
        }
        return { body: next.text, removed: (['X-APPLE-STRUCTURED-LOCATION', 'X-ALT-DESC'] as const).filter(name => removed.has(name)) };
    } catch (error) {
        throw builderError(error);
    }
}

// ---- update_event, edit_scope this ----

/** Changes one occurrence: patches its override, or adds one in the master's form from iCloud's expansion. */
export async function updateOccurrence(deps: WriteDeps, input: UpdateEventArgs, plan: ChangePlan, target: ScopeTarget): Promise<WriteEventResult> {
    if (plan.recurrence !== undefined) { throw invalid('recurrence_not_allowed_here', 'recurrence'); }
    const token = tokenOf(input.recurrence_id);
    const stamp = stampOf(deps);
    const read = await readSeries(deps, target.calendarId, target.href);
    const { found, original, guests, reporter, summary } = read;
    const base = (stored: StoredExpectation, occurrence: OccurrenceId): ResultContext => ({
        deps, reporter, calendarId: target.calendarId, href: target.href, summary, zoneDropped: plan.span?.zoneDropped ?? [], stored, guests, occurrence, fields: { recurrence_id: occurrence },
    });

    if (found.etag !== target.expected) {
        // Provable only by text: the token still names one stored override, and it holds the requested values.
        const override = original.overrides.find(item => item.recurrenceId?.token === token.id);
        const stored: StoredExpectation | null = override === undefined ? null : { kind: 'components', requests: [componentRequest(ridLineOf(read, override), plan)] };
        if (stored !== null && holds(found, stored)) { return eventResult(base(stored, token.id), 'desired_state_present', found, null); }
        throw new WriteError('calendar_changed', { reason: 'version_mismatch' });
    }

    const resolved = resolve(original, token, await expandFor(deps, read, target.calendarId, token));
    let plans: ComponentPlan[] = [];
    let resource: ResourceEdit[] = [];
    let expectation: EditExpectation;
    let stored: StoredExpectation;
    let occurrence: OccurrenceId;
    try {
        const fieldEdits: ComponentEdit[] = plan.fields.map(field => (field.property === null ? { op: 'remove', name: field.name } : { op: 'set', property: field.property }));
        const alarms = plan.alarms === undefined ? undefined : plan.alarms === null ? { kind: 'removed' as const } : { kind: 'replaced' as const, alarms: plan.alarms.expected };
        if (resolved.kind === 'existing') {
            const rid = ridLineOf(read, resolved.override);
            const sequence = nextSequence(resolved.override);
            const edits: ComponentEdit[] = [...fieldEdits];
            const properties: PropertyExpectation[] = plan.fields.map(field => field.expected);
            for (const time of plan.times) {
                if (time.property !== null) { edits.push({ op: 'set', property: time.property }); }
                properties.push(time.expected);
            }
            if (plan.span !== undefined) {
                edits.push({ op: 'remove', name: 'DURATION' });
                properties.push({ name: 'DURATION', absent: true });
            }
            if (plan.alarms !== undefined) { edits.push({ op: 'remove_alarms' }, ...(plan.alarms?.components ?? []).map(alarm => ({ op: 'add_alarm' as const, alarm }))); }
            edits.push(...stampEdits(stamp), { op: 'set', property: sequenceProperty(sequence) });
            plans = [{ target: { kind: 'override', recurrenceId: rid }, edits }];
            expectation = { target: { component: { kind: 'override', recurrenceId: rid }, properties: [...properties, ...stampExpectations(stamp, sequence)], companionsRemoved: plan.companions, ...(alarms === undefined ? {} : { alarms }) } };
            stored = { kind: 'components', requests: [componentRequest(rid, plan)] };
            const own = resolved.override.recurrenceId?.token ?? null;
            if (own === null) { throw unsupported('stored_data_not_editable'); }
            occurrence = own;
        } else {
            const master = requireMaster(original);
            const masterOutline = read.outlines.find(outline => outline.recurrenceId === null);
            if (masterOutline === undefined) { throw unsupported('stored_data_not_editable'); }
            const instance = resolved.instance;
            // The occurrence's own times: the agent's, else iCloud's expanded DTSTART/DTEND of this slot (master form).
            let times: { start: WrittenProperty; end: WrittenProperty; expected: PropertyExpectation[] };
            if (plan.span !== undefined) {
                const [start, end] = plan.times;
                if (start?.property === undefined || start.property === null || end?.property === undefined || end.property === null) { throw unsupported('self_verification_failed'); }
                times = { start: start.property, end: end.property, expected: [start.expected, end.expected] };
            } else {
                if (instance.end === null) { throw notSupported('occurrence_end_not_copyable'); }
                const startSlot = slotOf(instance.start);
                const endSlot = slotOf(instance.end);
                times = {
                    start: timeProperty('DTSTART', startSlot, 'start', { overrideCopy: true }), end: timeProperty('DTEND', endSlot, 'end', { overrideCopy: true }),
                    expected: [expectedTime('DTSTART', startSlot), expectedTime('DTEND', endSlot)],
                };
            }
            const ridProperty = timeProperty('RECURRENCE-ID', resolved.slot);
            const token2 = occurrenceTokenOf(resolved.slot);
            if (token2 === null) { throw new WriteError('occurrence_identity_unprovable', { reason: 'form_mismatch' }); }
            occurrence = token2;
            const sequence = nextSequence(master);
            const changed = new Set(plan.fields.map(field => field.name.toLowerCase()));
            const companions = new Set(plan.companions.map(name => name.toLowerCase()));
            const notCopied = new Set([...OVERRIDE_NOT_COPIED.map(name => name.toLowerCase()), 'recurrence-id']);
            const copies: NewComponentItem[] = masterOutline.properties
                .filter(line => !notCopied.has(line.name) && !changed.has(line.name) && !companions.has(line.name))
                .map(line => ({ copy_line: line.index }));
            const written: NewComponentItem[] = plan.fields.flatMap(field => (field.property === null ? [] : [field.property]));
            const alarmItems: NewComponentItem[] = plan.alarms === undefined ? masterOutline.alarms.map(alarm => ({ copy_component: alarm.begin })) : plan.alarms === null ? [] : plan.alarms.components;
            resource = [{
                op: 'add_component', items: [
                    ...copies, times.start, times.end, ridProperty, ...written,
                    timeProperty('DTSTAMP', { kind: 'utc', utc: stamp.basic }), timeProperty('LAST-MODIFIED', { kind: 'utc', utc: stamp.basic }), sequenceProperty(sequence), ...alarmItems,
                ],
            }];
            expectation = {
                addOverride: {
                    recurrenceId: expectedValue(resolved.slot),
                    properties: [...times.expected, ...plan.fields.map(field => field.expected), ...stampExpectations(stamp, sequence)],
                    companionsRemoved: plan.companions,
                    alarms: alarms ?? { kind: 'copied' },
                    // The one exception to "no new ATTENDEE/ORGANIZER": an occurrence of a series with guests keeps them (I6).
                    schedulingCopied: guests,
                },
            };
            const request: ComponentRequest = componentRequest(ridProperty.line, plan);
            stored = { kind: 'components', requests: [request] };
            // Nothing else about the master changes.
            void master;
        }
    } catch (error) {
        throw builderError(error);
    }
    const { body, removed } = editVerified(deps, found.calendarData, plans, resource, expectation);
    const context = { ...base(stored, occurrence), removedCompanions: removed };
    const outcome = await putIfMatch(deps, reporter, { calendarId: target.calendarId, href: target.href, body, expected: target.expected }, resource2 => holds(resource2, stored));
    if (outcome.kind === 'present') { return eventResult(context, 'desired_state_present', outcome.resource, null); }
    return readBack(context, outcome.etag);
}

// ---- delete_event results ----

async function partialDeleteResult(
    deps: WriteDeps, read: SeriesRead, target: ScopeTarget, token: ParsedOccurrenceId, deleted: 'occurrence' | 'following', stored: StoredExpectation,
    outcome: DeleteEventResult['write_outcome'], resource: CalendarResource | null, answerEtag: StrongEtag | null,
): Promise<DeleteEventResult> {
    let found = resource;
    if (found === null && outcome === 'applied') {
        const after = await reread(deps, read.reporter, target.calendarId, target.href);
        found = after.kind === 'found' ? after.resource : null;
    }
    const differs = found === null ? null : (storedDiffers(found.calendarData, stored).includes('recurrence') ? ['recurrence' as const] : []);
    return {
        write_outcome: outcome, deleted, calendar_id: target.calendarId, resource_href: target.href, recurrence_id: token.id,
        readback: found === null ? 'unavailable' : 'ok', expected_version: found?.etag ?? answerEtag, stored_differs_from_request: differs,
        ...(read.guests ? GUEST_FIELDS : {}),
        calendars: [calendarStatus(target.calendarId, read.summary, 'ok')],
    };
}

// ---- delete_event, edit_scope this ----

/** Deletes one occurrence: an EXDATE in the master's form, and its override removed if it has one (P3B-5). */
export async function deleteOccurrence(deps: WriteDeps, input: DeleteEventArgs, target: ScopeTarget): Promise<DeleteEventResult> {
    const token = tokenOf(input.recurrence_id);
    const stamp = stampOf(deps);
    const read = await readSeries(deps, target.calendarId, target.href);
    const { found, original } = read;
    const master = requireMaster(original);
    const storedFor = (exdate: WrittenProperty, removedRid: string | null): StoredExpectation => ({
        kind: 'components',
        requests: [{ rid: null, fields: [{ field: 'recurrence', name: 'EXDATE', line: null, includes: [exdate.line] }] }],
        absentRids: removedRid === null ? [] : [normaliseLine(removedRid)],
    });

    if (found.etag !== target.expected) {
        // Provable only by text: the slot follows from the token without expansion, it is excluded, and no override has it.
        const slot = lexicalSlot(master.start, token);
        if (slot !== null && !original.overrides.some(item => item.recurrenceId?.token === token.id)) {
            let exdate: WrittenProperty;
            try { exdate = timeProperty('EXDATE', slot); } catch (error) { throw builderError(error); }
            const stored = storedFor(exdate, null);
            if (holds(found, stored)) { return partialDeleteResult(deps, read, target, token, 'occurrence', stored, 'desired_state_present', found, null); }
        }
        throw new WriteError('calendar_changed', { reason: 'version_mismatch' });
    }

    const resolved = resolve(original, token, await expandFor(deps, read, target.calendarId, token));
    if (!inMasterForm(resolved.slot, master.start)) { throw new WriteError('occurrence_identity_unprovable', { reason: 'form_mismatch' }); }
    let exdate: WrittenProperty;
    let plans: ComponentPlan[];
    let resource: ResourceEdit[] = [];
    let expectation: EditExpectation;
    let removedRid: string | null = null;
    try {
        exdate = timeProperty('EXDATE', resolved.slot);
        const sequence = nextSequence(master);
        plans = [{ target: { kind: 'master' }, edits: [{ op: 'add', property: exdate }, ...stampEdits(stamp), { op: 'set', property: sequenceProperty(sequence) }] }];
        if (resolved.kind === 'existing') {
            removedRid = ridLineOf(read, resolved.override);
            resource = [{ op: 'remove_component', target: { kind: 'override', recurrenceId: removedRid } }];
        }
        expectation = {
            target: { component: { kind: 'master' }, properties: stampExpectations(stamp, sequence), exdates: { kind: 'added', values: [expectedValue(resolved.slot)] } },
            ...(removedRid === null ? {} : { removeOverride: { recurrenceId: removedRid } }),
        };
    } catch (error) {
        throw builderError(error);
    }
    const stored = storedFor(exdate, removedRid);
    const { body } = editVerified(deps, found.calendarData, plans, resource, expectation);
    const outcome = await putIfMatch(deps, read.reporter, { calendarId: target.calendarId, href: target.href, body, expected: target.expected }, resource2 => holds(resource2, stored));
    return outcome.kind === 'present'
        ? partialDeleteResult(deps, read, target, token, 'occurrence', stored, 'desired_state_present', outcome.resource, null)
        : partialDeleteResult(deps, read, target, token, 'occurrence', stored, 'applied', null, outcome.etag);
}

// ---- this_and_future: the truncation shared by delete and update ----

export interface Truncation {
    /** The master's new RRULE line. */
    rrule: WrittenProperty;
    /** Its rule text, for the verifier. */
    ruleText: string;
    /** Overrides at or after the split, by RECURRENCE-ID line, in source order. */
    removed: string[];
    /** The stored RRULE text and its parsed parts (the new series of an update starts from them). */
    storedRule: { text: string; parsed: ParsedRrule };
}

/** The one stored RRULE of a splittable master; RDATE and EXRULE series are refused (design 3.5). */
export function storedRuleOf(master: EventComponent, outline: EventOutline): { text: string; parsed: ParsedRrule } {
    if (master.properties.has('rdate')) { throw notSupported('rdate_present'); }
    if (master.properties.has('exrule')) { throw notSupported('exrule_present'); }
    const lines = outline.properties.filter(line => line.name === 'rrule');
    const line = lines[0];
    const text = line !== undefined && /^RRULE:/iu.test(line.text) ? line.text.slice(6) : null;
    if (lines.length !== 1 || text === null) { throw notSupported('rrule_not_editable'); }
    try {
        return { text, parsed: parseRrule(text, master.start.kind, 'rrule') };
    } catch {
        throw notSupported('rrule_not_editable');
    }
}

/**
 * The truncation of the master at `point` (an `occ1_` split point; `slot` the split occurrence's slot in the master's form):
 * COUNT and UNTIL removed, `UNTIL=<point − 1 s>` appended, other parts in source order (P3C-1, P3C-2), and every override
 * whose RECURRENCE-ID is at or after the split. A side that text cannot prove fails closed.
 */
export function truncation(read: SeriesRead, master: EventComponent, point: string, slot: ReturnType<typeof slotOf>): Truncation {
    const outline = read.outlines.find(item => item.recurrenceId === null);
    if (outline === undefined) { throw unsupported('stored_data_not_editable'); }
    const storedRule = storedRuleOf(master, outline);
    const until = untilBefore(point, master.start.kind);
    const parts: RrulePart[] = [...storedRule.parsed.parts.filter(part => part.key !== 'COUNT' && part.key !== 'UNTIL'), { key: 'UNTIL', value: until }];
    let rrule: WrittenProperty;
    try { rrule = rruleProperty({ parts }, master.start.kind, 'rrule'); } catch (error) { throw builderError(error); }
    const removed: string[] = [];
    for (const override of read.original.overrides) {
        if (override.recurrenceId === null) { throw unsupported('stored_data_not_editable'); }
        const side = sideOf(override.recurrenceId.time, master.start, point, slot);
        if (side === 'unprovable') { throw new WriteError('occurrence_identity_unprovable', { reason: 'split_near_changed_occurrence' }); }
        if (side === 'after') { removed.push(ridLineOf(read, override)); }
    }
    return { rrule, ruleText: rrule.line.slice(6), removed, storedRule };
}

/** What the original must hold after a truncation: that RRULE line, and none of the removed overrides. */
export function truncationStored(trunc: Truncation): StoredExpectation {
    return {
        kind: 'components', requests: [{ rid: null, fields: [{ field: 'recurrence', name: 'RRULE', line: trunc.rrule.line }] }],
        absentRids: trunc.removed.map(normaliseLine),
    };
}

/** The split point and slot of a resolved occurrence; refusals as design 3.5. */
export function splitAt(master: EventComponent, token: ParsedOccurrenceId, resolved: ResolvedOccurrence): { point: string; slot: ReturnType<typeof slotOf> } {
    const point = splitPoint(token);
    if (point === null) { throw notSupported('split_at_changed_zoned_occurrence'); }
    if (!inMasterForm(resolved.slot, master.start)) { throw new WriteError('occurrence_identity_unprovable', { reason: 'form_mismatch' }); }
    if (sameSlot(resolved.slot, slotOf(master.start))) { throw notSupported('split_at_series_start'); }
    return { point, slot: resolved.slot };
}

/**
 * On a stale version: whether the original is already truncated at the token's split point, by text alone (the split point
 * and, for a zoned master, the slot follow from the token only for UTC, DATE and floating series; a zoned master's slot
 * needs the expansion of a version that still has that occurrence, so it is provable only without zoned overrides).
 */
export function staleTruncationHolds(read: SeriesRead, master: EventComponent, token: ParsedOccurrenceId): Truncation | null {
    const point = splitPoint(token);
    if (point === null) { return null; }
    const slot = lexicalSlot(master.start, token) ?? { kind: 'utc' as const, utc: point };
    try {
        const trunc = truncation(read, master, point, slot);
        return holds(read.found, truncationStored(trunc)) ? trunc : null;
    } catch {
        return null;
    }
}

// ---- delete_event, edit_scope this_and_future ----

/** Deletes an occurrence and every later one: the series ends before it (one PUT). */
export async function deleteFollowing(deps: WriteDeps, input: DeleteEventArgs, target: ScopeTarget): Promise<DeleteEventResult> {
    const token = tokenOf(input.recurrence_id);
    const stamp = stampOf(deps);
    const read = await readSeries(deps, target.calendarId, target.href);
    const { found, original } = read;
    const master = requireMaster(original);

    if (found.etag !== target.expected) {
        const trunc = staleTruncationHolds(read, master, token);
        if (trunc !== null) { return partialDeleteResult(deps, read, target, token, 'following', truncationStored(trunc), 'desired_state_present', found, null); }
        throw new WriteError('calendar_changed', { reason: 'version_mismatch' });
    }

    const outline = read.outlines.find(item => item.recurrenceId === null);
    if (outline === undefined) { throw unsupported('stored_data_not_editable'); }
    storedRuleOf(master, outline);
    const resolved = resolve(original, token, await expandFor(deps, read, target.calendarId, token));
    const { point, slot } = splitAt(master, token, resolved);
    const trunc = truncation(read, master, point, slot);
    let plans: ComponentPlan[];
    let expectation: EditExpectation;
    try {
        const sequence = nextSequence(master);
        plans = [{ target: { kind: 'master' }, edits: [{ op: 'set', property: trunc.rrule }, ...stampEdits(stamp), { op: 'set', property: sequenceProperty(sequence) }] }];
        expectation = {
            target: { component: { kind: 'master' }, properties: stampExpectations(stamp, sequence), rrule: trunc.ruleText },
            removeOverrides: trunc.removed.map(recurrenceId => ({ recurrenceId })),
        };
    } catch (error) {
        throw builderError(error);
    }
    const stored = truncationStored(trunc);
    const resource: ResourceEdit[] = trunc.removed.map(recurrenceId => ({ op: 'remove_component', target: { kind: 'override', recurrenceId } }));
    const { body } = editVerified(deps, found.calendarData, plans, resource, expectation);
    const outcome = await putIfMatch(deps, read.reporter, { calendarId: target.calendarId, href: target.href, body, expected: target.expected }, resource2 => holds(resource2, stored));
    return outcome.kind === 'present'
        ? partialDeleteResult(deps, read, target, token, 'following', stored, 'desired_state_present', outcome.resource, null)
        : partialDeleteResult(deps, read, target, token, 'following', stored, 'applied', null, outcome.etag);
}
