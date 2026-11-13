import { CalDavError, type CalDavBackend } from '../caldav/contracts';
import { UnreadableCredentials, type ConnectionStatus, type UpstreamCredentials } from '../auth/contracts';
import { MAX_CALENDARS, calendarSummarySchema, type ListCalendarsOutput, type ToolErrorCode } from './schemas';
import type { CalDavReadBackend } from '../caldav/read-contracts';
import { createManagedAttachmentFetcher, type ManagedAttachmentFetcher } from '../caldav/attachment-fetch';
import type { FetchLike } from '../caldav/hosts';
import { MANAGED_ATTACHMENT_POLICY, type ManagedAttachmentPolicy } from '../caldav/managed-attachment-policy';
import { getAttachmentDownload } from './attachment-read';
import type { CalDavWriteBackend } from '../caldav/write-contracts';
import { createDownloadBudget, createReadBudget, createWriteBudget, type ReadBudget } from './budget';
import type { DownloadStore } from './downloads';
import type { DownloadArgs, DownloadOutput, GetEventArgs, ListEventsArgs, SearchEventsArgs } from './event-schemas';
import { BudgetError } from './model';
import { getEvent, listEvents, ReadError, searchEvents, type DetailReadResult, type ErrorDetail, type EventsReadResult, type ReadDeps } from './read';
import { createEvent, deleteEvent, updateEvent, WriteError, type WriteDeps, type WriteErrorExtra } from './write';
import type { CreateEventArgs, DeleteEventArgs, DeleteEventResult, UpdateEventArgs, WriteEventResult } from './write-schemas';

/**
 * A fixed, sanitized tool failure. It carries fixed enums and, for write tools, the sanitised upstream summary (whose
 * detail is untrusted text), never raw upstream text.
 */
export class CalendarError extends Error {
    constructor(public readonly code: ToolErrorCode, public readonly detail?: ErrorDetail, public readonly extra: WriteErrorExtra = {}) { super(code); }
}

/** What the write tools need to know about the caller's grant: `calendar:invite` opens the attendee gate. */
export interface WriteGrant { scopes: readonly string[] }

export interface BoundCalendarService {
    list_calendars(input: Record<string, never>): Promise<ListCalendarsOutput>;
    list_events(input: ListEventsArgs): Promise<EventsReadResult>;
    search_events(input: SearchEventsArgs): Promise<EventsReadResult>;
    get_event(input: GetEventArgs): Promise<DetailReadResult>;
    get_event_attachment_download(input: DownloadArgs): Promise<DownloadOutput>;
    create_event(input: CreateEventArgs, grant: WriteGrant): Promise<WriteEventResult>;
    update_event(input: UpdateEventArgs, grant: WriteGrant): Promise<WriteEventResult>;
    delete_event(input: DeleteEventArgs, grant: WriteGrant): Promise<DeleteEventResult>;
}

export interface DownloadBinding {
    /** Returns the staging store, created on first use; undefined when no download bucket is configured. */
    store?: () => DownloadStore | undefined;
    /** Transport for managed attachment GETs. Defaults to the global fetch. */
    fetch?: FetchLike;
    /** Tests only; production always uses the reviewed MANAGED_ATTACHMENT_POLICY. */
    policy?: ManagedAttachmentPolicy;
    now?: () => number;
}

export interface CalendarBinding {
    /** Production has all read and write methods; injected backends without them fail closed for those tools. */
    caldav: Pick<CalDavBackend, 'listCalendars'> & Partial<Omit<CalDavReadBackend, 'listCalendars'>> & Partial<CalDavWriteBackend>;
    /** Server clock in epoch milliseconds for written stamps. Defaults to Date.now. */
    now?: () => number;
    connectionStatus: ConnectionStatus;
    /**
     * Decrypts and re-validates the stored credentials. Called only when a tool needs iCloud and
     * the connection is active; throws UnreadableCredentials for a record that can never be used.
     * The result never leaves this closure.
     */
    credentials: () => UpstreamCredentials;
    /** CAS transition of the observed connection to reconnect_required. */
    markReconnectRequired: () => Promise<boolean>;
    /** Attachment download wiring. Absent means no staging store: inline and managed downloads fail, links still work. */
    downloads?: DownloadBinding;
}

const calendarList = calendarSummarySchema.array();

/** Builds a request-local service whose closures hold the credentials, outside tool arguments, results and authInfo. */
export function bindCalendarService(binding: CalendarBinding): BoundCalendarService {
    const { downloads } = binding;
    const fetchManaged: ManagedAttachmentFetcher = createManagedAttachmentFetcher({
        ...(downloads?.fetch === undefined ? {} : { fetch: downloads.fetch }),
        policy: downloads?.policy ?? MANAGED_ATTACHMENT_POLICY,
    });
    const markReconnectRequired = async () => {
        // The client is told to reconnect even if recording fails, because that is still true.
        try { await binding.markReconnectRequired(); } catch { /* the next call re-detects it */ }
    };
    const upstream = async <T>(call: (credentials: UpstreamCredentials, unauthorized: () => Promise<void>) => Promise<T>, read = false): Promise<T> => {
        let marked = false;
        const unauthorized = async (): Promise<void> => {
            if (marked) { return; }
            marked = true;
            await markReconnectRequired();
        };
        if (binding.connectionStatus !== 'active') { throw new CalendarError('reconnect_required'); }
        let credentials: UpstreamCredentials;
        try { credentials = binding.credentials(); } catch (error) {
            if (!(error instanceof UnreadableCredentials)) { throw new CalendarError('temporarily_unavailable'); }
            // A stored credential that can never be opened needs a new login, like a revoked password.
            await unauthorized();
            throw new CalendarError('reconnect_required');
        }
        try {
            return await call(credentials, unauthorized);
        } catch (error) {
            if (read && error instanceof WriteError) { throw new CalendarError(error.code, undefined, error.extra); }
            if (read && (error instanceof ReadError || error instanceof CalendarError)) { throw new CalendarError(error.code, error.detail); }
            if (read && error instanceof BudgetError) { throw new CalendarError(error.kind === 'deadline' ? 'temporarily_unavailable' : 'result_too_large'); }
            if (!(error instanceof CalDavError)) { throw new CalendarError('temporarily_unavailable'); }
            if (error.code === 'unauthorized') {
                // iCloud definitively rejected the stored password. Record it for this generation only.
                await unauthorized();
                throw new CalendarError('reconnect_required');
            }
            if (read && error.code === 'too_large') { throw new CalendarError('result_too_large'); }
            if (read && error.code === 'not_found') { throw new CalendarError('not_found'); }
            throw new CalendarError(error.code === 'temporary' ? 'temporarily_unavailable' : 'upstream_error');
        }
    };
    const read = <T>(call: (deps: ReadDeps) => Promise<T>, budget: ReadBudget = createReadBudget()): Promise<T> => {
        // The budget starts before credential binding/membership, not anew for each calendar or HTTP send.
        return upstream(async (credentials, onUnauthorized) => {
            const backend = binding.caldav;
            const { queryEvents, multigetEvents } = backend;
            if (queryEvents === undefined || multigetEvents === undefined) { throw new CalendarError('temporarily_unavailable'); }
            return call({
                backend: {
                    listCalendars: backend.listCalendars.bind(backend),
                    queryEvents: queryEvents.bind(backend),
                    multigetEvents: multigetEvents.bind(backend),
                },
                auth: { appleId: credentials.appleId, appPassword: credentials.appPassword },
                discovery: { principalUrl: credentials.principalUrl, calendarHomeUrl: credentials.calendarHomeUrl },
                accountId: credentials.accountId,
                budget,
                onUnauthorized,
            });
        }, true);
    };
    const write = <T>(call: (deps: WriteDeps) => Promise<T>, grant: WriteGrant): Promise<T> => {
        // The 40 s write budget begins here, before credentials and membership.
        const budget = createWriteBudget();
        return upstream(async (credentials, onUnauthorized) => {
            const backend = binding.caldav;
            const { queryEvents, multigetEvents, putEvent, deleteEvent } = backend;
            if (queryEvents === undefined || multigetEvents === undefined || putEvent === undefined || deleteEvent === undefined) { throw new CalendarError('temporarily_unavailable'); }
            return call({
                backend: {
                    listCalendars: backend.listCalendars.bind(backend),
                    queryEvents: queryEvents.bind(backend),
                    multigetEvents: multigetEvents.bind(backend),
                    putEvent: putEvent.bind(backend),
                    deleteEvent: deleteEvent.bind(backend),
                },
                auth: { appleId: credentials.appleId, appPassword: credentials.appPassword },
                discovery: { principalUrl: credentials.principalUrl, calendarHomeUrl: credentials.calendarHomeUrl },
                accountId: credentials.accountId,
                budget,
                onUnauthorized,
                now: binding.now ?? Date.now,
                scopes: [...grant.scopes],
            });
        }, true);
    };
    return {
        create_event: (input, grant) => write(deps => createEvent(deps, input), grant),
        update_event: (input, grant) => write(deps => updateEvent(deps, input), grant),
        delete_event: (input, grant) => write(deps => deleteEvent(deps, input), grant),
        list_events: input => read(deps => listEvents(deps, input)),
        search_events: input => read(deps => searchEvents(deps, input)),
        get_event: input => read(deps => getEvent(deps, input)),
        // The download's 30 s whole-call budget begins here, before credentials and membership.
        get_event_attachment_download: input => read(deps => getAttachmentDownload({
            ...deps,
            store: downloads?.store?.(),
            fetchManaged,
            policy: downloads?.policy ?? MANAGED_ATTACHMENT_POLICY,
            ...(downloads?.now === undefined ? {} : { now: downloads.now }),
        }, input), createDownloadBudget()),
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
