/**
 * An in-memory imitation of iCloud's CalDAV server, used as the `fetch` for probe tests.
 * Its behaviour on every point the probe measures is configurable, so each check can be
 * driven to `confirmed`, `refuted` and `inconclusive`. All data is synthetic.
 */
import { comps, parseIcal, prop, props, type IcalComponent } from '../../../scripts/probe/ical';
import { child, childrenNamed, descendants, escapeXml, parseXml, type XmlNode } from '../../../scripts/probe/xml';

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
};

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

function parseDt(value: string | undefined): number | undefined {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value ?? '');
    if (match === null) {
        return undefined;
    }
    const [, y, mo, d, h, mi, s] = match;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
}

function utc(ms: number): string {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function durationMs(value: string | undefined): number | undefined {
    const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value ?? '');
    if (match === null) {
        return undefined;
    }
    const [, w, d, h, m, s] = match.map((x) => Number(x ?? 0));
    return ((((w ?? 0) * 7 + (d ?? 0)) * 24 + (h ?? 0)) * 60 + (m ?? 0)) * 60_000 + (s ?? 0) * 1000;
}

interface Occurrence { start: number; end: number; recurrenceId: number | null; component: IcalComponent }

function bounds(event: IcalComponent): { start: number; end: number } | undefined {
    const startProp = prop(event, 'DTSTART');
    const start = parseDt(startProp?.value);
    if (start === undefined) {
        return undefined;
    }
    const isDate = startProp?.params.VALUE === 'DATE' || /^\d{8}$/.test(startProp?.value ?? '');
    const end = parseDt(prop(event, 'DTEND')?.value) ?? (start + (durationMs(prop(event, 'DURATION')?.value) ?? (isDate ? DAY : 0)));
    return { start, end };
}

function occurrences(resource: IcalComponent, limitEnd: number): Occurrence[] {
    const events = [...comps(resource, 'VEVENT'), ...comps(resource, 'VTODO')];
    const master = events.find((e) => prop(e, 'RECURRENCE-ID') === undefined);
    const overrides = events.filter((e) => prop(e, 'RECURRENCE-ID') !== undefined);
    const result: Occurrence[] = [];
    const overridden = new Set(overrides.map((o) => parseDt(prop(o, 'RECURRENCE-ID')?.value)));
    if (master !== undefined) {
        const b = bounds(master);
        const rule = prop(master, 'RRULE')?.value;
        if (b !== undefined) {
            if (rule === undefined) {
                result.push({ start: b.start, end: b.end, recurrenceId: null, component: master });
            } else {
                const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=') as [string, string]));
                const step = (parts.FREQ === 'DAILY' ? DAY : 7 * DAY) * Number(parts.INTERVAL ?? 1);
                const count = parts.COUNT === undefined ? Infinity : Number(parts.COUNT);
                const until = parseDt(parts.UNTIL) ?? Infinity;
                const exdates = new Set(props(master, 'EXDATE').flatMap((p) => p.value.split(',')).map((v) => parseDt(v)));
                for (let i = 0, start = b.start; i < count && start <= until && start < limitEnd && i < 2000; i++, start += step) {
                    if (exdates.has(start) || overridden.has(start)) {
                        continue;
                    }
                    result.push({ start, end: start + (b.end - b.start), recurrenceId: start, component: master });
                }
            }
        }
    }
    for (const o of overrides) {
        const b = bounds(o);
        if (b !== undefined) {
            result.push({ start: b.start, end: b.end, recurrenceId: parseDt(prop(o, 'RECURRENCE-ID')?.value) ?? null, component: o });
        }
    }
    return result;
}

function overlaps(o: { start: number; end: number }, start: number, end: number): boolean {
    return o.end > o.start ? o.start < end && o.end > start : o.start >= start && o.start < end;
}

function unfoldedLines(ical: string): string[] {
    return ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '');
}

function expandResource(ical: string, start: number, end: number): string {
    const root = parseIcal(ical);
    if (root === undefined) {
        return ical;
    }
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fake//EN'];
    const recurring = comps(root, 'VEVENT').some((e) => prop(e, 'RRULE') !== undefined);
    for (const occ of occurrences(root, end)) {
        if (!overlaps(occ, start, end)) {
            continue;
        }
        lines.push('BEGIN:VEVENT');
        for (const p of occ.component.properties) {
            if (['RRULE', 'EXDATE', 'RDATE', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID'].includes(p.name)) {
                continue;
            }
            lines.push(`${p.name}${Object.entries(p.params).map(([k, v]) => `;${k}=${v}`).join('')}:${p.value}`);
        }
        if (recurring && occ.recurrenceId !== null) {
            lines.push(`RECURRENCE-ID:${utc(occ.recurrenceId)}`);
        }
        lines.push(`DTSTART:${utc(occ.start)}`, `DTEND:${utc(occ.end)}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
}

export class FakeICloud {
    readonly requests: FakeRequest[] = [];
    readonly calendars = new Map<string, FakeCalendar>();
    readonly behaviour: FakeBehaviour;
    readonly host: string;
    private etagCounter = 0;
    private principalCalls = 0;

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
        if (fake.headers.get('authorization') !== expected) {
            return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic realm="fake"' } });
        }
        try {
            return this.route(fake);
        } catch {
            return new Response('fake server error', { status: 500 });
        }
    };

    private route(req: FakeRequest): Response {
        const host = req.url.hostname;
        const path = decodeURIComponent(req.url.pathname);
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
            this.calendars.set(calId, { id: calId, displayName, kind: 'owned', components: components.length > 0 ? components : ['VEVENT'], writable: true, color: '#000000FF', events: new Map(), tombstones: new Map(), rev: 1 });
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

    private eventEntry(cal: FakeCalendar, name: string, event: FakeEvent, propNode: XmlNode | undefined, expandRange?: { start: number; end: number }): string {
        const found = new Map<string, string>();
        const missing: string[] = [];
        for (const p of propNode?.children ?? []) {
            if (p.name === 'getetag') {
                found.set('getetag', escapeXml(event.etag));
            } else if (p.name === 'calendar-data') {
                const ical = expandRange === undefined ? event.ical : expandResource(event.ical, expandRange.start, expandRange.end);
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
            return multistatus(childrenNamed(root, 'href').map((h) => {
                const href = h.text.trim();
                const name = href.split('/').at(-1) ?? '';
                const event = href.startsWith(`${this.homePath}${cal.id}/`) ? cal.events.get(name) : undefined;
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
        const out: string[] = [];
        for (const [name, event] of cal.events) {
            const parsed = parseIcal(event.ical);
            if (parsed === undefined || comps(parsed, compName).length === 0) {
                continue;
            }
            if (range !== undefined && this.behaviour.timeRange && !occurrences(parsed, rangeEnd).some((o) => overlaps(o, rangeStart, rangeEnd))) {
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
            out.push(this.eventEntry(cal, name, event, propNode, expandRange));
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
                const etag = this.nextEtag();
                cal.rev++;
                cal.events.set(name, { ical: this.transform(req.body), etag, rev: cal.rev });
                cal.tombstones.delete(name);
                const headers: Record<string, string> = this.behaviour.putReturnsEtag ? { etag } : {};
                if (this.behaviour.scheduleStatus !== null && /^ORGANIZER/m.test(req.body)) {
                    headers['schedule-tag'] = `"${this.options.etagPrefix ?? ''}st${this.etagCounter}"`;
                }
                return new Response(null, { status: existing === undefined ? 201 : 204, headers });
            }
            default:
                return new Response(null, { status: 405 });
        }
    }
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
export function seedEvent(options: { uid: string; summary: string; start: number; durationMinutes?: number; rrule?: string; description?: string; location?: string; attendee?: string }): string {
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
