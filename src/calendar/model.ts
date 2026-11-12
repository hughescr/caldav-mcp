/**
 * Transport-neutral model types shared by the phase 2 read modules. Type-only apart from the two
 * error classes, the canonical-path predicate and the not-implemented marker used by stubs. No
 * ical.js types: jCal is described structurally so this file stays free of the parser.
 */
import { PATH_MAX } from './limits';

/** Placeholder body for modules a later package owns. Calling one is always a defect. */
export function notImplemented(name: string): never {
    throw new Error(`not implemented: ${name}`);
}

export type IcalErrorReason = 'malformed' | 'unsupported_recurrence_data' | 'unsupported_recurrence_id' | 'resource_too_large' | 'window_too_large';
/** A calendar-data problem. Carries only a fixed reason, never upstream text. */
export class IcalError extends Error {
    constructor(public readonly reason: IcalErrorReason) { super(reason); }
}

export type BudgetErrorKind = 'response_bytes' | 'aggregate_bytes' | 'work' | 'deadline';
/** A shared-capacity or deadline failure. The service maps it to a calendar status; it carries no text. */
export class BudgetError extends Error {
    constructor(public readonly kind: BudgetErrorKind) { super(kind); }
}

export const TIMEZONE_WARNINGS = ['no_timezone_on_event', 'unrecognized_timezone', 'timezone_dropped_from_date', 'utc_uncertain_dst_transition'] as const;
export type TimezoneWarning = typeof TIMEZONE_WARNINGS[number];

/** Public time value, passed through from the calendar card. See design v3 section 2. */
export type EventTime =
    | { date: string; all_day: true; timezone_warning?: 'timezone_dropped_from_date' }
    | { local: string; floating: true; timezone_warning: 'no_timezone_on_event' }
    | { utc: string }
    | { local: string; zone: string; utc?: string; offset?: string; timezone_warning?: 'unrecognized_timezone' | 'utc_uncertain_dst_transition' };

/** A time exactly as stored on the card, after literal validation and before any enrichment. */
export type StoredTime =
    | { kind: 'date'; date: string; tzid?: string }
    | { kind: 'floating'; local: string }
    | { kind: 'utc'; utc: string }
    | { kind: 'zoned'; local: string; tzid: string };

/** Half-open interval on one axis, in nanoseconds since the Unix epoch. */
export interface Interval { startNs: bigint; endNs: bigint }
/** REPORT time-range bounds in basic UTC seconds, e.g. 20260308T103000Z. */
export interface TransportWindow { startUtc: string; endUtc: string }

export type OccurrenceId = `occ1_${string}`;

/** The lexical rule behind the Path scalar. Canonical means a client may pass it back unchanged. */
export function isCanonicalPath(value: string): boolean {
    if (value.length < 1 || value.length > PATH_MAX || !value.startsWith('/') || value.startsWith('//')) { return false; }
    // Raw characters: unreserved, sub-delims, ':' '@' and the separator. Anything else must be a percent escape.
    if (!/^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-F]{2})+$/u.test(value)) { return false; }
    for (const segment of value.split('/').slice(1)) {
        if (segment === '.' || segment === '..') { return false; }
    }
    if (value.includes('//')) { return false; }
    for (const match of value.matchAll(/%([0-9A-F]{2})/gu)) {
        const code = Number.parseInt(match[1] ?? '', 16);
        // Escaped unreserved characters are non-canonical; escaped delimiters, NUL and controls are dangerous.
        if (/^[A-Za-z0-9\-._~]$/u.test(String.fromCharCode(code))) { return false; }
        if (code < 0x20 || code === 0x7F || code === 0x2F || code === 0x5C || code === 0x3F || code === 0x23) { return false; }
    }
    // A percent escape of a percent sign that itself introduces an escape decodes recursively.
    return !/%25[0-9A-Fa-f]{2}/u.test(value);
}

// ---- jCal and parsed model (filled in by calendar/ical, owned by P2) ----

export type JCalScalar = string | number | boolean | null;
export type JCalValue = JCalScalar | readonly JCalValue[] | { readonly [key: string]: JCalValue };

/** One raw property after validation: lower-case name, parameters in a Map (untrusted keys), jCal type and values. */
export interface RawProperty {
    name: string;
    params: ReadonlyMap<string, readonly string[]>;
    type: string;
    values: readonly JCalValue[];
}

export type AttachmentForm = 'managed' | 'inline' | 'external_url';
export interface AttachmentDescriptor {
    form: AttachmentForm;
    component: 'master' | 'override';
    /** Raw RID property tuple of the owning override; null for master or single. Identity only. */
    componentRecurrenceId: RawProperty | null;
    managedId: string | null;
    uri: string | null;
    filename: string | null;
    contentType: string | null;
    declaredSize: number | null;
    /** SHA-256 hex over the canonical attach-property/v1 array. */
    fingerprint: string;
    /** Count of identical fingerprints earlier in the same component. */
    ordinal: number;
    /** False when the pre-scan found duplicate or conflicting structural parameters or an invalid encoding. */
    structurallySupported: boolean;
}

export interface RecurrenceIdInfo {
    raw: RawProperty;
    time: StoredTime;
    /** Null unless the raw value is a Z date-time, a DATE or a floating date-time with no parameters (all map to the Z-form token). */
    token: OccurrenceId | null;
}

/** Structural view of one VEVENT. Display normalization happens later, from `properties`. */
export interface EventComponent {
    uid: string;
    start: StoredTime;
    end: StoredTime | null;
    /** Supplied DURATION text, or null. */
    duration: string | null;
    recurrenceId: RecurrenceIdInfo | null;
    /** Lower-case property name to properties in source order. Preserves unknown properties for future writes. */
    properties: ReadonlyMap<string, readonly RawProperty[]>;
    alarmCount: number;
    extensionPropertyCount: number;
    attachments: readonly AttachmentDescriptor[];
    /** True when RRULE, RDATE or EXDATE survived expansion. */
    retainsRecurrenceRules: boolean;
}

export interface ExpandedResource {
    components: readonly EventComponent[];
    /** VTIMEZONE components are counted and ignored, never iterated. */
    vtimezoneCount: number;
}

export interface OriginalResource {
    /** series: master (+ overrides); single: one non-recurring component; occurrence_only: iTIP detached overrides. */
    kind: 'series' | 'single' | 'occurrence_only';
    master: EventComponent | null;
    overrides: readonly EventComponent[];
    vtimezoneCount: number;
}
