/**
 * Write orchestration for `create_event`, `update_event` and `delete_event` (phase 3 design v2 sections 4-6, arbitration
 * B1/B2/S3, addendum 1). Release scope: create (single or repeating), update of a single event (every field) or of a
 * whole series without a time or rule change (`edit_scope: "all"`), delete of a whole resource. The occurrence scopes
 * follow; the target rules (`targets`) and the per-component plans are where they will plug in.
 *
 * Every call: membership listing → (edits) one multiget of the original, the attendee gate, the target rules and the
 * version check → the text, built by ics-write or ics-edit → the MANDATORY intent gate (`verifyCreateOutcome` /
 * `verifyEditOutcome`) with an expectation derived from the request, never from the builder's report → a deadline guard
 * → ONE conditional request → classification. There is no server-side retry of a write, ever (ORCH B1): a 412 or an
 * uncertain answer is followed by one re-read and a comparison of the requested values with the stored raw text.
 * `write_outcome` is separate from the read-back (ORCH B2): a 2xx is `applied` even when the read-back fails, and after
 * a request was sent, absence or an unchanged ETag never proves that nothing was applied.
 *
 * Identity of a create: UID and href derive from (account, operation_id), so a retry hits the same href and
 * `If-None-Match: *` makes it idempotent; no marker is stored in the event (ORCH B1).
 */
import { createHash } from 'node:crypto';
import { CalDavError, type CalDavAuth, type CalendarSummary, type Discovery } from '../caldav/contracts';
import { isDirectChildResource } from '../caldav/identifiers';
import type { CalDavReadBackend, CalendarResource } from '../caldav/read-contracts';
import { strongEtag, type CalDavWriteBackend, type StrongEtag, type UpstreamDetail, type WriteCallOptions, type WriteResponse } from '../caldav/write-contracts';
import type { ReadBudget } from './budget';
import { describeEvents, editResource, IcsEditError, type ComponentEdit, type ComponentSelector } from './ics-edit';
import {
    verifyCreateOutcome, verifyEditOutcome, type Companion, type CreateExpectation, type ExpectedAlarm, type ExpectedProperty, type OutcomeVerdict, type PropertyExpectation, type TargetExpectation,
} from './ics-verify';
import {
    ALARM_DESCRIPTION, buildCreateResource, displayAlarm, IcsWriteError, MAX_SEQUENCE, rruleProperty, sequenceProperty, statusProperty, textProperty, timeProperty, transparencyProperty,
    travelDurationProperty, type StartForm, type TextPropertyName, type WrittenComponent, type WrittenProperty,
} from './ics-write';
import { parseOriginalResource } from './ical';
import { DAV_LAMBDA_RESERVE_MS, DAV_REQUEST_MS } from './limits';
import { BudgetError, IcalError, isCanonicalPath, type EventComponent, type OriginalResource } from './model';
import { calendarStatus, originalEventView, readCalendarMembership, readStoredResource, ReadError, type ReadDeps, type UnauthorizedReporter } from './read';
import type { ToolErrorCode } from './schemas';
import { formatInstant } from './time-core';
import { differingFields, holdsRequest, normaliseLine, storedComponent, storedEvents, type ComponentRequest, type FieldLine } from './write-compare';
import {
    GUEST_NOTICE, STORED_FIELDS, type CreateEventArgs, type DeleteEventArgs, type DeleteEventResult, type StoredField, type UpdateChanges, type UpdateEventArgs, type WriteErrorField,
    type WriteErrorReason, type WriteEventResult,
} from './write-schemas';
import { parseWriteSpan, WriteTimeError, type ClientTime, type WriteSpan } from './write-time';

export interface WriteDeps {
    backend: CalDavReadBackend & CalDavWriteBackend;
    auth: CalDavAuth;
    discovery: Discovery;
    /** Authenticated pseudonymous account id; part of every create's identity. */
    accountId: string;
    budget: ReadBudget;
    onUnauthorized?: () => Promise<void>;
    /** Server clock in epoch milliseconds: DTSTAMP, LAST-MODIFIED and CREATED. */
    now: () => number;
    /** Scopes this connection was granted. `calendar:invite` opens the attendee gate. */
    scopes: readonly string[];
}

export interface WriteErrorExtra {
    reason?: WriteErrorReason;
    field?: WriteErrorField;
    /** Sanitised summary of iCloud's answer; its detail is untrusted text. */
    upstream?: UpstreamDetail;
    /** existing_resource_differs: the requested fields the existing resource does not hold. */
    differs?: StoredField[];
}

/** A fixed, sanitised write failure. Carries enums, counts and the sanitised upstream summary only. */
export class WriteError extends Error {
    constructor(public readonly code: ToolErrorCode, public readonly extra: WriteErrorExtra = {}) { super(code); }
}

const INVITE_SCOPE = 'calendar:invite';
const GUEST_FIELDS = { guests_may_be_emailed: true, guest_notice: GUEST_NOTICE } as const;
/** A request is sent only with time for it and one re-read left (design 5.3). */
export const WRITE_SEND_RESERVE_MS = 2 * DAV_REQUEST_MS + DAV_LAMBDA_RESERVE_MS;
const NEED_PRIVILEGES = '{DAV:}need-privileges';

const invalid = (reason: WriteErrorReason, field?: WriteErrorField): WriteError => new WriteError('invalid_input', { reason, ...(field === undefined ? {} : { field }) });
const unsupported = (reason: WriteErrorReason): WriteError => new WriteError('unsupported_calendar_data', { reason });

// ---- Identity, clock and values ----

/** `cmcp1-` + 32 characters of base64url(SHA-256) over the account and the client's operation id (design 5.2). */
export function deterministicUid(accountId: string, operationId: string): string {
    const digest = createHash('sha256').update(`caldav-mcp/uid/v1\0${accountId}\0${operationId}`, 'utf8').digest('base64url');
    return `cmcp1-${digest.slice(0, 32)}`;
}

interface Stamp { basic: string; jcal: string }

function stampOf(deps: WriteDeps): Stamp {
    const ms = deps.now();
    const jcal = Number.isSafeInteger(ms) ? formatInstant(BigInt(ms) * 1_000_000n) : null;
    if (jcal === null) { throw new WriteError('temporarily_unavailable'); }
    return { jcal, basic: jcal.replaceAll(/[-:]/gu, '') };
}

/** `YYYYMMDD[THHMMSS[Z]]` basic digits as the parser reports them: `YYYY-MM-DD[THH:MM:SS[Z]]`. */
function jcalOf(basic: string): string {
    const date = `${basic.slice(0, 4)}-${basic.slice(4, 6)}-${basic.slice(6, 8)}`;
    return basic.length === 8 ? date : `${date}T${basic.slice(9, 11)}:${basic.slice(11, 13)}:${basic.slice(13, 15)}${basic.endsWith('Z') ? 'Z' : ''}`;
}

/** The decoded value the parser will report for a client time, derived from the request (not from written text). */
function expectedTime(name: 'DTSTART' | 'DTEND', time: ClientTime): ExpectedProperty {
    switch (time.kind) {
        case 'utc': return { name, type: 'date-time', values: [jcalOf(time.utc)] };
        case 'zoned': return { name, type: 'date-time', values: [jcalOf(time.local)], params: { tzid: [time.tzid] } };
        case 'date': return { name, type: 'date', values: [jcalOf(time.date)] };
    }
}

/** TEXT as the parser decodes it: a written line break (CRLF, CR or LF) reads back as LF. */
const expectedText = (name: string, value: string): ExpectedProperty => ({ name, type: 'text', values: [value.replaceAll(/\r\n|\r/gu, '\n')] });
const stampExpectations = (stamp: Stamp, sequence: number): ExpectedProperty[] => [
    { name: 'DTSTAMP', type: 'date-time', values: [stamp.jcal] },
    { name: 'LAST-MODIFIED', type: 'date-time', values: [stamp.jcal] },
    { name: 'SEQUENCE', type: 'integer', values: [sequence] },
];

// ---- Errors from the pure builders ----

const FIELD_NAMES: ReadonlySet<string> = new Set<WriteErrorField>(['title', 'location', 'description', 'status', 'transparency', 'alarms', 'start', 'end', 'recurrence', 'travel_time']);

function builderError(error: unknown): WriteError {
    if (error instanceof WriteError) { return error; }
    if (error instanceof WriteTimeError) { return invalid(error.reason, error.field); }
    if (error instanceof IcsWriteError) {
        const field = error.field === 'rrule' ? 'recurrence' : error.field;
        const known = field !== null && FIELD_NAMES.has(field) ? field as WriteErrorField : undefined;
        switch (error.reason) {
            case 'text_not_representable':
            case 'text_too_long': return invalid('text_not_representable', known);
            case 'zone_not_representable': return invalid('zone_not_representable', known);
            case 'time_invalid':
            case 'time_form_not_allowed': return invalid('time_invalid', known);
            case 'start_end_kind_mismatch': return invalid('start_end_kind_mismatch', 'end');
            case 'trigger_invalid':
            case 'too_many_alarms': return invalid('alarm_invalid', 'alarms');
            case 'travel_invalid': return invalid('travel_time_invalid', 'travel_time');
            case 'rrule_until_form': return invalid('rrule_until_form', 'recurrence');
            case 'rrule_too_long':
            case 'rrule_syntax':
            case 'rrule_unknown_part':
            case 'rrule_duplicate_part':
            case 'rrule_value':
            case 'rrule_freq_missing':
            case 'rrule_until_count': return invalid('rrule_invalid', 'recurrence');
            case 'sequence_invalid': return unsupported('sequence_unsupported');
            default: return unsupported('self_verification_failed');
        }
    }
    if (error instanceof IcsEditError) {
        return unsupported(['value_not_written', 'conflicting_edits', 'output_invalid'].includes(error.reason) ? 'self_verification_failed' : 'stored_data_not_editable');
    }
    return unsupported('self_verification_failed');
}

/** The intent gate: a refusal is a server defect or an unexpected stored shape, and nothing is sent. */
function requireVerified(verdict: OutcomeVerdict): void {
    if (!verdict.ok) { throw unsupported('self_verification_failed'); }
}

// ---- Reads ----

function readFailure(error: unknown): WriteError {
    if (error instanceof WriteError) { return error; }
    if (error instanceof ReadError) { return new WriteError(error.code); }
    if (error instanceof BudgetError) { return new WriteError(error.kind === 'deadline' ? 'temporarily_unavailable' : 'result_too_large'); }
    if (error instanceof CalDavError && error.code === 'unauthorized') { return new WriteError('reconnect_required'); }
    return new WriteError('temporarily_unavailable');
}

async function membership(deps: WriteDeps, calendarId: string): Promise<{ summary: CalendarSummary; reporter: UnauthorizedReporter }> {
    let read: Awaited<ReturnType<typeof readCalendarMembership>>;
    try { read = await readCalendarMembership(deps satisfies ReadDeps); } catch (error) { throw readFailure(error); }
    const summary = read.members.get(calendarId);
    if (summary === undefined) { throw new WriteError('not_found'); }
    return { summary, reporter: read.reporter };
}

async function readOriginalText(deps: WriteDeps, reporter: UnauthorizedReporter, calendarId: string, href: string): Promise<CalendarResource | null> {
    try { return await readStoredResource(deps, reporter, calendarId, href); } catch (error) { throw readFailure(error); }
}

type Reread = { kind: 'found'; resource: CalendarResource } | { kind: 'absent' } | { kind: 'failed' };

/** The one re-read after a request was sent. Never throws: a failed read is an answer of its own. */
async function reread(deps: WriteDeps, reporter: UnauthorizedReporter, calendarId: string, href: string): Promise<Reread> {
    try {
        const resource = await readStoredResource(deps, reporter, calendarId, href);
        return resource === null ? { kind: 'absent' } : { kind: 'found', resource };
    } catch {
        return { kind: 'failed' };
    }
}

function parseStored(deps: WriteDeps, text: string): OriginalResource {
    try {
        return parseOriginalResource(text, { work: deps.budget.newResourceWork() });
    } catch (error) {
        if (error instanceof BudgetError) { throw new WriteError(error.kind === 'deadline' ? 'temporarily_unavailable' : 'result_too_large'); }
        if (error instanceof IcalError && error.reason === 'resource_too_large') { throw new WriteError('result_too_large'); }
        throw unsupported('stored_data_not_editable');
    }
}

function components(original: OriginalResource): EventComponent[] {
    return [...(original.master === null ? [] : [original.master]), ...original.overrides];
}

/** ATTENDEE or ORGANIZER in any VEVENT: iCloud emails guests on every change or delete (probe Run 8). */
function hasGuests(original: OriginalResource): boolean {
    return components(original).some(component => component.properties.has('attendee') || component.properties.has('organizer'));
}

/** Refuses an event with guests unless the user ticked the invitation permission (addendum 1). */
function attendeeGate(deps: WriteDeps, original: OriginalResource): boolean {
    const guests = hasGuests(original);
    if (guests && !deps.scopes.includes(INVITE_SCOPE)) { throw new WriteError('attendees_present', { reason: 'may_send_invitations' }); }
    return guests;
}

// ---- Sending and classifying ----

type Answer = 'applied' | 'precondition' | 'not_found' | 'forbidden' | 'busy' | 'redirected' | 'refused' | 'unknown';

/** Design 5.3: 202, 5xx (but 507) and an uncertain send are unknown; other 4xx and 507 are refusals. */
function classify(response: WriteResponse): Answer {
    if (response.kind === 'uncertain') { return 'unknown'; }
    if (response.kind === 'redirected') { return 'redirected'; }
    const { status } = response;
    if (status === 202) { return 'unknown'; }
    if (status >= 200 && status < 300) { return 'applied'; }
    if (status === 412) { return 'precondition'; }
    if (status === 404) { return 'not_found'; }
    if (status === 403) { return 'forbidden'; }
    if (status === 423 || status === 429) { return 'busy'; }
    if (status === 507) { return 'refused'; }
    return status >= 500 ? 'unknown' : 'refused';
}

const upstreamOf = (response: WriteResponse): UpstreamDetail | undefined => (response.kind === 'status' ? response.upstream : undefined);
const etagOf = (response: WriteResponse): StrongEtag | null => (response.kind === 'status' ? response.etag : null);

/** The fixed error for a definitive refusal; `undefined` for the answers the caller must resolve itself. */
function refusal(answer: Answer, response: WriteResponse): WriteError | undefined {
    const upstream = upstreamOf(response);
    const withUpstream = upstream === undefined ? {} : { upstream };
    switch (answer) {
        case 'forbidden': return new WriteError(upstream?.preconditions.includes(NEED_PRIVILEGES) === true ? 'read_only_calendar' : 'forbidden', withUpstream);
        case 'busy': return new WriteError('temporarily_unavailable');
        case 'redirected': return new WriteError('upstream_error');
        case 'refused': return new WriteError('write_refused', withUpstream);
        default: return undefined;
    }
}

/** One conditional request, only with time for it and a re-read left. Failures before sending are fixed errors. */
async function sendOnce(deps: WriteDeps, reporter: UnauthorizedReporter, request: (options: WriteCallOptions) => Promise<WriteResponse>): Promise<WriteResponse> {
    if (deps.budget.workRemainingMs() < WRITE_SEND_RESERVE_MS) { throw new WriteError('temporarily_unavailable'); }
    let options: WriteCallOptions;
    try { options = { signal: deps.budget.signal, deadlineMs: deps.budget.requestTimeoutMs() }; } catch { throw new WriteError('temporarily_unavailable'); }
    try {
        return await request(options);
    } catch (error) {
        if (error instanceof CalDavError && error.code === 'unauthorized') {
            // iCloud rejected the stored password; the write is never re-sent.
            reporter.report();
            await reporter.settled();
            throw new WriteError('reconnect_required');
        }
        // Refused before sending: nothing was applied.
        throw new WriteError(error instanceof CalDavError && error.code !== 'temporary' ? 'upstream_error' : 'temporarily_unavailable');
    }
}

// ---- Results ----

interface ResultContext {
    deps: WriteDeps;
    calendarId: string;
    href: string;
    summary: CalendarSummary;
    zoneDropped: readonly ('start' | 'end')[];
    requests: readonly ComponentRequest[];
    guests: boolean;
    removedCompanions?: readonly Companion[] | undefined;
    overridesChanged?: number | undefined;
}

function orderedFields(fields: Iterable<StoredField>): StoredField[] {
    const set = new Set(fields);
    return STORED_FIELDS.filter(field => set.has(field));
}

function storedDiffers(text: string, requests: readonly ComponentRequest[]): StoredField[] {
    const events = storedEvents(text);
    return orderedFields(requests.flatMap(request => differingFields(events === null ? undefined : storedComponent(events, request.rid), request)));
}

/** The result with the stored event as get_event shows it, or with `readback: "unavailable"` when that cannot be built. */
function eventResult(context: ResultContext, outcome: WriteEventResult['write_outcome'], resource: CalendarResource | null, answerEtag: StrongEtag | null): WriteEventResult {
    const removed = context.removedCompanions ?? [];
    const base = {
        write_outcome: outcome,
        calendar_id: context.calendarId,
        resource_href: context.href,
        request_warnings: context.zoneDropped.map(field => ({ field, timezone_warning: 'timezone_dropped_from_date' as const })),
        removed_dependent_properties: outcome === 'applied' ? [...removed] : [],
        ...(outcome === 'applied' && removed.includes('X-APPLE-STRUCTURED-LOCATION') ? { removed_apple_location_pin: true as const } : {}),
        ...(context.overridesChanged === undefined ? {} : { overrides_changed: context.overridesChanged }),
        ...(context.guests ? GUEST_FIELDS : {}),
    };
    if (resource !== null) {
        try {
            const original = parseOriginalResource(resource.calendarData, { work: context.deps.budget.newResourceWork() });
            const view = originalEventView(context.calendarId, context.summary, resource, original);
            return { ...base, readback: 'ok', expected_version: resource.etag, stored_differs_from_request: storedDiffers(resource.calendarData, context.requests), calendars: view.calendars, event: view.event };
        } catch {
            // The change stands; only its presentation failed.
        }
    }
    return { ...base, readback: 'unavailable', expected_version: answerEtag, stored_differs_from_request: null, calendars: [calendarStatus(context.calendarId, context.summary, 'ok')], event: null };
}

async function readBack(context: ResultContext, reporter: UnauthorizedReporter, answerEtag: StrongEtag | null): Promise<WriteEventResult> {
    const found = await reread(context.deps, reporter, context.calendarId, context.href);
    return eventResult(context, 'applied', found.kind === 'found' ? found.resource : null, answerEtag);
}

// ---- Identifiers ----

function collection(calendarId: string): string {
    if (!isCanonicalPath(calendarId) || !calendarId.endsWith('/')) { throw invalid('schema'); }
    return calendarId;
}

function resourceTarget(calendarId: string, href: string): { calendarId: string; href: string } {
    collection(calendarId);
    if (!isDirectChildResource(calendarId, href)) { throw invalid('schema'); }
    return { calendarId, href };
}

// ---- Requested properties ----

interface FieldPlan {
    field: StoredField;
    name: string;
    property: WrittenProperty | null;
    expected: PropertyExpectation;
}

function textField(field: StoredField, name: TextPropertyName, value: string | null): FieldPlan {
    return value === null
        ? { field, name, property: null, expected: { name, absent: true } }
        : { field, name, property: textProperty(name, value, field), expected: expectedText(name, value) };
}

interface AlarmPlan { components: WrittenComponent[]; expected: ExpectedAlarm[]; triggers: string[] }

function alarmPlan(alarms: readonly { before_start: string }[]): AlarmPlan {
    const built = alarms.map(alarm => displayAlarm(alarm.before_start, 'alarms'));
    return {
        components: built,
        expected: alarms.map(alarm => ({ trigger: `-${alarm.before_start}`, description: ALARM_DESCRIPTION })),
        triggers: alarms.map(alarm => `TRIGGER:-${alarm.before_start}`),
    };
}

function spanOf(start: unknown, end: unknown): WriteSpan {
    try { return parseWriteSpan(start, end); } catch (error) { throw builderError(error); }
}

const fieldLine = (plan: FieldPlan): FieldLine => ({ field: plan.field, name: plan.name, line: plan.property?.line ?? null });

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
    requireVerified(verifyCreateOutcome(body, expectation));

    const request: ComponentRequest = { rid: null, fields: fields.map(fieldLine), triggers: alarm.triggers };
    const { summary, reporter } = await membership(deps, calendarId);
    const context: ResultContext = { deps, calendarId, href, summary, zoneDropped: span.zoneDropped, requests: [request], guests: false };
    /** The stored resource is this create: one VEVENT, our UID, exactly the requested lines, nothing else but stamps. */
    const holds = (resource: CalendarResource): { holds: boolean; differs: StoredField[] } => {
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
    if (answer === 'applied') { return readBack(context, reporter, etagOf(response)); }
    const refused = refusal(answer, response);
    if (refused !== undefined) { throw refused; }
    if (answer === 'not_found') {
        // iCloud's answer to event data it refuses (an event without an end, measured): nothing was created.
        const upstream = upstreamOf(response);
        throw new WriteError('write_refused', upstream === undefined ? {} : { upstream });
    }
    const after = await reread(deps, reporter, calendarId, href);
    if (after.kind === 'found') {
        const check = holds(after.resource);
        if (check.holds) { return eventResult(context, 'desired_state_present', after.resource, null); }
        if (answer === 'precondition') { throw new WriteError('calendar_changed', { reason: 'existing_resource_differs', differs: orderedFields(check.differs) }); }
        throw new WriteError('outcome_unknown');
    }
    // 412 with nothing at the href: the UID is used elsewhere in the account (measured), or a concurrent delete.
    if (answer === 'precondition' && after.kind === 'absent') { throw new WriteError('create_conflict'); }
    throw new WriteError('outcome_unknown');
}

// ---- update_event ----

interface ChangePlan {
    fields: FieldPlan[];
    span: WriteSpan | undefined;
    /** Undefined: alarms unchanged; null: every alarm removed. */
    alarms: AlarmPlan | null | undefined;
    /** Undefined: no recurrence key; null: `recurrence: null`. */
    recurrence: { rrule: string } | null | undefined;
    companions: Companion[];
}

/** Everything the request asks for that needs no stored data. Throws invalid_input. */
function planChanges(changes: UpdateChanges): ChangePlan {
    const keys = (Object.keys(changes) as (keyof UpdateChanges)[]).filter(key => changes[key] !== undefined);
    if (keys.length === 0) { throw invalid('no_changes', 'changes'); }
    if ((changes.start === undefined) !== (changes.end === undefined)) { throw invalid('start_end_must_change_together', changes.start === undefined ? 'start' : 'end'); }
    try {
        const fields: FieldPlan[] = [];
        if (changes.title !== undefined) { fields.push(textField('title', 'SUMMARY', changes.title)); }
        if (changes.location !== undefined) { fields.push(textField('location', 'LOCATION', changes.location)); }
        if (changes.description !== undefined) { fields.push(textField('description', 'DESCRIPTION', changes.description)); }
        if (changes.status !== undefined) {
            fields.push(changes.status === null
                ? { field: 'status', name: 'STATUS', property: null, expected: { name: 'STATUS', absent: true } }
                : { field: 'status', name: 'STATUS', property: statusProperty(changes.status, 'status'), expected: expectedText('STATUS', changes.status) });
        }
        if (changes.transparency !== undefined) {
            fields.push(changes.transparency === null
                ? { field: 'transparency', name: 'TRANSP', property: null, expected: { name: 'TRANSP', absent: true } }
                : { field: 'transparency', name: 'TRANSP', property: transparencyProperty(changes.transparency, 'transparency'), expected: expectedText('TRANSP', changes.transparency) });
        }
        if (changes.travel_time !== undefined) {
            fields.push(changes.travel_time === null
                ? { field: 'travel_time', name: 'X-APPLE-TRAVEL-DURATION', property: null, expected: { name: 'X-APPLE-TRAVEL-DURATION', absent: true } }
                : { field: 'travel_time', name: 'X-APPLE-TRAVEL-DURATION', property: travelDurationProperty(changes.travel_time, 'travel_time'), expected: { name: 'X-APPLE-TRAVEL-DURATION', type: 'duration', values: [changes.travel_time] } });
        }
        let span: WriteSpan | undefined;
        if (changes.start !== undefined) {
            span = parseWriteSpan(changes.start, changes.end);
            fields.push(
                { field: 'start', name: 'DTSTART', property: timeProperty('DTSTART', span.start, 'start'), expected: expectedTime('DTSTART', span.start) },
                { field: 'end', name: 'DTEND', property: timeProperty('DTEND', span.end, 'end'), expected: expectedTime('DTEND', span.end) },
            );
        }
        const alarms = changes.alarms === undefined ? undefined : changes.alarms === null || changes.alarms.length === 0 ? null : alarmPlan(changes.alarms);
        const companions: Companion[] = [];
        if (changes.location !== undefined) { companions.push('X-APPLE-STRUCTURED-LOCATION'); }
        if (changes.description !== undefined) { companions.push('X-ALT-DESC'); }
        return { fields, span, alarms, recurrence: changes.recurrence, companions };
    } catch (error) {
        throw builderError(error);
    }
}

interface TargetComponent { selector: ComponentSelector; rid: string | null; component: EventComponent }

/** The target rules of this release (design 4.3, addendum 1). The occurrence scopes add their rows here. */
function targets(original: OriginalResource, text: string, scope: 'all' | undefined, plan: ChangePlan): TargetComponent[] {
    if (original.kind === 'occurrence_only' || original.master === null) { throw new WriteError('edit_not_supported', { reason: 'occurrence_only_resource' }); }
    if (original.kind === 'single') {
        // recurrence: null on a single event asks for what is already true; alone it is no change at all.
        if (plan.recurrence === null && plan.fields.length === 0 && plan.alarms === undefined) { throw invalid('no_changes', 'changes'); }
        return [{ selector: { kind: 'master' }, rid: null, component: original.master }];
    }
    if (scope !== 'all') { throw invalid('edit_scope_required', 'edit_scope'); }
    if (plan.span !== undefined) { throw new WriteError('edit_not_supported', { reason: 'series_time_change_not_supported' }); }
    if (plan.recurrence !== undefined) { throw new WriteError('edit_not_supported', { reason: 'series_rule_change_not_supported' }); }
    let outlines: ReturnType<typeof describeEvents>;
    try { outlines = describeEvents(text); } catch (error) { throw builderError(error); }
    const overrides = outlines.filter(outline => outline.recurrenceId !== null);
    if (overrides.length !== original.overrides.length) { throw unsupported('stored_data_not_editable'); }
    return [
        { selector: { kind: 'master' }, rid: null, component: original.master },
        ...overrides.map((outline, index) => {
            const component = original.overrides[index];
            const rid = outline.recurrenceId;
            if (component === undefined || rid === null) { throw unsupported('stored_data_not_editable'); }
            return { selector: { kind: 'override' as const, recurrenceId: rid }, rid, component };
        }),
    ];
}

/** The stored SEQUENCE plus one (1 when absent); a value this server cannot increment is unsupported data. */
function nextSequence(component: EventComponent): number {
    const list = component.properties.get('sequence') ?? [];
    if (list.length === 0) { return 1; }
    const value = list.length === 1 ? list[0]?.values[0] : undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= MAX_SEQUENCE) { throw unsupported('sequence_unsupported'); }
    return value + 1;
}

function componentRequest(rid: string | null, plan: ChangePlan, recurrenceLine: string | null): ComponentRequest {
    return {
        rid: rid === null ? null : normaliseLine(rid),
        fields: [...plan.fields.map(fieldLine), ...(recurrenceLine === null ? [] : [{ field: 'recurrence' as const, name: 'RRULE', line: recurrenceLine }])],
        ...(plan.alarms === undefined ? {} : { triggers: plan.alarms?.triggers ?? [] }),
        absent: plan.companions,
    };
}

/** Changes a single event or a whole series without a time or rule change, conditional on `expected_version`. */
export async function updateEvent(deps: WriteDeps, input: UpdateEventArgs): Promise<WriteEventResult> {
    const { calendarId, href } = resourceTarget(input.calendar_id, input.resource_href);
    const expected = strongEtag(input.expected_version);
    if (expected === null) { throw invalid('schema'); }
    const plan = planChanges(input.changes);
    const stamp = stampOf(deps);

    const { summary, reporter } = await membership(deps, calendarId);
    const found = await readOriginalText(deps, reporter, calendarId, href);
    if (found === null) { throw new WriteError('not_found'); }
    const original = parseStored(deps, found.calendarData);
    const guests = attendeeGate(deps, original);
    const selected = targets(original, found.calendarData, input.edit_scope, plan);

    // A repeating rule for a single event: UNTIL must fit the form of the (new or stored) start.
    let rrule: WrittenProperty | null = null;
    if (plan.recurrence !== undefined && plan.recurrence !== null) {
        const master = original.master;
        const form: StartForm | undefined = plan.span?.start.kind ?? master?.start.kind;
        try { rrule = rruleProperty(plan.recurrence.rrule, form ?? 'utc', 'rrule'); } catch (error) { throw builderError(error); }
    }
    const requests = selected.map(target => componentRequest(target.rid, plan, rrule?.line ?? null));
    const context: ResultContext = {
        deps, calendarId, href, summary, zoneDropped: plan.span?.zoneDropped ?? [], requests, guests,
        ...(original.kind === 'series' ? { overridesChanged: selected.length - 1 } : {}),
    };

    if (found.etag !== expected) {
        // Never a PUT with the newer ETag: either the event already says what was asked, or it changed (ORCH B1).
        if (holdsRequest(storedEvents(found.calendarData), requests)) { return eventResult(context, 'desired_state_present', found, null); }
        throw new WriteError('calendar_changed', { reason: 'version_mismatch' });
    }

    let body = found.calendarData;
    const removed = new Set<Companion>();
    try {
        for (const target of selected) {
            const sequence = nextSequence(target.component);
            const edits: ComponentEdit[] = plan.fields.map(field => (field.property === null ? { op: 'remove', name: field.name } : { op: 'set', property: field.property }));
            const properties: PropertyExpectation[] = plan.fields.map(field => field.expected);
            if (plan.span !== undefined) {
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
                { op: 'set', property: sequenceProperty(sequence) },
            );
            properties.push(...stampExpectations(stamp, sequence));
            const expectation: TargetExpectation = {
                component: target.selector,
                properties,
                companionsRemoved: plan.companions,
                ...(plan.alarms === undefined ? {} : { alarms: plan.alarms === null ? { kind: 'removed' as const } : { kind: 'replaced' as const, alarms: plan.alarms.expected } }),
                ...(plan.recurrence !== undefined && plan.recurrence !== null ? { rrule: plan.recurrence.rrule } : {}),
            };
            const next = editResource(body, { target: target.selector, edits });
            requireVerified(verifyEditOutcome(body, next.text, { target: expectation }));
            for (const change of next.report.changes) {
                if (change.reason === 'paired' && (change.name === 'X-APPLE-STRUCTURED-LOCATION' || change.name === 'X-ALT-DESC')) { removed.add(change.name); }
            }
            body = next.text;
        }
    } catch (error) {
        throw builderError(error);
    }
    const applied: ResultContext = { ...context, removedCompanions: (['X-APPLE-STRUCTURED-LOCATION', 'X-ALT-DESC'] as const).filter(name => removed.has(name)) };

    const response = await sendOnce(deps, reporter, options => deps.backend.putEvent(deps.auth, deps.discovery, { calendarId, href, body, precondition: { kind: 'match', etag: expected } }, options));
    const answer = classify(response);
    if (answer === 'applied') { return readBack(applied, reporter, etagOf(response)); }
    const refused = refusal(answer, response);
    if (refused !== undefined) { throw refused; }
    const after = await reread(deps, reporter, calendarId, href);
    const present = after.kind === 'found' && holdsRequest(storedEvents(after.resource.calendarData), requests);
    if (answer === 'not_found') {
        if (after.kind === 'absent') { throw new WriteError('not_found'); }
        const upstream = upstreamOf(response);
        throw new WriteError('write_refused', upstream === undefined ? {} : { upstream });
    }
    if (present && after.kind === 'found') { return eventResult(context, 'desired_state_present', after.resource, null); }
    if (answer === 'precondition') {
        if (after.kind === 'absent') { throw new WriteError('not_found'); }
        if (after.kind === 'found') { throw new WriteError('calendar_changed', { reason: 'precondition_failed' }); }
        throw new WriteError('outcome_unknown');
    }
    // Unknown: a changed ETag without the requested values is someone else's change; anything else stays unknown.
    if (after.kind === 'found' && after.resource.etag !== expected) { throw new WriteError('calendar_changed', { reason: 'precondition_failed' }); }
    throw new WriteError('outcome_unknown');
}

// ---- delete_event ----

/** Deletes a whole resource (a single event or a whole series), conditional on `expected_version`. */
export async function deleteEvent(deps: WriteDeps, input: DeleteEventArgs): Promise<DeleteEventResult> {
    const { calendarId, href } = resourceTarget(input.calendar_id, input.resource_href);
    const expected = strongEtag(input.expected_version);
    if (expected === null) { throw invalid('schema'); }
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
    const guests = attendeeGate(deps, original);
    if (original.kind !== 'single' && input.edit_scope !== 'all') { throw invalid('edit_scope_required', 'edit_scope'); }
    if (found.etag !== expected) { throw new WriteError('calendar_changed', { reason: 'version_mismatch' }); }

    const response = await sendOnce(deps, reporter, options => deps.backend.deleteEvent(deps.auth, deps.discovery, { calendarId, href, etag: expected }, options));
    const answer = classify(response);
    if (answer === 'applied') { return result('applied', guests); }
    const refused = refusal(answer, response);
    if (refused !== undefined) { throw refused; }
    const after = await reread(deps, reporter, calendarId, href);
    if (after.kind === 'absent') { return result('desired_state_present', guests); }
    if (after.kind === 'found' && answer === 'precondition') { throw new WriteError('calendar_changed', { reason: 'precondition_failed' }); }
    if (after.kind === 'found' && answer === 'not_found') { throw new WriteError('upstream_error'); }
    throw new WriteError('outcome_unknown');
}
