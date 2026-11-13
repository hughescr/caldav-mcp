/**
 * Write orchestration for `create_event`, `update_event` and `delete_event` (phase 3 design v2 sections 3-6, arbitration
 * B1-B4 and ORCH-R, addendum 1). This module holds create, the whole-resource update (a single event, or a whole series
 * with `edit_scope: "all"`, its time and rule included: design 3.6 and probe P3D), the whole-resource delete, and the
 * dispatch to the occurrence scopes: `this` (write-occurrence.ts) and `this_and_future` (write-split.ts for an update,
 * write-occurrence.ts for a delete). The shared machinery and its rules are in write-core.ts.
 *
 * Every call: membership listing → (edits) one multiget of the original, the attendee gate, the target rules and the
 * version check → the text, built by ics-write or by ONE ics-edit pass over every selected component → the MANDATORY
 * intent gate with an expectation derived from the request → a deadline guard → ONE conditional request → classification.
 *
 * Identity of a create: UID and href derive from (account, operation_id), so a retry hits the same href and
 * `If-None-Match: *` makes it idempotent; no marker is stored in the event (ORCH B1).
 */
import type { CalendarResource } from '../caldav/read-contracts';
import { strongEtag, type StrongEtag } from '../caldav/write-contracts';
import { describeEvents, editResource, type ComponentEdit, type ComponentPlan, type ComponentSelector, type ResourceEdit } from './ics-edit';
import { verifyCreateOutcome, verifyEditOutcome, type Companion, type CreateExpectation, type EditExpectation, type ExpectedProperty, type PropertyExpectation, type TargetExpectation } from './ics-verify';
import { buildCreateResource, rruleProperty, sequenceProperty, statusProperty, timeProperty, transparencyProperty, travelDurationProperty, type StartForm, type WrittenProperty } from './ics-write';
import type { EventComponent, OriginalResource } from './model';
import { calendarStatus, type UnauthorizedReporter } from './read';
import { differingFields, storedEvents, type ComponentRequest, type StoredExpectation } from './write-compare';
import {
    alarmPlan, attendeeGate, builderError, classify, collection, componentRequest, deterministicUid, etagOf, eventResult, expectedText, expectedTime, fieldLine, GUEST_FIELDS, holds, invalid,
    membership, nextSequence, notSupported, orderedFields, parseStored, parseWork, planChanges, putIfMatch, readBack, readOriginalText, refusal, requireVerified, reread, resourceTarget, sendOnce,
    spanOf, stampExpectations, stampOf, textField, unsupported, upstreamOf, WriteError, type AlarmPlan, type ChangePlan, type FieldPlan, type ResultContext, type Stamp, type WriteDeps,
} from './write-core';
import { planSeriesMove, type SeriesMovePlan } from './write-move';
import { deleteFollowing, deleteOccurrence, updateOccurrence } from './write-occurrence';
import { updateFollowing } from './write-split';
import type { CreateEventArgs, DeleteEventArgs, DeleteEventResult, StoredField, UpdateEventArgs, WriteEventResult } from './write-schemas';

export { deterministicUid, WRITE_SEND_RESERVE_MS, WriteError, type WriteDeps, type WriteErrorExtra } from './write-core';

// ---- create_event ----

/** Creates one event (single or repeating) at the href derived from (account, operation_id), with `If-None-Match: *`. */
export async function createEvent(deps: WriteDeps, input: CreateEventArgs): Promise<WriteEventResult> {
    const calendarId = collection(input.calendar_id);
    const span = spanOf(input.start, input.end);
    const uid = deterministicUid(deps.accountId, input.operation_id);
    const { href } = resourceTarget(calendarId, `${calendarId}${uid}.ics`);
    const stamp = stampOf(deps);
    const alarms = input.alarms ?? [];

    let body: string;
    let fields: FieldPlan[];
    let alarm: AlarmPlan;
    try {
        body = buildCreateResource({
            uid, now: stamp.basic, title: input.title, start: span.start, end: span.end, location: input.location, description: input.description,
            status: input.status, transparency: input.transparency, alarms, rrule: input.recurrence?.rrule, travelDuration: input.travel_time,
        });
        // The comparison lines and the expectation come from the request through the primitives, not from `body`.
        fields = [
            { field: 'start', name: 'DTSTART', property: timeProperty('DTSTART', span.start, 'start'), expected: expectedTime('DTSTART', span.start) },
            { field: 'end', name: 'DTEND', property: timeProperty('DTEND', span.end, 'end'), expected: expectedTime('DTEND', span.end) },
            textField('title', 'SUMMARY', input.title),
            ...(input.location === undefined ? [] : [textField('location', 'LOCATION', input.location)]),
            ...(input.description === undefined ? [] : [textField('description', 'DESCRIPTION', input.description)]),
            ...(input.status === undefined ? [] : [{ field: 'status' as const, name: 'STATUS', property: statusProperty(input.status, 'status'), expected: expectedText('STATUS', input.status) }]),
            ...(input.transparency === undefined ? [] : [{ field: 'transparency' as const, name: 'TRANSP', property: transparencyProperty(input.transparency, 'transparency'), expected: expectedText('TRANSP', input.transparency) }]),
            ...(input.travel_time === undefined ? [] : [{ field: 'travel_time' as const, name: 'X-APPLE-TRAVEL-DURATION', property: travelDurationProperty(input.travel_time, 'travel_time'), expected: { name: 'X-APPLE-TRAVEL-DURATION', type: 'duration', values: [input.travel_time] } }]),
            ...(input.recurrence === undefined ? [] : [{ field: 'recurrence' as const, name: 'RRULE', property: rruleProperty(input.recurrence.rrule, span.start.kind, 'rrule'), expected: { name: 'RRULE', absent: true as const } }]),
        ];
        alarm = alarmPlan(alarms);
    } catch (error) {
        throw builderError(error);
    }
    const expectation: CreateExpectation = {
        properties: [
            expectedText('UID', uid), { name: 'DTSTAMP', type: 'date-time', values: [stamp.jcal] }, { name: 'CREATED', type: 'date-time', values: [stamp.jcal] },
            { name: 'LAST-MODIFIED', type: 'date-time', values: [stamp.jcal] }, { name: 'SEQUENCE', type: 'integer', values: [0] },
            ...fields.filter(plan => plan.field !== 'recurrence').map(plan => plan.expected as ExpectedProperty),
        ],
        rrule: input.recurrence?.rrule,
        alarms: alarm.expected,
    };
    try { requireVerified(verifyCreateOutcome(body, expectation, { work: parseWork(deps) })); } catch (error) { throw builderError(error); }

    const request: ComponentRequest = { rid: null, fields: fields.map(fieldLine), triggers: alarm.triggers };
    const { summary, reporter } = await membership(deps, calendarId);
    const context: ResultContext = { deps, reporter, calendarId, href, summary, zoneDropped: span.zoneDropped, stored: { kind: 'components', requests: [request] }, guests: false };
    /** The stored resource is this create: one VEVENT, our UID, exactly the requested lines, nothing else but stamps. */
    const isThisCreate = (resource: CalendarResource): { holds: boolean; differs: StoredField[] } => {
        const events = storedEvents(resource.calendarData);
        const [event, ...more] = events ?? [];
        const differs = orderedFields(differingFields(event?.rid === null ? event : undefined, request));
        const allowed = new Set([...fields.map(plan => plan.name), 'UID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE']);
        const same = event !== undefined && more.length === 0 && event.rid === null && differs.length === 0
            && event.lines.filter(line => line.name === 'UID').map(line => line.text).join('\n') === `UID:${uid}`
            && event.lines.every(line => allowed.has(line.name));
        // differs may be empty when only other lines or the structure differ.
        return { holds: same, differs };
    };

    const response = await sendOnce(deps, reporter, options => deps.backend.putEvent(deps.auth, deps.discovery, { calendarId, href, body, precondition: { kind: 'create' } }, options));
    const answer = classify(response);
    if (answer === 'applied') { return readBack(context, etagOf(response)); }
    const refused = refusal(answer, response);
    if (refused !== undefined) { throw refused; }
    if (answer === 'not_found') {
        // iCloud's answer to event data it refuses (an event without an end, measured): nothing was created.
        const upstream = upstreamOf(response);
        throw new WriteError('write_refused', upstream === undefined ? {} : { upstream });
    }
    const after = await reread(deps, reporter, calendarId, href);
    if (after.kind === 'found') {
        const check = isThisCreate(after.resource);
        if (check.holds) { return eventResult(context, 'desired_state_present', after.resource, null); }
        if (answer === 'precondition') { throw new WriteError('calendar_changed', { reason: 'existing_resource_differs', differs: orderedFields(check.differs) }); }
        throw new WriteError('outcome_unknown');
    }
    // 412 with nothing at the href: the UID is used elsewhere in the account (measured), or a concurrent delete.
    if (answer === 'precondition' && after.kind === 'absent') { throw new WriteError('create_conflict'); }
    throw new WriteError('outcome_unknown');
}

// ---- update_event ----

/** Input rules shared by every scope; returns the strong expected version. */
function checkScopeInput(input: UpdateEventArgs | DeleteEventArgs): StrongEtag {
    const expected = strongEtag(input.expected_version);
    if (expected === null) { throw invalid('schema'); }
    const occurrenceScope = input.edit_scope === 'this' || input.edit_scope === 'this_and_future';
    if (occurrenceScope && input.recurrence_id === undefined) { throw invalid('recurrence_id_required', 'recurrence_id'); }
    // A recurrence_id names one occurrence: without an occurrence scope the call would change more than the agent named.
    if (!occurrenceScope && input.recurrence_id !== undefined) { throw invalid('edit_scope_required', 'edit_scope'); }
    return expected;
}

/**
 * Changes a single event, a whole series (`all`, its time and rule included), one occurrence (`this`) or an occurrence and
 * the ones after it (`this_and_future`), conditional on `expected_version`.
 */
export async function updateEvent(deps: WriteDeps, input: UpdateEventArgs): Promise<WriteEventResult> {
    const { calendarId, href } = resourceTarget(input.calendar_id, input.resource_href);
    const expected = checkScopeInput(input);
    if (input.exceptions !== undefined && input.edit_scope !== 'all' && input.edit_scope !== 'this_and_future') { throw invalid('exceptions_not_allowed_here', 'exceptions'); }
    if (input.edit_scope === 'this_and_future' && input.operation_id === undefined) { throw invalid('operation_id_required', 'operation_id'); }
    const plan = planChanges(input.changes);
    const target = { calendarId, href, expected };
    if (input.edit_scope === 'this') { return updateOccurrence(deps, input, plan, target); }
    if (input.edit_scope === 'this_and_future') { return updateFollowing(deps, input, plan, target); }
    return updateWhole(deps, input, plan, target);
}

interface TargetComponent { selector: ComponentSelector; rid: string | null; component: EventComponent }

/** Every VEVENT of a series, the master first, with the selectors the editor needs. */
function seriesComponents(deps: WriteDeps, original: OriginalResource, text: string): TargetComponent[] {
    const master = original.master;
    if (master === null) { throw notSupported('occurrence_only_resource'); }
    let outlines: ReturnType<typeof describeEvents>;
    try { outlines = describeEvents(text, { work: parseWork(deps) }); } catch (error) { throw builderError(error); }
    const overrides = outlines.filter(outline => outline.recurrenceId !== null);
    if (overrides.length !== original.overrides.length) { throw unsupported('stored_data_not_editable'); }
    return [
        { selector: { kind: 'master' }, rid: null, component: master },
        ...overrides.map((outline, index) => {
            const component = original.overrides[index];
            const rid = outline.recurrenceId;
            if (component === undefined || rid === null) { throw unsupported('stored_data_not_editable'); }
            return { selector: { kind: 'override' as const, recurrenceId: rid }, rid, component };
        }),
    ];
}

/** The edits and expectation every selected component shares: the requested fields, alarms, a rule, the stamps. */
function sharedPlan(plan: ChangePlan, stamp: Stamp, rrule: WrittenProperty | null, withTimes: boolean): { edits: ComponentEdit[]; properties: PropertyExpectation[]; alarms: Pick<TargetExpectation, 'alarms'> } {
    const fields = withTimes ? [...plan.fields, ...plan.times] : plan.fields;
    const edits: ComponentEdit[] = fields.map(field => (field.property === null ? { op: 'remove', name: field.name } : { op: 'set', property: field.property }));
    const properties: PropertyExpectation[] = fields.map(field => field.expected);
    if (withTimes && plan.span !== undefined) {
        edits.push({ op: 'remove', name: 'DURATION' });
        properties.push({ name: 'DURATION', absent: true });
    }
    if (plan.alarms !== undefined) {
        edits.push({ op: 'remove_alarms' }, ...(plan.alarms?.components ?? []).map(alarm => ({ op: 'add_alarm' as const, alarm })));
    }
    if (rrule !== null) { edits.push({ op: 'set', property: rrule }); }
    edits.push(
        { op: 'set', property: timeProperty('DTSTAMP', { kind: 'utc', utc: stamp.basic }) },
        { op: 'set', property: timeProperty('LAST-MODIFIED', { kind: 'utc', utc: stamp.basic }) },
    );
    const alarms = plan.alarms === undefined ? {} : { alarms: plan.alarms === null ? { kind: 'removed' as const } : { kind: 'replaced' as const, alarms: plan.alarms.expected } };
    return { edits, properties, alarms };
}

/** ONE edit pass and ONE verification; the removed Apple companions as the editor reported them. */
function editAndVerify(deps: WriteDeps, text: string, plans: ComponentPlan[], resource: ResourceEdit[], expectation: EditExpectation): { body: string; removed: Companion[] } {
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

/** A single event (every field), or a whole series: without a time or rule change in place, else as a series move. */
async function updateWhole(deps: WriteDeps, input: UpdateEventArgs, plan: ChangePlan, target: { calendarId: string; href: string; expected: StrongEtag }): Promise<WriteEventResult> {
    const { calendarId, href, expected } = target;
    const stamp = stampOf(deps);
    const { summary, reporter } = await membership(deps, calendarId);
    const found = await readOriginalText(deps, reporter, calendarId, href);
    if (found === null) { throw new WriteError('not_found'); }
    const original = parseStored(deps, found.calendarData);
    const guests = attendeeGate(deps, found.calendarData);
    if (original.kind === 'occurrence_only' || original.master === null) { throw notSupported('occurrence_only_resource'); }
    const master = original.master;

    let plans: ComponentPlan[] = [];
    let resource: ResourceEdit[] = [];
    let expectation: EditExpectation;
    let stored: StoredExpectation;
    let fields: ResultContext['fields'] = {};
    let staleProvable = true;
    if (original.kind === 'single' || input.edit_scope !== 'all' || (plan.span === undefined && plan.recurrence === undefined)) {
        if (original.kind === 'series' && input.edit_scope !== 'all') { throw invalid('edit_scope_required', 'edit_scope'); }
        if (input.exceptions !== undefined) { throw invalid('exceptions_not_allowed_here', 'exceptions'); }
        // recurrence: null on a single event asks for what is already true; alone it is no change at all.
        if (original.kind === 'single' && plan.recurrence === null && plan.fields.length === 0 && plan.times.length === 0 && plan.alarms === undefined) { throw invalid('no_changes', 'changes'); }
        const selected = original.kind === 'single' ? [{ selector: { kind: 'master' } as const, rid: null, component: master }] : seriesComponents(deps, original, found.calendarData);
        // A repeating rule for a single event: UNTIL must fit the form of the (new or stored) start.
        let rrule: WrittenProperty | null = null;
        if (plan.recurrence !== undefined && plan.recurrence !== null) {
            const form: StartForm = plan.span?.start.kind ?? master.start.kind;
            try { rrule = rruleProperty(plan.recurrence.rrule, form, 'rrule'); } catch (error) { throw builderError(error); }
        }
        // A single event: its master. A whole series: every VEVENT of the resource as it is when compared, not the set read now.
        stored = original.kind === 'series'
            ? { kind: 'every_event', request: componentRequest(null, plan, rrule === null ? [] : [{ field: 'recurrence', name: 'RRULE', line: rrule.line }]) }
            : { kind: 'components', requests: [componentRequest(null, plan, rrule === null ? [] : [{ field: 'recurrence', name: 'RRULE', line: rrule.line }])] };
        if (original.kind === 'series') { fields = { overrides_changed: selected.length - 1 }; }
        let shared: ReturnType<typeof sharedPlan>;
        try { shared = sharedPlan(plan, stamp, rrule, true); } catch (error) { throw builderError(error); }
        const rule = plan.recurrence !== undefined && plan.recurrence !== null ? { rrule: plan.recurrence.rrule } : {};
        const expectations: TargetExpectation[] = [];
        for (const item of selected) {
            const sequence = nextSequence(item.component);
            plans.push({ target: item.selector, edits: [...shared.edits, { op: 'set', property: sequenceProperty(sequence) }] });
            expectations.push({ component: item.selector, properties: [...shared.properties, ...stampExpectations(stamp, sequence)], companionsRemoved: plan.companions, ...shared.alarms, ...rule });
        }
        expectation = { targets: expectations };
    } else {
        // A series move or rule change (design 3.6, probe P3D-1..3).
        let move: SeriesMovePlan;
        try {
            move = planSeriesMove({ deps, original, text: found.calendarData, plan, stamp, exceptions: input.exceptions });
        } catch (error) {
            // A stale version: what the current resource would need is no answer to this call; it changed.
            if (found.etag !== expected && !(error instanceof WriteError && error.code === 'invalid_input')) { throw new WriteError('calendar_changed', { reason: 'version_mismatch' }); }
            throw error;
        }
        ({ plans, resource, expectation, stored } = move);
        fields = move.fields;
        staleProvable = move.staleProvable;
    }
    const context: ResultContext = { deps, reporter, calendarId, href, summary, zoneDropped: plan.span?.zoneDropped ?? [], stored, guests, fields };

    if (found.etag !== expected) {
        // Never a PUT with the newer ETag: either the event already says what was asked, or it changed (ORCH B1).
        if (staleProvable && holds(found, stored)) { return eventResult(context, 'desired_state_present', found, null); }
        throw new WriteError('calendar_changed', { reason: 'version_mismatch' });
    }

    // ONE edit pass over the resource for every selected component and ONE verification of the result (batch-first: a pass
    // per component was quadratic in the series). Each component's edits and its expectation are built from the request.
    const { body, removed } = editAndVerify(deps, found.calendarData, plans, resource, expectation);
    const outcome = await putIfMatch(deps, reporter, { calendarId, href, body, expected }, resource => holds(resource, stored));
    if (outcome.kind === 'present') { return eventResult(context, 'desired_state_present', outcome.resource, null); }
    return readBack({ ...context, removedCompanions: removed }, outcome.etag);
}

// ---- delete_event ----

/** Deletes a whole resource (a single event or a whole series), one occurrence, or an occurrence and the ones after it. */
export async function deleteEvent(deps: WriteDeps, input: DeleteEventArgs): Promise<DeleteEventResult> {
    const { calendarId, href } = resourceTarget(input.calendar_id, input.resource_href);
    const expected = checkScopeInput(input);
    if (input.edit_scope === 'this') { return deleteOccurrence(deps, input, { calendarId, href, expected }); }
    if (input.edit_scope === 'this_and_future') { return deleteFollowing(deps, input, { calendarId, href, expected }); }
    return deleteResource(deps, input, { calendarId, href, expected });
}

async function deleteResource(deps: WriteDeps, input: DeleteEventArgs, target: { calendarId: string; href: string; expected: StrongEtag }): Promise<DeleteEventResult> {
    const { calendarId, href, expected } = target;
    const { summary, reporter } = await membership(deps, calendarId);
    const calendars: [ReturnType<typeof calendarStatus>] = [calendarStatus(calendarId, summary, 'ok')];
    const result = (outcome: DeleteEventResult['write_outcome'], guests: boolean): DeleteEventResult => ({
        write_outcome: outcome, deleted: 'resource', calendar_id: calendarId, resource_href: href,
        ...(guests ? GUEST_FIELDS : {}),
        calendars,
    });

    const found = await readOriginalText(deps, reporter, calendarId, href);
    // Nothing at the href: the requested state already holds (a retry after a lost answer, measured as 404; ORCH).
    if (found === null) { return result('desired_state_present', false); }
    const original = parseStored(deps, found.calendarData);
    const guests = attendeeGate(deps, found.calendarData);
    if (original.kind !== 'single' && input.edit_scope !== 'all') { throw invalid('edit_scope_required', 'edit_scope'); }
    if (found.etag !== expected) { throw new WriteError('calendar_changed', { reason: 'version_mismatch' }); }

    const response = await sendOnce(deps, reporter, options => deps.backend.deleteEvent(deps.auth, deps.discovery, { calendarId, href, etag: expected }, options));
    return classifyDelete(deps, reporter, response, { calendarId, href }, guests, result);
}

async function classifyDelete(
    deps: WriteDeps, reporter: UnauthorizedReporter, response: Awaited<ReturnType<typeof sendOnce>>, target: { calendarId: string; href: string }, guests: boolean,
    result: (outcome: DeleteEventResult['write_outcome'], guests: boolean) => DeleteEventResult,
): Promise<DeleteEventResult> {
    const answer = classify(response);
    if (answer === 'applied') { return result('applied', guests); }
    const refused = refusal(answer, response);
    if (refused !== undefined) { throw refused; }
    const after = await reread(deps, reporter, target.calendarId, target.href);
    if (after.kind === 'absent') { return result('desired_state_present', guests); }
    if (after.kind === 'found' && answer === 'precondition') { throw new WriteError('calendar_changed', { reason: 'precondition_failed' }); }
    if (after.kind === 'found' && answer === 'not_found') { throw new WriteError('upstream_error'); }
    throw new WriteError('outcome_unknown');
}
