import { classifyHost, typeClass } from '../attachments';
import type { CheckContext } from '../context';
import { isAttachmentDestination, ProbeHttpError, type AttachmentStep, type ProbeResponse } from '../http';
import { AuthoredValue, fixed, type Safe } from '../safe';
import type { Evidence, Outcome } from '../types';

/** Only called after the synthetic event and uploaded ATTACH have passed provenance checks. */
function maskedHost(host: string): AuthoredValue | undefined {
    // Lower-case DNS labels, starting with a letter, no punycode, total at most 64 characters.
    if (host.length > 64 || !/^(?:[a-z](?:[a-z0-9-]*[a-z0-9])?\.)+icloud\.com$/.test(host) || host.split('.').some((label) => label.startsWith('xn--'))) {
        return undefined;
    }
    return new AuthoredValue(fixed(host.replace(/\d+/g, 'N')));
}

const LITERALS = new Set(['attachment', 'attachments', 'calendars']);
const QUERY_NAMES = new Set(['action', 'managed-id', 'token', 'download']);

function segmentClass(segment: string): Safe {
    if (LITERALS.has(segment)) { return fixed(`literal:${segment}`); }
    if (/^\d+$/.test(segment)) { return fixed('digits'); }
    if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(segment)) { return fixed('uuid'); }
    if (/^[a-f0-9]+$/i.test(segment)) { return fixed('hex'); }
    if (/^[a-z0-9_-]+\.[a-z0-9]{1,8}$/i.test(segment)) { return fixed('filename'); }
    return fixed('other');
}

/** Reduces a verified probe-authored ATTACH to shape only; no URL, identifier or query value. */
export function managedUrlShape(value: string, managedId: string, home: string | undefined): Evidence {
    const url = new URL(value);
    const segments = url.pathname.split('/').slice(1);
    if (segments.at(-1) === '') { segments.pop(); }
    const principal = home === undefined ? undefined : /^\/(\d+)\/calendars\//.exec(new URL(home).pathname)?.[1];
    const decode = (text: string): string => { try { return decodeURIComponent(text); } catch { return text; } };
    const path = decode(url.pathname);
    const query = decode(url.search);
    const host = maskedHost(url.hostname);
    return {
        ...(host === undefined ? {} : { urlHostMasked: host }),
        pathSegmentCount: segments.length, pathSegmentClasses: segments.map(segmentClass),
        managedIdInPath: path.includes(managedId), managedIdInQuery: query.includes(managedId),
        principalIdPresent: principal !== undefined && (path.includes(principal) || query.includes(principal)),
        queryPresent: url.search !== '',
        queryParameterNames: [...new Set([...url.searchParams.keys()].map((name) => QUERY_NAMES.has(name) ? name : 'other'))].sort().map(fixed),
    };
}

/** Challenge schemes only: quoted values and auth-param tokens are never emitted. */
function authSchemes(header: string | null): Safe[] {
    const allowed = new Set(['basic', 'bearer', 'digest', 'x-mobileme-authtoken']);
    const unquoted = (header ?? '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const schemes = unquoted.split(',').flatMap((part) => {
        const match = /^\s*([!#$%&'*+.^_`|~a-z0-9-]+)(?:\s+[^=\s]|\s*$)/i.exec(part);
        const token = match?.[1]?.toLowerCase();
        return token === undefined ? [] : [allowed.has(token) ? token : 'other'];
    });
    return [...new Set(schemes)].sort().map(fixed);
}

function locationOf(response: ProbeResponse): string | undefined {
    if (response.status < 300 || response.status >= 400 || !response.headers.has('location')) { return undefined; }
    try { return new URL(response.headers.get('location') ?? '', response.url).href; } catch { return undefined; }
}

function describe(step: AttachmentStep, res: ProbeResponse, uploaded: string): Evidence {
    const rawLength = res.headers.get('content-length');
    const length = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    const evidence: Evidence = {
        [`${step}Status`]: res.status,
        [`${step}ContentLengthPresent`]: res.headers.has('content-length'),
        [`${step}ContentRangePresent`]: res.headers.has('content-range'),
        [`${step}ContentLengthEqualsUploaded`]: length === null ? null : length === Buffer.byteLength(uploaded),
        [`${step}ContentTypeClass`]: fixed(typeClass(res.headers.get('content-type'))),
        [`${step}BodyEqualsUploaded`]: !res.truncated && res.body === uploaded,
        [`${step}BodyTruncated`]: res.truncated,
        [`${step}AuthSchemes`]: authSchemes(res.headers.get('www-authenticate')),
    };
    if (res.status >= 300 && res.status < 400) {
        const location = locationOf(res);
        const host = location === undefined ? undefined : new URL(location).hostname;
        const masked = host === undefined ? undefined : maskedHost(host);
        Object.assign(evidence, {
            [`${step}LocationHostClass`]: fixed(classifyHost(host ?? '')),
            [`${step}LocationSameHost`]: host === undefined ? null : host === new URL(res.url).hostname,
            ...(masked === undefined ? {} : { [`${step}LocationHostMasked`]: masked }),
        });
    }
    return evidence;
}

/** Ordered, bounded experiment; authorization is only attempted after an anonymous challenge. */
export async function downloadManaged(ctx: CheckContext, value: string, uploaded: string, evidence: Evidence): Promise<Outcome> {
    Object.assign(evidence, { matchedAnonymous: false, matchedAuthenticated: false, matchedRedirect: false });
    if (!isAttachmentDestination(value)) {
        evidence.fetchSkipReason = fixed('host-not-allowed');
        return 'inconclusive';
    }
    let matched = false;
    const get = async (step: AttachmentStep, url: string): Promise<ProbeResponse> => {
        const result = await ctx.http.attachmentDownload(value, url, step);
        Object.assign(evidence, describe(step, result, uploaded));
        const equal = !result.truncated && result.body === uploaded;
        evidence[`matched${step[0]?.toUpperCase()}${step.slice(1)}`] = equal;
        matched ||= equal;
        return result;
    };
    try {
        let response = await get('anonymous', value);
        if ([401, 403].includes(response.status)) { response = await get('authenticated', value); }
        if (response.status >= 300 && response.status < 400) {
            const location = locationOf(response);
            if (location === undefined || !isAttachmentDestination(location, true)) {
                evidence.redirectSkipped = true;
                return matched ? 'confirmed' : 'inconclusive';
            }
            await get('redirect', location);
        }
        return matched ? 'confirmed' : 'refuted';
    } catch (error) {
        evidence.downloadError = fixed(error instanceof ProbeHttpError ? error.code : 'network');
        return matched ? 'confirmed' : 'inconclusive';
    }
}
