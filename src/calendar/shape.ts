/**
 * The sole result builder and size policy (design v3 section 2, "Download result and MCP shaping"). Every size decision is
 * made on the UTF-8 bytes of the real serialized JSON-RPC response: the SDK projection for the protocol era, the structured
 * result, its full JSON text copy, the notices and the escaped request id, never an estimate or a structured-only allowance.
 */
import { SERVER_INFO_META_KEY, type CallToolResult } from '@modelcontextprotocol/server';
import { version } from '../../package.json';
import type { DetailReadResult, EventsReadResult } from './read';
import { eventsOutputSchema, getEventOutputSchema, type AttachmentMetadata, type EventsOutput, type FullEvent, type GetEventOutput, type SlimEvent, type Unreadable } from './event-schemas';
import {
    MAX_ATTACHMENTS, MAX_EVENTS, MAX_RAW_BYTES, MAX_UNREADABLE, MAX_WIRE_BYTES, RESULT_TOO_LARGE_NOTICE, RESUME_INSTRUCTION, RESUME_INSTRUCTION_NO_ROW,
} from './limits';
import type { EventTime } from './model';
import { civilStartText } from './time-core';

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
function toolResult(payload: EventsOutput | GetEventOutput, notices: readonly string[]): CallToolResult {
    return {
        structuredContent: payload,
        content: [{ type: 'text', text: JSON.stringify(payload) }, ...notices.map(text => ({ type: 'text' as const, text }))],
    };
}

// ---- list/search ----

interface EventsSelection { events: number; unreadable: number }

function eventsPayload(result: EventsReadResult, limit: number, chosen: EventsSelection): EventsOutput {
    const matched = result.events.length;
    const events: SlimEvent[] = result.events.slice(0, chosen.events);
    const unreadable: Unreadable[] = result.unreadable.slice(0, chosen.unreadable);
    const unreadableCount = Math.max(result.unreadableCount, unreadable.length);
    const truncated = matched > events.length;
    const reasons: EventsOutput['truncation_reasons'] = [];
    if (matched > limit) { reasons.push('result_limit'); }
    if (events.length < Math.min(limit, matched)) { reasons.push('response_bytes'); }
    const last = events.at(-1);
    const allOk = result.calendars.every(calendar => calendar.status === 'ok');
    return {
        calendars: result.calendars,
        range: { start: result.range.start, end: result.range.end },
        events,
        matched_count: matched,
        returned_count: events.length,
        unreadable,
        unreadable_count: unreadableCount,
        unreadable_truncated: unreadable.length < unreadableCount,
        truncated,
        truncation_reasons: reasons,
        ...(truncated ? {
            resume_hint: last === undefined
                ? { last_returned_civil_start: null, instruction: RESUME_INSTRUCTION_NO_ROW }
                // The schema output type only widens optional keys to `| undefined`; the value is the model EventTime.
                : { last_returned_civil_start: civilStartText(last.start as EventTime), instruction: RESUME_INSTRUCTION },
        } : {}),
        complete: !truncated && unreadableCount === 0 && allOk,
        coverage: 'server_reports',
        limitations: ['moved_overrides_unverified', 'silent_server_omissions_undetectable'],
    };
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

    // The envelope: every status and the fixed metadata. Unreadables may be shortened (the exact count stays) to make it fit.
    let unreadable = Math.min(result.unreadable.length, MAX_UNREADABLE);
    if (!attempt({ events: 0, unreadable })) {
        if (!attempt({ events: 0, unreadable: 0 })) { return errorResult('result_too_large'); }
        unreadable = largestFitting(0, unreadable - 1, count => attempt({ events: 0, unreadable: count }));
    }

    // Each row appears at least twice (structured and text copy) in at least its JSON length, which bounds the search cheaply.
    let ceiling = Math.min(limit, matched);
    let lowerBound = 0;
    for (let index = 0; index < ceiling; index++) {
        lowerBound += 2 * JSON.stringify(result.events[index]).length;
        if (lowerBound > MAX_WIRE_BYTES) { ceiling = index; break; }
    }
    // Below the full match count every candidate carries the resume hint, so fit is monotone in the row count there.
    const events = ceiling > 0 && attempt({ events: ceiling, unreadable })
        ? ceiling
        : largestFitting(0, Math.max(0, Math.min(ceiling, matched - 1)), count => attempt({ events: count, unreadable }));

    const shaped = eventsResult(result, limit, { events, unreadable });
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
    if (rawPrefix === null || result.rawIcs === null) { return { ...base, raw_included: false }; }
    const raw = unitPrefix(rawPrefix, state.raw);
    return { ...base, raw_included: true, raw_ics: raw, raw_truncated: raw.length < result.rawIcs.length, raw_representation: 'report_calendar_data' };
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
