import { describe, expect, test } from 'bun:test';
import { PutObjectCommand, S3Client, type GetObjectCommand } from '@aws-sdk/client-s3';
import { contentDisposition, downloadFilename, DownloadStageError, safeContentType, stageDownload, stagingKey } from '../src/calendar/downloads';
import { createS3DownloadStore, type S3ClientLike } from '../src/calendar/s3-download-store';
import { isValidBucketName } from '../src/config';
import { FakeDownloadStore } from './helpers/fake-download-store';

const accountId = 'A'.repeat(43);

describe('download filename', () => {
    test('uses FILENAME, then the URL basename, then attachment', () => {
        expect(downloadFilename('Report.pdf', 'https://gateway.icloud.com/a/other.pdf')).toBe('Report.pdf');
        expect(downloadFilename(null, 'https://gateway.icloud.com/a/b/c/d/probe%20file.txt/e')).toBe('e');
        expect(downloadFilename(null, 'https://gateway.icloud.com/a/probe%20file.txt')).toBe('probe file.txt');
        expect(downloadFilename(null, 'https://gateway.icloud.com/a/bad%zzname')).toBe('bad%zzname');
        expect(downloadFilename(null, 'https://gateway.icloud.com/')).toBe('attachment');
        expect(downloadFilename(null, 'not a url')).toBe('attachment');
        expect(downloadFilename(null, null)).toBe('attachment');
    });

    test('strips control, bidi and quote characters and replaces path separators', () => {
        expect(downloadFilename('../../etc/passwd', null)).toBe('.._.._etc_passwd');
        expect(downloadFilename('a\\b/c.txt', null)).toBe('a_b_c.txt');
        expect(downloadFilename('evil\r\nContent-Type: text/html.txt', null)).toBe('evilContent-Type: text/html.txt'.replace('/', '_'));
        expect(downloadFilename('na"me\'s`.txt', null)).toBe('names.txt');
        expect(downloadFilename('invoice‮txt.exe', null)).toBe('invoicetxt.exe');
        expect(downloadFilename('tab\there\u0000.txt', null)).toBe('tabhere.txt');
        expect(downloadFilename('c1\u0085.txt', null)).toBe('c1.txt');
        expect(downloadFilename('lone\uD800.txt', null)).toBe('lone.txt');
        expect(downloadFilename('  spaced.txt  ', null)).toBe('spaced.txt');
    });

    test('falls back when sanitizing leaves nothing useful', () => {
        expect(downloadFilename('""', 'https://gateway.icloud.com/a/real.txt')).toBe('real.txt');
        expect(downloadFilename('..', null)).toBe('attachment');
        expect(downloadFilename('\u0000\u0001', null)).toBe('attachment');
    });

    test('is NFC and bounded without splitting a surrogate pair', () => {
        expect(downloadFilename('é.txt', null)).toBe('é.txt');
        const long = `${'a'.repeat(179)}\u{1F600}tail`;
        const name = downloadFilename(long, null);
        expect(name).toBe('a'.repeat(179));
        expect(downloadFilename('x'.repeat(500), null)).toHaveLength(180);
    });
});

describe('content disposition', () => {
    test('is always attachment, with an ASCII fallback and an RFC 5987 UTF-8 name', () => {
        expect(contentDisposition('report.pdf')).toBe('attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf');
        expect(contentDisposition('Grüße (1).txt')).toBe('attachment; filename="Gr__e _1_.txt"; filename*=UTF-8\'\'Gr%C3%BC%C3%9Fe%20%281%29.txt');
        expect(contentDisposition('a;b,c*d!e~f.txt')).toBe('attachment; filename="a_b_c_d_e_f.txt"; filename*=UTF-8\'\'a%3Bb%2Cc%2Ad!e~f.txt');
    });
    test('a sanitized name can never break out of the header value', () => {
        for (const raw of ['x"; filename="evil.html', 'a\r\nSet-Cookie: x=y', "it's.txt"]) {
            const header = contentDisposition(downloadFilename(raw, null));
            expect(header).not.toMatch(/[\r\n]/u);
            expect(header.split('"')).toHaveLength(3);
            expect(header.split("''")).toHaveLength(2);
        }
    });
});

describe('content type', () => {
    test('FMTTYPE when plain, else application/octet-stream', () => {
        expect(safeContentType('application/pdf')).toBe('application/pdf');
        expect(safeContentType('Text/Plain; charset=utf-8')).toBe('text/plain');
        expect(safeContentType(null)).toBe('application/octet-stream');
        expect(safeContentType('')).toBe('application/octet-stream');
        expect(safeContentType('not a type')).toBe('application/octet-stream');
        expect(safeContentType('text/plain\r\nx: y')).toBe('application/octet-stream');
        expect(safeContentType(`a/${'b'.repeat(300)}`)).toBe('application/octet-stream');
    });
    test('active types are always application/octet-stream', () => {
        for (const type of ['text/html', 'TEXT/HTML', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml', 'application/rss+xml', 'text/javascript', 'application/javascript', 'application/x-javascript', 'application/ecmascript', 'text/xsl']) {
            expect([type, safeContentType(type)]).toEqual([type, 'application/octet-stream']);
        }
    });
});

describe('staging key', () => {
    test('is namespaced by a hash of the account id and unguessable', () => {
        const first = stagingKey(accountId);
        const second = stagingKey(accountId);
        expect(first).toMatch(/^downloads\/v1\/[0-9a-f]{64}\/[0-9a-f]{64}$/u);
        expect(first.split('/')[2]).toBe(second.split('/')[2]);
        expect(first).not.toBe(second);
        expect(stagingKey('B'.repeat(43)).split('/')[2]).not.toBe(first.split('/')[2]);
        expect(first).not.toContain(accountId);
    });
});

describe('stageDownload', () => {
    const bytes = new TextEncoder().encode('hello');
    const request = { accountId, bytes, filename: 'page.html', url: null, declaredContentType: 'text/html' };

    test('writes one private object and returns a short-lived https link', async () => {
        const now = 1_800_000_000_000;
        const store = new FakeDownloadStore(() => now);
        const staged = await stageDownload(store, request, new AbortController().signal, () => now);
        expect(staged).toEqual({ url: expect.stringMatching(/^https:\/\//u), expiresAt: '2027-01-15T08:05:00Z', filename: 'page.html', contentType: 'application/octet-stream', size: 5 });
        const [object] = [...store.objects.values()];
        expect(object?.contentType).toBe('application/octet-stream');
        expect(object?.contentDisposition).toBe('attachment; filename="page.html"; filename*=UTF-8\'\'page.html');
        expect(object?.body).toEqual(bytes);
        expect(store.signed).toEqual([{ key: object?.key ?? '', maxTtlSeconds: 300 }]);
        expect(JSON.stringify(staged)).not.toContain(accountId);
    });

    test('store failures become a fixed code without their text', async () => {
        const store = new FakeDownloadStore();
        store.putError = new Error('AccessDenied arn:aws:s3:::secret-bucket');
        const error = await stageDownload(store, request, new AbortController().signal).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(DownloadStageError);
        expect((error as DownloadStageError).code).toBe('temporarily_unavailable');
        expect(String(error)).not.toContain('secret-bucket');
        const signing = new FakeDownloadStore();
        signing.signError = new Error('expired');
        expect(await stageDownload(signing, request, new AbortController().signal).catch((caught: DownloadStageError) => caught.code)).toBe('temporarily_unavailable');
    });

    test('a link valid longer than five minutes, already expired or not https is refused', async () => {
        for (const seconds of [301 + 1, 0, -5]) {
            const store = new FakeDownloadStore();
            store.grantSeconds = seconds;
            expect(await stageDownload(store, request, new AbortController().signal).catch((caught: DownloadStageError) => caught.code)).toBe('verification_failed');
        }
        const plain: FakeDownloadStore = new FakeDownloadStore();
        plain.presignGet = async () => ({ url: 'http://insecure.example/x', expiresAt: new Date(Date.now() + 60_000) });
        expect(await stageDownload(plain, request, new AbortController().signal).catch((caught: DownloadStageError) => caught.code)).toBe('verification_failed');
    });

    test('a link with characters a presigned URL never has, or longer than 8192, is refused', async () => {
        for (const url of ['https://s3.example/a"b', 'https://s3.example/a\\b', 'https://s3.example/a b', 'https://s3.example/é', 'https://s3.example/a\u0001', 'https://', `https://s3.example/${'a'.repeat(8192)}`]) {
            const store = new FakeDownloadStore();
            store.presignGet = async () => ({ url, expiresAt: new Date(Date.now() + 60_000) });
            expect([url.slice(0, 40), await stageDownload(store, request, new AbortController().signal).catch((caught: DownloadStageError) => caught.code)]).toEqual([url.slice(0, 40), 'verification_failed']);
        }
        const exact = new FakeDownloadStore();
        const longest = `https://s3.example/${'a'.repeat(8192 - 19)}`;
        exact.presignGet = async () => ({ url: longest, expiresAt: new Date(Date.now() + 60_000) });
        expect((await stageDownload(exact, request, new AbortController().signal)).url).toHaveLength(8192);
    });

    test('an aborted signal writes nothing', async () => {
        const store = new FakeDownloadStore();
        expect(await stageDownload(store, request, AbortSignal.abort()).catch((caught: DownloadStageError) => caught.code)).toBe('temporarily_unavailable');
        expect(store.objects.size).toBe(0);
    });

    test('the signer gets the deadline signal', async () => {
        const store = new FakeDownloadStore();
        const signals: AbortSignal[] = [];
        const sign = store.presignGet.bind(store);
        store.presignGet = async (key, maxTtlSeconds, signal) => { signals.push(signal); return sign(key, maxTtlSeconds, signal); };
        const controller = new AbortController();
        await stageDownload(store, request, controller.signal);
        expect(signals).toEqual([controller.signal]);
    });

    test('a signer that never resolves is cut off by the deadline', async () => {
        const store = new FakeDownloadStore();
        store.presignGet = () => new Promise(() => {});
        const controller = new AbortController();
        const pending = stageDownload(store, request, controller.signal).catch((caught: DownloadStageError) => caught.code);
        // Let the put finish and the signer start before the deadline passes.
        await Bun.sleep(0);
        controller.abort();
        expect(await pending).toBe('temporarily_unavailable');
    });

    test('a put that never resolves is cut off by the deadline', async () => {
        const store = new FakeDownloadStore();
        store.putObject = () => new Promise(() => {});
        const controller = new AbortController();
        const pending = stageDownload(store, request, controller.signal).catch((caught: DownloadStageError) => caught.code);
        controller.abort();
        expect(await pending).toBe('temporarily_unavailable');
        expect(store.signed).toHaveLength(0);
    });

    test('a signer that resolves after cancellation is not a success', async () => {
        const controller = new AbortController();
        const store = new FakeDownloadStore();
        const sign = store.presignGet.bind(store);
        // Cancellation lands while the signer is working; the signer still answers with a valid link.
        store.presignGet = async (key, maxTtlSeconds, signal) => { const answer = await sign(key, maxTtlSeconds, signal); controller.abort(); await Bun.sleep(0); return answer; };
        expect(await stageDownload(store, request, controller.signal).catch((caught: DownloadStageError) => caught.code)).toBe('temporarily_unavailable');
        // Synchronous variant: the abort and the answer happen in the same turn, so only the re-check after signing catches it.
        const second = new AbortController();
        const quick = new FakeDownloadStore();
        const quickSign = quick.presignGet.bind(quick);
        quick.presignGet = (key, maxTtlSeconds, signal) => { const answer = quickSign(key, maxTtlSeconds, signal); second.abort(); return answer; };
        expect(await stageDownload(quick, request, second.signal).catch((caught: DownloadStageError) => caught.code)).toBe('temporarily_unavailable');
    });
});

describe('S3 download store', () => {
    test('bucket names are validated', () => {
        expect(isValidBucketName('caldav-mcp-bootstrap-downloadbucket-abc123')).toBe(true);
        for (const bad of ['', 'ab', 'UPPER', 'a..b', '-start', 'end-', 'a'.repeat(64), 'has space']) { expect([bad, isValidBucketName(bad)]).toEqual([bad, false]); }
        expect(() => createS3DownloadStore({ bucketName: 'Bad_Name' })).toThrow();
    });

    test('puts a private, encrypted, no-store object and creates no client until first use', async () => {
        const sent: PutObjectCommand[] = [];
        const signals: (AbortSignal | undefined)[] = [];
        let created = 0;
        const client: S3ClientLike = {
            send: async (command, options) => { sent.push(command); signals.push(options?.abortSignal); return {}; },
            config: { credentials: async () => ({}) },
        };
        const store = createS3DownloadStore({ bucketName: 'download-bucket', client: () => { created++; return client; } });
        expect(created).toBe(0);
        const signal = new AbortController().signal;
        const body = new Uint8Array([1, 2, 3]);
        await store.putObject({ key: 'downloads/v1/n/k', body, contentType: 'text/plain', contentDisposition: 'attachment; filename="a.txt"' }, signal);
        expect(created).toBe(1);
        expect(sent[0]).toBeInstanceOf(PutObjectCommand);
        expect(sent[0]?.input).toEqual({ Bucket: 'download-bucket', Key: 'downloads/v1/n/k', Body: body, ContentLength: 3, ContentType: 'text/plain', ContentDisposition: 'attachment; filename="a.txt"', CacheControl: 'private, no-store', ServerSideEncryption: 'AES256' });
        expect(signals[0]).toBe(signal);
    });

    test('presigns a GET for at most five minutes, shortened to the signing credentials lifetime', async () => {
        const now = 1_800_000_000_000;
        const calls: { key: unknown; expiresIn: number }[] = [];
        const make = (expiration?: Date) => createS3DownloadStore({
            bucketName: 'download-bucket', now: () => now,
            client: () => ({ send: async () => ({}), config: { credentials: async () => (expiration === undefined ? {} : { expiration }) } }),
            presign: async (_client, command: GetObjectCommand, options) => { calls.push({ key: command.input.Key, expiresIn: options.expiresIn }); return 'https://signed.example/x'; },
        });
        const signal = new AbortController().signal;
        expect(await make().presignGet('k1', 300, signal)).toEqual({ url: 'https://signed.example/x', expiresAt: new Date(now + 300_000) });
        expect(await make(new Date(now + 120_000)).presignGet('k2', 300, signal)).toEqual({ url: 'https://signed.example/x', expiresAt: new Date(now + 115_000) });
        await expect(make(new Date(now + 5_000)).presignGet('k3', 300, signal)).rejects.toThrow();
        expect(calls).toEqual([{ key: 'k1', expiresIn: 300 }, { key: 'k2', expiresIn: 115 }]);
    });

    test('presigning is bounded by the signal: stalled credentials are cut off and an aborted signal signs nothing', async () => {
        let signed = 0;
        const make = (credentials: () => Promise<{ expiration?: Date }>) => createS3DownloadStore({
            bucketName: 'download-bucket',
            client: () => ({ send: async () => ({}), config: { credentials } }),
            presign: async () => { signed++; return 'https://signed.example/x'; },
        });
        const controller = new AbortController();
        const pending = make(() => new Promise(() => {})).presignGet('k', 300, controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow();
        // Credentials that resolve only after the deadline passed do not lead to a signature.
        const late = new AbortController();
        await expect(make(async () => { late.abort(); return {}; }).presignGet('k', 300, late.signal)).rejects.toThrow();
        await expect(make(async () => ({})).presignGet('k', 300, AbortSignal.abort())).rejects.toThrow();
        expect(signed).toBe(0);
    });

    test('the real presigner signs locally, without any network, an https GET with the requested lifetime', async () => {
        const client = new S3Client({ region: 'us-west-2', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, maxAttempts: 1 });
        const store = createS3DownloadStore({ bucketName: 'download-bucket', client: () => client });
        const { url } = await store.presignGet('downloads/v1/n/k', 300, new AbortController().signal);
        const parsed = new URL(url);
        expect(parsed.protocol).toBe('https:');
        expect(parsed.pathname.endsWith('/downloads/v1/n/k')).toBe(true);
        expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
        expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/u);
        // stageDownload accepts what the real presigner produces, and returns it unchanged.
        // The put is stubbed: this test must not send anything to S3.
        const signOnly = { putObject: async () => {}, presignGet: store.presignGet.bind(store) };
        const staged = await stageDownload(signOnly, { accountId, bytes: new Uint8Array(1), filename: 'a.txt', url: null, declaredContentType: null }, new AbortController().signal);
        expect(new URL(staged.url).searchParams.get('X-Amz-Expires')).toBe('300');
    });
});
