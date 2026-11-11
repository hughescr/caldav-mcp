import { CheckStop, isRefusal, type CheckContext, type CheckDef } from '../context';
import { NS, absolute, dav, xmlDoc, type DavResult } from '../dav';
import { prose, safeNames, tokenShape } from '../safe';
import type { Evidence } from '../types';
import { escapeXml } from '../xml';
import { ensureWindow, eventCalendars } from './queries';

export function syncBody(token: string, limit?: number): string {
    const limitXml = limit === undefined ? '' : `<D:limit><D:nresults>${limit}</D:nresults></D:limit>`;
    return xmlDoc(`<D:sync-collection ${NS}><D:sync-token>${escapeXml(token)}</D:sync-token><D:sync-level>1</D:sync-level>${limitXml}<D:prop><D:getetag/></D:prop></D:sync-collection>`);
}

export interface SyncSummary {
    status: number;
    token: string | null;
    /** Member responses, excluding a collection-level 507 truncation marker. */
    items: { href: string; status: number | null; hasEtag: boolean }[];
    truncated: boolean;
}

export function summariseSync(r: DavResult, collection: string): SyncSummary {
    const items: SyncSummary['items'] = [];
    let truncated = false;
    for (const response of r.ms?.responses ?? []) {
        const href = absolute(response.href, collection);
        if (response.status === 507 || href === collection) {
            truncated ||= response.status === 507;
            continue;
        }
        items.push({ href: href ?? '', status: response.status, hasEtag: response.props.get('getetag')?.status === 200 });
    }
    return { status: r.res.status, token: r.ms?.syncToken ?? null, items, truncated };
}

export async function sync(ctx: CheckContext, collection: string, token: string, limit?: number): Promise<SyncSummary> {
    const depth = ctx.state.syncDepth ?? '0';
    const r = await dav(ctx, 'REPORT', collection, { depth, body: syncBody(token, limit) });
    if (r.res.status === 207) {
        ctx.state.syncDepth = depth;
    } else if (r.res.status === 400 && ctx.state.syncDepth === undefined) {
        // RFC 6578 requires Depth: 0. If the server refuses it, try Depth: 1 once and record that.
        const retry = await dav(ctx, 'REPORT', collection, { depth: '1', body: syncBody(token, limit) });
        if (retry.res.status === 207) {
            ctx.state.syncDepth = '1';
            return summariseSync(retry, collection);
        }
    }
    return summariseSync(r, collection);
}

/** Owned event calendar with the most events in the window; sync responses scale with its size. */
async function syncTarget(ctx: CheckContext): Promise<{ href: string; inWindow: number }> {
    await ensureWindow(ctx);
    const candidates = eventCalendars(ctx).filter((c) => c.kind === 'owned');
    let best: { href: string; inWindow: number } | undefined;
    for (const cal of candidates.length > 0 ? candidates : eventCalendars(ctx)) {
        const inWindow = ctx.state.window.get(cal.href)?.resources.length ?? 0;
        if (best === undefined || inWindow > best.inWindow) {
            best = { href: cal.href, inWindow };
        }
    }
    if (best === undefined) {
        throw new CheckStop('inconclusive', prose`No event calendar was available.`);
    }
    return best;
}

export const syncCheck: CheckDef = {
    id: 'sync-collection',
    planItem: 'Phase 0: sync-collection',
    claim: 'An initial sync-collection REPORT (empty token) returns a sync token, and a repeat with that token reports no changes.',
    needs: 'calendars',
    async run(ctx) {
        const target = await syncTarget(ctx);
        const initial = await sync(ctx, target.href, '');
        const evidence: Evidence = { initialStatus: initial.status, initialItemCount: initial.items.length, initialTokenShape: initial.token === null ? null : tokenShape(initial.token) };
        if (initial.status !== 207 || initial.token === null || initial.token === '') {
            return { outcome: initial.status === 207 || isRefusal(initial.status) ? 'refuted' : 'inconclusive', summary: prose`The initial sync answered HTTP ${initial.status} ${initial.token === null ? prose`without` : prose`with`} a token.`, evidence };
        }
        ctx.taint.add(initial.token);
        const second = await sync(ctx, target.href, initial.token);
        if (second.token !== null) {
            ctx.taint.add(second.token);
        }
        evidence.secondStatus = second.status;
        evidence.secondChangeCount = second.items.length;
        evidence.secondTokenUnchanged = second.token === initial.token;
        evidence.depthAccepted = ctx.state.syncDepth === undefined ? null : Number(ctx.state.syncDepth);
        const invalid = await dav(ctx, 'REPORT', target.href, { depth: ctx.state.syncDepth ?? '0', body: syncBody(`caldav-mcp-probe-invalid-${ctx.randomHex(8)}`) });
        evidence.invalidTokenStatus = invalid.res.status;
        evidence.invalidTokenPreconditions = safeNames(invalid.errorElements, ctx.taint);
        if (second.status === 207 && second.items.length === 0) {
            return { outcome: 'confirmed', summary: prose`Initial sync returned ${initial.items.length} item(s) and a token; the repeat reported no changes. An invalid token answered HTTP ${invalid.res.status}.`, evidence };
        }
        if (second.status === 207) {
            return { outcome: 'refuted', summary: prose`The repeat with the token reported ${second.items.length} change(s) although nothing changed.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The repeat sync answered HTTP ${second.status}.`, evidence };
    },
};

export const syncLimitCheck: CheckDef = {
    id: 'sync-limit',
    planItem: 'Known quirks: the sync-collection limit is ignored',
    claim: 'sync-collection ignores DAV:limit/nresults (returns more items than requested, without a 507 truncation marker).',
    needs: 'calendars',
    async run(ctx) {
        const target = await syncTarget(ctx);
        const limited = await sync(ctx, target.href, '', 1);
        if (limited.token !== null) {
            ctx.taint.add(limited.token);
        }
        const evidence: Evidence = { status: limited.status, nresultsRequested: 1, itemsReturned: limited.items.length, truncationMarker507: limited.truncated, eventsInWindow: target.inWindow };
        if (limited.status !== 207) {
            return { outcome: 'inconclusive', summary: prose`The limited sync answered HTTP ${limited.status}.`, evidence };
        }
        if (limited.items.length > 1) {
            return { outcome: 'confirmed', summary: prose`Asked for 1 result, received ${limited.items.length}.`, evidence };
        }
        if (target.inWindow >= 2 || limited.truncated) {
            return { outcome: 'refuted', summary: prose`The limit was honoured (${limited.items.length} item, truncation marker ${limited.truncated ? prose`present` : prose`absent`}).`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The calendar has too few items to tell (run --write for a definitive test).`, evidence };
    },
};
