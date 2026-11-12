/**
 * Shared pieces of the phase 3 write checks (probe 0.6.0). Every event is written by the probe
 * into its own temporary calendar with the usual probe UID and a SUMMARY starting
 * `caldav-mcp probe `, so `--cleanup` recognises it, and every read-back passes the same
 * provenance rules as the phase 2 checks (`requireSynthetic` through `windowResources` and
 * `readRaw`). Values are published only as `AuthoredValue`s from validated resources.
 */
import { CheckStop, isOk, isRefusal, stopOnThrottle, type CheckContext, type TempCalendar } from '../context';
import { contentTypeClass, getResource, requireSynthetic } from '../dav';
import { buildIcal, comps, icalUtc, prop, type IcalComponent, type IcalProperty } from '../ical';
import { kindOf } from '../ical-time';
import { fixed, prose, safeNames, type Safe } from '../safe';
import type { Evidence } from '../types';
import { PROBE_VERSION } from '../version';
import { windowResources, type Expanded } from './write-expansion';
import { putEvent, type PutResult } from './write-helpers';
import { tuples } from './write-instances';

export const PLAN_3A = 'Phase 3a write path';
export const PLAN_3B = 'Phase 3b (edit_scope this)';
export const PLAN_3C = 'Phase 3c (edit_scope this_and_future)';
export const PLAN_3D = 'Phase 3d (series move)';
export const OVERRIDE_SUMMARY = 'caldav-mcp probe override';
export const NY = 'America/New_York';

/** The VCALENDAR the probe writes around its VEVENTs (no VTIMEZONE: iCloud adds one [M], as phase 3's server will rely on). */
export function calendarText(vevents: readonly (readonly string[])[], vtimezone: readonly string[] = []): string {
    return buildIcal(['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//caldav-mcp//probe ${PROBE_VERSION}//EN`, 'CALSCALE:GREGORIAN', ...vtimezone, ...vevents.flat(), 'END:VCALENDAR']);
}

/** One VEVENT. The DTSTAMP is fixed by the caller, so the same master can be sent again byte for byte. */
export function vevent(uid: string, stamp: string, lines: readonly string[]): string[] {
    return ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, ...lines, 'END:VEVENT'];
}

export function stampNow(ctx: CheckContext): string {
    return icalUtc(ctx.now());
}

/** A property as one content line (parameters in the order they were parsed; quotes are not restored). */
export function lineOf(p: IcalProperty, name = p.name): string {
    return `${name}${Object.entries(p.params).map(([k, v]) => `;${k}=${v}`).join('')}:${p.value}`;
}

/** PUT that may be refused: records `<key>PutStatus` (and on a refusal the precondition names and body class). */
export async function tryWrite(ctx: CheckContext, url: string, body: string, evidence: Evidence, key: string, etag?: string | null): Promise<PutResult | undefined> {
    const put = await putEvent(ctx, url, body, etag === undefined ? { 'if-none-match': '*' } : etag === null ? {} : { 'if-match': etag });
    evidence[`${key}PutStatus`] = put.status;
    if (!isOk(put.status)) {
        evidence[`${key}Preconditions`] = safeNames(put.errorElements, ctx.taint);
        return undefined;
    }
    return put;
}

/** PUT that must succeed for the check to continue (a refusal is refuted, anything else inconclusive). */
export async function writeOrStop(ctx: CheckContext, url: string, body: string, evidence: Evidence, key: string, etag?: string | null): Promise<PutResult> {
    const put = await tryWrite(ctx, url, body, evidence, key, etag);
    if (put === undefined) {
        const status = evidence[`${key}PutStatus`];
        const code = typeof status === 'number' ? status : 0;
        throw new CheckStop(isRefusal(code) ? 'refuted' : 'inconclusive', prose`The server did not accept a test write (HTTP ${code}).`, evidence);
    }
    return put;
}

export interface Raw { status: number; etag: string | null; body: string; ical: IcalComponent | undefined; events: IcalComponent[] }

/** GET of a resource the probe wrote, with its body text; a 200 must carry exactly the probe's UID or the check stops. */
export async function readRaw(ctx: CheckContext, temp: TempCalendar, url: string, uid: string): Promise<Raw> {
    const got = await getResource(ctx, url);
    if (got.status === 200) {
        requireSynthetic(got.ical, got.url, temp.url, uid, got.status);
    }
    return { status: got.status, etag: got.etag, body: got.body, ical: got.ical, events: got.ical === undefined ? [] : comps(got.ical, 'VEVENT') };
}

/** One expanded REPORT over a window, with the resource of each href (validated by `windowResources`). */
export async function expandAll(ctx: CheckContext, temp: TempCalendar, hrefs: readonly string[], start: number, end: number): Promise<Map<string, Expanded>> {
    return windowResources(ctx, temp, hrefs, start, end, 'expand');
}

/** True when the server actually expanded: something came back, and no instance still carries an RRULE. */
export function expanded(got: Expanded | undefined): got is Expanded {
    return got !== undefined && got.status === 207 && got.returned && got.events.length > 0 && got.events.every((e) => prop(e, 'RRULE') === undefined);
}

/** Instances sorted by their RECURRENCE-ID text (one form per series, so text order is time order). */
export function byRid(events: readonly IcalComponent[]): IcalComponent[] {
    return events.toSorted((a, b) => {
        const [x, y] = [prop(a, 'RECURRENCE-ID')?.value ?? '', prop(b, 'RECURRENCE-ID')?.value ?? ''];
        return x < y ? -1 : x > y ? 1 : 0;
    });
}

export const summaryOf = (e: IcalComponent): string => prop(e, 'SUMMARY')?.value ?? '';
export const startText = (e: IcalComponent): string | undefined => {
    const p = prop(e, 'DTSTART');
    return p === undefined ? undefined : lineOf(p);
};

/** The count, the forms and the tuples of one expanded result, under keys that start with `key`. */
export function describeExpanded(key: string, got: Expanded | undefined): Evidence {
    const events = got?.events ?? [];
    const kinds = (name: string): Record<string, number> => {
        const counts: Record<string, number> = {};
        for (const e of events) {
            counts[kindOf(prop(e, name))] = (counts[kindOf(prop(e, name))] ?? 0) + 1;
        }
        return counts;
    };
    return {
        [`${key}ExpandStatus`]: got?.status ?? 0,
        [`${key}Count`]: events.length,
        [`${key}RecurrenceIdKinds`]: kinds('RECURRENCE-ID'),
        [`${key}DtstartKinds`]: kinds('DTSTART'),
        [`${key}OverrideSummaries`]: events.filter((e) => summaryOf(e).startsWith(OVERRIDE_SUMMARY)).length,
        [`${key}Tuples`]: tuples(events),
    };
}

/** Raw content lines of the VEVENT blocks of a body (unfolded), keyed master / override RECURRENCE-ID text. */
export function veventBlocks(body: string): { master: string[] | undefined; overrides: string[][] } {
    const lines = body.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '');
    const blocks: string[][] = [];
    let current: string[] | undefined;
    let depth = 0;
    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') {
            current = [line];
            depth = 1;
            continue;
        }
        if (current !== undefined) {
            current.push(line);
            depth += line.startsWith('BEGIN:') ? 1 : line.startsWith('END:') ? -1 : 0;
            if (depth === 0) {
                blocks.push(current);
                current = undefined;
            }
        }
    }
    const isOverride = (block: readonly string[]): boolean => block.some((l) => /^RECURRENCE-ID[;:]/.test(l));
    return { master: blocks.find((b) => !isOverride(b)), overrides: blocks.filter(isOverride) };
}

/** The class of a refusal's body (`xml`, `html`, ... `none`), never the body. */
export function bodyClass(headers: Headers): Safe {
    return fixed(contentTypeClass(headers.get('content-type')));
}

/** Zone-free day shift of `YYYYMMDD` or `YYYYMMDDTHHMMSS[Z]` text (the probe's own synthetic values). */
export function shiftText(value: string, ms: number): string {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value);
    if (match === null) {
        return value;
    }
    const [, y, mo, d, h, mi, s, z] = match;
    const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)) + ms;
    const text = icalUtc(at);
    return h === undefined ? text.slice(0, 8) : z === 'Z' ? text : text.slice(0, 15);
}

/** A property line with its value shifted (parameters kept). */
export function shiftLine(p: IcalProperty, ms: number, name = p.name): string {
    return lineOf({ ...p, value: shiftText(p.value, ms) }, name);
}

const nameOf = (line: string): string => /^[A-Za-z0-9-]+/.exec(line)?.[0].toUpperCase() ?? '';

/** The raw content lines of a body, each with its continuation lines, so untouched lines are re-sent byte for byte. */
export function contentLines(body: string): string[] {
    const out: string[] = [];
    for (const physical of body.split(/\r?\n/)) {
        if ((physical.startsWith(' ') || physical.startsWith('\t')) && out.length > 0) {
            out[out.length - 1] += `\r\n${physical}`;
        } else if (physical !== '') {
            out.push(physical);
        }
    }
    return out;
}

const unfoldLine = (line: string): string => line.replace(/\r\n[ \t]/g, '');

/**
 * Span edit of one VEVENT of a stored body (design §3.3, ORCH S1): in the first VEVENT whose
 * unfolded lines satisfy `select`, the named direct properties are replaced, DTSTAMP is renewed
 * and SEQUENCE incremented (inserted as 1 if absent); every other line is kept byte for byte.
 * Undefined when no VEVENT matches.
 */
export function spanEditVevent(body: string, select: (lines: readonly string[]) => boolean, replace: Record<string, string>, stamp: string): string | undefined {
    const lines = contentLines(body);
    const blocks: [number, number][] = [];
    let depth = 0;
    let start = -1;
    lines.forEach((line, i) => {
        const begin = line.startsWith('BEGIN:');
        const end = line.startsWith('END:');
        if (line === 'BEGIN:VEVENT' && depth === 1) {
            start = i;
        }
        depth += begin ? 1 : end ? -1 : 0;
        if (line === 'END:VEVENT' && depth === 1 && start >= 0) {
            blocks.push([start, i]);
            start = -1;
        }
    });
    const chosen = blocks.find(([from, to]) => select(lines.slice(from, to + 1).map(unfoldLine)));
    if (chosen === undefined) {
        return undefined;
    }
    const [from, to] = chosen;
    const out: string[] = [];
    let inner = 0;
    let sequenceSeen = false;
    lines.forEach((line, i) => {
        if (i <= from || i > to) {
            out.push(line);
            return;
        }
        if (i === to) {
            if (!sequenceSeen) {
                out.push('SEQUENCE:1');
            }
            out.push(line);
            return;
        }
        const top = inner === 0;
        inner += line.startsWith('BEGIN:') ? 1 : line.startsWith('END:') ? -1 : 0;
        const name = nameOf(line);
        if (top && name in replace) {
            out.push(replace[name] ?? line);
        } else if (top && name === 'DTSTAMP') {
            out.push(`DTSTAMP:${stamp}`);
        } else if (top && name === 'SEQUENCE') {
            sequenceSeen = true;
            out.push(`SEQUENCE:${Number(/:(\d+)$/.exec(unfoldLine(line))?.[1] ?? '0') + 1}`);
        } else {
            out.push(line);
        }
    });
    return `${out.join('\r\n')}\r\n`;
}

/** Master lines that §3.3 does not copy into a new override (the override gets its own). */
const NOT_COPIED = new Set(['BEGIN', 'END', 'UID', 'RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'DTSTART', 'DTEND', 'DURATION', 'DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE', 'SUMMARY']);

/**
 * A new override as design §3.3 builds it: the master's content lines except the recurrence and
 * time properties; DTSTART/DTEND are the expanded instance's lines verbatim unless changed; the
 * RECURRENCE-ID is the instance's DTSTART line renamed (master form); SUMMARY is the change.
 */
export function overrideVevent(uid: string, stamp: string, master: readonly string[], slot: IcalComponent, change: { summary: string; start?: string; end?: string; rid?: string }, sequence: number): string[] {
    const start = prop(slot, 'DTSTART');
    const end = prop(slot, 'DTEND');
    const copied = master.filter((line) => !NOT_COPIED.has(nameOf(line)));
    return vevent(uid, stamp, [
        change.rid ?? (start === undefined ? 'RECURRENCE-ID:' : lineOf(start, 'RECURRENCE-ID')),
        change.start ?? (start === undefined ? '' : lineOf(start)),
        change.end ?? (end === undefined ? '' : lineOf(end)),
        ...copied, `SUMMARY:${change.summary}`, `SEQUENCE:${sequence}`,
    ]);
}

/** §3.2 slot text check: the expanded DTSTART has the master's form (same TZID text for a TZID master). */
export function formMatches(masterStart: string, slot: IcalComponent): boolean {
    const p = prop(slot, 'DTSTART');
    const tzid = /;TZID=([^;:]+)/.exec(masterStart)?.[1];
    const kind = /;VALUE=DATE[;:]/.test(masterStart) ? 'date' : tzid !== undefined ? 'tzid' : masterStart.endsWith('Z') ? 'utc' : 'floating';
    return kindOf(p) === kind && (kind !== 'tzid' || p?.params.TZID === tzid);
}

/** Throttling ends a check like everywhere else in the probe. */
export async function guardedGet(ctx: CheckContext, url: string): Promise<{ status: number; url: string; etag: string | null; raw: Uint8Array }> {
    const res = await ctx.http.request({ method: 'GET', url, raw: true });
    stopOnThrottle(ctx, res);
    return { status: res.status, url: res.url, etag: res.headers.get('etag'), raw: res.raw ?? new Uint8Array(0) };
}
