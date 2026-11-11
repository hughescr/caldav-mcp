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
import { CalDavError, type CalDavAuth, type CalDavBackend, type CalDavErrorCode, type CalendarSummary, type Discovery } from './contracts';
import { ICLOUD_CALDAV_ROOT, assertAllowedCalDavUrl, createGuardedFetch, isAllowedCalDavUrl, type FetchLike } from './hosts';
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
    if (status === 403 || status === 408 || status === 429 || status >= 500) {
        return 'temporary';
    }
    return 'protocol';
}

/** Throws 'unauthorized' (before any request) for an Apple ID that Basic auth cannot carry. */
function basicAuthorization(auth: CalDavAuth): string {
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

/** null when the entry is not a VEVENT calendar collection. */
function toSummary(response: DavResponse, id: string): CalendarSummary | null {
    const resourcetype = findOkProp(response, DAV_NS, 'resourcetype');
    if (!resourcetype || !resourcetype.children.some((child) => isElement(child, CALDAV_NS, 'calendar'))) {
        return null;
    }
    const componentSet = findOkProp(response, CALDAV_NS, 'supported-calendar-component-set');
    if (!componentSet) {
        return null;
    }
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
function childPath(href: string, home: URL, homePath: string): string {
    let url: URL;
    try {
        url = new URL(href, home);
    } catch {
        return fail('protocol');
    }
    if (!isAllowedCalDavUrl(url) || url.origin !== home.origin || url.search !== '' || url.hash !== '') {
        return fail('protocol');
    }
    if (url.pathname !== home.pathname && !url.pathname.startsWith(homePath)) {
        return fail('protocol');
    }
    return url.pathname;
}

export function createICloudBackend(options: ICloudBackendOptions = {}): CalDavBackend {
    const guardedFetch = createGuardedFetch(options.fetch);

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

    return {
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

        async listCalendars(auth: CalDavAuth, discovery: Discovery): Promise<CalendarSummary[]> {
            const authorization = basicAuthorization(auth);
            const home = assertAllowedCalDavUrl(discovery.calendarHomeUrl);
            const homePath = home.pathname.endsWith('/') ? home.pathname : `${home.pathname}/`;
            const { responses } = await propfind(home, '1', CALENDARS_BODY, authorization);
            const seen = new Set<string>();
            const calendars: CalendarSummary[] = [];
            for (const response of responses) {
                const path = childPath(response.href, home, homePath);
                if (seen.has(path)) {
                    return fail('protocol');
                }
                seen.add(path);
                const isHome = path === home.pathname || path === homePath;
                const failed = response.status !== null && (response.status < 200 || response.status >= 300);
                if (isHome || failed) {
                    continue;
                }
                const summary = toSummary(response, path);
                if (summary) {
                    calendars.push(summary);
                }
            }
            return calendars;
        },
    };
}
