import { CheckStop, stopOnThrottle, type CheckContext, type CheckDef } from '../context';
import { absolute, dav, hrefsIn, propfindBody } from '../dav';
import { ProbeHttpError } from '../http';
import { DISCOVERY_HOST, DISCOVERY_URL, isAllowedProbeUrl, isPerAccountHost } from '../hosts';
import { davTokens, fixed, hrefShape, prose, safeNames, sortedSafe } from '../safe';
import type { Evidence } from '../types';
import { okProp } from '../xml';

export const AUTH_FAILED_FIRST = prose`Authentication failed (HTTP 401) on the first request, so nothing else was sent. Check the Apple ID and the app-specific password. Do not retry repeatedly: each attempt with a wrong password counts as a failed sign-in.`;
const AUTH_FAILED = prose`The server refused the credentials (HTTP 401) part-way through discovery, so nothing else was sent. Check the Apple ID and the app-specific password. Do not retry repeatedly.`;

const PRINCIPAL_PROPS =['C:calendar-home-set', 'C:calendar-user-address-set', 'C:schedule-inbox-URL', 'C:schedule-outbox-URL', 'D:principal-URL'];
const SCHEDULING_PROPS = ['calendar-user-address-set', 'schedule-inbox-URL', 'schedule-outbox-URL', 'principal-URL'];

function hostOf(url: string): string {
    return new URL(url).hostname.toLowerCase();
}

function normalise(url: string | undefined): string | undefined {
    return url === undefined ? undefined : absolute(url, DISCOVERY_URL);
}

interface PrincipalLookup { status: number; redirects: number; principalHref?: string; principalUrl?: string }

async function lookupPrincipal(ctx: CheckContext): Promise<PrincipalLookup> {
    const r = await dav(ctx, 'PROPFIND', DISCOVERY_URL, { depth: '0', body: propfindBody(['D:current-user-principal']) });
    const href = r.ms?.responses.map((resp) => hrefsIn(okProp(resp, 'current-user-principal')?.node)[0]).find((h) => h !== undefined);
    const principalUrl = href === undefined ? undefined : absolute(href, r.res.url);
    return { status: r.res.status, redirects: r.res.redirects, ...(href === undefined ? {} : { principalHref: href }), ...(principalUrl === undefined ? {} : { principalUrl }) };
}

interface HomeLookup { status: number; homeHref?: string; homeUrl?: string; present: Record<string, boolean>; addresses: string[] }

async function lookupHome(ctx: CheckContext, principalUrl: string): Promise<HomeLookup> {
    const r = await dav(ctx, 'PROPFIND', principalUrl, { depth: '0', body: propfindBody(PRINCIPAL_PROPS) });
    const response = r.ms?.responses[0];
    const present: Record<string, boolean> = {};
    let addresses: string[] = [];
    let homeHref: string | undefined;
    if (response !== undefined) {
        for (const name of SCHEDULING_PROPS) {
            present[name] = okProp(response, name) !== undefined;
        }
        addresses = hrefsIn(okProp(response, 'calendar-user-address-set')?.node);
        homeHref = hrefsIn(okProp(response, 'calendar-home-set')?.node)[0];
    }
    const homeUrl = homeHref === undefined ? undefined : absolute(homeHref, r.res.url);
    return { status: r.res.status, present, addresses, ...(homeHref === undefined ? {} : { homeHref }), ...(homeUrl === undefined ? {} : { homeUrl }) };
}

export const discoveryCheck: CheckDef = {
    id: 'discovery',
    planItem: 'What iCloud provides: Discovery',
    claim: 'Discovery starts at caldav.icloud.com and follows current-user-principal and calendar-home-set to a per-account host matching pNN-caldav.icloud.com.',
    async run(ctx) {
        const evidence: Evidence = {};
        // The first request of every run is this authenticated PROPFIND: it is the one that proves
        // the credentials, so an OPTIONS that a server answers without checking them cannot hide
        // a wrong password. A 401 latches the HTTP layer and nothing else is sent.
        const principal = await lookupPrincipal(ctx);
        ctx.state.authStatus = principal.status;
        evidence.principalStatus = principal.status;
        evidence.principalRedirects = principal.redirects;
        if (ctx.http.credentialsRejected) {
            throw new CheckStop('error', ctx.http.rejectedOnFirstRequest ? AUTH_FAILED_FIRST : AUTH_FAILED, evidence);
        }

        try {
            const options = await ctx.http.request({ method: 'OPTIONS', url: DISCOVERY_URL });
            stopOnThrottle(ctx, options);
            evidence.optionsStatus = options.status;
            ctx.state.rootDav = davTokens(options.headers.get('dav'));
            evidence.allowMethods = safeNames((options.headers.get('allow') ?? '').split(',').map((m) => m.trim()).filter((m) => m !== ''), ctx.taint);
        } catch (error) {
            if (!(error instanceof ProbeHttpError)) {
                throw error;
            }
            evidence.optionsError = fixed(error.code);
        }
        try {
            const wellKnown = await dav(ctx, 'PROPFIND', `${DISCOVERY_URL}.well-known/caldav`, { depth: '0', body: propfindBody(['D:current-user-principal']) });
            evidence.wellKnownStatus = wellKnown.res.status;
            evidence.wellKnownRedirects = wellKnown.res.redirects;
        } catch (error) {
            if (!(error instanceof ProbeHttpError)) {
                throw error;
            }
            evidence.wellKnownError = fixed(error.code);
        }
        if (ctx.http.credentialsRejected) {
            throw new CheckStop('error', AUTH_FAILED, evidence);
        }

        if (principal.principalUrl === undefined || principal.principalHref === undefined) {
            throw new CheckStop('inconclusive', prose`current-user-principal was not returned (HTTP ${principal.status}).`, evidence);
        }
        evidence.principalPathShape = hrefShape(principal.principalHref);
        evidence.principalHrefAbsolute = /^https?:/i.test(principal.principalHref);
        const principalAllowed = isAllowedProbeUrl(principal.principalUrl);
        evidence.principalAllowedByHostRule = principalAllowed;
        if (!principalAllowed) {
            throw new CheckStop('refuted', prose`The principal URL is outside the fixed-host rule, so it was not contacted.`, evidence);
        }
        evidence.principalHostIsDiscoveryHost = hostOf(principal.principalUrl) === DISCOVERY_HOST;

        const home = await lookupHome(ctx, principal.principalUrl);
        evidence.principalPropfindStatus = home.status;
        ctx.state.schedulingProps = home.present;
        ctx.state.addresses = home.addresses;
        if (home.homeUrl === undefined || home.homeHref === undefined) {
            throw new CheckStop('inconclusive', prose`calendar-home-set was not returned (HTTP ${home.status}).`, evidence);
        }
        evidence.homePathShape = hrefShape(home.homeHref);
        evidence.homeHrefAbsolute = /^https?:/i.test(home.homeHref);
        evidence.homeHrefHasExplicitPort = /^https?:\/\/[^/]+:\d+/i.test(home.homeHref);
        const homeAllowed = isAllowedProbeUrl(home.homeUrl);
        evidence.homeAllowedByHostRule = homeAllowed;
        if (!homeAllowed) {
            throw new CheckStop('refuted', prose`calendar-home-set points outside the fixed-host rule, so it was not contacted.`, evidence);
        }
        const homeHost = hostOf(home.homeUrl);
        evidence.homeHostMatchesPerAccountPattern = isPerAccountHost(homeHost);
        evidence.homeHostIsDiscoveryHost = homeHost === DISCOVERY_HOST;
        ctx.state.principalUrl = principal.principalUrl;
        ctx.state.homeUrl = home.homeUrl.endsWith('/') ? home.homeUrl : `${home.homeUrl}/`;

        try {
            const homeOptions = await ctx.http.request({ method: 'OPTIONS', url: ctx.state.homeUrl });
            stopOnThrottle(ctx, homeOptions);
            evidence.homeOptionsStatus = homeOptions.status;
            ctx.state.homeDav = davTokens(homeOptions.headers.get('dav'));
        } catch (error) {
            if (!(error instanceof ProbeHttpError)) {
                throw error;
            }
            evidence.homeOptionsError = fixed(error.code);
        }

        if (isPerAccountHost(homeHost)) {
            return { outcome: 'confirmed', summary: prose`Discovery reached a calendar home on a host matching the pNN-caldav pattern (${principal.redirects} redirect(s) on the first step).`, evidence };
        }
        return { outcome: 'refuted', summary: prose`The calendar home is not on a pNN-caldav host.`, evidence };
    },
};

export const authCheck: CheckDef = {
    id: 'auth-app-password',
    planItem: 'What iCloud provides: Authentication (HTTP Basic with an app-specific password)',
    claim: 'HTTP Basic authentication with the Apple ID and the app-specific password exactly as typed is accepted on every request.',
    offline: true,
    async run(ctx) {
        const status = ctx.state.authStatus;
        const evidence: Evidence = {
            authSucceeded: status === 207,
            passwordContainsHyphens: ctx.credentials.appPassword.includes('-'),
            setCookieSeen: ctx.http.stats().headerNames.includes('set-cookie'),
        };
        if (status === 207) {
            return { outcome: 'confirmed', summary: prose`The supplied app-specific password was accepted. Other spellings (with or without hyphens) were deliberately not tried.`, evidence };
        }
        if (status === 401) {
            return { outcome: 'refuted', summary: prose`The server answered HTTP 401 to the supplied credentials.`, evidence };
        }
        return { outcome: 'inconclusive', summary: status === null ? prose`No authenticated response was received.` : prose`Discovery answered HTTP ${status}.`, evidence };
    },
};

export const davCapabilitiesCheck: CheckDef = {
    id: 'dav-capabilities',
    planItem: 'What iCloud provides: Invitations when an event with attendees is saved (capability tokens)',
    claim: 'The server advertises calendar-access in its DAV header; calendar-auto-schedule would indicate server-side invitation delivery (RFC 6638).',
    async run(ctx) {
        const root = ctx.state.rootDav;
        const home = ctx.state.homeDav;
        if (root === undefined && home === undefined) {
            throw new CheckStop('inconclusive', prose`No DAV header was received.`);
        }
        const all = new Set<string>([...(root?.tokens ?? []), ...(home?.tokens ?? [])]);
        const evidence: Evidence = {
            rootTokens: sortedSafe(root?.tokens ?? []),
            rootOtherTokenCount: root?.otherCount ?? 0,
            homeTokens: sortedSafe(home?.tokens ?? []),
            homeOtherTokenCount: home?.otherCount ?? 0,
            calendarAccess: all.has('calendar-access'),
            calendarAutoSchedule: all.has('calendar-auto-schedule'),
            calendarSchedule: all.has('calendar-schedule'),
        };
        if (all.has('calendar-access')) {
            return { outcome: 'confirmed', summary: prose`calendar-access advertised; calendar-auto-schedule ${all.has('calendar-auto-schedule') ? prose`advertised` : prose`not advertised`}.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`calendar-access is not advertised.`, evidence };
    },
};

export const schedulingPropsCheck: CheckDef = {
    id: 'scheduling-properties',
    planItem: 'What iCloud provides: Invitations when an event with attendees is saved (organizer properties)',
    claim: 'The principal exposes schedule-outbox-URL and calendar-user-address-set, which an organizer needs.',
    async run(ctx) {
        const present = ctx.state.schedulingProps;
        if (Object.keys(present).length === 0) {
            throw new CheckStop('inconclusive', prose`The principal properties were not read.`);
        }
        const mailto = ctx.state.addresses.filter((a) => /^mailto:/i.test(a)).length;
        const evidence: Evidence = { ...present, mailtoAddressCount: mailto, otherAddressCount: ctx.state.addresses.length - mailto };
        if (present['schedule-outbox-URL'] === true && present['calendar-user-address-set'] === true) {
            return { outcome: 'confirmed', summary: prose`Both present; ${mailto} mailto address(es) in calendar-user-address-set.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`schedule-outbox-URL or calendar-user-address-set is missing.`, evidence };
    },
};

export const stabilityCheck: CheckDef = {
    id: 'discovery-stability',
    planItem: 'Authentication and access control: stored principal and calendar-home URLs',
    claim: 'A second discovery returns the same principal URL and calendar-home URL, so storing them at login is safe.',
    needs: 'home',
    async run(ctx) {
        const principal = await lookupPrincipal(ctx);
        const principalStable = normalise(principal.principalUrl) === normalise(ctx.state.principalUrl);
        let homeStable = false;
        let homeStatus: number | null = null;
        if (principal.principalUrl !== undefined && isAllowedProbeUrl(principal.principalUrl)) {
            const home = await lookupHome(ctx, principal.principalUrl);
            homeStatus = home.status;
            const homeUrl = home.homeUrl === undefined ? undefined : home.homeUrl.endsWith('/') ? home.homeUrl : `${home.homeUrl}/`;
            homeStable = homeUrl !== undefined && normalise(homeUrl) === normalise(ctx.state.homeUrl);
        }
        const evidence: Evidence = { principalStatus: principal.status, homeStatus, principalStable, homeStable };
        if (principal.status !== 207) {
            return { outcome: 'inconclusive', summary: prose`The second discovery answered HTTP ${principal.status}.`, evidence };
        }
        if (principalStable && homeStable) {
            return { outcome: 'confirmed', summary: prose`Both URLs were identical on the second discovery.`, evidence };
        }
        return { outcome: 'refuted', summary: prose`The second discovery returned a different principal or calendar home.`, evidence };
    },
};
