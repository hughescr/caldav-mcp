import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { SCOPES } from '../src/auth/http';
import { PAGE_STYLE_SOURCE } from '../src/auth/page-style';
import { ACCOUNT_ID, callTool, checkboxes, issuer, post, setup, start, submit, tokenRequest, type Env } from './helpers/http-env';

const LABEL = {
    read: 'Read your calendars and events (always included)',
    write: 'Create and change events',
    delete: 'Delete events (whole events, single occurrences, or all following occurrences)',
    invite: 'Change events that involve other people. iCloud emails them at once: invitations, updates and cancellations from your Apple Account. Has effect only together with create/change or delete.',
};
const EVERY = 'calendar:read calendar:write calendar:delete calendar:invite';

let spies: Mock<(...args: unknown[]) => void>[] = [];
beforeEach(() => {
    spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => spyOn(console, method).mockImplementation(() => {}));
});
afterEach(() => {
    for (const spy of spies) { spy.mockRestore(); }
});

/** Every non-empty subset of the supported scopes, each in SCOPES order. */
function combinations(): string[][] {
    const out: string[][] = [];
    for (let mask = 1; mask < 1 << SCOPES.length; mask++) { out.push(SCOPES.filter((_scope, index) => mask & (1 << index))); }
    return out;
}

/** Submits the form and exchanges the code; returns the token response. */
async function grant(env: Env, grants?: string[]) {
    const redirect = await submit(env, await start(env), grants === undefined ? {} : { grants });
    expect(redirect.status).toBe(302);
    const response = await tokenRequest(env, new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '');
    expect(response.status).toBe(200);
    return await response.json() as { access_token: string; refresh_token: string; scope: string };
}

function refresh(env: Env, refreshToken: string, scope?: string) {
    return post(env.app, '/token', new URLSearchParams({ grant_type: 'refresh_token', client_id: env.params.get('client_id') ?? '', resource: `${issuer}/mcp`, refresh_token: refreshToken, ...(scope === undefined ? {} : { scope }) }));
}

/** The scopes of the current stored record of each id of one kind (these tests inject no store failures). */
async function storedScopes(env: Env, kind: 'grant' | 'code'): Promise<string[][]> {
    const ids = new Set(env.store.writes.flatMap(write => (JSON.parse(write) as { puts: { kind: string; id: string }[] }).puts.filter(put => put.kind === kind).map(put => put.id)));
    const records = await Promise.all([...ids].map(id => env.store.get(kind, id)));
    return records.map(record => (record && 'scopes' in record ? record.scopes : []));
}
const storedGrantScopes = (env: Env) => storedScopes(env, 'grant');

describe('consent page rows', () => {
    test('every requested-scope combination shows a fixed read row and one checkbox per other scope, in a fixed order', async () => {
        const combos = combinations();
        expect(combos).toHaveLength(15);
        for (const requested of combos) {
            // Request in reverse order: the page order comes from SCOPES, not from the request.
            const env = setup({ scope: [...requested].reverse().join(' ') });
            const { html } = await start(env);
            const kind = requested.join(' ');
            const offered = requested.filter(scope => scope !== 'calendar:read');
            expect(checkboxes(html), kind).toEqual(offered.map(value => ({ name: 'grant', value, checked: value !== 'calendar:invite' })));
            expect(html.includes(`<li class="permission"><span>${LABEL.read}<small>calendar:read</small></span></li>`), kind).toBe(requested.includes('calendar:read'));
            expect(html.match(/<li class="permission">/g)?.length ?? 0, kind).toBe(requested.includes('calendar:read') ? 1 : 0);
            expect(html.includes('<legend>Choose permissions</legend>'), kind).toBe(offered.length > 0);
            expect(html.includes('<h2>Requested permissions</h2>'), kind).toBe(offered.length === 0);
            expect(html, kind).not.toContain('allow_invite');
            expect(html, kind).not.toMatch(/<input[^>]*disabled/);
        }
    });

    test('each checkbox row carries its exact label and scope; only invite is sensitive and unticked', async () => {
        const { html } = await start(setup({ scope: EVERY }));
        expect(html).toContain(`<label class="permission"><input type="checkbox" name="grant" value="calendar:write" checked><span>${LABEL.write}<small>calendar:write</small></span></label>`);
        expect(html).toContain(`<label class="permission"><input type="checkbox" name="grant" value="calendar:delete" checked><span>${LABEL.delete}<small>calendar:delete</small></span></label>`);
        expect(html).toContain(`<label class="permission"><input type="checkbox" name="grant" value="calendar:invite"><span><em>Sensitive</em>${LABEL.invite}<small>calendar:invite</small></span></label>`);
        expect(html.indexOf('value="calendar:write"')).toBeLessThan(html.indexOf('value="calendar:delete"'));
        expect(html.indexOf('value="calendar:delete"')).toBeLessThan(html.indexOf('value="calendar:invite"'));
        // The rest of the page is unchanged: the help link, the texts and the two buttons follow the permissions.
        expect(html.indexOf('</fieldset>')).toBeLessThan(html.indexOf('Keep this connection for up to 180 days.'));
        expect(html).toContain('<button class="primary" name="decision" value="allow">Connect and allow</button>');
        expect(html).toContain('How do I generate an app-specific password?');
    });

    test('a muted line right under the permission rows says the choice replaces what the client was allowed before', async () => {
        for (const [scope, closing] of [[EVERY, '</fieldset>'], ['calendar:read', '</section>']] as const) {
            const { html, response } = await start(setup({ scope }));
            const line = '<p class="help">Your choice replaces what this client was allowed before.</p>';
            expect(html, scope).toContain(`${closing}${line}<p class="help">Keep this connection for up to 180 days.`);
            expect(html.split(line), scope).toHaveLength(2);
            expect(response.headers.get('content-security-policy'), scope).toContain(`style-src ${PAGE_STYLE_SOURCE};`);
            expect(html, scope).not.toContain('style=');
        }
    });
});

describe('granting', () => {
    test('the default ticks grant read, write and delete but never invite', async () => {
        const env = setup({ scope: EVERY });
        expect((await grant(env)).scope).toBe('calendar:delete calendar:read calendar:write');
        expect(await storedGrantScopes(env)).toEqual([['calendar:delete', 'calendar:read', 'calendar:write']]);
    });

    test('the granted subset flows into the code, the token response and the stored grant; unticked requests are dropped', async () => {
        const env = setup({ scope: EVERY });
        const redirect = await submit(env, await start(env), { grants: ['calendar:delete'] });
        expect(await storedScopes(env, 'code')).toEqual([['calendar:delete', 'calendar:read']]);
        const response = await tokenRequest(env, new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '');
        expect((await response.json()).scope).toBe('calendar:delete calendar:read');
        expect(await storedGrantScopes(env)).toEqual([['calendar:delete', 'calendar:read']]);
    });

    test('invite can be granted on its own when read is not requested', async () => {
        const env = setup({ scope: 'calendar:invite calendar:write' });
        expect((await grant(env, ['calendar:invite'])).scope).toBe('calendar:invite');
    });

    test('a read-only request needs no field and grants read', async () => {
        expect((await grant(setup({ scope: 'calendar:read' }))).scope).toBe('calendar:read');
    });

    test('refresh keeps the granted scopes, can narrow, and never widens back or to an unticked scope', async () => {
        const env = setup({ scope: EVERY });
        const tokens = await grant(env, ['calendar:write']);
        expect(tokens.scope).toBe('calendar:read calendar:write');
        for (const wider of ['calendar:read calendar:write calendar:delete', 'calendar:invite', 'calendar:read calendar:write calendar:invite']) {
            const refused = await refresh(env, tokens.refresh_token, wider);
            expect(refused.status, wider).toBe(400);
            expect(await refused.json(), wider).toEqual({ error: 'invalid_scope' });
        }
        const same = await refresh(env, tokens.refresh_token);
        expect(same.status).toBe(200);
        const kept = await same.json() as { refresh_token: string; scope: string };
        expect(kept.scope).toBe('calendar:read calendar:write');
        const narrowed = await refresh(env, kept.refresh_token, 'calendar:read');
        const narrow = await narrowed.json() as { refresh_token: string; scope: string };
        expect(narrow.scope).toBe('calendar:read');
        expect(await storedGrantScopes(env)).toEqual([['calendar:read']]);
        const back = await refresh(env, narrow.refresh_token, 'calendar:read calendar:write');
        expect(back.status).toBe(400);
        expect(await back.json()).toEqual({ error: 'invalid_scope' });
    });

    test('cancel ignores the checkboxes and grants nothing', async () => {
        const env = setup({ scope: EVERY });
        const cancel = await submit(env, await start(env), { decision: 'cancel', grants: ['calendar:invite', 'calendar:bogus'] });
        expect(cancel.status).toBe(302);
        expect(new URL(cancel.headers.get('location') ?? '').searchParams.get('error')).toBe('access_denied');
        expect(env.caldav.count()).toBe(0);
        expect(env.store.writes).toHaveLength(0);
    });
});

describe('tampered permission fields', () => {
    test('a value the page did not offer, a duplicate or an empty value is invalid_request before any store write or iCloud request', async () => {
        const cases: [string, string[]][] = [
            ['calendar:write calendar:invite', ['calendar:delete']],
            ['calendar:read', ['calendar:write']],
            ['calendar:read calendar:write', ['calendar:admin']],
            ['calendar:read calendar:write', ['']],
            ['calendar:read calendar:write', ['calendar:read']],
            ['calendar:read calendar:write', ['calendar:write', 'calendar:write']],
            ['calendar:read calendar:write calendar:delete', ['calendar:write', 'calendar:delete', 'calendar:write']],
            ['calendar:write', ['calendar:write ']],
            ['calendar:write', ['calendar:write calendar:delete']],
        ];
        for (const [scope, grants] of cases) {
            const env = setup({ scope });
            const response = await submit(env, await start(env), { grants });
            const kind = `${scope} / ${JSON.stringify(grants)}`;
            expect(response.status, kind).toBe(400);
            expect(await response.json(), kind).toEqual({ error: 'invalid_request' });
            expect(env.caldav.count(), kind).toBe(0);
            expect(env.store.writes, kind).toHaveLength(0);
        }
    });

    test('widening the bound scope field to make a tick valid fails the request binding', async () => {
        const env = setup({ scope: 'calendar:read calendar:write' });
        const form = await start(env);
        const response = await submit(env, form, { extra: { scope: EVERY }, grants: ['calendar:write', 'calendar:delete'] });
        expect(response.status).toBe(400);
        expect(env.caldav.count()).toBe(0);
        expect(env.store.writes).toHaveLength(0);
    });
});

describe('empty grant', () => {
    test('no permission chosen renders the fixed page, clears the flow, stores nothing and never contacts iCloud', async () => {
        const env = setup({ scope: 'calendar:write calendar:delete calendar:invite' });
        const form = await start(env);
        // Even a wrong password: the empty grant is decided before the allowlist, throttle and iCloud.
        const response = await submit(env, form, { grants: [], password: 'wrong-pass-word-0000' });
        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
        expect(response.headers.get('content-security-policy')).toBe(`default-src 'none'; style-src ${PAGE_STYLE_SOURCE}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
        const html = await response.text();
        expect(html).toContain('<h2 id="result">Choose at least one permission</h2><p>Nothing was saved and iCloud was not contacted. Start the connection again and tick at least one permission.</p>');
        expect(html).not.toContain('wrong-pass-word-0000');
        expect(env.caldav.count()).toBe(0);
        expect(env.store.writes).toHaveLength(0);
        expect(await env.store.get('throttle', ACCOUNT_ID)).toBeUndefined();
        expect(await env.store.get('connection', ACCOUNT_ID)).toBeUndefined();
    });

    test('a request that includes read is never empty: unticking everything still grants read', async () => {
        const env = setup({ scope: EVERY });
        expect((await grant(env, [])).scope).toBe('calendar:read');
    });
});

describe('tools refuse a token without the scope they need', () => {
    const READ_MESSAGE = 'Access denied. This tool requires calendar:read, which this connection was not granted. The user must reconnect this connector and, on the consent page, allow "Read your calendars and events" (the page always includes it when the client requests calendar:read).';

    test('a write-only grant cannot read, and the error names the missing scope and what the user must do', async () => {
        const env = setup({ scope: 'calendar:write' });
        const tokens = await grant(env);
        expect(tokens.scope).toBe('calendar:write');
        const reply = await (await callTool(env, tokens.access_token, 'list_calendars')).json();
        expect(reply.result.isError).toBe(true);
        expect(reply.result.structuredContent.error.code).toBe('insufficient_scope');
        expect(reply.result.structuredContent.error.message).toBe(`${READ_MESSAGE} Request ID: ${reply.result.structuredContent.error.request_id}.`);
        expect(env.caldav.count('listCalendars')).toBe(0);
    });

    test('narrowing a grant away from read on refresh refuses the new and the earlier access token on their next verification', async () => {
        const env = setup({ scope: 'calendar:read calendar:write' });
        const tokens = await grant(env);
        const narrowed = await (await refresh(env, tokens.refresh_token, 'calendar:write')).json() as { access_token: string; scope: string };
        expect(narrowed.scope).toBe('calendar:write');
        const reply = await (await callTool(env, narrowed.access_token, 'list_calendars')).json();
        expect(reply.result.structuredContent.error.code).toBe('insufficient_scope');
        expect(reply.result.structuredContent.error.message).toStartWith(READ_MESSAGE);
        // Each verification reads the grant's current scopes, so the narrowing also applies to the token issued before it.
        expect((await (await callTool(env, tokens.access_token, 'list_calendars')).json()).result.structuredContent.error.code).toBe('insufficient_scope');
        expect(env.caldav.count('listCalendars')).toBe(0);
    });
});
