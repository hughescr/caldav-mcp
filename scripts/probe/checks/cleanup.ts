import { CheckStop, isOk, type CheckContext, type CheckRecord } from '../context';
import { NS, absolute, dav, hrefsIn, propfindBody, xmlDoc } from '../dav';
import { directChildOf, probeSegment } from '../http';
import { parseIcal, prop, type IcalComponent } from '../ical';
import { prose, type Prose } from '../safe';
import type { CleanupCandidates, Outcome, CleanupReport, Evidence, NotDeletedReason, NotDeletedReport, TempCalendarReport } from '../types';
import { escapeXml, okProp, type DavResponse } from '../xml';

/**
 * `--cleanup`: removes calendars the probe itself left behind, and nothing else.
 *
 * A collection is a deletion candidate only when ALL of these hold:
 *  (a) its display name is exactly caldav-mcp-probe-<8 hex digits>;
 *  (b) its URL is a direct child of the calendar home whose last segment is that same name
 *      (the path the probe's own MKCALENDAR uses);
 *  (c) it is a plain owned calendar: no shared / shared-owner / subscribed resource type, no
 *      invite, shared-url or source property, and no owner other than this principal;
 *  (d) a Depth 1 listing plus a calendar-multiget shows every resource in it was written by
 *      the probe: resource name <UID>.ics with UID caldav-mcp-probe-<hex>-<suffix>, only
 *      VEVENT (and VTIMEZONE) components, every VEVENT with that UID and a SUMMARY starting
 *      "caldav-mcp probe ".
 * The candidates are then shown (probe-style names only) and deleted only after confirmation.
 * The HTTP layer enforces (a) and (b) again on every cleanup DELETE.
 */
export const PROBE_PREFIX = 'caldav-mcp-probe-';
const STRICT_NAME = /^caldav-mcp-probe-[0-9a-f]{8}$/;
const PROBE_RESOURCE = /^(caldav-mcp-probe-[0-9a-f]{8}-[0-9a-z]{1,12})\.ics$/;
const PROBE_SUMMARY = /^caldav-mcp probe /;
/** A 0.6.0 `--write` run leaves about 90 events in its first temporary calendar if its deletion fails. */
const MAX_RESOURCES = 100;
const LISTING_PROPS = ['D:resourcetype', 'D:displayname', 'D:owner', 'CS:invite', 'CS:shared-url', 'CS:source'];
const SHARING_PROPS = ['invite', 'shared-url', 'source'];

export interface CleanupOptions {
    confirm?: (candidates: CleanupCandidates) => Promise<boolean>;
    signal?: AbortSignal;
}

function firstSegment(url: string | undefined): string | undefined {
    if (url === undefined) {
        return undefined;
    }
    try {
        return new URL(url, 'https://placeholder.invalid').pathname.split('/')[1];
    } catch {
        return undefined;
    }
}

/** Rules (b) and (c) from the home listing alone. */
function listingReason(ctx: CheckContext, response: DavResponse, url: string | undefined, home: string, name: string): NotDeletedReason | undefined {
    if (url === undefined || directChildOf(url, home) === undefined || probeSegment(url, home) !== name) {
        return 'url_not_probe_pattern';
    }
    const types = (okProp(response, 'resourcetype')?.node.children ?? []).map((c) => c.name);
    if (types.includes('subscribed')) {
        return 'subscribed';
    }
    if (types.includes('shared') || types.includes('shared-owner')) {
        return 'shared';
    }
    if (!types.includes('calendar')) {
        return 'not_calendar';
    }
    if (SHARING_PROPS.some((p) => okProp(response, p) !== undefined)) {
        return 'sharing_property';
    }
    const owner = firstSegment(hrefsIn(okProp(response, 'owner')?.node)[0]);
    const principal = firstSegment(ctx.state.principalUrl);
    if (owner !== undefined && (principal === undefined || owner !== principal)) {
        return 'not_owned';
    }
    return undefined;
}

/** Rule (d) for one parsed resource. */
function writtenByProbe(cal: IcalComponent | undefined, uid: string): boolean {
    if (cal?.name !== 'VCALENDAR' || cal.components.length === 0) {
        return false;
    }
    let events = 0;
    for (const component of cal.components) {
        if (component.name === 'VTIMEZONE') {
            continue;
        }
        if (component.name !== 'VEVENT' || prop(component, 'UID')?.value !== uid || !PROBE_SUMMARY.test(prop(component, 'SUMMARY')?.value ?? '')) {
            return false;
        }
        events++;
    }
    return events > 0;
}

/** Rule (d): every resource in the collection was written by the probe. */
async function contentsReason(ctx: CheckContext, url: string): Promise<NotDeletedReason | undefined> {
    const listing = await dav(ctx, 'PROPFIND', url, { depth: '1', body: propfindBody(['D:resourcetype', 'D:getetag']) });
    if (listing.ms === undefined) {
        return 'contents_unreadable';
    }
    const collection = new URL(url);
    const members = new Map<string, string>();
    for (const response of listing.ms.responses) {
        const abs = absolute(response.href, listing.res.url);
        if (abs === undefined) {
            return 'contents_unreadable';
        }
        const target = new URL(abs);
        if (target.origin === collection.origin && (target.pathname === collection.pathname || `${target.pathname}/` === collection.pathname)) {
            continue;
        }
        const match = target.origin === collection.origin && target.pathname.startsWith(collection.pathname) && target.search === ''
            ? PROBE_RESOURCE.exec(target.pathname.slice(collection.pathname.length))
            : null;
        const uid = match?.[1];
        if (uid === undefined) {
            return 'foreign_resource';
        }
        members.set(target.pathname, uid);
    }
    if (members.size > MAX_RESOURCES) {
        return 'too_many_resources';
    }
    if (members.size === 0) {
        return undefined;
    }
    const body = xmlDoc(`<C:calendar-multiget ${NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>${[...members.keys()].map((p) => `<D:href>${escapeXml(p)}</D:href>`).join('')}</C:calendar-multiget>`);
    const r = await dav(ctx, 'REPORT', url, { depth: '1', body });
    if (r.ms === undefined) {
        return 'contents_unreadable';
    }
    const checked = new Set<string>();
    for (const response of r.ms.responses) {
        const abs = absolute(response.href, r.res.url);
        const path = abs === undefined ? undefined : new URL(abs).pathname;
        const uid = path === undefined ? undefined : members.get(path);
        const data = okProp(response, 'calendar-data')?.node.text;
        if (path === undefined || uid === undefined || data === undefined) {
            return 'contents_unreadable';
        }
        if (!writtenByProbe(parseIcal(data), uid)) {
            return 'foreign_resource';
        }
        checked.add(path);
    }
    return checked.size === members.size ? undefined : 'contents_unreadable';
}

async function confirmed(options: CleanupOptions, candidates: CleanupCandidates): Promise<boolean> {
    const { confirm, signal } = options;
    // A function, not a narrowed property: the signal can fire while the prompt waits.
    const interrupted = (): boolean => signal?.aborted === true;
    if (confirm === undefined || interrupted()) {
        return false;
    }
    const aborted = new Promise<boolean>((resolve) => {
        signal?.addEventListener('abort', () => { resolve(false); }, { once: true });
    });
    const answer = await Promise.race([confirm(candidates).catch(() => false), aborted]);
    return answer && !interrupted();
}

async function verifiedGone(ctx: CheckContext, url: string): Promise<boolean> {
    const res = await ctx.http.request({ method: 'PROPFIND', url, headers: { depth: '0' }, body: propfindBody(['D:resourcetype']), essential: true });
    return res.status === 404 || res.status === 410;
}

interface Candidate { name: string; url: string }

export async function runCleanup(ctx: CheckContext, options: CleanupOptions = {}): Promise<{ result: CheckRecord; report: CleanupReport }> {
    const base = {
        id: 'cleanup-leftovers',
        planItem: 'Probe hygiene: leftover temporary calendars',
        claim: 'Every calendar the probe left behind (exact probe name and URL, unshared, holding only probe events) is deleted after confirmation, and nothing else is.',
    };
    const tempCalendars: TempCalendarReport[] = [];
    const notDeleted: NotDeletedReport[] = [];
    const finish = (outcome: Outcome, summary: Prose, evidence: Evidence): { result: CheckRecord; report: CleanupReport } => {
        const deleted = tempCalendars.filter((t) => t.removalVerified).length;
        return {
            result: { ...base, outcome, summary, evidence },
            report: { tempCalendars, notDeleted, deleted, allRemoved: deleted === tempCalendars.length && notDeleted.length === 0 },
        };
    };
    const home = ctx.state.homeUrl;
    if (home === undefined || ctx.http.credentialsRejected) {
        return finish('skipped', prose`Skipped: discovery did not find a usable calendar home.`, {});
    }
    try {
        const listing = await dav(ctx, 'PROPFIND', home, { depth: '1', body: propfindBody(LISTING_PROPS) });
        if (listing.ms === undefined) {
            throw new CheckStop('inconclusive', prose`The calendar home listing was not readable (HTTP ${listing.res.status}).`, { status: listing.res.status });
        }
        let found = 0;
        let lookalikes = 0;
        const candidates: Candidate[] = [];
        for (const response of listing.ms.responses) {
            const url = absolute(response.href, listing.res.url);
            const name = okProp(response, 'displayname')?.text ?? '';
            if (!name.startsWith(PROBE_PREFIX) || url === home) {
                continue;
            }
            if (!STRICT_NAME.test(name)) {
                // Not the probe's own form (for example one the owner named): never touched or printed.
                lookalikes++;
                continue;
            }
            found++;
            const reason = listingReason(ctx, response, url, home, name) ?? (await contentsReason(ctx, url ?? ''));
            if (reason === undefined && url !== undefined) {
                candidates.push({ name, url });
            } else {
                notDeleted.push({ name, reason: reason ?? 'url_not_probe_pattern', cleanupCanRemove: false });
            }
        }
        candidates.sort((a, b) => a.name.localeCompare(b.name));
        const evidence: Evidence = { found, candidates: candidates.length, lookalikesIgnored: lookalikes };
        if (candidates.length > 0 && !(await confirmed(options, { names: candidates.map((c) => c.name) }))) {
            for (const c of candidates) {
                notDeleted.push({ name: c.name, reason: 'not_confirmed', cleanupCanRemove: true });
            }
            Object.assign(evidence, { confirmed: false, notDeleted: notDeleted.length, reasons: reasonCounts(notDeleted) });
            return finish('skipped', prose`${candidates.length} probe calendar(s) could be deleted, but deletion was not confirmed; nothing was deleted.`, evidence);
        }
        let accepted = 0;
        for (const c of candidates) {
            try {
                ctx.http.registerLeftoverCollection(c.url, home, c.name);
            } catch {
                notDeleted.push({ name: c.name, reason: 'registration_refused', cleanupCanRemove: false });
                continue;
            }
            let removed = false;
            try {
                const del = await ctx.http.request({ method: 'DELETE', url: c.url, essential: true });
                accepted += isOk(del.status) ? 1 : 0;
                removed = await verifiedGone(ctx, c.url);
            } catch {
                removed = false;
            }
            tempCalendars.push({ name: c.name, removalVerified: removed });
        }
        const verified = tempCalendars.filter((t) => t.removalVerified).length;
        Object.assign(evidence, { confirmed: candidates.length > 0, deleteAccepted: accepted, removalVerified: verified, notDeleted: notDeleted.length, reasons: reasonCounts(notDeleted) });
        if (found === 0) {
            return finish('confirmed', prose`No leftover probe calendar was found.`, evidence);
        }
        if (verified === tempCalendars.length && notDeleted.length === 0) {
            return finish('confirmed', prose`Deleted ${verified} leftover probe calendar(s); all verified gone.`, evidence);
        }
        return finish('refuted', prose`Deleted and verified ${verified}; ${tempCalendars.length - verified} could not be verified; ${notDeleted.length} found but not deleted (see the reasons).`, evidence);
    } catch (error) {
        if (error instanceof CheckStop) {
            return finish(error.outcome, error.summary, error.evidence);
        }
        return finish('inconclusive', prose`The cleanup listing could not be completed.`, {});
    }
}

function reasonCounts(entries: readonly NotDeletedReport[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of entries) {
        counts[e.reason] = (counts[e.reason] ?? 0) + 1;
    }
    return counts;
}
