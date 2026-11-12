import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { TemporaryUnavailable } from '../src/auth/contracts';
import { PAGE_STYLE, PAGE_STYLE_SOURCE } from '../src/auth/page-style';
import { setup, start, submit, type Env } from './helpers/http-env';

const APPLE_HELP_URL = 'https://support.apple.com/102654';
/** The one allowed outbound link: a fixed constant, a new tab, no opener, no referrer. */
const HELP_LINK = /<a [^>]*>How do I generate an app-specific password\?<\/a>/;

let spies: Mock<(...args: unknown[]) => void>[] = [];
beforeEach(() => {
    spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => spyOn(console, method).mockImplementation(() => {}));
});
afterEach(() => {
    for (const spy of spies) { spy.mockRestore(); }
});

/** One HTML response of every page kind the browser flow can serve. */
async function pages(): Promise<Record<string, Response>> {
    const plain = setup({ scope: 'calendar:read calendar:write' });
    const invite = setup({ scope: 'calendar:read calendar:invite' });
    const wrong = setup(); wrong.caldav.setPassword('calendar.user@example.invalid', 'something-else-entirely');
    const throttled = setup();
    for (let index = 0; index < 5; index++) { await submit(throttled, await start(throttled), { password: 'wrong-pass-word-0000' }); }
    const unavailable: Env = setup(); unavailable.store.failTransact = write => write.puts.some(put => put.kind === 'connection') ? new TemporaryUnavailable() : undefined;
    return {
        form: (await start(plain)).response,
        'form with invite checkbox': (await start(invite)).response,
        'sign-in failed (400)': await submit(wrong, await start(wrong)),
        'throttled (429)': await submit(throttled, await start(throttled)),
        'unavailable (503)': await submit(unavailable, await start(unavailable)),
    };
}

describe('page style and its Content-Security-Policy hash', () => {
    test('the style source is the SHA-256 of the exact style text', () => {
        expect(PAGE_STYLE_SOURCE).toBe(`'sha256-${createHash('sha256').update(PAGE_STYLE, 'utf8').digest('base64')}'`);
    });

    test('every page kind carries exactly one style block that the CSP allows by hash and nothing broader', async () => {
        const all = await pages();
        expect(Object.keys(all)).toHaveLength(5);
        for (const [kind, response] of Object.entries(all)) {
            const html = await response.text();
            expect(response.headers.get('content-type'), kind).toContain('text/html');
            const blocks = [...html.matchAll(/<style>([^]*?)<\/style>/g)];
            expect(blocks, kind).toHaveLength(1);
            expect(html.match(/<style/g), kind).toHaveLength(1);
            const recomputed = `'sha256-${createHash('sha256').update(blocks[0]?.[1] ?? '', 'utf8').digest('base64')}'`;
            const csp = response.headers.get('content-security-policy') ?? '';
            expect(csp, kind).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/]{43}='; form-action 'self'( \S+)?; frame-ancestors 'none'; base-uri 'none'$/);
            expect(csp, kind).toContain(`style-src ${recomputed};`);
            expect(csp, kind).not.toMatch(/unsafe|nonce|script-src|img-src|font-src|connect-src/);
            expect(response.headers.get('referrer-policy'), kind).toBe('same-origin');
        }
    });

    test('no page has a style attribute, script, external reference or url() resource', async () => {
        for (const [kind, response] of Object.entries(await pages())) {
            const html = await response.text();
            const markup = html.replace(/<style>[^]*?<\/style>/, '');
            expect(markup, kind).not.toMatch(/\sstyle\s*=/i);
            // The only reference a page may carry is the one fixed help link, and only on the form (see the next test).
            const unlinked = html.replace(HELP_LINK, '');
            expect(unlinked, kind).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|<svg|<base|\ssrc\s*=|\shref\s*=|javascript:|\son[a-z]+\s*=/i);
            // Hidden OAuth parameters legitimately hold URLs as values; nothing else may name one.
            expect(unlinked.replace(/ value="[^"]*"/g, ''), kind).not.toMatch(/https?:\/\/|\/\/[a-z]/i);
            expect(html, kind).not.toMatch(/url\(|@import|@font-face/i);
        }
    });

    test('every page kind is the same brand shell with the shared heading structure', async () => {
        for (const [kind, response] of Object.entries(await pages())) {
            const html = await response.text();
            expect(html, kind).toMatch(/^<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>[^<]+ · caldav-mcp<\/title><style>/);
            expect(html, kind).toContain('<header><div class="brand">caldav-mcp</div><h1>');
        }
    });

    test('the permission list rows are plain text and only the invitation acknowledgment is a checkbox', async () => {
        const all = await pages();
        const plain = await all.form?.text() ?? '';
        const invite = await all['form with invite checkbox']?.text() ?? '';
        expect(plain.match(/type="checkbox"/g)).toBeNull();
        expect(invite.match(/type="checkbox"/g)).toHaveLength(1);
        expect(invite).toContain('<em>Sensitive</em>');
        expect(plain).not.toContain('<em>Sensitive</em>');
    });

    test('only the sign-in form carries the app-specific password help link, and it is outside every label', async () => {
        const all = await pages();
        for (const [kind, response] of Object.entries(all)) {
            const html = await response.text();
            const anchors = html.match(/<a[\s>]/g) ?? [];
            if (!kind.startsWith('form')) { expect(anchors, kind).toHaveLength(0); continue; }
            expect(anchors, kind).toHaveLength(1);
            expect(html.match(/\shref\s*=/g), kind).toHaveLength(1);
            const link = HELP_LINK.exec(html)?.[0] ?? '';
            expect(link, kind).toBe(`<a class="aside" href="${APPLE_HELP_URL}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">How do I generate an app-specific password?</a>`);
            // Not a descendant of any <label>: clicking it must not focus a field.
            for (const label of html.matchAll(/<label\b[^]*?<\/label>/g)) { expect(label[0], kind).not.toContain('<a '); }
            expect(html.match(/<\/?label\b/g)?.length, kind).toBe(2 * (html.match(/<label\b/g)?.length ?? 0));
            // DOM order is Apple ID, password, link: tabbing out of the password field reaches the link last.
            expect(html.indexOf('id="apple"'), kind).toBeLessThan(html.indexOf('id="password"'));
            expect(html.indexOf('id="password"'), kind).toBeLessThan(html.indexOf(link));
            expect(html, kind).toContain('<label for="password">App-specific password</label>');
        }
    });
});
