/**
 * Regression for a side channel in the second redaction layer: a short value seen in the
 * account's data ("side") was substring-replaced inside the probe's own sentence ("inside"),
 * so the report disclosed the value. Probe-authored text must never change because of what
 * the account holds.
 */
import { describe, expect, test } from 'bun:test';
import { Taint, fixed, prose, renderProse, scrubValue } from '../scripts/probe/safe';
import type { EvidenceValue, ProbeDeps, ProbeFlags, ProbeReport } from '../scripts/probe/types';
import { FAKE_NOW, PLAIN, probeStyleEvent, seedAttachment, seedCalendar, seedEvent, standardAccount, type FakeBehaviour, type FakeICloud } from './fixtures/probe/fake-icloud';
import { probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const INVITEE = 'invitee@example.invalid';
const DAY = 86_400_000;

/** Short values that occur inside the probe's own words, and neutral values of the same length. */
const SEEDS = ['side', 'even', 'time', 'rang', 'sync', 'calendar', 'event', 'match', 'token', 'probe', 'list', 'with', 'from', 'test', 'name'];
const NEUTRAL = SEEDS.map((word, i) => `qvjw${String.fromCharCode(97 + i)}${'x'.repeat(word.length)}`.slice(0, word.length));

function seededFetch(fake: FakeICloud, words: readonly string[]): ProbeDeps['fetch'] {
    let n = 0;
    return async (input, init) => {
        const res = await fake.fetch(input, init);
        const headers = new Headers(res.headers);
        // A response header value the probe taints (not a header it treats as structural).
        headers.set('x-request-note', words[n++ % words.length] ?? '');
        return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers });
    };
}

function account(words: readonly string[], behaviour: Partial<FakeBehaviour> = {}): FakeICloud {
    const fake = standardAccount(PLAIN, behaviour);
    words.forEach((word, i) => {
        // Every word is also a file name, a MANAGED-ID, an extra parameter name, a path and a host label of an attachment.
        const attach = [
            `ATTACH;MANAGED-ID=${word}-id;FMTTYPE=text/plain;SIZE=${word.length};FILENAME=${word}.txt;X-APPLE-FILENAME=${word}.txt;X-${word.toUpperCase()}=${word}:https://p42-caldav.icloud.com:443/10000000001/attachments/${word}-id/${word}.txt`,
            `ATTACH;ENCODING=BASE64;VALUE=BINARY;FMTTYPE=text/plain:${Buffer.from(word).toString('base64')}`,
            `ATTACH:https://${word}.example.com/${word}.pdf`,
        ];
        seedAttachment(fake, `${word}-id`, word);
        seedCalendar(fake, {
            id: `seeded-${i}`,
            displayName: word,
            events: [{
                name: `seeded-${i}.ics`,
                ical: seedEvent({ uid: `seeded-uid-${i}`, summary: word, description: word, location: word, attendee: `${word}@example.invalid`, start: FAKE_NOW + (i + 1) * DAY, attach }),
            }],
        });
    });
    // A leftover the --cleanup run may remove.
    seedCalendar(fake, { id: 'caldav-mcp-probe-0a0a0a0a', displayName: 'caldav-mcp-probe-0a0a0a0a', events: [probeStyleEvent('caldav-mcp-probe-0a0a0a0a-1')] });
    return fake;
}

const WRITE_FLAGS: ProbeFlags = { write: true, invite: false, cleanup: false };

const MODES: [string, ProbeFlags][] = [
    ['read-only', { write: false, invite: false, cleanup: false }],
    ['write', { write: true, invite: false, cleanup: false }],
    ['invite', { write: true, invite: true, cleanup: false }],
    ['cleanup', { write: false, invite: false, cleanup: true }],
];

/** A server that expands and answers the way that records the most (values of probe-authored events, forms of the account's). */
const RECORDING: Partial<FakeBehaviour> = { expand: true, expandStyle: 'keep-forms', floatingInterpretation: 'calendar-timezone', thisAndFuture: 'applied', multigetHidesEvery: 3 };

async function run(words: readonly string[], flags: ProbeFlags, behaviour: Partial<FakeBehaviour> = {}): Promise<ProbeReport> {
    const fake = account(words, behaviour);
    return probe(fake, flags, creds, { fetch: seededFetch(fake, words), confirmCleanup: async () => true }, flags.invite ? INVITEE : undefined);
}

/** Everything the probe itself authors: ids, plan items, claims, summaries and evidence keys. */
function authored(report: ProbeReport): unknown {
    return report.checks.map((c) => ({ id: c.id, planItem: c.planItem, claim: c.claim, summary: c.summary, evidenceKeys: Object.keys(c.evidence) }));
}

function evidenceStrings(value: EvidenceValue): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.map(String);
    }
    if (value !== null && typeof value === 'object') {
        return Object.values(value).filter((v): v is string => typeof v === 'string');
    }
    return [];
}

describe('short tainted values inside the probe’s own words (redaction side channel)', () => {
    const VARIANTS: [string, Partial<FakeBehaviour>][] = [['', {}], [', expansion recording forms and values', RECORDING]];
    for (const [name, flags] of MODES) {
        for (const [variant, behaviour] of VARIANTS) {
        test(`${name}${variant}: probe-authored text is identical to a run with neutral values, and nothing is scrubbed`, async () => {
            const seeded = await run(SEEDS, flags, behaviour);
            const neutral = await run(NEUTRAL, flags, behaviour);
            expect(seeded.checks.length).toBeGreaterThan(2);
            expect(authored(seeded)).toEqual(authored(neutral));
            expect(seeded.redaction.scrubbedOccurrences).toBe(0);
            expect(neutral.redaction.scrubbedOccurrences).toBe(0);
            expect(seeded.cleanup).toEqual(neutral.cleanup);
            // Stronger still: nothing in the report depends on which words the account holds.
            expect(JSON.stringify(seeded)).toBe(JSON.stringify(neutral));
            for (const c of seeded.checks) {
                for (const text of [c.id, c.planItem, c.claim, c.summary, ...Object.keys(c.evidence)]) {
                    expect(text).not.toContain('<scrubbed>');
                }
                for (const value of Object.values(c.evidence).flatMap(evidenceStrings)) {
                    expect(value).not.toContain('<scrubbed>');
                    expect(SEEDS).not.toContain(value.toLowerCase());
                }
            }
            expect(JSON.stringify(seeded)).not.toContain('<scrubbed>');
        });
        }
    }

    for (const [mode, flags] of MODES.slice(0, 2)) {
        test(`${mode}: date and numeric owner text cannot rewrite synthetic evidence`, async () => {
            const colliding = ['20280229', '2028', 'text/plain', 'uri-managed', 'preserved', 'body_too_large'];
            const neutral = colliding.map((word) => 'q'.repeat(word.length));
            const a = await run(colliding, flags, RECORDING);
            const b = await run(neutral, flags, RECORDING);
            expect(JSON.stringify(a)).toBe(JSON.stringify(b));
            expect(a.redaction.scrubbedOccurrences).toBe(0);
            expect(b.redaction.scrubbedOccurrences).toBe(0);
        });
    }

    test('write: the DST and moved-override checks publish their values, and owner text that looks like them or like their enums changes nothing', async () => {
        const NEW_CHECKS = ['write-dst-repeated-hour', 'write-dst-skipped-hour', 'write-dst-utc-in-repeated-hour', 'write-moved-overrides', 'write-moved-override-in-span'];
        const colliding = ['20271107T053000Z', '20271107', '20270130T100000Z', '20270314T073000Z', '2027', 'date', 'floating', 'invalid', 'first', 'second', 'gap', 'before', 'after', 'tzid'];
        const neutral = colliding.map((word) => 'q'.repeat(word.length));
        // The second server answers the other way on every DST question, so the refuting values are published too.
        const behaviours: Partial<FakeBehaviour>[] = [RECORDING, { expand: true, expandStyle: 'utc-all', repeatedHour: 'second', skippedHour: 'after-gap' }];
        for (const behaviour of behaviours) {
            const a = await run(colliding, WRITE_FLAGS, behaviour);
            const b = await run(neutral, WRITE_FLAGS, behaviour);
            expect(JSON.stringify(a)).toBe(JSON.stringify(b));
            expect(a.redaction.scrubbedOccurrences).toBe(0);
            for (const id of NEW_CHECKS) {
                const result = a.checks.find((c) => c.id === id);
                expect(result).toBeDefined();
                expect(['skipped', 'error']).not.toContain(result?.outcome);
                expect(Object.keys(result?.evidence ?? {}).some((key) => key.endsWith('Tuples'))).toBe(true);
            }
        }
    });

    test('write: managed-host shapes and auth schemes are invariant to colliding owner text', async () => {
        const colliding = ['pN-attachment.icloud.com', 'attachments', 'digits', 'uuid', 'filename', 'basic', '20270121T100000Z'];
        const neutral = colliding.map((word) => 'q'.repeat(word.length));
        for (const behaviour of [
            { expand: true, attachmentHost: 'icloud-other' },
            { expand: true, attachmentHost: 'icloud-other', attachmentGet: 'redirect-content' },
        ] satisfies Partial<FakeBehaviour>[]) {
            const a = await run(colliding, WRITE_FLAGS, behaviour);
            const b = await run(neutral, WRITE_FLAGS, behaviour);
            expect(JSON.stringify(a)).toBe(JSON.stringify(b));
            expect(a.redaction.scrubbedOccurrences).toBe(0);
            const managed = a.checks.find((c) => c.id === 'write-attachment-managed');
            expect(managed?.evidence).toHaveProperty('urlHostMasked', 'pN-attachment.icloud.com');
            expect(managed?.outcome).toBe('confirmed');
        }
    });

    test('date-shaped server text is not vocabulary and is still scrubbed', () => {
        const taint = new Taint();
        taint.add('20280229');
        expect(scrubValue({ leaked: fixed('20280229') }, taint)).toMatchObject({ value: { leaked: '<scrubbed>' }, count: 1 });
    });

    test('the seeds really were tainted: a check that leaks one into a variable part still loses it', async () => {
        // The same words, but a summary slot and an evidence value carry them, as a buggy check would.
        const taint = new Taint();
        for (const word of SEEDS) {
            taint.add(word);
        }
        const sentence = prose`The time range selected exactly the event inside it (${fixed('side')}, ${fixed('x-side-trace')}, ${3}).`;
        const rendered = renderProse(sentence, taint);
        expect(rendered.text).toBe('The time range selected exactly the event inside it (<scrubbed>, <scrubbed>, 3).');
        expect(rendered.count).toBe(2);
        const evidence = scrubValue({ insideStatus: 207, leaked: fixed('probe'), names: [fixed('accept-ranges'), fixed('x-token-id')], shape: fixed('/<id>/calendars/<probe>.ics'), code: fixed('timeout') }, taint);
        expect(evidence.value).toEqual({ insideStatus: 207, leaked: fixed('<scrubbed>'), names: [fixed('accept-ranges'), fixed('<scrubbed>')], shape: fixed('/<id>/calendars/<probe>.ics'), code: fixed('timeout') });
        expect(evidence.count).toBe(2);
    });
});
