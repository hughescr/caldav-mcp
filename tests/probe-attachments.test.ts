/**
 * Attachment evidence: the read-only census and fetch, the --write managed-attachment and inline
 * checks, and the rules they must keep (counts and fixed enums only from the owner's data, requests
 * and credentials only to hosts the guard allows, writes only in probe calendars, cleanup on every path).
 */
import { describe, expect, test } from 'bun:test';
import {
    attachForm, classifyHost, classifyUrl, declaredSize, inlineSize, isFetchable, sizeBucket, typeClass,
} from '../scripts/probe/attachments';
import { PROBE_FILE_NAME, PROBE_FILE_TEXT, dispositionOf } from '../scripts/probe/checks/write-attachments';
import { ProbeHttp, ProbeHttpError, type HttpMode } from '../scripts/probe/http';
import { parseIcal, prop } from '../scripts/probe/ical';
import { Taint } from '../scripts/probe/safe';
import { PROBE_VERSION } from '../scripts/probe/version';
import { FAKE_NOW, FakeICloud, PLAIN, seedAttachment, seedEvent, standardAccount, type FakeBehaviour, type FakeICloud as Fake } from './fixtures/probe/fake-icloud';
import { READ_ONLY, WRITE, check, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const DAY = 86_400_000;
const ALLOWED_HOSTS = new Set(['caldav.icloud.com', 'p42-caldav.icloud.com']);
const NOT_FETCHED_HOSTS = ['p42-content.icloud-content.com', 'files.example.invalid', 'example.invalid', 'example.com'];

const managedLine = (id: string, host: string, extra = ''): string => `ATTACH;MANAGED-ID=${id};FMTTYPE=text/plain;SIZE=100;FILENAME=Secret-name.txt${extra}:https://${host}/10000000001/attachments/${id}/Secret-name.txt`;

/** An account whose single calendar holds one event per list of ATTACH lines. */
function account(attach: string[][], behaviour: Partial<FakeBehaviour> = {}): Fake {
    return new FakeICloud({
        ...creds, dsid: PLAIN.dsid, behaviour,
        calendars: [{
            id: 'home', displayName: 'Home',
            events: attach.map((lines, i) => ({ name: `e${i}.ics`, ical: seedEvent({ uid: `e${i}`, summary: 'Secret title', start: FAKE_NOW + (i + 1) * DAY, attach: lines }) })),
        }],
    });
}

/** Evidence as plain data (its strings are branded, which a literal in an assertion is not). */
const flat = (evidence: object): Record<string, unknown> => ({ ...evidence });

const attachmentGets = (fake: Fake): { url: URL; range: string | null }[] => fake.requests
    .filter((r) => r.method === 'GET' && r.url.pathname.includes('/attachments/'))
    .map((r) => ({ url: r.url, range: r.headers.get('range') }));

function onlyAllowedHosts(fake: Fake): void {
    expect(fake.requests.filter((r) => !ALLOWED_HOSTS.has(r.url.hostname)).map((r) => r.url.hostname)).toEqual([]);
}

describe('attachment read-back equality', () => {
    for (const fault of ['duplicate', 'missing-fmttype', 'parameter-case'] as const) {
        test(`ATTACH comparison handles ${fault}`, async () => {
            const fake = standardAccount(PLAIN, { transformResponse: async (req, res) => {
                if (req.method !== 'GET' || !req.url.pathname.endsWith('-attinline.ics')) { return res; }
                const text = await res.text();
                const changed = fault === 'duplicate' ? text.replace(/(ATTACH[^\r\n]*(?:\r\n [^\r\n]*)*)/, '$1\r\n$1')
                    : fault === 'missing-fmttype' ? text.replace(';FMTTYPE=text/plain', '')
                        : text.replace('ENCODING=BASE64;VALUE=BINARY;FMTTYPE=text/plain', 'ENCODING=base64;VALUE=binary;FMTTYPE=TEXT/PLAIN');
                return new Response(changed, { status: res.status, headers: res.headers });
            } });
            expect(check(await probe(fake, WRITE, creds), 'write-attachment-inline').outcome).toBe(fault === 'parameter-case' ? 'confirmed' : 'refuted');
        });
    }
});

describe('attachment write provenance', () => {
    for (const fault of ['redirect', 'uid', 'mixed-uid', 'after-remove'] as const) {
        test(`${fault} cannot publish owner attachment values or fetch its URL`, async () => {
            let removed = false;
            const owner = seedEvent({ uid: 'owner', summary: 'Private', start: FAKE_NOW, attach: [managedLine('owner-id', 'p42-caldav.icloud.com').replace('SIZE=100', 'SIZE=987654')] });
            const fake = standardAccount(PLAIN, {
                hook: (req) => {
                    if (req.method === 'POST' && req.url.searchParams.get('action') === 'attachment-remove') { removed = true; }
                    if (fault === 'redirect' && req.method === 'GET' && /-att(managed|inline|external)\.ics$/.test(req.url.pathname)) { return new Response(null, { status: 302, headers: { location: '/10000000001/calendars/home/owner.ics' } }); }
                    if (req.url.pathname.endsWith('/owner.ics')) { return new Response(owner); }
                    return undefined;
                },
                transformResponse: async (req, res) => {
                    if (req.method !== 'GET' || !/-att(managed|inline|external)\.ics$/.test(req.url.pathname) || fault === 'redirect' || (fault === 'after-remove' && !removed)) { return res; }
                    const text = await res.text();
                    return new Response(fault === 'mixed-uid' ? text.replace('END:VCALENDAR', owner.replace(/^[\s\S]*?BEGIN:VEVENT/, 'BEGIN:VEVENT').replace('END:VCALENDAR', '')) + 'END:VCALENDAR\r\n' : owner, { status: res.status, headers: res.headers });
                },
            });
            const report = await probe(fake, WRITE, creds);
            const result = check(report, 'write-attachment-managed');
            expect(result.outcome).toBe('inconclusive');
            expect(JSON.stringify(result.evidence)).not.toContain('987654');
            expect(fake.requests.some((r) => r.url.pathname.includes('/attachments/owner-id/'))).toBe(false);
            if (fault !== 'after-remove') {
                expect(result.evidence).not.toHaveProperty('declaredSize');
                expect(check(report, 'write-attachment-inline').outcome).toBe('inconclusive');
            }
            expect(report.cleanup?.allRemoved).toBe(true);
        });
    }
});

describe('classification', () => {
    test('host classes', () => {
        const cases: [string, string][] = [
            ['caldav.icloud.com', 'caldav-root'], ['p42-caldav.icloud.com', 'caldav-partition'], ['p7-caldav.icloud.com', 'caldav-partition'],
            ['www.icloud.com', 'icloud-other'], ['icloud.com', 'icloud-other'], ['p42-content.icloud-content.com', 'icloud-content'],
            ['icloud-content.com', 'icloud-content'], ['www.apple.com', 'apple-other'], ['x.me.com', 'apple-other'], ['mac.com', 'apple-other'],
            ['example.com', 'other'], ['evil-icloud.com', 'other'], ['icloud.com.evil.example', 'other'], ['pxx-caldav.icloud.com', 'icloud-other'], ['', 'unparseable'],
        ];
        for (const [host, expected] of cases) {
            expect({ host, class: classifyHost(host) }).toEqual({ host, class: expected as never });
        }
    });

    test('scheme and host class of a URI value', () => {
        expect(classifyUrl('https://p42-caldav.icloud.com:443/1/a')).toEqual({ scheme: 'https', host: 'caldav-partition' });
        expect(classifyUrl('http://caldav.icloud.com/x')).toEqual({ scheme: 'http', host: 'caldav-root' });
        expect(classifyUrl('ftp://example.com/x')).toEqual({ scheme: 'other', host: 'other' });
        expect(classifyUrl('cid:part1@example.com')).toEqual({ scheme: 'other', host: 'unparseable' });
        expect(classifyUrl('not a url')).toEqual({ scheme: 'other', host: 'unparseable' });
        expect(classifyUrl('/relative/path', 'https://caldav.icloud.com/a')).toEqual({ scheme: 'https', host: 'caldav-root' });
    });

    test('only URLs the host guard allows are fetchable', () => {
        expect(isFetchable('https://p42-caldav.icloud.com:443/1/attachments/a/b.txt')).toBe(true);
        expect(isFetchable('https://caldav.icloud.com/a')).toBe(true);
        for (const url of ['http://caldav.icloud.com/a', 'https://p42-content.icloud-content.com/a', 'https://p42-caldav.icloud.com:8443/a', 'https://user@caldav.icloud.com/a', 'https://caldav.icloud.com/a%2Fb', 'https://example.invalid/probe.txt']) {
            expect({ url, fetchable: isFetchable(url) }).toEqual({ url, fetchable: false });
        }
    });

    test('size buckets, declared and estimated sizes, media type classes, ATTACH forms', () => {
        const edges: [number | null, string][] = [
            [0, 'lt64KiB'], [65_535, 'lt64KiB'], [65_536, 'lt1MiB'], [1_048_575, 'lt1MiB'], [1_048_576, 'lt5MiB'], [5_242_879, 'lt5MiB'],
            [5_242_880, 'lt20MiB'], [20_971_519, 'lt20MiB'], [20_971_520, 'ge20MiB'], [null, 'missingOrInvalid'], [-1, 'missingOrInvalid'], [Number.NaN, 'missingOrInvalid'],
        ];
        for (const [bytes, bucket] of edges) {
            expect({ bytes, bucket: sizeBucket(bytes) }).toEqual({ bytes, bucket: bucket as never });
        }
        const p = (params: Record<string, string>, value = 'x') => ({ name: 'ATTACH', params, value });
        expect(declaredSize(p({ SIZE: '1234' }))).toBe(1234);
        expect(declaredSize(p({ SIZE: '12.5' }))).toBeNull();
        expect(declaredSize(p({ SIZE: '-3' }))).toBeNull();
        expect(declaredSize(p({}))).toBeNull();
        expect(inlineSize(p({}, 'aGVsbG8='))).toBe(5);
        expect(inlineSize(p({}, 'aGVsbG8'))).toBe(5);
        expect(inlineSize(p({}, 'aGV sbG8=\r\n'))).toBe(5);
        expect(inlineSize(p({}, 'not*base64'))).toBeNull();
        expect(typeClass('image/png')).toBe('image');
        expect(typeClass('TEXT/Plain; charset=utf-8')).toBe('text');
        expect(typeClass('application/pdf')).toBe('application');
        expect(typeClass('audio/mpeg')).toBe('audio');
        expect(typeClass('video/mp4')).toBe('video');
        expect(typeClass('x-secret/thing')).toBe('other');
        expect(typeClass('weird')).toBe('other');
        expect(typeClass('')).toBe('missing');
        expect(typeClass(null)).toBe('missing');
        expect(attachForm(p({ ENCODING: 'BASE64', 'MANAGED-ID': 'a' }))).toBe('inline-binary');
        expect(attachForm(p({ VALUE: 'binary' }))).toBe('inline-binary');
        expect(attachForm(p({ 'MANAGED-ID': 'a' }))).toBe('uri-managed');
        expect(attachForm(p({ VALUE: 'URI' }))).toBe('uri-unmanaged');
    });

    test('what a server did with an ATTACH it was sent', () => {
        const ical = (line: string) => parseIcal(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n${line}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)?.components[0]?.properties.filter((x) => x.name === 'ATTACH') ?? [];
        const sent = { form: 'uri-unmanaged' as const, value: 'https://example.invalid/probe.txt' };
        expect(dispositionOf(sent, ical('ATTACH:https://example.invalid/probe.txt'))).toBe('preserved');
        expect(dispositionOf(sent, [])).toBe('dropped');
        expect(dispositionOf(sent, ical('ATTACH:https://example.invalid/other.txt'))).toBe('modified');
        expect(dispositionOf(sent, ical('ATTACH;MANAGED-ID=abc:https://p42-caldav.icloud.com/x'))).toBe('converted-to-managed');
        expect(dispositionOf({ form: 'inline-binary', value: 'aGk=', params: { ENCODING: 'BASE64', VALUE: 'BINARY' } }, ical('ATTACH;ENCODING=BASE64;VALUE=BINARY:aGk='))).toBe('preserved');
        expect(dispositionOf({ form: 'inline-binary', value: 'aGk=', params: { ENCODING: 'BASE64', VALUE: 'BINARY' } }, ical('ATTACH;MANAGED-ID=abc:https://p42-caldav.icloud.com/x'))).toBe('converted-to-managed');
        expect(dispositionOf({ form: 'inline-binary', value: 'aGk=', params: { ENCODING: 'BASE64', VALUE: 'BINARY' } }, ical('ATTACH;ENCODING=BASE64;VALUE=BINARY:aGkx'))).toBe('modified');
    });

    test('the probe file is 32 bytes of ASCII', () => {
        expect(Buffer.byteLength(PROBE_FILE_TEXT, 'utf8')).toBe(32);
        expect(PROBE_FILE_TEXT.length).toBe(32);
        expect(PROBE_FILE_NAME).toBe('probe-attachment.txt');
        expect(PROBE_VERSION).toBe('0.5.0');
    });
});

describe('HTTP layer: the one POST that is allowed, and truncated bodies', () => {
    const HOME = 'https://p42-caldav.icloud.com/10000000001/calendars/';
    const PROBE = `${HOME}caldav-mcp-probe-0a1b2c3d/`;

    function setup(mode: HttpMode, respond: (req: Request) => Response = () => new Response('ok', { status: 207 })) {
        const sent: { method: string; url: string }[] = [];
        const http = new ProbeHttp({
            fetch: async (input, init) => {
                const req = new Request(input, init);
                sent.push({ method: req.method, url: req.url });
                return respond(req);
            },
            now: () => 1_000_000,
            sleep: async () => undefined,
            auth: { appleId: 'user@example.invalid', appPassword: 'abcd-efgh-ijkl-mnop' },
            mode,
            taint: new Taint(),
            limits: { minIntervalMs: 0, maxRequests: 50, reserveRequests: 5, maxBodyBytes: 1024 },
        });
        return { http, sent };
    }

    async function code(promise: Promise<unknown>): Promise<string> {
        try {
            await promise;
            return 'resolved';
        } catch (error) {
            return error instanceof ProbeHttpError ? error.code : 'other';
        }
    }

    test('write mode: only attachment actions on an event inside a registered probe calendar', async () => {
        const { http, sent } = setup('write');
        http.registerProbeCollection(PROBE, HOME);
        const event = `${PROBE}caldav-mcp-probe-0a1b2c3d-attm.ics`;
        expect(await code(http.request({ method: 'POST', url: `${event}?action=attachment-add`, body: 'x', headers: { 'content-type': 'text/plain' } }))).toBe('resolved');
        expect(await code(http.request({ method: 'POST', url: `${event}?action=attachment-remove&managed-id=AB-12_x.y` }))).toBe('resolved');
        expect(sent.length).toBe(2);
        const refused: [string, string][] = [
            [event, 'method_not_allowed'],
            [`${event}?action=attachment-add&x=1`, 'method_not_allowed'],
            [`${event}?action=attachment-remove`, 'method_not_allowed'],
            [`${event}?action=attachment-remove&managed-id=`, 'method_not_allowed'],
            [`${event}?action=attachment-remove&managed-id=a/b`, 'method_not_allowed'],
            [`${event}?action=attachment-remove&managed-id=a%2Fb`, 'forbidden_host'],
            [`${event}?action=attachment-remove&managed-id=a&x=b`, 'method_not_allowed'],
            [`${event}?action=attachment-update`, 'method_not_allowed'],
            [`${event}?action=attachment-add#x`, 'resolved'],
            [`${PROBE}?action=attachment-add`, 'write_outside_probe_calendar'],
            [`${PROBE}sub/e.ics?action=attachment-add`, 'write_outside_probe_calendar'],
            [`${HOME}home/e.ics?action=attachment-add`, 'write_outside_probe_calendar'],
            [`${HOME}caldav-mcp-probe-ffffffff/e.ics?action=attachment-add`, 'write_outside_probe_calendar'],
            ['https://evil.example/x.ics?action=attachment-add', 'forbidden_host'],
            [`https://p42-content.icloud-content.com/x.ics?action=attachment-add`, 'forbidden_host'],
        ];
        for (const [url, expected] of refused) {
            expect({ url: url.replace(HOME, '<home>'), code: await code(http.request({ method: 'POST', url })) }).toEqual({ url: url.replace(HOME, '<home>'), code: expected });
        }
    });

    test('read and cleanup modes never POST', async () => {
        for (const mode of ['read', 'cleanup'] as const) {
            const { http, sent } = setup(mode);
            expect(await code(http.request({ method: 'POST', url: `${PROBE}e.ics?action=attachment-add`, body: 'x' }))).toBe('method_not_allowed');
            expect(sent.length).toBe(0);
        }
    });

    test('a 401 on a POST latches the run like any other, and the temporary calendar can still be deleted once', async () => {
        const { http, sent } = setup('write', (req) => (req.method === 'POST' ? new Response('no', { status: 401 }) : new Response(null, { status: 204 })));
        http.registerProbeCollection(PROBE, HOME);
        const event = `${PROBE}caldav-mcp-probe-0a1b2c3d-attm.ics`;
        expect((await http.request({ method: 'POST', url: `${event}?action=attachment-add`, body: 'x' })).status).toBe(401);
        expect(http.credentialsRejected).toBe(true);
        expect(await code(http.request({ method: 'GET', url: event }))).toBe('unauthorized');
        expect(await code(http.request({ method: 'POST', url: `${event}?action=attachment-remove&managed-id=a` }))).toBe('unauthorized');
        expect(await code(http.request({ method: 'DELETE', url: PROBE, essential: true }))).toBe('resolved');
        expect(sent.map((s) => s.method)).toEqual(['POST', 'DELETE']);
    });

    test('maxBytes cuts the body instead of failing at the body cap', async () => {
        const { http } = setup('read', () => new Response('x'.repeat(5000), { status: 200, headers: { 'content-length': '5000' } }));
        const cut = await http.request({ method: 'GET', url: `${HOME}x`, maxBytes: 16 });
        expect(cut.truncated).toBe(true);
        expect(cut.body.length).toBe(16);
        expect(cut.headers.get('content-length')).toBe('5000');
        expect(await code(http.request({ method: 'GET', url: `${HOME}x` }))).toBe('body_too_large');
        const small = setup('read', () => new Response('abc', { status: 200 }));
        const whole = await small.http.request({ method: 'GET', url: `${HOME}x`, maxBytes: 16 });
        expect(whole).toMatchObject({ truncated: false, body: 'abc' });
    });

    test('followRedirects: false returns a redirect to the caller without following it', async () => {
        const { http, sent } = setup('read', () => new Response(null, { status: 302, headers: { location: 'https://p42-content.icloud-content.com/x' } }));
        const res = await http.request({ method: 'GET', url: `${HOME}x`, followRedirects: false });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('https://p42-content.icloud-content.com/x');
        expect(sent.length).toBe(1);
    });
});

/** Seven events, one per interesting ATTACH shape. */
const CENSUS_ATTACH = [
    [managedLine('M1', 'p42-caldav.icloud.com:443', ';X-APPLE-FILENAME=Secret-name.txt').replace('FMTTYPE=text/plain', 'FMTTYPE=image/png')],
    [`ATTACH;MANAGED-ID=M2;FMTTYPE=application/pdf;SIZE=3000000:https://p01-content.icloud-content.com/Secret/path/file.pdf`],
    ['ATTACH;ENCODING=BASE64;VALUE=BINARY;FMTTYPE=text/plain;X-SECRET-PARAM=Secret:aGVsbG8=', 'ATTACH:https://files.example.com/Secret-name.pdf'],
    ['ATTACH;FMTTYPE=weird:http://caldav.icloud.com/Secret'],
    ['ATTACH;MANAGED-ID=M5;FMTTYPE=video/mp4;SIZE=notanumber:https://www.icloud.com/Secret'],
];

describe('attachment-census: counts and fixed enums from the strictness census’s own responses', () => {
    test('counts every form, host class, parameter, size bucket and media type class', async () => {
        const fake = account(CENSUS_ATTACH);
        seedAttachment(fake, 'M1', 'x'.repeat(100));
        const report = await probe(fake, READ_ONLY, creds);
        const result = check(report, 'attachment-census');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence).toMatchObject({
            censusRead: true, calendarsQueried: 1, calendarsRead: 1, resources: 5, vevents: 5, veventsWithAttach: 5, attachProperties: 6, maxAttachPerVevent: 2,
            forms: { 'inline-binary': 1, 'uri-managed': 3, 'uri-unmanaged': 2 },
            uriManagedBySchemeClass: { https: 3, http: 0, other: 0 },
            uriUnmanagedBySchemeClass: { https: 1, http: 1, other: 0 },
            uriManagedByHostClass: { 'caldav-root': 0, 'caldav-partition': 1, 'icloud-other': 1, 'icloud-content': 1, 'apple-other': 0, other: 0, unparseable: 0 },
            uriUnmanagedByHostClass: { 'caldav-root': 1, 'caldav-partition': 0, 'icloud-other': 0, 'icloud-content': 0, 'apple-other': 0, other: 1, unparseable: 0 },
            parameterPresence: { fmttype: 5, size: 3, filename: 1, managedId: 3, xAppleFilename: 1, otherXParameter: 1 },
            declaredSizeBuckets: { lt64KiB: 1, lt1MiB: 0, lt5MiB: 1, lt20MiB: 0, ge20MiB: 0, missingOrInvalid: 3 },
            inlineDecodedSizeBuckets: { lt64KiB: 1, lt1MiB: 0, lt5MiB: 0, lt20MiB: 0, ge20MiB: 0, missingOrInvalid: 0 },
            fmttypeTopLevel: { application: 1, image: 1, text: 1, audio: 0, video: 1, other: 1, missing: 1 },
            managedWithGuardAllowedHost: 1,
        });
        // Nothing from the account's attachments is in the evidence: no name, URL, host, id or media type.
        const text = JSON.stringify(report.checks.filter((c) => c.id.startsWith('attachment-')));
        for (const secret of ['Secret', 'secret', 'example.com', 'icloud-content', 'p01-content', 'M1', 'M2', 'M5', 'pdf', 'png', 'SECRET-PARAM', 'weird', 'caldav.icloud.com/', '10000000001']) {
            expect(text).not.toContain(secret.replace('icloud-content', 'icloud-content.com'));
        }
        expect(report.redaction.scrubbedOccurrences).toBe(0);
    });

    test('adds no request: it reads the strictness census’s wide responses', async () => {
        const fake = account(CENSUS_ATTACH);
        await probe(fake, READ_ONLY, creds);
        const wide = fake.requests.filter((r) => r.method === 'REPORT' && /start="(\d{8})T\d{6}Z" end="(\d{8})/.test(r.body) && wideRange(r.body) > 2000);
        expect(wide.map((r) => r.url.pathname.split('/').at(-2))).toEqual(['home']);
        const plain = account(CENSUS_ATTACH.map(() => []));
        await probe(plain, READ_ONLY, creds);
        expect(fake.requests.length - plain.requests.length).toBeLessThanOrEqual(2);
    });

    test('all attachments managed on guard-allowed hosts: confirmed; none at all: inconclusive; a refusal to read: inconclusive', async () => {
        const all = account([[managedLine('A1', 'p42-caldav.icloud.com')], [managedLine('A2', 'caldav.icloud.com')]]);
        const report = await probe(all, READ_ONLY, creds);
        expect(check(report, 'attachment-census').outcome).toBe('confirmed');
        expect(check(report, 'attachment-census').evidence).toMatchObject({ attachProperties: 2, managedWithGuardAllowedHost: 2 });
        const none = await probe(account([[], []]), READ_ONLY, creds);
        expect(check(none, 'attachment-census').outcome).toBe('inconclusive');
        expect(check(none, 'attachment-census').evidence).toMatchObject({ attachProperties: 0, resources: 2, forms: { 'inline-binary': 0, 'uri-managed': 0, 'uri-unmanaged': 0 } });
        const broken = standardAccount(PLAIN, { hook: (req) => (req.method === 'REPORT' && req.body.includes('calendar-query') ? new Response('x', { status: 500 }) : undefined) });
        expect(check(await probe(broken, READ_ONLY, creds), 'attachment-census').outcome).toBe('inconclusive');
    });

    test('it sends nothing, so it still reports after a 401 that cut the wide query short; the fetch check is skipped; before the calendars are known it is skipped', async () => {
        let wide = 0;
        const fake = new FakeICloud({
            ...creds, dsid: PLAIN.dsid,
            behaviour: { hook: (req) => (req.method === 'REPORT' && wideRange(req.body) > 2000 && ++wide === 2 ? new Response('Unauthorized', { status: 401 }) : undefined) },
            calendars: [
                { id: 'home', displayName: 'Home', events: [{ name: 'e.ics', ical: seedEvent({ uid: 'e', summary: 'x', start: FAKE_NOW + DAY, attach: [managedLine('F1', 'p42-caldav.icloud.com')] }) }] },
                { id: 'second', displayName: 'Second', events: [{ name: 'f.ics', ical: seedEvent({ uid: 'f', summary: 'y', start: FAKE_NOW + DAY }) }] },
            ],
        });
        const report = await probe(fake, READ_ONLY, creds);
        expect(report.auth.rejected).toBe(true);
        expect(check(report, 'attachment-census').outcome).toBe('inconclusive');
        expect(check(report, 'attachment-census').evidence).toMatchObject({ censusRead: true, calendarsQueried: 2, calendarsRead: 1, attachProperties: 1 });
        expect(check(report, 'attachment-fetch').outcome).toBe('skipped');
        expect(attachmentGets(fake)).toEqual([]);
        const early = standardAccount(PLAIN, { hook: (_req, n) => (n > 6 ? new Response('Unauthorized', { status: 401 }) : undefined) });
        expect(check(await probe(early, READ_ONLY, creds), 'attachment-census').outcome).toBe('skipped');
    });

    test('a large inline attachment is neither tainted nor recorded', async () => {
        const big = 'QUJD'.repeat(40_000);
        const fake = account([[`ATTACH;ENCODING=BASE64;VALUE=BINARY:${big}`]]);
        const report = await probe(fake, READ_ONLY, creds);
        expect(check(report, 'attachment-census').evidence).toMatchObject({ forms: { 'inline-binary': 1, 'uri-managed': 0, 'uri-unmanaged': 0 }, inlineDecodedSizeBuckets: { lt1MiB: 1, lt64KiB: 0 } });
        expect(JSON.stringify(report)).not.toContain('QUJDQUJD');
    });
});

function wideRange(body: string): number {
    const match = /start="(\d{8})T\d{6}Z" end="(\d{8})T\d{6}Z"/.exec(body);
    const parse = (v: string): number => Date.UTC(Number(v.slice(0, 4)), Number(v.slice(4, 6)) - 1, Number(v.slice(6, 8)));
    return match?.[1] === undefined || match[2] === undefined ? 0 : Math.round((parse(match[2]) - parse(match[1])) / DAY);
}

function managedAccount(behaviour: Partial<FakeBehaviour> = {}, line = managedLine('F1', 'p42-caldav.icloud.com:443')): Fake {
    const fake = account([[line]], behaviour);
    seedAttachment(fake, 'F1', 'x'.repeat(100));
    return fake;
}

describe('attachment-fetch: one guarded GET with Range: bytes=0-0', () => {
    test('a managed attachment on the partition host answers 206; only classes, booleans and statuses are recorded', async () => {
        const fake = managedAccount();
        const report = await probe(fake, READ_ONLY, creds);
        const result = check(report, 'attachment-fetch');
        expect(result.outcome).toBe('confirmed');
        expect(flat(result.evidence)).toEqual({
            requests: 1, status: 206, redirected: false, redirectHostClass: 'none', redirectSchemeClass: 'none', redirectFollowed: false, finalStatus: 206,
            contentLengthPresent: true, contentRangePresent: true, acceptRangesPresent: true, contentTypeClass: 'text',
            declaredSizePresent: true, sizeMatchesDeclared: true, bodyTruncated: false,
        });
        const gets = attachmentGets(fake);
        expect(gets.length).toBe(1);
        expect(gets[0]?.range).toBe('bytes=0-0');
        expect(gets[0]?.url.hostname).toBe('p42-caldav.icloud.com');
        onlyAllowedHosts(fake);
        expect(report.redaction.scrubbedOccurrences).toBe(0);
        expect(JSON.stringify(result.evidence)).not.toMatch(/Secret|F1|icloud|10000000001/);
    });

    test('a declared SIZE that differs from the server’s total is a recorded false; a missing one is null', async () => {
        const wrong = await probe(managedAccount({}, managedLine('F1', 'p42-caldav.icloud.com').replace('SIZE=100', 'SIZE=99')), READ_ONLY, creds);
        expect(check(wrong, 'attachment-fetch').evidence).toMatchObject({ declaredSizePresent: true, sizeMatchesDeclared: false });
        const none = await probe(managedAccount({}, managedLine('F1', 'p42-caldav.icloud.com').replace(';SIZE=100', '')), READ_ONLY, creds);
        expect(check(none, 'attachment-fetch').evidence).toMatchObject({ declaredSizePresent: false, sizeMatchesDeclared: null });
    });

    test('a server that ignores Range answers 200: the total comes from Content-Length and no Range headers are present', async () => {
        const report = await probe(managedAccount({ attachmentGet: 'ignores-range' }), READ_ONLY, creds);
        expect(check(report, 'attachment-fetch').outcome).toBe('confirmed');
        expect(check(report, 'attachment-fetch').evidence).toMatchObject({ status: 200, contentRangePresent: false, acceptRangesPresent: false, contentLengthPresent: true, sizeMatchesDeclared: true });
    });

    test('a redirect inside the allowed hosts is followed once; the target is recorded by class only', async () => {
        const fake = managedAccount({ attachmentGet: 'redirect-allowed' });
        const report = await probe(fake, READ_ONLY, creds);
        expect(check(report, 'attachment-fetch').outcome).toBe('confirmed');
        expect(check(report, 'attachment-fetch').evidence).toMatchObject({ requests: 2, status: 302, redirected: true, redirectHostClass: 'caldav-partition', redirectSchemeClass: 'https', redirectFollowed: true, finalStatus: 206 });
        expect(attachmentGets(fake).length).toBe(2);
        onlyAllowedHosts(fake);
    });

    test('a redirect to icloud-content.com is classified and not followed: no request, no credentials reach that host', async () => {
        const fake = managedAccount({ attachmentGet: 'redirect-content' });
        const report = await probe(fake, READ_ONLY, creds);
        expect(check(report, 'attachment-fetch').outcome).toBe('inconclusive');
        expect(check(report, 'attachment-fetch').evidence).toMatchObject({ requests: 1, status: 302, redirected: true, redirectHostClass: 'icloud-content', redirectSchemeClass: 'https', redirectFollowed: false, finalStatus: 302 });
        expect(attachmentGets(fake).length).toBe(1);
        onlyAllowedHosts(fake);
        expect(fake.requests.some((r) => NOT_FETCHED_HOSTS.includes(r.url.hostname))).toBe(false);
    });

    test('managed attachments only on other hosts: nothing is requested (host-not-allowed); none at all: none-found', async () => {
        const elsewhere = account([[managedLine('F1', 'p42-content.icloud-content.com')], [managedLine('F2', 'files.example.com')]]);
        const report = await probe(elsewhere, READ_ONLY, creds);
        expect(check(report, 'attachment-fetch').outcome).toBe('inconclusive');
        expect(flat(check(report, 'attachment-fetch').evidence)).toEqual({ reason: 'host-not-allowed', managedAttachmentsFound: 2, requests: 0 });
        expect(attachmentGets(elsewhere)).toEqual([]);
        onlyAllowedHosts(elsewhere);
        const unmanaged = account([['ATTACH:https://p42-caldav.icloud.com/x/y.txt']]);
        const none = await probe(unmanaged, READ_ONLY, creds);
        expect(flat(check(none, 'attachment-fetch').evidence)).toEqual({ reason: 'none-found', managedAttachmentsFound: 0, requests: 0 });
        expect(attachmentGets(unmanaged)).toEqual([]);
        const plain = await probe(standardAccount(), READ_ONLY, creds);
        expect(check(plain, 'attachment-fetch').evidence).toMatchObject({ reason: 'none-found' });
    });

    test('a managed attachment on http, a port, or an encoded slash is not requested even on an iCloud host name', async () => {
        for (const url of ['http://p42-caldav.icloud.com/1/attachments/F1/a.txt', 'https://p42-caldav.icloud.com:8443/1/attachments/F1/a.txt', 'https://p42-caldav.icloud.com/1/attachments/F1%2Fa.txt']) {
            const fake = account([[`ATTACH;MANAGED-ID=F1;SIZE=100:${url}`]]);
            seedAttachment(fake, 'F1', 'x'.repeat(100));
            const report = await probe(fake, READ_ONLY, creds);
            expect(check(report, 'attachment-fetch').evidence).toMatchObject({ reason: 'host-not-allowed', requests: 0 });
            expect(attachmentGets(fake)).toEqual([]);
        }
    });

    test('a 403 refutes the claim and the run carries on', async () => {
        const report = await probe(managedAccount({ attachmentGet: 'forbidden' }), READ_ONLY, creds);
        expect(check(report, 'attachment-fetch').outcome).toBe('refuted');
        expect(check(report, 'attachment-fetch').evidence).toMatchObject({ status: 403, finalStatus: 403 });
        expect(report.auth.rejected).toBe(false);
        expect(check(report, 'sync-collection').outcome).toBe('confirmed');
    });

    test('a 401 is a recorded answer and, like every 401, stops the run (the message says what it saw)', async () => {
        const fake = managedAccount({ attachmentGet: 'unauthorized' });
        const report = await probe(fake, READ_ONLY, creds);
        expect(check(report, 'attachment-fetch').evidence).toMatchObject({ status: 401 });
        expect(report.auth).toEqual({ rejected: true, onFirstRequest: false });
        expect(check(report, 'sync-collection').outcome).toBe('skipped');
        expect(attachmentGets(fake).length).toBe(1);
    });

    test('a throttled answer stops the check and records Retry-After', async () => {
        const fake = managedAccount({ hook: (req) => (req.url.pathname.includes('/attachments/') ? new Response('slow down', { status: 503, headers: { 'retry-after': '7' } }) : undefined) });
        const report = await probe(fake, READ_ONLY, creds);
        expect(check(report, 'attachment-fetch').outcome).toBe('inconclusive');
        expect(check(report, 'attachment-fetch').evidence).toMatchObject({ status: 503, retryAfterSeconds: 7 });
    });

    test('a huge answer that ignores Range is cut, never read whole', async () => {
        const fake = managedAccount({ hook: (req) => (req.url.pathname.includes('/attachments/') ? new Response('y'.repeat(2_000_000), { status: 200, headers: { 'content-type': 'image/png' } }) : undefined) });
        const report = await probe(fake, READ_ONLY, creds);
        expect(check(report, 'attachment-fetch').outcome).toBe('confirmed');
        expect(check(report, 'attachment-fetch').evidence).toMatchObject({ bodyTruncated: true, contentTypeClass: 'image', sizeMatchesDeclared: null });
    });
});

const POSTS = (fake: Fake): { method: string; url: URL }[] => fake.requests.filter((r) => r.method === 'POST');
const eventRequests = (fake: Fake, stem: string): string[] => fake.requests.filter((r) => r.url.pathname.includes(`-${stem}.ics`)).map((r) => r.method);
const probeCalendarsLeft = (fake: Fake): string[] => [...fake.calendars.keys()].filter((id) => id.startsWith('caldav-mcp-probe-'));
const run = async (behaviour: Partial<FakeBehaviour> = {}): Promise<{ report: Awaited<ReturnType<typeof probe>>; fake: Fake }> => {
    const fake = standardAccount(PLAIN, behaviour);
    return { report: await probe(fake, WRITE, creds), fake };
};

describe('write-attachment-managed: POST ?action=attachment-add and -remove on a probe event', () => {
    test('works end to end: added, read back, fetched with credentials, removed, and gone', async () => {
        const { report, fake } = await run();
        const result = check(report, 'write-attachment-managed');
        expect(result.outcome).toBe('confirmed');
        expect(flat(result.evidence)).toEqual({
            managedAttachmentsAdvertised: true, putStatus: 201, addStatus: 201, calManagedIdHeaderPresent: true, locationHeaderPresent: true, representationReturned: true,
            eventStatus: 200, attachCount: 1, attachForm: 'uri-managed', attachParameterNames: ['FILENAME', 'FMTTYPE', 'MANAGED-ID', 'SIZE'], declaredSize: 32,
            declaredSizeEqualsUploaded: true, fmttype: 'text/plain', filenameEqualsUploaded: true, urlSchemeClass: 'https', urlHostClass: 'caldav-partition',
            managedIdEqualsHeader: true, etagChanged: true, attachmentProvenanceVerified: true,
            urlHostMasked: 'pN-caldav.icloud.com', pathSegmentCount: 4, pathSegmentClasses: ['digits', 'literal:attachments', 'uuid', 'filename'],
            managedIdInPath: true, managedIdInQuery: false, principalIdPresent: true, queryPresent: false, queryParameterNames: [],
            matchedAnonymous: false, matchedAuthenticated: true, matchedRedirect: false,
            anonymousStatus: 401, anonymousContentLengthPresent: false, anonymousContentRangePresent: false, anonymousContentLengthEqualsUploaded: null,
            anonymousContentTypeClass: 'missing', anonymousBodyEqualsUploaded: false, anonymousBodyTruncated: false, anonymousAuthSchemes: ['basic'],
            authenticatedStatus: 206, authenticatedContentLengthPresent: true, authenticatedContentRangePresent: true, authenticatedContentLengthEqualsUploaded: true,
            authenticatedContentTypeClass: 'text', authenticatedBodyEqualsUploaded: true, authenticatedBodyTruncated: false, authenticatedAuthSchemes: [],
            removeStatus: 204, afterRemoveEventStatus: 200, afterRemoveReads: 1, attachGoneAfterRemove: true, etagChangedAfterRemove: true,
        });
        expect(eventRequests(fake, 'attmanaged')).toEqual(['PUT', 'POST', 'GET', 'POST', 'GET']);
        expect(fake.blobs.size).toBe(0);
        expect(report.cleanup?.allRemoved).toBe(true);
        expect(probeCalendarsLeft(fake)).toEqual([]);
        onlyAllowedHosts(fake);
        const gets = attachmentGets(fake);
        expect(gets.map((g) => g.range)).toEqual(['bytes=0-63', 'bytes=0-63']);
        // The upload carries the fixed 32 bytes, the type and the file name; nothing else is POSTed.
        const [add, remove] = POSTS(fake);
        expect(add?.url.search).toBe('?action=attachment-add');
        expect(remove?.url.search).toMatch(/^\?action=attachment-remove&managed-id=[A-Za-z0-9._-]+$/);
        expect(fake.requests.filter((r) => r.method === 'POST').length).toBe(2);
        const addRequest = fake.requests.find((r) => r.method === 'POST');
        expect(addRequest?.body).toBe(PROBE_FILE_TEXT);
        expect(addRequest?.headers.get('content-type')).toBe('text/plain');
        expect(addRequest?.headers.get('content-disposition')).toBe(`attachment; filename="${PROBE_FILE_NAME}"`);
        expect(addRequest?.headers.get('prefer')).toBe('return=representation');
        expect(report.redaction.scrubbedOccurrences).toBe(0);
        expect(JSON.stringify(result.evidence)).not.toMatch(/10000000001|probe-attachment|\d{8}-0000|p42-caldav|https?:/);
    });

    test('request budget: 7 requests, 8 with a challenged redirect', async () => {
        const plain = await run();
        const count = (fake: Fake): number => fake.requests.filter((r) => r.url.pathname.includes('-attmanaged.ics') || r.url.pathname.includes('/attachments/')).length;
        expect(count(plain.fake)).toBe(7);
        const redirecting = await run({ attachmentGet: 'redirect-allowed' });
        expect(count(redirecting.fake)).toBe(8);
        expect(check(redirecting.report, 'write-attachment-managed').outcome).toBe('confirmed');
        expect(check(redirecting.report, 'write-attachment-managed').evidence).toMatchObject({ authenticatedStatus: 302, authenticatedLocationHostClass: 'caldav-partition', redirectStatus: 206, matchedRedirect: true });
    });

    test('missing SIZE cannot prove upload provenance even without the add headers', async () => {
        const { report, fake } = await run({ attachmentAddHeaders: false, attachmentAddRepresentation: false, attachmentSizeParam: false });
        const result = check(report, 'write-attachment-managed');
        expect(result.outcome).toBe('inconclusive');
        expect(result.evidence).toMatchObject({ calManagedIdHeaderPresent: false, locationHeaderPresent: false, representationReturned: false, attachmentProvenanceVerified: false });
        expect(attachmentGets(fake)).toEqual([]);
        // No trusted id for attachment-remove; calendar cleanup still runs, blob disposal is unknown.
        expect(report.cleanup?.allRemoved).toBe(true);
    });

    test('an attachment URL on another host is classified and never requested', async () => {
        for (const [host, expected] of [['content', 'icloud-content'], ['other', 'other']] as const) {
            const { report, fake } = await run({ attachmentHost: host });
            const result = check(report, 'write-attachment-managed');
            expect(result.outcome).toBe('inconclusive');
            expect(result.evidence).toMatchObject({ urlHostClass: expected, urlSchemeClass: 'https', fetchSkipReason: 'host-not-allowed', attachGoneAfterRemove: true });
            expect(result.evidence).not.toHaveProperty('getStatus');
            expect(attachmentGets(fake)).toEqual([]);
            onlyAllowedHosts(fake);
            expect(fake.requests.some((r) => NOT_FETCHED_HOSTS.includes(r.url.hostname))).toBe(false);
        }
        const root = await run({ attachmentHost: 'root' });
        expect(check(root.report, 'write-attachment-managed').evidence).toMatchObject({ urlHostClass: 'caldav-root', anonymousStatus: 401, authenticatedStatus: 206 });
        expect(attachmentGets(root.fake).every((g) => g.url.hostname === 'caldav.icloud.com')).toBe(true);
    });

    test('a server that ignores Range, and one that redirects to icloud-content.com', async () => {
        const ignores = await run({ attachmentGet: 'ignores-range' });
        expect(check(ignores.report, 'write-attachment-managed').evidence).toMatchObject({ authenticatedStatus: 200, authenticatedBodyEqualsUploaded: true, authenticatedContentRangePresent: false });
        const redirect = await run({ attachmentGet: 'redirect-content' });
        const evidence = check(redirect.report, 'write-attachment-managed').evidence;
        expect(evidence).toMatchObject({ authenticatedStatus: 302, authenticatedLocationHostClass: 'icloud-content', redirectStatus: 206, matchedRedirect: true });
        expect(check(redirect.report, 'write-attachment-managed').outcome).toBe('confirmed');
        const target = redirect.fake.requests.find((r) => r.url.hostname === 'p42-content.icloud-content.com');
        expect(target?.headers.has('authorization')).toBe(false);
    });

    test('a refusal (403, 405) is recorded and ends the check as refuted after the PUT and the POST: no retry', async () => {
        for (const behaviour of ['forbidden', 'unsupported'] as const) {
            const { report, fake } = await run({ attachmentAdd: behaviour });
            const result = check(report, 'write-attachment-managed');
            expect(result.outcome).toBe('refuted');
            expect(result.evidence).toMatchObject({ putStatus: 201, addStatus: behaviour === 'forbidden' ? 403 : 405 });
            expect(eventRequests(fake, 'attmanaged')).toEqual(['PUT', 'POST']);
            expect(report.auth.rejected).toBe(false);
            expect(report.cleanup?.allRemoved).toBe(true);
            expect(probeCalendarsLeft(fake)).toEqual([]);
            // The inline check, written afterwards, still runs.
            expect(check(report, 'write-attachment-inline').outcome).toBe('confirmed');
        }
        expect(check((await run({ attachmentAdd: 'forbidden' })).report, 'write-attachment-managed').evidence).toMatchObject({ preconditions: ['need-privileges'] });
    });

    test('a 401 on the POST follows the stop-on-401 rule, and the temporary calendars are still deleted', async () => {
        const { report, fake } = await run({ attachmentAdd: 'unauthorized' });
        expect(check(report, 'write-attachment-managed').outcome).toBe('refuted');
        expect(check(report, 'write-attachment-managed').evidence).toMatchObject({ addStatus: 401 });
        expect(check(report, 'write-attachment-inline').outcome).toBe('skipped');
        expect(report.auth).toEqual({ rejected: true, onFirstRequest: false });
        const first401 = fake.requests.findIndex((r) => r.method === 'POST');
        expect(fake.requests.slice(first401 + 1).map((r) => r.method)).toEqual(['DELETE', 'DELETE']);
        expect(probeCalendarsLeft(fake)).toEqual([]);
        expect(report.cleanup?.tempCalendars.length).toBe(2);
    });

    test('a 401 on the attachment GET: the run stops, no remove is sent, the calendars are still deleted', async () => {
        const { report, fake } = await run({ attachmentGet: 'unauthorized' });
        const result = check(report, 'write-attachment-managed');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence).toMatchObject({ anonymousStatus: 401, authenticatedStatus: 401, removeSkipped: true });
        expect(POSTS(fake).length).toBe(1);
        expect(probeCalendarsLeft(fake)).toEqual([]);
        expect(report.auth.rejected).toBe(true);
    });

    test('an accepted add that leaves no ATTACH cannot prove provenance, and no remove is sent', async () => {
        const { report, fake } = await run({ hook: (req) => (req.method === 'POST' ? new Response(null, { status: 201 }) : undefined) });
        const result = check(report, 'write-attachment-managed');
        expect(result.outcome).toBe('inconclusive');
        expect(result.evidence).toMatchObject({ addStatus: 201, calManagedIdHeaderPresent: false, attachmentProvenanceVerified: false });
        expect(POSTS(fake).length).toBe(1);
    });

    test('a refused remove is recorded independently of the confirmed download; calendar deletion removes the event', async () => {
        const { report, fake } = await run({ hook: (req) => (req.method === 'POST' && req.url.search.includes('attachment-remove') ? new Response(null, { status: 403 }) : undefined) });
        const result = check(report, 'write-attachment-managed');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ removeStatus: 403, attachGoneAfterRemove: false, afterRemoveReads: 3, etagChangedAfterRemove: false });
        expect(probeCalendarsLeft(fake)).toEqual([]);
        expect(report.cleanup?.allRemoved).toBe(true);
    });

    test('if the check ends early (throttled), the remove is still attempted', async () => {
        let throttled = false;
        const { report, fake } = await run({
            hook: (req) => {
                if (!throttled && req.method === 'GET' && req.url.pathname.includes('-attmanaged.ics')) {
                    throttled = true;
                    return new Response('slow', { status: 503, headers: { 'retry-after': '1' } });
                }
                return undefined;
            },
        });
        expect(check(report, 'write-attachment-managed').outcome).toBe('inconclusive');
        expect(POSTS(fake).map((r) => r.url.searchParams.get('action'))).toEqual(['attachment-add', 'attachment-remove']);
        expect(fake.blobs.size).toBe(0);
        expect(report.cleanup?.allRemoved).toBe(true);
    });

    test('a server error on the add is inconclusive', async () => {
        const { report } = await run({ hook: (req) => (req.method === 'POST' ? new Response('oops', { status: 500 }) : undefined) });
        expect(check(report, 'write-attachment-managed').outcome).toBe('inconclusive');
        expect(check(report, 'write-attachment-managed').evidence).toMatchObject({ addStatus: 500 });
    });

    test('a redirect answer to the POST is never followed', async () => {
        const { report, fake } = await run({ hook: (req) => (req.method === 'POST' ? new Response(null, { status: 307, headers: { location: 'https://evil.example/x' } }) : undefined) });
        expect(check(report, 'write-attachment-managed').outcome).toBe('inconclusive');
        expect(check(report, 'write-attachment-managed').evidence).toMatchObject({ addStatus: 307 });
        expect(POSTS(fake).length).toBe(1);
        expect(fake.requests.every((r) => ALLOWED_HOSTS.has(r.url.hostname))).toBe(true);
    });

    test('all writes stay in probe calendars: every POST is an attachment action on a probe event', async () => {
        const { fake } = await run();
        for (const r of fake.requests.filter((q) => q.method !== 'GET' && q.method !== 'PROPFIND' && q.method !== 'REPORT' && q.method !== 'OPTIONS')) {
            expect(r.url.pathname).toMatch(/^\/10000000001\/calendars\/caldav-mcp-probe-[0-9a-f]{8}\//);
        }
        for (const r of POSTS(fake)) {
            expect(r.url.pathname).toMatch(/-attmanaged\.ics$/);
        }
    });

    test('if the calendars survive a failed deletion, --cleanup recognises the attachment events and removes the calendars', async () => {
        const fake = standardAccount(PLAIN, { deleteCollection: 'fails' });
        const first = await probe(fake, WRITE, creds);
        expect(first.cleanup?.allRemoved).toBe(false);
        const left = [...fake.calendars.values()].filter((c) => c.id.startsWith('caldav-mcp-probe-'));
        expect(left.length).toBe(2);
        const names = left.flatMap((c) => [...c.events.keys()]);
        expect(names.some((n) => n.endsWith('-attmanaged.ics'))).toBe(true);
        expect(names.some((n) => n.endsWith('-attinline.ics'))).toBe(true);
        expect(names.some((n) => n.endsWith('-attexternal.ics'))).toBe(true);
        fake.behaviour.deleteCollection = 'works';
        const cleaned = await probe(fake, { write: false, invite: false, cleanup: true }, creds, { confirmCleanup: async () => true });
        expect(check(cleaned, 'cleanup-leftovers').evidence).toMatchObject({ found: 2, candidates: 2, deleteAccepted: 2, removalVerified: 2 });
        expect([...fake.calendars.keys()].filter((id) => id.startsWith('caldav-mcp-probe-'))).toEqual([]);
    });

    test('a server-chosen calendar location cannot authorize attachment POSTs', async () => {
        let fake: Fake | undefined;
        fake = standardAccount(PLAIN, {
            hook: (req) => {
                if (req.method !== 'MKCALENDAR' || fake === undefined) {
                    return undefined;
                }
                const id = `uuid-${fake.calendars.size}`;
                const name = /<D:displayname>([^<]+)</.exec(req.body)?.[1] ?? id;
                fake.calendars.set(id, { id, displayName: name, kind: 'owned', components: ['VEVENT'], writable: true, color: '#000', events: new Map(), tombstones: new Map(), rev: 1 });
                return new Response(null, { status: 201, headers: { location: `/10000000001/calendars/${id}/` } });
            },
        });
        const report = await probe(fake, WRITE, creds);
        expect(check(report, 'write-attachment-managed').outcome).toBe('skipped');
        expect(POSTS(fake)).toEqual([]);
        expect(report.cleanup?.allRemoved).toBe(false);
    });
});

describe('write-attachment-inline: what PUT does to inline and external ATTACH properties', () => {
    test('a server that keeps both: confirmed, with only statuses, an enum, names and booleans recorded', async () => {
        const { report, fake } = await run();
        const result = check(report, 'write-attachment-inline');
        expect(result.outcome).toBe('confirmed');
        expect(flat(result.evidence)).toEqual({
            inlinePutStatus: 201, inlineGetStatus: 200, inlineDisposition: 'preserved', inlineAttachCount: 1, inlineParameterNames: ['ENCODING', 'FMTTYPE', 'VALUE'], inlineValueUnchanged: true,
            externalPutStatus: 201, externalGetStatus: 200, externalDisposition: 'preserved', externalAttachCount: 1, externalParameterNames: [], externalValueUnchanged: true,
        });
        expect(eventRequests(fake, 'attinline')).toEqual(['PUT', 'GET']);
        expect(eventRequests(fake, 'attexternal')).toEqual(['PUT', 'GET']);
        // The external URI is never fetched.
        expect(fake.requests.some((r) => r.url.hostname === 'example.invalid')).toBe(false);
        onlyAllowedHosts(fake);
        const put = fake.requests.find((r) => r.method === 'PUT' && r.url.pathname.endsWith('-attinline.ics'));
        expect(put?.body).toContain('ATTACH;ENCODING=BASE64;VALUE=BINARY;FMTTYPE=text/plain:');
        expect(put?.body.split('\r\n').every((line) => line.length <= 75)).toBe(true);
        expect(put?.body).toMatch(/\r\n [A-Za-z0-9+/=]+\r\nEND:VEVENT/);
        const decoded = /BASE64;VALUE=BINARY;FMTTYPE=text\/plain:([\s\S]*?)\r\nEND:VEVENT/.exec(put?.body ?? '')?.[1]?.replace(/\r\n /g, '') ?? '';
        expect(Buffer.from(decoded, 'base64').toString('utf8')).toBe(PROBE_FILE_TEXT);
        expect(JSON.stringify(result)).not.toContain('example');
    });

    test('an inline attachment turned into a managed one, or dropped, refutes the claim', async () => {
        const converted = await run({ attachmentPut: 'inline-to-managed' });
        const evidence = check(converted.report, 'write-attachment-inline').evidence;
        expect(check(converted.report, 'write-attachment-inline').outcome).toBe('refuted');
        expect(evidence).toMatchObject({ inlineDisposition: 'converted-to-managed', inlineValueUnchanged: false, externalDisposition: 'preserved', inlineAttachCount: 1 });
        expect(flat(evidence).inlineParameterNames).toEqual(['FILENAME', 'FMTTYPE', 'MANAGED-ID', 'SIZE']);
        const dropped = await run({ attachmentPut: 'drop' });
        expect(check(dropped.report, 'write-attachment-inline').outcome).toBe('refuted');
        expect(check(dropped.report, 'write-attachment-inline').evidence).toMatchObject({ inlineDisposition: 'dropped', externalDisposition: 'dropped', inlineAttachCount: 0, externalAttachCount: 0, inlineParameterNames: [] });
        // The managed copy the converting server made lives in the probe calendar, which is deleted.
        expect(converted.report.cleanup?.allRemoved).toBe(true);
    });

    test('a refused PUT is recorded with its status and does not stop the other event', async () => {
        const { report, fake } = await run({ hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-attexternal.ics') ? new Response('no', { status: 400 }) : undefined) });
        const result = check(report, 'write-attachment-inline');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence).toMatchObject({ inlinePutStatus: 201, inlineDisposition: 'preserved', externalPutStatus: 400, externalPreconditions: [] });
        expect(eventRequests(fake, 'attexternal')).toEqual(['PUT']);
    });

    test('a failing server is inconclusive, never an internal error', async () => {
        const { report } = await run({ hook: (req) => (req.method === 'PUT' && /-att(inline|external)\.ics$/.test(req.url.pathname) ? new Response('oops', { status: 500 }) : undefined) });
        expect(check(report, 'write-attachment-inline').outcome).toBe('inconclusive');
    });

    test('the check ids are in the report in order, after the earlier write checks and before the deletion', async () => {
        const { report } = await run();
        const ids = report.checks.map((c) => c.id);
        expect(ids.indexOf('write-attachment-managed')).toBeGreaterThan(ids.indexOf('write-range-thisandfuture'));
        expect(ids.indexOf('write-attachment-inline')).toBe(ids.indexOf('write-attachment-managed') + 1);
        expect(ids.indexOf('write-delete-calendar')).toBe(ids.indexOf('write-attachment-inline') + 1);
        expect(report.probeVersion).toBe('0.5.0');
        expect(ids.indexOf('write-dst-utc-in-repeated-hour')).toBeLessThan(ids.indexOf('write-attachment-managed'));
    });
});

describe('the temporary event keeps the probe’s own UID and summary (for --cleanup)', () => {
    test('every PUT the attachment checks send', async () => {
        const { fake } = await run();
        const puts = fake.requests.filter((r) => r.method === 'PUT' && /-att[a-z]+\.ics$/.test(r.url.pathname));
        expect(puts.length).toBe(3);
        for (const put of puts) {
            const stem = /\/(caldav-mcp-probe-[0-9a-f]{8}-[0-9a-z]{1,12})\.ics$/.exec(put.url.pathname)?.[1];
            expect(stem).toBeDefined();
            expect(put.body).toContain(`UID:${stem}`);
            expect(put.body).toContain('SUMMARY:caldav-mcp probe event');
            expect(prop(parseIcal(put.body)?.components[0] ?? { name: '', properties: [], components: [] }, 'UID')?.value).toBe(stem);
        }
    });
});
