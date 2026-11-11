import { stopOnThrottle, type CheckContext } from './context';
import type { ProbeResponse } from './http';
import { comps, parseIcal, prop, props, textValues, type IcalComponent } from './ical';
import type { Taint } from './safe';
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
    if (options.stopOnThrottle !== false) {
        stopOnThrottle(ctx, res);
    }
    let ms: Multistatus | undefined;
    let errorElements: string[] = [];
    if (res.status === 207) {
        ms = parseMultistatus(res.body);
        taintXml(ms?.root, ctx.taint);
    } else if (/^\s*</.test(res.body)) {
        const root = parseXml(res.body);
        taintXml(root, ctx.taint);
        errorElements = elementNames(root).filter((name) => name !== 'error' && name !== 'href');
    }
    return { res, ms, errorElements };
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

export function calendarQueryBody(options: { start: number; end: number; calendarData: 'full' | 'expand' | 'none'; extraFilter?: string; component?: string }): string {
    const range = `start="${calDavUtc(options.start)}" end="${calDavUtc(options.end)}"`;
    const data = options.calendarData === 'full'
        ? '<C:calendar-data/>'
        : options.calendarData === 'expand'
            ? `<C:calendar-data><C:expand ${range}/></C:calendar-data>`
            : '';
    return xmlDoc(`<C:calendar-query ${NS}><D:prop><D:getetag/>${data}</D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${options.component ?? 'VEVENT'}"><C:time-range ${range}/>${options.extraFilter ?? ''}</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`);
}

/** GET one resource; returns the parsed (and tainted) calendar. */
export async function getIcal(ctx: CheckContext, url: string, essential = false): Promise<{ status: number; etag: string | null; ical: IcalComponent | undefined; headerNames: string[] }> {
    const res = await ctx.http.request({ method: 'GET', url, essential });
    stopOnThrottle(ctx, res);
    const headerNames: string[] = [];
    res.headers.forEach((_value, name) => {
        headerNames.push(name.toLowerCase());
    });
    return {
        status: res.status,
        etag: res.headers.get('etag'),
        ical: res.status === 200 ? taintIcalText(res.body, ctx.taint) : undefined,
        headerNames,
    };
}
