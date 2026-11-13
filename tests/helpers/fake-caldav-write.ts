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
 * - RRULE parts are stored in iCloud's own order, values unchanged (measured 2026-11-12: written
 *   FREQ=WEEKLY;INTERVAL=2;COUNT=3, stored FREQ=WEEKLY;COUNT=3;INTERVAL=2; FREQ=WEEKLY;COUNT=3 and FREQ=WEEKLY;UNTIL=...Z
 *   came back unchanged). Modelled: FREQ first, then COUNT before INTERVAL (measured). GUESS: every other part follows them
 *   in its written order.
 * - `rewrite` (switchable): replaces the local digits of DTSTART/DTEND with one TZID, standing in for the measured
 *   Australia/Lord_Howe rewrite (Run 7: write-iana-zones, stored 20261215T233000). The real rule is unknown.
 * - Faults (`failNextWrite`, `failNextRead`, `failNextQuery`) inject the adversarial cases: a lost answer after applying, a
 *   5xx with or without applying, a weak or missing ETag header, a refusal with a body, a redirect, a 401, a failing read.
 *
 * Expanded REPORT (`queryEvents`), as measured (probe Run 7 P3B-1..6, P3C-1..4, P3D-1..3; Runs 2-5):
 * - Every resource with an instance in the window is returned with the stored ETag; calendar-data has no VERSION, PRODID or
 *   VTIMEZONE (measured) and LF line endings; RRULE, EXDATE and EXRULE are gone from the instances, and the master's RDATE
 *   lines stay on every instance (measured 2026-11, read-only). Each RDATE value of a UTC or TZID master is one more
 *   instance; a floating value is read as UTC (measured), a UTC or TZID value as its instant (GUESS).
 * - An unmoved instance's DTSTART/DTEND keep the master's form (TZID local digits, UTC, DATE, floating) and its
 *   RECURRENCE-ID is the UTC form: the true instant for UTC and TZID series, the date at T000000Z for DATE series, the
 *   wall digits with Z for floating series (measured).
 * - An instance with a stored override carries that override's lines verbatim, its RECURRENCE-ID in the STORED form (TZID
 *   local text, VALUE=DATE, floating, or UTC; measured outcome (a), P3B-2 and P3B-6) and `X-RECURRENCE-EXCEPTION` (measured
 *   name; the value `TRUE` is a GUESS). It is returned only when the window overlaps both its slot and its own time (Run 5).
 * - An override whose RECURRENCE-ID matches no instance (beyond UNTIL, or off every slot) is hidden (P3C-4).
 * - A window that holds only EXDATE-excluded slots of a series (no remaining instance) still returns the resource: the
 *   stored master's lines alone, VALARM included, in a VCALENDAR with no properties and no VTIMEZONE (measured 2026-11-13,
 *   read-only: 1022 bytes for a 3722-byte stored series). A window before the series or between instances returns nothing.
 * - In a TZID series a local time in a repeated hour resolves to the SECOND instant and one in a skipped hour to the
 *   earlier offset (01:30 EST for 02:30 on 2027-03-14); an expanded DTEND is the first resolution plus the master's
 *   duration (measured tuples, P3B-4: 01:30/01:30/06:30Z and 01:30/03:30/06:30Z). Overrides and EXDATEs match a slot by
 *   instant under the same rule. Zone rules come from the runtime's Temporal (the fake only; the server never does this).
 * - Only FREQ=DAILY and FREQ=WEEKLY with INTERVAL, COUNT and UNTIL are modelled (BYDAY only when it names DTSTART's own
 *   weekday); anything else throws, so a test cannot silently rely on an unmodelled rule. GUESS: VALARMs are kept in
 *   instances; time-range overlap is half-open, a zero-length instance matches when its start is in the window.
 * - `expansionHook` lets a test replace the expanded text of one resource (an injection, labelled where used).
 */
export type WriteFault =
    /** This write is answered normally (a placeholder, so a later fault hits the second write of a split). */
    | { kind: 'none' }
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
    hrefs?: readonly string[];
    range?: { startUtc: string; endUtc: string };
    precondition?: string;
    body?: string;
    deadlineMs?: number | undefined;
}

// ---- Expansion model (see the header; test-only zone rules through the runtime's Temporal) ----

interface TemporalZoned { epochNanoseconds: bigint; toPlainDateTime(): { toString(): string } }
interface TemporalPlain { toZonedDateTime(zone: string, options?: { disambiguation: 'earlier' | 'later' }): TemporalZoned; add(duration: { days?: number }): TemporalPlain; toString(): string }
interface TemporalApi {
    PlainDateTime: { from(text: string): TemporalPlain };
    Instant: { fromEpochNanoseconds(ns: bigint): { toZonedDateTimeISO(zone: string): TemporalZoned } };
}
const temporal = (): TemporalApi => {
    const api = (globalThis as unknown as { Temporal?: TemporalApi }).Temporal;
    if (api === undefined) { throw new Error('the fake expansion needs Temporal'); }
    return api;
};

type FakeTime = { kind: 'utc' | 'floating' | 'date'; digits: string } | { kind: 'zoned'; digits: string; tzid: string };

const extended = (digits: string): string => `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(9, 11)}:${digits.slice(11, 13)}:${digits.slice(13, 15)}`;
const basicOf = (text: string): string => text.replaceAll(/[-:]/gu, '').slice(0, 15);
const civilMs = (digits: string): number => (digits.length === 8
    ? Date.UTC(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)) - 1, Number(digits.slice(6, 8)))
    : Date.UTC(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)) - 1, Number(digits.slice(6, 8)), Number(digits.slice(9, 11)), Number(digits.slice(11, 13)), Number(digits.slice(13, 15))));
const utcDigits = (ms: number): string => new Date(ms).toISOString().replaceAll(/[-:]/gu, '').replace(/\.\d{3}/u, '');
const dateDigits = (ms: number): string => utcDigits(ms).slice(0, 8);

function fakeTime(line: string): FakeTime {
    const value = valueOf(line).split(',')[0] ?? '';
    const tzid = tzidOf(line);
    if (/;VALUE=DATE(?=[;:])/iu.test(line) || /^\d{8}$/u.test(value)) { return { kind: 'date', digits: value }; }
    if (value.endsWith('Z')) { return { kind: 'utc', digits: value.slice(0, -1) }; }
    return tzid === null ? { kind: 'floating', digits: value } : { kind: 'zoned', digits: value, tzid };
}

/** iCloud's resolution of a zoned local time (measured): repeated hour → the second instant, skipped hour → the earlier offset. */
function zonedInstant(digits: string, tzid: string): { chosen: number; first: number } {
    const plain = temporal().PlainDateTime.from(extended(digits));
    const earlier = plain.toZonedDateTime(tzid, { disambiguation: 'earlier' });
    const later = plain.toZonedDateTime(tzid, { disambiguation: 'later' });
    const overlap = earlier.toPlainDateTime().toString() === later.toPlainDateTime().toString() && earlier.epochNanoseconds !== later.epochNanoseconds;
    const toMs = (zoned: TemporalZoned): number => Number(zoned.epochNanoseconds / 1_000_000n);
    return { chosen: toMs(overlap ? later : earlier), first: toMs(earlier) };
}
const wallOf = (ms: number, tzid: string): string => basicOf(temporal().Instant.fromEpochNanoseconds(BigInt(ms) * 1_000_000n).toZonedDateTimeISO(tzid).toPlainDateTime().toString());

/** The instant (ms) a value denotes: UTC as is, zoned by the rule above, DATE and floating on the civil axis. */
function instantOf(time: FakeTime): number {
    return time.kind === 'zoned' ? zonedInstant(time.digits, time.tzid).chosen : civilMs(time.digits);
}

interface Block {
    /** Every line between BEGIN:VEVENT and END:VEVENT, nested components included. */
    lines: string[];
    direct: string[];
    /** Lines of the nested components, BEGIN to END. */
    nested: string[];
}

/** Top-level VEVENT blocks with their direct lines and their nested components' lines. */
function eventBlocks(lines: readonly string[]): Block[] {
    const blocks: Block[] = [];
    let depth = 0;
    let current: Block | null = null;
    for (const line of lines) {
        const name = nameOf(line);
        if (name === 'BEGIN') {
            depth++;
            if (depth === 2 && valueOf(line).toUpperCase() === 'VEVENT') { current = { lines: [], direct: [], nested: [] }; continue; }
            if (current !== null) { current.lines.push(line); current.nested.push(line); }
            continue;
        }
        if (name === 'END') {
            if (depth === 2 && current !== null && valueOf(line).toUpperCase() === 'VEVENT') { blocks.push(current); current = null; depth--; continue; }
            if (current !== null) { current.lines.push(line); current.nested.push(line); }
            depth--;
            continue;
        }
        if (current === null) { continue; }
        current.lines.push(line);
        if (depth === 2) { current.direct.push(line); } else { current.nested.push(line); }
    }
    return blocks;
}

const RULE_LINES: ReadonlySet<string> = new Set(['RRULE', 'RDATE', 'EXDATE', 'EXRULE']);
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

interface Window { start: number; end: number }
const overlaps = (window: Window, start: number, end: number): boolean => (end > start ? start < window.end && end > window.start : start >= window.start && start < window.end);

/** One expanded resource text (LF, no VTIMEZONE, no VERSION/PRODID), or null when nothing is in the window. */
function expandResource(text: string, window: Window): string | null {
    const blocks = eventBlocks(unfold(text));
    const master = blocks.find(block => !block.direct.some(line => nameOf(line) === 'RECURRENCE-ID'));
    const overrides = blocks.filter(block => block !== master);
    const out: string[][] = [];
    const firstOf = (block: Block, name: string): string | undefined => block.direct.find(line => nameOf(line) === name);
    const span = (block: Block): { start: number; end: number } => {
        const start = fakeTime(firstOf(block, 'DTSTART') ?? '');
        const endLine = firstOf(block, 'DTEND');
        const startMs = instantOf(start);
        if (endLine === undefined) { return { start: startMs, end: start.kind === 'date' ? startMs + 86_400_000 : startMs }; }
        return { start: startMs, end: instantOf(fakeTime(endLine)) };
    };
    const rule = master === undefined ? undefined : firstOf(master, 'RRULE');
    if (master !== undefined && rule === undefined) {
        const own = span(master);
        return overlaps(window, own.start, own.end) ? `BEGIN:VCALENDAR\n${['BEGIN:VEVENT', ...master.lines, 'END:VEVENT'].join('\n')}\nEND:VCALENDAR\n` : null;
    }
    if (master === undefined || rule === undefined) {
        for (const block of overrides) {
            const own = span(block);
            if (overlaps(window, own.start, own.end)) { out.push(['BEGIN:VEVENT', ...block.lines, 'END:VEVENT']); }
        }
        return out.length === 0 ? null : `BEGIN:VCALENDAR\n${out.flat().join('\n')}\nEND:VCALENDAR\n`;
    }
    const parts = new Map(valueOf(rule).split(';').map(part => part.split('=') as [string, string]));
    const freq = parts.get('FREQ');
    const interval = Number(parts.get('INTERVAL') ?? '1');
    const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;
    const until = parts.get('UNTIL') ?? null;
    const start = fakeTime(firstOf(master, 'DTSTART') ?? '');
    const startDay = WEEKDAYS[new Date(civilMs(start.digits.slice(0, 8))).getUTCDay()];
    for (const key of parts.keys()) {
        if (!['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'].includes(key)) { throw new Error(`fake expansion: unmodelled RRULE part ${key}`); }
    }
    if ((freq !== 'DAILY' && freq !== 'WEEKLY') || (parts.has('BYDAY') && parts.get('BYDAY') !== startDay)) { throw new Error('fake expansion: unmodelled RRULE'); }
    const stepDays = interval * (freq === 'WEEKLY' ? 7 : 1);
    const endLine = firstOf(master, 'DTEND');
    const masterSpan = span(master);
    const durationMs = endLine === undefined ? (start.kind === 'date' ? 86_400_000 : 0) : (start.kind === 'zoned' ? masterSpan.end - zonedInstant(start.digits, start.tzid).first : masterSpan.end - masterSpan.start);
    const untilMs = until === null ? null : until.endsWith('Z') ? civilMs(until.slice(0, -1)) : civilMs(until);
    const exdates = master.direct.filter(line => nameOf(line) === 'EXDATE').flatMap(line => valueOf(line).split(',').map(value => instantOf(fakeTime(`${line.slice(0, line.length - valueOf(line).length)}${value}`))));
    const overrideAt = new Map<number, Block>();
    for (const block of overrides) { overrideAt.set(instantOf(fakeTime(firstOf(block, 'RECURRENCE-ID') ?? '')), block); }
    // The master's RDATE lines stay on every instance (measured 2026-11, read-only); the other rule lines do not.
    const kept = master.direct.filter(line => (nameOf(line) === 'RDATE' || !RULE_LINES.has(nameOf(line))) && nameOf(line) !== 'DTSTART' && nameOf(line) !== 'DTEND' && nameOf(line) !== 'DURATION');
    interface Slot { digits: string; ms: number; firstMs: number }
    const slots: Slot[] = [];
    for (let k = 0; k < 20_000; k++) {
        if (count !== null && k >= count) { break; }
        // The k-th slot on the wall clock of the master's form.
        const slotDigits = start.kind === 'date' ? dateDigits(civilMs(start.digits) + k * stepDays * 86_400_000)
            : start.kind === 'zoned' ? basicOf(temporal().PlainDateTime.from(extended(start.digits)).add({ days: k * stepDays }).toString())
            : utcDigits(civilMs(start.digits) + k * stepDays * 86_400_000).slice(0, 15);
        const slot: FakeTime = start.kind === 'zoned' ? { kind: 'zoned', digits: slotDigits, tzid: start.tzid } : { kind: start.kind, digits: slotDigits };
        const slotMs = instantOf(slot);
        if (untilMs !== null && slotMs > untilMs) { break; }
        if (slotMs > window.end + 40 * 86_400_000) { break; }
        slots.push({ digits: slotDigits, ms: slotMs, firstMs: slot.kind === 'zoned' ? zonedInstant(slot.digits, slot.tzid).first : slotMs });
    }
    // RDATE instances (measured for a TZID master): a floating value is read as UTC. GUESS: a UTC value as is, a TZID value
    // in its zone. Other master or value forms are not modelled.
    for (const line of master.direct.filter(item => nameOf(item) === 'RDATE')) {
        if (start.kind !== 'zoned' && start.kind !== 'utc') { throw new Error('fake expansion: RDATE is modelled only for UTC and TZID masters'); }
        for (const value of valueOf(line).split(',')) {
            const time = fakeTime(`${line.slice(0, line.length - valueOf(line).length)}${value}`);
            if (time.kind === 'date') { throw new Error('fake expansion: unmodelled RDATE form'); }
            const ms = time.kind === 'floating' ? civilMs(time.digits) : instantOf(time);
            if (!slots.some(slot => slot.ms === ms)) { slots.push({ digits: utcDigits(ms).slice(0, 15), ms, firstMs: ms }); }
        }
    }
    slots.sort((a, b) => a.ms - b.ms);
    let excludedInWindow = false;
    for (const { digits: slotDigits, ms: slotMs, firstMs } of slots) {
        const slotEnd = firstMs + durationMs;
        if (exdates.includes(slotMs)) {
            if (overlaps(window, slotMs, slotEnd)) { excludedInWindow = true; }
            continue;
        }
        const override = overrideAt.get(slotMs);
        if (override !== undefined) {
            const own = span(override);
            if (overlaps(window, slotMs, slotEnd) && overlaps(window, own.start, own.end)) {
                out.push(['BEGIN:VEVENT', ...override.lines, 'X-RECURRENCE-EXCEPTION:TRUE', 'END:VEVENT']);
            }
            continue;
        }
        if (!overlaps(window, slotMs, slotEnd)) { continue; }
        const render = (name: 'DTSTART' | 'DTEND', ms: number): string => {
            switch (start.kind) {
                case 'utc': return `${name}:${utcDigits(ms)}`;
                case 'floating': return `${name}:${utcDigits(ms).slice(0, 15)}`;
                case 'date': return `${name};VALUE=DATE:${dateDigits(ms)}`;
                case 'zoned': return `${name};TZID=${start.tzid}:${wallOf(ms, start.tzid)}`;
            }
        };
        const rid = start.kind === 'date' ? `RECURRENCE-ID:${slotDigits}T000000Z` : start.kind === 'floating' ? `RECURRENCE-ID:${slotDigits}Z` : `RECURRENCE-ID:${utcDigits(slotMs)}`;
        out.push(['BEGIN:VEVENT', ...kept, render('DTSTART', slotMs), render('DTEND', slotEnd), rid, ...master.nested, 'END:VEVENT']);
    }
    // A window whose only slots are EXDATE-excluded still returns the resource, as the stored master alone in a VCALENDAR
    // with no properties and no VTIMEZONE (measured 2026-11-13, read-only). GUESS: the same when a hidden override shares
    // the window with an excluded slot.
    if (out.length === 0 && excludedInWindow) { return `BEGIN:VCALENDAR\n${['BEGIN:VEVENT', ...master.lines, 'END:VEVENT'].join('\n')}\nEND:VCALENDAR\n`; }
    return out.length === 0 ? null : `BEGIN:VCALENDAR\n${out.flat().join('\n')}\nEND:VCALENDAR\n`;
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

/** iCloud's order of RRULE parts (see the header): FREQ, COUNT, INTERVAL measured; the rest in written order is a GUESS. */
const RULE_PART_RANK = ['FREQ', 'COUNT', 'INTERVAL'];
function icloudRuleOrder(line: string): string {
    const value = valueOf(line);
    const rank = (part: string): number => {
        const found = RULE_PART_RANK.indexOf((part.split('=')[0] ?? '').toUpperCase());
        return found === -1 ? RULE_PART_RANK.length : found;
    };
    // Array sort is stable, so parts of equal rank keep their written order.
    const parts = value.split(';').sort((a, b) => rank(a) - rank(b));
    return `${line.slice(0, line.length - value.length)}${parts.join(';')}`;
}

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
    private readonly queryFaults: (Error | ((fake: FakeICloud) => void) | undefined)[] = [];
    private counter = 0;
    /** Replaces one resource's expanded text (an injection; tests label what it stands for). */
    expansionHook: ((href: string, expanded: string) => string) | null = null;
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
    /**
     * The next expanded REPORTs: an Error fails the request; a function runs after the REPORT was answered (a change by
     * another client between the expansion and the next request); undefined answers normally.
     */
    failNextQuery(...faults: (Error | ((fake: FakeICloud) => void) | undefined)[]): this {
        this.queryFaults.push(...faults);
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

    /**
     * The text as iCloud keeps it: VTIMEZONEs regenerated for the TZIDs used, RRULE parts in iCloud's order, the rewrite
     * applied, re-folded at 91 octets, CRLF.
     */
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
            kept.push(name === 'RRULE' ? icloudRuleOrder(line) : line);
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
    async queryEvents(_auth: CalDavAuth, _discovery: Discovery, query: { calendarId: string; range: { startUtc: string; endUtc: string } }, _options?: DavCallOptions): Promise<readonly CalendarResource[]> {
        this.calls.push({ method: 'queryEvents', calendarId: query.calendarId, range: { ...query.range } });
        const fault = this.queryFaults.shift();
        if (fault instanceof Error) { throw fault; }
        const window = { start: civilMs(query.range.startUtc.slice(0, -1)), end: civilMs(query.range.endUtc.slice(0, -1)) };
        const resources: CalendarResource[] = [];
        for (const [href, stored] of this.collection(query.calendarId)) {
            const expanded = expandResource(stored.text, window);
            const text = this.expansionHook === null || expanded === null ? expanded : this.expansionHook(href, expanded);
            if (text !== null) { resources.push({ href, etag: stored.etag, calendarData: text }); }
        }
        // A change between this REPORT and the next request (the race the write path must catch).
        fault?.(this);
        return resources;
    }
    async multigetEvents(_auth: CalDavAuth, _discovery: Discovery, query: { calendarId: string; hrefs: readonly string[] }, _options?: DavCallOptions): Promise<readonly ResourceLookup[]> {
        this.calls.push({ method: 'multigetEvents', calendarId: query.calendarId, ...(query.hrefs[0] === undefined ? {} : { href: query.hrefs[0] }), hrefs: [...query.hrefs] });
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
