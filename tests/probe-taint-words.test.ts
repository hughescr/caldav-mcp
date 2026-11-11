/**
 * Regression for a side channel in the second redaction layer: a short value seen in the
 * account's data ("side") was substring-replaced inside the probe's own sentence ("inside"),
 * so the report disclosed the value. Probe-authored text must never change because of what
 * the account holds.
 */
import { describe, expect, test } from 'bun:test';
import { Taint, fixed, prose, renderProse, scrubValue } from '../scripts/probe/safe';
import type { EvidenceValue, ProbeDeps, ProbeFlags, ProbeReport } from '../scripts/probe/types';
import { FAKE_NOW, PLAIN, probeStyleEvent, seedCalendar, seedEvent, standardAccount, type FakeICloud } from './fixtures/probe/fake-icloud';
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

function account(words: readonly string[]): FakeICloud {
    const fake = standardAccount(PLAIN);
    words.forEach((word, i) => {
        seedCalendar(fake, {
            id: `seeded-${i}`,
            displayName: word,
            events: [{
                name: `seeded-${i}.ics`,
                ical: seedEvent({ uid: `seeded-uid-${i}`, summary: word, description: word, location: word, attendee: `${word}@example.invalid`, start: FAKE_NOW + (i + 1) * DAY }),
            }],
        });
    });
    // A leftover the --cleanup run may remove.
    seedCalendar(fake, { id: 'caldav-mcp-probe-0a0a0a0a', displayName: 'caldav-mcp-probe-0a0a0a0a', events: [probeStyleEvent('caldav-mcp-probe-0a0a0a0a-1')] });
    return fake;
}

const MODES: [string, ProbeFlags][] = [
    ['read-only', { write: false, invite: false, cleanup: false }],
    ['write', { write: true, invite: false, cleanup: false }],
    ['invite', { write: true, invite: true, cleanup: false }],
    ['cleanup', { write: false, invite: false, cleanup: true }],
];

async function run(words: readonly string[], flags: ProbeFlags): Promise<ProbeReport> {
    const fake = account(words);
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
    for (const [name, flags] of MODES) {
        test(`${name}: probe-authored text is identical to a run with neutral values, and nothing is scrubbed`, async () => {
            const seeded = await run(SEEDS, flags);
            const neutral = await run(NEUTRAL, flags);
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
