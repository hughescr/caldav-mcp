import type { Context } from 'hono';
import { accountIdFor, normalizeAppleId } from '../account';
import { CalDavError, type Discovery } from '../caldav/contracts';
import { isAllowedCalDavUrl } from '../caldav/hosts';
import type { AuthRuntime } from './runtime';
import { AUTH_FIELDS, authorization, form, required, unique, type Authorization } from './http';
import { connectionAAD, digest, equal, randomId } from './crypto';
import { OAuthError, type Connection, type Sealed, type UpstreamCredentials } from './contracts';
import { LoginThrottle, type LoginReservation } from './throttle';
import { PAGE_STYLE, PAGE_STYLE_SOURCE } from './page-style';
const COOKIE = '__Host-caldav-flow';
/** The flow cookie never carries credentials: the password exists only in the connect POST and the sealed store record. */
interface Flow { deadline: number; csrf: string; flowId: string; binding: string }
const now = () => Math.floor(Date.now() / 1000);
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
const binding = (auth: Authorization) => digest(JSON.stringify(AUTH_FIELDS.map(key => [key, auth.fields[key] ?? null])));
const SCOPE_TEXT: Record<string, string> = {
    'calendar:read': 'Read your calendars and events',
    'calendar:write': 'Create, change and delete events',
    'calendar:invite': 'Save events with attendees, which can send invitations from your Apple Account',
};
/** Apple's article on what app-specific passwords are and how to create one. A fixed constant: never built from request data. */
const APPLE_HELP_URL = 'https://support.apple.com/102654';
const FAILED ='Sign-in failed. Check the Apple ID and app-specific password, then start the connection again.';
const THROTTLED = 'Too many failed sign-in attempts for this Apple ID. Wait 15 minutes, then start the connection again.';
const UNAVAILABLE = 'iCloud sign-in is temporarily unavailable. Try again later.';
function cookie(context: Context, runtime: AuthRuntime, flow?: Flow) {
    const value = flow ? Buffer.from(JSON.stringify(runtime.crypto.seal('browser-flow', JSON.stringify([runtime.issuer, 1]), flow))).toString('base64url') : '';
    if (value.length > 3800) { throw new OAuthError('invalid_request'); }
    context.header('Set-Cookie', `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${flow ? Math.max(0, flow.deadline - now()) : 0}`);
}
function read(context: Context, runtime: AuthRuntime): Flow {
    try {
        const entries = (context.req.header('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
        if (entries.length !== 1) { throw new Error(); }
        const sealed = JSON.parse(Buffer.from((entries[0] ?? '').slice(COOKIE.length + 1), 'base64url').toString('utf8')) as Sealed;
        const flow = runtime.crypto.open<Flow>('browser-flow', JSON.stringify([runtime.issuer, 1]), sealed);
        if (!Number.isSafeInteger(flow.deadline) || flow.deadline <= now() || flow.deadline > now() + 600 || typeof flow.csrf !== 'string' || typeof flow.binding !== 'string') { throw new Error(); }
        return flow;
    } catch { throw new OAuthError('invalid_request'); }
}
function page(context: Context, title: string, body: string, callbackOrigin?: string) {
    context.header('Content-Security-Policy', `default-src 'none'; style-src ${PAGE_STYLE_SOURCE}; form-action 'self'${callbackOrigin ? ` ${callbackOrigin}` : ''}; frame-ancestors 'none'; base-uri 'none'`);
    context.header('Referrer-Policy', 'same-origin');
    return context.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · caldav-mcp</title><style>${PAGE_STYLE}</style></head><body><main><header><div class="brand">caldav-mcp</div><h1>${escape(title)}</h1></header>${body}</main></body></html>`);
}
/** Terminal pages are static text: they never echo a submitted field, so they cannot reflect a password. */
const FAILURE_HEADING = { 400: 'Sign-in failed', 429: 'Please wait', 503: 'Temporary failure · 503' } as const;
function failure(context: Context, runtime: AuthRuntime, status: 400 | 429 | 503, message: string) {
    cookie(context, runtime);
    context.status(status);
    return page(context, 'Connection not completed', `<section class="terminal" aria-labelledby="result"><h2 id="result">${FAILURE_HEADING[status]}</h2><p>${escape(message)}</p></section>`);
}
function render(context: Context, runtime: AuthRuntime, auth: Authorization, flow: Flow) {
    cookie(context, runtime, flow);
    const hidden = [...Object.entries(auth.fields), ['csrf', flow.csrf]].map(([key, value]) => `<input type="hidden" name="${escape(key ?? '')}" value="${escape(value ?? '')}">`).join('');
    const identity = auth.client.clientId.startsWith('https://') ? new URL(auth.client.clientId).hostname : 'Registered OAuth client';
    // Requested scopes are plain list rows, not inputs: there is no choice to make about them.
    const scopes = auth.scopes.map(scope => `<li class="permission"><span>${escape(SCOPE_TEXT[scope] ?? scope)}<small>${escape(scope)}</small></span></li>`).join('');
    const invite = auth.scopes.includes('calendar:invite') ? '<label class="permission"><input type="checkbox" name="allow_invite" value="yes" required><span><em>Sensitive</em>Allow saving events that can send invitations to other people</span></label>' : '';
    return page(context, 'Connect your iCloud calendar', [
        `<div class="request"><strong>${escape(auth.client.name)}</strong> (${escape(identity)}) requests access to your iCloud calendar<small>Redirect destination · <span class="host">${escape(new URL(auth.redirectUri).hostname)}</span></small></div>`,
        `<form method="post" action="/auth/connect">${hidden}`,
        '<section class="section"><h2>Sign in to iCloud</h2>',
        '<label class="field" for="apple">Apple ID <input id="apple" name="apple_id" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="255" required></label>',
        // The help link sits after the input in the DOM so tabbing from the field never detours through it; CSS order puts it in the label row. It is outside the label so clicking it cannot focus the field.
        `<div class="field row"><label for="password">App-specific password</label><input id="password" name="app_password" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="256" aria-describedby="password-help" required><a class="aside" href="${APPLE_HELP_URL}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">How do I generate an app-specific password?</a></div>`,
        '<p id="password-help" class="help">Use one made only for this connector. Never use your main Apple Account password.</p></section>',
        `<section class="permissions"><h2>Requested permissions</h2><div class="rows"><ul>${scopes}</ul>${invite}</div></section>`,
        '<p class="help">Keep this connection for up to 180 days. iCloud may require reconnection sooner, for example if the app-specific password is revoked.</p>',
        '<p class="privacy">Your password is stored encrypted and used only to talk to iCloud.</p>',
        '<div class="actions"><button class="primary" name="decision" value="allow">Connect and allow</button>',
        '<button class="secondary" name="decision" value="cancel" formnovalidate>Cancel</button></div></form>',
    ].join(''), new URL(auth.redirectUri).origin);
}
function redirect(context: Context, runtime: AuthRuntime, auth: Authorization, values: Record<string, string>) {
    context.header('Referrer-Policy', 'no-referrer');
    cookie(context, runtime); const target = new URL(auth.redirectUri);
    for (const [key, value] of Object.entries({ ...values, iss: runtime.issuer, ...(auth.fields.state === undefined ? {} : { state: auth.fields.state }) })) { target.searchParams.set(key, value); }
    return context.redirect(target.href, 302);
}
export async function beginBrowser(context: Context, runtime: AuthRuntime) {
    const auth = await authorization(runtime, unique(new URL(context.req.url).searchParams));
    return render(context, runtime, auth, { deadline: now() + 600, csrf: randomId(), flowId: randomId(), binding: binding(auth) });
}
/** Proves the credentials with iCloud. Any error object is dropped here: it might carry request data. */
async function discover(runtime: AuthRuntime, appleId: string, appPassword: string): Promise<Discovery | 'unauthorized' | 'unavailable'> {
    let discovery: Discovery;
    try { discovery = await runtime.caldav.discover({ appleId, appPassword }); }
    catch (error) { return error instanceof CalDavError && error.code === 'unauthorized' ? 'unauthorized' : 'unavailable'; }
    if (typeof discovery?.principalUrl !== 'string' || typeof discovery.calendarHomeUrl !== 'string' || !isAllowedCalDavUrl(discovery.principalUrl) || !isAllowedCalDavUrl(discovery.calendarHomeUrl)) { return 'unavailable'; }
    return { principalUrl: discovery.principalUrl, calendarHomeUrl: discovery.calendarHomeUrl };
}
/** Duplicate delivery detection only. A retired key or damaged old ciphertext must not block a fresh replacement. */
function identicalActive(runtime: AuthRuntime, previous: Connection | undefined, candidate: UpstreamCredentials): boolean {
    if (!previous || previous.status !== 'active' || previous.expiresAt <= now()) { return false; }
    let stored: UpstreamCredentials;
    try { stored = runtime.crypto.open<UpstreamCredentials>('upstream-credentials', connectionAAD(previous), previous.credentials); }
    catch { return false; }
    return stored.accountId === candidate.accountId && stored.appleId === candidate.appleId && typeof stored.appPassword === 'string' && equal(stored.appPassword, candidate.appPassword)
        && stored.principalUrl === candidate.principalUrl && stored.calendarHomeUrl === candidate.calendarHomeUrl;
}
export async function postBrowser(context: Context, runtime: AuthRuntime) {
    if (context.req.header('origin') !== runtime.issuer) { throw new OAuthError('invalid_request'); }
    const fields = await form(context.req.raw); const flow = read(context, runtime); const auth = await authorization(runtime, fields);
    if (!equal(flow.csrf, required(fields, 'csrf')) || !equal(flow.binding, binding(auth))) { throw new OAuthError('invalid_request'); }
    if (fields.decision === 'cancel') { return redirect(context, runtime, auth, { error: 'access_denied' }); }
    if (fields.decision !== 'allow') { throw new OAuthError('invalid_request'); }
    if (auth.scopes.includes('calendar:invite') && fields.allow_invite !== 'yes') { throw new OAuthError('invalid_request'); }
    // Syntax, allowlist and wrong-password failures share one static page and status. Timing and the
    // throttle still distinguish an allowlisted Apple ID from others (an accepted limitation).
    const appleId = normalizeAppleId((fields.apple_id ?? '').slice(0, 512));
    const appPassword = (fields.app_password ?? '').trim();
    if (appleId === undefined || appPassword.length === 0 || appPassword.length > 256) { return failure(context, runtime, 400, FAILED); }
    const accountId = accountIdFor(appleId);
    // The allowlist is checked before any upstream request or store write.
    if (!runtime.allowedAccountIds.has(accountId)) { return failure(context, runtime, 400, FAILED); }
    // The attempt is counted before iCloud sees it, so concurrent requests cannot exceed the budget.
    const throttle = new LoginThrottle(runtime.store);
    let reservation: LoginReservation | 'throttled';
    try { reservation = await throttle.reserve(accountId); } catch { return failure(context, runtime, 503, UNAVAILABLE); }
    if (reservation === 'throttled') { return failure(context, runtime, 429, THROTTLED); }
    const discovery = await discover(runtime, appleId, appPassword);
    // A failed sign-in keeps its reservation. Anything else returns the slot, best effort:
    // a lost release only costs the account one attempt until the window ends.
    if (discovery === 'unauthorized') { return failure(context, runtime, 400, FAILED); }
    try { await throttle.release(reservation); } catch { /* fail closed: the slot stays counted */ }
    if (discovery === 'unavailable') { return failure(context, runtime, 503, UNAVAILABLE); }
    const credentials: UpstreamCredentials = { accountId, appleId, appPassword, principalUrl: discovery.principalUrl, calendarHomeUrl: discovery.calendarHomeUrl, issuedAt: now() };
    let code: string;
    try { code = await store(runtime, auth, credentials); } catch (error) {
        // Fixed pages for the expected outcomes after discovery: a concurrent reconnect or a
        // session check that now fails (invalid_grant), or a temporary store/upstream error.
        if (!(error instanceof OAuthError)) { throw error; }
        return error.error === 'temporarily_unavailable' ? failure(context, runtime, 503, UNAVAILABLE) : failure(context, runtime, 400, FAILED);
    }
    return redirect(context, runtime, auth, { code });
}
/** Stores the iCloud-proven credential and issues the authorization code. */
async function store(runtime: AuthRuntime, auth: Authorization, credentials: UpstreamCredentials): Promise<string> {
    const { accountId } = credentials;
    const record = await runtime.store.get('connection', accountId);
    if (record && (record.kind !== 'connection' || record.accountId !== accountId)) { throw new OAuthError('temporarily_unavailable'); }
    const previous = record?.kind === 'connection' ? record : undefined;
    // Duplicate delivery of an identical, still-active credential must not rotate the canonical
    // generation: that would end the grants of every client already using it and invalidate an
    // already returned code. issueCode re-validates the session and conditions its write on the
    // unchanged connection. Anything else is a fresh, iCloud-proven replacement, which ends every
    // earlier grant for the account.
    const connection = previous && identicalActive(runtime, previous, credentials) ? previous : await runtime.engine.connectOrReconnect({ accountId, credentials, expiresAt: now() + 180 * 86400, ...(previous ? { expectedCredentialGeneration: previous.credentialGeneration } : {}) });
    return runtime.engine.issueCode({ client: auth.client, connectionId: connection.id, redirectUri: auth.redirectUri, resource: auth.resource, scopes: auth.scopes, challenge: auth.challenge });
}
