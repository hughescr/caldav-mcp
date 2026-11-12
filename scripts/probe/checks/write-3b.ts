/**
 * Phase 3b probe checks (design §8.2, P3B-1 to P3B-6): occurrence edits (`edit_scope: "this"`)
 * built exactly as design §3.3 and §3.4 build them, from the text of iCloud's own expansion.
 * P3B-1, P3B-2 and P3B-3 edit the same four series in turn (TZID, UTC, DATE and floating
 * masters); P3B-4 to P3B-6 write their own. Everything is the probe's own data.
 */
import { isRefusal, type CheckContext, type CheckDef, type CheckOutput, type Phase3Series, type TempCalendar } from '../context';
import { icalDate, icalLocal, icalUtc, prop, type IcalComponent } from '../ical';
import { kindOf } from '../ical-time';
import { fixed, prose, safeNames } from '../safe';
import type { Evidence } from '../types';
import { SUMMARY, newEvent, primary } from './write-helpers';
import {
    NY, OVERRIDE_SUMMARY, PLAN_3B, byRid, calendarText, describeExpanded, expandAll, expanded, formMatches, lineOf, overrideVevent, readRaw, shiftLine,
    stampNow, startText, summaryOf, tryWrite, vevent, veventBlocks,
} from './phase3-helpers';
import type { Expanded } from './write-expansion';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MOVED = `${OVERRIDE_SUMMARY} moved`;
const AGAIN = `${OVERRIDE_SUMMARY} again`;

/** One series: its DTSTART/DTEND lines, and optionally its own RRULE and how many instances its window must hold. */
export interface FormSpec { key: string; suffix: string; start: string; end: string; rrule?: string; extra?: readonly string[]; expected?: number }

/** Six weekly instances per form, in April and May 2027 (no clock change in New York). */
function forms(prefix: string, first: number): FormSpec[] {
    const at = (day: number, hour: number): number => first + day * DAY + hour * HOUR;
    return [
        { key: 'tzid', suffix: `${prefix}tz`, start: `DTSTART;TZID=${NY}:${icalLocal(at(0, 10))}`, end: `DTEND;TZID=${NY}:${icalLocal(at(0, 11))}` },
        { key: 'utc', suffix: `${prefix}utc`, start: `DTSTART:${icalUtc(at(1, 15))}`, end: `DTEND:${icalUtc(at(1, 16))}` },
        { key: 'date', suffix: `${prefix}date`, start: `DTSTART;VALUE=DATE:${icalDate(at(2, 0))}`, end: `DTEND;VALUE=DATE:${icalDate(at(3, 0))}` },
        { key: 'floating', suffix: `${prefix}flt`, start: `DTSTART:${icalLocal(at(3, 9))}`, end: `DTEND:${icalLocal(at(3, 10))}` },
    ];
}

const WINDOW_3B = [Date.UTC(2027, 3, 1), Date.UTC(2027, 5, 1)] as const;
const FORM_COUNT = 4;

function masterOf(ctx: CheckContext, uid: string, spec: FormSpec, count: number): string[] {
    return vevent(uid, stampNow(ctx), [spec.start, spec.end, `RRULE:${spec.rrule ?? `FREQ=WEEKLY;COUNT=${count}`}`, `SUMMARY:${SUMMARY}`, 'SEQUENCE:0', ...(spec.extra ?? [])]);
}

/** PUTs each series, then one expanded REPORT; returns the series whose expansion gave exactly `count` (or the spec's `expected`) instances in the master's form. */
export async function createSeries(ctx: CheckContext, temp: TempCalendar, specs: readonly FormSpec[], count: number, window: readonly [number, number], evidence: Evidence, overridesOf: (spec: FormSpec, uid: string) => string[][] = () => []): Promise<Phase3Series[]> {
    const created: Phase3Series[] = [];
    for (const spec of specs) {
        const { url, uid } = newEvent(temp, spec.suffix);
        const master = masterOf(ctx, uid, spec, count);
        const overrides = overridesOf(spec, uid);
        const put = await tryWrite(ctx, url, calendarText([master, ...overrides]), evidence, spec.key);
        if (put !== undefined) {
            created.push({ key: spec.key, url, uid, etag: put.etag, master, slots: [], overrides });
        }
    }
    if (created.length === 0) {
        return [];
    }
    const got = await expandAll(ctx, temp, created.map((s) => s.url), window[0], window[1]);
    const usable: Phase3Series[] = [];
    for (const series of created) {
        const result = got.get(series.url);
        Object.assign(evidence, describeExpanded(`${series.key}Before`, result));
        const spec = specs.find((s) => s.key === series.key);
        const masterForm = result !== undefined && expanded(result) && spec !== undefined && result.events.every((e) => summaryOf(e).startsWith(OVERRIDE_SUMMARY) || formMatches(spec.start, e));
        evidence[`${series.key}SlotsInMasterForm`] = masterForm;
        if (masterForm && result.events.length === (spec.expected ?? count)) {
            series.slots = byRid(result.events);
            series.etag = result.etag ?? series.etag;
            usable.push(series);
        }
    }
    return usable;
}

/** PUT of the master byte for byte plus the current overrides, with If-Match; the new ETag is kept. */
export async function rewrite(ctx: CheckContext, series: Phase3Series, evidence: Evidence, key: string, master = series.master): Promise<boolean> {
    const put = await tryWrite(ctx, series.url, calendarText([master, ...series.overrides]), evidence, key, series.etag);
    if (put !== undefined) {
        series.etag = put.etag;
    } else if (isRefusal(Number(evidence[`${key}PutStatus`]))) {
        // A refused edit answers the claim (no): the verdicts count it as a readable failure.
        evidence.editsRefused = Number(evidence.editsRefused ?? 0) + 1;
    }
    return put !== undefined;
}

/** After an edit: the ETag for the next If-Match comes from the expanded REPORT (ETags are equal across forms [M]). */
export function refreshEtags(series: readonly Phase3Series[], got: Map<string, Expanded>): void {
    for (const s of series) {
        s.etag = got.get(s.url)?.etag ?? s.etag;
    }
}

export const dtstarts = (events: readonly IcalComponent[]): string[] => events.map((e) => startText(e) ?? '-').toSorted();
export const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Verdict over the forms that were tried: confirmed when every one held, refuted when one readable form failed. */
export function verdict(tried: number, held: number, readable: number, what: { confirmed: CheckOutput['summary']; refuted: CheckOutput['summary']; inconclusive: CheckOutput['summary'] }, evidence: Evidence): CheckOutput {
    Object.assign(evidence, { formsTried: tried, formsReadable: readable, formsAsClaimed: held });
    if (tried > 0 && held === tried) {
        return { outcome: 'confirmed', summary: what.confirmed, evidence };
    }
    if (readable + Number(evidence.editsRefused ?? 0) > held) {
        return { outcome: 'refuted', summary: what.refuted, evidence };
    }
    return { outcome: 'inconclusive', summary: what.inconclusive, evidence };
}

export const overrideNewFormsCheck: CheckDef = {
    id: 'write-override-new-forms',
    planItem: `${PLAN_3B} (P3B-1): a new override in each master form`,
    claim: 'For weekly TZID, UTC, DATE and floating series of 6 instances, adding an override for instance 3 (RECURRENCE-ID built from the expanded instance, a title change) leaves exactly 6 instances with instance 3 replaced, and the stored RECURRENCE-ID text is kept verbatim.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const evidence: Evidence = {};
        const series = await createSeries(ctx, temp, forms('p3b1', Date.UTC(2027, 3, 6)), 6, WINDOW_3B, evidence);
        ctx.state.phase3.overrideSeries = [];
        if (series.length === 0) {
            return verdict(0, 0, 0, { confirmed: prose``, refuted: prose``, inconclusive: prose`No series came back expanded in its master’s form with 6 instances, so no override was written.` }, evidence);
        }
        const sent = new Map<string, string>();
        for (const s of series) {
            const slot = s.slots[2];
            if (slot === undefined) {
                continue;
            }
            const override = overrideVevent(s.uid, stampNow(ctx), s.master, slot, { summary: OVERRIDE_SUMMARY }, 1);
            s.overrides = [override];
            sent.set(s.key, override[3] ?? '');
            if (!(await rewrite(ctx, s, evidence, `${s.key}Override`))) {
                s.overrides = [];
            }
        }
        const written = series.filter((s) => s.overrides.length > 0);
        for (const s of written) {
            const stored = await readRaw(ctx, temp, s.url, s.uid);
            const override = stored.events.find((e) => prop(e, 'RECURRENCE-ID') !== undefined);
            const rid = override === undefined ? undefined : prop(override, 'RECURRENCE-ID');
            evidence[`${s.key}StoredRidVerbatim`] = rid !== undefined && lineOf(rid) === sent.get(s.key);
            evidence[`${s.key}StoredRidKind`] = fixed(kindOf(rid));
            s.storedMaster = veventBlocks(stored.body).master;
        }
        const got = written.length === 0 ? new Map<string, Expanded>() : await expandAll(ctx, temp, written.map((s) => s.url), WINDOW_3B[0], WINDOW_3B[1]);
        refreshEtags(written, got);
        let held = 0;
        let readable = 0;
        for (const s of written) {
            const result = got.get(s.url);
            Object.assign(evidence, describeExpanded(`${s.key}After`, result));
            if (!expanded(result)) {
                continue;
            }
            readable++;
            const replaced = result.events.filter((e) => summaryOf(e) === OVERRIDE_SUMMARY);
            const exact = result.events.length === 6 && replaced.length === 1 && startText(replaced[0] as IcalComponent) === startText(s.slots[2] as IcalComponent)
                && sameList(dtstarts(result.events), dtstarts(s.slots));
            evidence[`${s.key}Replaced`] = exact;
            held += exact && evidence[`${s.key}StoredRidVerbatim`] === true ? 1 : 0;
        }
        ctx.state.phase3.overrideSeries = written;
        return verdict(FORM_COUNT, held, readable, {
            confirmed: prose`In all ${held} forms instance 3 was replaced exactly and its RECURRENCE-ID stored verbatim.`,
            refuted: prose`${held} of ${FORM_COUNT} forms held; the others duplicated, lost or rewrote an instance (recorded per form).`,
            inconclusive: prose`The edited series could not be read back expanded.`,
        }, evidence);
    },
};

export const overrideExpandedShapeCheck: CheckDef = {
    id: 'write-override-expanded-shape',
    planItem: `${PLAN_3B} (P3B-2): how expansion renders an overridden instance (decides design §3.2 step 5)`,
    claim: 'After a moved override (instance 4 moved two days) joins the P3B-1 override, expansion renders each overridden instance’s RECURRENCE-ID as the same …Z token an unmoved instance had (outcome b), and returns the override’s DTSTART and DTEND text verbatim.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const series = ctx.state.phase3.overrideSeries ?? [];
        const evidence: Evidence = { seriesFromP3b1: series.length };
        if (series.length === 0) {
            return { outcome: 'inconclusive', summary: prose`P3B-1 left no series to edit.`, evidence };
        }
        const moved = new Map<string, string[]>();
        for (const s of series) {
            const slot = s.slots[3];
            const start = slot === undefined ? undefined : prop(slot, 'DTSTART');
            const end = slot === undefined ? undefined : prop(slot, 'DTEND');
            if (slot === undefined || start === undefined || end === undefined) {
                continue;
            }
            const override = overrideVevent(s.uid, stampNow(ctx), s.master, slot, { summary: MOVED, start: shiftLine(start, 2 * DAY), end: shiftLine(end, 2 * DAY) }, 1);
            const before = s.overrides;
            s.overrides = [...before, override];
            if (await rewrite(ctx, s, evidence, `${s.key}Moved`)) {
                moved.set(s.key, override);
            } else {
                s.overrides = before;
            }
        }
        const written = series.filter((s) => moved.has(s.key));
        const got = written.length === 0 ? new Map<string, Expanded>() : await expandAll(ctx, temp, written.map((s) => s.url), WINDOW_3B[0], WINDOW_3B[1]);
        refreshEtags(written, got);
        const classes = new Map<string, 'b-utc-token' | 'a-stored-text' | 'other'>();
        let verbatimForms = 0;
        let readable = 0;
        for (const s of written) {
            const result = got.get(s.url);
            Object.assign(evidence, describeExpanded(`${s.key}Moved`, result));
            if (!expanded(result)) {
                continue;
            }
            readable++;
            const overridden = result.events.filter((e) => summaryOf(e).startsWith(OVERRIDE_SUMMARY));
            const plain = result.events.filter((e) => !summaryOf(e).startsWith(OVERRIDE_SUMMARY));
            const pairs = [[OVERRIDE_SUMMARY, s.slots[2], s.overrides[0]], [MOVED, s.slots[3], moved.get(s.key)]] as const;
            let tokens = 0;
            let storedText = 0;
            let verbatim = 0;
            for (const [summary, slot, sent] of pairs) {
                const instance = overridden.find((e) => summaryOf(e) === summary);
                const rid = instance === undefined ? undefined : prop(instance, 'RECURRENCE-ID');
                const slotRid = slot === undefined ? undefined : prop(slot, 'RECURRENCE-ID')?.value;
                tokens += rid !== undefined && rid.value === slotRid && kindOf(rid) === 'utc' ? 1 : 0;
                storedText += rid !== undefined && lineOf(rid) === sent?.[3] ? 1 : 0;
                const end = instance === undefined ? undefined : prop(instance, 'DTEND');
                verbatim += instance !== undefined && startText(instance) === sent?.[4] && end !== undefined && lineOf(end) === sent?.[5] ? 1 : 0;
            }
            const cls = tokens === 2 ? 'b-utc-token' : storedText === 2 ? 'a-stored-text' : 'other';
            classes.set(s.key, cls);
            verbatimForms += verbatim === 2 ? 1 : 0;
            const plainNames = new Set(plain.flatMap((e) => e.properties.map((p) => p.name)));
            Object.assign(evidence, {
                [`${s.key}OverriddenRidClass`]: fixed(cls),
                [`${s.key}OverriddenRidKinds`]: Object.fromEntries(overridden.map((e) => [kindOf(prop(e, 'RECURRENCE-ID')), overridden.filter((o) => kindOf(prop(o, 'RECURRENCE-ID')) === kindOf(prop(e, 'RECURRENCE-ID'))).length])),
                [`${s.key}OverrideTimesVerbatim`]: verbatim === 2,
                [`${s.key}NamesOnlyOnOverridden`]: safeNames(overridden.flatMap((e) => e.properties.map((p) => p.name)).filter((n) => !plainNames.has(n)), ctx.taint),
            });
        }
        const tzid = classes.get('tzid');
        ctx.state.phase3.overrideRid = tzid ?? 'other';
        evidence.tzidSeriesOutcome = fixed(tzid ?? 'other');
        const allB = written.length > 0 && readable === written.length && [...classes.values()].every((c) => c === 'b-utc-token');
        if (allB && written.length === FORM_COUNT && verbatimForms === written.length) {
            return { outcome: 'confirmed', summary: prose`Outcome (b) in all ${readable} forms: overridden instances keep the …Z token, and their times are verbatim.`, evidence };
        }
        if (tzid === 'a-stored-text' || Number(evidence.editsRefused ?? 0) > 0 || (readable > 0 && verbatimForms < readable && [...classes.values()].every((c) => c === 'b-utc-token'))) {
            return { outcome: 'refuted', summary: prose`Outcome (a) for the TZID series, or override times not verbatim (recorded per form).`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The overridden instances matched neither outcome in every form, or were not read back.`, evidence };
    },
};

export const overrideReeditCheck: CheckDef = {
    id: 'write-override-reedit',
    planItem: `${PLAN_3B} (P3B-3): editing an already moved override again`,
    claim: 'A span edit of the moved override alone (new times and title, its RECURRENCE-ID line kept) leaves one instance for that slot at the new values, 6 instances in all, and the stored master byte-identical.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const series = (ctx.state.phase3.overrideSeries ?? []).filter((s) => s.overrides.length === 2);
        const evidence: Evidence = { seriesFromP3b2: series.length };
        if (series.length === 0) {
            return { outcome: 'inconclusive', summary: prose`P3B-2 left no moved override to edit.`, evidence };
        }
        const edited = new Map<string, string>();
        for (const s of series) {
            const slot = s.slots[3];
            const start = slot === undefined ? undefined : prop(slot, 'DTSTART');
            const end = slot === undefined ? undefined : prop(slot, 'DTEND');
            const old = s.overrides[1];
            if (start === undefined || end === undefined || old === undefined) {
                continue;
            }
            const newStart = shiftLine(start, 3 * DAY);
            // Span edit: only DTSTART, DTEND, SUMMARY, DTSTAMP and SEQUENCE of that VEVENT change.
            const again = old.map((line) => (line.startsWith('DTSTART') ? newStart : line.startsWith('DTEND') ? shiftLine(end, 3 * DAY) : line.startsWith('SUMMARY:') ? `SUMMARY:${AGAIN}` : line.startsWith('DTSTAMP:') ? `DTSTAMP:${stampNow(ctx)}` : line.startsWith('SEQUENCE:') ? 'SEQUENCE:2' : line));
            s.overrides = [s.overrides[0] ?? [], again];
            if (await rewrite(ctx, s, evidence, `${s.key}Reedit`)) {
                edited.set(s.key, newStart);
            }
        }
        const written = series.filter((s) => edited.has(s.key));
        for (const s of written) {
            const stored = await readRaw(ctx, temp, s.url, s.uid);
            const master = veventBlocks(stored.body).master;
            evidence[`${s.key}MasterUnchanged`] = master !== undefined && s.storedMaster !== undefined && sameList(master, s.storedMaster);
            evidence[`${s.key}StoredOverrides`] = stored.events.filter((e) => prop(e, 'RECURRENCE-ID') !== undefined).length;
        }
        const got = written.length === 0 ? new Map<string, Expanded>() : await expandAll(ctx, temp, written.map((s) => s.url), WINDOW_3B[0], WINDOW_3B[1]);
        let held = 0;
        let readable = 0;
        for (const s of written) {
            const result = got.get(s.url);
            Object.assign(evidence, describeExpanded(`${s.key}Reedit`, result));
            if (!expanded(result)) {
                continue;
            }
            readable++;
            const again = result.events.filter((e) => summaryOf(e) === AGAIN);
            const ok = result.events.length === 6 && again.length === 1 && startText(again[0] as IcalComponent) === edited.get(s.key)
                && !result.events.some((e) => summaryOf(e) === MOVED) && evidence[`${s.key}MasterUnchanged`] === true;
            evidence[`${s.key}OneInstanceAtNewValues`] = ok;
            held += ok ? 1 : 0;
        }
        return verdict(FORM_COUNT, held, readable, {
            confirmed: prose`In all ${held} forms the re-edited override is the only instance of its slot, and the master is unchanged.`,
            refuted: prose`${held} of ${FORM_COUNT} forms held after the re-edit (recorded per form).`,
            inconclusive: prose`The re-edited series could not be read back expanded.`,
        }, evidence);
    },
};

/** P3B-4: weekly New York series whose second instance is on a clock-change night. */
const DST_SERIES: readonly FormSpec[] = [
    { key: 'repeatedHour', suffix: 'p3b4repeat', start: `DTSTART;TZID=${NY}:20271031T013000`, end: `DTEND;TZID=${NY}:20271031T023000` },
    { key: 'skippedHour', suffix: 'p3b4skip', start: `DTSTART;TZID=${NY}:20270307T023000`, end: `DTEND;TZID=${NY}:20270307T033000` },
];

/** Replaces instance `index` of each series with an override and reports, per series, whether exactly that instance was replaced. */
async function replaceInstance(ctx: CheckContext, temp: TempCalendar, series: readonly Phase3Series[], index: number, count: number, window: readonly [number, number], evidence: Evidence, rid: (slot: IcalComponent) => string | undefined): Promise<{ held: number; readable: number }> {
    const written: Phase3Series[] = [];
    for (const s of series) {
        const slot = s.slots[index];
        if (slot === undefined) {
            continue;
        }
        const ridLine = rid(slot);
        s.overrides = [overrideVevent(s.uid, stampNow(ctx), s.master, slot, { summary: OVERRIDE_SUMMARY, ...(ridLine === undefined ? {} : { rid: ridLine }) }, 1)];
        if (await rewrite(ctx, s, evidence, `${s.key}Override`)) {
            written.push(s);
        }
    }
    const got = written.length === 0 ? new Map<string, Expanded>() : await expandAll(ctx, temp, written.map((s) => s.url), window[0], window[1]);
    let held = 0;
    let readable = 0;
    for (const s of written) {
        const result = got.get(s.url);
        Object.assign(evidence, describeExpanded(`${s.key}After`, result));
        if (!expanded(result)) {
            continue;
        }
        readable++;
        const target = startText(s.slots[index] as IcalComponent);
        const replaced = result.events.filter((e) => summaryOf(e) === OVERRIDE_SUMMARY);
        const ok = result.events.length === count && replaced.length === 1 && startText(replaced[0] as IcalComponent) === target
            && result.events.filter((e) => startText(e) === target).length === 1 && sameList(dtstarts(result.events), dtstarts(s.slots));
        evidence[`${s.key}ReplacedExactly`] = ok;
        held += ok ? 1 : 0;
    }
    return { held, readable };
}

export const overrideDstCheck: CheckDef = {
    id: 'write-override-dst',
    planItem: `${PLAN_3B} (P3B-4): an override on a clock-change night (gates 3b for TZID series)`,
    claim: 'For America/New_York weekly series through 2027-11-07 01:30 (repeated hour) and 2027-03-14 02:30 (skipped hour), an override whose RECURRENCE-ID copies the expanded DTSTART text of that night’s instance replaces exactly that instance.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const evidence: Evidence = {};
        const window = [Date.UTC(2027, 2, 1), Date.UTC(2027, 10, 20)] as const;
        const series = await createSeries(ctx, temp, DST_SERIES, 3, window, evidence);
        const { held, readable } = await replaceInstance(ctx, temp, series, 1, 3, window, evidence, () => undefined);
        return verdict(series.length === 0 ? 0 : DST_SERIES.length, held, readable, {
            confirmed: prose`Both clock-change instances were replaced exactly.`,
            refuted: prose`${held} of ${DST_SERIES.length} clock-change instances were replaced exactly (the others duplicated or lost an instance).`,
            inconclusive: prose`The clock-change series did not come back expanded in their master’s form, or not after the edit.`,
        }, evidence);
    },
};

export const exdateFormsCheck: CheckDef = {
    id: 'write-exdate-forms',
    planItem: `${PLAN_3B} (P3B-5): delete this as an EXDATE in each master form`,
    claim: 'An EXDATE line in the master’s form for instance 3 (TZID, UTC, DATE and floating masters), and override-removal plus EXDATE for a slot that had an override, each leave exactly that instance gone, with no orphan.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const evidence: Evidence = {};
        const first = Date.UTC(2027, 5, 1);
        const specs = [...forms('p3b5', first), { key: 'overridden', suffix: 'p3b5ovr', start: `DTSTART:${icalUtc(first + 4 * DAY + 15 * HOUR)}`, end: `DTEND:${icalUtc(first + 4 * DAY + 16 * HOUR)}` }];
        const window = [Date.UTC(2027, 4, 25), Date.UTC(2027, 6, 20)] as const;
        // The overridden series is created with an override for instance 3 already in place (UTC RECURRENCE-ID).
        const series = await createSeries(ctx, temp, specs, 6, window, evidence, (spec, uid) => (spec.key !== 'overridden' ? [] : [vevent(uid, stampNow(ctx), [
            `RECURRENCE-ID:${icalUtc(first + 18 * DAY + 15 * HOUR)}`, `DTSTART:${icalUtc(first + 18 * DAY + 15 * HOUR)}`, `DTEND:${icalUtc(first + 18 * DAY + 16 * HOUR)}`, `SUMMARY:${OVERRIDE_SUMMARY}`, 'SEQUENCE:1',
        ])]));
        const written: Phase3Series[] = [];
        for (const s of series) {
            const slot = s.slots[2];
            const start = slot === undefined ? undefined : prop(slot, 'DTSTART');
            if (start === undefined) {
                continue;
            }
            // §3.4: the slot text S is the stored RECURRENCE-ID for an existing override, else the instance's DTSTART line.
            const exdate = s.key === 'overridden' ? `EXDATE:${icalUtc(first + 18 * DAY + 15 * HOUR)}` : lineOf(start, 'EXDATE');
            const master = [...s.master.slice(0, -1).map((l) => (l.startsWith('SEQUENCE:') ? 'SEQUENCE:1' : l.startsWith('DTSTAMP:') ? `DTSTAMP:${stampNow(ctx)}` : l)), exdate, 'END:VEVENT'];
            s.overrides = [];
            evidence[`${s.key}ExdateKind`] = fixed(s.key === 'overridden' ? 'utc' : kindOf(start));
            if (await rewrite(ctx, s, evidence, `${s.key}Exdate`, master)) {
                written.push(s);
            }
        }
        const got = written.length === 0 ? new Map<string, Expanded>() : await expandAll(ctx, temp, written.map((s) => s.url), window[0], window[1]);
        let held = 0;
        let readable = 0;
        for (const s of written) {
            const result = got.get(s.url);
            Object.assign(evidence, describeExpanded(`${s.key}After`, result));
            if (!expanded(result)) {
                continue;
            }
            readable++;
            const gone = startText(s.slots[2] as IcalComponent);
            const expected = dtstarts(s.slots.filter((_, i) => i !== 2));
            const ok = result.events.length === 5 && !result.events.some((e) => startText(e) === gone || summaryOf(e).startsWith(OVERRIDE_SUMMARY)) && sameList(dtstarts(result.events), expected);
            evidence[`${s.key}InstanceGone`] = ok;
            held += ok ? 1 : 0;
        }
        return verdict(series.length === 0 ? 0 : specs.length, held, readable, {
            confirmed: prose`In all ${held} series exactly instance 3 is gone, with no orphan.`,
            refuted: prose`${held} of ${specs.length} series lost exactly instance 3 (recorded per series).`,
            inconclusive: prose`The series did not come back expanded before or after the EXDATE.`,
        }, evidence);
    },
};

export const overrideUtcRidOnTzidCheck: CheckDef = {
    id: 'write-override-utc-rid-on-tzid',
    planItem: `${PLAN_3B} (P3B-6, contingency for P3B-2 outcome a): a UTC RECURRENCE-ID on a TZID master`,
    claim: 'On a TZID weekly series, an override whose RECURRENCE-ID is the expanded …Z token in UTC form replaces exactly instance 3.',
    needs: 'temp',
    async run(ctx) {
        const evidence: Evidence = { p3b2Outcome: fixed(ctx.state.phase3.overrideRid ?? 'other') };
        if (ctx.state.phase3.overrideRid !== 'a-stored-text') {
            return { outcome: 'skipped', summary: prose`Skipped: P3B-2 did not show outcome (a), so the contingency is not needed.`, evidence };
        }
        const temp = primary(ctx);
        const spec = forms('p3b6', Date.UTC(2027, 6, 6))[0] as FormSpec;
        const window = [Date.UTC(2027, 6, 1), Date.UTC(2027, 7, 20)] as const;
        const series = await createSeries(ctx, temp, [spec], 6, window, evidence);
        const { held, readable } = await replaceInstance(ctx, temp, series, 2, 6, window, evidence, (slot) => {
            const rid = prop(slot, 'RECURRENCE-ID');
            return rid === undefined || kindOf(rid) !== 'utc' ? undefined : `RECURRENCE-ID:${rid.value}`;
        });
        return verdict(series.length, held, readable, {
            confirmed: prose`The UTC RECURRENCE-ID replaced exactly instance 3.`,
            refuted: prose`The UTC RECURRENCE-ID did not replace exactly instance 3.`,
            inconclusive: prose`The TZID series did not come back expanded before or after the edit.`,
        }, evidence);
    },
};

export const WRITE_3B_CHECKS: CheckDef[] = [overrideNewFormsCheck, overrideExpandedShapeCheck, overrideReeditCheck, overrideDstCheck, exdateFormsCheck, overrideUtcRidOnTzidCheck];
