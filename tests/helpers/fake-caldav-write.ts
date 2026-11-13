import { CalDavError, type CalDavAuth, type CalendarSummary, type Discovery } from '../../src/caldav/contracts';
import type { CalDavReadBackend, CalendarResource, DavCallOptions, ResourceLookup } from '../../src/caldav/read-contracts';
import { strongEtag, type CalDavWriteBackend, type DeleteEventRequest, type PutEventRequest, type UpstreamDetail, type WriteCallOptions, type WriteResponse } from '../../src/caldav/write-contracts';
import { FAKE_DISCOVERY } from './fake-caldav';

/**
 * A stateful in-memory iCloud for the write path, at the backend-contract level (the HTTP layer is tested on its own in
 * tests/caldav-write.test.ts). Behaviour and its evidence (probe-evidence.md); anything not measured is marked GUESS:
 *
 * - ETags are strong, quoted, 10 characters, and change on every accepted write; the ETag header of a write equals the
 *   stored ETag (Run 7: etagHeaderMatchesPropfind, etagHeaderEqualsStored).
 * - `If-None-Match: *` on an existing href answers 412; so does a UID already used by another resource of the account, in
 *   the same or another calendar, with an empty body (Run 7: write-create-if-none-match, write-duplicate-uid).
 * - `If-Match` with the exact ETag: 204; stale: 412 for PUT and DELETE, nothing changed (Run 7: write-if-match-*).
 *   GUESS: PUT with `If-Match` on a missing href answers 412 (RFC 7232; not measured).
 * - DELETE of a missing href answers 404, also with `If-Match` (Run 7: write-delete-semantics).
 * - A VEVENT with DTSTART and neither DTEND nor DURATION: 404 (earlier runs). An end before the start in the same form
 *   (both UTC, or the same TZID): 403 with an empty body (Run 7: write-end-order). GUESS: cross-zone order is not
 *   modelled (it would need zone math; iCloud answered 403 for one measured cross-zone case).
 * - Every refusal has an empty body (Run 7: write-error-bodies: 11 refusals, content type none).
 * - VTIMEZONEs are regenerated for the TZIDs the VEVENTs use: iCloud adds one for a TZID sent without it, and after a zone
 *   change keeps only the new zone's (Run 7: write-unknown-zone, write-iana-zones, write-zone-change). `Mars/Olympus` gets
 *   none (measured). GUESS: every other name in `unknownZones` gets none, every name outside it gets one; the VTIMEZONE
 *   body here is synthetic.
 * - Stored lines are re-folded at up to 91 octets, never inside a UTF-8 sequence, with CRLF (Run 7: write-text-roundtrip);
 *   a multiget returns LF line endings (REPORT calendar-data differs from GET only in line endings, earlier runs).
 * - `rewrite` (switchable): replaces the local digits of DTSTART/DTEND with one TZID, standing in for the measured
 *   Australia/Lord_Howe rewrite (Run 7: write-iana-zones, stored 20261215T233000). The real rule is unknown.
 * - Faults (`failNextWrite`, `failNextRead`) inject the adversarial cases: a lost answer after applying, a 5xx with or
 *   without applying, a weak or missing ETag header, a refusal with a body, a redirect, a 401, a failing read.
 */
export type WriteFault =
    | { kind: 'unauthorized' }
    | { kind: 'redirect'; status: number }
    /** Answer `status` (with `upstream`), after applying the write normally when `apply` is true. */
    | { kind: 'status'; status: number; apply: boolean; upstream?: Partial<UpstreamDetail> }
    /** The request was sent; no answer arrives. `apply` decides whether iCloud saved it anyway. */
    | { kind: 'uncertain'; apply: boolean }
    /** Apply normally but answer with this ETag header (a weak one, or none). */
    | { kind: 'etag_header'; etag: string | null }
    /** Before the write is processed, something else changes the store (a concurrent edit or delete). */
    | { kind: 'concurrent'; change: (fake: FakeICloud) => void };

export interface FakeWriteCall {
    method: 'putEvent' | 'deleteEvent' | 'multigetEvents' | 'listCalendars' | 'queryEvents';
    calendarId?: string;
    href?: string;
    precondition?: string;
    body?: string;
    deadlineMs?: number | undefined;
}

interface Stored { etag: string; text: string }

const VTIMEZONE_STUB = (tzid: string): string[] => [
    'BEGIN:VTIMEZONE', `TZID:${tzid}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0000', 'END:STANDARD', 'END:VTIMEZONE',
];

function unfold(text: string): string[] {
    const physical = text.split(/\r?\n/u);
    if (physical.at(-1) === '') { physical.pop(); }
    const logical: string[] = [];
    for (const line of physical) {
        if ((line.startsWith(' ') || line.startsWith('\t')) && logical.length > 0) { logical[logical.length - 1] += line.slice(1); } else { logical.push(line); }
    }
    return logical;
}

/** iCloud-style folding: at most 91 octets per physical line, never inside a UTF-8 sequence. */
function fold91(line: string): string[] {
    const out: string[] = [];
    let current = '';
    let used = 0;
    for (const character of line) {
        const size = Buffer.byteLength(character, 'utf8');
        if (used + size > 91) {
            out.push(current);
            current = ' ';
            used = 1;
        }
        current += character;
        used += size;
    }
    out.push(current);
    return out;
}

const nameOf = (line: string): string => line.slice(0, Math.max(0, line.search(/[;:]/u))).toUpperCase();
const valueOf = (line: string): string => {
    // The value starts after the first colon that is not inside a quoted parameter value.
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
        if (line[index] === '"') { quoted = !quoted; }
        if (line[index] === ':' && !quoted) { return line.slice(index + 1); }
    }
    return '';
};
const tzidOf = (line: string): string | null => {
    const match = /;TZID=("[^"]*"|[^;:]*)/iu.exec(line);
    if (match === null) { return null; }
    const raw = match[1] ?? '';
    return raw.startsWith('"') ? raw.slice(1, -1) : raw;
};

interface Vevent { lines: string[] }

function vevents(lines: readonly string[]): Vevent[] {
    const events: Vevent[] = [];
    let depth = 0;
    let current: string[] | null = null;
    for (const line of lines) {
        const name = nameOf(line);
        if (name === 'BEGIN') {
            depth++;
            if (depth === 2 && valueOf(line).toUpperCase() === 'VEVENT') { current = []; }
            continue;
        }
        if (name === 'END') {
            if (depth === 2 && current !== null && valueOf(line).toUpperCase() === 'VEVENT') { events.push({ lines: current }); current = null; }
            depth--;
            continue;
        }
        if (depth === 2 && current !== null) { current.push(line); }
    }
    return events;
}

export class FakeICloud implements CalDavReadBackend, CalDavWriteBackend {
    readonly calls: FakeWriteCall[] = [];
    readonly calendars: CalendarSummary[];
    private readonly store = new Map<string, Map<string, Stored>>();
    private readonly writeFaults: WriteFault[] = [];
    private readonly readFaults: (Error | 'absent')[] = [];
    private counter = 0;
    /** Zone names iCloud stores without adding a VTIMEZONE (measured: Mars/Olympus). */
    unknownZones: Set<string> = new Set(['Mars/Olympus']);
    /** Switchable stand-in for the measured Lord_Howe rewrite: local digits of DTSTART/DTEND in `tzid` become `to(local)`. */
    rewrite: { tzid: string; to: (local: string) => string } | null = null;

    constructor(calendarIds: readonly string[] = ['/10000000001/calendars/work/']) {
        this.calendars = calendarIds.map(id => ({ id, displayName: `Calendar ${id.split('/').at(-2) ?? ''}`, components: ['VEVENT'], color: null }));
        for (const id of calendarIds) { this.store.set(id, new Map()); }
    }

    // ---- Test controls ----

    failNextWrite(...faults: WriteFault[]): this {
        this.writeFaults.push(...faults);
        return this;
    }
    /** The next multigets fail with these errors, or report the href absent. */
    failNextRead(...faults: (Error | 'absent')[]): this {
        this.readFaults.push(...faults);
        return this;
    }
    /** Stores text exactly as given (as if another client wrote it), with a new ETag. */
    seed(calendarId: string, href: string, text: string): string {
        const etag = this.nextEtag();
        this.collection(calendarId).set(href, { etag, text });
        return etag;
    }
    /** Another client's edit: the text is replaced and the ETag changes. */
    externalEdit(calendarId: string, href: string, change: (text: string) => string): string {
        const stored = this.get(calendarId, href);
        if (stored === undefined) { throw new Error('no such resource'); }
        return this.seed(calendarId, href, change(stored.text));
    }
    externalDelete(calendarId: string, href: string): void {
        this.collection(calendarId).delete(href);
    }
    get(calendarId: string, href: string): Stored | undefined {
        return this.store.get(calendarId)?.get(href);
    }
    hrefs(calendarId: string): string[] {
        return [...this.collection(calendarId).keys()].sort();
    }
    count(method?: FakeWriteCall['method']): number {
        return method === undefined ? this.calls.length : this.calls.filter(call => call.method === method).length;
    }

    private collection(calendarId: string): Map<string, Stored> {
        const found = this.store.get(calendarId);
        if (found === undefined) { throw new Error(`unknown calendar ${calendarId}`); }
        return found;
    }
    private nextEtag(): string {
        this.counter++;
        return `"e${this.counter.toString(36).padStart(7, '0')}"`;
    }

    // ---- Measured semantics ----

    private uidOf(text: string): string | null {
        const line = unfold(text).find(item => nameOf(item) === 'UID');
        return line === undefined ? null : valueOf(line);
    }

    /** What iCloud refuses before storing, or null. */
    private validate(text: string): number | null {
        for (const event of vevents(unfold(text))) {
            const start = event.lines.find(line => nameOf(line) === 'DTSTART');
            const end = event.lines.find(line => nameOf(line) === 'DTEND');
            const duration = event.lines.some(line => nameOf(line) === 'DURATION');
            if (start !== undefined && end === undefined && !duration) { return 404; }
            if (start !== undefined && end !== undefined) {
                const a = valueOf(start);
                const b = valueOf(end);
                const sameForm = (a.endsWith('Z') && b.endsWith('Z')) || (tzidOf(start) !== null && tzidOf(start) === tzidOf(end)) || (a.length === 8 && b.length === 8);
                if (sameForm && b < a) { return 403; }
            }
        }
        return null;
    }

    /** The text as iCloud keeps it: VTIMEZONEs regenerated for the TZIDs used, the rewrite applied, re-folded at 91 octets, CRLF. */
    private stored(text: string): string {
        const lines = unfold(text);
        const kept: string[] = [];
        let skipping = 0;
        for (const line of lines) {
            const name = nameOf(line);
            if (name === 'BEGIN' && valueOf(line).toUpperCase() === 'VTIMEZONE') { skipping++; continue; }
            if (skipping > 0) {
                if (name === 'BEGIN') { skipping++; }
                if (name === 'END') { skipping--; }
                continue;
            }
            const rewrite = this.rewrite;
            if (rewrite !== null && (name === 'DTSTART' || name === 'DTEND') && tzidOf(line) === rewrite.tzid) {
                const value = valueOf(line);
                kept.push(`${line.slice(0, line.length - value.length)}${rewrite.to(value)}`);
                continue;
            }
            kept.push(line);
        }
        const zones = new Set<string>();
        for (const event of vevents(kept)) {
            for (const line of event.lines) {
                const tzid = ['DTSTART', 'DTEND', 'RECURRENCE-ID', 'EXDATE'].includes(nameOf(line)) ? tzidOf(line) : null;
                if (tzid !== null && !this.unknownZones.has(tzid)) { zones.add(tzid); }
            }
        }
        const firstComponent = kept.findIndex((line, index) => index > 0 && nameOf(line) === 'BEGIN');
        const at = firstComponent === -1 ? kept.length - 1 : firstComponent;
        const withZones = [...kept.slice(0, at), ...[...zones].flatMap(VTIMEZONE_STUB), ...kept.slice(at)];
        return `${withZones.flatMap(fold91).join('\r\n')}\r\n`;
    }

    private apply(calendarId: string, href: string, text: string): string {
        const etag = this.nextEtag();
        this.collection(calendarId).set(href, { etag, text: this.stored(text) });
        return etag;
    }

    private uidInUse(uid: string, except: { calendarId: string; href: string } | null): boolean {
        for (const [calendarId, resources] of this.store) {
            for (const [href, stored] of resources) {
                if (except !== null && except.calendarId === calendarId && except.href === href) { continue; }
                if (this.uidOf(stored.text) === uid) { return true; }
            }
        }
        return false;
    }

    private answer(status: number, etag: string | null, upstream: Partial<UpstreamDetail> = {}): WriteResponse {
        // As the transport does: only a strong ETag header survives (a weak one becomes null).
        return { kind: 'status', status, etag: strongEtag(etag), upstream: { status, content_type: 'none', preconditions: [], detail: null, ...upstream } };
    }

    // ---- CalDavReadBackend ----

    async listCalendars(_auth: CalDavAuth, _discovery: Discovery, _options?: DavCallOptions): Promise<CalendarSummary[]> {
        this.calls.push({ method: 'listCalendars' });
        return structuredClone(this.calendars);
    }
    async queryEvents(_auth: CalDavAuth, _discovery: Discovery, query: { calendarId: string }): Promise<readonly CalendarResource[]> {
        this.calls.push({ method: 'queryEvents', calendarId: query.calendarId });
        return [];
    }
    async multigetEvents(_auth: CalDavAuth, _discovery: Discovery, query: { calendarId: string; hrefs: readonly string[] }, _options?: DavCallOptions): Promise<readonly ResourceLookup[]> {
        this.calls.push({ method: 'multigetEvents', calendarId: query.calendarId, ...(query.hrefs[0] === undefined ? {} : { href: query.hrefs[0] }) });
        const fault = this.readFaults.shift();
        if (fault instanceof Error) { throw fault; }
        return query.hrefs.map((href): ResourceLookup => {
            const stored = fault === 'absent' ? undefined : this.store.get(query.calendarId)?.get(href);
            return stored === undefined ? { kind: 'not_found', href } : { kind: 'found', resource: { href, etag: stored.etag, calendarData: stored.text.replaceAll('\r\n', '\n') } };
        });
    }

    // ---- CalDavWriteBackend ----

    async putEvent(_auth: CalDavAuth, _discovery: Discovery, request: PutEventRequest, options?: WriteCallOptions): Promise<WriteResponse> {
        const { calendarId, href, body, precondition } = request;
        this.calls.push({ method: 'putEvent', calendarId, href, body, precondition: precondition.kind === 'create' ? 'If-None-Match: *' : `If-Match: ${precondition.etag}`, deadlineMs: options?.deadlineMs });
        const fault = this.writeFaults.shift();
        if (fault?.kind === 'unauthorized') { throw new CalDavError('unauthorized'); }
        if (fault?.kind === 'redirect') { return { kind: 'redirected', status: fault.status }; }
        if (fault?.kind === 'concurrent') { fault.change(this); }
        if ((fault?.kind === 'status' || fault?.kind === 'uncertain') && !fault.apply) {
            return fault.kind === 'uncertain' ? { kind: 'uncertain' } : this.answer(fault.status, null, fault.upstream);
        }
        const existing = this.store.get(calendarId)?.get(href);
        if (precondition.kind === 'create') {
            const uid = this.uidOf(body);
            if (existing !== undefined || (uid !== null && this.uidInUse(uid, null))) { return this.answer(412, null); }
        } else if (existing === undefined || existing.etag !== precondition.etag) {
            return this.answer(412, null);
        }
        const refused = this.validate(body);
        if (refused !== null) { return this.answer(refused, null); }
        const etag = this.apply(calendarId, href, body);
        if (fault?.kind === 'uncertain') { return { kind: 'uncertain' }; }
        if (fault?.kind === 'status') { return this.answer(fault.status, null, fault.upstream); }
        if (fault?.kind === 'etag_header') { return this.answer(precondition.kind === 'create' ? 201 : 204, fault.etag); }
        return this.answer(precondition.kind === 'create' ? 201 : 204, etag);
    }

    async deleteEvent(_auth: CalDavAuth, _discovery: Discovery, request: DeleteEventRequest, options?: WriteCallOptions): Promise<WriteResponse> {
        const { calendarId, href, etag } = request;
        this.calls.push({ method: 'deleteEvent', calendarId, href, precondition: `If-Match: ${etag}`, deadlineMs: options?.deadlineMs });
        const fault = this.writeFaults.shift();
        if (fault?.kind === 'unauthorized') { throw new CalDavError('unauthorized'); }
        if (fault?.kind === 'redirect') { return { kind: 'redirected', status: fault.status }; }
        if (fault?.kind === 'concurrent') { fault.change(this); }
        if ((fault?.kind === 'status' || fault?.kind === 'uncertain') && !fault.apply) {
            return fault.kind === 'uncertain' ? { kind: 'uncertain' } : this.answer(fault.status, null, fault.upstream);
        }
        const existing = this.store.get(calendarId)?.get(href);
        if (existing === undefined) { return this.answer(404, null); }
        if (existing.etag !== etag) { return this.answer(412, null); }
        this.collection(calendarId).delete(href);
        if (fault?.kind === 'uncertain') { return { kind: 'uncertain' }; }
        if (fault?.kind === 'status') { return this.answer(fault.status, null, fault.upstream); }
        return this.answer(204, null);
    }
}

export { FAKE_DISCOVERY };
