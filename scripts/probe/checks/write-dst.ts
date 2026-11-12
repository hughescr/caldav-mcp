/**
 * Write-mode evidence for what iCloud does with an America/New_York wall-clock time on the night
 * the clocks change: a time that occurs twice (01:30 on 2027-11-07), a time that does not exist
 * (02:30 on 2027-03-14), and, as the control, the same instants written in UTC. Each zone case
 * writes one non-recurring event and one weekly series (COUNT=3) whose middle instance falls on
 * the changeover day, then reads back what was stored, how the events expand and which narrow
 * UTC windows select them. Everything recorded is the probe's own; values are published only
 * for resources whose URL and UID were validated (`readStored`, `windowResources`).
 */
import { isOk, type CheckContext, type CheckDef, type CheckOutput } from '../context';
import { icalLocal, icalUtc, prop, props, type IcalComponent } from '../ical';
import { dateShape, kindOf } from '../ical-time';
import { prose, safeNames, type Prose } from '../safe';
import type { Evidence } from '../types';
import { PLAN, windowResources, type Expanded } from './write-expansion';
import { HOUR, SUMMARY, newEvent, primary, probeCalendar, putEvent } from './write-helpers';
import { compareInstances, describeResult, describeStored, instanceOf, readStored, readableInstants, selectedIn, type Expected, type Stored } from './write-instances';
import { NEW_YORK, parseWall, wallToInstant } from './zones';

const ZONE = 'America/New_York';
const MINUTE = 60_000;
type Window = readonly [number, number];

interface Item { key: string; suffix: string; lines: readonly string[] }
interface GatherSpec { items: readonly Item[]; vtimezone: boolean; tzid: string | null; expandWindow: Window; windows: readonly Window[] }
interface Gathered {
    evidence: Evidence;
    /** Every PUT was accepted, every read-back was a 200, every REPORT answered 207 and returned every resource. */
    complete: boolean;
    stored: Map<string, Stored>;
    expanded: Map<string, Expanded | undefined>;
    /** Per item, per window: selected, or undefined when the query was not answered. */
    selected: Map<string, (boolean | undefined)[]>;
}

/** PUT that may be refused: the status and preconditions are the evidence, and the check goes on without that resource. */
async function tryPut(ctx: CheckContext, url: string, body: string, evidence: Evidence, key: string): Promise<boolean> {
    const put = await putEvent(ctx, url, body, { 'if-none-match': '*' });
    evidence[`${key}PutStatus`] = put.status;
    if (!isOk(put.status)) {
        evidence[`${key}Preconditions`] = safeNames(put.errorElements, ctx.taint);
        return false;
    }
    return true;
}

/** Validate coverage and identity without choosing an interpretation of an ambiguous wall time. */
function structureValid(events: readonly IcalComponent[], item: Item, tzid: string | null): boolean {
    const recurring = item.lines.some((line) => line === 'RRULE:FREQ=WEEKLY;COUNT=3');
    const count = recurring ? 3 : 1;
    const start = item.lines.find((line) => line.startsWith('DTSTART'))?.split(':').at(-1);
    const end = item.lines.find((line) => line.startsWith('DTEND'))?.split(':').at(-1);
    const wall = parseWall(start);
    if (events.length !== count || wall === undefined || end === undefined) {
        return false;
    }
    const slots = Array.from({ length: count }, (_, i) => icalLocal(wall + i * 7 * 86_400_000));
    const identities = events.map((event) => JSON.stringify([prop(event, 'DTSTART')?.value, prop(event, 'RECURRENCE-ID')?.value]));
    if (new Set(identities).size !== count || events.some((event) => {
        const kind = kindOf(prop(event, 'DTSTART'));
        return !['utc', 'tzid'].includes(kind) || prop(event, 'RRULE') !== undefined
            || ['DTSTART', 'DTEND', ...(recurring ? ['RECURRENCE-ID'] : [])].some((name) => {
                const p = prop(event, name);
                return props(event, name).length !== 1 || kindOf(p) !== kind || (kind === 'tzid' ? tzid === null || p?.params.TZID !== tzid : p?.params.TZID !== undefined);
            }) || (!recurring && props(event, 'RECURRENCE-ID').length !== 0);
    })) {
        return false;
    }
    // UTC values are interpreted by pickOf; their dates still establish the expected weekly slots.
    // TZID-preserving answers must match the entire authored wall-clock tuple, not just its date.
    const expectedDates = slots.map((slot) => slot.slice(0, 8)).toSorted();
    const dates = events.map((event) => prop(event, recurring ? 'RECURRENCE-ID' : 'DTSTART')?.value.slice(0, 8)).toSorted();
    if (!dates.every((date, i) => date === expectedDates[i])) {
        return false;
    }
    if (events.every((event) => kindOf(prop(event, 'DTSTART')) === 'tzid')) {
        const endWall = parseWall(end);
        return endWall !== undefined && compareInstances(events, slots.map((slot, i) => ({ start: slot, rid: recurring ? slot : null, ends: [icalLocal(endWall + i * 7 * 86_400_000)] }))).full;
    }
    return events.every((event) => kindOf(prop(event, 'DTSTART')) === 'utc');
}

/** The writes and reads every zone case needs. Each request goes through the guarded path: primary calendar, `newEvent`, `putEvent`, validated read-back. */
async function gather(ctx: CheckContext, spec: GatherSpec): Promise<Gathered> {
    const temp = primary(ctx);
    const evidence: Evidence = {};
    const stored = new Map<string, Stored>();
    const expanded = new Map<string, Expanded | undefined>();
    const selected = new Map<string, (boolean | undefined)[]>();
    let complete = true;
    const accepted: { key: string; url: string; uid: string }[] = [];
    for (const item of spec.items) {
        const { url, uid } = newEvent(temp, item.suffix);
        const body = probeCalendar(ctx, uid, item.lines, spec.vtimezone ? { vtimezone: NEW_YORK } : {});
        if (await tryPut(ctx, url, body, evidence, item.key)) {
            accepted.push({ key: item.key, url, uid });
        } else {
            complete = false;
        }
    }
    for (const item of accepted) {
        const read = await readStored(ctx, temp, item.url, item.uid);
        stored.set(item.key, read);
        Object.assign(evidence, describeStored(item.key, read, spec.tzid));
        complete &&= read.status === 200 && read.events.length > 0;
    }
    if (accepted.length === 0) {
        return { evidence, complete: false, stored, expanded, selected };
    }
    const hrefs = accepted.map((a) => a.url);
    const got = await windowResources(ctx, temp, hrefs, spec.expandWindow[0], spec.expandWindow[1], 'expand');
    for (const item of accepted) {
        const result = got.get(item.url);
        expanded.set(item.key, result);
        Object.assign(evidence, describeResult(`${item.key}Expanded`, result));
        const authored = spec.items.find((candidate) => candidate.key === item.key);
        const valid = result !== undefined && authored !== undefined && structureValid(result.events, authored, spec.tzid);
        evidence[`${item.key}ExpandedStructureValid`] = valid;
        complete &&= result?.status === 207 && result.returned && valid;
        selected.set(item.key, []);
    }
    for (const [n, window] of spec.windows.entries()) {
        const answer = await selectedIn(ctx, temp, hrefs, window[0], window[1]);
        evidence[`window${n + 1}Status`] = answer.status;
        evidence[`window${n + 1}Start`] = dateShape(icalUtc(window[0]));
        evidence[`window${n + 1}End`] = dateShape(icalUtc(window[1]));
        complete &&= answer.status === 207;
        for (const item of accepted) {
            const inside = answer.selected.get(item.url);
            selected.get(item.key)?.push(inside);
            evidence[`${item.key}InWindow${n + 1}`] = inside ?? null;
        }
    }
    return { evidence, complete, stored, expanded, selected };
}

const utcAt = (local: string, offsetMinutes: number): number => wallToInstant(parseWall(local) ?? Number.NaN, offsetMinutes);

/** One expected instance: its start is the wall-clock time read with `startOffset`; its end is the wall-clock end with `endOffset`, or the start plus the master's one hour. */
function expectedAt(startLocal: string, startOffset: number, endLocal: string, endOffset: number, recurring: boolean): Expected {
    const start = utcAt(startLocal, startOffset);
    return { start: icalUtc(start), rid: recurring ? icalUtc(start) : null, ends: [icalUtc(utcAt(endLocal, endOffset)), icalUtc(start + HOUR)] };
}

type Pick = string;
const UNKNOWN: Pick = 'unknown';
const OTHER: Pick = 'other';

/** Which expected reading the expanded instances follow: the variant whose (DTSTART, RECURRENCE-ID) multiset equals the observed one. */
function pickOf(got: Expanded | undefined, variants: Readonly<Record<string, readonly Expected[]>>): { pick: Pick; full: boolean } {
    if (got === undefined || got.status !== 207 || !readableInstants(got.events)) {
        return { pick: UNKNOWN, full: false };
    }
    for (const [name, expected] of Object.entries(variants)) {
        const match = compareInstances(got.events, expected);
        if (match.starts) {
            return { pick: name, full: match.full };
        }
    }
    return { pick: OTHER, full: false };
}

/** Booleans only: the names of the readings are not values the second redaction layer could safely leave alone. */
function pickEvidence(prefix: string, pick: Pick, names: readonly string[]): Evidence {
    return {
        [`${prefix}Readable`]: pick !== UNKNOWN,
        [`${prefix}MatchesNeither`]: pick === OTHER,
        ...Object.fromEntries(names.map((name) => [`${prefix}Is${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`, pick === name])),
    };
}

interface Signals { names: readonly string[]; picks: Record<string, Pick>; fulls: boolean[] }

interface Rules {
    good: Pick;
    /** A known signal in this set argues against the claim. */
    bad: readonly Pick[];
    /** A known signal in this set rules out a refutation (it contradicts `bad`). */
    blocks: readonly Pick[];
    /** Refuting needs complete coverage as well. */
    refuteNeedsCoverage: boolean;
}

type Verdict = 'confirmed' | 'refuted' | 'inconclusive';

function decide(signals: Signals, rules: Rules, complete: boolean, primarySignal: string): Verdict {
    if (!complete) {
        return 'inconclusive';
    }
    const known = Object.values(signals.picks).filter((p) => p !== UNKNOWN);
    if (complete && signals.picks[primarySignal] === rules.good && known.every((p) => p === rules.good) && signals.fulls.every(Boolean)) {
        return 'confirmed';
    }
    if (known.some((p) => rules.bad.includes(p)) && !known.some((p) => rules.blocks.includes(p)) && (complete || !rules.refuteNeedsCoverage)) {
        return 'refuted';
    }
    return 'inconclusive';
}

function collect(g: Gathered, variants: Readonly<Record<string, readonly Expected[]>>, series: Readonly<Record<string, readonly Expected[]>>, windowPick: (inside: readonly (boolean | undefined)[]) => Pick): Signals & { evidence: Evidence } {
    const names = Object.keys(variants);
    const single = pickOf(g.expanded.get('single'), variants);
    const multi = pickOf(g.expanded.get('series'), series);
    const picks: Record<string, Pick> = {
        expandedSingle: single.pick,
        expandedSeries: multi.pick,
        windowSingle: windowPick(g.selected.get('single') ?? []),
        windowSeries: windowPick(g.selected.get('series') ?? []),
    };
    const evidence: Evidence = {};
    for (const [signal, pick] of Object.entries(picks)) {
        Object.assign(evidence, pickEvidence(signal, pick, names));
    }
    const fulls = [single, multi].filter((s) => s.pick !== UNKNOWN && s.pick !== OTHER).map((s) => s.full);
    evidence.endsPlausibleWhereReadable = fulls.every(Boolean);
    return { names, picks, fulls, evidence };
}

const utcMs = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi);
const windowAt = (y: number, mo: number, d: number, h: number, mi: number): Window => [utcMs(y, mo, d, h, mi), utcMs(y, mo, d, h, mi) + 30 * MINUTE];

// ---- the repeated hour --------------------------------------------------------------------------

const REPEATED_SINGLE = { start: '20271107T013000', end: '20271107T023000' };
const REPEATED_SERIES = { start: '20271031T013000', end: '20271031T023000' };

const zoneLines = (start: string, end: string, extra: readonly string[] = []): string[] => [`DTSTART;TZID=${ZONE}:${start}`, `DTEND;TZID=${ZONE}:${end}`, ...extra, `SUMMARY:${SUMMARY}`];

export const dstRepeatedHourCheck: CheckDef = {
    id: 'write-dst-repeated-hour',
    planItem: `${PLAN}: a TZID wall-clock time that occurs twice`,
    claim: 'An event at 01:30 America/New_York on 2027-11-07 (a time that occurs twice) and the second instance of a weekly series from 2027-10-31 are placed at the FIRST occurrence (05:30Z, EDT, RFC 5545 section 3.3.5), not the second (06:30Z, EST).',
    needs: 'temp',
    async run(ctx) {
        const g = await gather(ctx, {
            items: [
                { key: 'single', suffix: 'wdstrepone', lines: zoneLines(REPEATED_SINGLE.start, REPEATED_SINGLE.end) },
                { key: 'series', suffix: 'wdstrepser', lines: zoneLines(REPEATED_SERIES.start, REPEATED_SERIES.end, ['RRULE:FREQ=WEEKLY;COUNT=3']) },
            ],
            vtimezone: true, tzid: ZONE,
            expandWindow: [utcMs(2027, 10, 30), utcMs(2027, 11, 16)],
            windows: [windowAt(2027, 11, 7, 5, 15), windowAt(2027, 11, 7, 6, 15)],
        });
        const single = (startOffset: number): Expected[] => [expectedAt(REPEATED_SINGLE.start, startOffset, REPEATED_SINGLE.end, -300, false)];
        const series = (novemberSeventh: number): Expected[] => [
            expectedAt('20271031T013000', -240, '20271031T023000', -240, true),
            expectedAt('20271107T013000', novemberSeventh, '20271107T023000', -300, true),
            expectedAt('20271114T013000', -300, '20271114T023000', -300, true),
        ];
        const windowPick = (inside: readonly (boolean | undefined)[]): Pick => {
            const [early, late] = inside;
            if (early === undefined || late === undefined) {
                return UNKNOWN;
            }
            // The event is an hour or more long, so the early window also selects it when it starts at 05:30Z; it does not when it starts at 06:30Z.
            return early ? 'first' : late ? 'second' : OTHER;
        };
        const signals = collect(g, { first: single(-240), second: single(-300) }, { first: series(-240), second: series(-300) }, windowPick);
        Object.assign(g.evidence, signals.evidence, { expectedFirstInstant: dateShape(icalUtc(utcAt('20271107T013000', -240))), expectedSecondInstant: dateShape(icalUtc(utcAt('20271107T013000', -300))), coverageComplete: g.complete });
        const known = Object.values(signals.picks).filter((p) => p !== UNKNOWN).length;
        const outcome = decide(signals, { good: 'first', bad: ['second'], blocks: ['first', OTHER], refuteNeedsCoverage: false }, g.complete, 'windowSingle');
        return answer(outcome, g.evidence, {
            confirmed: prose`All ${known} readable signal(s) put the repeated 01:30 at the first occurrence (05:30Z).`,
            refuted: prose`The repeated 01:30 was placed at the second occurrence (06:30Z) by at least one signal, and by none at the first.`,
            inconclusive: prose`The signals do not settle which 01:30 was used (${known} readable; coverage ${g.complete ? prose`complete` : prose`incomplete`}).`,
        });
    },
};

function answer(outcome: Verdict, evidence: Evidence, summaries: Record<Verdict, Prose>): CheckOutput {
    return { outcome, summary: summaries[outcome], evidence };
}

// ---- the skipped hour ---------------------------------------------------------------------------

const SKIPPED_SINGLE = { start: '20270314T023000', end: '20270314T033000' };
const SKIPPED_SERIES = { start: '20270307T023000', end: '20270307T033000' };

export const dstSkippedHourCheck: CheckDef = {
    id: 'write-dst-skipped-hour',
    planItem: `${PLAN}: a TZID wall-clock time that does not exist`,
    claim: 'An event at 02:30 America/New_York on 2027-03-14 (a time that does not exist) and the second instance of a weekly series from 2027-03-07 are accepted and placed at 07:30Z (the offset before the gap, EST; RFC 5545 section 3.3.5).',
    needs: 'temp',
    async run(ctx) {
        const g = await gather(ctx, {
            items: [
                { key: 'single', suffix: 'wdstskpone', lines: zoneLines(SKIPPED_SINGLE.start, SKIPPED_SINGLE.end) },
                { key: 'series', suffix: 'wdstskpser', lines: zoneLines(SKIPPED_SERIES.start, SKIPPED_SERIES.end, ['RRULE:FREQ=WEEKLY;COUNT=3']) },
            ],
            vtimezone: true, tzid: ZONE,
            expandWindow: [utcMs(2027, 3, 6), utcMs(2027, 3, 23)],
            windows: [windowAt(2027, 3, 14, 7, 15), windowAt(2027, 3, 14, 6, 15)],
        });
        const single = (offset: number): Expected[] => [expectedAt(SKIPPED_SINGLE.start, offset, SKIPPED_SINGLE.end, -240, false)];
        const series = (offset: number): Expected[] => [
            expectedAt('20270307T023000', -300, '20270307T033000', -300, true),
            expectedAt('20270314T023000', offset, '20270314T033000', -240, true),
            expectedAt('20270321T023000', -240, '20270321T033000', -240, true),
        ];
        const windowPick = (inside: readonly (boolean | undefined)[]): Pick => {
            const [at0730, at0630] = inside;
            if (at0730 === undefined || at0630 === undefined) {
                return UNKNOWN;
            }
            // 07:30Z is selected by [07:15Z, 07:45Z) and not by [06:15Z, 06:45Z); 06:30Z-07:30Z is selected by both.
            return at0730 && !at0630 ? 'beforeGap' : at0730 && at0630 ? 'afterGap' : OTHER;
        };
        const signals = collect(g, { beforeGap: single(-300), afterGap: single(-240) }, { beforeGap: series(-300), afterGap: series(-240) }, windowPick);
        Object.assign(g.evidence, signals.evidence, {
            expectedInstant: dateShape(icalUtc(utcAt('20270314T023000', -300))), alternativeInstant: dateShape(icalUtc(utcAt('20270314T023000', -240))),
            coverageComplete: g.complete,
        });
        const known = Object.values(signals.picks).filter((p) => p !== UNKNOWN).length;
        const outcome = decide(signals, { good: 'beforeGap', bad: ['afterGap', OTHER], blocks: ['beforeGap'], refuteNeedsCoverage: true }, g.complete, 'windowSingle');
        return answer(outcome, g.evidence, {
            confirmed: prose`All ${known} readable signal(s) put the skipped 02:30 at 07:30Z, the offset before the gap.`,
            refuted: prose`The skipped 02:30 was placed at another instant than 07:30Z by at least one signal, and by none at 07:30Z.`,
            inconclusive: prose`The result could not be read completely: a PUT was refused, data was missing or unreadable, or the signals disagree (${known} readable; coverage ${g.complete ? prose`complete` : prose`incomplete`}).`,
        });
    },
};

// ---- the control: the same instants in UTC ------------------------------------------------------

const UTC_FIRST = { start: '20271107T053000Z', end: '20271107T063000Z' };
const UTC_SECOND = { start: '20271107T063000Z', end: '20271107T073000Z' };

export const dstUtcControlCheck: CheckDef = {
    id: 'write-dst-utc-in-repeated-hour',
    planItem: `${PLAN}: the control for the repeated hour, two UTC events`,
    claim: 'Two one-hour UTC events at 05:30Z and 06:30Z on 2027-11-07 are stored and expanded as UTC, stay distinct, and are selected exactly by the narrow windows that overlap them.',
    needs: 'temp',
    async run(ctx) {
        const g = await gather(ctx, {
            items: [
                { key: 'first', suffix: 'wdstutca', lines: [`DTSTART:${UTC_FIRST.start}`, `DTEND:${UTC_FIRST.end}`, `SUMMARY:${SUMMARY}`] },
                { key: 'second', suffix: 'wdstutcb', lines: [`DTSTART:${UTC_SECOND.start}`, `DTEND:${UTC_SECOND.end}`, `SUMMARY:${SUMMARY}`] },
            ],
            vtimezone: false, tzid: null,
            expandWindow: [utcMs(2027, 11, 6), utcMs(2027, 11, 9)],
            // The first two windows are the ones of write-dst-repeated-hour; the third overlaps only the second event.
            windows: [windowAt(2027, 11, 7, 5, 15), windowAt(2027, 11, 7, 6, 15), windowAt(2027, 11, 7, 6, 45)],
        });
        const sent = { first: UTC_FIRST, second: UTC_SECOND };
        let allMatch = g.complete;
        for (const [key, times] of Object.entries(sent)) {
            const read = g.stored.get(key);
            const readBack = read?.events.length === 1 && read.events[0] !== undefined ? instanceOf(read.events[0]) : undefined;
            const storedOk = readBack?.start === times.start && readBack.end === times.end && readBack.rid === null;
            const expanded = g.expanded.get(key);
            const expandedOk = expanded !== undefined && expanded.status === 207 && compareInstances(expanded.events, [{ start: times.start, rid: null, ends: [times.end] }]).full;
            const [start, end] = [parseWall(times.start) ?? Number.NaN, parseWall(times.end) ?? Number.NaN];
            const expectedSelection = [[5, 15], [6, 15], [6, 45]].map(([h, m]) => {
                const w = windowAt(2027, 11, 7, h ?? 0, m ?? 0);
                return start < w[1] && end > w[0];
            });
            const observed = g.selected.get(key) ?? [];
            const selectionOk = observed.length === 3 && observed.every((s, i) => s === expectedSelection[i]);
            Object.assign(g.evidence, { [`${key}StoredMatchesSent`]: storedOk, [`${key}ExpandedMatchesSent`]: expandedOk, [`${key}SelectionMatchesOverlap`]: selectionOk });
            allMatch &&= storedOk && expandedOk && selectionOk;
        }
        const distinct = g.expanded.get('first')?.events.length === 1 && g.expanded.get('second')?.events.length === 1;
        Object.assign(g.evidence, { coverageComplete: g.complete, bothStayDistinct: distinct });
        if (!g.complete) {
            return { outcome: 'inconclusive', summary: prose`A PUT was refused or a read, expand or time-range query was not answered completely.`, evidence: g.evidence };
        }
        return allMatch
            ? { outcome: 'confirmed', summary: prose`Both UTC events were stored, expanded and selected exactly as written.`, evidence: g.evidence }
            : { outcome: 'refuted', summary: prose`A stored value, an expanded instance or a window selection differs from what was written.`, evidence: g.evidence };
    },
};

export const DST_WRITE_CHECKS: CheckDef[] = [dstRepeatedHourCheck, dstSkippedHourCheck, dstUtcControlCheck];
