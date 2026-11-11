import { CalDavError, type CalDavBackend } from '../caldav/contracts';
import { UnreadableCredentials, type ConnectionStatus, type UpstreamCredentials } from '../auth/contracts';
import { MAX_CALENDARS, calendarSummarySchema, type ListCalendarsOutput, type ToolErrorCode } from './schemas';

/** A fixed, sanitized tool failure. It never carries upstream text. */
export class CalendarError extends Error {
    constructor(public readonly code: ToolErrorCode) { super(code); }
}

export interface BoundCalendarService {
    list_calendars(input: Record<string, never>): Promise<ListCalendarsOutput>;
}

export interface CalendarBinding {
    caldav: Pick<CalDavBackend, 'listCalendars'>;
    connectionStatus: ConnectionStatus;
    /**
     * Decrypts and re-validates the stored credentials. Called only when a tool needs iCloud and
     * the connection is active; throws UnreadableCredentials for a record that can never be used.
     * The result never leaves this closure.
     */
    credentials: () => UpstreamCredentials;
    /** CAS transition of the observed connection to reconnect_required. */
    markReconnectRequired: () => Promise<boolean>;
}

const calendarList = calendarSummarySchema.array();

/** Builds a request-local service whose closures hold the credentials, outside tool arguments, results and authInfo. */
export function bindCalendarService(binding: CalendarBinding): BoundCalendarService {
    const markReconnectRequired = async () => {
        // The client is told to reconnect even if recording fails, because that is still true.
        try { await binding.markReconnectRequired(); } catch { /* the next call re-detects it */ }
    };
    const upstream = async <T>(call: (credentials: UpstreamCredentials) => Promise<T>): Promise<T> => {
        if (binding.connectionStatus !== 'active') { throw new CalendarError('reconnect_required'); }
        let credentials: UpstreamCredentials;
        try { credentials = binding.credentials(); } catch (error) {
            if (!(error instanceof UnreadableCredentials)) { throw new CalendarError('temporarily_unavailable'); }
            // A stored credential that can never be opened needs a new login, like a revoked password.
            await markReconnectRequired();
            throw new CalendarError('reconnect_required');
        }
        try {
            return await call(credentials);
        } catch (error) {
            if (!(error instanceof CalDavError)) { throw new CalendarError('temporarily_unavailable'); }
            if (error.code === 'unauthorized') {
                // iCloud definitively rejected the stored password. Record it for this generation only.
                await markReconnectRequired();
                throw new CalendarError('reconnect_required');
            }
            throw new CalendarError(error.code === 'temporary' ? 'temporarily_unavailable' : 'upstream_error');
        }
    };
    return {
        list_calendars: async () => {
            const raw = await upstream(credentials => binding.caldav.listCalendars(
                { appleId: credentials.appleId, appPassword: credentials.appPassword },
                { principalUrl: credentials.principalUrl, calendarHomeUrl: credentials.calendarHomeUrl },
            ));
            const parsed = calendarList.safeParse(raw);
            if (!parsed.success) { throw new CalendarError('upstream_error'); }
            return { calendars: parsed.data.slice(0, MAX_CALENDARS), truncated: parsed.data.length > MAX_CALENDARS };
        },
    };
}
