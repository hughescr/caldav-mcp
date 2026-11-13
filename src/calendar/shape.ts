/**
 * The sole result builder and size policy (design v3 section 2, "Download result and MCP shaping"). Every size decision is
 * made on the UTF-8 bytes of the real serialized JSON-RPC response: the SDK projection for the protocol era, the structured
 * result, its full JSON text copy, the notices and the escaped request id, never an estimate or a structured-only allowance.
 */
import { SERVER_INFO_META_KEY, type CallToolResult } from '@modelcontextprotocol/server';
import { version } from '../../package.json';
import type { DetailReadResult, EventsReadResult } from './read';
import {
    downloadOutputSchema, eventsOutputSchema, getEventOutputSchema, type AttachmentMetadata, type DownloadOutput, type EventsOutput, type FullEvent, type GetEventOutput, type SlimEvent, type Unreadable,
} from './event-schemas';
import {
    MAX_ATTACHMENTS, MAX_EVENTS, MAX_RAW_BYTES, MAX_SERIES_WITHOUT_OCCURRENCES, MAX_UNREADABLE, MAX_WIRE_BYTES, RESULT_TOO_LARGE_NOTICE, RESUME_INSTRUCTION, RESUME_INSTRUCTION_NO_ROW,
} from './limits';
import type { EventTime } from './model';
import {
    DELETE_STORED_DIFFERS_NOTE, DOWNLOAD_LINK_NOTE, EXCEPTIONS_DROPPED_NOTE, EXTERNAL_ATTACHMENT_NOTE, notesField, OUTCOME_NOTES, RANGE_MARGIN_NOTE, READBACK_UNAVAILABLE_NOTE, SPLIT_OUTCOME_NOTE,
    STORED_DIFFERS_NOTE, timezoneNotes,
} from './notes';
import { civilStartText } from './time-core';
import { deleteEventResultSchema, writeEventResultSchema, type DeleteEventResult, type WriteEventResult } from './write-schemas';

/**
 * What the sole result builder needs to measure the real serialized JSON-RPC response, not an estimate of it.
 * `legacy` is the 2025-11-25 protocol era (the result is serialized as projected); `modern` is 2026-07-28, whose projected
 * result also carries `resultType` and `_meta`. `serialize`, when given, serializes the complete JSON-RPC response for a
 * result exactly as the transport will and is measured instead of the built-in projection.
 */
export interface WireContext {
    /** The JSON-RPC request id, escaped exactly as the transport will write it. */
    jsonRpcId: string | number;
    protocolEra: 'legacy' | 'modern';
    serialize?: (result: CallToolResult) => string;
}

export interface EventsShapeOptions {
    /** Requested event limit, 1..100. */
    limit: number;
    wire: WireContext;
}

export interface DetailShapeOptions { wire: WireContext }

/** The identity this server's McpServer stamps on modern-era results (mcp.ts constructs it with these values). */
const SERVER_INFO = { name: 'caldav-mcp', version } as const;

/** Fixed message when even the immutable part of a result cannot fit the wire cap. */
export const RESPONSE_TOO_LARGE_MESSAGE = 'The result does not fit the 96 KiB response limit even after shortening. Narrow the range, select fewer calendars, or omit include_raw.';
const UPSTREAM_ERROR_MESSAGE = 'iCloud returned a response this server could not use safely. Please try again later.';

// ---- Wire projection and measurement ----

function isObjectValue(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The SDK's text fallback: a non-object structured value gets a JSON text copy when the result has no text block. */
function withTextFallback(result: CallToolResult): CallToolResult {
    const structured = result.structuredContent;
    if (structured === undefined || isObjectValue(structured) || (result.content?.some(item => item.type === 'text') ?? false)) { return result; }
    return { ...result, content: [...(result.content ?? []), { type: 'text', text: JSON.stringify(structured) }] };
}

/**
 * The result exactly as @modelcontextprotocol/server 2.4 projects and encodes it for tools/call on an object-root output
 * schema: 2025-11-25 wraps only non-object structured values; 2026-07-28 stamps `resultType` and the server identity.
 */
function projectResult(result: CallToolResult, era: WireContext['protocolEra']): Record<string, unknown> {
    const projected: Record<string, unknown> = { ...withTextFallback(result) };
    if (era === 'legacy') {
        const structured = projected['structuredContent'];
        if (structured !== undefined && !isObjectValue(structured)) { projected['structuredContent'] = { result: structured }; }
        return projected;
    }
    if (projected['resultType'] === undefined) { projected['resultType'] = 'complete'; }
    const meta = projected['_meta'];
    if (meta === undefined) {
        projected['_meta'] = { [SERVER_INFO_META_KEY]: SERVER_INFO };
    } else if (isObjectValue(meta) && (meta as Record<string, unknown>)[SERVER_INFO_META_KEY] === undefined) {
        projected['_meta'] = { ...(meta as Record<string, unknown>), [SERVER_INFO_META_KEY]: SERVER_INFO };
    }
    return projected;
}

/** UTF-8 bytes of the SDK-projected, serialized JSON-RPC response for this tool result in this wire context. */
export function measureWireBytes(result: CallToolResult, wire: WireContext): number {
    if (wire.serialize !== undefined) { return Buffer.byteLength(wire.serialize(result), 'utf8'); }
    return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: wire.jsonRpcId, result: projectResult(result, wire.protocolEra) }), 'utf8');
}

function fits(result: CallToolResult, wire: WireContext): boolean {
    return measureWireBytes(result, wire) <= MAX_WIRE_BYTES;
}

/** Largest n in [low, high] with ok(n), given ok is monotone (true then false) and ok(low) is true. */
function largestFitting(low: number, high: number, ok: (n: number) => boolean): number {
    let good = low;
    let bad = high + 1;
    while (bad - good > 1) {
        const middle = good + Math.floor((bad - good) / 2);
        if (ok(middle)) { good = middle; } else { bad = middle; }
    }
    return good;
}

/** A fixed, sanitized tool failure in the shape mcp.ts uses. Carries no upstream text. */
function errorResult(code: 'result_too_large' | 'upstream_error'): CallToolResult {
    const message = code === 'result_too_large' ? RESPONSE_TOO_LARGE_MESSAGE : UPSTREAM_ERROR_MESSAGE;
    return { isError: true, structuredContent: { error: { code, message } }, content: [{ type: 'text', text: message }] };
}

/** Structured content, its full JSON text copy first (text-only clients see everything), then fixed notices. */
function toolResult(payload: EventsOutput | GetEventOutput | DownloadOutput | WriteEventResult | DeleteEventResult, notices: readonly string[]): CallToolResult {
    return {
        structuredContent: payload,
        content: [{ type: 'text', text: JSON.stringify(payload) }, ...notices.map(text => ({ type: 'text' as const, text }))],
    };
}

// ---- list/search ----

interface EventsSelection { events: number; unreadable: number; series: number }

/** A time with a fixed instant: UTC, or a recognised zone. All-day, floating and unrecognised-zone times have none. */
const hasInstant = (time: SlimEvent['start']): boolean => 'utc' in time && time.utc !== undefined;

/** The notes of a list/search payload: each timezone warning in it, and the range margin when an event has no instant. */
function eventsNotes(payload: Omit<EventsOutput, 'notes'>): { notes?: string[] } {
    const found = timezoneNotes(payload);
    if (payload.events.some(event => !hasInstant(event.start) || (event.end !== null && !hasInstant(event.end)))) { found.add(RANGE_MARGIN_NOTE); }
    return notesField(found);
}

function eventsPayload(result: EventsReadResult, limit: number, chosen: EventsSelection): EventsOutput {
    const matched = result.events.length;
    const events: SlimEvent[] = result.events.slice(0, chosen.events);
    const unreadable: Unreadable[] = result.unreadable.slice(0, chosen.unreadable);
    const series = result.seriesWithoutOccurrences.slice(0, chosen.series);
    const unreadableCount = Math.max(result.unreadableCount, unreadable.length);
    const truncated = matched > events.length;
    const reasons: EventsOutput['truncation_reasons'] = [];
    if (matched > limit) { reasons.push('result_limit'); }
    if (events.length < Math.min(limit, matched)) { reasons.push('response_bytes'); }
    const last = events.at(-1);
    const allOk = result.calendars.every(calendar => calendar.status === 'ok');
    const seriesTruncated = series.length < result.seriesWithoutOccurrences.length;
    const payload = {
        calendars: result.calendars,
        range: { start: result.range.start, end: result.range.end },
        events,
        matched_count: matched,
        returned_count: events.length,
        unreadable,
        unreadable_count: unreadableCount,
        unreadable_truncated: unreadable.length < unreadableCount,
        // Omitted when empty: the rare case costs nothing in the common result. Their presence is not an error, so it does
        // not affect `complete`; leaving some out does.
        ...(series.length > 0 ? { series_without_occurrences: series } : {}),
        // Also when the wire cap left no entry at all, so a cut is never silent.
        ...(seriesTruncated ? { series_without_occurrences_truncated: true as const } : {}),
        truncated,
        truncation_reasons: reasons,
        ...(truncated ? {
            resume_hint: last === undefined
                ? { last_returned_civil_start: null, instruction: RESUME_INSTRUCTION_NO_ROW }
                // The schema output type only widens optional keys to `| undefined`; the value is the model EventTime.
                : { last_returned_civil_start: civilStartText(last.start as EventTime), instruction: RESUME_INSTRUCTION },
        } : {}),
        complete: !truncated && unreadableCount === 0 && allOk && !seriesTruncated,
        coverage: 'server_reports' as const,
        limitations: ['moved_overrides_unverified', 'silent_server_omissions_undetectable'] as ['moved_overrides_unverified', 'silent_server_omissions_undetectable'],
    };
    return { ...payload, ...eventsNotes(payload) };
}

/** Fixed notices, rendered from trusted constants and counts only. */
function eventsNotices(payload: EventsOutput): string[] {
    const notices: string[] = [];
    if (payload.truncated) { notices.push(`Returned ${payload.returned_count} of ${payload.matched_count} matching events; see resume_hint.`); }
    if (payload.unreadable_count > 0) { notices.push(`${payload.unreadable_count} items in this range could not be read; see unreadable.`); }
    if (payload.calendars.some(calendar => calendar.status !== 'ok')) { notices.push('Some calendars were not read; see the status of each calendar.'); }
    if (payload.calendars.some(calendar => calendar.status === 'result_too_large')) { notices.push(RESULT_TOO_LARGE_NOTICE); }
    return notices;
}

function eventsResult(result: EventsReadResult, limit: number, chosen: EventsSelection): CallToolResult {
    const payload = eventsPayload(result, limit, chosen);
    return toolResult(payload, eventsNotices(payload));
}

/**
 * Reserves complete calendar statuses and fixed metadata, then picks the longest sorted event prefix under the limit and the
 * 96 KiB wire cap. Emits the resume hint and fixed notices. Fails with a fixed result_too_large result if the immutable
 * envelope cannot fit.
 */
export function shapeEventsResult(result: EventsReadResult, options: EventsShapeOptions): CallToolResult {
    const { wire } = options;
    const limit = Math.min(Math.max(1, Math.trunc(options.limit)), MAX_EVENTS);
    const matched = result.events.length;
    const attempt = (chosen: EventsSelection): boolean => fits(eventsResult(result, limit, chosen), wire);

    // The envelope: every status and the fixed metadata. Series entries, then unreadables, may be shortened (each says so:
    // series_without_occurrences_truncated, and the exact unreadable count) to make it fit.
    let unreadable = Math.min(result.unreadable.length, MAX_UNREADABLE);
    let series = Math.min(result.seriesWithoutOccurrences.length, MAX_SERIES_WITHOUT_OCCURRENCES);
    if (!attempt({ events: 0, unreadable, series })) {
        if (!attempt({ events: 0, unreadable: 0, series: 0 })) { return errorResult('result_too_large'); }
        if (attempt({ events: 0, unreadable, series: 0 })) {
            series = largestFitting(0, series - 1, count => attempt({ events: 0, unreadable, series: count }));
        } else {
            series = 0;
            unreadable = largestFitting(0, unreadable - 1, count => attempt({ events: 0, unreadable: count, series }));
        }
    }

    // Each row appears at least twice (structured and text copy) in at least its JSON length, which bounds the search cheaply.
    let ceiling = Math.min(limit, matched);
    let lowerBound = 0;
    for (let index = 0; index < ceiling; index++) {
        lowerBound += 2 * JSON.stringify(result.events[index]).length;
        if (lowerBound > MAX_WIRE_BYTES) { ceiling = index; break; }
    }
    // Below the full match count every candidate carries the resume hint, so fit is monotone in the row count there.
    const events = ceiling > 0 && attempt({ events: ceiling, unreadable, series })
        ? ceiling
        : largestFitting(0, Math.max(0, Math.min(ceiling, matched - 1)), count => attempt({ events: count, unreadable, series }));

    const shaped = eventsResult(result, limit, { events, unreadable, series });
    return eventsOutputSchema.safeParse(shaped.structuredContent).success ? shaped : errorResult('upstream_error');
}

// ---- get_event ----

/** Longest prefix of whole code points whose UTF-8 encoding fits `maxBytes`. */
function utf8Prefix(text: string, maxBytes: number): string {
    if (text.length <= maxBytes / 3 || Buffer.byteLength(text, 'utf8') <= maxBytes) { return text; }
    let bytes = 0;
    let end = 0;
    for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        if (bytes + size > maxBytes) { break; }
        bytes += size;
        end += character.length;
    }
    return text.slice(0, end);
}

/** Prefix of at most `units` UTF-16 units that never splits a surrogate pair. */
function unitPrefix(text: string, units: number): string {
    let end = Math.min(units, text.length);
    const last = text.charCodeAt(end - 1);
    if (end > 0 && end < text.length && last >= 0xD800 && last <= 0xDBFF) { end--; }
    return text.slice(0, end);
}

interface DetailState {
    raw: number;
    attendees: number;
    attachments: number;
    description: number;
    location: number;
    title: number;
}

function detailPayload(result: DetailReadResult, rawPrefix: string | null, allAttachments: readonly AttachmentMetadata[], state: DetailState): GetEventOutput {
    const source = result.event;
    const event: FullEvent = { ...source, attendees: source.attendees.slice(0, state.attendees) };
    if (event.attendees.length < source.attendees.length) { event.attendees_truncated = true; }
    const textFields = [['description', 'description_truncated'], ['location', 'location_truncated'], ['title', 'title_truncated']] as const;
    for (const [field, flag] of textFields) {
        const value = source[field];
        if (value !== null && state[field] < value.length) {
            event[field] = unitPrefix(value, state[field]);
            event[flag] = true;
        }
    }
    const attachments = allAttachments.slice(0, state.attachments);
    const base = {
        calendars: result.calendars,
        event,
        attachments,
        attachments_total: allAttachments.length,
        attachments_truncated: attachments.length < allAttachments.length,
    };
    // Cutting text never changes a time, so the notes are the same for every candidate.
    const notes = notesField(timezoneNotes(base));
    if (rawPrefix === null || result.rawIcs === null) { return { ...base, raw_included: false, ...notes }; }
    const raw = unitPrefix(rawPrefix, state.raw);
    return { ...base, raw_included: true, raw_ics: raw, raw_truncated: raw.length < result.rawIcs.length, raw_representation: 'report_calendar_data', ...notes };
}

/** Reduces in order: raw prefix, attendee suffix, attachment suffix, description/location/title prefixes. */
export function shapeEventDetail(result: DetailReadResult, options: DetailShapeOptions): CallToolResult {
    const { wire } = options;
    const rawPrefix = result.rawIcs === null ? null : utf8Prefix(result.rawIcs, MAX_RAW_BYTES);
    const attachments = result.attachments;
    const source = result.event;
    const state: DetailState = {
        raw: rawPrefix?.length ?? 0,
        attendees: source.attendees.length,
        attachments: Math.min(attachments.length, MAX_ATTACHMENTS),
        description: source.description?.length ?? 0,
        location: source.location?.length ?? 0,
        title: source.title?.length ?? 0,
    };
    const build = (candidate: DetailState): CallToolResult => toolResult(detailPayload(result, rawPrefix, attachments, candidate), []);
    const attempt = (candidate: DetailState): boolean => fits(build(candidate), wire);

    if (!attempt(state)) {
        let fitted = false;
        for (const key of ['raw', 'attendees', 'attachments', 'description', 'location', 'title'] as const) {
            const full = state[key];
            if (full === 0) { continue; }
            if (attempt({ ...state, [key]: 0 })) {
                state[key] = largestFitting(0, full - 1, amount => attempt({ ...state, [key]: amount }));
                fitted = true;
                break;
            }
            state[key] = 0;
        }
        // Identities, times and totals are never cut: if they alone cannot fit, the result is too large.
        if (!fitted && !attempt(state)) { return errorResult('result_too_large'); }
    }

    const shaped = build(state);
    return getEventOutputSchema.safeParse(shaped.structuredContent).success ? shaped : errorResult('upstream_error');
}

// ---- create_event / update_event / delete_event ----

interface EventTextState { attendees: number; description: number; location: number; title: number }

function withEventCut(event: FullEvent, state: EventTextState): FullEvent {
    const cut: FullEvent = { ...event, attendees: event.attendees.slice(0, state.attendees) };
    if (cut.attendees.length < event.attendees.length) { cut.attendees_truncated = true; }
    for (const [field, flag] of [['description', 'description_truncated'], ['location', 'location_truncated'], ['title', 'title_truncated']] as const) {
        const value = event[field];
        if (value !== null && state[field] < value.length) {
            cut[field] = unitPrefix(value, state[field]);
            cut[flag] = true;
        }
    }
    return cut;
}

/**
 * The write result with its event shortened like get_event's (attendee suffix, then description, location, title
 * prefixes) until the whole response fits 96 KiB. The outcome fields are never cut: if even a fully shortened event
 * cannot fit, the event is left out and the result says `readback: "unavailable"`, so an applied write is never reported
 * as a failure.
 */
/**
 * The notes of a write result: a write_outcome other than the ordinary "applied" (a split's new series too), and each
 * rare field or timezone warning it holds. An ordinary save has none.
 */
function writeNotes(payload: WriteEventResult): { notes?: string[] } {
    const found = timezoneNotes(payload);
    if (payload.write_outcome === 'desired_state_present') { found.add(OUTCOME_NOTES.desired_state_present); }
    const created = payload.created_series;
    if (created !== undefined) {
        found.add(SPLIT_OUTCOME_NOTE);
        // A result names only a confirmed new series (the schema refuses `unconfirmed` here).
        if (created.write_outcome === 'desired_state_present') { found.add(OUTCOME_NOTES.desired_state_present); }
    }
    if (payload.readback === 'unavailable') { found.add(READBACK_UNAVAILABLE_NOTE); }
    if ((payload.stored_differs_from_request?.length ?? 0) > 0) { found.add(STORED_DIFFERS_NOTE); }
    if (payload.exceptions_dropped !== undefined) { found.add(EXCEPTIONS_DROPPED_NOTE); }
    return notesField(found);
}

export function shapeWriteResult(input: WriteEventResult, options: DetailShapeOptions): CallToolResult {
    if (!writeEventResultSchema.safeParse(input).success) { return errorResult('upstream_error'); }
    const { wire } = options;
    // The notes are the server's own, computed from what is sent; any given ones are replaced.
    const { notes: _given, ...result } = input;
    const source = result.event;
    const build = (event: FullEvent | null): CallToolResult => {
        const payload: WriteEventResult = event === null ? { ...result, readback: 'unavailable', stored_differs_from_request: null, event: null } : { ...result, event };
        return toolResult({ ...payload, ...writeNotes(payload) }, []);
    };
    if (source === null) { return fits(build(null), wire) ? build(null) : errorResult('upstream_error'); }
    const state: EventTextState = { attendees: source.attendees.length, description: source.description?.length ?? 0, location: source.location?.length ?? 0, title: source.title?.length ?? 0 };
    const attempt = (candidate: EventTextState): boolean => fits(build(withEventCut(source, candidate)), wire);
    if (!attempt(state)) {
        let fitted = false;
        for (const key of ['attendees', 'description', 'location', 'title'] as const) {
            const full = state[key];
            if (full === 0) { continue; }
            if (attempt({ ...state, [key]: 0 })) {
                state[key] = largestFitting(0, full - 1, amount => attempt({ ...state, [key]: amount }));
                fitted = true;
                break;
            }
            state[key] = 0;
        }
        if (!fitted && !attempt(state)) { return fits(build(null), wire) ? build(null) : errorResult('upstream_error'); }
    }
    const shaped = build(withEventCut(source, state));
    return writeEventResultSchema.safeParse(shaped.structuredContent).success ? shaped : errorResult('upstream_error');
}

/** The delete result: fixed fields, identifiers and the notes of its outcome; validated, never cut. */
export function shapeDeleteResult(input: DeleteEventResult, options: DetailShapeOptions): CallToolResult {
    if (!deleteEventResultSchema.safeParse(input).success) { return errorResult('upstream_error'); }
    const { notes: _given, ...result } = input;
    const found = new Set<string>(result.write_outcome === 'desired_state_present' ? [OUTCOME_NOTES.desired_state_present] : []);
    if (result.readback === 'unavailable') { found.add(READBACK_UNAVAILABLE_NOTE); }
    if (result.stored_differs_from_request?.includes('recurrence') === true) { found.add(DELETE_STORED_DIFFERS_NOTE); }
    const shaped = toolResult({ ...result, ...notesField(found) }, []);
    return deleteEventResultSchema.safeParse(shaped.structuredContent).success && fits(shaped, options.wire) ? shaped : errorResult('upstream_error');
}

// ---- get_event_attachment_download ----

/**
 * Structured result and its JSON text copy. Every download_url comes with the note on handling it; an external link with
 * the note that it was not fetched and is untrusted (fixed text that does not repeat the link). The link is in each
 * representation once. Nothing in it is shortened: if it cannot fit, it is result_too_large.
 */
export function shapeDownloadResult(input: DownloadOutput, options: DetailShapeOptions): CallToolResult {
    if (!downloadOutputSchema.safeParse(input).success) { return errorResult('upstream_error'); }
    const { notes: _given, ...result } = input;
    const found: string[] = [];
    if (result.download_url !== undefined) { found.push(DOWNLOAD_LINK_NOTE); }
    if (result.form === 'external') { found.push(EXTERNAL_ATTACHMENT_NOTE); }
    const shaped = toolResult({ ...result, ...notesField(found) }, []);
    if (!downloadOutputSchema.safeParse(shaped.structuredContent).success) { return errorResult('upstream_error'); }
    return fits(shaped, options.wire) ? shaped : errorResult('result_too_large');
}
