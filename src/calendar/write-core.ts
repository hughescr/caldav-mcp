/**
 * Shared machinery of the write tools (phase 3 design v2 sections 4-6, arbitration B1/B2/S3, addendum 1): identity, the
 * clock, request-derived expectations, the builders' error mapping, the reads, the attendee gate, ONE conditional send and
 * its classification, and the result with its read-back. The flows (create, update, delete and the occurrence scopes)
 * live in write.ts, write-occurrence.ts, write-split.ts and write-move.ts and build only on this module.
 *
 * Rules every flow keeps: every parse checks the invocation's deadline first and charges its shared work caps; the MANDATORY
 * intent gate (`verifyCreateOutcome`, `verifyEditOutcome` or `verifyDerivedOutcome`) runs before every PUT with an
 * expectation derived from the request (and iCloud's text), never from the builder's report; a request is sent only with
 * time for it and a re-read left; there is no server-side retry of a write, ever (ORCH B1); `write_outcome` is separate from
 * the read-back (ORCH B2): a 2xx is `applied` even when the read-back fails, and after a request was sent, absence or an
 * unchanged ETag never proves that nothing was applied. Only a 412 is a definitive refusal; after an uncertain answer,
 * anything but the requested state observed is `outcome_unknown`.
 */
import { createHash } from 'node:crypto';
import { CalDavError, type CalDavAuth, type CalendarSummary, type Discovery } from '../caldav/contracts';
import { isDirectChildResource } from '../caldav/identifiers';
import type { CalDavReadBackend, CalendarResource } from '../caldav/read-contracts';
import type { CalDavWriteBackend, StrongEtag, UpstreamDetail, WriteCallOptions, WriteResponse } from '../caldav/write-contracts';
import type { ReadBudget, ResourceWork } from './budget';
import { IcsEditError } from './ics-edit';
import { hasSchedulingLine, type Companion, type ExpectedAlarm, type ExpectedProperty, type ExpectedValue, type OutcomeVerdict, type PropertyExpectation } from './ics-verify';
import { ALARM_DESCRIPTION, displayAlarm, IcsWriteError, MAX_SEQUENCE, statusProperty, textProperty, timeProperty, transparencyProperty, travelDurationProperty, type IcsTime, type TextPropertyName, type WrittenComponent, type WrittenProperty } from './ics-write';
import { parseOriginalResource } from './ical';
import { DAV_LAMBDA_RESERVE_MS, DAV_REQUEST_MS } from './limits';
import { BudgetError, IcalError, isCanonicalPath, type EventComponent, type OccurrenceId, type OriginalResource } from './model';
import { OccurrenceTargetError } from './occurrence-target';
import { calendarStatus, occurrenceView, originalEventView, readCalendarMembership, readStoredResource, ReadError, type ReadDeps, type UnauthorizedReporter } from './read';
import type { ToolErrorCode } from './schemas';
import { formatInstant, occurrenceIdFromRecurrenceId } from './time-core';
import { holdsExpectation, normaliseLine, storedDifferences, storedEvents, type ComponentRequest, type FieldLine, type StoredExpectation } from './write-compare';
import {
    GUEST_NOTICE, STORED_FIELDS, type StoredField, type UpdateChanges, type WriteErrorField, type WriteErrorReason, type WriteEventResult,
} from './write-schemas';
import { parseWriteSpan, WriteTimeError, type ClientTime, type WriteSpan } from './write-time';

export interface WriteDeps {
    backend: CalDavReadBackend & CalDavWriteBackend;
    auth: CalDavAuth;
    discovery: Discovery;
    /** Authenticated pseudonymous account id; part of every create's and split's identity. */
    accountId: string;
    budget: ReadBudget;
    onUnauthorized?: () => Promise<void>;
    /** Server clock in epoch milliseconds: DTSTAMP, LAST-MODIFIED and CREATED. */
    now: () => number;
    /** Scopes this connection was granted. `calendar:invite` opens the attendee gate. */
    scopes: readonly string[];
}

/** The series a split created, when a split's error must say where it is (B2: never claim nothing was saved). */
export interface CreatedSeries { resource_href: string; expected_version: string | null; write_outcome: 'applied' | 'desired_state_present' | 'unconfirmed' }

export interface WriteErrorExtra {
    reason?: WriteErrorReason;
    field?: WriteErrorField;
    /** Sanitised summary of iCloud's answer; its detail is untrusted text. */
    upstream?: UpstreamDetail;
    /** existing_resource_differs: the requested fields the existing resource does not hold. */
    differs?: StoredField[];
    /** split_incomplete, and outcome_unknown after a split's first write: the new series. */
    created_series?: CreatedSeries;
    /** exceptions_choice_required: how many exceptions the series has. */
    exceptions?: { changed_occurrences: number; deleted_occurrences: number };
    /** split_incomplete and outcome_unknown of a split that drops exceptions: what was or may have been dropped. */
    exceptions_dropped?: NonNullable<WriteEventResult['exceptions_dropped']>;
}

/** A fixed, sanitised write failure. Carries enums, counts, identifiers and the sanitised upstream summary only. */
export class WriteError extends Error {
    constructor(public readonly code: ToolErrorCode, public readonly extra: WriteErrorExtra = {}) { super(code); }
}

export const INVITE_SCOPE = 'calendar:invite';
export const GUEST_FIELDS = { guests_may_be_emailed: true, guest_notice: GUEST_NOTICE } as const;
/** A request is sent only with time for it and one re-read left (design 5.3). */
export const WRITE_SEND_RESERVE_MS = 2 * DAV_REQUEST_MS + DAV_LAMBDA_RESERVE_MS;
const NEED_PRIVILEGES = '{DAV:}need-privileges';

export const invalid = (reason: WriteErrorReason, field?: WriteErrorField): WriteError => new WriteError('invalid_input', { reason, ...(field === undefined ? {} : { field }) });
export const unsupported = (reason: WriteErrorReason): WriteError => new WriteError('unsupported_calendar_data', { reason });
export const notSupported = (reason: WriteErrorReason, extra: Omit<WriteErrorExtra, 'reason'> = {}): WriteError => new WriteError('edit_not_supported', { reason, ...extra });

// ---- Identity, clock and values ----

/**
 * `cmcp1-` + 32 characters of base64url(SHA-256) over the account and the client's operation id (design 5.2), in one
 * domain: `uid` for a create, `split` for the new series of a this_and_future change.
 */
export function deterministicUid(accountId: string, operationId: string, domain: 'uid' | 'split' = 'uid'): string {
    const digest = createHash('sha256').update(`caldav-mcp/${domain}/v1\0${accountId}\0${operationId}`, 'utf8').digest('base64url');
    return `cmcp1-${digest.slice(0, 32)}`;
}

export interface Stamp { basic: string; jcal: string }

export function stampOf(deps: WriteDeps): Stamp {
    const ms = deps.now();
    const jcal = Number.isSafeInteger(ms) ? formatInstant(BigInt(ms) * 1_000_000n) : null;
    if (jcal === null) { throw new WriteError('temporarily_unavailable'); }
    return { jcal, basic: jcal.replaceAll(/[-:]/gu, '') };
}

/** `YYYYMMDD[THHMMSS[Z]]` basic digits as the parser reports them: `YYYY-MM-DD[THH:MM:SS[Z]]`. */
export function jcalOf(basic: string): string {
    const date = `${basic.slice(0, 4)}-${basic.slice(4, 6)}-${basic.slice(6, 8)}`;
    return basic.length === 8 ? date : `${date}T${basic.slice(9, 11)}:${basic.slice(11, 13)}:${basic.slice(13, 15)}${basic.endsWith('Z') ? 'Z' : ''}`;
}

/** The decoded value the parser reports for a written time of any form (a client time, or a slot copied from iCloud). */
export function expectedValue(time: IcsTime): ExpectedValue {
    switch (time.kind) {
        case 'utc': return { type: 'date-time', values: [jcalOf(time.utc)] };
        case 'zoned': return { type: 'date-time', values: [jcalOf(time.local)], params: { tzid: [time.tzid] } };
        case 'date': return { type: 'date', values: [jcalOf(time.date)] };
        case 'floating': return { type: 'date-time', values: [jcalOf(time.local)] };
    }
}

/** The decoded value the parser will report for a client time, derived from the request (not from written text). */
export function expectedTime(name: 'DTSTART' | 'DTEND', time: ClientTime | IcsTime): ExpectedProperty {
    return { name, ...expectedValue(time) };
}

/** The token a stored RECURRENCE-ID in this form gets from the read path (`occ1_`, or `occ2_` for the TZID form). */
export function occurrenceTokenOf(slot: IcsTime): OccurrenceId | null {
    const value = expectedValue(slot);
    const params = new Map<string, readonly string[]>(Object.entries(value.params ?? {}));
    return occurrenceIdFromRecurrenceId(value.type, String(value.values[0]), params);
}

/** TEXT as the parser decodes it: a written line break (CRLF, CR or LF) reads back as LF. */
export const expectedText = (name: string, value: string): ExpectedProperty => ({ name, type: 'text', values: [value.replaceAll(/\r\n|\r/gu, '\n')] });
export const stampExpectations = (stamp: Stamp, sequence: number): ExpectedProperty[] => [
    { name: 'DTSTAMP', type: 'date-time', values: [stamp.jcal] },
    { name: 'LAST-MODIFIED', type: 'date-time', values: [stamp.jcal] },
    { name: 'SEQUENCE', type: 'integer', values: [sequence] },
];

// ---- Errors from the pure builders ----

const FIELD_NAMES: ReadonlySet<string> = new Set<WriteErrorField>(['title', 'location', 'description', 'status', 'transparency', 'alarms', 'start', 'end', 'recurrence', 'travel_time']);

export function builderError(error: unknown): WriteError {
    if (error instanceof WriteError) { return error; }
    // The invocation's deadline or shared caps, from a parse inside the editor or the verifier.
    if (error instanceof BudgetError) { return budgetFailure(error); }
    if (error instanceof WriteTimeError) { return invalid(error.reason, error.field); }
    if (error instanceof OccurrenceTargetError) { return new WriteError(error.code, error.reason === undefined ? {} : { reason: error.reason }); }
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
export function requireVerified(verdict: OutcomeVerdict): void {
    if (!verdict.ok) { throw unsupported('self_verification_failed'); }
}

// ---- Reads ----

export function readFailure(error: unknown): WriteError {
    if (error instanceof WriteError) { return error; }
    if (error instanceof ReadError) { return new WriteError(error.code); }
    if (error instanceof BudgetError) { return budgetFailure(error); }
    if (error instanceof CalDavError && error.code === 'unauthorized') { return new WriteError('reconnect_required'); }
    return new WriteError('temporarily_unavailable');
}

export async function membership(deps: WriteDeps, calendarId: string): Promise<{ summary: CalendarSummary; reporter: UnauthorizedReporter }> {
    let read: Awaited<ReturnType<typeof readCalendarMembership>>;
    try { read = await readCalendarMembership(deps satisfies ReadDeps); } catch (error) { throw readFailure(error); }
    const summary = read.members.get(calendarId);
    if (summary === undefined) { throw new WriteError('not_found'); }
    return { summary, reporter: read.reporter };
}

export async function readOriginalText(deps: WriteDeps, reporter: UnauthorizedReporter, calendarId: string, href: string): Promise<CalendarResource | null> {
    try { return await readStoredResource(deps, reporter, calendarId, href); } catch (error) { throw readFailure(error); }
}

export type Reread = { kind: 'found'; resource: CalendarResource } | { kind: 'absent' } | { kind: 'failed' };

/** The one re-read after a request was sent. Never throws: a failed read is an answer of its own. */
export async function reread(deps: WriteDeps, reporter: UnauthorizedReporter, calendarId: string, href: string): Promise<Reread> {
    try {
        const resource = await readStoredResource(deps, reporter, calendarId, href);
        return resource === null ? { kind: 'absent' } : { kind: 'found', resource };
    } catch {
        return { kind: 'failed' };
    }
}

/**
 * The work charge for one parse of this invocation's write work: the deadline is checked first, so no parse (and no edit or
 * verification built on one) starts once it has passed, and every parse charges the invocation's shared line and property
 * caps. Throws BudgetError.
 */
export function parseWork(deps: WriteDeps): () => ResourceWork {
    return () => {
        deps.budget.throwIfExpired();
        return deps.budget.newResourceWork();
    };
}

export function budgetFailure(error: BudgetError): WriteError {
    return new WriteError(error.kind === 'deadline' ? 'temporarily_unavailable' : 'result_too_large');
}

export function parseStored(deps: WriteDeps, text: string): OriginalResource {
    try {
        return parseOriginalResource(text, { work: parseWork(deps)() });
    } catch (error) {
        if (error instanceof BudgetError) { throw budgetFailure(error); }
        if (error instanceof IcalError && error.reason === 'resource_too_large') { throw new WriteError('result_too_large'); }
        throw unsupported('stored_data_not_editable');
    }
}

/**
 * Refuses an event with guests unless the user ticked the invitation permission (addendum 1): iCloud emails guests on every
 * change or delete (probe Run 8). Any ATTENDEE or ORGANIZER line anywhere in the stored text counts, by the verifier's own
 * name policy (group prefixes included, X- names not), including components the parser ignores; it fails closed. The text
 * was read within the 2 MiB resource cap and has parsed, so the linear scan is bounded.
 */
export function attendeeGate(deps: WriteDeps, storedText: string): boolean {
    const guests = hasSchedulingLine(storedText);
    if (guests && !deps.scopes.includes(INVITE_SCOPE)) { throw new WriteError('attendees_present', { reason: 'may_send_invitations' }); }
    return guests;
}

// ---- Sending and classifying ----

export type Answer = 'applied' | 'precondition' | 'not_found' | 'forbidden' | 'busy' | 'redirected' | 'refused' | 'unknown';

/** Design 5.3: 202, 5xx (but 507) and an uncertain send are unknown; other 4xx and 507 are refusals. */
export function classify(response: WriteResponse): Answer {
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

export const upstreamOf = (response: WriteResponse): UpstreamDetail | undefined => (response.kind === 'status' ? response.upstream : undefined);
export const etagOf = (response: WriteResponse): StrongEtag | null => (response.kind === 'status' ? response.etag : null);

/** The fixed error for a definitive refusal; `undefined` for the answers the caller must resolve itself. */
export function refusal(answer: Answer, response: WriteResponse): WriteError | undefined {
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

/**
 * One conditional request, only with `reserveMs` of work time left (time for it and a re-read; a split asks for both of its
 * writes before the first). Failures before sending are fixed errors.
 */
export async function sendOnce(deps: WriteDeps, reporter: UnauthorizedReporter, request: (options: WriteCallOptions) => Promise<WriteResponse>, reserveMs = WRITE_SEND_RESERVE_MS): Promise<WriteResponse> {
    if (deps.budget.workRemainingMs() < reserveMs) { throw new WriteError('temporarily_unavailable'); }
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

export type PutOutcome = { kind: 'applied'; etag: StrongEtag | null } | { kind: 'present'; resource: CalendarResource };

/**
 * ONE PUT with the exact `If-Match: expected` and its classification (design 5.3): a 2xx is applied; a definitive refusal is
 * its fixed error; anything else is followed by one re-read, in which `present` decides whether the requested state is
 * observed. A 412 with the state absent is `calendar_changed` (`precondition_failed`); an uncertain answer with the state
 * absent is `outcome_unknown`, never "not saved" (ORCH B2).
 */
export async function putIfMatch(
    deps: WriteDeps, reporter: UnauthorizedReporter, request: { calendarId: string; href: string; body: string; expected: StrongEtag }, present: (resource: CalendarResource) => boolean,
): Promise<PutOutcome> {
    const { calendarId, href, body, expected } = request;
    const response = await sendOnce(deps, reporter, options => deps.backend.putEvent(deps.auth, deps.discovery, { calendarId, href, body, precondition: { kind: 'match', etag: expected } }, options));
    const answer = classify(response);
    if (answer === 'applied') { return { kind: 'applied', etag: etagOf(response) }; }
    const refused = refusal(answer, response);
    if (refused !== undefined) { throw refused; }
    const after = await reread(deps, reporter, calendarId, href);
    if (answer === 'not_found') {
        if (after.kind === 'absent') { throw new WriteError('not_found'); }
        const upstream = upstreamOf(response);
        throw new WriteError('write_refused', upstream === undefined ? {} : { upstream });
    }
    if (after.kind === 'found' && present(after.resource)) { return { kind: 'present', resource: after.resource }; }
    if (answer === 'precondition') {
        // A definitive refusal: this PUT saved nothing, and the re-read says what is stored instead.
        if (after.kind === 'absent') { throw new WriteError('not_found'); }
        if (after.kind === 'found') { throw new WriteError('calendar_changed', { reason: 'precondition_failed' }); }
        throw new WriteError('outcome_unknown');
    }
    // Unknown: the requested values are not observed, and nothing proves the PUT was refused. A changed ETag is no proof
    // either: iCloud may have applied the write and rewritten values, or another client may have edited after it (ORCH B2).
    throw new WriteError('outcome_unknown');
}

// ---- Results ----

export interface ResultContext {
    deps: WriteDeps;
    reporter: UnauthorizedReporter;
    calendarId: string;
    href: string;
    summary: CalendarSummary;
    zoneDropped: readonly ('start' | 'end')[];
    /** What the stored resource must hold; compared with the resource as read back, never with a frozen component set. */
    stored: StoredExpectation;
    guests: boolean;
    removedCompanions?: readonly Companion[] | undefined;
    /** Result fields of the scope (overrides_changed, exceptions_dropped, created_series, …), passed through. */
    fields?: Partial<Pick<WriteEventResult, 'overrides_changed' | 'exceptions_dropped' | 'exceptions_shifted' | 'created_series' | 'recurrence_id'>> | undefined;
    /** The occurrence to show as `event` (edit_scope this), else the master or single event. */
    occurrence?: OccurrenceId | undefined;
    /** Differences found in another resource the call wrote (the original of a split). */
    otherDiffers?: readonly StoredField[] | undefined;
}

export function orderedFields(fields: Iterable<StoredField>): StoredField[] {
    const set = new Set(fields);
    return STORED_FIELDS.filter(field => set.has(field));
}

export function storedDiffers(text: string, expectation: StoredExpectation): StoredField[] {
    return orderedFields(storedDifferences(storedEvents(text), expectation));
}

export const holds = (resource: CalendarResource, expectation: StoredExpectation): boolean => holdsExpectation(storedEvents(resource.calendarData), expectation);

/** The result with the stored event as get_event shows it, or with `readback: "unavailable"` when that cannot be built. */
export async function eventResult(context: ResultContext, outcome: WriteEventResult['write_outcome'], resource: CalendarResource | null, answerEtag: StrongEtag | null): Promise<WriteEventResult> {
    const removed = context.removedCompanions ?? [];
    const base = {
        write_outcome: outcome,
        calendar_id: context.calendarId,
        resource_href: context.href,
        request_warnings: context.zoneDropped.map(field => ({ field, timezone_warning: 'timezone_dropped_from_date' as const })),
        removed_dependent_properties: outcome === 'applied' ? [...removed] : [],
        ...(outcome === 'applied' && removed.includes('X-APPLE-STRUCTURED-LOCATION') ? { removed_apple_location_pin: true as const } : {}),
        ...context.fields,
        ...(context.guests ? GUEST_FIELDS : {}),
    };
    if (resource !== null) {
        try {
            const original = parseOriginalResource(resource.calendarData, { work: context.deps.budget.newResourceWork() });
            const event = context.occurrence === undefined
                ? originalEventView(context.calendarId, context.summary, resource, original).event
                : await occurrenceView(context.deps, context.reporter, context.calendarId, resource, original, context.occurrence);
            const differs = orderedFields([...storedDiffers(resource.calendarData, context.stored), ...(context.otherDiffers ?? [])]);
            return { ...base, readback: 'ok', expected_version: resource.etag, stored_differs_from_request: differs, calendars: [calendarStatus(context.calendarId, context.summary, 'ok')], event };
        } catch {
            // The change stands; only its presentation failed.
        }
    }
    return { ...base, readback: 'unavailable', expected_version: answerEtag, stored_differs_from_request: null, calendars: [calendarStatus(context.calendarId, context.summary, 'ok')], event: null };
}

export async function readBack(context: ResultContext, answerEtag: StrongEtag | null): Promise<WriteEventResult> {
    const found = await reread(context.deps, context.reporter, context.calendarId, context.href);
    return eventResult(context, 'applied', found.kind === 'found' ? found.resource : null, answerEtag);
}

// ---- Identifiers ----

export function collection(calendarId: string): string {
    if (!isCanonicalPath(calendarId) || !calendarId.endsWith('/')) { throw invalid('schema'); }
    return calendarId;
}

export function resourceTarget(calendarId: string, href: string): { calendarId: string; href: string } {
    collection(calendarId);
    if (!isDirectChildResource(calendarId, href)) { throw invalid('schema'); }
    return { calendarId, href };
}

// ---- Requested properties ----

export interface FieldPlan {
    field: StoredField;
    name: string;
    property: WrittenProperty | null;
    expected: PropertyExpectation;
}

export function textField(field: StoredField, name: TextPropertyName, value: string | null): FieldPlan {
    return value === null
        ? { field, name, property: null, expected: { name, absent: true } }
        : { field, name, property: textProperty(name, value, field), expected: expectedText(name, value) };
}

export interface AlarmPlan { components: WrittenComponent[]; expected: ExpectedAlarm[]; triggers: string[] }

export function alarmPlan(alarms: readonly { before_start: string }[]): AlarmPlan {
    const built = alarms.map(alarm => displayAlarm(alarm.before_start, 'alarms'));
    return {
        components: built,
        expected: alarms.map(alarm => ({ trigger: `-${alarm.before_start}`, description: ALARM_DESCRIPTION })),
        triggers: alarms.map(alarm => `TRIGGER:-${alarm.before_start}`),
    };
}

export function spanOf(start: unknown, end: unknown): WriteSpan {
    try { return parseWriteSpan(start, end); } catch (error) { throw builderError(error); }
}

export const fieldLine = (plan: FieldPlan): FieldLine => ({ field: plan.field, name: plan.name, line: plan.property?.line ?? null });

export interface ChangePlan {
    /** Every requested property but the times. */
    fields: FieldPlan[];
    span: WriteSpan | undefined;
    /** DTSTART and DTEND when the span is given. */
    times: FieldPlan[];
    /** Undefined: alarms unchanged; null: every alarm removed. */
    alarms: AlarmPlan | null | undefined;
    /** Undefined: no recurrence key; null: `recurrence: null`. */
    recurrence: { rrule: string } | null | undefined;
    companions: Companion[];
}

/** Everything the request asks for that needs no stored data. Throws invalid_input. */
export function planChanges(changes: UpdateChanges): ChangePlan {
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
        const times: FieldPlan[] = [];
        if (changes.start !== undefined) {
            span = parseWriteSpan(changes.start, changes.end);
            times.push(
                { field: 'start', name: 'DTSTART', property: timeProperty('DTSTART', span.start, 'start'), expected: expectedTime('DTSTART', span.start) },
                { field: 'end', name: 'DTEND', property: timeProperty('DTEND', span.end, 'end'), expected: expectedTime('DTEND', span.end) },
            );
        }
        const alarms = changes.alarms === undefined ? undefined : changes.alarms === null || changes.alarms.length === 0 ? null : alarmPlan(changes.alarms);
        const companions: Companion[] = [];
        if (changes.location !== undefined) { companions.push('X-APPLE-STRUCTURED-LOCATION'); }
        if (changes.description !== undefined) { companions.push('X-ALT-DESC'); }
        return { fields, span, times, alarms, recurrence: changes.recurrence, companions };
    } catch (error) {
        throw builderError(error);
    }
}

/** The stored SEQUENCE plus one (1 when absent); a value this server cannot increment is unsupported data. */
export function nextSequence(component: EventComponent): number {
    const list = component.properties.get('sequence') ?? [];
    if (list.length === 0) { return 1; }
    const value = list.length === 1 ? list[0]?.values[0] : undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= MAX_SEQUENCE) { throw unsupported('sequence_unsupported'); }
    return value + 1;
}

/** What one component must hold afterwards: the requested lines (and extra written lines), the alarms, the companions gone. */
export function componentRequest(rid: string | null, plan: ChangePlan, extra: readonly FieldLine[] = [], withTimes = true): ComponentRequest {
    return {
        rid: rid === null ? null : normaliseLine(rid),
        fields: [...plan.fields.map(fieldLine), ...(withTimes ? plan.times.map(fieldLine) : []), ...extra],
        ...(plan.alarms === undefined ? {} : { triggers: plan.alarms?.triggers ?? [] }),
        absent: plan.companions,
    };
}

/** The WriteError for a send that failed before anything was sent; others propagate unchanged. */
export function isWriteError(error: unknown, code: ToolErrorCode): error is WriteError {
    return error instanceof WriteError && error.code === code;
}

/** The new-override and split flows need the whole stored master; a resource without one is not editable that way. */
export function requireMaster(original: OriginalResource): EventComponent {
    if (original.master === null) { throw notSupported('occurrence_only_resource'); }
    return original.master;
}
