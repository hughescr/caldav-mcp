export type CalDavErrorCode = 'unauthorized' | 'temporary' | 'forbidden_host' | 'protocol';
export class CalDavError extends Error {
    constructor(public readonly code: CalDavErrorCode) { super(code); }
}
export interface CalDavAuth { appleId: string; appPassword: string }
export interface Discovery { principalUrl: string; calendarHomeUrl: string }
export interface CalendarSummary {
    /** Collection URL path (no scheme/host), opaque to clients. */
    id: string;
    /** Untrusted user data. null when the server gave none. */
    displayName: string | null;
    /** Upper-case component names the collection declares, e.g. ['VEVENT']. */
    components: string[];
    /** Untrusted. Apple calendar-color value if present, else null. */
    color: string | null;
}
export interface CalDavBackend {
    /** Proves the credentials and finds the account URLs. Starts at https://caldav.icloud.com/ only. */
    discover(auth: CalDavAuth): Promise<Discovery>;
    /** Cheap credential check against stored URLs: 'valid' | 'expired' (definitive 401) | 'temporary'. Never throws. */
    validate(auth: CalDavAuth, discovery: Discovery): Promise<'valid' | 'expired' | 'temporary'>;
    /** Calendar collections under the home that declare VEVENT. Throws CalDavError. */
    listCalendars(auth: CalDavAuth, discovery: Discovery): Promise<CalendarSummary[]>;
}
