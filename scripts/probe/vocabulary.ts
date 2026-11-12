/**
 * Enum-like strings the probe itself writes into evidence and the cleanup report. The
 * second redaction layer never rewrites them: they are the same in every run, so changing
 * one would reveal that some value from the account occurs inside it.
 */
export const HTTP_ERROR_CODES = [
    'forbidden_host', 'method_not_allowed', 'write_outside_probe_calendar', 'request_cap', 'timeout', 'network',
    'too_many_redirects', 'body_too_large', 'throttled_abort', 'deadline', 'interrupted', 'unauthorized',
] as const;

/** Error codes a loaded skeleton backend may report, kept as they are. */
export const BACKEND_CODES = ['unauthorized', 'temporary', 'forbidden_host', 'protocol'] as const;

/** Results of the skeleton backend's validate(), kept as they are. */
export const VALIDATE_RESULTS = ['valid', 'expired', 'temporary'] as const;

export const NOT_DELETED_REASONS = [
    'url_not_probe_pattern', 'not_calendar', 'shared', 'subscribed', 'sharing_property', 'not_owned', 'foreign_resource',
    'contents_unreadable', 'too_many_resources', 'not_confirmed', 'registration_refused', 'still_listed', 'server_chosen_url',
] as const;

/** Placeholders the reducers write in place of a value. */
export const PLACEHOLDERS = ['<other>', '<none>', '<non-path>', '<scrubbed>', 'other'] as const;

/**
 * The fixed enums of the attachment checks (host class, scheme class, top-level content type
 * class, ATTACH form, what a server did with an ATTACH, why nothing was fetched). Each is chosen
 * by the probe's own classification, never copied from a response.
 */
export const ATTACHMENT_CODES = [
    'caldav-root', 'caldav-partition', 'icloud-other', 'icloud-content', 'apple-other', 'unparseable',
    'https', 'http',
    'application', 'image', 'text', 'audio', 'video', 'missing',
    'inline-binary', 'uri-managed', 'uri-unmanaged', 'none',
    'preserved', 'converted-to-managed', 'dropped', 'modified',
    'none-found', 'host-not-allowed',
    // The one media type the probe uploads itself (a FMTTYPE read back from its own attachment).
    'text/plain',
    'digits', 'uuid', 'hex', 'filename', 'literal:attachment', 'literal:attachments', 'literal:calendars',
    'action', 'managed-id', 'token', 'download', 'basic', 'bearer', 'digest', 'x-mobileme-authtoken',
] as const;

/**
 * The fixed enums of the phase 3 checks (probe 0.6.0): what a PUT did to a TZID, the class of a
 * body's Content-Type, line endings, what happened to a nonsense RRULE, how expansion renders an
 * overridden instance's RECURRENCE-ID, and the invite steps' request labels and roles.
 */
export const PHASE3_CODES = [
    'kept-tzid', 'floating', 'utc', 'tzid', 'date', 'invalid', 'tzid-changed',
    'xml', 'html', 'plain', 'calendar', 'json',
    'crlf', 'lf', 'mixed',
    'internal', 'stopped', 'refused', 'unread', 'unavailable', 'hidden', 'shown', 'stored-no-instances', 'stored-one-instance', 'stored-many-instances',
    'b-utc-token', 'a-stored-text',
    'create', 'update', 'delete', 'read', 'add-attendee', 'remove-attendee', 'alarm-only', 'transp-only', 'time-change', 'description-only',
    'override', 'exdate', 'split-new', 'split-truncate', 'partstat-accepted', 'summary-change', 'create-client', 'create-none',
    'I1', 'I2', 'I2b', 'I3', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10',
] as const;

/** Every code above, plus the `probe_`-prefixed HTTP error codes the backend check reports. */
export const CODE_WORDS: ReadonlySet<string> = new Set<string>([
    ...HTTP_ERROR_CODES, ...HTTP_ERROR_CODES.map((code) => `probe_${code}`), ...BACKEND_CODES, ...VALIDATE_RESULTS,
    ...NOT_DELETED_REASONS, ...PLACEHOLDERS, ...ATTACHMENT_CODES, ...PHASE3_CODES,
]);
