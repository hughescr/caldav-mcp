/**
 * Read-only attachment evidence. `attachment-census` works on the responses the strictness
 * census already fetched (no request of its own) and records counts and members of fixed enums.
 * `attachment-fetch` sends at most 2 GETs for one managed attachment, and only when its URL is on
 * a host the probe's guard allows; it records status codes, header presence and booleans, never a
 * body, name or URL. An attachment URL on any other host is classified and not requested.
 */
import { classifyUrl, isFetchable, tallyEvidence, typeClass, type HostClass, type SchemeClass } from '../attachments';
import { isRefusal, stopOnThrottle, type CheckContext, type CheckDef } from '../context';
import { absolute } from '../dav';
import type { ProbeResponse } from '../http';
import { fixed, prose } from '../safe';
import type { Evidence } from '../types';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Enough to compare a few bytes; an attachment whose server ignores Range is cut here, never read whole. */
export const ATTACHMENT_READ_LIMIT = 65_536;

export interface Fetched {
    /** Status of the first response. */
    status: number;
    redirected: boolean;
    redirectHostClass: HostClass | null;
    redirectSchemeClass: SchemeClass | null;
    /** The redirect target passed the host guard and was requested (once). */
    redirectFollowed: boolean;
    /** The last response received (the first one unless a redirect was followed). */
    final: ProbeResponse;
    requests: number;
}

/**
 * GET of an attachment URL the host guard allows. A redirect is classified (host and scheme class
 * only) and followed at most once, and only when its target also passes the guard. A 401 latches
 * the run like any other 401 (nothing more is sent but the removal of the temporary calendars).
 */
export async function fetchAttachment(ctx: CheckContext, url: string, range?: string): Promise<Fetched> {
    const send = async (target: string): Promise<ProbeResponse> => {
        const res = await ctx.http.request({
            method: 'GET', url: target, ...(range === undefined ? {} : { headers: { range } }),
            followRedirects: false, maxBytes: ATTACHMENT_READ_LIMIT,
        });
        stopOnThrottle(ctx, res);
        return res;
    };
    const first = await send(url);
    const location = first.headers.get('location');
    if (!REDIRECT_STATUSES.has(first.status) || location === null) {
        return { status: first.status, redirected: false, redirectHostClass: null, redirectSchemeClass: null, redirectFollowed: false, final: first, requests: 1 };
    }
    const target = absolute(location, url);
    const classes = target === undefined ? { scheme: 'other' as const, host: 'unparseable' as const } : classifyUrl(target);
    const base = { status: first.status, redirected: true, redirectHostClass: classes.host, redirectSchemeClass: classes.scheme };
    if (target === undefined || !isFetchable(target)) {
        return { ...base, redirectFollowed: false, final: first, requests: 1 };
    }
    return { ...base, redirectFollowed: true, final: await send(target), requests: 2 };
}

const NONE = fixed('none');

/** The recorded form of a fetch: statuses, redirect classes, header presence, content-type class. */
export function describeFetch(prefix: string, got: Fetched): Evidence {
    const h = got.final.headers;
    const key = (name: string): string => (prefix === '' ? name : `${prefix}${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`);
    return {
        [key('status')]: got.status,
        [key('redirected')]: got.redirected,
        [key('redirectHostClass')]: got.redirectHostClass === null ? NONE : fixed(got.redirectHostClass),
        [key('redirectSchemeClass')]: got.redirectSchemeClass === null ? NONE : fixed(got.redirectSchemeClass),
        [key('redirectFollowed')]: got.redirectFollowed,
        [key('finalStatus')]: got.final.status,
        [key('contentLengthPresent')]: h.has('content-length'),
        [key('contentRangePresent')]: h.has('content-range'),
        [key('acceptRangesPresent')]: h.has('accept-ranges'),
        [key('contentTypeClass')]: fixed(typeClass(h.get('content-type'))),
    };
}

/** Total size of the file from Content-Range (206) or Content-Length / the body (200), when the answer states it. */
export function totalSize(res: ProbeResponse): number | null {
    const range = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(res.headers.get('content-range')?.trim() ?? '');
    if (res.status === 206) {
        return range?.[1] === undefined ? null : Number(range[1]);
    }
    if (res.status !== 200) {
        return null;
    }
    const length = res.headers.get('content-length')?.trim() ?? '';
    if (/^\d{1,15}$/.test(length)) {
        return Number(length);
    }
    return res.truncated ? null : Buffer.byteLength(res.body, 'utf8');
}

export const attachmentCensusCheck: CheckDef = {
    id: 'attachment-census',
    planItem: 'Phase 2 read path: how attachments appear in real events (inline, managed or plain URI; where managed ones are hosted)',
    claim: 'Every ATTACH property in a wide unexpanded query is a managed attachment (a URI with MANAGED-ID) whose URL is on caldav.icloud.com or a pNN-caldav.icloud.com host.',
    needs: 'calendars',
    offline: true,
    async run(ctx: CheckContext) {
        const state = ctx.state.attachments;
        if (state === undefined) {
            return { outcome: 'inconclusive', summary: prose`The wide query of the strictness census did not run, so there is nothing to count.`, evidence: { censusRead: false } };
        }
        const t = state.tally;
        const evidence: Evidence = {
            censusRead: true,
            wideWindowDays: ctx.limits.wideWindowDays * 2,
            calendarsQueried: state.calendarsQueried,
            calendarsRead: state.calendarsRead,
            calendarsOverBodyCap: state.calendarsOverBodyCap,
            coverageComplete: state.coverageComplete,
            stoppedEarly: state.stoppedEarly,
            ...tallyEvidence(t),
        };
        if (t.resources === 0 || state.stoppedEarly) {
            return { outcome: 'inconclusive', summary: prose`${t.resources} resource(s) were read from ${state.calendarsRead} of ${state.calendarsQueried} calendar(s); nothing can be concluded.`, evidence };
        }
        if (t.attachProperties === 0) {
            return { outcome: 'inconclusive', summary: prose`None of the ${t.vevents} event(s) in ${t.resources} resource(s) has an ATTACH property, so there is nothing to classify.`, evidence };
        }
        if (t.managedFetchable === t.attachProperties) {
            if (!state.coverageComplete) {
                return { outcome: 'inconclusive', summary: prose`All ${t.attachProperties} ATTACH propert(ies) found are managed attachments on hosts the probe may contact, but coverage of the ${state.calendarsQueried} calendar(s) was incomplete.`, evidence };
            }
            return { outcome: 'confirmed', summary: prose`All ${t.attachProperties} ATTACH propert(ies) in ${t.veventsWithAttach} event(s) are managed attachments on hosts the probe may contact.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`${t.attachProperties} ATTACH propert(ies) in ${t.veventsWithAttach} event(s); managed attachments on hosts the probe may contact: ${t.managedFetchable}.`, evidence };
    },
};

export const attachmentFetchCheck: CheckDef = {
    id: 'attachment-fetch',
    planItem: 'Phase 2 read path: whether a managed attachment can be fetched with the account credentials',
    claim: 'A managed attachment whose URL is on caldav.icloud.com or a pNN-caldav.icloud.com host can be fetched with the account’s HTTP Basic credentials (HTTP 200, or 206 for a one-byte Range request).',
    needs: 'calendars',
    async run(ctx: CheckContext) {
        const state = ctx.state.attachments;
        if (state?.candidate === undefined) {
            const managedFound = state?.tally.forms['uri-managed'] ?? 0;
            return {
                outcome: 'inconclusive',
                summary: managedFound > 0
                    ? prose`The managed attachments found are on hosts the probe may not contact, so none was requested.`
                    : prose`No managed attachment was found in the wide query, so none was requested.`,
                evidence: { reason: fixed(managedFound > 0 ? 'host-not-allowed' : 'none-found'), managedAttachmentsFound: managedFound, requests: 0 },
            };
        }
        const { candidate } = state;
        const got = await fetchAttachment(ctx, candidate.url, 'bytes=0-0');
        const total = totalSize(got.final);
        const evidence: Evidence = {
            requests: got.requests,
            ...describeFetch('', got),
            declaredSizePresent: candidate.declaredSize !== null,
            sizeMatchesDeclared: total === null || candidate.declaredSize === null ? null : total === candidate.declaredSize,
            bodyTruncated: got.final.truncated,
        };
        const status = got.final.status;
        if (status === 200 || status === 206) {
            return { outcome: 'confirmed', summary: prose`The attachment answered HTTP ${status} to a one-byte Range request.`, evidence };
        }
        if (got.redirected && !got.redirectFollowed) {
            return { outcome: 'inconclusive', summary: prose`The attachment URL redirected (HTTP ${got.status}) to a host the probe may not contact, so it was not followed.`, evidence };
        }
        if (isRefusal(status)) {
            return { outcome: 'refuted', summary: prose`The attachment answered HTTP ${status}.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The attachment answered HTTP ${status}.`, evidence };
    },
};
