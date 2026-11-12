import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { SCOPES } from '../src/auth/http';
import { insufficientScopeMessage, requiredScope } from '../src/mcp';
import type { BoundCalendarService } from '../src/calendar/service';
import { CALENDARS, callTool, connectOtherClient, issuer, post, setup, start, submit, tokenRequest, type Env } from './helpers/http-env';
// Every accepted consent submission starts a fresh authorization epoch (see "One consent per client"
// in docs/auth-design.md): the later submission wins, for a new flow and a resubmitted one alike.

let spies: Mock<(...args: unknown[]) => void>[] = [];
beforeEach(() => { spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => spyOn(console, method).mockImplementation(() => {})); });
afterEach(() => { for (const spy of spies) { spy.mockRestore(); } });

const WIDE = 'calendar:read calendar:write calendar:invite';
const sorted = (scope: string | readonly string[]) => (typeof scope === 'string' ? scope.split(' ') : [...scope]).sort();
interface Tokens { access_token: string; refresh_token: string; scope: string }

const codeOf = (redirect: Response) => new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '';

/** Posts the consent page with exactly these ticks and returns the response, whatever it is. */
async function consentPost(env: Env, form: Awaited<ReturnType<typeof start>>, grants: string[]) {
    return submit(env, form, { grants });
}

/** Completes the consent page with exactly these ticks and returns the redirect, without exchanging the code. */
async function consent(env: Env, grants: string[], form?: Awaited<ReturnType<typeof start>>) {
    const redirect = await consentPost(env, form ?? await start(env), grants);
    expect(redirect.status).toBe(302);
    return redirect;
}

async function exchange(env: Env, code: string): Promise<Tokens> {
    const response = await tokenRequest(env, code);
    expect(response.status).toBe(200);
    return await response.json() as Tokens;
}

function refresh(env: Env, refreshToken: string, scope?: string, clientId = env.params.get('client_id') ?? '') {
    return post(env.app, '/token', new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: `${issuer}/mcp`, ...(scope === undefined ? {} : { scope }) }));
}

async function expectInvalidGrant(response: Response) {
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_grant');
}

async function expectChallenge(response: Response) {
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`);
}

async function expectCalendars(env: Env, accessToken: string) {
    const response = await callTool(env, accessToken, 'list_calendars');
    expect(response.status).toBe(200);
    expect((await response.json()).result.structuredContent).toEqual({ calendars: CALENDARS, truncated: false });
}

const grantId = (env: Env, refreshToken: string) => env.crypto.readToken(refreshToken, 'refresh', 0).grantId;

describe('a new consent for the same client replaces what it was allowed before', () => {
    test('narrowing on reconnect: the older access token is refused, the older refresh is invalid_grant, the new grant has exactly the new scopes', async () => {
        const env = setup({ scope: WIDE });
        const wide = await exchange(env, codeOf(await consent(env, ['calendar:write', 'calendar:invite'])));
        expect(sorted(wide.scope)).toEqual(['calendar:invite', 'calendar:read', 'calendar:write']);
        await expectCalendars(env, wide.access_token);

        const narrow = await exchange(env, codeOf(await consent(env, [])));
        expect(narrow.scope).toBe('calendar:read');

        await expectChallenge(await callTool(env, wide.access_token, 'list_calendars'));
        await expect(env.runtime.engine.verifyAccess(wide.access_token)).rejects.toThrow('invalid_token');
        await expectInvalidGrant(await refresh(env, wide.refresh_token));
        // The refused refresh neither revived nor rotated the older grant record.
        expect(await env.store.get('grant', grantId(env, wide.refresh_token))).toMatchObject({ refreshGeneration: 0, scopes: ['calendar:invite', 'calendar:read', 'calendar:write'] });

        await expectCalendars(env, narrow.access_token);
        expect((await env.runtime.engine.verifyAccess(narrow.access_token)).scopes).toEqual(['calendar:read']);
        expect((await env.runtime.engine.verifyAccess(narrow.access_token, ['calendar:read', 'calendar:write']).catch((error: Error) => error.message))).toBe('invalid_token');
        const widened = await refresh(env, narrow.refresh_token, 'calendar:read calendar:write');
        expect(widened.status).toBe(400);
        expect((await widened.json()).error).toBe('invalid_scope');
        const renewed = await refresh(env, narrow.refresh_token);
        expect(renewed.status).toBe(200);
        expect((await renewed.json() as Tokens).scope).toBe('calendar:read');
    });

    test('widening on reconnect also replaces the earlier grant', async () => {
        const env = setup({ scope: WIDE });
        const narrow = await exchange(env, codeOf(await consent(env, [])));
        const wide = await exchange(env, codeOf(await consent(env, ['calendar:write'])));
        expect(sorted(wide.scope)).toEqual(['calendar:read', 'calendar:write']);
        await expectChallenge(await callTool(env, narrow.access_token, 'list_calendars'));
        await expectInvalidGrant(await refresh(env, narrow.refresh_token));
        await expectCalendars(env, wide.access_token);
    });

    test('a different client of the same account keeps its grant', async () => {
        const env = setup({ scope: WIDE });
        const mine = await exchange(env, codeOf(await consent(env, ['calendar:write'])));
        const other = await connectOtherClient(env, undefined, WIDE);
        await exchange(env, codeOf(await consent(env, [])));

        await expectChallenge(await callTool(env, mine.access_token, 'list_calendars'));
        await expectCalendars(env, other.tokens.access_token);
        expect(sorted((await env.runtime.engine.verifyAccess(other.tokens.access_token)).scopes)).toEqual(['calendar:read', 'calendar:write']);
        const renewed = await refresh(env, other.tokens.refresh_token, undefined, other.clientId);
        expect(renewed.status).toBe(200);
        await expectCalendars(env, (await renewed.json() as Tokens).access_token);
    });

    test('the replacement takes effect when the consent is submitted, so a client cannot keep the wider grant by not exchanging the new code', async () => {
        const env = setup({ scope: WIDE });
        const wide = await exchange(env, codeOf(await consent(env, ['calendar:write'])));
        const unexchanged = codeOf(await consent(env, []));

        await expectChallenge(await callTool(env, wide.access_token, 'list_calendars'));
        await expectInvalidGrant(await refresh(env, wide.refresh_token));
        // The code of the new consent stays the client's way back for its two minutes, with only the new choice.
        const narrow = await exchange(env, unexchanged);
        expect(narrow.scope).toBe('calendar:read');
        await expectCalendars(env, narrow.access_token);
    });

    test('an older outstanding code of the same client stops working when a newer consent is submitted', async () => {
        const env = setup({ scope: WIDE });
        const older = codeOf(await consent(env, ['calendar:write']));
        const newer = codeOf(await consent(env, []));
        const refused = await tokenRequest(env, older);
        expect(refused.status).toBe(400);
        expect((await refused.json()).error).toBe('invalid_grant');
        expect((await exchange(env, newer)).scope).toBe('calendar:read');
    });

    test('a consent that is not completed changes nothing: cancel, a wrong password and a forged form leave the earlier grant working', async () => {
        const env = setup({ scope: WIDE });
        const tokens = await exchange(env, codeOf(await consent(env, ['calendar:write'])));

        const cancelled = await submit(env, await start(env), { decision: 'cancel', grants: [] });
        expect(cancelled.status).toBe(302);
        expect(new URL(cancelled.headers.get('location') ?? '').searchParams.get('error')).toBe('access_denied');
        expect((await submit(env, await start(env), { password: 'wrong-pass-word-0000', grants: [] })).status).toBe(400);
        const form = await start(env);
        expect((await submit(env, { ...form, cookie: '' }, { grants: [] })).status).toBe(400);
        const crossSite = new URLSearchParams(form.fields); crossSite.delete('grant');
        expect((await post(env.app, '/auth/connect', crossSite, form.cookie, 'https://attacker.example')).status).toBe(400);

        await expectCalendars(env, tokens.access_token);
        expect(sorted((await env.runtime.engine.verifyAccess(tokens.access_token)).scopes)).toEqual(['calendar:read', 'calendar:write']);
        const renewed = await refresh(env, tokens.refresh_token);
        expect(renewed.status).toBe(200);
        await expectCalendars(env, (await renewed.json() as Tokens).access_token);
    });
});

describe('every accepted submission is a new epoch, a resubmission of the same flow included', () => {
    test('same flow, same ticks, submitted twice: the later submission wins and the first code is refused', async () => {
        const env = setup({ scope: WIDE });
        const form = await start(env);
        const first = codeOf(await consent(env, ['calendar:write'], form));
        const second = codeOf(await consent(env, ['calendar:write'], form));
        await expectInvalidGrant(await tokenRequest(env, first));
        const tokens = await exchange(env, second);
        expect(sorted(tokens.scope)).toEqual(['calendar:read', 'calendar:write']);
        await expectCalendars(env, tokens.access_token);
    });

    test('same flow, same ticks, resubmitted after the first code was exchanged: that grant stops working', async () => {
        const env = setup({ scope: WIDE });
        const form = await start(env);
        const tokens = await exchange(env, codeOf(await consent(env, ['calendar:write'], form)));
        await expectCalendars(env, tokens.access_token);
        const again = codeOf(await consent(env, ['calendar:write'], form));
        await expectChallenge(await callTool(env, tokens.access_token, 'list_calendars'));
        await expectInvalidGrant(await refresh(env, tokens.refresh_token));
        await expectCalendars(env, (await exchange(env, again)).access_token);
    });

    test('same flow, different ticks, wide code exchanged first: the wide grant stops working as soon as the narrow submission is accepted', async () => {
        const env = setup({ scope: WIDE });
        const form = await start(env);
        const wide = await exchange(env, codeOf(await consent(env, ['calendar:write'], form)));
        const narrowCode = codeOf(await consent(env, [], form));
        // Before the narrow code is exchanged.
        await expectChallenge(await callTool(env, wide.access_token, 'list_calendars'));
        await expect(env.runtime.engine.verifyAccess(wide.access_token)).rejects.toThrow('invalid_token');
        await expectInvalidGrant(await refresh(env, wide.refresh_token));
        const narrow = await exchange(env, narrowCode);
        expect(narrow.scope).toBe('calendar:read');
        await expectCalendars(env, narrow.access_token);
        await expectChallenge(await callTool(env, wide.access_token, 'list_calendars'));
    });

    test('same flow, different ticks, wide code exchanged after the narrow one: it is refused and the narrow grant keeps working', async () => {
        const env = setup({ scope: WIDE });
        const form = await start(env);
        const wideCode = codeOf(await consent(env, ['calendar:write'], form));
        const narrowCode = codeOf(await consent(env, [], form));
        const narrow = await exchange(env, narrowCode);
        await expectInvalidGrant(await tokenRequest(env, wideCode));
        await expectCalendars(env, narrow.access_token);
        expect((await env.runtime.engine.verifyAccess(narrow.access_token)).scopes).toEqual(['calendar:read']);
    });

    test('same flow, different ticks, neither exchanged yet: the wide code is refused even before the narrow one is exchanged', async () => {
        const env = setup({ scope: WIDE });
        const form = await start(env);
        const wideCode = codeOf(await consent(env, ['calendar:write'], form));
        const narrowCode = codeOf(await consent(env, [], form));
        await expectInvalidGrant(await tokenRequest(env, wideCode));
        expect((await exchange(env, narrowCode)).scope).toBe('calendar:read');
    });

    test('flow F, then flow G, then a replay of F: the replay is a new epoch that replaces G, and F\'s first code is not revived', async () => {
        const env = setup({ scope: WIDE });
        const flowF = await start(env);
        const wideCode = codeOf(await consent(env, ['calendar:write'], flowF));
        const narrow = await exchange(env, codeOf(await consent(env, [])));
        await expectCalendars(env, narrow.access_token);
        // The delayed duplicate POST of F still carries its cookie, CSRF binding and the password.
        const replayCode = codeOf(await consent(env, ['calendar:write'], flowF));
        await expectInvalidGrant(await tokenRequest(env, wideCode));
        await expectChallenge(await callTool(env, narrow.access_token, 'list_calendars'));
        await expectInvalidGrant(await refresh(env, narrow.refresh_token));
        const replayed = await exchange(env, replayCode);
        expect(sorted(replayed.scope)).toEqual(['calendar:read', 'calendar:write']);
        await expectCalendars(env, replayed.access_token);
        await expectInvalidGrant(await tokenRequest(env, wideCode));
    });

    test('flow F exchanged, then flow G, then a replay of F: the grant from F\'s first code stays dead', async () => {
        const env = setup({ scope: WIDE });
        const flowF = await start(env);
        const wide = await exchange(env, codeOf(await consent(env, ['calendar:write'], flowF)));
        await exchange(env, codeOf(await consent(env, [])));
        const replayCode = codeOf(await consent(env, ['calendar:write'], flowF));
        await expectChallenge(await callTool(env, wide.access_token, 'list_calendars'));
        await expectInvalidGrant(await refresh(env, wide.refresh_token));
        await exchange(env, replayCode);
        await expectChallenge(await callTool(env, wide.access_token, 'list_calendars'));
        await expectInvalidGrant(await refresh(env, wide.refresh_token));
    });
});

test('an /mcp request reads the grant, the connection and the consent record once each, strongly consistent and uncached', async () => {
    const env = setup({ scope: WIDE });
    const tokens = await exchange(env, codeOf(await consent(env, [])));
    const reads = spyOn(env.store, 'get');
    await expectCalendars(env, tokens.access_token);
    expect(reads.mock.calls.map(([kind]) => kind).sort()).toEqual(['connection', 'consent', 'grant']);
    // Never cached: a second request reads the consent record again, and a replacement in between ends it.
    await exchange(env, codeOf(await consent(env, ['calendar:write'])));
    reads.mockClear();
    await expectChallenge(await callTool(env, tokens.access_token, 'list_calendars'));
    expect(reads.mock.calls.map(([kind]) => kind).sort()).toEqual(['connection', 'consent', 'grant']);
    reads.mockRestore();
});

describe('two consent submissions racing at code issue', () => {
    test('the one that commits second gets the retryable 503 page, and only the winner\'s code works', async () => {
        const env = setup({ scope: WIDE });
        const form = await start(env);
        const reached = Promise.withResolvers<void>(); const released = Promise.withResolvers<void>();
        let held = false;
        env.store.beforeTransact = write => {
            if (held || !write.puts.some(record => record.kind === 'consent') || !write.puts.some(record => record.kind === 'code')) { return undefined; }
            held = true; reached.resolve(); return released.promise;
        };
        const loser = consentPost(env, form, ['calendar:write']);
        await reached.promise;
        const winner = codeOf(await consent(env, [], form));
        released.resolve();
        const page = await loser;
        expect(page.status).toBe(503);
        expect(page.headers.get('location')).toBeNull();
        expect(await page.text()).toContain('iCloud sign-in is temporarily unavailable. Try again later.');
        const tokens = await exchange(env, winner);
        expect(tokens.scope).toBe('calendar:read');
        expect((await env.runtime.engine.verifyAccess(tokens.access_token)).scopes).toEqual(['calendar:read']);
    });
});

describe('a refresh racing the replacement', () => {
    test('a replacement committed while a refresh of the older grant is in flight makes that refresh fail and cannot be undone by it', async () => {
        const env = setup({ scope: WIDE });
        const wide = await exchange(env, codeOf(await consent(env, ['calendar:write'])));
        let code = '';
        env.caldav.script('validate', async () => {
            // While the refresh checks the session with iCloud, the user completes a narrower consent.
            code = codeOf(await consent(env, []));
            return 'valid' as const;
        });
        await expectInvalidGrant(await refresh(env, wide.refresh_token));
        expect(code).not.toBe('');
        expect(await env.store.get('grant', grantId(env, wide.refresh_token))).toMatchObject({ refreshGeneration: 0, status: 'active' });
        await expectInvalidGrant(await refresh(env, wide.refresh_token));
        await expectChallenge(await callTool(env, wide.access_token, 'list_calendars'));
        const narrow = await exchange(env, code);
        expect(narrow.scope).toBe('calendar:read');
        await expectCalendars(env, narrow.access_token);
    });

    test('a refresh that commits while the replacement is in flight returns tokens that die when the replacement commits', async () => {
        const env = setup({ scope: WIDE });
        const wide = await exchange(env, codeOf(await consent(env, ['calendar:write'])));
        let rotated: Tokens | undefined;
        env.caldav.script('validate', async () => {
            // The consent's code issue checks the session; meanwhile the client refreshes its older grant.
            const response = await refresh(env, wide.refresh_token);
            expect(response.status).toBe(200);
            rotated = await response.json() as Tokens;
            return 'valid' as const;
        });
        const code = codeOf(await consent(env, []));
        if (!rotated) { throw new Error('the racing refresh did not run'); }
        await expectChallenge(await callTool(env, rotated.access_token, 'list_calendars'));
        await expectInvalidGrant(await refresh(env, rotated.refresh_token));
        const narrow = await exchange(env, code);
        expect(narrow.scope).toBe('calendar:read');
        await expectCalendars(env, narrow.access_token);
    });
});

describe('every tool refuses a token without the scope it needs, in both protocol eras', () => {
    const range = { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' };
    /** Valid arguments per tool, so the scope check, not input validation, is what refuses the call. */
    const ARGS: Record<keyof BoundCalendarService, Record<string, unknown>> = {
        list_calendars: {},
        list_events: { range },
        search_events: { range, query: 'x' },
        get_event: { calendar_id: '/1/calendars/home/', resource_href: '/1/calendars/home/e.ics' },
        get_event_attachment_download: { calendar_id: '/1/calendars/home/', resource_href: '/1/calendars/home/e.ics', attachment_ref: `a1_${'A'.repeat(43)}` },
    };
    const ERAS = ['2025-11-25', '2026-07-28'] as const;

    function mcp(env: Env, token: string, protocol: string, method: string, params: Record<string, unknown> = {}) {
        const modern = protocol === '2026-07-28';
        return env.app.request('/mcp', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
                ...(modern ? { 'Mcp-Method': method, ...(typeof params['name'] === 'string' ? { 'Mcp-Name': params['name'] } : {}) } : {}),
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: modern ? { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: protocol, [CLIENT_INFO_META_KEY]: { name: 'test', version: '0' }, [CLIENT_CAPABILITIES_META_KEY]: {} } } : params }),
        });
    }

    /** A real token for every supported scope except `missing`. */
    async function tokenWithout(missing: string): Promise<{ env: Env; tokens: Tokens }> {
        const scope = SCOPES.filter(value => value !== missing).join(' ');
        const env = setup({ scope });
        const tokens = await exchange(env, codeOf(await consent(env, SCOPES.filter(value => value !== missing && value !== 'calendar:read'))));
        expect(sorted(tokens.scope)).toEqual(sorted(scope));
        return { env, tokens };
    }

    test('the matrix covers every listed tool', async () => {
        const { env, tokens } = await tokenWithout('calendar:invite');
        for (const protocol of ERAS) {
            const response = await mcp(env, tokens.access_token, protocol, 'tools/list');
            expect(response.status).toBe(200);
            const names = (await response.json()).result.tools.map((tool: { name: string }) => tool.name).sort();
            expect(names).toEqual(Object.keys(requiredScope).sort());
            expect(Object.keys(ARGS).sort()).toEqual(names);
        }
    });

    for (const [name, scopes] of Object.entries(requiredScope) as [keyof BoundCalendarService, readonly string[]][]) {
        for (const missing of scopes) {
            test(`${name} without ${missing}`, async () => {
                const { env, tokens } = await tokenWithout(missing);
                const before = env.caldav.count();
                for (const protocol of ERAS) {
                    const response = await mcp(env, tokens.access_token, protocol, 'tools/call', { name, arguments: ARGS[name] });
                    expect(response.status).toBe(200);
                    const reply = await response.json();
                    expect(reply.error).toBeUndefined();
                    expect(reply.result.isError).toBe(true);
                    const error = reply.result.structuredContent.error;
                    expect(error.code).toBe('insufficient_scope');
                    expect(error.message).toBe(`${insufficientScopeMessage([missing])} Request ID: ${error.request_id}.`);
                }
                expect(env.caldav.count()).toBe(before);
            });
        }
    }
});
