import { describe, expect, test } from 'bun:test';
import { runCli, type CliIo } from '../scripts/probe/cli';
import { runProbe } from '../scripts/probe/core';
import { runLambdaEvent } from '../scripts/probe/lambda';
import type { BackendLoad, ProbeDeps } from '../scripts/probe/types';
import { FAKE_NOW, ICLOUD_MEASURED, seedAttachment, seedEvent, standardAccount, type Canaries, type FakeBehaviour, type FakeICloud } from './fixtures/probe/fake-icloud';
import { fakeDeps } from './fixtures/probe/harness';

/** Every value is distinctive so that any leak, in any encoding, is found. */
const C: Canaries = {
    appleId: 'canary.appleid.q7x2@example.invalid',
    appPassword: 'cnry-pwdq-7x2z-zzzk',
    dsid: '98765432101',
    calendarName: 'CanaryCalName Zq7x2',
    calendarId: 'CANARYCALIDQ7X2',
    summary: 'CanarySummaryQ7x2',
    description: 'CanaryDescriptionQ7x2',
    location: 'CanaryLocationQ7x2',
    uid: 'canary-uid-q7x2',
    etagPrefix: 'CanaryEtagQ7x2-',
    tokenPrefix: 'CanarySyncTokenQ7x2-',
    attendee: 'canary.attendee.q7x2@example.invalid',
    principalName: 'Canary Principal Q7x2',
    address: 'canary.alias.q7x2@example.invalid',
};
const INVITEE = 'canary.invitee.q7x2@example.invalid';

function forms(value: string): string[] {
    const variants = new Set([value, value.toLowerCase(), value.toUpperCase()]);
    const out = new Set<string>();
    for (const v of variants) {
        out.add(v);
        out.add(encodeURIComponent(v));
        out.add(Buffer.from(v, 'utf8').toString('base64'));
        out.add(Buffer.from(v, 'utf8').toString('base64url'));
    }
    return [...out];
}

const CANARY_STRINGS = [
    ...Object.values(C), INVITEE, `${C.appleId}:${C.appPassword}`,
    // Fragments: the distinctive core of each canary, so a partial leak is caught too.
    'q7x2', 'Q7x2', 'Q7X2', 'cnry-pwdq', '98765432101', 'CanaryEtag', 'CanarySyncToken', 'CANARYCALID',
];

function assertNoCanary(text: string, where: string): void {
    for (const canary of CANARY_STRINGS) {
        for (const form of forms(canary)) {
            if (text.includes(form)) {
                throw new Error(`canary form leaked in ${where}: ${JSON.stringify(form)}`);
            }
        }
    }
}

function withLeftovers(fake: FakeICloud): FakeICloud {
    fake.calendars.set('caldav-mcp-probe-0a0a0a0a', { id: 'caldav-mcp-probe-0a0a0a0a', displayName: 'caldav-mcp-probe-0a0a0a0a', kind: 'owned', components: ['VEVENT'], writable: true, color: '#000', events: new Map(), tombstones: new Map(), rev: 1 });
    fake.calendars.set(`${C.calendarId}-odd`, { id: `${C.calendarId}-odd`, displayName: `caldav-mcp-probe-${C.calendarName}`, kind: 'owned', components: ['VEVENT'], writable: true, color: '#000', events: new Map(), tombstones: new Map(), rev: 1 });
    return fake;
}

/**
 * Attachments carrying a canary in every place a report could be tempted to echo: file names, the
 * MANAGED-ID, parameter names and values, URL host labels and paths, and the file itself.
 */
function withAttachments(fake: FakeICloud): FakeICloud {
    const id = `${C.uid}-mid`;
    const attach = [
        `ATTACH;MANAGED-ID=${id};FMTTYPE=image/png;SIZE=${C.description.length};FILENAME=${C.summary}.png;X-APPLE-FILENAME=${C.summary}.png;X-${C.location.toUpperCase()}=${C.description}:https://p42-caldav.icloud.com:443/${C.dsid}/attachments/${id}/${C.summary}.png`,
        `ATTACH;ENCODING=BASE64;VALUE=BINARY;FMTTYPE=text/plain;X-${C.summary.toUpperCase()}=1:${Buffer.from(C.description).toString('base64')}`,
        `ATTACH:https://files.${C.location}.example.com/${C.summary}.pdf`,
        `ATTACH;MANAGED-ID=${C.uid}-other;FILENAME=${C.location}.txt:https://p42-content.icloud-content.com/${C.dsid}/${C.summary}/${C.location}.txt`,
    ];
    fake.calendars.get(C.calendarId)?.events.set(`${C.uid}-att.ics`, {
        ical: seedEvent({ uid: `${C.uid}-att`, summary: C.summary, start: FAKE_NOW + 3 * 86_400_000, attach }),
        etag: `"${C.etagPrefix}att"`,
        rev: 1,
    });
    seedAttachment(fake, id, C.description);
    return fake;
}

/** A backend module that touches the server and then fails with an error carrying canaries. */
const leakyBackend = async (): Promise<BackendLoad> => ({
    status: 'loaded',
    module: {
        createICloudBackend: (options?: { fetch?: typeof fetch }) => ({
            discover: async () => {
                await options?.fetch?.('https://caldav.icloud.com/', { method: 'PROPFIND', headers: { depth: '0' }, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', redirect: 'manual' });
                return { principalUrl: `https://caldav.icloud.com/${C.dsid}/principal/`, calendarHomeUrl: `https://p42-caldav.icloud.com/${C.dsid}/calendars/` };
            },
            validate: async () => C.summary,
            listCalendars: async () => { throw Object.assign(new Error(`${C.calendarName} ${C.appPassword}`), { code: C.calendarName }); },
        }),
    },
});

async function runAll(argv: string[], behaviour: Partial<FakeBehaviour>, prepare: (f: FakeICloud) => FakeICloud = (f) => f, backend?: () => Promise<BackendLoad>, wrapFetch?: (f: FakeICloud) => ProbeDeps['fetch']): Promise<{ stdout: string; stderr: string; code: number; scrubbed: number[]; fake: FakeICloud }> {
    const fake = prepare(standardAccount(C, behaviour));
    const out: string[] = [];
    const err: string[] = [];
    const scrubbed: number[] = [];
    const io: CliIo = {
        env: { PROBE_APPLE_ID: C.appleId.toUpperCase(), PROBE_APP_PASSWORD: C.appPassword, PROBE_INVITE_ATTENDEE: INVITEE, PROBE_INVITE_CONFIRM: 'send', PROBE_CLEANUP_CONFIRM: 'delete', AWS_REGION: 'us-west-2' },
        isTTY: false,
        promptLine: async () => undefined,
        promptHidden: async () => undefined,
        stdout: (t) => { out.push(t); },
        stderr: (t) => { err.push(t); },
    };
    const fetchOverride = wrapFetch === undefined ? {} : { fetch: wrapFetch(fake) };
    const code = await runCli(argv, io, {
        probe: async (input, hooks) => {
            const report = await runProbe(input, fakeDeps(fake, { confirmCleanup: hooks.confirmCleanup, ...fetchOverride, ...(backend === undefined ? {} : { loadBackend: backend }) }));
            scrubbed.push(report.redaction.scrubbedOccurrences);
            return report;
        },
        invokeLambda: async (_name, payload) => ({ ok: true, body: await runLambdaEvent(JSON.parse(payload), { ...fakeDeps(fake, fetchOverride), awsRegion: 'us-west-2' }) }),
    });
    return { stdout: out.join(''), stderr: err.join(''), code, scrubbed, fake };
}

describe('nothing personal reaches stdout, stderr or the JSON report', () => {
    const runs: [string, string[], Partial<FakeBehaviour>, ((f: FakeICloud) => FakeICloud)?][] = [
        ['read-only', [], {}],
        ['read-only, other behaviours', [], { expand: true, textMatch: true, freeBusyStatus: 200, uidFilterStatus: 207, syncLimitHonoured: true, weakEtags: true }],
        ['--json', ['--json'], {}],
        ['--write', ['--write'], {}],
        ['read-only, expansion that keeps forms and census-visible differences', [], { expand: true, expandStyle: 'keep-forms-no-vtimezone', expandKeepsDuration: true, queryCalendarData: 'dropped-x-properties', reportEtagSuffix: 'q', multigetHidesEvery: 2 }],
        ['--write, expansion that keeps forms and reads floating values in the calendar-timezone', ['--write'], {
            expand: true, expandStyle: 'keep-forms', floatingInterpretation: 'calendar-timezone', unknownTzid: 'as-new-york', thisAndFuture: 'applied', feb29: 'clamp', overrideMatching: 'original-slot', dateZeroLength: 'rewrite', rangeParam: 'strip',
        }],
        ['--write, a server that picks the second repeated hour and reads the skipped hour after the gap', ['--write'], { expand: true, repeatedHour: 'second', skippedHour: 'after-gap', overrideMatching: 'original-slot' }],
        ['--write, a server that refuses the calendar-timezone and unknown zones', ['--write'], { expand: true, calendarTimezone: 'refused', vtimezonePolicy: 'refuse-unknown', dateZeroLength: 'refuse', rangeParam: 'refuse' }],
        ['--write, other behaviours', ['--write'], { expand: true, textMatch: true, ifMatchStar: 'works', requireEnd: false, uniqueUidAcrossCalendars: false, putReturnsEtag: false, addsVtimezone: true, rewritesProdid: false, syncLimitHonoured: true }],
        ['read-only, attachments with canary names, hosts and parameters', [], {}, withAttachments],
        ['read-only, attachments whose URL redirects off the allowed hosts', [], { attachmentGet: 'redirect-content' }, withAttachments],
        ['--write, attachments with canaries and a server that serves them on the partition host', ['--write'], {}, withAttachments],
        ['--write, attachment host evidence and in-span override', ['--write'], { expand: true, attachmentHost: 'icloud-other' }, withAttachments],
        ['--write, attachments on another host, ignoring Range, with no headers or representation', ['--write'], { attachmentHost: 'content', attachmentGet: 'ignores-range', attachmentAddHeaders: false, attachmentAddRepresentation: false, attachmentSizeParam: false }, withAttachments],
        ['--write, attachments redirected, converted and refused', ['--write'], { attachmentGet: 'redirect-allowed', attachmentPut: 'inline-to-managed' }, withAttachments],
        ['--write, attachment actions refused and attachments dropped', ['--write'], { attachmentAdd: 'forbidden', attachmentPut: 'drop' }, withAttachments],
        ['--write, attachment actions answered 401', ['--write'], { attachmentAdd: 'unauthorized' }, withAttachments],
        ['--write with undeletable calendars', ['--write'], { deleteCollection: 'fails' }],
        ['--write --invite', ['--write', '--invite'], {}],
        ['--write, measured iCloud behaviour (every phase 3 check runs to the end)', ['--write'], ICLOUD_MEASURED],
        ['--write, measured, with every phase 3 question answered the other way', ['--write'], {
            ...ICLOUD_MEASURED, overrideRid: 'stored-text', orphanOverride: 'refused', endBeforeStart: 'refuse', unknownTzidPut: 'floating', foldOnGet: true, weeklyByMonthDay: 'ignored', ridMatching: 'utc-only',
        }],
        ['--write --invite with every invite step', ['--write', '--invite', '--invite-steps=all', '--invite-gap=10'], ICLOUD_MEASURED],
        ['--cleanup', ['--cleanup'], {}, withLeftovers],
        ['--lambda --write', ['--lambda', 'caldav-mcp-probe', '--write'], {}],
        ['--lambda --cleanup', ['--lambda', 'caldav-mcp-probe', '--cleanup'], {}, withLeftovers],
    ];
    for (const [name, argv, behaviour, prepare] of runs) {
        test(name, async () => {
            const result = await runAll(argv, behaviour, prepare);
            expect([0, 1]).toContain(result.code);
            if (argv.includes('--cleanup')) {
                // B1: the strict probe calendar is removed; the one named caldav-mcp-probe-<user text> is skipped.
                expect(result.fake.calendars.has('caldav-mcp-probe-0a0a0a0a')).toBe(false);
                expect(result.fake.calendars.has(`${C.calendarId}-odd`)).toBe(true);
                expect(result.fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.url.pathname)).toEqual([`/${C.dsid}/calendars/caldav-mcp-probe-0a0a0a0a/`]);
            }
            expect(result.stdout).toContain('"schemaVersion": 2');
            assertNoCanary(result.stdout, 'stdout');
            assertNoCanary(result.stderr, 'stderr');
            // The first layer alone must be enough: the scrubber should have had nothing to remove.
            expect(result.scrubbed.every((n) => n === 0)).toBe(true);
            const json = result.stdout.includes('JSON report:\n') ? result.stdout.slice(result.stdout.indexOf('JSON report:\n') + 13) : result.stdout;
            const printed = JSON.parse(json) as { redaction: { scrubbedOccurrences: number } };
            expect(printed.redaction.scrubbedOccurrences).toBe(0);
            expect(result.stdout).not.toContain('<scrubbed>');
            expect(result.stdout).not.toMatch(/"(?:W\/)?"?Canary/);
        });
    }

    test('error paths: a failing server and a leaky backend module', async () => {
        const chaos = await runAll(['--write'], { hook: (req, n) => (n > 12 && n % 3 === 0 ? new Response(`<d:error xmlns:d="DAV:"><d:href>/${C.dsid}/${C.calendarId}/</d:href><d:x>${C.summary}</d:x></d:error>`, { status: 403, headers: { etag: `"${C.etagPrefix}x"`, location: `/${C.dsid}/` } }) : undefined) });
        assertNoCanary(chaos.stdout + chaos.stderr, 'chaos run');
        const leaky = await runAll([], {}, undefined, leakyBackend);
        assertNoCanary(leaky.stdout + leaky.stderr, 'leaky backend run');
        expect(leaky.stdout).toContain('skeleton-backend');
    });

    test('wrong password: only the fixed authentication message', async () => {
        const fake = standardAccount(C);
        const out: string[] = [];
        const code = await runCli([], {
            env: { PROBE_APPLE_ID: C.appleId, PROBE_APP_PASSWORD: 'wrong-but-canary-q7x2' },
            isTTY: false, promptLine: async () => undefined, promptHidden: async () => undefined,
            stdout: (t) => { out.push(t); }, stderr: (t) => { out.push(t); },
        }, { probe: (input) => runProbe(input, fakeDeps(fake)), invokeLambda: async () => ({ ok: false, code: 'x' }) });
        expect(code).toBe(1);
        assertNoCanary(out.join(''), 'wrong password run');
        expect(out.join('')).toContain('401');
    });

    test('i3: hostile header, XML element and iCalendar property names never reach the output', async () => {
        const hostile = (fake: FakeICloud): ProbeDeps['fetch'] => async (input, init) => {
            const res = await fake.fetch(input, init);
            const method = (init?.method ?? 'GET').toUpperCase();
            const headers = new Headers(res.headers);
            headers.set(`x-${C.calendarId.toLowerCase()}-trace`, '1');
            headers.set('x-rate-98765432101', '1');
            let body: BodyInit | null = res.body;
            if (method === 'GET' && res.status === 200) {
                body = (await res.text()).replace('END:VEVENT', `X-${C.summary.toUpperCase()}:1\r\nEND:VEVENT`);
            }
            if (method === 'PUT' && new URL(String(input)).pathname.includes('dupsame')) {
                return new Response(`<d:error xmlns:d="DAV:"><d:${C.location}/></d:error>`, { status: 403, headers });
            }
            return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, headers });
        };
        for (const argv of [[], ['--write']]) {
            const result = await runAll(argv, {}, undefined, undefined, hostile);
            assertNoCanary(result.stdout, 'stdout');
            assertNoCanary(result.stderr, 'stderr');
            expect(result.scrubbed.every((n) => n === 0)).toBe(true);
            expect(result.stdout).toContain('<other>');
        }
    });

    test('the temporary calendar name is the only calendar name printed', async () => {
        const result = await runAll(['--write'], { deleteCollection: 'fails' });
        expect(result.code).toBe(1);
        expect(result.stdout).toMatch(/TEMPORARY CALENDAR NOT REMOVED/);
        const names = [...result.stdout.matchAll(/caldav-mcp-probe-[0-9a-f]{8}\b/g)].map((m) => m[0]);
        expect(names.length).toBeGreaterThan(0);
    });
});
