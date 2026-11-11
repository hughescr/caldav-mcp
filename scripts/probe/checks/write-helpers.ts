import { CheckStop, isOk, isRefusal, type CheckContext, type CheckRecord, type TempCalendar } from '../context';
import { NS, absolute, dav, propfindBody, xmlDoc, type DavResult } from '../dav';
import { directChildOf, probeSegment } from '../http';
import { buildIcal, icalUtc } from '../ical';
import { prose } from '../safe';
import { PROBE_VERSION } from '../version';
import { childrenNamed, okProp } from '../xml';
import type { Evidence, NotDeletedReason, NotDeletedReport } from '../types';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const SUMMARY = 'caldav-mcp probe event';

/** Midnight UTC ten days from now: every synthetic event is placed relative to it. */
export function baseDay(ctx: CheckContext): number {
    const d = new Date(ctx.now());
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 10 * DAY;
}

export function primary(ctx: CheckContext): TempCalendar {
    const temp = ctx.state.primaryTemp;
    if (temp === undefined) {
        throw new CheckStop('skipped', prose`Skipped: the temporary calendar could not be created.`);
    }
    return temp;
}

/** Resource URL and UID for a synthetic event; the suffix is a short lower-case word. */
export function newEvent(temp: TempCalendar, suffix: string): { url: string; uid: string } {
    const uid = `${temp.name}-${suffix}`;
    return { uid, url: `${temp.url}${uid}.ics` };
}

export function probeCalendar(ctx: CheckContext, uid: string, lines: readonly string[], options: { vtimezone?: readonly string[]; overrides?: readonly (readonly string[])[] } = {}): string {
    const stamp = icalUtc(ctx.now());
    const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//caldav-mcp//probe ${PROBE_VERSION}//EN`, 'CALSCALE:GREGORIAN', ...(options.vtimezone ?? [])];
    out.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, ...lines, 'END:VEVENT');
    for (const override of options.overrides ?? []) {
        out.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, ...override, 'END:VEVENT');
    }
    out.push('END:VCALENDAR');
    return buildIcal(out);
}

export function utcSpan(start: number, hours = 1): string[] {
    return [`DTSTART:${icalUtc(start)}`, `DTEND:${icalUtc(start + hours * HOUR)}`];
}

export interface PutResult { status: number; etag: string | null; headers: Headers; errorElements: string[] }

export async function putEvent(ctx: CheckContext, url: string, body: string, headers: Record<string, string> = {}): Promise<PutResult> {
    const r = await dav(ctx, 'PUT', url, { body, headers: { 'content-type': 'text/calendar; charset=utf-8', ...headers } });
    return { status: r.res.status, etag: r.res.headers.get('etag'), headers: r.res.headers, errorElements: r.errorElements };
}

export async function propfindEtag(ctx: CheckContext, url: string): Promise<string | null> {
    const r = await dav(ctx, 'PROPFIND', url, { depth: '0', body: propfindBody(['D:getetag']) });
    const response = r.ms?.responses[0];
    return response === undefined ? null : okProp(response, 'getetag')?.text ?? null;
}

/** PUT that must succeed for the check to continue. Returns the ETag (header, else PROPFIND). */
export async function createOrStop(ctx: CheckContext, url: string, body: string, evidence: Evidence): Promise<string | null> {
    const put = await putEvent(ctx, url, body, { 'if-none-match': '*' });
    evidence.putStatus = put.status;
    if (!isOk(put.status)) {
        throw new CheckStop(isRefusal(put.status) ? 'refuted' : 'inconclusive', prose`The server did not accept the test event (HTTP ${put.status}).`, evidence);
    }
    return put.etag ?? (await propfindEtag(ctx, url));
}

export async function deleteEvent(ctx: CheckContext, url: string, etag: string | null): Promise<number> {
    const r = await dav(ctx, 'DELETE', url, etag === null ? {} : { headers: { 'if-match': etag } });
    return r.res.status;
}

export interface TempCalendarCreation {
    temp: TempCalendar;
    status: number;
    visible: boolean;
    displayNameKept: boolean;
    declaresVevent: boolean;
    locationHeader: boolean;
    locationUsed: boolean;
}

const PROBE_NAME = /^caldav-mcp-probe-[0-9a-f]{8}$/;

function withSlash(url: string): string {
    return url.endsWith('/') ? url : `${url}/`;
}

/** Collection URLs listed in the home before any write (from the collections check). */
function existingCollections(ctx: CheckContext): ReadonlySet<string> | undefined {
    const calendars = ctx.state.calendars;
    return calendars === undefined ? undefined : new Set(calendars.map((c) => withSlash(c.href)));
}

/**
 * Honours a MKCALENDAR Location that names a different URL. It is used (for the write checks
 * and for deletion) only when it passes the host rule, is a direct child of the home, was not
 * in the home listing taken before any write, and a PROPFIND shows our own display name there.
 */
async function adoptLocation(ctx: CheckContext, temp: TempCalendar, home: string, location: string, requestUrl: string): Promise<boolean> {
    const target = absolute(location, requestUrl);
    if (target === undefined || withSlash(target) === temp.requestedUrl || directChildOf(target, home) === undefined) {
        return false;
    }
    const existing = existingCollections(ctx);
    if (existing === undefined || existing.has(withSlash(target))) {
        return false;
    }
    const check = await dav(ctx, 'PROPFIND', target, { depth: '0', body: propfindBody(['D:resourcetype', 'D:displayname']) });
    const response = check.ms?.responses[0];
    const types = response === undefined ? [] : (okProp(response, 'resourcetype')?.node.children ?? []).map((c) => c.name);
    if (check.res.status !== 207 || response === undefined || okProp(response, 'displayname')?.text !== temp.name || !types.includes('calendar') || types.includes('shared') || types.includes('shared-owner')) {
        return false;
    }
    ctx.http.registerCreatedCollection(target, home, existing, temp.requestedUrl);
    temp.url = target;
    temp.deleteUrls = [target, temp.requestedUrl];
    return true;
}

export async function createTempCalendar(ctx: CheckContext): Promise<TempCalendarCreation> {
    const home = ctx.state.homeUrl;
    if (home === undefined) {
        throw new CheckStop('skipped', prose`Skipped: no calendar home.`);
    }
    const name = `caldav-mcp-probe-${ctx.randomHex(4)}`;
    const url = new URL(`${name}/`, home).href;
    ctx.http.registerProbeCollection(url, home);
    const temp: TempCalendar = { name, url, requestedUrl: url, deleteUrls: [url], removalVerified: false, deleteStatus: null };
    // Recorded before the request, so the DELETE is sent even if the outcome is unknown.
    ctx.state.temp.push(temp);
    const body = xmlDoc(`<C:mkcalendar ${NS}><D:set><D:prop><D:displayname>${name}</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`);
    const created = await dav(ctx, 'MKCALENDAR', url, { body });
    const location = created.res.headers.get('location');
    const locationUsed = location !== null && isOk(created.res.status) && (await adoptLocation(ctx, temp, home, location, created.res.url));
    const check = await dav(ctx, 'PROPFIND', temp.url, { depth: '0', body: propfindBody(['D:resourcetype', 'D:displayname', 'C:supported-calendar-component-set']) });
    const response = check.ms?.responses[0];
    const types = response === undefined ? [] : (okProp(response, 'resourcetype')?.node.children ?? []).map((c) => c.name);
    const components = response === undefined ? [] : childrenNamed(okProp(response, 'supported-calendar-component-set')?.node, 'comp').map((c) => c.attrs.name ?? '');
    return {
        temp,
        status: created.res.status,
        visible: check.res.status === 207 && types.includes('calendar'),
        displayNameKept: response !== undefined && okProp(response, 'displayname')?.text === name,
        declaresVevent: components.includes('VEVENT'),
        locationHeader: location !== null,
        locationUsed,
    };
}

async function collectionStatus(ctx: CheckContext, url: string): Promise<number> {
    const res = await ctx.http.request({ method: 'PROPFIND', url, headers: { depth: '0' }, body: propfindBody(['D:resourcetype']), essential: true });
    return res.status;
}

/** DELETE (one retry on 429/503), then a PROPFIND that must answer 404 or 410. */
async function deleteAndVerify(ctx: CheckContext, temp: TempCalendar, url: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const del = await ctx.http.request({ method: 'DELETE', url, essential: true });
        temp.deleteStatus = del.status;
        if (del.status !== 429 && del.status !== 503) {
            break;
        }
    }
    const after = await collectionStatus(ctx, url);
    return after === 404 || after === 410;
}

interface Leftover { name: string; reason: NotDeletedReason; cleanupCanRemove: boolean }

/**
 * One Depth 1 listing of the home: any collection whose display name is one of this run's
 * temporary names is a leftover. Undefined when the listing could not be read.
 */
async function finalListing(ctx: CheckContext, home: string): Promise<{ leftovers: Leftover[]; olderProbe: number } | undefined> {
    const names = new Set(ctx.state.temp.map((t) => t.name));
    let listing: DavResult;
    try {
        listing = await dav(ctx, 'PROPFIND', home, { depth: '1', body: propfindBody(['D:resourcetype', 'D:displayname']), essential: true, stopOnThrottle: false });
    } catch {
        return undefined;
    }
    if (listing.ms === undefined) {
        return undefined;
    }
    const leftovers: Leftover[] = [];
    let olderProbe = 0;
    for (const response of listing.ms.responses) {
        const url = absolute(response.href, listing.res.url);
        const name = okProp(response, 'displayname')?.text ?? '';
        if (url === undefined || withSlash(url) === home || !PROBE_NAME.test(name)) {
            continue;
        }
        if (!names.has(name)) {
            olderProbe++;
            continue;
        }
        const atProbeUrl = probeSegment(url, home) === name;
        leftovers.push({ name, reason: atProbeUrl ? 'still_listed' : 'server_chosen_url', cleanupCanRemove: atProbeUrl });
    }
    return { leftovers, olderProbe };
}

/**
 * Sends a DELETE for every calendar the probe attempted to create (a 404 is fine), verifies
 * each with PROPFIND, then lists the home once: removal is only verified when no collection
 * with one of this run's names remains anywhere in it. Never throws.
 */
export async function removeTempCalendars(ctx: CheckContext): Promise<{ result: CheckRecord; notDeleted: NotDeletedReport[] }> {
    const base = {
        id: 'write-delete-calendar',
        planItem: 'Phase 0 write tests: the temporary calendar is removed',
        claim: 'DELETE of a calendar collection is accepted, a later PROPFIND answers 404, and a final listing of the calendar home shows none of this run’s calendars.',
    };
    const deleteStatuses: Record<string, number> = {};
    for (const temp of ctx.state.temp) {
        let gone = true;
        for (const url of temp.deleteUrls) {
            try {
                gone = (await deleteAndVerify(ctx, temp, url)) && gone;
            } catch {
                gone = false;
            }
        }
        temp.removalVerified = gone;
        if (temp.deleteStatus !== null) {
            deleteStatuses[String(temp.deleteStatus)] = (deleteStatuses[String(temp.deleteStatus)] ?? 0) + 1;
        }
    }
    const evidence: Evidence = { temporaryCalendars: ctx.state.temp.length, deleteStatuses };
    const home = ctx.state.homeUrl;
    if (ctx.state.temp.length === 0 || home === undefined) {
        evidence.removalVerified = 0;
        return { result: { ...base, outcome: 'skipped', summary: prose`No temporary calendar was created.`, evidence }, notDeleted: [] };
    }
    const listed = await finalListing(ctx, home);
    evidence.finalListingRead = listed !== undefined;
    const notDeleted: NotDeletedReport[] = [];
    if (listed === undefined) {
        for (const temp of ctx.state.temp) {
            temp.removalVerified = false;
        }
    } else {
        evidence.olderProbeCalendarsListed = listed.olderProbe;
        for (const leftover of listed.leftovers) {
            for (const temp of ctx.state.temp.filter((t) => t.name === leftover.name)) {
                temp.removalVerified = false;
            }
            notDeleted.push({ name: leftover.name, reason: leftover.reason, cleanupCanRemove: leftover.cleanupCanRemove });
        }
        evidence.leftoversListed = listed.leftovers.length;
    }
    const verified = ctx.state.temp.filter((t) => t.removalVerified).length;
    evidence.removalVerified = verified;
    if (verified === ctx.state.temp.length) {
        return { result: { ...base, outcome: 'confirmed', summary: prose`All ${verified} temporary calendar(s) were deleted, verified gone, and absent from the final listing.`, evidence }, notDeleted };
    }
    const anyAnswer = ctx.state.temp.some((t) => !t.removalVerified && t.deleteStatus !== null);
    return {
        result: {
            ...base,
            outcome: anyAnswer ? 'refuted' : 'inconclusive',
            summary: prose`${ctx.state.temp.length - verified} temporary calendar(s) could not be verified as removed; delete them by hand (names in the cleanup section).`,
            evidence,
        },
        notDeleted,
    };
}
