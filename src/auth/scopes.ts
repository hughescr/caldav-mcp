/**
 * Single source of truth for the supported scopes and the words the consent page uses for them.
 * The order here is the order of the rows on the consent page.
 */
export const SCOPES: readonly string[] = Object.freeze(['calendar:read', 'calendar:write', 'calendar:delete', 'calendar:invite']);
/** Granted whenever a client requests no scope. On the consent page it is a fixed row, never a checkbox. */
export const DEFAULT_SCOPE = 'calendar:read';
/** Every scope's consent-page label. The page and the `insufficient_scope` tool error both quote these. */
export const SCOPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
    'calendar:read': 'Read your calendars and events',
    'calendar:write': 'Create and change events',
    'calendar:delete': 'Delete events (whole events, single occurrences, or all following occurrences)',
    'calendar:invite': 'Change events that involve other people. iCloud emails them at once: invitations, updates and cancellations from your Apple Account. Has effect only together with create/change or delete.',
});
/** Requested scopes the user may grant pre-ticked. calendar:invite is never in this set: mail-sending needs a deliberate tick. */
export const PRE_TICKED: ReadonlySet<string> = new Set(['calendar:write', 'calendar:delete']);
/** Scopes whose checkbox carries the SENSITIVE marker. */
export const SENSITIVE: ReadonlySet<string> = new Set(['calendar:invite']);
