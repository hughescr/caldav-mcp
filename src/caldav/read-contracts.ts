/**
 * Phase 2 read-path backend contracts. Transport-neutral: no service imports, no iCloud specifics. The phase 1
 * CalDavBackend in contracts.ts is unchanged; the iCloud backend returns the intersection of the two interfaces.
 */
import type { CalDavAuth, CalendarSummary, Discovery } from './contracts';

/** Charges bytes against shared capacity before a chunk is accepted. Throws the model BudgetError; never refunds. */
export interface ReadCharge { chargeBytes(bytes: number): void }

export interface DavCallOptions {
    signal?: AbortSignal;
    charge?: ReadCharge;
    /** Milliseconds this logical request, redirects and body included, may take. */
    deadlineMs?: number;
}

export interface CalendarResource {
    /** Canonical resource path. */
    href: string;
    /** Server ETag exactly as returned. */
    etag: string;
    /** XML-decoded calendar-data text (LF line endings). */
    calendarData: string;
}

export type ResourceLookup =
    | { kind: 'found'; resource: CalendarResource }
    | { kind: 'not_found'; href: string };

export interface CalDavReadBackend {
    /** Complete home Depth:1 membership. Called once per tool invocation. */
    listCalendars(auth: CalDavAuth, discovery: Discovery, options?: DavCallOptions): Promise<CalendarSummary[]>;
    /** One expanded calendar-query. Range bounds are basic UTC seconds, e.g. 20260308T103000Z. */
    queryEvents(
        auth: CalDavAuth,
        discovery: Discovery,
        query: { calendarId: string; range: { startUtc: string; endUtc: string } },
        options?: DavCallOptions,
    ): Promise<readonly CalendarResource[]>;
    /** One calendar-multiget of unexpanded originals: at most 50 unique hrefs; phase 2 callers pass one. */
    multigetEvents(
        auth: CalDavAuth,
        discovery: Discovery,
        query: { calendarId: string; hrefs: readonly string[] },
        options?: DavCallOptions,
    ): Promise<readonly ResourceLookup[]>;
}

/** A managed attachment accepted by the reviewed policy module. Provider facts live only in managed-attachment-policy. */
export interface ValidatedManagedDescriptor {
    managedId: string;
    /** Policy-approved initial URL. Never logged. */
    url: string;
    filename: string | null;
    contentType: string | null;
    declaredSize: number | null;
}

export interface AttachmentBody {
    body: ReadableStream<Uint8Array>;
    expectedSize: number;
    /** Releases the source lease. Idempotent. */
    dispose(): void;
}

/** Separate capability, not a required method on every backend or fake. */
export interface ManagedAttachmentBackend {
    openManagedAttachment(
        auth: CalDavAuth,
        discovery: Discovery,
        descriptor: ValidatedManagedDescriptor,
        options: DavCallOptions,
    ): Promise<AttachmentBody>;
}
