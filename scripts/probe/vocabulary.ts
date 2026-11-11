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

/** Every code above, plus the `probe_`-prefixed HTTP error codes the backend check reports. */
export const CODE_WORDS: ReadonlySet<string> = new Set<string>([
    ...HTTP_ERROR_CODES, ...HTTP_ERROR_CODES.map((code) => `probe_${code}`), ...BACKEND_CODES, ...VALIDATE_RESULTS,
    ...NOT_DELETED_REASONS, ...PLACEHOLDERS,
]);
