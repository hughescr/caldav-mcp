/**
 * Phase 3c and 3d probe checks (design §8.3 P3C-1 to P3C-4, §8.4 P3D-1 to P3D-3): splitting a
 * series (`this_and_future`, design §3.5) and moving a whole series (design §3.6), built from
 * the text of iCloud's own expansion and zone-free arithmetic on the probe's own values only.
 * The owner-observed checks (P3C-5, P3D-4, `--observe-client`) are not part of this version.
 */
import type { CheckContext, CheckDef, CheckOutput, Phase3Series } from '../context';
import { icalDate, icalLocal, icalUtc, prop, type IcalComponent } from '../ical';
import { fixed, prose } from '../safe';
import type { Evidence } from '../types';
import { SUMMARY, newEvent, primary } from './write-helpers';
import {
    NY, OVERRIDE_SUMMARY, PLAN_3C, PLAN_3D, calendarText, describeExpanded, expandAll, expanded, lineOf, shiftText, stampNow, startText, summaryOf, tryWrite, vevent,
} from './phase3-helpers';
import { createSeries, dtstarts, refreshEtags, rewrite, sameList, verdict, type FormSpec } from './write-3b';
import type { Expanded } from './write-expansion';
import { easternOffset, parseWall, wallToInstant } from './zones';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MOVED = `${OVERRIDE_SUMMARY} moved`;
const ORPHAN = `${OVERRIDE_SUMMARY} orphan`;
const SPLIT_WINDOW = [Date.UTC(2027, 1, 1), Date.UTC(2027, 3, 15)] as const;

/** Rewrites the named lines of a VEVENT (the first line whose name matches; `null` removes it). */
function editLines(lines: readonly string[], change: Record<string, string | null>): string[] {
    const out: string[] = [];
    for (const line of lines) {
        const name = /^[A-Z-]+/.exec(line)?.[0] ?? '';
        if (name in change) {
            const next = change[name];
            if (next !== null && next !== undefined) {
                out.push(next);
            }
            continue;
        }
        out.push(line);
    }
    return out;
}

/** A line with its value moved by a zone-free delta (§3.1: UTC instants, DATE and floating values only). */
function shifted(line: string, ms: number): string {
    const colon = line.lastIndexOf(':');
    return `${line.slice(0, colon)}:${shiftText(line.slice(colon + 1), ms)}`;
}

const formOf = (start: string): 'utc' | 'tzid' | 'date' | 'floating' => (/;VALUE=DATE[;:]/.test(start) ? 'date' : /;TZID=/.test(start) ? 'tzid' : start.endsWith('Z') ? 'utc' : 'floating');

/** §3.5: UNTIL = split token instant minus 1 s, as UTC for UTC and TZID masters, as floating digits or the date on the pseudo-UTC axis. */
export function untilFor(start: string, token: string | undefined): string | undefined {
    const at = parseWall(token);
    if (at === undefined || token?.endsWith('Z') !== true) {
        return undefined;
    }
    const form = formOf(start);
    return form === 'date' ? icalDate(at - 1000) : form === 'floating' ? icalLocal(at - 1000) : icalUtc(at - 1000);
}

/** The RRULE with COUNT and UNTIL removed and UNTIL=<u> appended, other parts kept in order. */
export function truncatedRule(rule: string, until: string): string {
    return [...rule.split(';').filter((part) => !/^(COUNT|UNTIL)=/i.test(part)), `UNTIL=${until}`].join(';');
}

/** Truncates each series before instance 4 (index 3) and reports, per series, whether exactly instances 1-3 remain. */
async function truncate(ctx: CheckContext, series: readonly Phase3Series[], specs: readonly FormSpec[], evidence: Evidence): Promise<{ held: number; readable: number; results: Map<string, Expanded> }> {
    const written: Phase3Series[] = [];
    for (const s of series) {
        const spec = specs.find((x) => x.key === s.key);
        const rule = /^RRULE:(.*)$/m.exec(s.master.join('\n'))?.[1];
        const until = spec === undefined ? undefined : untilFor(spec.start, s.slots[3] === undefined ? undefined : prop(s.slots[3], 'RECURRENCE-ID')?.value);
        if (rule === undefined || until === undefined) {
            evidence[`${s.key}UntilComputed`] = false;
            continue;
        }
        evidence[`${s.key}Until`] = fixed(`${formOf(spec?.start ?? '')}`);
        const master = editLines(s.master, { RRULE: `RRULE:${truncatedRule(rule, until)}`, SEQUENCE: 'SEQUENCE:1', DTSTAMP: `DTSTAMP:${stampNow(ctx)}` });
        if (await rewrite(ctx, s, evidence, `${s.key}Truncate`, master)) {
            written.push(s);
        }
    }
    const temp = primary(ctx);
    const got = written.length === 0 ? new Map<string, Expanded>() : await expandAll(ctx, temp, written.map((s) => s.url), SPLIT_WINDOW[0], SPLIT_WINDOW[1]);
    let held = 0;
    let readable = 0;
    for (const s of written) {
        const result = got.get(s.url);
        Object.assign(evidence, describeExpanded(`${s.key}Truncated`, result));
        if (!expanded(result)) {
            continue;
        }
        readable++;
        const ok = result.events.length === 3 && sameList(dtstarts(result.events), dtstarts(s.slots.slice(0, 3)));
        evidence[`${s.key}EndsAtInstance3`] = ok;
        held += ok ? 1 : 0;
    }
    return { held, readable, results: got };
}

const SPLIT_FORMS: readonly FormSpec[] = [
    { key: 'utc', suffix: 'p3c1utc', start: 'DTSTART:20270202T150000Z', end: 'DTEND:20270202T160000Z', rrule: 'FREQ=WEEKLY', expected: 11 },
    // Instance 4 (2027-03-16) is after the 2027-03-14 change: the UNTIL comes from a true UTC token.
    { key: 'tzid', suffix: 'p3c1tz', start: `DTSTART;TZID=${NY}:20270223T100000`, end: `DTEND;TZID=${NY}:20270223T110000`, rrule: 'FREQ=WEEKLY', expected: 8 },
    { key: 'date', suffix: 'p3c1date', start: 'DTSTART;VALUE=DATE:20270204', end: 'DTEND;VALUE=DATE:20270205', rrule: 'FREQ=WEEKLY', expected: 10 },
    { key: 'floating', suffix: 'p3c1flt', start: 'DTSTART:20270205T090000', end: 'DTEND:20270205T100000', rrule: 'FREQ=WEEKLY', expected: 10 },
];

export const splitUntilCheck: CheckDef = {
    id: 'write-split-until',
    planItem: `${PLAN_3C} (P3C-1): truncating a series with UNTIL`,
    claim: 'Truncating weekly UTC, TZID (across the 2027-03-14 change), DATE and floating series at instance 4 with UNTIL = instance 4’s token minus 1 s (design §3.5) leaves exactly instances 1 to 3 in each form.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const evidence: Evidence = {};
        const series = await createSeries(ctx, temp, SPLIT_FORMS, 0, SPLIT_WINDOW, evidence);
        const { held, readable, results } = await truncate(ctx, series, SPLIT_FORMS, evidence);
        const utc = series.find((s) => s.key === 'utc');
        const utcResult = utc === undefined ? undefined : results.get(utc.url);
        if (utcResult !== undefined && expanded(utcResult)) {
            ctx.state.phase3.splitUtcStarts = dtstarts(utcResult.events);
        }
        return verdict(series.length === 0 ? 0 : SPLIT_FORMS.length, held, readable, {
            confirmed: prose`All ${held} forms end exactly at instance 3.`,
            refuted: prose`${held} of ${SPLIT_FORMS.length} forms end exactly at instance 3 (recorded per form).`,
            inconclusive: prose`The series did not come back expanded in their master’s form before or after the truncation.`,
        }, evidence);
    },
};

export const splitCountToUntilCheck: CheckDef = {
    id: 'write-split-count-to-until',
    planItem: `${PLAN_3C} (P3C-2): COUNT replaced by UNTIL`,
    claim: 'A weekly UTC COUNT=8 series truncated at instance 4 by replacing COUNT with UNTIL keeps exactly instances 1 to 3, the same as P3C-1’s UTC series.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const spec: FormSpec = { key: 'count', suffix: 'p3c2count', start: 'DTSTART:20270202T150000Z', end: 'DTEND:20270202T160000Z', rrule: 'FREQ=WEEKLY;COUNT=8', expected: 8 };
        const evidence: Evidence = {};
        const series = await createSeries(ctx, temp, [spec], 0, SPLIT_WINDOW, evidence);
        const { held, readable, results } = await truncate(ctx, series, [spec], evidence);
        const result = series[0] === undefined ? undefined : results.get(series[0].url);
        const reference = ctx.state.phase3.splitUtcStarts;
        evidence.sameAsSplitUntilUtc = reference === undefined || !expanded(result) ? null : sameList(dtstarts(result.events), reference);
        return verdict(series.length === 0 ? 0 : 1, evidence.sameAsSplitUntilUtc === false ? 0 : held, readable, {
            confirmed: prose`COUNT replaced by UNTIL keeps exactly instances 1 to 3.`,
            refuted: prose`The truncated COUNT series does not hold exactly instances 1 to 3, or differs from P3C-1’s UTC series.`,
            inconclusive: prose`The COUNT series did not come back expanded before or after the truncation.`,
        }, evidence);
    },
};

export const splitNewSeriesCheck: CheckDef = {
    id: 'write-split-new-series',
    planItem: `${PLAN_3C} (P3C-3): the new-UID resource of a split`,
    claim: 'Splitting a weekly UTC series (with an EXDATE and a moved override after the split point) at instance 4 into a new-UID resource (EXDATE copied, override with its UID replaced; If-None-Match) and a truncated original (If-Match) shows the EXDATE and the override applied, and each slot once across both.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const evidence: Evidence = {};
        const spec: FormSpec = { key: 'old', suffix: 'p3c3old', start: 'DTSTART:20270203T160000Z', end: 'DTEND:20270203T170000Z', rrule: 'FREQ=WEEKLY', extra: ['EXDATE:20270310T160000Z'], expected: 10 };
        const [series] = await createSeries(ctx, temp, [spec], 0, SPLIT_WINDOW, evidence, (_spec, uid) => [vevent(uid, stampNow(ctx), [
            'RECURRENCE-ID:20270303T160000Z', 'DTSTART:20270304T160000Z', 'DTEND:20270304T170000Z', `SUMMARY:${MOVED}`, 'SEQUENCE:1',
        ])]);
        const slot = series?.slots[3];
        const start = slot === undefined ? undefined : startText(slot);
        const endProp = slot === undefined ? undefined : prop(slot, 'DTEND');
        const until = untilFor(spec.start, slot === undefined ? undefined : prop(slot, 'RECURRENCE-ID')?.value);
        if (series === undefined || start === undefined || endProp === undefined || until === undefined) {
            return { outcome: 'inconclusive', summary: prose`The original series did not come back expanded as written, so it was not split.`, evidence };
        }
        const fresh = newEvent(temp, 'p3c3new');
        const stamp = stampNow(ctx);
        const newMaster = editLines(series.master, { UID: `UID:${fresh.uid}`, DTSTAMP: `DTSTAMP:${stamp}`, DTSTART: start, DTEND: lineOf(endProp), SEQUENCE: 'SEQUENCE:0' });
        const moved = (series.overrides[0] ?? []).map((line) => (line.startsWith('UID:') ? `UID:${fresh.uid}` : line));
        const created = await tryWrite(ctx, fresh.url, calendarText([newMaster, moved]), evidence, 'newSeries');
        if (created === undefined) {
            return { outcome: 'refuted', summary: prose`The new series of the split was not accepted.`, evidence };
        }
        series.overrides = [];
        const truncatedMaster = editLines(series.master, { RRULE: `RRULE:${truncatedRule('FREQ=WEEKLY', until)}`, SEQUENCE: 'SEQUENCE:1', DTSTAMP: `DTSTAMP:${stamp}` });
        if (!(await rewrite(ctx, series, evidence, 'truncate', truncatedMaster))) {
            return { outcome: 'inconclusive', summary: prose`The new series was created but the original was not truncated (both are recorded).`, evidence };
        }
        const got = await expandAll(ctx, temp, [series.url, fresh.url], SPLIT_WINDOW[0], SPLIT_WINDOW[1]);
        const [old, next] = [got.get(series.url), got.get(fresh.url)];
        Object.assign(evidence, describeExpanded('oldAfter', old), describeExpanded('newAfter', next));
        if (!expanded(old) || !expanded(next)) {
            return { outcome: 'inconclusive', summary: prose`The two series were not both read back expanded.`, evidence };
        }
        const rids = (events: readonly IcalComponent[]): string[] => events.map((e) => prop(e, 'RECURRENCE-ID')?.value ?? '-').toSorted();
        const movedInstance = next.events.find((e) => summaryOf(e) === MOVED);
        const flags = {
            oldEndsAtInstance3: sameList(dtstarts(old.events), dtstarts(series.slots.slice(0, 3))),
            newAppliesExdate: !next.events.some((e) => prop(e, 'RECURRENCE-ID')?.value === '20270310T160000Z' || startText(e) === 'DTSTART:20270310T160000Z'),
            newAppliesOverride: movedInstance !== undefined && startText(movedInstance) === 'DTSTART:20270304T160000Z',
            eachSlotOnce: sameList(rids([...old.events, ...next.events]), rids(series.slots)),
        };
        Object.assign(evidence, flags);
        return Object.values(flags).every(Boolean)
            ? { outcome: 'confirmed', summary: prose`The split shows the EXDATE and the override applied, and each slot once.`, evidence }
            : { outcome: 'refuted', summary: prose`The split series differ from the claim (each part is recorded).`, evidence };
    },
};

export const orphanOverrideCheck: CheckDef = {
    id: 'write-orphan-override',
    planItem: `${PLAN_3C} (P3C-4): overrides whose RECURRENCE-ID matches no instance (justifies "no keep")`,
    claim: 'iCloud does not show an override whose RECURRENCE-ID matches no instance of its series (one beyond UNTIL, one three hours off a slot): it refuses the PUT or hides the override.',
    needs: 'temp',
    async run(ctx): Promise<CheckOutput> {
        const temp = primary(ctx);
        const evidence: Evidence = {};
        const cases = [
            { key: 'beyondUntil', suffix: 'p3c4until', master: ['DTSTART:20270204T170000Z', 'DTEND:20270204T180000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20270225T170000Z'], rid: '20270311T170000Z' },
            { key: 'offSlot', suffix: 'p3c4offslot', master: ['DTSTART:20270205T170000Z', 'DTEND:20270205T180000Z', 'RRULE:FREQ=WEEKLY;COUNT=4'], rid: '20270212T200000Z' },
        ];
        const accepted = new Map<string, string>();
        for (const c of cases) {
            const { url, uid } = newEvent(temp, c.suffix);
            const stamp = stampNow(ctx);
            const body = calendarText([
                vevent(uid, stamp, [...c.master, `SUMMARY:${SUMMARY}`, 'SEQUENCE:0']),
                vevent(uid, stamp, [`RECURRENCE-ID:${c.rid}`, `DTSTART:${c.rid}`, `DTEND:${icalUtc((parseWall(c.rid) ?? 0) + HOUR)}`, `SUMMARY:${ORPHAN}`, 'SEQUENCE:1']),
            ]);
            if ((await tryWrite(ctx, url, body, evidence, c.key)) === undefined) {
                evidence[`${c.key}Disposition`] = fixed(Number(evidence[`${c.key}PutStatus`]) >= 400 && Number(evidence[`${c.key}PutStatus`]) < 500 ? 'refused' : 'unread');
            } else {
                accepted.set(c.key, url);
            }
        }
        const got = accepted.size === 0 ? new Map<string, Expanded>() : await expandAll(ctx, temp, [...accepted.values()], SPLIT_WINDOW[0], SPLIT_WINDOW[1]);
        for (const [key, url] of accepted) {
            const result = got.get(url);
            Object.assign(evidence, describeExpanded(key, result));
            const readable = result?.status === 207 && result.returned && result.events.every((e) => prop(e, 'RRULE') === undefined);
            evidence[`${key}RegularInstances`] = result?.events.filter((e) => summaryOf(e) !== ORPHAN).length ?? 0;
            evidence[`${key}Disposition`] = fixed(!readable ? 'unread' : result.events.some((e) => summaryOf(e) === ORPHAN) ? 'shown' : 'hidden');
        }
        const dispositions = cases.map((c) => String(evidence[`${c.key}Disposition`]));
        if (dispositions.every((d) => d === 'refused' || d === 'hidden')) {
            return { outcome: 'confirmed', summary: prose`Neither orphan override is shown (each was refused or hidden).`, evidence };
        }
        if (dispositions.includes('shown')) {
            return { outcome: 'refuted', summary: prose`An orphan override is shown as an extra instance.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The orphan cases could not be read back expanded.`, evidence };
    },
};

// ---- 3d -------------------------------------------------------------------------------------

/** One series written, read, rewritten with `edit`, and read again; `judge` decides on the second expansion. */
async function moveSeries(ctx: CheckContext, specs: readonly FormSpec[], window: readonly [number, number], evidence: Evidence, overridesOf: (spec: FormSpec, uid: string) => string[][], edit: (s: Phase3Series, spec: FormSpec) => { master: string[]; overrides: string[][] }, judge: (s: Phase3Series, spec: FormSpec, after: Expanded) => boolean): Promise<CheckOutput> {
    const temp = primary(ctx);
    const series = await createSeries(ctx, temp, specs, 0, window, evidence, overridesOf);
    const written: Phase3Series[] = [];
    for (const s of series) {
        const spec = specs.find((x) => x.key === s.key) as FormSpec;
        const next = edit(s, spec);
        s.overrides = next.overrides;
        if (await rewrite(ctx, s, evidence, `${s.key}Move`, next.master)) {
            s.master = next.master;
            written.push(s);
        }
    }
    const got = written.length === 0 ? new Map<string, Expanded>() : await expandAll(ctx, temp, written.map((s) => s.url), window[0], window[1]);
    refreshEtags(written, got);
    let held = 0;
    let readable = 0;
    for (const s of written) {
        const result = got.get(s.url);
        Object.assign(evidence, describeExpanded(`${s.key}Moved`, result));
        if (!expanded(result)) {
            continue;
        }
        readable++;
        const ok = judge(s, specs.find((x) => x.key === s.key) as FormSpec, result);
        evidence[`${s.key}AsClaimed`] = ok;
        held += ok ? 1 : 0;
    }
    return verdict(series.length === 0 ? 0 : specs.length, held, readable, {
        confirmed: prose`Every moved series came back as claimed.`,
        refuted: prose`${held} of ${specs.length} moved series came back as claimed (recorded per series).`,
        inconclusive: prose`The series did not come back expanded in their master’s form before or after the move.`,
    }, evidence);
}

const nyLine = (name: string, wall: number): string => `${name};TZID=${NY}:${icalLocal(wall)}`;

export const seriesMovePlainCheck: CheckDef = {
    id: 'write-series-move-plain',
    planItem: `${PLAN_3D} (P3D-1): moving a plain TZID series`,
    claim: 'Moving a weekly America/New_York series (COUNT=4, across the 2027-03-14 change, no exceptions) one hour later and to the next day leaves 4 instances, all at the new local time, with none left at the old one.',
    needs: 'temp',
    async run(ctx) {
        const first = Date.UTC(2027, 2, 2, 10);
        const spec: FormSpec = { key: 'tzid', suffix: 'p3d1tz', start: nyLine('DTSTART', first), end: nyLine('DTEND', first + HOUR), rrule: 'FREQ=WEEKLY;COUNT=4', expected: 4 };
        const moved = first + DAY + HOUR;
        const expected = [0, 1, 2, 3].map((k) => nyLine('DTSTART', moved + 7 * k * DAY)).toSorted();
        const tokens = [0, 1, 2, 3].map((k) => icalUtc(wallToInstant(moved + 7 * k * DAY, easternOffset(moved + 7 * k * DAY)))).toSorted();
        const evidence: Evidence = {};
        return moveSeries(ctx, [spec], [Date.UTC(2027, 1, 25), Date.UTC(2027, 3, 5)], evidence, () => [], (s) => ({
            master: editLines(s.master, { DTSTART: nyLine('DTSTART', moved), DTEND: nyLine('DTEND', moved + HOUR), SEQUENCE: 'SEQUENCE:1', DTSTAMP: `DTSTAMP:${stampNow(ctx)}` }),
            overrides: [],
        }), (_s, _spec, after) => {
            evidence.ridTokensMatchNewInstants = sameList(after.events.map((e) => prop(e, 'RECURRENCE-ID')?.value ?? '-').toSorted(), tokens);
            return after.events.length === 4 && sameList(dtstarts(after.events), expected);
        });
    },
};

export const seriesMoveShiftCheck: CheckDef = {
    id: 'write-series-move-shift',
    planItem: `${PLAN_3D} (P3D-2): moving a series with exceptions "shift"`,
    claim: 'Moving a weekly UTC series by 25 hours and a weekly DATE series by one day, each with an EXDATE, an unmoved override and a moved override, shifted per design §3.6, keeps the exclusion and both overrides on the right instances, and the moved override keeps its own time.',
    needs: 'temp',
    async run(ctx) {
        const specs: FormSpec[] = [
            { key: 'utc', suffix: 'p3d2utc', start: 'DTSTART:20270208T150000Z', end: 'DTEND:20270208T160000Z', rrule: 'FREQ=WEEKLY;COUNT=6', extra: ['EXDATE:20270308T150000Z'], expected: 5 },
            { key: 'date', suffix: 'p3d2date', start: 'DTSTART;VALUE=DATE:20270210', end: 'DTEND;VALUE=DATE:20270211', rrule: 'FREQ=WEEKLY;COUNT=6', extra: ['EXDATE;VALUE=DATE:20270310'], expected: 5 },
        ];
        const overrides: Record<string, string[][]> = {
            utc: [
                ['RECURRENCE-ID:20270215T150000Z', 'DTSTART:20270215T150000Z', 'DTEND:20270215T160000Z', `SUMMARY:${OVERRIDE_SUMMARY}`],
                ['RECURRENCE-ID:20270222T150000Z', 'DTSTART:20270223T150000Z', 'DTEND:20270223T160000Z', `SUMMARY:${MOVED}`],
            ],
            date: [
                ['RECURRENCE-ID;VALUE=DATE:20270217', 'DTSTART;VALUE=DATE:20270217', 'DTEND;VALUE=DATE:20270218', `SUMMARY:${OVERRIDE_SUMMARY}`],
                ['RECURRENCE-ID;VALUE=DATE:20270224', 'DTSTART;VALUE=DATE:20270226', 'DTEND;VALUE=DATE:20270227', `SUMMARY:${MOVED}`],
            ],
        };
        const delta: Record<string, number> = { utc: DAY + HOUR, date: DAY };
        const evidence: Evidence = {};
        const valueOf = (line: string | undefined): string => line?.slice(line.lastIndexOf(':') + 1) ?? '';
        return moveSeries(ctx, specs, [Date.UTC(2027, 1, 5), Date.UTC(2027, 2, 25)], evidence,
            (spec, uid) => (overrides[spec.key] ?? []).map((lines) => vevent(uid, stampNow(ctx), [...lines, 'SEQUENCE:1'])),
            (s, spec) => {
                const d = delta[spec.key] ?? 0;
                const master = editLines(s.master, { DTSTART: shifted(spec.start, d), DTEND: shifted(spec.end, d), EXDATE: shifted(spec.extra?.[0] ?? '', d), SEQUENCE: 'SEQUENCE:1', DTSTAMP: `DTSTAMP:${stampNow(ctx)}` });
                // §3.6 "shift": every RECURRENCE-ID moves; DTSTART/DTEND move only on an override whose DTSTART text equals its RECURRENCE-ID text.
                const next = s.overrides.map((o) => {
                    const rid = o.find((l) => l.startsWith('RECURRENCE-ID'));
                    const unmoved = valueOf(rid) === valueOf(o.find((l) => l.startsWith('DTSTART')));
                    return o.map((l) => (l.startsWith('RECURRENCE-ID') || (unmoved && (l.startsWith('DTSTART') || l.startsWith('DTEND'))) ? shifted(l, d) : l.startsWith('SEQUENCE:') ? 'SEQUENCE:2' : l));
                });
                return { master, overrides: next };
            },
            (s, spec, after) => {
                const d = delta[spec.key] ?? 0;
                const [unmoved, moved] = overrides[spec.key] ?? [];
                const slots = [0, 1, 2, 3, 5].map((k) => shifted(spec.start, d + 7 * k * DAY));
                const expected = [slots[0], shifted(unmoved?.[1] ?? '', d), moved?.[1], slots[3], slots[4]].map(String).toSorted();
                const overrideAt = after.events.find((e) => summaryOf(e) === OVERRIDE_SUMMARY);
                const movedAt = after.events.find((e) => summaryOf(e) === MOVED);
                Object.assign(evidence, {
                    [`${s.key}UnmovedOverrideShifted`]: overrideAt !== undefined && startText(overrideAt) === shifted(unmoved?.[1] ?? '', d),
                    [`${s.key}MovedOverrideKeptTime`]: movedAt !== undefined && startText(movedAt) === moved?.[1],
                    [`${s.key}ExclusionKept`]: !after.events.some((e) => startText(e) === shifted(spec.start, d + 28 * DAY)),
                });
                return after.events.length === 5 && sameList(dtstarts(after.events), expected);
            });
    },
};

export const seriesMoveDropCheck: CheckDef = {
    id: 'write-series-move-drop',
    planItem: `${PLAN_3D} (P3D-3): moving a series with exceptions "drop"`,
    claim: 'Moving a weekly America/New_York series (COUNT=5) with an override and an EXDATE one hour later, dropping both exceptions, leaves the plain series of 5 instances at the new time, with no orphan.',
    needs: 'temp',
    async run(ctx) {
        const first = Date.UTC(2027, 3, 6, 10);
        const spec: FormSpec = {
            key: 'tzid', suffix: 'p3d3tz', start: nyLine('DTSTART', first), end: nyLine('DTEND', first + HOUR), rrule: 'FREQ=WEEKLY;COUNT=5', extra: [nyLine('EXDATE', first + 21 * DAY)], expected: 4,
        };
        const expected = [0, 1, 2, 3, 4].map((k) => nyLine('DTSTART', first + HOUR + 7 * k * DAY)).toSorted();
        const evidence: Evidence = {};
        return moveSeries(ctx, [spec], [Date.UTC(2027, 3, 1), Date.UTC(2027, 4, 15)], evidence,
            (_spec, uid) => [vevent(uid, stampNow(ctx), [nyLine('RECURRENCE-ID', first + 7 * DAY), nyLine('DTSTART', first + 7 * DAY), nyLine('DTEND', first + 7 * DAY + HOUR), `SUMMARY:${OVERRIDE_SUMMARY}`, 'SEQUENCE:1'])],
            (s) => ({
                master: editLines(s.master, { DTSTART: nyLine('DTSTART', first + HOUR), DTEND: nyLine('DTEND', first + 2 * HOUR), EXDATE: null, SEQUENCE: 'SEQUENCE:1', DTSTAMP: `DTSTAMP:${stampNow(ctx)}` }),
                overrides: [],
            }),
            (_s, _spec, after) => {
                evidence.noOrphan = !after.events.some((e) => summaryOf(e).startsWith(OVERRIDE_SUMMARY));
                return after.events.length === 5 && evidence.noOrphan && sameList(dtstarts(after.events), expected);
            });
    },
};

export const WRITE_3C_CHECKS: CheckDef[] = [splitUntilCheck, splitCountToUntilCheck, splitNewSeriesCheck, orphanOverrideCheck];
export const WRITE_3D_CHECKS: CheckDef[] = [seriesMovePlainCheck, seriesMoveShiftCheck, seriesMoveDropCheck];
