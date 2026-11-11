import { CheckStop, type CalendarInfo, type CalendarKind, type CheckDef } from '../context';
import { absolute, dav, hrefsIn, propfindBody } from '../dav';
import { prose, safeNames } from '../safe';
import type { Evidence } from '../types';
import { childrenNamed, descendants, okProp } from '../xml';

const PROPS = [
    'D:resourcetype', 'D:displayname', 'A:calendar-color', 'C:calendar-timezone', 'CS:getctag', 'D:sync-token',
    'C:supported-calendar-component-set', 'D:current-user-privilege-set', 'CS:source', 'D:owner', 'CS:invite',
];
const PROP_NAMES = PROPS.map((p) => p.slice(p.indexOf(':') + 1));
const WRITE_PRIVILEGES = new Set(['write', 'write-content', 'all', 'bind']);

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

export const collectionsCheck: CheckDef = {
    id: 'collections',
    planItem: 'Phase 0: shared and subscribed calendars; What iCloud provides: Calendars and events',
    claim: 'The calendar home lists calendar collections (owned, shared with me, shared by me, subscribed) with at least one declaring VEVENT.',
    needs: 'home',
    async run(ctx) {
        const home = ctx.state.homeUrl ?? '';
        const r = await dav(ctx, 'PROPFIND', home, { depth: '1', body: propfindBody(PROPS) });
        if (r.ms === undefined) {
            throw new CheckStop('inconclusive', prose`The calendar home listing was not a readable multistatus (HTTP ${r.res.status}).`, { status: r.res.status });
        }
        const byKind: Record<CalendarKind, number> = { owned: 0, 'shared-with-me': 0, 'shared-by-me': 0, subscribed: 0 };
        const byComponent = { VEVENT: 0, VTODO: 0, none: 0 };
        const privileges = { writable: 0, readOnly: 0, unknown: 0 };
        const returned: Record<string, number> = Object.fromEntries(PROP_NAMES.map((n) => [n, 0]));
        const otherTypes = new Set<string>();
        let ownerDiffers = 0;
        let withInvite = 0;
        const principalSegment = firstSegment(ctx.state.principalUrl);
        const calendars: CalendarInfo[] = [];
        for (const response of r.ms.responses) {
            const url = absolute(response.href, r.res.url);
            if (url === undefined || url === home || `${url}/` === home) {
                continue;
            }
            const types = (okProp(response, 'resourcetype')?.node.children ?? []).map((c) => c.name);
            const isCalendar = types.includes('calendar');
            const subscribed = types.includes('subscribed');
            if (!isCalendar && !subscribed) {
                for (const t of types) {
                    if (t !== 'collection') {
                        otherTypes.add(t);
                    }
                }
                continue;
            }
            const kind: CalendarKind = subscribed ? 'subscribed' : types.includes('shared') ? 'shared-with-me' : types.includes('shared-owner') ? 'shared-by-me' : 'owned';
            byKind[kind]++;
            const components = childrenNamed(okProp(response, 'supported-calendar-component-set')?.node, 'comp')
                .map((c) => (c.attrs.name ?? '').toUpperCase())
                .filter((c) => c !== '');
            if (components.includes('VEVENT')) {
                byComponent.VEVENT++;
            }
            if (components.includes('VTODO')) {
                byComponent.VTODO++;
            }
            if (components.length === 0) {
                byComponent.none++;
            }
            const privilegeSet = okProp(response, 'current-user-privilege-set');
            const privilegeNames = descendants(privilegeSet?.node, 'privilege').flatMap((p) => p.children.map((c) => c.name));
            const writable = privilegeNames.some((p) => WRITE_PRIVILEGES.has(p));
            if (privilegeSet === undefined) {
                privileges.unknown++;
            } else if (writable) {
                privileges.writable++;
            } else {
                privileges.readOnly++;
            }
            for (const name of PROP_NAMES) {
                if (okProp(response, name) !== undefined) {
                    returned[name] = (returned[name] ?? 0) + 1;
                }
            }
            const ownerSegment = firstSegment(hrefsIn(okProp(response, 'owner')?.node)[0]);
            if (ownerSegment !== undefined && principalSegment !== undefined && ownerSegment !== principalSegment) {
                ownerDiffers++;
            }
            if (okProp(response, 'invite') !== undefined) {
                withInvite++;
            }
            const displayName = okProp(response, 'displayname')?.text ?? null;
            calendars.push({ href: url, kind, isCalendar, components, writable, displayName });
        }
        ctx.state.calendars = calendars;
        const evidence: Evidence = {
            status: r.res.status,
            calendarCollections: calendars.length,
            byKind: { owned: byKind.owned, sharedWithMe: byKind['shared-with-me'], sharedByMe: byKind['shared-by-me'], subscribed: byKind.subscribed },
            byComponent,
            privileges,
            propertyReturnCounts: returned,
            otherCollectionTypes: safeNames(otherTypes, ctx.taint),
            ownerDiffersFromPrincipal: ownerDiffers,
            withInviteProperty: withInvite,
        };
        if (byComponent.VEVENT + byComponent.none > 0) {
            return { outcome: 'confirmed', summary: prose`${calendars.length} calendar collection(s): ${byKind.owned} owned, ${byKind['shared-with-me']} shared with me, ${byKind['shared-by-me']} shared by me, ${byKind.subscribed} subscribed.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`No collection declaring VEVENT was found.`, evidence };
    },
};
