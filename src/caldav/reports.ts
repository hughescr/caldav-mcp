/** REPORT request builders and strict, namespace-aware event response extraction. */
import { MAX_MULTIGET_HREFS, MAX_MULTIGET_XML_BYTES, MAX_REPORT_BYTES, MAX_RESOURCES_PER_REPORT } from '../calendar/limits';
import { isResourceHref } from '../calendar/model';
import { CalDavError } from './contracts';
import { canonicalizeCalendarPath, canonicalizeServerHref, isDirectChildResource, resolveServerResourceHref } from './identifiers';
import type { CalendarResource, QueriedResource, ReadCharge } from './read-contracts';
import { CALDAV_NS, DAV_NS, assertCompleteMultistatus, childrenNamed, isElement, parseXml, type XmlElement } from './xml';

export interface ReportContext {
    /** Canonical selected collection path. */
    calendarId: string;
    /** The actual final response URL; server hrefs resolve against it. */
    requestUrl: string;
    /** The authenticated calendar-home URL, for exact-origin and containment checks. */
    homeUrl: string;
    /** For multiget: exactly the canonical hrefs that were requested. */
    requestedHrefs?: readonly string[];
    /** Streaming byte charging belongs to the dispatcher, not this already-buffered extraction. */
    charge?: ReadCharge;
}

function protocol(): never { throw new CalDavError('protocol'); }
function tooLarge(): never { throw new CalDavError('too_large'); }
const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const NAMESPACES = `xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}"`;
const BASIC_UTC = /^(\d{4})(\d{2})(\d{2})T([01]\d|2[0-3])([0-5]\d)([0-5]\d)Z$/u;

function utcMillis(value: string): number {
    const match = BASIC_UTC.exec(value);
    if (!match) { return protocol(); }
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
    const millis = Date.parse(iso);
    if (!Number.isFinite(millis) || new Date(millis).toISOString() !== iso) { return protocol(); }
    return millis;
}

function escapeXml(value: string): string {
    return value.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? protocol());
}

/** Builds one expanded VEVENT query, with identical expansion and selection bounds in basic UTC seconds. */
export function buildExpandedQuery(range: { startUtc: string; endUtc: string }): string {
    if (utcMillis(range.startUtc) >= utcMillis(range.endUtc)) { return protocol(); }
    const bounds = `start="${range.startUtc}" end="${range.endUtc}"`;
    return `${DECLARATION}<c:calendar-query ${NAMESPACES}><d:prop><d:getetag/><c:calendar-data><c:expand ${bounds}/></c:calendar-data></d:prop>`
        + `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${bounds}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}

/** Builds one unexpanded multiget, rejecting empty, duplicate, invalid or oversized input batches. Hrefs are XML-escaped only. */
export function buildMultiget(hrefs: readonly string[]): string {
    if (hrefs.length === 0 || hrefs.length > MAX_MULTIGET_HREFS || new Set(hrefs).size !== hrefs.length
        || hrefs.some((href) => !isResourceHref(href))) { return protocol(); }
    const xml = `${DECLARATION}<c:calendar-multiget ${NAMESPACES}><d:prop><d:getetag/><c:calendar-data/></d:prop>`
        + hrefs.map((href) => `<d:href>${escapeXml(href)}</d:href>`).join('') + '</c:calendar-multiget>';
    if (Buffer.byteLength(xml, 'utf8') > MAX_MULTIGET_XML_BYTES) { return protocol(); }
    return xml;
}

/** Rejects non-whitespace mixed text and children outside an exact namespace-aware set. */
function structure(element: XmlElement, allowed: readonly [string, string][]): void {
    if (element.text.trim() !== '' || element.attributes.size !== 0
        || element.children.some((child) => !allowed.some(([ns, local]) => isElement(child, ns, local)))) { protocol(); }
    const descriptions = childrenNamed(element, DAV_NS, 'responsedescription');
    if (descriptions.length > 1) { protocol(); }
    if (descriptions[0]) { text(descriptions[0]); }
}
function single(element: XmlElement, ns: string, local: string): XmlElement {
    const children = childrenNamed(element, ns, local);
    return children.length === 1 && children[0] ? children[0] : protocol();
}
function text(element: XmlElement): string {
    if (element.children.length !== 0 || element.attributes.size !== 0) { return protocol(); }
    return element.text;
}
function status(element: XmlElement): number {
    const match = /^HTTP\/\d(?:\.\d)?[ \t]+([1-5]\d{2})(?:[ \t].*)?$/su.exec(text(element).trim());
    return match?.[1] ? Number(match[1]) : protocol();
}
function failStatus(code: number): never {
    if (code === 507) { return tooLarge(); }
    if (code === 401) { throw new CalDavError('unauthorized'); }
    if (code === 403 || code === 408 || code === 429 || code >= 500) { throw new CalDavError('temporary'); }
    if (code === 404) { throw new CalDavError('not_found'); }
    return protocol();
}
function successfulResource(response: XmlElement, href: string): CalendarResource | null {
    structure(response, [[DAV_NS, 'href'], [DAV_NS, 'status'], [DAV_NS, 'propstat'], [DAV_NS, 'error'], [DAV_NS, 'responsedescription']]);
    const statuses = childrenNamed(response, DAV_NS, 'status');
    const propstats = childrenNamed(response, DAV_NS, 'propstat');
    if (statuses.length > 1 || (statuses.length > 0 && propstats.length > 0)) { return protocol(); }
    if (statuses[0]) {
        const code = status(statuses[0]);
        if (code === 404) { return null; }
        return failStatus(code);
    }
    if (propstats.length === 0 || childrenNamed(response, DAV_NS, 'error').length !== 0) { return protocol(); }
    let etag: string | undefined;
    let calendarData: string | undefined;
    const seenProperties = new Set<string>();
    for (const propstat of propstats) {
        structure(propstat, [[DAV_NS, 'prop'], [DAV_NS, 'status'], [DAV_NS, 'responsedescription'], [DAV_NS, 'error']]);
        const code = status(single(propstat, DAV_NS, 'status'));
        const prop = single(propstat, DAV_NS, 'prop');
        structure(prop, [[DAV_NS, 'getetag'], [CALDAV_NS, 'calendar-data']]);
        if (prop.children.length === 0) { return protocol(); }
        for (const property of prop.children) {
            const key = `${property.ns}:${property.local}`;
            if (seenProperties.has(key)) { return protocol(); }
            seenProperties.add(key);
        }
        if (code < 200 || code >= 300) { return failStatus(code); }
        if (childrenNamed(propstat, DAV_NS, 'error').length !== 0) { return protocol(); }
        for (const property of prop.children) {
            if (isElement(property, DAV_NS, 'getetag')) { etag = text(property); }
            else { calendarData = text(property); }
        }
    }
    if (etag === undefined || !/^"[\x21\x23-\x7E]*"$/u.test(etag) || calendarData === undefined) { return protocol(); }
    return { href, etag, calendarData };
}

/**
 * Extracts a complete event REPORT. Every reply (even a failure) must name the selected collection at the authenticated
 * home origin, by an href kept byte for byte, and be unique. Explicit 404s have no resource; multiget still requires
 * their replies, each exactly a requested href. In an expanded query, a well-formed reply whose href is a refused name of
 * this calendar (resolveServerResourceHref `unsupported_name`) becomes one UnaddressableResource entry, in order.
 * @throws {CalDavError} For malformed, incomplete, out-of-scope, partial or over-limit responses.
 */
export function extractEventReport(xml: string, context: ReportContext): QueriedResource[] {
    if (Buffer.byteLength(xml, 'utf8') > MAX_REPORT_BYTES) { return tooLarge(); }
    const calendar = canonicalizeCalendarPath(context.calendarId);
    if (calendar !== context.calendarId) { return protocol(); }
    const home = canonicalizeServerHref(context.homeUrl, context.homeUrl);
    const homePath = home.endsWith('/') ? home : `${home}/`;
    const collectionName = calendar.slice(homePath.length);
    if (!homePath.endsWith('/') || !calendar.startsWith(homePath) || !collectionName.endsWith('/')
        || collectionName.slice(0, -1) === '' || collectionName.slice(0, -1).includes('/')) { return protocol(); }
    // Also validates the actual final response origin; relative hrefs must resolve there, not at the original URL.
    if (canonicalizeServerHref(context.requestUrl, context.homeUrl) !== calendar) { return protocol(); }
    const requested = context.requestedHrefs === undefined ? undefined : new Set(context.requestedHrefs);
    if (requested) {
        if (requested.size !== context.requestedHrefs?.length || requested.size === 0 || requested.size > MAX_MULTIGET_HREFS
            || [...requested].some((href) => !isDirectChildResource(calendar, href))) { return protocol(); }
    }
    const root = parseXml(xml, 'report');
    if (!isElement(root, DAV_NS, 'multistatus')) { return protocol(); }
    assertCompleteMultistatus(root);
    structure(root, [[DAV_NS, 'response'], [DAV_NS, 'responsedescription']]);
    const responses = childrenNamed(root, DAV_NS, 'response');
    if (responses.length > MAX_RESOURCES_PER_REPORT) { return tooLarge(); }
    const seen = new Set<string>();
    const seenUnaddressable = new Set<string>();
    const resources: QueriedResource[] = [];
    for (const response of responses) {
        const raw = text(single(response, DAV_NS, 'href')).trim();
        const resolved = resolveServerResourceHref(raw, context.requestUrl, calendar);
        if (resolved.kind === 'unsupported_name') {
            // Only an expanded query can do without one resource; the same raw href twice cannot be told apart.
            if (requested || seenUnaddressable.has(raw)) { return protocol(); }
            seenUnaddressable.add(raw);
            // The reply must still be well formed and successful: its own failures stay the whole answer's.
            if (successfulResource(response, '') === null) { return failStatus(404); }
            resources.push({ unaddressable: true });
            continue;
        }
        const { href } = resolved;
        if (seen.has(href) || (requested && !requested.has(href))) { return protocol(); }
        seen.add(href);
        const resource = successfulResource(response, href);
        if (resource) { resources.push(resource); }
        else if (!requested) { return failStatus(404); }
    }
    if (requested && seen.size !== requested.size) { return protocol(); }
    return resources;
}
