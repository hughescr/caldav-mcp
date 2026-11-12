import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { handleMcp } from '../src/mcp';
import { bindCalendarService, type DownloadBinding } from '../src/calendar/service';
import { CalDavError } from '../src/caldav/contracts';
import type { ManagedAttachmentPolicy } from '../src/caldav/managed-attachment-policy';
import type { CalendarResource } from '../src/caldav/read-contracts';
import { downloadOutputSchema, type AttachmentMetadata } from '../src/calendar/event-schemas';
import { MAX_DOWNLOAD_BYTES } from '../src/calendar/limits';
import type { UpstreamCredentials } from '../src/auth/contracts';
import { withRequestBudget } from '../src/request-budget';
import { FAKE_DISCOVERY, FakeCalDavRead } from './helpers/fake-caldav-read';
import { FakeDownloadStore } from './helpers/fake-download-store';

const calendarId = '/10000000001/calendars/work/';
const href = `${calendarId}attached.ics`;
const credentials: UpstreamCredentials = { accountId: 'download-account', appleId: 'bound@example.invalid', appPassword: 'download-canary-pass', ...FAKE_DISCOVERY, issuedAt: 1000 };
const managedUrl = 'https://gateway.icloud.com/a1/b2/c3/d4/probe.txt/e5';
const offPolicyUrl = 'https://p01-caldav.icloud.com/10000000001/calendars/work/other.ics';
const loginHost = 'login-required.icloud.example';

function ics(attachLines: readonly string[]): string {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic//EN', 'BEGIN:VEVENT', 'UID:attachments', 'DTSTART:20270111T100000Z', 'DTEND:20270111T110000Z', 'SUMMARY:Attachments', ...attachLines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\n');
}

const LINES = {
    managed: `ATTACH;FILENAME=probe.txt;FMTTYPE=text/plain;MANAGED-ID=m1;SIZE=32:${managedUrl}`,
    inline: 'ATTACH;FMTTYPE=text/html;FILENAME=page.html;VALUE=BINARY;ENCODING=BASE64:PGI+aGk8L2I+',
    external: 'ATTACH;FMTTYPE=application/pdf;FILENAME=shared.pdf:https://files.example.invalid/shared/doc.pdf',
    offPolicy: `ATTACH;MANAGED-ID=m2;FILENAME=sneaky.txt:${offPolicyUrl}`,
    unsupported: 'ATTACH;VALUE=BINARY;ENCODING=BASE64;ENCODING=BASE64:SGk=',
    oversize: `ATTACH;MANAGED-ID=m3;SIZE=${MAX_DOWNLOAD_BYTES + 1}:https://gateway.icloud.com/a/b/c/d/big.bin/e`,
    unsized: 'ATTACH;MANAGED-ID=m4;FILENAME=unsized.bin:https://gateway.icloud.com/a/b/c/d/unsized.bin/e',
    inlineOverSize: 'ATTACH;FILENAME=short.txt;SIZE=3;VALUE=BINARY;ENCODING=BASE64:PGI+aGk8L2I+',
    credentialed: `ATTACH;MANAGED-ID=m5;FILENAME=login.txt:https://${loginHost}/a/login.txt`,
    ftp: 'ATTACH:ftp://files.example.invalid/doc',
} as const;
type Kind = keyof typeof LINES;
const KINDS = Object.keys(LINES) as Kind[];
const DATA = ics(KINDS.map(kind => LINES[kind]));
const resource = (calendarData = DATA, etag = '"v1"'): CalendarResource => ({ href, etag, calendarData });

interface Sent { url: string; headers: Headers; redirect: RequestRedirect | undefined }

function setup(options: { store?: FakeDownloadStore | null; responses?: (Response | (() => Response))[]; policy?: ManagedAttachmentPolicy } = {}) {
    const backend = new FakeCalDavRead().setCalendars([{ id: calendarId, displayName: 'Work', components: ['VEVENT'], color: null }]);
    const store = options.store === null ? undefined : options.store ?? new FakeDownloadStore();
    const responses = [...(options.responses ?? [])];
    const sent: Sent[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        sent.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
        const next = responses.shift();
        if (next === undefined) { throw new Error('unexpected attachment request'); }
        return typeof next === 'function' ? next() : next;
    };
    let marks = 0;
    const downloads: DownloadBinding = { store: () => store, fetch, ...(options.policy === undefined ? {} : { policy: options.policy }) };
    const service = bindCalendarService({ caldav: backend, connectionStatus: 'active', credentials: () => credentials, markReconnectRequired: async () => { marks++; return true; }, downloads });
    /** The attachment metadata get_event exposes, from one scripted original read. */
    const metadata = async (calendarData = DATA): Promise<AttachmentMetadata[]> => {
        backend.scriptMultiget(calendarId, [{ kind: 'found', resource: resource(calendarData) }]);
        return (await service.get_event({ calendar_id: calendarId, resource_href: href })).attachments;
    };
    const refOf = async (kind: Kind): Promise<string> => {
        const all = await metadata();
        const ref = all[KINDS.indexOf(kind)]?.attachment_ref;
        if (ref === undefined) { throw new Error(`no attachment ${kind}`); }
        return ref;
    };
    const download = async (attachment_ref: string, extra: { expected_version?: string; recurrence_id?: string | null; calendarData?: string; etag?: string } = {}) => {
        backend.scriptMultiget(calendarId, [{ kind: 'found', resource: resource(extra.calendarData ?? DATA, extra.etag ?? '"v1"') }]);
        return service.get_event_attachment_download({
            calendar_id: calendarId, resource_href: href, attachment_ref,
            ...(extra.expected_version === undefined ? {} : { expected_version: extra.expected_version }),
            ...(extra.recurrence_id === undefined ? {} : { recurrence_id: extra.recurrence_id }),
        });
    };
    return { backend, store, sent, service, metadata, refOf, download, marks: () => marks };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
    try { await promise; return 'resolved'; } catch (error) { return (error as { code?: string }).code ?? String(error); }
}

let tripwire: Mock<typeof fetch>;
beforeEach(() => { tripwire = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('network tripwire'); }) as unknown as typeof fetch); });
afterEach(() => { expect(tripwire).not.toHaveBeenCalled(); tripwire.mockRestore(); });

describe('get_event_attachment_download end to end over the fake backend', () => {
    test('get_event reports which attachments the download tool can serve', async () => {
        const f = setup();
        const all = await f.metadata();
        expect(all.map(item => [item.form, item.download_supported])).toEqual([
            ['managed', true], ['inline', true], ['external_url', true], ['managed', true], ['inline', false],
            ['managed', false], ['managed', true], ['inline', true], ['managed', true], ['external_url', false],
        ]);
        expect(JSON.stringify(all)).not.toContain('https://');
    });

    test('inline: decoded from the event, staged with forced attachment and a safe type, nothing fetched', async () => {
        const f = setup();
        const ref = await f.refOf('inline');
        const before = f.backend.count();
        const result = await f.download(ref);
        expect(downloadOutputSchema.parse(result)).toEqual({
            form: 'inline', attachment_ref: ref, expected_version: '"v1"', filename: 'page.html', content_type: 'application/octet-stream', size: 9,
            download_url: expect.stringMatching(/^https:\/\//u), expires_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u), fetched_by_server: true,
        });
        expect(f.backend.calls.slice(before).map(call => call.method)).toEqual(['listCalendars', 'multigetEvents']);
        expect(f.sent).toHaveLength(0);
        const [object] = [...(f.store?.objects.values() ?? [])];
        expect(new TextDecoder().decode(object?.body)).toBe('<b>hi</b>');
        expect(object?.contentDisposition).toBe('attachment; filename="page.html"; filename*=UTF-8\'\'page.html');
        expect(object?.key).toMatch(/^downloads\/v1\/[0-9a-f]{64}\/[0-9a-f]{64}$/u);
        expect(f.store?.signed).toEqual([{ key: object?.key ?? '', maxTtlSeconds: 300 }]);
        expect(Date.parse(result.expires_at ?? '') - Date.now()).toBeLessThanOrEqual(300_000);
    });

    test('managed: one anonymous GET of the gateway URL, then staged', async () => {
        const f = setup({ responses: [new Response('0123456789abcdef0123456789abcdef', { status: 200, headers: { 'content-type': 'text/html' } })] });
        const ref = await f.refOf('managed');
        const result = await f.download(ref);
        expect(result).toMatchObject({ form: 'managed', filename: 'probe.txt', content_type: 'text/plain', size: 32, fetched_by_server: true });
        expect(f.sent).toHaveLength(1);
        expect(f.sent[0]?.url).toBe(managedUrl);
        expect(f.sent[0]?.redirect).toBe('manual');
        expect(f.sent[0]?.headers.get('authorization')).toBeNull();
        expect(JSON.stringify(result)).not.toContain('gateway.icloud.com');
        expect([...(f.store?.objects.values() ?? [])].map(object => new TextDecoder().decode(object.body))).toEqual(['0123456789abcdef0123456789abcdef']);
    });

    test('managed without SIZE and without Content-Length is staged under the 20 MiB cap', async () => {
        const f = setup({ responses: [new Response(new Uint8Array(1000))] });
        const result = await f.download(await f.refOf('unsized'));
        expect(result).toMatchObject({ form: 'managed', filename: 'unsized.bin', content_type: 'application/octet-stream', size: 1000 });
    });

    test('external: the link is returned, marked as not fetched; nothing is fetched or staged', async () => {
        const f = setup();
        const ref = await f.refOf('external');
        expect(await f.download(ref)).toEqual({
            form: 'external', attachment_ref: ref, expected_version: '"v1"', url: 'https://files.example.invalid/shared/doc.pdf', fetched_by_server: false, filename: 'shared.pdf', content_type: 'application/pdf',
        });
        expect(f.sent).toHaveLength(0);
        expect(f.store?.objects.size).toBe(0);
    });

    test('a MANAGED-ID URL the policy refuses (here a CalDAV .ics path) is never fetched: it is only an external link', async () => {
        const f = setup();
        const result = await f.download(await f.refOf('offPolicy'));
        expect(result).toMatchObject({ form: 'external', url: offPolicyUrl, fetched_by_server: false });
        expect(f.sent).toHaveLength(0);
        expect(f.store?.objects.size).toBe(0);
    });

    test('a structurally unsupported attachment, or a non-http link, is unsupported_attachment', async () => {
        const f = setup();
        expect(await codeOf(f.download(await f.refOf('unsupported')))).toBe('unsupported_attachment');
        expect(await codeOf(f.download(await f.refOf('ftp')))).toBe('unsupported_attachment');
        expect(f.store?.objects.size).toBe(0);
    });

    test('a missing attachment ref is not_found, also after the attachment was removed from the event', async () => {
        const f = setup();
        expect(await codeOf(f.download(`a1_${'Z'.repeat(43)}`))).toBe('not_found');
        const ref = await f.refOf('inline');
        expect(await codeOf(f.download(ref, { calendarData: ics([LINES.external]), etag: '"v2"' }))).toBe('not_found');
        expect(f.store?.objects.size).toBe(0);
    });

    test('a ref is bound to its account, calendar and resource: it cannot select another account\'s attachment', async () => {
        const f = setup();
        const ref = await f.refOf('inline');
        const other = setup();
        const otherService = bindCalendarService({
            caldav: other.backend, connectionStatus: 'active', credentials: () => ({ ...credentials, accountId: 'another-account' }), markReconnectRequired: async () => true,
            downloads: { store: () => other.store },
        });
        other.backend.scriptMultiget(calendarId, [{ kind: 'found', resource: resource() }]);
        expect(await codeOf(otherService.get_event_attachment_download({ calendar_id: calendarId, resource_href: href, attachment_ref: ref }))).toBe('not_found');
    });

    test('expected_version mismatch is calendar_changed before anything is fetched or staged', async () => {
        const f = setup();
        const ref = await f.refOf('managed');
        expect(await codeOf(f.download(ref, { expected_version: '"v0"' }))).toBe('calendar_changed');
        expect(f.sent).toHaveLength(0);
        expect(f.store?.objects.size).toBe(0);
        expect(await codeOf(f.download(await f.refOf('external'), { expected_version: '"v1"' }))).toBe('resolved');
    });

    test('recurrence_id is accepted like get_event, and validated', async () => {
        const f = setup();
        const ref = await f.refOf('external');
        expect(await codeOf(f.download(ref, { recurrence_id: 'occ1_20270111T100000Z' }))).toBe('resolved');
        expect(await codeOf(f.service.get_event_attachment_download({ calendar_id: calendarId, resource_href: href, attachment_ref: ref, recurrence_id: 'bad' }))).toBe('invalid_input');
    });

    test('oversize: a SIZE over 20 MiB fails before any fetch; a body over 20 MiB stops streaming and stages nothing', async () => {
        const f = setup();
        expect(await codeOf(f.download(await f.refOf('oversize')))).toBe('result_too_large');
        expect(f.sent).toHaveLength(0);
        let produced = 0;
        const body = new ReadableStream<Uint8Array>({ pull(controller) { produced += 1024 * 1024; controller.enqueue(new Uint8Array(1024 * 1024)); } });
        const g = setup({ responses: [new Response(body)] });
        expect(await codeOf(g.download(await g.refOf('unsized')))).toBe('result_too_large');
        expect(produced).toBeLessThanOrEqual(MAX_DOWNLOAD_BYTES + 3 * 1024 * 1024);
        expect(g.store?.objects.size).toBe(0);
    });

    test('only an attachment over 20 MiB carries the attachment_size detail; an oversized calendar read does not', async () => {
        const detailOf = async (promise: Promise<unknown>): Promise<[string, unknown]> => {
            try { await promise; return ['resolved', undefined]; } catch (error) { return [(error as { code: string }).code, (error as { detail?: unknown }).detail]; }
        };
        const f = setup();
        expect(await detailOf(f.download(await f.refOf('oversize')))).toEqual(['result_too_large', 'attachment_size']);
        const g = setup({ responses: [new Response(new Uint8Array(MAX_DOWNLOAD_BYTES + 1))] });
        expect(await detailOf(g.download(await g.refOf('unsized')))).toEqual(['result_too_large', 'attachment_size']);
        const ref = await f.refOf('inline');
        f.backend.scriptMultiget(calendarId, new CalDavError('too_large'));
        expect(await detailOf(f.service.get_event_attachment_download({ calendar_id: calendarId, resource_href: href, attachment_ref: ref }))).toEqual(['result_too_large', undefined]);
    });

    test('a body longer than SIZE, or inline bytes longer than SIZE, fail verification', async () => {
        const f = setup({ responses: [new Response('x'.repeat(33))] });
        expect(await codeOf(f.download(await f.refOf('managed')))).toBe('verification_failed');
        expect(await codeOf(f.download(await f.refOf('inlineOverSize')))).toBe('verification_failed');
        expect(f.store?.objects.size).toBe(0);
    });

    test('a redirect from the managed host is a failure, never followed', async () => {
        const f = setup({ responses: [new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })] });
        expect(await codeOf(f.download(await f.refOf('managed')))).toBe('upstream_error');
        expect(f.sent).toHaveLength(1);
        expect(f.store?.objects.size).toBe(0);
    });

    test('an opaqueredirect or status 0 answer is refused and stages nothing', async () => {
        const reshape = (type: ResponseType, status: number) => (): Response => Object.defineProperties(new Response('upstream body canary'), { type: { value: type }, status: { value: status } });
        for (const answer of [reshape('opaqueredirect', 0), reshape('basic', 0), () => Response.error()]) {
            const f = setup({ responses: [answer] });
            expect(await codeOf(f.download(await f.refOf('managed')))).toBe('upstream_error');
            expect(f.sent).toHaveLength(1);
            expect(f.store?.objects.size).toBe(0);
            expect(f.store?.signed).toHaveLength(0);
        }
    });

    test('upstream errors map to fixed codes and stage nothing', async () => {
        for (const [status, expected] of [[503, 'temporarily_unavailable'], [500, 'temporarily_unavailable'], [429, 'temporarily_unavailable'], [404, 'not_found'], [400, 'upstream_error'], [401, 'unsupported_attachment']] as const) {
            const f = setup({ responses: [new Response('upstream body canary', { status, headers: { 'www-authenticate': 'Basic realm="x"' } })] });
            expect([status, await codeOf(f.download(await f.refOf('managed')))]).toEqual([status, expected]);
            expect(f.sent).toHaveLength(1);
            expect(f.sent[0]?.headers.get('authorization')).toBeNull();
            expect(f.store?.objects.size).toBe(0);
        }
    });

    test('a credentialed host from a test policy gets the bound credentials only after a 401 Basic challenge', async () => {
        const policy: ManagedAttachmentPolicy = { downloadHosts: ['gateway.icloud.com', loginHost], credentialedHosts: [loginHost] };
        const f = setup({ policy, responses: [new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="files"' } }), new Response('secret file')] });
        const result = await f.download(await f.refOf('credentialed'));
        expect(result).toMatchObject({ form: 'managed', filename: 'login.txt', size: 11 });
        expect(f.sent.map(sent => sent.headers.get('authorization'))).toEqual([null, `Basic ${Buffer.from(`${credentials.appleId}:${credentials.appPassword}`).toString('base64')}`]);
        // The shipped policy does not list that host: the same attachment is only an external link.
        const shipped = setup();
        expect(await shipped.download(await shipped.refOf('credentialed'))).toMatchObject({ form: 'external', fetched_by_server: false });
        expect(shipped.sent).toHaveLength(0);
    });

    test('without a download bucket, inline and managed fail before any fetch; external links still work', async () => {
        const f = setup({ store: null });
        expect(await codeOf(f.download(await f.refOf('inline')))).toBe('temporarily_unavailable');
        expect(await codeOf(f.download(await f.refOf('managed')))).toBe('temporarily_unavailable');
        expect(f.sent).toHaveLength(0);
        expect(await f.download(await f.refOf('external'))).toMatchObject({ form: 'external' });
    });

    test('a staging failure is temporarily_unavailable without store text', async () => {
        const store = new FakeDownloadStore();
        store.putError = new Error('AccessDenied arn:aws:s3:::private-bucket-canary');
        const f = setup({ store });
        const error = await f.download(await f.refOf('inline')).catch((caught: unknown) => caught);
        expect((error as { code: string }).code).toBe('temporarily_unavailable');
        expect(JSON.stringify(error)).not.toContain('canary');
    });

    test('a CalDAV 401 is reconnect_required and marks the connection once, with nothing fetched', async () => {
        const f = setup({ responses: [new Response('x')] });
        const ref = await f.refOf('managed');
        f.backend.scriptMultiget(calendarId, new CalDavError('unauthorized'));
        expect(await codeOf(f.service.get_event_attachment_download({ calendar_id: calendarId, resource_href: href, attachment_ref: ref }))).toBe('reconnect_required');
        expect(f.marks()).toBe(1);
        expect(f.sent).toHaveLength(0);
    });

    test('an unknown calendar or event is not_found', async () => {
        const f = setup();
        const ref = await f.refOf('inline');
        expect(await codeOf(f.service.get_event_attachment_download({ calendar_id: '/10000000001/calendars/other/', resource_href: '/10000000001/calendars/other/attached.ics', attachment_ref: ref }))).toBe('not_found');
        expect(await codeOf(f.service.get_event_attachment_download({ calendar_id: calendarId, resource_href: href, attachment_ref: ref }))).toBe('not_found');
    });

    test('the managed fetch is bounded by the download deadline, body included', async () => {
        const stalled = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
        const f = setup({ responses: [new Response(stalled)] });
        const ref = await f.refOf('managed');
        f.backend.scriptMultiget(calendarId, [{ kind: 'found', resource: resource() }]);
        // 3 s Lambda reserve + 1 s cleanup reserve + 250 ms of stream lease.
        const started = performance.now();
        const code = await codeOf(withRequestBudget(() => 4250, () => f.service.get_event_attachment_download({ calendar_id: calendarId, resource_href: href, attachment_ref: ref })));
        expect(code).toBe('temporarily_unavailable');
        // The GET was sent and its body then stalled: the lease, not a pre-flight check, ended it.
        expect(f.sent).toHaveLength(1);
        expect(performance.now() - started).toBeGreaterThanOrEqual(200);
        expect(performance.now() - started).toBeLessThan(3000);
        expect(f.store?.objects.size).toBe(0);
    });

    test('presigning is bounded by the download deadline: a signer that never answers ends as temporarily_unavailable', async () => {
        const store = new FakeDownloadStore();
        store.presignGet = () => new Promise(() => {});
        const f = setup({ store });
        const ref = await f.refOf('inline');
        f.backend.scriptMultiget(calendarId, [{ kind: 'found', resource: resource() }]);
        // 3 s Lambda reserve + 250 ms of work time for staging.
        const started = performance.now();
        const code = await codeOf(withRequestBudget(() => 3250, () => f.service.get_event_attachment_download({ calendar_id: calendarId, resource_href: href, attachment_ref: ref })));
        expect(code).toBe('temporarily_unavailable');
        expect(store.objects.size).toBe(1);
        expect(performance.now() - started).toBeLessThan(3000);
    });

    test('through MCP: a staged copy comes back as structured data plus one resource_link', async () => {
        const f = setup();
        const ref = await f.refOf('inline');
        f.backend.scriptMultiget(calendarId, [{ kind: 'found', resource: resource() }]);
        const authInfo: AuthInfo = { token: 'synthetic', clientId: 'test', scopes: ['calendar:read'] };
        const request = new Request('https://service.example/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_event_attachment_download', arguments: { calendar_id: calendarId, resource_href: href, attachment_ref: ref } } }),
        });
        const reply = await (await handleMcp(request, authInfo, f.service)).json();
        const structured = downloadOutputSchema.parse(reply.result.structuredContent);
        expect(structured.form).toBe('inline');
        expect(reply.result.content[1]).toEqual({ type: 'resource_link', uri: structured.download_url, name: 'page.html', mimeType: 'application/octet-stream', size: 9 });
        expect(JSON.stringify(reply)).not.toContain(credentials.appPassword);
    });
});
