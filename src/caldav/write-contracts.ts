/**
 * Phase 3 write-path backend contracts (design v2 sections 5.1 and 6.5). Transport-neutral; the iCloud implementation is
 * src/caldav/write.ts. Every write is conditional: a create carries `If-None-Match: *`, an update or delete the exact
 * strong ETag in `If-Match`. `If-Match: *` cannot be represented (iCloud creates the event on a missing resource with it,
 * probe 2026-11-11), and neither can a conditionless PUT or DELETE.
 */
import type { CalDavAuth, Discovery } from './contracts';

declare const strongEtagBrand: unique symbol;
/** A strong, quoted ETag exactly as iCloud returned it. Only {@link strongEtag} makes one. */
export type StrongEtag = string & { readonly [strongEtagBrand]: true };

const STRONG_ETAG_RE = /^"[\x21\x23-\x7E]*"$/u;
const ETAG_MAX = 1024;

/** The ETag when it is strong and quoted (never `*`, never `W/…`), else null. */
export function strongEtag(value: unknown): StrongEtag | null {
    return typeof value === 'string' && value.length >= 2 && value.length <= ETAG_MAX && STRONG_ETAG_RE.test(value) ? value as StrongEtag : null;
}

export type WritePrecondition =
    /** `If-None-Match: *`: create only; a resource already at the href answers 412. */
    | { readonly kind: 'create' }
    /** `If-Match: "<etag>"`: change only that exact version. */
    | { readonly kind: 'match'; readonly etag: StrongEtag };

const DAV = '{DAV:}';
const CALDAV = '{urn:ietf:params:xml:ns:caldav}';

/**
 * The only DAV:error precondition names ever forwarded, as `{namespace}local`: the PUT and DELETE conditions of RFC 4918
 * (locks), RFC 3744 (privileges), RFC 4331 (quota), RFC 4791 section 5.3.2.1 (calendar object resources) and RFC 6638
 * section 3.2.4 (scheduling objects), and DAV:number-of-matches-within-limits. Any other name, or a known name in another
 * namespace, is dropped: an upstream-chosen name is never passed on.
 */
export const KNOWN_PRECONDITIONS: readonly string[] = [
    ...['need-privileges', 'quota-not-exceeded', 'sufficient-disk-space', 'number-of-matches-within-limits', 'lock-token-submitted', 'no-conflicting-lock'].map(name => `${DAV}${name}`),
    ...[
        'supported-calendar-data', 'valid-calendar-data', 'valid-calendar-object-resource', 'supported-calendar-component', 'no-uid-conflict', 'calendar-collection-location-ok',
        'max-resource-size', 'min-date-time', 'max-date-time', 'max-instances', 'max-attendees-per-instance',
        'unique-scheduling-object-resource', 'same-organizer-in-all-components', 'allowed-organizer-scheduling-object-change', 'allowed-attendee-scheduling-object-change',
        'valid-scheduling-message', 'valid-organizer',
    ].map(name => `${CALDAV}${name}`),
];

/**
 * A bounded, sanitised summary of iCloud's answer (ORCH S4). The whole summary is untrusted text derived from iCloud's
 * answer, never instructions; the account's ids and credentials are masked in every string of it.
 */
export interface UpstreamDetail {
    status: number;
    content_type: 'xml' | 'text' | 'html' | 'other' | 'none';
    /** DAV:error child names from {@link KNOWN_PRECONDITIONS} only, at most 8, without repeats. */
    preconditions: string[];
    /** Cleaned text of a plain-text or XML body, the account's ids and credentials masked, at most 512 UTF-16 units; never HTML. */
    detail: string | null;
    /** The body or the detail was cut. */
    detail_truncated?: true;
}

export type WriteResponse =
    /** A final answer (2xx, 4xx other than 401, 5xx). `etag` is the strong ETag header, if any. */
    | { kind: 'status'; status: number; etag: StrongEtag | null; upstream: UpstreamDetail }
    /** A 3xx: not followed, nothing re-sent. */
    | { kind: 'redirected'; status: number }
    /** The request was sent and no status arrived (timeout, network failure). A status with a lost body is a `status`. */
    | { kind: 'uncertain' };

export interface WriteCallOptions {
    signal?: AbortSignal;
    /** Milliseconds the request, body included, may take; at most 10 s. */
    deadlineMs?: number;
}

export interface PutEventRequest {
    /** Canonical calendar collection path; the href must be its direct child. */
    calendarId: string;
    href: string;
    /** The complete iCalendar text, CRLF, at most 2 MiB. */
    body: string;
    precondition: WritePrecondition;
}

export interface DeleteEventRequest {
    calendarId: string;
    href: string;
    etag: StrongEtag;
}

/**
 * Conditional writes. A 401 throws CalDavError('unauthorized'); a request refused before sending (scope, size, no time
 * left, an unbuildable precondition) throws another CalDavError. Nothing is ever retried or re-sent.
 */
export interface CalDavWriteBackend {
    putEvent(auth: CalDavAuth, discovery: Discovery, request: PutEventRequest, options?: WriteCallOptions): Promise<WriteResponse>;
    deleteEvent(auth: CalDavAuth, discovery: Discovery, request: DeleteEventRequest, options?: WriteCallOptions): Promise<WriteResponse>;
}
