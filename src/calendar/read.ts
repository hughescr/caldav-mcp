/**
 * Read orchestration (design v3 sections 3-4): one membership listing, then either one expanded REPORT per selected calendar
 * (list/search, at most three complete pipelines at once) or one original multiget plus at most one expanded REPORT (get).
 * Produces complete, sorted, pre-shape results; shape.ts owns sizing. Calendar data is passed through as stored: no original
 * fetch for list/search, no local recurrence expansion, no guessed occurrence. Errors carry only fixed codes.
 */
import { CalDavError, type CalDavAuth, type CalendarSummary, type Discovery } from '../caldav/contracts';
import { isDirectChildResource } from '../caldav/identifiers';
import { isAddressedResource, type CalDavReadBackend, type CalendarResource, type DavCallOptions, type QueriedResource } from '../caldav/read-contracts';
import { downloadSupported } from './attachment-access';
import { buildAttachmentIndex, prescanAttachProperties, toAttachmentMetadata, type AttachmentIndexEntry } from './attachments';
import type { ReadBudget } from './budget';
import type {
    AttachmentMetadata, CalendarStatus, EventTimeOutput, FullEvent, GetEventArgs, ListEventsArgs, ReadToolErrorCode, SearchEventsArgs, SeriesWithoutOccurrences, SlimEvent, Unreadable,
} from './event-schemas';
import { parseExpandedListing, parseOriginalResource, type ExpandedListing } from './ical';
import {
    CALENDAR_CONCURRENCY, DISPLAY_NAME_MAX, ETAG_MAX, ETAG_MIN, MAX_DISCOVERED_CALENDARS, MAX_MEMBERSHIP_BYTES, MAX_MULTIGET_HREFS, MAX_REPORT_BYTES, MAX_RESOURCES_PER_REPORT, MAX_UNREADABLE,
} from './limits';
import { BudgetError, IcalError, isCanonicalPath, isResourceHref, type EventComponent, type EventTime, type Interval, type OriginalResource } from './model';
import { normalizeFullEvent, normalizeSeriesWithoutOccurrences, normalizeSlimEvent, sanitizeDisplayText } from './normalize';
import { matchesQuery, normalizeQuery, type SearchField } from './search';
import {
    compareCodePoints, compareEventOrder, eventSpan, nominalSpanSeconds, occurrenceServerForm, occurrenceTransportWindow, parseOccurrenceId, parseRange,
    rangeTransportWindow, spanOverlapsRange, type ParsedRange,
} from './time-core';

/** Everything one tool invocation needs. Credentials are bound once by the service and never reach tool output. */
export interface ReadDeps {
    backend: CalDavReadBackend;
    auth: CalDavAuth;
    discovery: Discovery;
    /** Authenticated pseudonymous UpstreamCredentials.accountId. */
    accountId: string;
    budget: ReadBudget;
    /**
     * Called once when a calendar request is refused with 401 (credentials rejected), after queued dispatch has stopped, so the
     * caller can record that the stored credentials are no longer valid. The read result still reports reconnect_required.
     */
    onUnauthorized?: () => Promise<void>;
}

/** Complete, sorted, pre-limit list/search result. matched_count is `events.length`. */
export interface EventsReadResult {
    calendars: CalendarStatus[];
    range: { start: string; end: string };
    /** Every readable match from ok calendars, in deterministic civil order, not yet cut to the limit. */
    events: SlimEvent[];
    /** Deterministic sorted prefix of at most 50. */
    unreadable: Unreadable[];
    unreadableCount: number;
    /** Every series iCloud returned without an occurrence in the window, from ok calendars, sorted; shape.ts caps it. */
    seriesWithoutOccurrences: SeriesWithoutOccurrences[];
}

export interface DetailReadResult {
    calendars: [CalendarStatus];
    event: FullEvent;
    /** Every attachment, not yet cut to 100. */
    attachments: AttachmentMetadata[];
    /** The entire original calendar-data text, unmodified, only when include_raw was requested. */
    rawIcs: string | null;
}

/**
 * Why an error happened, when the message should say so: `attachment_size` (result_too_large), the attachment itself is
 * over the download cap; `occurrence_not_expanded` (not_found), iCloud's expansion for the occurrence's window returned
 * the series alone, in the measured stripped shape (ical.ts parseExpandedListing), so the occurrence was probably deleted.
 */
export type ErrorDetail = 'attachment_size' | 'occurrence_not_expanded';

/** A whole-tool read failure with one fixed code. It never carries upstream text, values or causes. */
export class ReadError extends Error {
    constructor(public readonly code: ReadToolErrorCode, public readonly detail?: ErrorDetail) { super(code); }
}

type CalendarStatusCode = CalendarStatus['status'];

const ETAG_RE = /^"[\x21\x23-\x7E]*"$/u;
const ALL_FIELDS: readonly SearchField[] = ['title', 'description', 'location'];

function validEtag(etag: unknown): etag is string {
    return typeof etag === 'string' && etag.length >= ETAG_MIN && etag.length <= ETAG_MAX && ETAG_RE.test(etag);
}

/** Calendar status for a failure. Unknown errors are treated as temporary, never as upstream text. */
function statusFor(error: unknown): Exclude<CalendarStatusCode, 'ok' | 'not_read'> {
    if (error instanceof CalDavError) {
        switch (error.code) {
            case 'unauthorized': return 'reconnect_required';
            case 'temporary': return 'temporarily_unavailable';
            case 'too_large': return 'result_too_large';
            case 'not_found': return 'not_found';
            case 'protocol':
            case 'forbidden_host': return 'upstream_error';
        }
    }
    if (error instanceof BudgetError) { return error.kind === 'deadline' ? 'temporarily_unavailable' : 'result_too_large'; }
    if (error instanceof IcalError) { return error.reason === 'resource_too_large' || error.reason === 'window_too_large' ? 'result_too_large' : 'upstream_error'; }
    return 'temporarily_unavailable';
}

/** Whole-tool code for a membership, multiget or occurrence-query failure. */
function toolCodeFor(error: unknown): ReadToolErrorCode {
    if (error instanceof ReadError) { return error.code; }
    return statusFor(error);
}

function isUnauthorized(error: unknown): boolean {
    return error instanceof CalDavError && error.code === 'unauthorized';
}

/** Reports a 401 once per invocation and lets the caller wait for the report to be recorded. */
export interface UnauthorizedReporter { report(): void; settled(): Promise<void> }

/** The single 401 reporter for one invocation: the callback runs at most once and its failure never changes the result. */
function unauthorizedReporter(deps: ReadDeps): UnauthorizedReporter {
    let pending: Promise<void> | null = null;
    return {
        report: () => {
            if (pending !== null) { return; }
            pending = (async () => { try { await deps.onUnauthorized?.(); } catch { /* the next call re-detects it */ } })();
        },
        settled: async () => { await pending; },
    };
}

function callOptions(budget: ReadBudget, maxBytes: number, signal: AbortSignal = budget.signal): DavCallOptions {
    // requestTimeoutMs() throws BudgetError('deadline') when no time is left, before anything is sent.
    return { signal, charge: budget.responseCharge(maxBytes), deadlineMs: budget.requestTimeoutMs() };
}

/** One complete home membership listing: exact VEVENT collections, canonical and unique, or a whole-tool failure. */
async function readMembership(deps: ReadDeps, reporter: { report(): void; settled(): Promise<void> }): Promise<Map<string, CalendarSummary>> {
    let calendars: CalendarSummary[];
    try {
        calendars = await deps.backend.listCalendars(deps.auth, deps.discovery, callOptions(deps.budget, MAX_MEMBERSHIP_BYTES));
    } catch (error) {
        if (isUnauthorized(error)) {
            reporter.report();
            await reporter.settled();
        }
        throw new ReadError(toolCodeFor(error));
    }
    const members = new Map<string, CalendarSummary>();
    for (const summary of calendars) {
        // The membership is authorization data: an id the client could not pass back, or a duplicate, is a protocol failure.
        if (!isCanonicalPath(summary.id) || !summary.id.endsWith('/') || members.has(summary.id)) { throw new ReadError('upstream_error'); }
        if (summary.components.includes('VEVENT')) { members.set(summary.id, summary); }
    }
    return members;
}

/** One calendar's public status, its untrusted display name sanitized and capped. */
export function calendarStatus(calendarId: string, summary: CalendarSummary | undefined, status: CalendarStatusCode): CalendarStatus {
    const name = summary?.displayName ?? null;
    const display = name === null ? null : sanitizeDisplayText(name, DISPLAY_NAME_MAX);
    return {
        calendar_id: calendarId,
        display_name: display?.text ?? null,
        ...(display?.truncated === true ? { display_name_truncated: true as const } : {}),
        ...(display?.sanitized === true ? { sanitized: true as const } : {}),
        status,
    };
}

/**
 * Report-level checks before any content is used: every href a direct child of the calendar, unique, with a strong ETag and
 * text calendar-data, and no more entries than the byte-derived cap. Any violation fails the whole calendar. An
 * unaddressable entry (a refused name of this calendar, see QueriedResource) carries nothing to check.
 */
function validateReport(calendarId: string, resources: readonly QueriedResource[]): void {
    if (resources.length > MAX_RESOURCES_PER_REPORT) { throw new CalDavError('too_large'); }
    const seen = new Set<string>();
    for (const entry of resources) {
        if (typeof entry !== 'object' || entry === null) { throw new CalDavError('protocol'); }
        if (!isAddressedResource(entry)) {
            if (entry.unaddressable !== true || Object.keys(entry).length !== 1) { throw new CalDavError('protocol'); }
            continue;
        }
        const resource = entry;
        if (typeof resource.href !== 'string' || !isDirectChildResource(calendarId, resource.href) || seen.has(resource.href)
            || !validEtag(resource.etag) || typeof resource.calendarData !== 'string') {
            throw new CalDavError('protocol');
        }
        seen.add(resource.href);
    }
}

function propertyText(component: EventComponent, name: string): string | null {
    const value = component.properties.get(name)?.[0]?.values[0];
    return typeof value === 'string' ? value : null;
}

type Matcher = (component: EventComponent) => boolean;

interface CalendarOutcome {
    events: { event: SlimEvent; calendarId: string }[];
    unreadable: Unreadable[];
    seriesWithoutOccurrences: SeriesWithoutOccurrences[];
}

function unreadableReason(error: IcalError): Unreadable['reason'] {
    if (error.reason === 'unsupported_recurrence_data') { return 'unsupported_recurrence_data'; }
    // An unexpected RID form is local malformed data, not evidence that the server ignored expansion for this calendar.
    if (error.reason === 'unsupported_recurrence_id') { return 'malformed'; }
    return error.reason === 'resource_too_large' ? 'resource_too_large' : 'malformed';
}

interface CalendarContext {
    budget: ReadBudget;
    range: ParsedRange;
    matcher: Matcher | null;
    /** True once the invocation stopped (401) or this calendar was aborted. */
    cancelled: () => boolean;
}

/**
 * Parses each resource once, filters by the requested range and the search, and keeps its candidates only if the whole
 * report passes. A resource that cannot be read becomes an unreadable entry; a report-level or shared-capacity failure throws.
 */
async function processCalendar(context: CalendarContext, index: number, calendarId: string, resources: readonly QueriedResource[]): Promise<CalendarOutcome> {
    validateReport(calendarId, resources);
    const { budget } = context;
    const work = budget.newCalendarWork();
    const outcome: CalendarOutcome = { events: [], unreadable: [], seriesWithoutOccurrences: [] };
    let unsupported = 0;
    let recurringReadable = 0;
    for (const resource of resources) {
        if (!isAddressedResource(resource)) {
            // Its href failed the safety check, so it is not echoed: the entry only counts it.
            outcome.unreadable.push({ calendar: index, resource_href: null, recurrence_id: null, reason: 'unsupported_resource_address' });
            await budget.afterComponent();
            continue;
        }
        let listing: ExpandedListing;
        try {
            listing = parseExpandedListing(resource.calendarData, { work: budget.newResourceWork() });
        } catch (error) {
            // A per-resource line/property cap is that resource's problem; spent shared capacity is the calendar's.
            const resourceCap = error instanceof BudgetError && error.kind === 'work' && !budget.exhausted();
            if (!(error instanceof IcalError) && !resourceCap) { throw error; }
            const reason = error instanceof IcalError ? unreadableReason(error) : 'resource_too_large';
            if (reason === 'unsupported_recurrence_data') { unsupported++; }
            outcome.unreadable.push({ calendar: index, resource_href: resource.href, recurrence_id: null, reason });
            await budget.afterComponent();
            continue;
        }
        if (listing.kind === 'series_without_occurrences') {
            // iCloud's answer for a window holding only deleted occurrences: reported as data, never range-filtered (the server
            // cannot compute occurrences). It counts neither as unsupported nor as recurring readable, so it neither fails the
            // calendar nor vouches for the expansion of the others: an unexpanded master beside it still fails the calendar.
            work.chargeComponents(1);
            await budget.afterComponent();
            if (context.cancelled()) { throw new CalDavError('unauthorized'); }
            budget.throwIfExpired();
            if (context.matcher === null || context.matcher(listing.series.master)) {
                outcome.seriesWithoutOccurrences.push(normalizeSeriesWithoutOccurrences(listing.series, { calendar: index, resourceHref: resource.href }));
            }
            continue;
        }
        const components = listing.resource.components;
        work.chargeComponents(components.length);
        if (components.some(component => component.recurrenceId !== null)) { recurringReadable++; }
        for (const component of components) {
            await budget.afterComponent();
            if (context.cancelled()) { throw new CalDavError('unauthorized'); }
            budget.throwIfExpired();
            // The parser already validated the span structurally, so this cannot throw for a parsed component.
            if (!spanOverlapsRange(context.range, eventSpan(component.start, component.end, component.duration))) { continue; }
            if (context.matcher !== null && !context.matcher(component)) { continue; }
            const event = normalizeSlimEvent(component, { calendar: index, resourceHref: resource.href, etag: resource.etag, recurring: component.recurrenceId !== null });
            outcome.events.push({ event, calendarId });
        }
    }
    // Every recurring resource still carrying its rules means the server did not expand: the report is unusable as a whole.
    if (unsupported > 0 && recurringReadable === 0) { throw new CalDavError('protocol'); }
    return outcome;
}

/**
 * The schema output type widens optional keys to `| undefined` (exactOptionalPropertyTypes); the values normalize.ts builds
 * never carry an undefined key, so they are the model EventTime exactly.
 */
function modelTime(time: EventTimeOutput): EventTime {
    return time as EventTime;
}

function compareUnreadable(calendars: readonly CalendarStatus[]): (a: Unreadable, b: Unreadable) => number {
    return (a, b) => {
        const byCalendar = compareCodePoints(calendars[a.calendar]?.calendar_id ?? '', calendars[b.calendar]?.calendar_id ?? '') || a.calendar - b.calendar;
        if (byCalendar !== 0) { return Math.sign(byCalendar); }
        // An unaddressable entry (no href) sorts after every named one of its calendar.
        if (a.resource_href === null || b.resource_href === null) {
            if (a.resource_href !== b.resource_href) { return a.resource_href === null ? 1 : -1; }
            return 0;
        }
        const byHref = compareCodePoints(a.resource_href, b.resource_href);
        if (byHref !== 0) { return byHref; }
        if (a.recurrence_id !== b.recurrence_id) {
            if (a.recurrence_id === null) { return -1; }
            if (b.recurrence_id === null) { return 1; }
            return compareCodePoints(a.recurrence_id, b.recurrence_id);
        }
        return compareCodePoints(a.reason, b.reason);
    };
}

async function readEvents(deps: ReadDeps, input: ListEventsArgs, matcher: Matcher | null): Promise<EventsReadResult> {
    const range = parseRange(input.range);
    if (range === null) { throw new ReadError('invalid_input'); }
    let window: { startUtc: string; endUtc: string };
    try { window = rangeTransportWindow(input.range); } catch { throw new ReadError('result_too_large'); }

    const { budget } = deps;
    const reporter = unauthorizedReporter(deps);
    const members = await readMembership(deps, reporter);
    if (members.size > MAX_DISCOVERED_CALENDARS) { throw new ReadError('result_too_large'); }

    const selected = input.calendar_ids ?? [...members.keys()].sort(compareCodePoints);
    const statuses: CalendarStatusCode[] = selected.map(id => (members.has(id) ? 'not_read' : 'not_found'));
    const queue = selected.flatMap((id, index) => (members.has(id) ? [index] : []));
    const outcomes = new Map<number, CalendarOutcome>();
    const inFlight = new Set<AbortController>();
    let stopped = false;

    const stop = (): void => {
        if (stopped) { return; }
        stopped = true;
        for (const controller of inFlight) { controller.abort(); }
        reporter.report();
    };

    const runCalendar = async (index: number, calendarId: string): Promise<void> => {
        const controller = new AbortController();
        inFlight.add(controller);
        const context: CalendarContext = { budget, range, matcher, cancelled: () => stopped || controller.signal.aborted };
        try {
            const resources = await deps.backend.queryEvents(deps.auth, deps.discovery, { calendarId, range: window }, callOptions(budget, MAX_REPORT_BYTES, AbortSignal.any([budget.signal, controller.signal])));
            if (stopped) { throw new CalDavError('unauthorized'); }
            const outcome = await processCalendar(context, index, calendarId, resources);
            // A calendar still unfinished when a 401 arrived is not reported as read.
            if (stopped) { throw new CalDavError('unauthorized'); }
            outcomes.set(index, outcome);
            statuses[index] = 'ok';
        } catch (error) {
            if (isUnauthorized(error)) { stop(); }
            statuses[index] = stopped ? 'reconnect_required' : statusFor(error);
        } finally {
            inFlight.delete(controller);
        }
    };

    let next = 0;
    const worker = async (): Promise<void> => {
        for (let position = next++; position < queue.length; position = next++) {
            const index = queue[position] ?? 0;
            if (stopped) { statuses[index] = 'reconnect_required'; continue; }
            if (budget.exhausted()) { statuses[index] = 'result_too_large'; continue; }
            if (budget.signal.aborted || !budget.canStartCalendar()) { statuses[index] = 'not_read'; continue; }
            await runCalendar(index, selected[index] ?? '');
        }
    };
    await Promise.all(Array.from({ length: Math.min(CALENDAR_CONCURRENCY, queue.length) }, worker));
    await reporter.settled();

    const calendars = selected.map((id, index) => calendarStatus(id, members.get(id), statuses[index] ?? 'not_read'));
    const rows = [...outcomes.values()].flatMap(outcome => outcome.events);
    rows.sort((a, b) => compareEventOrder(
        { start: modelTime(a.event.start), calendarId: a.calendarId, href: a.event.resource_href, token: a.event.recurrence_id },
        { start: modelTime(b.event.start), calendarId: b.calendarId, href: b.event.resource_href, token: b.event.recurrence_id },
    ));
    const distinct = new Map<string, Unreadable>();
    let unaddressable = 0;
    for (const item of [...outcomes.values()].flatMap(outcome => outcome.unreadable)) {
        // Unaddressable entries have no identity to deduplicate by: each one is a separate response, so each one counts.
        distinct.set(item.resource_href === null ? `unaddressable:${unaddressable++}` : JSON.stringify([item.calendar, item.resource_href, item.recurrence_id, item.reason]), item);
    }
    const unreadable = [...distinct.values()].sort(compareUnreadable(calendars));
    // Each href appears at most once per report (validateReport) and each calendar once, so there is nothing to deduplicate.
    const series = [...outcomes.values()].flatMap(outcome => outcome.seriesWithoutOccurrences).sort((a, b) => (
        compareCodePoints(calendars[a.calendar]?.calendar_id ?? '', calendars[b.calendar]?.calendar_id ?? '') || a.calendar - b.calendar || compareCodePoints(a.resource_href, b.resource_href)
    ));
    return {
        calendars,
        range: { start: input.range.start, end: input.range.end },
        events: rows.map(row => row.event),
        unreadable: unreadable.slice(0, MAX_UNREADABLE),
        unreadableCount: unreadable.length,
        seriesWithoutOccurrences: series,
    };
}

export function listEvents(deps: ReadDeps, input: ListEventsArgs): Promise<EventsReadResult> {
    return readEvents(deps, input, null);
}

export function searchEvents(deps: ReadDeps, input: SearchEventsArgs): Promise<EventsReadResult> {
    const query = normalizeQuery(input.query);
    if (query === '') { return Promise.reject(new ReadError('invalid_input')); }
    const fields = input.fields ?? ALL_FIELDS;
    return readEvents(deps, input, component => matchesQuery({
        title: propertyText(component, 'summary'),
        description: propertyText(component, 'description'),
        location: propertyText(component, 'location'),
    }, query, fields));
}

// ---- get_event ----

/** Fixed tool code for a calendar-data problem in the selected resource. */
function detailDataError(error: unknown): ReadError {
    if (error instanceof IcalError) {
        return new ReadError(error.reason === 'resource_too_large' || error.reason === 'window_too_large' ? 'result_too_large' : 'unsupported_calendar_data');
    }
    return new ReadError(toolCodeFor(error));
}

/** Runs one get request; a 401 is reported once before the fixed failure is thrown. */
async function detailRequest<T>(reporter: { report(): void; settled(): Promise<void> }, request: () => Promise<T>): Promise<T> {
    try {
        return await request();
    } catch (error) {
        if (isUnauthorized(error)) {
            reporter.report();
            await reporter.settled();
        }
        throw new ReadError(toolCodeFor(error));
    }
}

/** Full normalization; a component the output cannot carry (a UID over the cap) is unsupported data, never a raw error. */
function fullEvent(component: EventComponent, context: Parameters<typeof normalizeFullEvent>[1]): FullEvent {
    try { return normalizeFullEvent(component, context); } catch (error) { throw detailDataError(error); }
}

function originalUid(resource: OriginalResource): string {
    return resource.master?.uid ?? resource.overrides[0]?.uid ?? '';
}

function spanIntervals(component: EventComponent): Interval[] {
    const span = eventSpan(component.start, component.end, component.duration);
    return span.instant === null ? [span.civil] : [span.civil, span.instant];
}

/** Selects the component for a null token: the master or single event, or the only stored occurrence of a detached resource. */
function nullTokenComponent(resource: OriginalResource): { component: EventComponent; view: FullEvent['view']; recurring: boolean } {
    if (resource.master !== null) {
        return resource.kind === 'series' ? { component: resource.master, view: 'series_master', recurring: true } : { component: resource.master, view: 'single', recurring: false };
    }
    const [only, ...more] = resource.overrides;
    // A detached-only resource with several occurrences needs a token; one is never guessed.
    if (only === undefined || more.length > 0) { throw new ReadError('invalid_input'); }
    return { component: only, view: 'occurrence', recurring: true };
}

/**
 * The one expanded-query window for a non-null token, without expanding recurrence: the token's original slot with the
 * series' nominal span, unioned with the actual intervals of every stored override that maps to the token or cannot be
 * mapped (an unrecognized zone), padded 24 h (time-core). An `occ2_` token is matched by text only: the stored override whose
 * RECURRENCE-ID has the same token, with no zone conversion. Too wide is result_too_large; a DATE series `occ1_` token off
 * midnight, or a token on a non-recurring event, is not_found.
 */
export function occurrenceWindow(resource: OriginalResource, token: NonNullable<ReturnType<typeof parseOccurrenceId>>): { startUtc: string; endUtc: string } {
    if (resource.kind === 'single') { throw new ReadError('not_found'); }
    let related: EventComponent[];
    if (token.kind === 'stored') {
        related = resource.overrides.filter(override => override.recurrenceId?.token === token.id);
    } else {
        const seriesIsDate = resource.master !== null ? resource.master.start.kind === 'date' : resource.overrides.every(override => override.recurrenceId?.time.kind === 'date');
        if (seriesIsDate && !token.serverForm.endsWith('T000000Z')) { throw new ReadError('not_found'); }
        related = resource.overrides.filter(override => {
            const form = override.recurrenceId === null ? null : occurrenceServerForm(override.recurrenceId.time);
            return form === null || form === token.serverForm;
        });
    }
    const matched = token.kind === 'stored'
        ? related[0]
        : resource.overrides.find(override => override.recurrenceId !== null && occurrenceServerForm(override.recurrenceId.time) === token.serverForm);
    const nominalSource = resource.master ?? matched ?? null;
    const masterSpanSeconds = nominalSource === null ? 0 : nominalSpanSeconds(eventSpan(nominalSource.start, nominalSource.end, nominalSource.duration));
    try {
        return occurrenceTransportWindow({ token, masterSpanSeconds, overrideIntervals: related.flatMap(spanIntervals) });
    } catch (error) {
        throw detailDataError(error);
    }
}

/** A selected original resource: fresh membership, one multiget, the optional version check, parse and attachment refs. */
export interface OriginalRead {
    summary: CalendarSummary;
    resource: CalendarResource;
    original: OriginalResource;
    /** Every resource-wide attachment with its ref, recomputed from this read. */
    attachments: readonly AttachmentIndexEntry[];
    reporter: { report(): void; settled(): Promise<void> };
}

/** Validates the identifiers of a detail or download call. Returns the parsed occurrence token, or null. */
export function detailTarget(calendarId: string, href: string, tokenText: string | null): ReturnType<typeof parseOccurrenceId> {
    const token = tokenText === null ? null : parseOccurrenceId(tokenText);
    if (!isCanonicalPath(calendarId) || !isResourceHref(href) || (tokenText !== null && token === null)) { throw new ReadError('invalid_input'); }
    // A path that cannot be a direct child of the calendar can never name one of its events.
    if (!isDirectChildResource(calendarId, href)) { throw new ReadError('invalid_input'); }
    return token;
}

// ---- Seams shared with the write path (src/calendar/write.ts) ----

/** One complete membership listing for an invocation, with that invocation's 401 reporter. Throws ReadError. */
export async function readCalendarMembership(deps: ReadDeps): Promise<{ members: Map<string, CalendarSummary>; reporter: UnauthorizedReporter }> {
    const reporter = unauthorizedReporter(deps);
    return { members: await readMembership(deps, reporter), reporter };
}

/**
 * One calendar-multiget of one original, validated like get_event's: the same href back, a strong ETag and text data.
 * Null when iCloud reports the href absent. Throws ReadError.
 */
export async function readStoredResource(deps: ReadDeps, reporter: UnauthorizedReporter, calendarId: string, href: string): Promise<CalendarResource | null> {
    const [found] = await readStoredResources(deps, reporter, calendarId, [href]);
    return found ?? null;
}

/**
 * ONE calendar-multiget of several originals of one calendar (distinct hrefs, at most MAX_MULTIGET_HREFS), validated like
 * get_event's: exactly one answer per href, in any order, the same href back, a strong ETag and text data. Returns the
 * resources in the order asked, null where iCloud reports one absent. Throws ReadError.
 */
export async function readStoredResources(deps: ReadDeps, reporter: UnauthorizedReporter, calendarId: string, hrefs: readonly string[]): Promise<(CalendarResource | null)[]> {
    if (hrefs.length === 0 || hrefs.length > MAX_MULTIGET_HREFS || new Set(hrefs).size !== hrefs.length) { throw new ReadError('invalid_input'); }
    const lookups = await detailRequest(reporter, () => deps.backend.multigetEvents(deps.auth, deps.discovery, { calendarId, hrefs }, callOptions(deps.budget, MAX_REPORT_BYTES)));
    if (lookups.length !== hrefs.length) { throw new ReadError('upstream_error'); }
    const answers = new Map<string, CalendarResource | null>();
    for (const lookup of lookups) {
        const href = lookup.kind === 'not_found' ? lookup.href : lookup.resource.href;
        if (!hrefs.includes(href) || answers.has(href)) { throw new ReadError('upstream_error'); }
        if (lookup.kind === 'found' && (!validEtag(lookup.resource.etag) || typeof lookup.resource.calendarData !== 'string')) { throw new ReadError('upstream_error'); }
        answers.set(href, lookup.kind === 'found' ? lookup.resource : null);
    }
    return hrefs.map(href => answers.get(href) ?? null);
}

/** The expanded instances of one resource in a window, or `absent` when iCloud returned no instance of it there. */
export type ExpandedLookup = { kind: 'absent' } | { kind: 'found'; components: readonly EventComponent[] };

/**
 * One expanded REPORT over `window`, reduced to the one resource at `href`. The instances must come from the same stored
 * version that was read (`etag`) and carry its UID (`uid`), else ReadError('calendar_changed'): an expansion of another
 * version is never used. iCloud's answer for a window that holds only deleted occurrences, the series alone in the measured
 * stripped shape, is not_found (`occurrence_not_expanded`), never unsupported data. Charges the invocation's work caps.
 * Throws ReadError.
 */
export async function expandStoredResource(
    deps: ReadDeps, reporter: UnauthorizedReporter, query: { calendarId: string; href: string; etag: string; uid: string; window: { startUtc: string; endUtc: string } },
): Promise<ExpandedLookup> {
    const { budget } = deps;
    const resources = await detailRequest(reporter, () => deps.backend.queryEvents(deps.auth, deps.discovery, { calendarId: query.calendarId, range: query.window }, callOptions(budget, MAX_REPORT_BYTES)));
    try { validateReport(query.calendarId, resources); } catch (error) { throw new ReadError(toolCodeFor(error)); }
    // The target's href passed the rule, so it is never one of the unaddressable entries.
    const target = resources.filter(isAddressedResource).find(resource => resource.href === query.href);
    if (target === undefined) { return { kind: 'absent' }; }
    if (target.etag !== query.etag) { throw new ReadError('calendar_changed'); }
    let listing: ExpandedListing;
    try {
        listing = parseExpandedListing(target.calendarData, { work: budget.newResourceWork() });
        budget.newCalendarWork().chargeComponents(listing.kind === 'instances' ? listing.resource.components.length : 1);
    } catch (error) {
        throw detailDataError(error);
    }
    const components = listing.kind === 'instances' ? listing.resource.components : [listing.series.master];
    if (components.some(component => component.uid !== query.uid)) { throw new ReadError('calendar_changed'); }
    if (listing.kind === 'series_without_occurrences') { throw new ReadError('not_found', 'occurrence_not_expanded'); }
    return { kind: 'found', components };
}

/** The UID of a parsed original: the master's, else the first override's. */
export function resourceUid(resource: OriginalResource): string {
    return originalUid(resource);
}

/**
 * The get_event occurrence view of one stored resource for a token: one expanded REPORT over the token's window, matched
 * to the same version and UID. Throws ReadError (`calendar_changed` when the resource is missing from the expansion or
 * changed, `not_found` when no instance has the token).
 */
export async function occurrenceView(
    deps: ReadDeps, reporter: UnauthorizedReporter, calendarId: string, resource: CalendarResource, original: OriginalResource, tokenText: string,
): Promise<FullEvent> {
    const token = parseOccurrenceId(tokenText);
    if (token === null) { throw new ReadError('invalid_input'); }
    const window = occurrenceWindow(original, token);
    const expanded = await expandStoredResource(deps, reporter, { calendarId, href: resource.href, etag: resource.etag, uid: originalUid(original), window });
    // The resource vanished or changed between the two reads: never substitute a neighbouring occurrence.
    if (expanded.kind === 'absent') { throw new ReadError('calendar_changed'); }
    const occurrence = expanded.components.find(component => component.recurrenceId?.token === tokenText);
    if (occurrence === undefined) { throw new ReadError('not_found'); }
    return fullEvent(occurrence, { calendar: 0, resourceHref: resource.href, etag: resource.etag, recurring: true, calendarId, view: 'occurrence' });
}

/**
 * The get_event view of a parsed original without an occurrence token: the master or single event, or the sole stored
 * occurrence of a detached resource. Throws ReadError (several detached occurrences need a token; a UID over the cap).
 */
export function originalEventView(calendarId: string, summary: CalendarSummary, resource: CalendarResource, original: OriginalResource): { calendars: [CalendarStatus]; event: FullEvent } {
    const selected = nullTokenComponent(original);
    return {
        calendars: [calendarStatus(calendarId, summary, 'ok')],
        event: fullEvent(selected.component, { calendar: 0, resourceHref: resource.href, etag: resource.etag, recurring: selected.recurring, calendarId, view: selected.view }),
    };
}

/**
 * Membership, then one original multiget of the resource, then the optional expected_version check, then parse and the
 * attachment index. Shared by get_event and the download tool, so both authorize against current data the same way.
 */
export async function readOriginal(deps: ReadDeps, calendarId: string, href: string, expectedVersion: string | undefined): Promise<OriginalRead> {
    const { budget } = deps;
    const { members, reporter } = await readCalendarMembership(deps);
    const summary = members.get(calendarId);
    if (summary === undefined) { throw new ReadError('not_found'); }

    const found = await readStoredResource(deps, reporter, calendarId, href);
    if (found === null) { throw new ReadError('not_found'); }
    if (expectedVersion !== undefined && expectedVersion !== found.etag) { throw new ReadError('calendar_changed'); }

    try {
        const original = parseOriginalResource(found.calendarData, { work: budget.newResourceWork() });
        const attachments = buildAttachmentIndex({ accountId: deps.accountId, calendarId, href, resource: original, prescan: prescanAttachProperties(found.calendarData) });
        return { summary, resource: found, original, attachments, reporter };
    } catch (error) {
        throw detailDataError(error);
    }
}

export async function getEvent(deps: ReadDeps, input: GetEventArgs): Promise<DetailReadResult> {
    const calendarId = input.calendar_id;
    const href = input.resource_href;
    const tokenText = input.recurrence_id ?? null;
    const token = detailTarget(calendarId, href, tokenText);

    const { summary, resource: found, original, attachments: entries, reporter } = await readOriginal(deps, calendarId, href, input.expected_version);
    const homeUrl = deps.discovery.calendarHomeUrl;
    const attachments: AttachmentMetadata[] = entries.map(entry => toAttachmentMetadata(entry, downloadSupported(entry.descriptor, homeUrl)));

    let event: FullEvent;
    if (token === null) {
        const selected = nullTokenComponent(original);
        event = fullEvent(selected.component, { calendar: 0, resourceHref: href, etag: found.etag, recurring: selected.recurring, calendarId, view: selected.view });
    } else {
        event = await occurrenceView(deps, reporter, calendarId, found, original, token.id);
    }

    return {
        calendars: [calendarStatus(calendarId, summary, 'ok')],
        event,
        attachments,
        rawIcs: input.include_raw === true ? found.calendarData : null,
    };
}
