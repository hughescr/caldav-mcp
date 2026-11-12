/**
 * An in-memory imitation of iCloud's CalDAV server, used as the `fetch` for probe tests.
 * Its behaviour on every point the probe measures is configurable, so each check can be
 * driven to `confirmed`, `refuted` and `inconclusive`. All data is synthetic.
 */
import { comps, parseIcal, prop, props } from '../../../scripts/probe/ical';
import { child, childrenNamed, descendants, escapeXml, parseXml, type XmlNode } from '../../../scripts/probe/xml';
import {
    embeddedZones, expandResource, limitRecurrenceSet, occurrences, overlaps, parseDt, pointOf, utc, zoneFromVtimezone, BUILTIN_ZONES,
    type ExpandStyle, type TimeEnv, type ZoneRules,
} from './fake-time';

export { utc } from './fake-time';
export const FAKE_NOW = Date.parse('2026-11-11T12:00:00Z');
const DAY = 86_400_000;

export type CalendarKind = 'owned' | 'shared' | 'shared-owner' | 'subscribed';

export interface FakeEventSeed { name: string; ical: string }

export interface FakeCalendarSeed {
    id: string;
    displayName: string;
    kind?: CalendarKind;
    components?: string[];
    writable?: boolean;
    color?: string;
    events?: FakeEventSeed[];
}

export interface FakeRequest { method: string; url: URL; headers: Headers; body: string }

export interface FakeBehaviour {
    davHeader: string;
    freeBusyStatus: number;
    uidFilterStatus: number;
    expand: boolean;
    textMatch: boolean;
    timeRange: boolean;
    syncLimitHonoured: boolean;
    ifMatchStar: 'works' | 'fails';
    requireEnd: boolean;
    uniqueUidAcrossCalendars: boolean;
    putReturnsEtag: boolean;
    scheduleStatus: string | null;
    addsVtimezone: boolean;
    rewritesProdid: boolean;
    deleteCollection: 'works' | 'fails' | 'pretend';
    principalChangesEachTime: boolean;
    weakEtags: boolean;
    /** The Depth value sync-collection accepts (RFC 6578: 0). */
    syncDepth: '0' | '1';
    /** Form of expanded instances: everything in UTC, original forms kept, forms kept without VTIMEZONE, DATE turned into UTC. */
    expandStyle: ExpandStyle;
    /** An expanded instance of an event with DURATION keeps DURATION instead of getting a DTEND. */
    expandKeepsDuration: boolean;
    /** Where floating and DATE values sit on the time axis for time-range filtering and expansion. */
    floatingInterpretation: 'utc' | 'calendar-timezone';
    /** MKCALENDAR with a calendar-timezone property: stored, silently ignored, replaced by the server's own (Europe/Berlin), or refused with HTTP 400. */
    calendarTimezone: 'stored' | 'ignored' | 'replaced' | 'refused';
    /** A known TZID with an embedded VTIMEZONE: whose rules expansion uses. */
    tzPolicy: 'embedded-first' | 'tzdb-first' | 'ignore';
    /** A TZID the server does not know: use the embedded rules, treat it as America/New_York, or as UTC. */
    unknownTzid: 'use-embedded' | 'as-new-york' | 'as-utc';
    /** PUT of an unknown TZID's VTIMEZONE: kept as sent, refused with HTTP 400, or dropped on save. */
    vtimezonePolicy: 'preserve' | 'refuse-unknown' | 'strip-unknown';
    /** Whether an override counts for a time range by its own times or by the instance it replaces. */
    overrideMatching: 'actual' | 'original-slot';
    /** RECURRENCE-ID;RANGE=THISANDFUTURE moves later instances too, or only the one instance. */
    thisAndFuture: 'applied' | 'ignored';
    /** A TZID wall-clock time that occurs twice (the end of daylight time): the first occurrence (RFC 5545) or the second. */
    repeatedHour: 'first' | 'second';
    /** A TZID wall-clock time that does not exist (the start of daylight time): read with the offset before the gap (RFC 5545) or after it. */
    skippedHour: 'before-gap' | 'after-gap';
    /** Yearly on February 29: only leap years (RFC 5545), February 28, or March 1. */
    feb29: 'skip' | 'clamp' | 'roll';
    /** PUT of a VALUE=DATE event whose DTEND equals DTSTART. */
    dateZeroLength: 'accept' | 'refuse' | 'rewrite';
    /** PUT of RECURRENCE-ID;RANGE=...: kept, the parameter dropped on save, or refused with HTTP 400. */
    rangeParam: 'keep' | 'strip' | 'refuse';
    /** calendar-data/limit-recurrence-set: applied, ignored (everything returned), or refused with HTTP 400. */
    limitRecurrenceSet: 'works' | 'ignored' | 'refused';
    /** The calendar-data in a calendar-query: as stored, with LF line endings, or without X- properties. */
    queryCalendarData: 'verbatim' | 'lf-line-endings' | 'dropped-x-properties';
    /** Appended inside the quotes of the ETag a calendar-query returns (a different ETag than GET). */
    reportEtagSuffix: string;
    /** calendar-multiget returns at most this many resources (extra hrefs are silently dropped). */
    multigetMaxHrefs: number;
    /** calendar-multiget answers 404 for every Nth requested href (0: never). */
    multigetHidesEvery: number;
    /** POST ?action=attachment-add / -remove: works, refused with 403, answered 401, or not implemented (405). */
    attachmentAdd: 'works' | 'forbidden' | 'unauthorized' | 'unsupported';
    /** An accepted attachment-add carries the Cal-Managed-ID and Location headers. */
    attachmentAddHeaders: boolean;
    /** An accepted attachment-add returns the event when the request has `Prefer: return=representation`. */
    attachmentAddRepresentation: boolean;
    /** The ATTACH the fake writes has a SIZE parameter. */
    attachmentSizeParam: boolean;
    /** Which host the URL of a managed attachment names (the fake serves it on any host it is asked on). */
    attachmentHost: 'partition' | 'root' | 'content' | 'other' | 'icloud-other';
    /** Whether the initial attachment URL serves bytes anonymously (redirect targets always do). */
    attachmentAnonymous: boolean;
    /** GET of an attachment URL: served (with Range), served ignoring Range, redirected within the allowed hosts, redirected to icloud-content.com, or refused with 403 or 401. */
    attachmentGet: 'ok' | 'ignores-range' | 'redirect-allowed' | 'redirect-content' | 'forbidden' | 'unauthorized';
    /** PUT of an event with ATTACH: kept as sent, an inline one turned into a managed attachment, or every ATTACH dropped. */
    attachmentPut: 'preserve' | 'inline-to-managed' | 'drop';
    /** Transform a normal response for adversarial evidence/coverage tests (in-memory only). */
    transformResponse?: (req: FakeRequest, response: Response) => Promise<Response>;
    /** Return a response to override normal handling. */
    hook?: (req: FakeRequest, count: number) => Response | undefined;
}

export interface FakeOptions {
    appleId: string;
    appPassword: string;
    dsid: string;
    host?: string;
    addresses?: string[];
    principalName?: string;
    calendars: FakeCalendarSeed[];
    behaviour?: Partial<FakeBehaviour>;
    etagPrefix?: string;
    tokenPrefix?: string;
}

interface FakeEvent { ical: string; etag: string; rev: number }

interface FakeCalendar {
    id: string;
    displayName: string;
    kind: CalendarKind;
    components: string[];
    writable: boolean;
    color: string;
    events: Map<string, FakeEvent>;
    tombstones: Map<string, number>;
    rev: number;
    /** The calendar-timezone property (iCalendar text), when one was stored. */
    timezone?: string;
}

const DEFAULT_BEHAVIOUR: FakeBehaviour = {
    davHeader: '1, 3, access-control, calendar-access, calendar-schedule, calendar-auto-schedule, calendar-availability, calendarserver-sharing, calendarserver-subscribed, calendar-managed-attachments, <https://caldav.icloud.com/ns/x>',
    freeBusyStatus: 400,
    uidFilterStatus: 412,
    expand: false,
    textMatch: false,
    timeRange: true,
    syncLimitHonoured: false,
    ifMatchStar: 'fails',
    requireEnd: true,
    uniqueUidAcrossCalendars: true,
    putReturnsEtag: true,
    scheduleStatus: '1.2',
    addsVtimezone: false,
    rewritesProdid: true,
    deleteCollection: 'works',
    principalChangesEachTime: false,
    weakEtags: false,
    syncDepth: '0',
    expandStyle: 'utc-all',
    expandKeepsDuration: false,
    floatingInterpretation: 'utc',
    calendarTimezone: 'stored',
    tzPolicy: 'embedded-first',
    unknownTzid: 'use-embedded',
    vtimezonePolicy: 'preserve',
    overrideMatching: 'actual',
    thisAndFuture: 'ignored',
    repeatedHour: 'first',
    skippedHour: 'before-gap',
    feb29: 'skip',
    dateZeroLength: 'accept',
    rangeParam: 'keep',
    limitRecurrenceSet: 'works',
    queryCalendarData: 'verbatim',
    reportEtagSuffix: '',
    multigetMaxHrefs: Infinity,
    multigetHidesEvery: 0,
    attachmentAdd: 'works',
    attachmentAddHeaders: true,
    attachmentAddRepresentation: true,
    attachmentSizeParam: true,
    attachmentHost: 'partition',
    attachmentAnonymous: false,
    attachmentGet: 'ok',
    attachmentPut: 'preserve',
};

/** A file the fake serves at an attachment URL. */
export interface FakeBlob { text: string; type: string }

const ATTACHMENT_HOSTS = { 'icloud-other': 'p123-attachment.icloud.com', partition: 'p42-caldav.icloud.com', root: 'caldav.icloud.com', content: 'p42-content.icloud-content.com', other: 'files.example.invalid' } as const;

/** A calendar-timezone the fake supplies itself in `replaced` mode. */
const SERVER_DEFAULT_TIMEZONE = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19961027T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'DTSTART:19960331T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'END:VTIMEZONE', 'END:VCALENDAR',
].join('\r\n') + '\r\n';

const NS = 'xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';
const PREFIX: Record<string, string> = {
    'calendar-home-set': 'cal', 'calendar-user-address-set': 'cal', 'schedule-outbox-URL': 'cal', 'schedule-inbox-URL': 'cal',
    'supported-calendar-component-set': 'cal', 'calendar-timezone': 'cal', 'calendar-data': 'cal', 'calendar-description': 'cal',
    getctag: 'cs', source: 'cs', invite: 'cs', 'allowed-sharing-modes': 'cs', 'shared-url': 'cs', 'calendar-color': 'ic',
};

function tag(name: string): string {
    return `${PREFIX[name] ?? 'd'}:${name}`;
}

function xmlText(value: string): string {
    return escapeXml(value).replace(/\r\n/g, '&#13;\n');
}

function multistatus(responses: string[], extra = ''): Response {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<d:multistatus ${NS}>${responses.join('')}${extra}</d:multistatus>`, {
        status: 207,
        headers: { 'content-type': 'text/xml; charset=utf-8' },
    });
}

function propResponse(href: string, found: Map<string, string>, missing: string[]): string {
    let xml = `<d:response><d:href>${escapeXml(href)}</d:href>`;
    if (found.size > 0) {
        xml += `<d:propstat><d:prop>${[...found].map(([name, inner]) => `<${tag(name)}>${inner}</${tag(name)}>`).join('')}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
    }
    if (missing.length > 0) {
        xml += `<d:propstat><d:prop>${missing.map((name) => `<${tag(name)}/>`).join('')}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`;
    }
    return `${xml}</d:response>`;
}

function errorResponse(status: number, element: string, inner = ''): Response {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><d:error ${NS}><${element}>${inner}</${element}></d:error>`, { status, headers: { 'content-type': 'text/xml' } });
}

function unfoldedLines(ical: string): string[] {
    return ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '');
}

export class FakeICloud {
    readonly requests: FakeRequest[] = [];
    readonly calendars = new Map<string, FakeCalendar>();
    readonly behaviour: FakeBehaviour;
    readonly host: string;
    /** Files behind attachment URLs, by managed id. */
    readonly blobs = new Map<string, FakeBlob>();
    private etagCounter = 0;
    private principalCalls = 0;
    private managedCounter = 0;

    constructor(private readonly options: FakeOptions) {
        this.behaviour = { ...DEFAULT_BEHAVIOUR, ...options.behaviour };
        this.host = options.host ?? 'p42-caldav.icloud.com';
        for (const seed of options.calendars) {
            const cal: FakeCalendar = {
                id: seed.id,
                displayName: seed.displayName,
                kind: seed.kind ?? 'owned',
                components: seed.components ?? ['VEVENT'],
                writable: seed.writable ?? (seed.kind === undefined || seed.kind === 'owned' || seed.kind === 'shared-owner'),
                color: seed.color ?? '#1BADF8FF',
                events: new Map(),
                tombstones: new Map(),
                rev: 1,
            };
            for (const event of seed.events ?? []) {
                cal.events.set(event.name, { ical: event.ical, etag: this.nextEtag(), rev: 1 });
            }
            this.calendars.set(seed.id, cal);
        }
    }

    get homePath(): string {
        return `/${this.options.dsid}/calendars/`;
    }

    get principalPath(): string {
        return `/${this.options.dsid}/principal/`;
    }

    private nextEtag(): string {
        this.etagCounter++;
        const value = `"${this.options.etagPrefix ?? 'etag'}${this.etagCounter}"`;
        return this.behaviour.weakEtags ? `W/${value}` : value;
    }

    private token(cal: FakeCalendar, rev: number): string {
        return `${this.options.tokenPrefix ?? 'sync-'}${cal.id}_${rev}`;
    }

    readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        const fake: FakeRequest = { method: req.method.toUpperCase(), url: new URL(req.url), headers: req.headers, body: req.body === null ? '' : await req.text() };
        this.requests.push(fake);
        if (init?.redirect !== 'manual') {
            throw new Error('fake server: probe must use redirect: manual');
        }
        const hooked = this.behaviour.hook?.(fake, this.requests.length);
        if (hooked !== undefined) {
            return hooked;
        }
        const expected = `Basic ${Buffer.from(`${this.options.appleId}:${this.options.appPassword}`).toString('base64')}`;
        const anonymousFile = fake.method === 'GET' && fake.url.pathname.includes('/attachments/')
            && (this.behaviour.attachmentAnonymous || fake.url.searchParams.has('hop') || fake.url.hostname === ATTACHMENT_HOSTS.content);
        if (!anonymousFile && fake.headers.get('authorization') !== expected) {
            return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic realm="fake"' } });
        }
        try {
            const response = this.route(fake);
            return this.behaviour.transformResponse === undefined ? response : await this.behaviour.transformResponse(fake, response);
        } catch {
            return new Response('fake server error', { status: 500 });
        }
    };

    private route(req: FakeRequest): Response {
        const host = req.url.hostname;
        const path = decodeURIComponent(req.url.pathname);
        const attachment = /^\/[^/]+\/attachments\/([^/]+)\/[^/]+$/.exec(path);
        if (attachment !== null) {
            // Served on whatever host it is asked on; the tests assert which hosts the probe really contacted.
            return this.attachmentFile(req, attachment[1] ?? '');
        }
        if (host !== 'caldav.icloud.com' && host !== this.host) {
            return new Response('wrong host', { status: 421 });
        }
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 200, headers: { dav: this.behaviour.davHeader, allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT, MKCALENDAR' } });
        }
        if (path === '/.well-known/caldav') {
            return new Response(null, { status: 301, headers: { location: '/' } });
        }
        if (path === '/') {
            return this.propfind(req, [{ href: '/', props: (name) => (name === 'current-user-principal' ? `<d:href>${this.principalPath}</d:href>` : undefined) }]);
        }
        if (path === this.principalPath) {
            return this.propfind(req, [{ href: this.principalPath, props: (name) => this.principalProp(name) }]);
        }
        if (host !== this.host) {
            return new Response('not found', { status: 404 });
        }
        if (path === this.homePath) {
            return this.home(req);
        }
        if (!path.startsWith(this.homePath)) {
            return new Response('not found', { status: 404 });
        }
        const rest = path.slice(this.homePath.length);
        const match = /^([^/]+)\/(?:([^/]+))?$/.exec(rest);
        if (match === null) {
            return new Response('not found', { status: 404 });
        }
        const [, calId = '', name] = match;
        if (name === undefined) {
            return this.collection(req, calId);
        }
        return this.resource(req, calId, name);
    }

    private attachmentUrl(id: string, filename: string): string {
        const host = ATTACHMENT_HOSTS[this.behaviour.attachmentHost];
        const port = this.behaviour.attachmentHost === 'partition' || this.behaviour.attachmentHost === 'root' ? ':443' : '';
        return `https://${host}${port}/${this.options.dsid}/attachments/${id}/${encodeURIComponent(filename)}`;
    }

    /** A new managed attachment: the file is stored and the ATTACH line that names it is returned. */
    private managedLine(blob: FakeBlob, filename: string): { id: string; line: string } {
        const id = `${String(++this.managedCounter).padStart(8, '0')}-0000-4000-8000-000000000000`;
        this.blobs.set(id, blob);
        const size = this.behaviour.attachmentSizeParam ? `;SIZE=${Buffer.byteLength(blob.text)}` : '';
        return { id, line: `ATTACH;MANAGED-ID=${id};FMTTYPE=${blob.type}${size};FILENAME=${filename}:${this.attachmentUrl(id, filename)}` };
    }

    private attachmentFile(req: FakeRequest, id: string): Response {
        const mode = this.behaviour.attachmentGet;
        if (req.method !== 'GET') {
            return new Response(null, { status: 405 });
        }
        if (mode === 'unauthorized') {
            return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer realm="fake"' } });
        }
        if (mode === 'forbidden') {
            return new Response('no', { status: 403 });
        }
        // Like a front end that redirects before it knows whether the file is still there.
        const hopped = req.url.searchParams.has('hop') || req.url.hostname === ATTACHMENT_HOSTS.content;
        if (!hopped && mode === 'redirect-allowed') {
            return new Response(null, { status: 302, headers: { location: `https://${this.host}:443${req.url.pathname}?hop=2` } });
        }
        if (!hopped && mode === 'redirect-content') {
            return new Response(null, { status: 302, headers: { location: `https://${ATTACHMENT_HOSTS.content}${req.url.pathname}` } });
        }
        const blob = this.blobs.get(id);
        if (blob === undefined) {
            return new Response('not found', { status: 404 });
        }
        const bytes = Buffer.from(blob.text, 'utf8');
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get('range') ?? '');
        if (range?.[1] !== undefined && range[2] !== undefined && mode !== 'ignores-range') {
            const [from, to] = [Number(range[1]), Math.min(Number(range[2]), bytes.length - 1)];
            const slice = bytes.subarray(from, to + 1);
            return new Response(slice, { status: 206, headers: { 'content-type': blob.type, 'accept-ranges': 'bytes', 'content-range': `bytes ${from}-${to}/${bytes.length}`, 'content-length': String(slice.length) } });
        }
        return new Response(bytes, { status: 200, headers: { 'content-type': blob.type, 'content-length': String(bytes.length), ...(mode === 'ignores-range' ? {} : { 'accept-ranges': 'bytes' }) } });
    }

    /** POST ?action=attachment-add and ?action=attachment-remove (RFC 8607) on an event. */
    private attachmentAction(req: FakeRequest, cal: FakeCalendar, name: string, existing: FakeEvent | undefined): Response {
        const mode = this.behaviour.attachmentAdd;
        if (mode === 'unsupported') {
            return new Response(null, { status: 405 });
        }
        if (mode === 'unauthorized') {
            return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic realm="fake"' } });
        }
        if (mode === 'forbidden' || !cal.writable) {
            return errorResponse(403, 'd:need-privileges');
        }
        if (existing === undefined) {
            return new Response('not found', { status: 404 });
        }
        const action = req.url.searchParams.get('action');
        const lines = unfoldedLines(existing.ical);
        const at = lines.indexOf('END:VEVENT');
        if (action === 'attachment-add') {
            const filename = /filename="([^"]*)"/.exec(req.headers.get('content-disposition') ?? '')?.[1] ?? 'attachment';
            const { id, line } = this.managedLine({ text: req.body, type: req.headers.get('content-type') ?? 'application/octet-stream' }, filename);
            lines.splice(at, 0, line);
            existing.ical = `${lines.join('\r\n')}\r\n`;
            existing.etag = this.nextEtag();
            cal.rev++;
            existing.rev = cal.rev;
            const headers: Record<string, string> = { etag: existing.etag };
            if (this.behaviour.attachmentAddHeaders) {
                headers['cal-managed-id'] = id;
                headers.location = this.attachmentUrl(id, filename);
            }
            const represent = this.behaviour.attachmentAddRepresentation && /return=representation/.test(req.headers.get('prefer') ?? '');
            return new Response(represent ? existing.ical : null, { status: 201, headers: represent ? { ...headers, 'content-type': 'text/calendar; charset=utf-8' } : headers });
        }
        if (action === 'attachment-remove') {
            const id = req.url.searchParams.get('managed-id') ?? '';
            const kept = lines.filter((l) => !(l.startsWith('ATTACH;') && l.includes(`MANAGED-ID=${id};`)));
            if (kept.length === lines.length || !this.blobs.has(id)) {
                return new Response('no such attachment', { status: 404 });
            }
            this.blobs.delete(id);
            existing.ical = `${kept.join('\r\n')}\r\n`;
            existing.etag = this.nextEtag();
            cal.rev++;
            existing.rev = cal.rev;
            return new Response(null, { status: 204, headers: { etag: existing.etag } });
        }
        return new Response('unknown action', { status: 400 });
    }

    /** What a PUT does to ATTACH properties (`attachmentPut`). */
    private applyAttachmentPolicy(lines: string[]): string[] {
        const policy = this.behaviour.attachmentPut;
        if (policy === 'preserve') {
            return lines;
        }
        if (policy === 'drop') {
            return lines.filter((l) => !/^ATTACH[;:]/.test(l));
        }
        return lines.map((l) => {
            const inline = /^ATTACH;[^:]*(?:ENCODING=BASE64|VALUE=BINARY)[^:]*:(.*)$/.exec(l);
            if (inline?.[1] === undefined) {
                return l;
            }
            return this.managedLine({ text: Buffer.from(inline[1], 'base64').toString('utf8'), type: /FMTTYPE=([^;:]+)/.exec(l)?.[1] ?? 'application/octet-stream' }, 'inline-file').line;
        });
    }

    private principalProp(name: string): string | undefined {
        this.principalCalls += name === 'calendar-home-set' ? 1 : 0;
        const dsid = this.behaviour.principalChangesEachTime ? `${this.options.dsid}${this.principalCalls}` : this.options.dsid;
        switch (name) {
            case 'calendar-home-set':
                return `<d:href>https://${this.host}:443/${dsid}/calendars/</d:href>`;
            case 'calendar-user-address-set':
                return (this.options.addresses ?? [`mailto:${this.options.appleId}`, `https://${this.host}:443${this.principalPath}`])
                    .map((a) => `<d:href>${escapeXml(a)}</d:href>`).join('');
            case 'schedule-outbox-URL':
                return `<d:href>${this.homePath}outbox/</d:href>`;
            case 'schedule-inbox-URL':
                return `<d:href>${this.homePath}inbox/</d:href>`;
            case 'principal-URL':
            case 'current-user-principal':
                return `<d:href>${this.principalPath}</d:href>`;
            case 'displayname':
                return this.options.principalName === undefined ? undefined : xmlText(this.options.principalName);
            default:
                return undefined;
        }
    }

    private requestedProps(body: string): string[] {
        const root = parseXml(body);
        const names = child(root, 'prop')?.children.map((c) => c.name);
        return names ?? ['resourcetype', 'displayname'];
    }

    private propfind(req: FakeRequest, entries: { href: string; props: (name: string) => string | undefined }[]): Response {
        if (req.method !== 'PROPFIND') {
            return new Response('method not allowed', { status: 405 });
        }
        const wanted = this.requestedProps(req.body);
        return multistatus(entries.map((entry) => {
            const found = new Map<string, string>();
            const missing: string[] = [];
            for (const name of wanted) {
                const value = entry.props(name);
                if (value === undefined) {
                    missing.push(name);
                } else {
                    found.set(name, value);
                }
            }
            return propResponse(entry.href, found, missing);
        }));
    }

    private calendarProps(cal: FakeCalendar): (name: string) => string | undefined {
        return (name) => {
            switch (name) {
                case 'resourcetype': {
                    const extra = { owned: '', shared: '<cs:shared/>', 'shared-owner': '<cs:shared-owner/>', subscribed: '<cs:subscribed/>' }[cal.kind];
                    return cal.kind === 'subscribed' ? `<d:collection/>${extra}` : `<d:collection/><cal:calendar/>${extra}`;
                }
                case 'displayname':
                    return xmlText(cal.displayName);
                case 'calendar-color':
                    return cal.color;
                case 'getctag':
                    return `${this.options.etagPrefix ?? 'ctag'}ctag-${cal.rev}`;
                case 'sync-token':
                    return this.token(cal, cal.rev);
                case 'supported-calendar-component-set':
                    return cal.components.map((c) => `<cal:comp name="${c}"/>`).join('');
                case 'calendar-timezone':
                    return cal.timezone === undefined ? undefined : xmlText(cal.timezone);
                case 'current-user-privilege-set':
                    return `<d:privilege><d:read/></d:privilege>${cal.writable ? '<d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege>' : ''}`;
                case 'source':
                    return cal.kind === 'subscribed' ? '<d:href>https://feeds.example.invalid/holidays.ics</d:href>' : undefined;
                case 'owner':
                    return cal.kind === 'shared' ? '<d:href>/20000000002/principal/</d:href>' : `<d:href>${this.principalPath}</d:href>`;
                case 'invite':
                    return cal.kind === 'shared' || cal.kind === 'shared-owner' ? '<cs:user><d:href>mailto:friend@example.invalid</d:href></cs:user>' : undefined;
                default:
                    return undefined;
            }
        };
    }

    private home(req: FakeRequest): Response {
        const depth = req.headers.get('depth') ?? '0';
        const homeEntry = { href: this.homePath, props: (name: string): string | undefined => (name === 'resourcetype' ? '<d:collection/>' : undefined) };
        if (req.method === 'PROPFIND') {
            const entries: { href: string; props: (name: string) => string | undefined }[] = [homeEntry];
            if (depth === '1') {
                for (const special of ['inbox', 'outbox', 'notification']) {
                    const type = { inbox: '<cal:schedule-inbox/>', outbox: '<cal:schedule-outbox/>', notification: '<cs:notification/>' }[special];
                    entries.push({ href: `${this.homePath}${special}/`, props: (name) => (name === 'resourcetype' ? `<d:collection/>${type}` : undefined) });
                }
                for (const cal of this.calendars.values()) {
                    entries.push({ href: `${this.homePath}${cal.id}/`, props: this.calendarProps(cal) });
                }
            }
            return this.propfind(req, entries);
        }
        return new Response('method not allowed', { status: 405 });
    }

    private collection(req: FakeRequest, calId: string): Response {
        const cal = this.calendars.get(calId);
        if (req.method === 'MKCALENDAR') {
            if (cal !== undefined || ['inbox', 'outbox', 'notification'].includes(calId)) {
                return new Response(null, { status: 405 });
            }
            const root = parseXml(req.body);
            const displayName = descendants(root, 'displayname')[0]?.text ?? calId;
            const components = descendants(root, 'comp').map((c) => c.attrs.name ?? '').filter((c) => c !== '');
            const timezone = descendants(root, 'calendar-timezone')[0]?.text;
            if (timezone !== undefined && this.behaviour.calendarTimezone === 'refused') {
                return errorResponse(400, 'd:error');
            }
            this.calendars.set(calId, {
                id: calId, displayName, kind: 'owned', components: components.length > 0 ? components : ['VEVENT'], writable: true, color: '#000000FF', events: new Map(), tombstones: new Map(), rev: 1,
                ...(timezone !== undefined && this.behaviour.calendarTimezone === 'stored' ? { timezone } : {}),
                ...(this.behaviour.calendarTimezone === 'replaced' ? { timezone: SERVER_DEFAULT_TIMEZONE } : {}),
            });
            return new Response(null, { status: 201 });
        }
        if (cal === undefined) {
            return new Response('not found', { status: 404 });
        }
        if (req.method === 'PROPFIND') {
            const entries = [{ href: `${this.homePath}${cal.id}/`, props: this.calendarProps(cal) }];
            if (req.headers.get('depth') === '1') {
                for (const [name, event] of cal.events) {
                    entries.push({ href: `${this.homePath}${cal.id}/${name}`, props: (p) => (p === 'getetag' ? event.etag : p === 'getcontenttype' ? 'text/calendar; charset=utf-8' : undefined) });
                }
            }
            return this.propfind(req, entries);
        }
        if (req.method === 'DELETE') {
            if (this.behaviour.deleteCollection === 'fails') {
                return new Response(null, { status: 403 });
            }
            if (this.behaviour.deleteCollection === 'works') {
                this.calendars.delete(calId);
            }
            return new Response(null, { status: 204 });
        }
        if (req.method === 'REPORT') {
            return this.report(req, cal);
        }
        return new Response(null, { status: 405 });
    }

    /** How times are placed on the axis for one resource of one calendar. */
    private env(cal: FakeCalendar, resource: ReturnType<typeof parseIcal>): TimeEnv {
        let floating: ZoneRules | undefined;
        if (this.behaviour.floatingInterpretation === 'calendar-timezone' && cal.timezone !== undefined) {
            const tz = comps(parseIcal(cal.timezone) ?? { name: '', properties: [], components: [] }, 'VTIMEZONE')[0];
            floating = tz === undefined ? undefined : zoneFromVtimezone(tz);
        }
        return {
            floating, embedded: embeddedZones(resource), tzPolicy: this.behaviour.tzPolicy, unknownTzid: this.behaviour.unknownTzid,
            overrideMatching: this.behaviour.overrideMatching, thisAndFuture: this.behaviour.thisAndFuture, feb29: this.behaviour.feb29,
            repeatedHour: this.behaviour.repeatedHour, skippedHour: this.behaviour.skippedHour,
        };
    }

    private queryText(ical: string): string {
        switch (this.behaviour.queryCalendarData) {
            case 'verbatim':
                return ical;
            case 'lf-line-endings':
                return ical.replace(/\r\n/g, '\n');
            case 'dropped-x-properties':
                return `${unfoldedLines(ical).filter((l) => !l.startsWith('X-')).join('\r\n')}\r\n`;
        }
    }

    private eventEntry(cal: FakeCalendar, name: string, event: FakeEvent, propNode: XmlNode | undefined, view: { expandRange?: { start: number; end: number }; limitRange?: { start: number; end: number }; query?: boolean } = {}): string {
        const found = new Map<string, string>();
        const missing: string[] = [];
        for (const p of propNode?.children ?? []) {
            if (p.name === 'getetag') {
                found.set('getetag', escapeXml(view.query === true && this.behaviour.reportEtagSuffix !== '' ? event.etag.replace(/"$/, `${this.behaviour.reportEtagSuffix}"`) : event.etag));
            } else if (p.name === 'calendar-data') {
                const parsed = view.expandRange !== undefined || view.limitRange !== undefined ? parseIcal(event.ical) : undefined;
                let ical = view.query === true ? this.queryText(event.ical) : event.ical;
                if (view.expandRange !== undefined) {
                    ical = expandResource(event.ical, view.expandRange.start, view.expandRange.end, this.env(cal, parsed), { style: this.behaviour.expandStyle, keepDuration: this.behaviour.expandKeepsDuration });
                } else if (view.limitRange !== undefined) {
                    ical = limitRecurrenceSet(event.ical, view.limitRange.start, view.limitRange.end, this.env(cal, parsed));
                }
                found.set('calendar-data', xmlText(ical));
            } else {
                missing.push(p.name);
            }
        }
        return propResponse(`${this.homePath}${cal.id}/${name}`, found, missing);
    }

    private report(req: FakeRequest, cal: FakeCalendar): Response {
        const root = parseXml(req.body);
        if (root === undefined) {
            return new Response('bad xml', { status: 400 });
        }
        if (root.name === 'free-busy-query') {
            if (this.behaviour.freeBusyStatus === 200) {
                return new Response('BEGIN:VCALENDAR\r\nBEGIN:VFREEBUSY\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n', { status: 200, headers: { 'content-type': 'text/calendar' } });
            }
            return new Response('bad request', { status: this.behaviour.freeBusyStatus });
        }
        if (root.name === 'calendar-multiget') {
            const propNode = child(root, 'prop');
            const hides = this.behaviour.multigetHidesEvery;
            return multistatus(childrenNamed(root, 'href').slice(0, this.behaviour.multigetMaxHrefs).map((h, i) => {
                const href = h.text.trim();
                const name = href.split('/').at(-1) ?? '';
                const event = href.startsWith(`${this.homePath}${cal.id}/`) && !(hides > 0 && (i + 1) % hides === 0) ? cal.events.get(name) : undefined;
                return event === undefined ? `<d:response><d:href>${escapeXml(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>` : this.eventEntry(cal, name, event, propNode);
            }));
        }
        if (root.name === 'sync-collection') {
            return this.sync(req, root, cal);
        }
        if (root.name !== 'calendar-query') {
            return new Response('unsupported report', { status: 403 });
        }
        const vcal = child(child(root, 'filter'), 'comp-filter');
        const compFilter = child(vcal, 'comp-filter');
        const compName = compFilter?.attrs.name ?? 'VEVENT';
        const range = child(compFilter, 'time-range');
        const rangeStart = parseDt(range?.attrs.start) ?? -Infinity;
        const rangeEnd = parseDt(range?.attrs.end) ?? Infinity;
        const propFilters = childrenNamed(compFilter, 'prop-filter');
        if (propFilters.some((p) => p.attrs.name === 'UID') && this.behaviour.uidFilterStatus !== 207) {
            return errorResponse(this.behaviour.uidFilterStatus, 'cal:supported-filter');
        }
        const propNode = child(root, 'prop');
        const expand = child(child(propNode, 'calendar-data'), 'expand');
        const expandRange = expand !== undefined && this.behaviour.expand ? { start: parseDt(expand.attrs.start) ?? rangeStart, end: parseDt(expand.attrs.end) ?? rangeEnd } : undefined;
        const limit = child(child(propNode, 'calendar-data'), 'limit-recurrence-set');
        if (limit !== undefined && this.behaviour.limitRecurrenceSet === 'refused') {
            return errorResponse(400, 'cal:valid-calendar-data');
        }
        const limitRange = limit !== undefined && this.behaviour.limitRecurrenceSet === 'works' ? { start: parseDt(limit.attrs.start) ?? rangeStart, end: parseDt(limit.attrs.end) ?? rangeEnd } : undefined;
        const out: string[] = [];
        for (const [name, event] of cal.events) {
            const parsed = parseIcal(event.ical);
            if (parsed === undefined || comps(parsed, compName).length === 0) {
                continue;
            }
            if (range !== undefined && this.behaviour.timeRange && !occurrences(parsed, rangeEnd, this.env(cal, parsed)).some((o) => overlaps(o, rangeStart, rangeEnd))) {
                continue;
            }
            const textOk = propFilters.every((pf) => {
                const match = child(pf, 'text-match');
                if (match === undefined || (!this.behaviour.textMatch && pf.attrs.name !== 'UID')) {
                    return true;
                }
                const needle = match.text.trim().toLowerCase();
                const hit = comps(parsed, compName).some((c) => props(c, pf.attrs.name ?? '').some((p) => p.value.toLowerCase().includes(needle)));
                return match.attrs['negate-condition'] === 'yes' ? !hit : hit;
            });
            if (!textOk) {
                continue;
            }
            out.push(this.eventEntry(cal, name, event, propNode, { query: true, ...(expandRange === undefined ? {} : { expandRange }), ...(limitRange === undefined ? {} : { limitRange }) }));
        }
        return multistatus(out);
    }

    private sync(req: FakeRequest, root: XmlNode, cal: FakeCalendar): Response {
        if ((req.headers.get('depth') ?? '0') !== this.behaviour.syncDepth) {
            return new Response('wrong depth', { status: 400 });
        }
        const tokenText = child(root, 'sync-token')?.text.trim() ?? '';
        let since = 0;
        if (tokenText !== '') {
            const prefix = `${this.options.tokenPrefix ?? 'sync-'}${cal.id}_`;
            const rev = tokenText.startsWith(prefix) ? Number(tokenText.slice(prefix.length)) : Number.NaN;
            if (!Number.isInteger(rev) || rev > cal.rev) {
                return errorResponse(403, 'd:valid-sync-token');
            }
            since = rev;
        }
        const limit = Number(child(child(root, 'limit'), 'nresults')?.text.trim() ?? 'NaN');
        const propNode = child(root, 'prop');
        const changes: { rev: number; xml: string }[] = [];
        for (const [name, event] of cal.events) {
            if (event.rev > since) {
                changes.push({ rev: event.rev, xml: this.eventEntry(cal, name, event, propNode) });
            }
        }
        if (since > 0) {
            for (const [name, rev] of cal.tombstones) {
                if (rev > since) {
                    changes.push({ rev, xml: `<d:response><d:href>${this.homePath}${cal.id}/${name}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>` });
                }
            }
        }
        changes.sort((a, b) => a.rev - b.rev);
        let token = cal.rev;
        let responses = changes.map((c) => c.xml);
        if (this.behaviour.syncLimitHonoured && Number.isInteger(limit) && limit < changes.length) {
            responses = changes.slice(0, limit).map((c) => c.xml);
            token = changes[limit - 1]?.rev ?? since;
            responses.push(`<d:response><d:href>${this.homePath}${cal.id}/</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>`);
        }
        return multistatus(responses, `<d:sync-token>${escapeXml(this.token(cal, token))}</d:sync-token>`);
    }

    private findUid(uid: string): { cal: FakeCalendar; name: string } | undefined {
        for (const cal of this.calendars.values()) {
            for (const [name, event] of cal.events) {
                const parsed = parseIcal(event.ical);
                const eventUid = parsed === undefined ? undefined : prop([...comps(parsed, 'VEVENT'), ...comps(parsed, 'VTODO')][0] ?? parsed, 'UID')?.value;
                if (eventUid === uid) {
                    return { cal, name };
                }
            }
        }
        return undefined;
    }

    private transform(ical: string): string {
        let lines = unfoldedLines(ical);
        if (this.behaviour.rewritesProdid) {
            lines = lines.map((l) => (l.startsWith('PRODID') ? 'PRODID:-//Fake Inc.//Fake Calendar Server//EN' : l));
        }
        lines = this.applyAttachmentPolicy(lines);
        const hasOrganizer = lines.some((l) => l.startsWith('ORGANIZER'));
        if (this.behaviour.scheduleStatus !== null && hasOrganizer) {
            lines = lines.map((l) => (l.startsWith('ATTENDEE') ? l.replace(/^ATTENDEE/, `ATTENDEE;SCHEDULE-STATUS=${this.behaviour.scheduleStatus}`) : l));
        }
        if (this.behaviour.addsVtimezone) {
            const tzids = new Set(lines.flatMap((l) => [...l.matchAll(/;TZID=([^;:]+)/g)].map((m) => m[1] ?? '')));
            const present = new Set(lines.filter((l) => l.startsWith('TZID:')).map((l) => l.slice(5)));
            for (const tzid of tzids) {
                if (!present.has(tzid)) {
                    const at = lines.findIndex((l) => l === 'BEGIN:VEVENT');
                    lines.splice(at, 0, 'BEGIN:VTIMEZONE', `TZID:${tzid}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE');
                }
            }
        }
        return `${lines.join('\r\n')}\r\n`;
    }

    /** Server-side rules on what is stored: zero-length DATE events, RANGE parameters, unknown VTIMEZONEs. */
    private policies(body: string, parsed: NonNullable<ReturnType<typeof parseIcal>>): { text: string } | { refuse: Response } {
        const refuse = (): { refuse: Response } => ({ refuse: errorResponse(400, 'cal:valid-calendar-object-resource') });
        let lines = unfoldedLines(body);
        const zeroLengthDate = comps(parsed, 'VEVENT').some((e) => {
            const start = prop(e, 'DTSTART');
            const end = prop(e, 'DTEND');
            return start !== undefined && end !== undefined && pointOf(start)?.kind === 'date' && start.value === end.value;
        });
        if (zeroLengthDate && this.behaviour.dateZeroLength === 'refuse') {
            return refuse();
        }
        if (zeroLengthDate && this.behaviour.dateZeroLength === 'rewrite') {
            lines = lines.map((l) => {
                const match = /^DTEND;VALUE=DATE:(\d{8})$/.exec(l);
                return match?.[1] === undefined ? l : `DTEND;VALUE=DATE:${utc((parseDt(match[1]) ?? 0) + DAY).slice(0, 8)}`;
            });
        }
        if (lines.some((l) => /^RECURRENCE-ID;[^:]*RANGE=/.test(l))) {
            if (this.behaviour.rangeParam === 'refuse') {
                return refuse();
            }
            if (this.behaviour.rangeParam === 'strip') {
                lines = lines.map((l) => (l.startsWith('RECURRENCE-ID;') ? l.replace(/;RANGE=[A-Z]+/, '') : l));
            }
        }
        const unknown = new Set(comps(parsed, 'VTIMEZONE').map((tz) => prop(tz, 'TZID')?.value ?? '').filter((id) => BUILTIN_ZONES[id] === undefined));
        if (unknown.size > 0 && this.behaviour.vtimezonePolicy === 'refuse-unknown') {
            return refuse();
        }
        if (unknown.size > 0 && this.behaviour.vtimezonePolicy === 'strip-unknown') {
            const kept: string[] = [];
            let block: string[] | undefined;
            for (const line of lines) {
                if (line === 'BEGIN:VTIMEZONE') {
                    block = [line];
                } else if (block !== undefined) {
                    block.push(line);
                    if (line === 'END:VTIMEZONE') {
                        const id = block.find((l) => l.startsWith('TZID:'))?.slice(5) ?? '';
                        kept.push(...(unknown.has(id) ? [] : block));
                        block = undefined;
                    }
                } else {
                    kept.push(line);
                }
            }
            lines = kept;
        }
        return { text: `${lines.join('\r\n')}\r\n` };
    }

    private resource(req: FakeRequest, calId: string, name: string): Response {
        const cal = this.calendars.get(calId);
        if (cal === undefined) {
            return new Response('no collection', { status: req.method === 'PUT' ? 409 : 404 });
        }
        const existing = cal.events.get(name);
        const ifMatch = req.headers.get('if-match')?.trim();
        const ifNoneMatch = req.headers.get('if-none-match')?.trim();
        const preconditionFails = (): boolean => {
            if (ifMatch === undefined) {
                return false;
            }
            if (ifMatch === '*') {
                return this.behaviour.ifMatchStar === 'fails' || existing === undefined;
            }
            return existing?.etag !== ifMatch;
        };
        switch (req.method) {
            case 'GET':
                return existing === undefined ? new Response('not found', { status: 404 }) : new Response(existing.ical, { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', etag: existing.etag } });
            case 'PROPFIND':
                return existing === undefined ? new Response('not found', { status: 404 }) : this.propfind(req, [{ href: `${this.homePath}${cal.id}/${name}`, props: (p) => (p === 'getetag' ? existing.etag : undefined) }]);
            case 'DELETE':
                if (existing === undefined) {
                    return new Response(null, { status: 404 });
                }
                if (preconditionFails()) {
                    return new Response(null, { status: 412 });
                }
                cal.events.delete(name);
                cal.rev++;
                cal.tombstones.set(name, cal.rev);
                return new Response(null, { status: 204 });
            case 'PUT': {
                if (!cal.writable) {
                    return errorResponse(403, 'd:need-privileges');
                }
                if (ifNoneMatch === '*' && existing !== undefined) {
                    return new Response(null, { status: 412 });
                }
                if (preconditionFails()) {
                    return new Response(null, { status: 412 });
                }
                const parsed = parseIcal(req.body);
                const components = parsed === undefined ? [] : [...comps(parsed, 'VEVENT'), ...comps(parsed, 'VTODO')];
                const first = components[0];
                const uid = first === undefined ? undefined : prop(first, 'UID')?.value;
                if (parsed === undefined || first === undefined || uid === undefined) {
                    return errorResponse(400, 'cal:valid-calendar-data');
                }
                if (this.behaviour.requireEnd && comps(parsed, 'VEVENT').some((e) => prop(e, 'DTEND') === undefined && prop(e, 'DURATION') === undefined)) {
                    return errorResponse(400, 'cal:valid-calendar-object-resource');
                }
                const clash = this.findUid(uid);
                if (clash !== undefined && (clash.cal !== cal || clash.name !== name) && (this.behaviour.uniqueUidAcrossCalendars || clash.cal === cal)) {
                    return errorResponse(403, 'cal:no-uid-conflict', `<d:href>${this.homePath}${clash.cal.id}/${clash.name}</d:href>`);
                }
                const policy = this.policies(req.body, parsed);
                if ('refuse' in policy) {
                    return policy.refuse;
                }
                const etag = this.nextEtag();
                cal.rev++;
                cal.events.set(name, { ical: this.transform(policy.text), etag, rev: cal.rev });
                cal.tombstones.delete(name);
                const headers: Record<string, string> = this.behaviour.putReturnsEtag ? { etag } : {};
                if (this.behaviour.scheduleStatus !== null && /^ORGANIZER/m.test(req.body)) {
                    headers['schedule-tag'] = `"${this.options.etagPrefix ?? ''}st${this.etagCounter}"`;
                }
                return new Response(null, { status: existing === undefined ? 201 : 204, headers });
            }
            case 'POST':
                return this.attachmentAction(req, cal, name, existing);
            default:
                return new Response(null, { status: 405 });
        }
    }
}

/** Puts a file behind a managed-attachment URL (for events seeded with a managed ATTACH). */
export function seedAttachment(fake: FakeICloud, id: string, text: string, type = 'text/plain'): void {
    fake.blobs.set(id, { text, type });
}

/** Adds a calendar to a fake after construction (same defaults as the constructor). */
export function seedCalendar(fake: FakeICloud, seed: FakeCalendarSeed): void {
    let n = 0;
    fake.calendars.set(seed.id, {
        id: seed.id,
        displayName: seed.displayName,
        kind: seed.kind ?? 'owned',
        components: seed.components ?? ['VEVENT'],
        writable: seed.writable ?? true,
        color: seed.color ?? '#000000FF',
        events: new Map((seed.events ?? []).map((e) => [e.name, { ical: e.ical, etag: `"seeded-${++n}"`, rev: 1 }])),
        tombstones: new Map(),
        rev: 1,
    });
}

/** An event exactly as the probe writes one: UID = resource name stem, probe SUMMARY. */
export function probeStyleEvent(uid: string, start = FAKE_NOW + 10 * DAY): FakeEventSeed {
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fake Inc.//Fake Calendar Server//EN', 'BEGIN:VEVENT',
        `UID:${uid}`, `DTSTAMP:${utc(FAKE_NOW)}`, `DTSTART:${utc(start)}`, `DTEND:${utc(start + 3_600_000)}`,
        'SUMMARY:caldav-mcp probe event', 'END:VEVENT', 'END:VCALENDAR',
    ];
    return { name: `${uid}.ics`, ical: `${lines.join('\r\n')}\r\n` };
}

/** Synthetic event text for seeding. */
export function seedEvent(options: { uid: string; summary: string; start: number; durationMinutes?: number; rrule?: string; description?: string; location?: string; attendee?: string; attach?: string[] }): string {
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//seed//EN', 'BEGIN:VEVENT',
        `UID:${options.uid}`, `DTSTAMP:${utc(FAKE_NOW - DAY)}`, `DTSTART:${utc(options.start)}`,
        `DTEND:${utc(options.start + (options.durationMinutes ?? 60) * 60_000)}`, `SUMMARY:${options.summary}`,
    ];
    if (options.rrule !== undefined) {
        lines.push(`RRULE:${options.rrule}`);
    }
    if (options.description !== undefined) {
        lines.push(`DESCRIPTION:${options.description}`);
    }
    if (options.location !== undefined) {
        lines.push(`LOCATION:${options.location}`);
    }
    if (options.attendee !== undefined) {
        lines.push(`ORGANIZER:mailto:${options.attendee}`, `ATTENDEE;CN=${options.attendee}:mailto:${options.attendee}`);
    }
    lines.push(...(options.attach ?? []));
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
}

export interface Canaries {
    appleId: string;
    appPassword: string;
    dsid: string;
    calendarName: string;
    calendarId: string;
    summary: string;
    description: string;
    location: string;
    uid: string;
    etagPrefix: string;
    tokenPrefix: string;
    attendee: string;
    principalName: string;
    address: string;
}

export const PLAIN: Canaries = {
    appleId: 'person@example.invalid',
    appPassword: 'abcd-efgh-ijkl-mnop',
    dsid: '10000000001',
    calendarName: 'Home',
    calendarId: 'home',
    summary: 'Dentist',
    description: 'Bring forms',
    location: 'Main Street',
    uid: 'seed-uid',
    etagPrefix: 'etag',
    tokenPrefix: 'sync-',
    attendee: 'friend@example.invalid',
    principalName: 'Person Example',
    address: 'person.alias@example.invalid',
};

/** A realistic account: owned, shared, subscribed and task-only calendars, with recurring events in the window. */
export function standardAccount(c: Canaries = PLAIN, behaviour: Partial<FakeBehaviour> = {}): FakeICloud {
    const at = (days: number, hour = 15): number => Date.UTC(2026, 10, 11 + days, hour);
    return new FakeICloud({
        appleId: c.appleId,
        appPassword: c.appPassword,
        dsid: c.dsid,
        principalName: c.principalName,
        addresses: [`mailto:${c.appleId}`, `mailto:${c.address}`, `https://p42-caldav.icloud.com:443/${c.dsid}/principal/`],
        etagPrefix: c.etagPrefix,
        tokenPrefix: c.tokenPrefix,
        behaviour,
        calendars: [
            {
                id: c.calendarId,
                displayName: c.calendarName,
                events: [
                    { name: `${c.uid}-1.ics`, ical: seedEvent({ uid: `${c.uid}-1`, summary: `${c.summary} checkup`, start: at(2), description: c.description, location: c.location, attendee: c.attendee }) },
                    { name: `${c.uid}-2.ics`, ical: seedEvent({ uid: `${c.uid}-2`, summary: 'Team lunch', start: at(-3, 12) }) },
                    { name: `${c.uid}-3.ics`, ical: seedEvent({ uid: `${c.uid}-3`, summary: 'Lunch with Sam', start: at(5, 12) }) },
                    { name: `${c.uid}-4.ics`, ical: seedEvent({ uid: `${c.uid}-4`, summary: 'Gym session', start: at(-20, 7), rrule: 'FREQ=WEEKLY;COUNT=20' }) },
                    { name: `${c.uid}-5.ics`, ical: seedEvent({ uid: `${c.uid}-5`, summary: 'Old trip', start: at(-400) }) },
                ],
            },
            { id: `${c.calendarId}-work`, displayName: `${c.calendarName} Work`, components: ['VEVENT', 'VTODO'], events: [{ name: `${c.uid}-6.ics`, ical: seedEvent({ uid: `${c.uid}-6`, summary: 'Standup', start: at(1, 9) }) }] },
            { id: `${c.calendarId}-tasks`, displayName: `${c.calendarName} Tasks`, components: ['VTODO'] },
            { id: `${c.calendarId}-shared-in`, displayName: `${c.calendarName} Family`, kind: 'shared', writable: false },
            { id: `${c.calendarId}-shared-out`, displayName: `${c.calendarName} Shared`, kind: 'shared-owner' },
            { id: `${c.calendarId}-subscribed`, displayName: `${c.calendarName} Holidays`, kind: 'subscribed' },
        ],
    });
}
