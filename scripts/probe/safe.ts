/**
 * Everything that may appear in the probe report passes through this module.
 *
 * First layer: evidence strings are branded `Safe`: they can only be produced by the
 * functions here, which reduce server data to names, shapes and placeholders. Summaries are
 * `Prose`, built only with the `prose` template tag: the sentence is fixed text written in
 * this code base, and its only variable parts are numbers, nested `Prose` and `Safe` values.
 *
 * Second layer (`Taint` + `renderProse` / `scrubValue`), in case a check ever puts a value
 * it saw from the server or the user into the report by mistake. It only ever looks at
 * variable parts: a `Prose` slot or an evidence string that is not probe vocabulary. A part
 * that contains a tainted value is replaced as a whole by `<scrubbed>`, never in part. Fixed
 * text (the sentences, ids, plan items, claims, evidence keys, the probe's own codes and
 * calendar names, standard protocol names and href shapes) is never changed: changing it
 * would show which word of a known text matched a value from the account.
 */
import { CODE_WORDS } from './vocabulary';

declare const safeBrand: unique symbol;
export type Safe = string & { readonly [safeBrand]: true };

/** For string constants written in this code base only. */
export function fixed(value: string): Safe {
    return value as Safe;
}

const OTHER = fixed('<other>');
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9:_.-]{0,63}$/;

/**
 * Standard names (HTTP headers, WebDAV/CalDAV elements, DAV capability tokens, iCalendar
 * properties) that are never personal. Any other server-supplied name is also checked
 * against every value seen in this run, because a server could put user data into a name.
 */
const KNOWN_NAMES = new Set([
    // HTTP response headers
    'accept-ranges', 'allow', 'cache-control', 'connection', 'content-encoding', 'content-length', 'content-location', 'content-type',
    'date', 'dav', 'etag', 'expires', 'keep-alive', 'last-modified', 'location', 'pragma', 'retry-after', 'schedule-tag', 'server',
    'set-cookie', 'strict-transport-security', 'transfer-encoding', 'vary', 'www-authenticate', 'x-content-type-options',
    'x-frame-options', 'x-xss-protection', 'referrer-policy', 'content-security-policy', 'alt-svc', 'via', 'age',
    // HTTP methods (Allow header)
    'acl', 'copy', 'delete', 'get', 'head', 'lock', 'mkcalendar', 'mkcol', 'move', 'options', 'patch', 'post', 'propfind',
    'proppatch', 'put', 'report', 'search', 'trace', 'unlock', 'bind', 'unbind', 'rebind',
    // WebDAV / CalDAV / calendarserver elements and preconditions
    'calendar', 'collection', 'principal', 'schedule-inbox', 'schedule-outbox', 'notification', 'shared', 'shared-owner', 'subscribed',
    'dropbox-home', 'notification-home', 'no-uid-conflict', 'valid-calendar-data', 'valid-calendar-object-resource',
    'supported-calendar-data', 'supported-calendar-component', 'supported-filter', 'supported-collation', 'valid-filter',
    'need-privileges', 'valid-sync-token', 'number-of-matches-within-limits', 'max-resource-size', 'min-date-time',
    'max-date-time', 'max-instances', 'max-attendees-per-instance', 'calendar-collection-location-ok', 'resource-must-be-null',
    'lock-token-submitted', 'precondition-failed', 'error', 'href', 'resource', 'privilege', 'response', 'status',
    // DAV header capability tokens
    'access-control', 'addressbook', 'calendar-access', 'calendar-schedule', 'calendar-auto-schedule', 'calendar-availability',
    'calendar-managed-attachments', 'calendar-no-timezone', 'calendar-default-alarms', 'calendar-query-extended',
    'calendarserver-sharing', 'calendarserver-subscribed', 'calendarserver-principal-property-search',
    'calendarserver-principal-search', 'calendarserver-private-events', 'calendarserver-private-comments',
    'calendarserver-home-sync', 'extended-mkcol', 'inbox-availability', 'resource-sharing', 'sync-collection',
    // iCalendar properties
    'action', 'attach', 'attendee', 'calscale', 'categories', 'class', 'comment', 'completed', 'contact', 'created', 'description',
    'dtend', 'dtstamp', 'dtstart', 'due', 'duration', 'exdate', 'exrule', 'freebusy', 'geo', 'last-modified', 'location', 'method',
    'organizer', 'percent-complete', 'priority', 'prodid', 'rdate', 'recurrence-id', 'related-to', 'repeat', 'request-status',
    'resources', 'rrule', 'sequence', 'status', 'summary', 'transp', 'trigger', 'tzid', 'tzname', 'tzoffsetfrom', 'tzoffsetto',
    'tzurl', 'uid', 'url', 'version', 'acknowledged', 'color', 'conference', 'image', 'refresh-interval', 'source', 'name',
    'x-wr-alarmuid', 'x-wr-calname', 'x-wr-timezone', 'x-apple-travel-advisory-behavior', 'x-apple-structured-location',
    'x-apple-default-alarm', 'x-apple-creator-identity', 'x-apple-creator-team-identity', 'x-apple-local-default-alarm',
    'x-lic-location', 'x-caldav-mcp-probe',
]);

/**
 * Element, property, header, privilege and capability names. Anything that is not of name
 * shape becomes `<other>` (and, with a taint set, is remembered so it is scrubbed anywhere
 * else it appears). A non-standard name that overlaps a value seen in this run also
 * becomes `<other>`.
 */
export function safeName(value: string, taint?: Taint): Safe {
    if (!NAME_SHAPE.test(value) || /\d{5,}/.test(value)) {
        taint?.add(value);
        return OTHER;
    }
    if (taint !== undefined && !KNOWN_NAMES.has(value.toLowerCase()) && taint.overlaps(value)) {
        return OTHER;
    }
    return value as Safe;
}

export function safeNames(values: Iterable<string>, taint?: Taint): Safe[] {
    return [...new Set([...values].map((v) => safeName(v, taint)))].toSorted();
}

/**
 * Re-checks names already in evidence against everything seen by the end of the run (a
 * name recorded early, such as an Allow-header method, may only later turn out to match
 * a value from the account). Only arrays of strings hold names in evidence.
 */
export function recheckNames<T>(evidence: Record<string, T>, taint: Taint): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(evidence)) {
        out[key] = Array.isArray(value)
            ? ([...new Set(value.map((v: unknown) => (typeof v === 'string' && v !== OTHER && !KNOWN_NAMES.has(v.toLowerCase()) && taint.overlaps(v) ? OTHER : v)))].toSorted() as T)
            : value;
    }
    return out;
}

/** Sorted, de-duplicated list of values that were already reduced to a safe form. */
export function sortedSafe(values: Iterable<Safe>): Safe[] {
    return [...new Set(values)].toSorted();
}

const SAFE_SEGMENTS = new Set([
    'principal', 'principals', 'calendars', 'inbox', 'outbox', 'notification', 'dropbox',
    '.well-known', 'caldav', 'calendar', 'users', '__uids__',
]);
const PROBE_SEGMENT = /^caldav-mcp-probe-[0-9a-f]{8}(-[0-9a-z]{1,12})*$/;

/** Path shape of an href with every identifier replaced, e.g. `/<id>/calendars/<id>/`. */
export function hrefShape(href: string | null | undefined): Safe {
    if (href === null || href === undefined || href.trim() === '') {
        return fixed('<none>');
    }
    let path: string;
    try {
        const url = new URL(href.trim(), 'https://placeholder.invalid');
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return fixed('<non-path>');
        }
        path = url.pathname;
    } catch {
        return fixed('<non-path>');
    }
    const shaped = path.split('/').map((segment, index, all) => {
        if (segment === '' && (index === 0 || index === all.length - 1)) {
            return '';
        }
        const ics = segment.toLowerCase().endsWith('.ics');
        const stem = ics ? segment.slice(0, -4) : segment;
        if (SAFE_SEGMENTS.has(stem)) {
            return segment;
        }
        const placeholder = PROBE_SEGMENT.test(stem) ? '<probe>' : '<id>';
        return ics ? `${placeholder}.ics` : placeholder;
    });
    return fixed(shaped.join('/') || '/');
}

export interface EtagShape { quoted: boolean; weak: boolean; length: number }

export function etagShape(etag: string | null | undefined): EtagShape | null {
    if (etag === null || etag === undefined) {
        return null;
    }
    const weak = etag.startsWith('W/');
    const rest = weak ? etag.slice(2) : etag;
    return { quoted: rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"'), weak, length: etag.length };
}

export interface TokenShape { length: number; looksLikeUrl: boolean; base64Alphabet: boolean }

export function tokenShape(token: string): TokenShape {
    return {
        length: token.length,
        looksLikeUrl: /^https?:\/\//i.test(token),
        base64Alphabet: token.length > 0 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(token),
    };
}

/** DAV header capability tokens. Coded URLs (`<...>`) and odd tokens are only counted. */
export function davTokens(header: string | null | undefined): { tokens: Safe[]; otherCount: number } {
    if (header === null || header === undefined) {
        return { tokens: [], otherCount: 0 };
    }
    const tokens: Safe[] = [];
    let otherCount = 0;
    for (const raw of header.split(',')) {
        const token = raw.trim();
        if (token === '') {
            continue;
        }
        if (/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(token) && !/\d{5,}/.test(token)) {
            tokens.push(token as Safe);
        } else {
            otherCount++;
        }
    }
    return { tokens, otherCount };
}

/** Retry-After as seconds, or null. Never echoes the raw value. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    const trimmed = value.trim();
    if (/^\d{1,7}$/.test(trimmed)) {
        return Number(trimmed);
    }
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) {
        return null;
    }
    return Math.max(0, Math.round((date - nowMs) / 1000));
}

const NEVER_TAINT = /^caldav-mcp[- ]probe/;
/** iCloud's default calendar slugs: not personal, and common words in the report's own text. */
const GENERIC_WORDS = new Set(['home', 'work', 'tasks', 'reminders', 'calendar', 'calendars', 'default', 'events']);

function base64(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Values the probe has seen and must never print: the credentials, and every name,
 * href, ETag, token, address and event text received from the server.
 */
export class Taint {
    private readonly values = new Set<string>();
    private cachedForms: string[] | undefined;

    add(value: string | null | undefined): void {
        if (value === null || value === undefined) {
            return;
        }
        const trimmed = value.trim();
        if (trimmed.length < 4 || NEVER_TAINT.test(trimmed) || GENERIC_WORDS.has(trimmed)) {
            return;
        }
        if (!this.values.has(trimmed)) {
            this.values.add(trimmed);
            this.cachedForms = undefined;
        }
    }

    /** Taints an href and each of its non-structural path segments. */
    addHref(href: string | null | undefined): void {
        if (href === null || href === undefined) {
            return;
        }
        this.add(href);
        for (const segment of href.split(/[/?#]/)) {
            let decoded = segment;
            try {
                decoded = decodeURIComponent(segment);
            } catch {
                // Keep the raw segment.
            }
            const stem = decoded.replace(/\.ics$/i, '');
            if (!SAFE_SEGMENTS.has(stem) && !/^https?:$/i.test(stem) && !/\.icloud\.com(:\d+)?$/i.test(stem)) {
                this.add(segment);
                this.add(decoded);
                this.add(stem);
            }
        }
    }

    get size(): number {
        return this.values.size;
    }

    /**
     * Case-insensitive: the name contains a seen value, or the name (without a leading
     * `x-`) is contained in one. Used to withhold server-supplied names that carry user data.
     */
    overlaps(name: string): boolean {
        const lower = name.toLowerCase();
        const core = lower.replace(/^x-/, '');
        for (const value of this.values) {
            const seen = value.toLowerCase();
            if (lower.includes(seen) || (core.length >= 4 && seen.includes(core))) {
                return true;
            }
        }
        return false;
    }

    /** True when the string contains any tainted value, raw, URL-encoded or base64. */
    foundIn(text: string): boolean {
        return this.forms().some((form) => text.includes(form));
    }

    forms(): string[] {
        if (this.cachedForms === undefined) {
            const forms = new Set<string>();
            for (const value of this.values) {
                forms.add(value);
                forms.add(encodeURIComponent(value));
                forms.add(base64(value));
            }
            // Longest first, so a value is replaced before any shorter value it contains.
            this.cachedForms = [...forms].filter((form) => form.length >= 4).toSorted((a, b) => b.length - a.length);
        }
        return this.cachedForms;
    }
}

const SCRUBBED = '<scrubbed>';
const STRICT_PROBE_NAME = /^caldav-mcp-probe-[0-9a-f]{8}$/;

function isShapeSegment(segment: string): boolean {
    const stem = segment.toLowerCase().endsWith('.ics') ? segment.slice(0, -4) : segment;
    return stem === '<id>' || stem === '<probe>' || SAFE_SEGMENTS.has(stem);
}

/** Output of `hrefShape`: only placeholders and structural words. */
function isHrefShape(value: string): boolean {
    if (value === '/') {
        return true;
    }
    const segments = value.split('/');
    return segments.length >= 2 && segments[0] === ''
        && segments.slice(1).every((segment, i, rest) => (segment === '' ? i === rest.length - 1 : isShapeSegment(segment)));
}

/**
 * Strings that are the same in every run, whatever the account holds: the probe's own codes
 * and placeholders, its temporary calendar names, href shapes and standard protocol names.
 * The second layer never rewrites them.
 */
export function isVocabulary(value: string): boolean {
    return CODE_WORDS.has(value) || KNOWN_NAMES.has(value.toLowerCase()) || STRICT_PROBE_NAME.test(value) || isHrefShape(value);
}

/** One variable string: kept, or replaced as a whole when it is not vocabulary and contains a tainted form. */
function scrubString(value: string, taint: Taint | undefined): { text: string; scrubbed: boolean } {
    if (taint === undefined || isVocabulary(value) || !taint.foundIn(value)) {
        return { text: value, scrubbed: false };
    }
    return { text: SCRUBBED, scrubbed: true };
}

/** A variable part of a sentence: a number, a nested sentence, or a value already reduced by the first layer. */
export type ProseSlot = number | Prose | Safe;

/** A sentence written in this code base, with its variable parts kept apart from the fixed text. */
export class Prose {
    private constructor(readonly parts: readonly string[], readonly slots: readonly ProseSlot[]) {}

    /** Use the `prose` tag. Only a template literal's strings array is accepted as fixed text. */
    static fromTemplate(parts: TemplateStringsArray, slots: readonly ProseSlot[]): Prose {
        if (!Object.isFrozen(parts) || !Array.isArray(parts.raw) || parts.length !== slots.length + 1) {
            throw new TypeError('prose: fixed text must come from a template literal');
        }
        return new Prose([...parts], [...slots]);
    }
}

/** Template tag for summaries: prose`Narrow window ${n} of ${m} resources.` */
export function prose(parts: TemplateStringsArray, ...slots: ProseSlot[]): Prose {
    return Prose.fromTemplate(parts, slots);
}

/**
 * The sentence as text. With a taint set, each `Safe` slot that is not vocabulary and
 * contains a tainted form becomes `<scrubbed>` as a whole; the fixed text never changes.
 */
export function renderProse(sentence: Prose, taint?: Taint): { text: string; count: number } {
    let count = 0;
    const render = (p: Prose): string => {
        let out = p.parts[0] ?? '';
        p.slots.forEach((slot, i) => {
            let piece: string;
            if (typeof slot === 'number') {
                piece = String(slot);
            } else if (slot instanceof Prose) {
                piece = render(slot);
            } else {
                const result = scrubString(slot, taint);
                count += result.scrubbed ? 1 : 0;
                piece = result.text;
            }
            out += piece + (p.parts[i + 1] ?? '');
        });
        return out;
    };
    return { text: render(sentence), count };
}

/**
 * Second layer for structured values (evidence, the cleanup report, a report returned by
 * the Lambda function), recursively. A string that is not vocabulary and contains a tainted
 * form is replaced as a whole by `<scrubbed>` and counted. Keys, numbers, booleans and
 * vocabulary strings are never changed.
 */
export function scrubValue<T>(value: T, taint: Taint): { value: T; count: number } {
    let count = 0;
    const visit = (input: unknown): unknown => {
        if (typeof input === 'string') {
            const result = scrubString(input, taint);
            count += result.scrubbed ? 1 : 0;
            return result.text;
        }
        if (Array.isArray(input)) {
            return input.map(visit);
        }
        if (input !== null && typeof input === 'object') {
            return Object.fromEntries(Object.entries(input).map(([key, inner]) => [key, visit(inner)]));
        }
        return input;
    };
    const result = visit(value) as T;
    return { value: result, count };
}
