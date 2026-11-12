import { CheckStop, stopOnThrottle, type CheckContext, type RefusalShape } from './context';
import type { ProbeResponse } from './http';
import { comps, parseIcal, prop, props, textValues, type IcalComponent } from './ical';
import { prose, type Taint } from './safe';
import { descendants, elementNames, parseMultistatus, parseXml, type Multistatus, type XmlNode } from './xml';

export const NS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"';

export function xmlDoc(inner: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>\n${inner}`;
}

export function propfindBody(props: readonly string[]): string {
    return xmlDoc(`<D:propfind ${NS}><D:prop>${props.map((p) => `<${p}/>`).join('')}</D:prop></D:propfind>`);
}

/** Element text that is user data or an identifier. */
const TAINTED_ELEMENTS = new Set(['displayname', 'getetag', 'getctag', 'sync-token', 'calendar-description', 'calendar-color', 'calendar-timezone', 'shared-url', 'first-name', 'last-name', 'common-name', 'email-address']);

/** Adds every href, name, ETag, token and event text in a parsed XML tree to the taint set. */
export function taintXml(root: XmlNode | undefined, taint: Taint): void {
    if (root === undefined) {
        return;
    }
    const walk = (node: XmlNode): void => {
        if (node.name === 'href') {
            taint.addHref(node.text.trim());
            taint.add(node.text.trim().replace(/^mailto:/i, ''));
        } else if (node.name === 'calendar-data') {
            taintIcalText(node.text, taint);
        } else if (TAINTED_ELEMENTS.has(node.name)) {
            taint.add(node.text);
        }
        // Attribute values (component names, time ranges) are structural and not tainted.
        for (const c of node.children) {
            walk(c);
        }
    };
    walk(root);
}

export function taintIcalText(text: string, taint: Taint): IcalComponent | undefined {
    const parsed = parseIcal(text);
    if (parsed !== undefined) {
        for (const value of textValues(parsed)) {
            taint.add(value);
        }
    }
    return parsed;
}

export interface DavResult {
    res: ProbeResponse;
    ms: Multistatus | undefined;
    /** Element names in a non-multistatus XML body (for example DAV:error preconditions). */
    errorElements: string[];
}

export interface DavOptions {
    depth?: '0' | '1';
    body?: string;
    headers?: Record<string, string>;
    essential?: boolean;
    paced?: boolean;
    /** Default true: a 429/503 ends the check. */
    stopOnThrottle?: boolean;
}

/** One WebDAV request whose response is parsed and tainted. */
export async function dav(ctx: CheckContext, method: string, url: string, options: DavOptions = {}): Promise<DavResult> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.depth !== undefined) {
        headers.depth = options.depth;
    }
    const res = await ctx.http.request({
        method,
        url,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.essential === undefined ? {} : { essential: options.essential }),
        ...(options.paced === undefined ? {} : { paced: options.paced }),
    });
    let ms: Multistatus | undefined;
    let errorElements: string[] = [];
    let rootName: string | undefined;
    if (res.status === 207) {
        ms = parseMultistatus(res.body);
        taintXml(ms?.root, ctx.taint);
    } else if (/^\s*</.test(res.body)) {
        const root = parseXml(res.body);
        taintXml(root, ctx.taint);
        rootName = root?.name;
        errorElements = elementNames(root).filter((name) => name !== 'error' && name !== 'href');
    }
    if (WRITE_METHODS.has(method) && res.status >= 400) {
        recordRefusal(ctx, method, res, rootName, errorElements);
    }
    // After the body is parsed and tainted, and the refusal recorded (429 and 503 included).
    if (options.stopOnThrottle !== false) {
        stopOnThrottle(ctx, res);
    }
    return { res, ms, errorElements };
}

/** Records the shape of a refused write's body for `write-error-bodies` (names are reduced when reported). */
export function recordRefusal(ctx: CheckContext, method: string, res: ProbeResponse, rootName: string | undefined, elements: string[]): void {
    ctx.state.refusals.push({ method, status: res.status, contentType: contentTypeClass(res.headers.get('content-type')), bytes: Buffer.byteLength(res.body), root: rootName, elements });
}

const WRITE_METHODS = new Set(['PUT', 'DELETE', 'MKCALENDAR', 'POST']);

/** The class of a Content-Type header; the header itself is never recorded. */
export function contentTypeClass(header: string | null): RefusalShape['contentType'] {
    if (header === null || header.trim() === '') {
        return 'none';
    }
    const type = header.split(';')[0]?.trim().toLowerCase() ?? '';
    if (type === 'text/xml' || type === 'application/xml' || type.endsWith('+xml')) {
        return 'xml';
    }
    return ({ 'text/html': 'html', 'text/plain': 'plain', 'text/calendar': 'calendar', 'application/json': 'json' } as const)[type] ?? 'other';
}

export function absolute(href: string, base: string): string | undefined {
    try {
        return new URL(href, base).href;
    } catch {
        return undefined;
    }
}

export function hrefsIn(node: XmlNode | undefined): string[] {
    return descendants(node, 'href').map((h) => h.text.trim()).filter((h) => h !== '');
}

/** UTC timestamp in the CalDAV time-range format. */
export function calDavUtc(ms: number): string {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function eventComponents(cal: IcalComponent | undefined): IcalComponent[] {
    return cal === undefined ? [] : comps(cal, 'VEVENT');
}

export function isRecurring(cal: IcalComponent | undefined): boolean {
    return eventComponents(cal).some((e) => prop(e, 'RRULE') !== undefined || props(e, 'RDATE').length > 0);
}

export function calendarQueryBody(options: { start: number; end: number; calendarData: 'full' | 'expand' | 'limit-recurrence-set' | 'none'; extraFilter?: string; component?: string }): string {
    const range = `start="${calDavUtc(options.start)}" end="${calDavUtc(options.end)}"`;
    const data = options.calendarData === 'full'
        ? '<C:calendar-data/>'
        : options.calendarData === 'expand'
            ? `<C:calendar-data><C:expand ${range}/></C:calendar-data>`
            : options.calendarData === 'limit-recurrence-set'
                ? `<C:calendar-data><C:limit-recurrence-set ${range}/></C:calendar-data>`
                : '';
    return xmlDoc(`<C:calendar-query ${NS}><D:prop><D:getetag/>${data}</D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${options.component ?? 'VEVENT'}"><C:time-range ${range}/>${options.extraFilter ?? ''}</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`);
}

/** Fail closed before any synthetic read-back values are described. No rejected values escape. */
export function requireSynthetic(ical: IcalComponent | undefined, finalUrl: string, calendarUrl: string, uid: string, status: number): void {
    const events = eventComponents(ical);
    let confined = false;
    try {
        const target = new URL(finalUrl);
        const calendar = new URL(calendarUrl);
        confined = target.origin === calendar.origin && new URL('.', target).href === calendar.href && target.search === '' && target.hash === '';
    } catch { /* No provenance. */ }
    if (!confined || ical === undefined || events.length === 0 || events.some((e) => props(e, 'UID').length !== 1 || prop(e, 'UID')?.value !== uid)) {
        throw new CheckStop('inconclusive', prose`The read-back resource could not be attributed to the probe's event.`, { status, returnedVevents: events.length, provenanceVerified: false });
    }
}

/** GET one resource; returns the body as received and the parsed (and tainted) calendar. */
export async function getResource(ctx: CheckContext, url: string): Promise<{ status: number; url: string; etag: string | null; body: string; ical: IcalComponent | undefined }> {
    const res = await ctx.http.request({ method: 'GET', url });
    stopOnThrottle(ctx, res);
    return { status: res.status, url: res.url, etag: res.headers.get('etag'), body: res.body, ical: res.status === 200 ? taintIcalText(res.body, ctx.taint) : undefined };
}

/** GET one resource; returns the parsed (and tainted) calendar. */
export async function getIcal(ctx: CheckContext, url: string, essential = false): Promise<{ status: number; url: string; etag: string | null; ical: IcalComponent | undefined; headerNames: string[] }> {
    const res = await ctx.http.request({ method: 'GET', url, essential });
    stopOnThrottle(ctx, res);
    const headerNames: string[] = [];
    res.headers.forEach((_value, name) => {
        headerNames.push(name.toLowerCase());
    });
    return {
        status: res.status,
        url: res.url,
        etag: res.headers.get('etag'),
        ical: res.status === 200 ? taintIcalText(res.body, ctx.taint) : undefined,
        headerNames,
    };
}
