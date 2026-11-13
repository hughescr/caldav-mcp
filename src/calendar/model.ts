/**
 * Transport-neutral model types shared by the phase 2 read modules. Type-only apart from the two
 * error classes, the path and resource-href predicates and the not-implemented marker used by stubs. No
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

/**
 * Opaque occurrence token. `occ1_YYYYMMDDTHHMMSSZ` names an occurrence whose expanded RECURRENCE-ID is a `…Z` date-time, a
 * `VALUE=DATE` date or a floating date-time; `occ2_YYYYMMDDTHHMMSS_<base64url TZID>` one whose expanded RECURRENCE-ID is a
 * TZID date-time (iCloud's form for a stored override of a TZID series), as text, with no zone conversion.
 */
export type OccurrenceId = `occ1_${string}` | `occ2_${string}`;

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

/**
 * The last segment of a resource href: an opaque name issued by iCloud, never decoded, re-encoded or case-normalised.
 * Raw characters are RFC 3986 pchar (unreserved, sub-delims, ':' and '@'); every '%' starts an escape of two hex digits in
 * either case. A double-encoded slash (`%252F`), `%3A` and every other escape are ordinary characters of the name.
 * Refused: an empty name; `.` and `..`, also as a single case-insensitive decode (WHATWG URL resolves `%2e` and `%2E%2E` as
 * dot segments); a single-encoded slash or backslash (`%2F`, `%5C`, either case), the one form a single upstream decode
 * would turn into a path separator; escaped C0 controls and DEL; and raw characters outside pchar, which WHATWG URL would
 * percent-encode (space, `"`, `<`, `>`, `` ` ``, `{`, `}`, `^`) or which are not valid in a URI path (`|`, `[`, `]`, `\`,
 * non-ASCII), so the bytes sent could differ from the bytes issued.
 */
export function isResourceName(name: string): boolean {
    if (name.length === 0 || !/^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+$/u.test(name)) { return false; }
    const decoded = name.replace(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded === '.' || decoded === '..') { return false; }
    for (const match of name.matchAll(/%([0-9A-Fa-f]{2})/gu)) {
        const code = Number.parseInt(match[1] ?? '', 16);
        if (code < 0x20 || code === 0x7F || code === 0x2F || code === 0x5C) { return false; }
    }
    return true;
}

/**
 * The lexical rule behind the public resource href: a canonical calendar collection path (see {@link isCanonicalPath},
 * unchanged) followed by exactly one {@link isResourceName} segment, at most PATH_MAX characters in all. The client passes
 * it back byte for byte; it is sent to iCloud byte for byte.
 */
export function isResourceHref(value: string): boolean {
    if (value.length > PATH_MAX) { return false; }
    const slash = value.lastIndexOf('/');
    if (slash < 1) { return false; }
    const collection = value.slice(0, slash + 1);
    return isCanonicalPath(collection) && isResourceName(value.slice(slash + 1));
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
    /** The exact unfolded base64 text of an inline attachment, null otherwise. Never part of metadata. */
    inlineBase64: string | null;
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
    /**
     * `occ1_` for a Z date-time, a DATE or a floating date-time with no parameters; `occ2_` for a local date-time whose only
     * parameter is one TZID within MAX_TOKEN_TZID_BYTES; null for anything else.
     */
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
    /**
     * True when the VEVENT has RRULE, RDATE or EXDATE. Read only for an original master (series or single); on an expanded
     * instance it can be true only from a leftover RDATE/EXDATE, which says nothing about that instance.
     */
    retainsRecurrenceRules: boolean;
}

export interface ExpandedResource {
    components: readonly EventComponent[];
    /** VTIMEZONE components are counted and ignored, never iterated. */
    vtimezoneCount: number;
}

/**
 * An expanded-query answer that is a stored series master alone, in the stripped shape iCloud returns when the window holds
 * only deleted occurrences (measured 2026-11-13; see ical.ts parseExpandedListing). Values as stored; nothing computed.
 */
export interface StrippedSeries {
    master: EventComponent;
    /** The RRULE value text, unfolded, exactly as stored. */
    repeatRule: string;
    /** Every EXDATE value of the master, in stored order (the range filter reads them all; an entry shows the first few). */
    excludedStarts: readonly StoredTime[];
}

export interface OriginalResource {
    /** series: master (+ overrides); single: one non-recurring component; occurrence_only: iTIP detached overrides. */
    kind: 'series' | 'single' | 'occurrence_only';
    master: EventComponent | null;
    overrides: readonly EventComponent[];
    vtimezoneCount: number;
}
