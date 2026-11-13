/**
 * iCloud CalDAV backend: discovery, credential validation and calendar listing.
 *
 * Implemented directly on the guarded fetch with three PROPFINDs rather than through tsdav:
 * tsdav 2.5.0's discovery helpers collapse 403/5xx/parse failures into one generic Error
 * (so 'temporary' and 'protocol' cannot be told apart without matching message text), its
 * XML layer turns parse errors into ok:false results, and fetchCalendars sends an extra
 * supported-report-set PROPFIND per calendar.
 *
 * HTTP Basic auth is sent on every request. The Authorization value exists only inside the
 * outgoing request headers; every failure is a bare CalDavError code.
 */
import { Buffer } from 'node:buffer';
import { MAX_MEMBERSHIP_BYTES, MAX_REPORT_BYTES } from '../calendar/limits';
import { isCanonicalPath } from '../calendar/model';
import { canonicalizeCalendarPath, canonicalizeServerHref, isDirectChildResource } from './identifiers';
import { buildExpandedQuery, buildMultiget, extractEventReport } from './reports';
import type { CalDavReadBackend, CalendarResource, DavCallOptions, ResourceLookup } from './read-contracts';
import { CalDavError, type CalDavAuth, type CalDavBackend, type CalDavErrorCode, type CalendarSummary, type Discovery } from './contracts';
import { ICLOUD_CALDAV_ROOT, assertAllowedCalDavUrl, createGuardedFetch, isAllowedCalDavUrl, type FetchLike } from './hosts';
import { createWriteBackend } from './write';
import type { CalDavWriteBackend } from './write-contracts';
import {
    APPLE_ICAL_NS,
    CALDAV_NS,
    DAV_NS,
    type DavResponse,
    type XmlElement,
    childrenNamed,
    findOkProp,
    hrefText,
    isElement,
    parseMultistatus,
} from './xml';

export interface ICloudBackendOptions {
    /** Transport under the guarded fetch. Defaults to the global fetch, looked up per call. */
    fetch?: FetchLike;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>\n';

const PRINCIPAL_BODY = `${XML_DECLARATION}<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`;

const HOME_SET_BODY = `${XML_DECLARATION}<propfind xmlns="DAV:" xmlns:C="${CALDAV_NS}"><prop><C:calendar-home-set/></prop></propfind>`;

const CALENDARS_BODY = `${XML_DECLARATION}<propfind xmlns="DAV:" xmlns:C="${CALDAV_NS}" xmlns:A="${APPLE_ICAL_NS}">`
    + '<prop><resourcetype/><displayname/><C:supported-calendar-component-set/><A:calendar-color/></prop></propfind>';

/** iCalendar component name (iana-token / x-name). */
const COMPONENT_NAME = /^[A-Za-z0-9-]{1,64}$/;
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function fail(code: CalDavErrorCode): never {
    throw new CalDavError(code);
}

/** Maps a non-success HTTP status. 403 is not treated as bad credentials (unproven on iCloud). */
function codeForStatus(status: number): CalDavErrorCode {
    if (status === 401) {
        return 'unauthorized';
    }
    if (status === 507) {
        return 'too_large';
    }
    if (status === 403 || status === 408 || status === 429 || status >= 500) {
        return 'temporary';
    }
    return 'protocol';
}

/** Throws 'unauthorized' (before any request) for an Apple ID that Basic auth cannot carry. */
export function basicAuthorization(auth: CalDavAuth): string {
    const { appleId, appPassword } = auth;
    if (typeof appleId !== 'string' || typeof appPassword !== 'string'
        || appleId === '' || appleId.includes(':') || CONTROL_CHARS.test(appleId)) {
        return fail('unauthorized');
    }
    return `Basic ${Buffer.from(`${appleId}:${appPassword}`, 'utf8').toString('base64')}`;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeBody(bytes: ArrayBuffer): string {
    try {
        return utf8.decode(bytes);
    } catch {
        return fail('protocol');
    }
}

interface PropfindResult {
    responses: DavResponse[];
    /** Final URL after redirects; relative hrefs resolve against it. */
    url: URL;
}

/** The single DAV:href inside the single 2xx instance of a property across all responses. */
function singlePropertyHref(responses: DavResponse[], ns: string, local: string): string {
    const found = responses.flatMap((response) => {
        const prop = findOkProp(response, ns, local);
        return prop ? [prop] : [];
    });
    const [prop, ...extra] = found;
    if (!prop || extra.length > 0) {
        return fail('protocol');
    }
    const hrefs = childrenNamed(prop, DAV_NS, 'href');
    const [href, ...extraHrefs] = hrefs;
    if (!href || extraHrefs.length > 0) {
        return fail('protocol');
    }
    return hrefText(href);
}

function resolveAllowed(href: string, base: URL): URL {
    let url: URL;
    try {
        url = new URL(href, base);
    } catch {
        return fail('protocol');
    }
    return assertAllowedCalDavUrl(url);
}

/** A simple text property; must not contain elements. Empty text is reported as null. */
function textProperty(element: XmlElement | undefined, trim: boolean): string | null {
    if (!element) {
        return null;
    }
    if (element.children.length > 0) {
        return fail('protocol');
    }
    const text = trim ? element.text.trim() : element.text;
    return text === '' ? null : text;
}

function componentNames(set: XmlElement): string[] {
    const names: string[] = [];
    for (const comp of childrenNamed(set, CALDAV_NS, 'comp')) {
        const name = comp.attributes.get('name');
        if (name === undefined || !COMPONENT_NAME.test(name)) {
            return fail('protocol');
        }
        const upper = name.toUpperCase();
        if (!names.includes(upper)) {
            names.push(upper);
        }
    }
    return names;
}

/** Membership requires affirmative successful evidence; failed instances cannot be hidden by a successful one. */
function membershipProperty(response: DavResponse, ns: string, local: string): XmlElement {
    for (const propstat of response.propstats) {
        if ((propstat.status < 200 || propstat.status >= 300) && propstat.props.some(prop => isElement(prop, ns, local))) { return fail('temporary'); }
    }
    const property = findOkProp(response, ns, local);
    if (!property) { return fail('temporary'); }
    return property;
}

/** null only when successful properties prove the entry is not a VEVENT calendar collection. */
function toSummary(response: DavResponse, id: string): CalendarSummary | null {
    const resourcetype = membershipProperty(response, DAV_NS, 'resourcetype');
    if (!resourcetype.children.some((child) => isElement(child, CALDAV_NS, 'calendar'))) {
        return null;
    }
    const componentSet = membershipProperty(response, CALDAV_NS, 'supported-calendar-component-set');
    const components = componentNames(componentSet);
    if (!components.includes('VEVENT')) {
        return null;
    }
    return {
        id,
        displayName: textProperty(findOkProp(response, DAV_NS, 'displayname'), false),
        components,
        color: textProperty(findOkProp(response, APPLE_ICAL_NS, 'calendar-color'), true),
    };
}

/** Resolves a child href; it must stay on the home's origin, pass the host rule, and sit under the home path. */
function childPath(href: string, finalUrl: URL, home: URL, homePath: string): string {
    const path = canonicalizeServerHref(href, finalUrl.href);
    // canonicalizeServerHref checks the final response origin; it must also be the authenticated home origin.
    if (finalUrl.origin !== home.origin || (path !== homePath.slice(0, -1) && path !== homePath
        && (!path.startsWith(homePath) || !path.endsWith('/') || path.slice(homePath.length, -1).includes('/')))) {
        return fail('protocol');
    }
    return path;
}

/** Creates the phase-1 backend plus the batched event-read and conditional-write capabilities; injected fetch remains probe-compatible. */
export function createICloudBackend(options: ICloudBackendOptions = {}): CalDavBackend & CalDavReadBackend & CalDavWriteBackend {
    const guardedFetch = createGuardedFetch(options.fetch);
    // PUT and DELETE live only in write.ts; this backend just carries them with the same transport and authorization.
    const writer = createWriteBackend({ authorization: basicAuthorization, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });

    function send(url: URL, depth: '0' | '1', body: string, authorization: string): Promise<Response> {
        return guardedFetch(url.href, {
            method: 'PROPFIND',
            headers: {
                authorization,
                depth,
                'content-type': 'application/xml; charset=utf-8',
                accept: 'application/xml, text/xml',
            },
            body,
        });
    }

    async function propfind(url: URL, depth: '0' | '1', body: string, authorization: string): Promise<PropfindResult> {
        const response = await send(url, depth, body, authorization);
        if (response.status !== 207) {
            return fail(codeForStatus(response.status));
        }
        const responses = parseMultistatus(decodeBody(await response.arrayBuffer()));
        return { responses, url: assertAllowedCalDavUrl(response.url) };
    }

    /** Scope is independent of the broad host rule: not even another allowed Apple account may receive a read. */
    function scopeGuard(home: URL, path: string): (url: URL, raw: string) => void {
        return (url, raw) => {
            if (url.origin !== home.origin || canonicalizeServerHref(raw, url.href) !== path
                || canonicalizeServerHref(url.href, home.href) !== path) { fail('protocol'); }
        };
    }

    async function readDav(url: URL, home: URL, method: 'PROPFIND' | 'REPORT', body: string, auth: CalDavAuth, call: DavCallOptions = {}): Promise<Response> {
        if (call.deadlineMs !== undefined && (!Number.isFinite(call.deadlineMs) || call.deadlineMs <= 0)) { return fail('temporary'); }
        const authorization = basicAuthorization(auth);
        const guarded = createGuardedFetch(options.fetch, {
            timeoutMs: Math.min(10_000, call.deadlineMs ?? 10_000),
            maxResponseBytes: method === 'REPORT' ? MAX_REPORT_BYTES : MAX_MEMBERSHIP_BYTES,
            overflowCode: 'too_large',
            ...(call.charge ? { charge: call.charge } : {}),
            preserveMethod: true,
            validateUrl: scopeGuard(home, canonicalizeServerHref(url.href, home.href)),
        });
        return guarded(url.href, {
            method,
            headers: { authorization, depth: '1', 'content-type': 'application/xml; charset=utf-8', accept: 'application/xml, text/xml' },
            body,
            ...(call.signal ? { signal: call.signal } : {}),
        });
    }

    function readTarget(discovery: Discovery, calendarId: string): { home: URL; target: URL } {
        const home = assertAllowedCalDavUrl(discovery.calendarHomeUrl);
        const homePath = canonicalizeServerHref(home.href, home.href).replace(/\/?$/u, '/');
        if (!isCanonicalPath(calendarId) || !calendarId.endsWith('/') || !calendarId.startsWith(homePath)) { return fail('protocol'); }
        const child = calendarId.slice(homePath.length, -1);
        if (child === '' || child.includes('/')) { return fail('protocol'); }
        return { home, target: new URL(calendarId, home) };
    }

    async function eventReport(auth: CalDavAuth, discovery: Discovery, calendarId: string, body: string, call?: DavCallOptions, hrefs?: readonly string[]): Promise<CalendarResource[]> {
        const { home, target } = readTarget(discovery, calendarId);
        if (hrefs?.some((href) => !isDirectChildResource(calendarId, href))) { return fail('protocol'); }
        const response = await readDav(target, home, 'REPORT', body, auth, call);
        if (response.status !== 207) { return fail(response.status === 404 ? 'not_found' : codeForStatus(response.status)); }
        return extractEventReport(decodeBody(await response.arrayBuffer()), {
            calendarId, homeUrl: home.href, requestUrl: response.url,
            ...(hrefs ? { requestedHrefs: hrefs } : {}),
        });
    }

    return {
        putEvent: writer.putEvent,
        deleteEvent: writer.deleteEvent,

        async queryEvents(auth, discovery, query, call): Promise<readonly CalendarResource[]> {
            return eventReport(auth, discovery, query.calendarId, buildExpandedQuery(query.range), call);
        },

        async multigetEvents(auth, discovery, query, call): Promise<readonly ResourceLookup[]> {
            const resources = await eventReport(auth, discovery, query.calendarId, buildMultiget(query.hrefs), call, query.hrefs);
            const byHref = new Map(resources.map((resource) => [resource.href, resource]));
            return query.hrefs.map((href) => {
                const resource = byHref.get(href);
                return resource ? { kind: 'found', resource } : { kind: 'not_found', href };
            });
        },

        async discover(auth: CalDavAuth): Promise<Discovery> {
            const authorization = basicAuthorization(auth);
            const root = await propfind(assertAllowedCalDavUrl(ICLOUD_CALDAV_ROOT), '0', PRINCIPAL_BODY, authorization);
            const principalUrl = resolveAllowed(singlePropertyHref(root.responses, DAV_NS, 'current-user-principal'), root.url);
            const principal = await propfind(principalUrl, '0', HOME_SET_BODY, authorization);
            const calendarHomeUrl = resolveAllowed(singlePropertyHref(principal.responses, CALDAV_NS, 'calendar-home-set'), principal.url);
            return { principalUrl: principalUrl.href, calendarHomeUrl: calendarHomeUrl.href };
        },

        async validate(auth: CalDavAuth, discovery: Discovery): Promise<'valid' | 'expired' | 'temporary'> {
            let authorization: string;
            try {
                authorization = basicAuthorization(auth);
            } catch {
                return 'expired';
            }
            try {
                if (!isAllowedCalDavUrl(discovery.principalUrl)) {
                    return 'temporary';
                }
                const response = await send(assertAllowedCalDavUrl(discovery.principalUrl), '0', PRINCIPAL_BODY, authorization);
                // Only a multistatus answer proves an authenticated PROPFIND; a plain 200 could be anything.
                if (response.status === 207) {
                    return 'valid';
                }
                return response.status === 401 ? 'expired' : 'temporary';
            } catch {
                return 'temporary';
            }
        },

        async listCalendars(auth: CalDavAuth, discovery: Discovery, call?: DavCallOptions): Promise<CalendarSummary[]> {
            const home = assertAllowedCalDavUrl(discovery.calendarHomeUrl);
            const homePath = canonicalizeCalendarPath(home.pathname.endsWith('/') ? home.pathname : `${home.pathname}/`);
            const response = await readDav(home, home, 'PROPFIND', CALENDARS_BODY, auth, call);
            if (response.status !== 207) { return fail(codeForStatus(response.status)); }
            const responses = parseMultistatus(decodeBody(await response.arrayBuffer()), true);
            const finalUrl = assertAllowedCalDavUrl(response.url);
            const seen = new Set<string>();
            const calendars: CalendarSummary[] = [];
            for (const response of responses) {
                const path = childPath(response.href, finalUrl, home, homePath);
                if (seen.has(path)) {
                    return fail('protocol');
                }
                seen.add(path);
                const isHome = path === home.pathname || path === homePath;
                const failed = response.status !== null && (response.status < 200 || response.status >= 300);
                if (isHome) { continue; }
                if (failed) { return fail('temporary'); }
                const summary = toSummary(response, path);
                if (summary) {
                    calendars.push(summary);
                }
            }
            return calendars;
        },
    };
}
