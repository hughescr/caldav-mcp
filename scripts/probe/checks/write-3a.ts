/**
 * Phase 3a probe checks (design §8.1, P3A-1 to P3A-9): what iCloud does with the single events
 * and simple series that `create_event`, `update_event` and `delete_event` will write. Every
 * event is the probe's own, in its own temporary calendar; values are published only from
 * resources whose URL and UID were validated, and only in strict date shapes or fixed codes.
 */
import { CheckStop, isOk, isRefusal, stopOnThrottle, type CheckContext, type CheckDef, type CheckOutput } from '../context';
import { recordRefusal, requireSynthetic, taintIcalText, taintXml } from '../dav';
import { elementNames, parseXml } from '../xml';
import { comps, icalDate, icalLocal, icalUtc, prop, type IcalComponent, type IcalProperty } from '../ical';
import { dateShape, kindOf } from '../ical-time';
import { fixed, prose, safeNames, type Safe } from '../safe';
import { zoneValidator } from '../tz';
import type { Evidence } from '../types';
import { DAY, HOUR, SUMMARY, baseDay, deleteEvent, newEvent, primary, propfindEtag } from './write-helpers';
import {
    NY, PLAN_3A, bodyClass, calendarText, spanEditVevent, describeExpanded, expandAll, expanded, guardedGet, readRaw, stampNow, tryWrite, vevent, writeOrStop,
} from './phase3-helpers';
import type { Expanded } from './write-expansion';
import { easternOffset, wallToInstant } from './zones';

/** What a PUT did to a TZID it was sent: `kept-tzid`, `floating`, `utc`, `tzid-changed` or `other` (never the stored TZID). */
function zoneDisposition(stored: IcalProperty | undefined, tzid: string, local: string): Safe {
    const kind = kindOf(stored);
    if (stored === undefined) {
        return fixed('other');
    }
    if (kind === 'utc') {
        return fixed('utc');
    }
    if (kind === 'floating') {
        return fixed(stored.value === local ? 'floating' : 'other');
    }
    if (kind === 'tzid') {
        return fixed(stored.params.TZID === tzid ? (stored.value === local ? 'kept-tzid' : 'other') : 'tzid-changed');
    }
    return fixed('other');
}

const hasZone = (root: IcalComponent | undefined, tzid: string): boolean => root !== undefined && comps(root, 'VTIMEZONE').some((z) => prop(z, 'TZID')?.value === tzid);

interface ZoneCase { key: string; suffix: string; tzid: string }

/** One create without VTIMEZONE in the given zone, then a read-back. Records under `<key>…`. */
async function zoneCreate(ctx: CheckContext, zone: ZoneCase, wall: number, evidence: Evidence): Promise<{ accepted: boolean; refused: boolean; disposition: Safe | undefined; zoneAdded: boolean; etagEqual: boolean | null }> {
    const temp = primary(ctx);
    const { url, uid } = newEvent(temp, zone.suffix);
    const local = icalLocal(wall);
    const body = calendarText([vevent(uid, stampNow(ctx), [`DTSTART;TZID=${zone.tzid}:${local}`, `DTEND;TZID=${zone.tzid}:${icalLocal(wall + HOUR)}`, `SUMMARY:${SUMMARY}`])]);
    const put = await tryWrite(ctx, url, body, evidence, zone.key);
    if (put === undefined) {
        const status = evidence[`${zone.key}PutStatus`];
        return { accepted: false, refused: typeof status === 'number' && isRefusal(status), disposition: undefined, zoneAdded: false, etagEqual: null };
    }
    evidence[`${zone.key}PutEtagHeader`] = put.etag !== null;
    const stored = await readRaw(ctx, temp, url, uid);
    const master = stored.events.find((e) => prop(e, 'RECURRENCE-ID') === undefined);
    const start = master === undefined ? undefined : prop(master, 'DTSTART');
    const disposition = stored.status === 200 ? zoneDisposition(start, zone.tzid, local) : undefined;
    const zoneAdded = hasZone(stored.ical, zone.tzid);
    const etagEqual = put.etag === null || stored.etag === null ? null : put.etag === stored.etag;
    Object.assign(evidence, {
        [`${zone.key}ReadBackStatus`]: stored.status,
        [`${zone.key}Disposition`]: disposition ?? fixed('<none>'),
        [`${zone.key}StoredDtstart`]: dateShape(start?.value),
        [`${zone.key}Vtimezones`]: stored.ical === undefined ? 0 : comps(stored.ical, 'VTIMEZONE').length,
        [`${zone.key}VtimezoneForSentTzid`]: zoneAdded,
        [`${zone.key}EtagHeaderEqualsStored`]: etagEqual,
    });
    if (disposition === 'tzid-changed' && start?.params.TZID !== undefined) {
        evidence[`${zone.key}NewTzidIsIana`] = zoneValidator()(start.params.TZID) ?? null;
    }
    return { accepted: true, refused: false, disposition, zoneAdded, etagEqual };
}

const UNKNOWN_ZONES: readonly ZoneCase[] = [
    { key: 'windows', suffix: 'p3a1windows', tzid: 'Pacific Standard Time' },
    { key: 'alias', suffix: 'p3a1alias', tzid: 'US/Eastern' },
    { key: 'unknown', suffix: 'p3a1unknown', tzid: 'Mars/Olympus' },
];

export const unknownZoneCheck: CheckDef = {
    id: 'write-unknown-zone',
    planItem: `${PLAN_3A} (P3A-1): a TZID that is not a canonical IANA name, without VTIMEZONE`,
    claim: 'iCloud refuses each of three events written without a VTIMEZONE in TZID=Pacific Standard Time (a Windows name), US/Eastern (a tzdb alias) and Mars/Olympus (no zone).',
    needs: 'temp',
    async run(ctx) {
        const evidence: Evidence = {};
        const day = baseDay(ctx) + 20 * DAY + 10 * HOUR;
        const results = [];
        for (const [i, zone] of UNKNOWN_ZONES.entries()) {
            results.push(await zoneCreate(ctx, zone, day + i * DAY, evidence));
        }
        const refused = results.filter((r) => r.refused).length;
        const accepted = results.filter((r) => r.accepted).length;
        evidence.refused = refused;
        evidence.accepted = accepted;
        if (refused === UNKNOWN_ZONES.length) {
            return { outcome: 'confirmed', summary: prose`All ${refused} events were refused.`, evidence };
        }
        if (accepted > 0) {
            return { outcome: 'refuted', summary: prose`${accepted} of ${UNKNOWN_ZONES.length} events were accepted (the disposition of each is recorded).`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`${refused} event(s) were refused and the others were not answered with a 2xx or 4xx.`, evidence };
    },
};

const IANA_ZONES: readonly ZoneCase[] = [
    { key: 'kolkata', suffix: 'p3a2kolkata', tzid: 'Asia/Kolkata' },
    { key: 'lordHowe', suffix: 'p3a2lordhowe', tzid: 'Australia/Lord_Howe' },
    { key: 'saoPaulo', suffix: 'p3a2saopaulo', tzid: 'America/Sao_Paulo' },
    { key: 'gmtPlus5', suffix: 'p3a2gmtplus5', tzid: 'Etc/GMT+5' },
];

export const ianaZonesCheck: CheckDef = {
    id: 'write-iana-zones',
    planItem: `${PLAN_3A} (P3A-2): IANA zones without VTIMEZONE (generalises plan rule 7)`,
    claim: 'Events written without a VTIMEZONE in Asia/Kolkata, Australia/Lord_Howe, America/Sao_Paulo and Etc/GMT+5 are each kept with their TZID and local time, gain a VTIMEZONE for it, and the 201 carries an ETag equal to the stored one.',
    needs: 'temp',
    async run(ctx) {
        const evidence: Evidence = {};
        const day = baseDay(ctx) + 24 * DAY + 10 * HOUR;
        const results: Awaited<ReturnType<typeof zoneCreate>>[] = [];
        for (const [i, zone] of IANA_ZONES.entries()) {
            results.push(await zoneCreate(ctx, zone, day + i * DAY, evidence));
        }
        const good = results.filter((r) => r.accepted && r.disposition === 'kept-tzid' && r.zoneAdded && r.etagEqual === true).length;
        evidence.asClaimed = good;
        if (good === IANA_ZONES.length) {
            return { outcome: 'confirmed', summary: prose`All ${good} zones were kept, gained a VTIMEZONE, and the ETag header matched.`, evidence };
        }
        // A counterexample is a refusal, or a read-back that differs from the claim; an unread case is not one.
        const asClaimed = (r: (typeof results)[number]): boolean => r.disposition === 'kept-tzid' && r.zoneAdded && r.etagEqual === true;
        if (results.some((r) => r.refused || (r.accepted && r.disposition !== undefined && !asClaimed(r)))) {
            return { outcome: 'refuted', summary: prose`${good} of ${IANA_ZONES.length} zones behaved as claimed (each case is recorded).`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The events could not be written or read back.`, evidence };
    },
};

/** Span edit of the master VEVENT (the one without RECURRENCE-ID). */
function spanEdit(body: string, replace: Record<string, string>, stamp: string): string | undefined {
    return spanEditVevent(body, (lines) => !lines.some((l) => /^RECURRENCE-ID[;:]/i.test(l)), replace, stamp);
}

export const zoneChangeCheck: CheckDef = {
    id: 'write-zone-change',
    planItem: `${PLAN_3A} (P3A-3): an update that changes the zone`,
    claim: 'A span-edited update (If-Match, SEQUENCE+1, new DTSTAMP) moving an America/New_York event to Europe/Berlin with the same local digits is accepted and stored with the Berlin TZID and those digits, and the 204 carries an ETag equal to the stored one.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'p3a3zone');
        const wall = baseDay(ctx) + 28 * DAY + 10 * HOUR;
        const [start, end] = [icalLocal(wall), icalLocal(wall + HOUR)];
        const evidence: Evidence = {};
        await writeOrStop(ctx, url, calendarText([vevent(uid, stampNow(ctx), [`DTSTART;TZID=${NY}:${start}`, `DTEND;TZID=${NY}:${end}`, 'SEQUENCE:0', `SUMMARY:${SUMMARY}`])]), evidence, 'create');
        const before = await readRaw(ctx, temp, url, uid);
        Object.assign(evidence, { beforeReadBackStatus: before.status, newYorkVtimezoneBefore: hasZone(before.ical, NY), vtimezonesBefore: before.ical === undefined ? 0 : comps(before.ical, 'VTIMEZONE').length });
        if (before.status !== 200) {
            return { outcome: 'inconclusive', summary: prose`The created event could not be read back (HTTP ${before.status}).`, evidence };
        }
        const edited = spanEdit(before.body, { DTSTART: `DTSTART;TZID=Europe/Berlin:${start}`, DTEND: `DTEND;TZID=Europe/Berlin:${end}` }, stampNow(ctx));
        if (edited === undefined) {
            return { outcome: 'inconclusive', summary: prose`The stored event had no master VEVENT to edit.`, evidence };
        }
        const put = await tryWrite(ctx, url, edited, evidence, 'update', before.etag);
        if (put === undefined) {
            const status = evidence.updatePutStatus;
            return { outcome: typeof status === 'number' && isRefusal(status) ? 'refuted' : 'inconclusive', summary: prose`The zone-changing update was not accepted.`, evidence };
        }
        evidence.updateEtagHeader = put.etag !== null;
        const after = await readRaw(ctx, temp, url, uid);
        const master = after.events.find((e) => prop(e, 'RECURRENCE-ID') === undefined);
        const [s, e] = [master === undefined ? undefined : prop(master, 'DTSTART'), master === undefined ? undefined : prop(master, 'DTEND')];
        const berlin = s?.params.TZID === 'Europe/Berlin' && e?.params.TZID === 'Europe/Berlin';
        const digits = s?.value === start && e?.value === end;
        const zones = after.ical === undefined ? [] : comps(after.ical, 'VTIMEZONE').map((z) => prop(z, 'TZID')?.value);
        const etagEqual = put.etag === null || after.etag === null ? null : put.etag === after.etag;
        Object.assign(evidence, {
            afterReadBackStatus: after.status, berlinTzidKept: berlin, localDigitsKept: digits, storedDtstart: dateShape(s?.value),
            newYorkVtimezoneAfter: zones.includes(NY), berlinVtimezoneAfter: zones.includes('Europe/Berlin'), otherVtimezonesAfter: zones.filter((z) => z !== NY && z !== 'Europe/Berlin').length,
            sequenceAfter: Number(prop(master ?? { name: '', properties: [], components: [] }, 'SEQUENCE')?.value ?? -1),
            etagHeaderEqualsStored: etagEqual,
        });
        if (after.status !== 200) {
            return { outcome: 'inconclusive', summary: prose`The updated event could not be read back (HTTP ${after.status}).`, evidence };
        }
        return berlin && digits && etagEqual === true
            ? { outcome: 'confirmed', summary: prose`The update was stored in Europe/Berlin with the same local time, and the ETag header matched.`, evidence }
            : { outcome: 'refuted', summary: prose`The update was accepted, but the zone, the local time or the ETag header differ from the claim.`, evidence };
    },
};

// ---- P3A-4: text round trip ----------------------------------------------------------------

const encoder = new TextEncoder();
/** Escaped TEXT values (RFC 5545 3.3.11) with every hazard the design names; SUMMARY starts with the probe prefix. */
export const TEXT_VALUES = {
    SUMMARY: 'caldav-mcp probe text\\, comma\\; semicolon\\\\ backslash\\nnewline\ttab \u{1F5D3}\u{FE0F} cafe\u0301',
    LOCATION: 'Probe room\\, level 2\\; east\\\\west\\nsecond line\t\u{1F642} nai\u0308ve',
    DESCRIPTION: (() => {
        const unit = 'caldav-mcp probe description \u00e9\u6f22\u{1F642}\u0301\\, \\; \\\\ \\n\t';
        let text = '';
        while (encoder.encode(text).length < 8192) {
            text += unit;
        }
        return text;
    })(),
} as const;

/** RFC 5545 TEXT unescaping. */
export function unescapeText(value: string): string {
    return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** One content line folded every 75 octets (74 after the leading space), ignoring character boundaries. */
export function foldOctets(line: string): { bytes: number[]; insideUtf8: number } {
    const b = encoder.encode(line);
    const out: number[] = [];
    let insideUtf8 = 0;
    for (let pos = 0, first = true; pos < b.length; first = false) {
        const take = first ? 75 : 74;
        if (!first) {
            out.push(13, 10, 32);
            insideUtf8 += ((b[pos] ?? 0) & 0xc0) === 0x80 ? 1 : 0;
        }
        for (const byte of b.subarray(pos, pos + take)) {
            out.push(byte);
        }
        pos += take;
    }
    return { bytes: out, insideUtf8 };
}

/** Physical lines of a body as octets (line ending removed), grouped into content lines. */
function physicalGroups(raw: Uint8Array): { name: string; lines: Uint8Array[] }[] {
    const groups: { name: string; lines: Uint8Array[] }[] = [];
    let start = 0;
    for (let i = 0; i <= raw.length; i++) {
        if (i === raw.length || raw[i] === 10) {
            let end = i;
            if (end > start && raw[end - 1] === 13) {
                end--;
            }
            const line = raw.subarray(start, end);
            start = i + 1;
            if (line.length === 0) {
                continue;
            }
            const last = groups.at(-1);
            if ((line[0] === 32 || line[0] === 9) && last !== undefined) {
                last.lines.push(line);
            } else {
                groups.push({ name: /^[A-Za-z0-9-]*/.exec(new TextDecoder().decode(line.subarray(0, 64)))?.[0].toUpperCase() ?? '', lines: [line] });
            }
        }
    }
    return groups;
}

/** RFC 5545 3.1: unfold as octets, then decode. */
function unfoldThenDecode(raw: Uint8Array): string {
    return physicalGroups(raw).map((g) => {
        const parts = g.lines.map((l, i) => (i === 0 ? l : l.subarray(1)));
        return new TextDecoder().decode(Buffer.concat(parts));
    }).join('\r\n');
}

export const textRoundTripCheck: CheckDef = {
    id: 'write-text-roundtrip',
    planItem: `${PLAN_3A} (P3A-4): text values and line folding`,
    claim: 'SUMMARY, LOCATION and an 8 KiB DESCRIPTION with escaped , ; and \\, newlines, a TAB, emoji and combining marks, sent folded every 75 octets (also inside UTF-8 sequences), come back with identical decoded values.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'p3a4text');
        const day = baseDay(ctx) + 30 * DAY + 15 * HOUR;
        const ascii = (lines: readonly string[]): number[] => [...encoder.encode(lines.map((l) => `${l}\r\n`).join(''))];
        const folded = Object.entries(TEXT_VALUES).map(([name, value]) => ({ name, ...foldOctets(`${name}:${value}`) }));
        const bytes = new Uint8Array([
            ...ascii(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//caldav-mcp//probe//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stampNow(ctx)}`, `DTSTART:${icalUtc(day)}`, `DTEND:${icalUtc(day + HOUR)}`]),
            ...folded.flatMap((f) => [...f.bytes, 13, 10]),
            ...ascii(['END:VEVENT', 'END:VCALENDAR']),
        ]);
        const evidence: Evidence = { sentFoldsInsideUtf8: folded.reduce((n, f) => n + f.insideUtf8, 0), sentDescriptionOctets: encoder.encode(TEXT_VALUES.DESCRIPTION).length };
        const put = await ctx.http.request({ method: 'PUT', url, body: bytes, headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' } });
        if (put.status >= 400) {
            // Sent outside dav(), so its refusal is recorded here for write-error-bodies.
            const root = /^\s*</.test(put.body) ? parseXml(put.body) : undefined;
            taintXml(root, ctx.taint);
            recordRefusal(ctx, 'PUT', put, root?.name, elementNames(root).filter((name) => name !== 'error' && name !== 'href'));
        }
        stopOnThrottle(ctx, put);
        evidence.putStatus = put.status;
        if (!isOk(put.status)) {
            evidence.refusalBodyClass = bodyClass(put.headers);
            return { outcome: isRefusal(put.status) ? 'refuted' : 'inconclusive', summary: prose`The folded text event was not accepted (HTTP ${put.status}).`, evidence };
        }
        const got = await guardedGet(ctx, url);
        evidence.readBackStatus = got.status;
        if (got.status !== 200) {
            return { outcome: 'inconclusive', summary: prose`The text event could not be read back (HTTP ${got.status}).`, evidence };
        }
        const text = unfoldThenDecode(got.raw);
        const ical = taintIcalText(text, ctx.taint);
        requireSynthetic(ical, got.url, temp.url, uid, got.status);
        const event = ical === undefined ? undefined : comps(ical, 'VEVENT')[0];
        const groups = physicalGroups(got.raw);
        const description = groups.find((g) => g.name === 'DESCRIPTION');
        const sentDescription = folded.find((f) => f.name === 'DESCRIPTION')?.bytes ?? [];
        const receivedDescription = Buffer.concat(description === undefined ? [] : description.lines.flatMap((l, i) => (i === 0 ? [l] : [new Uint8Array([13, 10]), l])));
        const lengths = groups.flatMap((g) => g.lines.map((l) => l.length));
        let equalDecoded = 0;
        for (const name of Object.keys(TEXT_VALUES) as (keyof typeof TEXT_VALUES)[]) {
            const value = event === undefined ? undefined : prop(event, name)?.value;
            const decodedEqual = value !== undefined && unescapeText(value) === unescapeText(TEXT_VALUES[name]);
            equalDecoded += decodedEqual ? 1 : 0;
            evidence[`${name.toLowerCase()}DecodedEqual`] = decodedEqual;
            evidence[`${name.toLowerCase()}EscapedTextEqual`] = value === TEXT_VALUES[name];
        }
        Object.assign(evidence, {
            receivedMaxPhysicalLineOctets: lengths.length === 0 ? 0 : Math.max(...lengths),
            receivedPhysicalLinesOver75Octets: lengths.filter((n) => n > 75).length,
            receivedDescriptionContinuationLines: description === undefined ? 0 : description.lines.length - 1,
            receivedFoldsInsideUtf8: groups.reduce((n, g) => n + g.lines.slice(1).filter((l) => ((l[1] ?? 0) & 0xc0) === 0x80).length, 0),
            descriptionFoldedAsSent: receivedDescription.equals(Buffer.from(sentDescription)),
            receivedLineEndings: fixed(lineEndings(got.raw)),
            naiveDecodeHasReplacementCharacter: new TextDecoder().decode(got.raw).includes('\uFFFD'),
        });
        return equalDecoded === 3
            ? { outcome: 'confirmed', summary: prose`All three text values came back with identical decoded values.`, evidence }
            : { outcome: 'refuted', summary: prose`${3 - equalDecoded} of 3 text values came back with different decoded values.`, evidence };
    },
};

function lineEndings(raw: Uint8Array): string {
    let crlf = 0;
    let lf = 0;
    raw.forEach((b, i) => {
        if (b === 10) {
            if (raw[i - 1] === 13) {
                crlf++;
            } else {
                lf++;
            }
        }
    });
    return crlf > 0 && lf > 0 ? 'mixed' : lf > 0 ? 'lf' : 'crlf';
}

// ---- P3A-5: refusal bodies -----------------------------------------------------------------

export const errorBodiesCheck: CheckDef = {
    id: 'write-error-bodies',
    planItem: `${PLAN_3A} (P3A-5): the shape of refusal bodies (sanitiser constants)`,
    claim: 'Every write refused before this check (status 400 or above, 429 and 503 included, in every earlier write check and one PUT whose DTSTART is after its DTEND in UTC; the invite steps and cleanup run later and are not counted) has an empty body or a DAV:error XML body.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'p3a5invalid');
        const day = baseDay(ctx) + 31 * DAY;
        const evidence: Evidence = {};
        const put = await tryWrite(ctx, url, calendarText([vevent(uid, stampNow(ctx), [`DTSTART:${icalUtc(day + 11 * HOUR)}`, `DTEND:${icalUtc(day + 10 * HOUR)}`, `SUMMARY:${SUMMARY}`])]), evidence, 'invalid');
        evidence.invalidAccepted = put !== undefined;
        const refusals = ctx.state.refusals;
        const byStatus: Record<string, number> = {};
        const byClass: Record<string, number> = {};
        for (const r of refusals) {
            byStatus[`${r.method}-${r.status}`] = (byStatus[`${r.method}-${r.status}`] ?? 0) + 1;
            byClass[r.contentType] = (byClass[r.contentType] ?? 0) + 1;
        }
        const empty = refusals.filter((r) => r.bytes === 0).length;
        const xmlError = refusals.filter((r) => r.bytes > 0 && r.contentType === 'xml' && r.root === 'error').length;
        Object.assign(evidence, {
            refusals: refusals.length, refusalsByMethodAndStatus: byStatus, refusalContentTypes: byClass, refusalEmptyBodies: empty, refusalDavErrorBodies: xmlError,
            refusalMaxBodyOctets: refusals.reduce((n, r) => Math.max(n, r.bytes), 0),
            refusalRootElements: safeNames(refusals.flatMap((r) => (r.root === undefined ? [] : [r.root])), ctx.taint),
            refusalPreconditions: safeNames(refusals.flatMap((r) => r.elements), ctx.taint),
        });
        if (refusals.length === 0) {
            return { outcome: 'inconclusive', summary: prose`No write was refused in this run, so there is no body to describe.`, evidence };
        }
        return empty + xmlError === refusals.length
            ? { outcome: 'confirmed', summary: prose`All ${refusals.length} refusal(s) had an empty body or a DAV:error body.`, evidence }
            : { outcome: 'refuted', summary: prose`${refusals.length - empty - xmlError} of ${refusals.length} refusal(s) had another kind of body.`, evidence };
    },
};

// ---- P3A-6, P3A-7, P3A-8 -------------------------------------------------------------------

export const defaultAlarmsCheck: CheckDef = {
    id: 'write-default-alarms',
    planItem: `${PLAN_3A} (P3A-6): default alarms`,
    claim: 'An event created without a VALARM is stored without a VALARM and without X-APPLE-DEFAULT-ALARM.',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'p3a6alarm');
        const day = baseDay(ctx) + 32 * DAY + 15 * HOUR;
        const sentNames = ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY'];
        const evidence: Evidence = {};
        await writeOrStop(ctx, url, calendarText([vevent(uid, stampNow(ctx), [`DTSTART:${icalUtc(day)}`, `DTEND:${icalUtc(day + HOUR)}`, `SUMMARY:${SUMMARY}`])]), evidence, 'create');
        const stored = await readRaw(ctx, temp, url, uid);
        const event = stored.events[0];
        const alarms = event === undefined ? [] : comps(event, 'VALARM');
        const defaultAlarm = event !== undefined && [event, ...alarms].some((c) => c.properties.some((p) => p.name === 'X-APPLE-DEFAULT-ALARM'));
        Object.assign(evidence, {
            readBackStatus: stored.status, valarms: alarms.length, defaultAlarmProperty: defaultAlarm,
            addedPropertyNames: safeNames(event === undefined ? [] : event.properties.map((p) => p.name).filter((n) => !sentNames.includes(n)), ctx.taint),
        });
        if (stored.status !== 200) {
            return { outcome: 'inconclusive', summary: prose`The event could not be read back (HTTP ${stored.status}).`, evidence };
        }
        return alarms.length === 0 && !defaultAlarm
            ? { outcome: 'confirmed', summary: prose`The stored event has no alarm.`, evidence }
            : { outcome: 'refuted', summary: prose`The stored event gained ${alarms.length} VALARM(s) or a default-alarm property.`, evidence };
    },
};

export const endOrderCheck: CheckDef = {
    id: 'write-end-order',
    planItem: `${PLAN_3A} (P3A-7): end equal to or before start`,
    claim: 'iCloud accepts a timed event whose end equals its start, and refuses one whose end is before its start in the same zone and one whose end is before its start only as an instant (different zones).',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const day = Date.UTC(2027, 0, 15);
        // 10:00 New York is 15:00Z and 11:00 Berlin is 10:00Z in January: the end text is later, the end instant earlier.
        const cases = [
            { key: 'equal', suffix: 'p3a7equal', lines: [`DTSTART:${icalUtc(day + 15 * HOUR)}`, `DTEND:${icalUtc(day + 15 * HOUR)}`], expectAccept: true },
            { key: 'sameZoneBefore', suffix: 'p3a7before', lines: [`DTSTART;TZID=${NY}:${icalLocal(day + 11 * HOUR)}`, `DTEND;TZID=${NY}:${icalLocal(day + 10 * HOUR)}`], expectAccept: false },
            { key: 'instantBefore', suffix: 'p3a7cross', lines: [`DTSTART;TZID=${NY}:${icalLocal(day + 10 * HOUR)}`, `DTEND;TZID=Europe/Berlin:${icalLocal(day + 11 * HOUR)}`], expectAccept: false },
        ];
        const evidence: Evidence = { endInstantBeforeStartInCrossCase: wallToInstant(day + 11 * HOUR, 60) < wallToInstant(day + 10 * HOUR, easternOffset(day + 10 * HOUR)) };
        let asClaimed = 0;
        let unanswered = 0;
        for (const c of cases) {
            const { url, uid } = newEvent(temp, c.suffix);
            const put = await tryWrite(ctx, url, calendarText([vevent(uid, stampNow(ctx), [...c.lines, `SUMMARY:${SUMMARY}`])]), evidence, c.key);
            const status = evidence[`${c.key}PutStatus`];
            if (put !== undefined) {
                const stored = await readRaw(ctx, temp, url, uid);
                const event = stored.events[0];
                const sentEnd = c.lines[1]?.split(':').at(-1);
                Object.assign(evidence, {
                    [`${c.key}ReadBackStatus`]: stored.status,
                    [`${c.key}StoredEndAsSent`]: event !== undefined && prop(event, 'DTEND')?.value === sentEnd,
                    [`${c.key}StoredDtend`]: dateShape(event === undefined ? undefined : prop(event, 'DTEND')?.value),
                });
            } else if (typeof status === 'number' && !isRefusal(status)) {
                unanswered++;
            }
            asClaimed += (put !== undefined) === c.expectAccept && (put !== undefined || (typeof status === 'number' && isRefusal(status))) ? 1 : 0;
        }
        evidence.asClaimed = asClaimed;
        if (unanswered > 0) {
            return { outcome: 'inconclusive', summary: prose`${unanswered} write(s) were answered neither 2xx nor 4xx.`, evidence };
        }
        return asClaimed === cases.length
            ? { outcome: 'confirmed', summary: prose`The equal-end event was accepted and both end-before-start events were refused.`, evidence }
            : { outcome: 'refuted', summary: prose`${asClaimed} of ${cases.length} cases were answered as claimed (each status is recorded).`, evidence };
    },
};

export const deleteSemanticsCheck: CheckDef = {
    id: 'write-delete-semantics',
    planItem: `${PLAN_3A} (P3A-8): a repeated DELETE with the same If-Match (the delete retry row)`,
    claim: 'A DELETE with the exact If-Match answers 204, and the same DELETE repeated answers 404 (not 412).',
    needs: 'temp',
    async run(ctx) {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'p3a8delete');
        const day = baseDay(ctx) + 33 * DAY + 15 * HOUR;
        const evidence: Evidence = {};
        const put = await writeOrStop(ctx, url, calendarText([vevent(uid, stampNow(ctx), [`DTSTART:${icalUtc(day)}`, `DTEND:${icalUtc(day + HOUR)}`, `SUMMARY:${SUMMARY}`])]), evidence, 'create');
        const etag = put.etag ?? (await propfindEtag(ctx, url));
        if (etag === null) {
            throw new CheckStop('inconclusive', prose`No ETag was available for the event.`, evidence);
        }
        const first = await deleteEvent(ctx, url, etag);
        const second = await deleteEvent(ctx, url, etag);
        Object.assign(evidence, { firstDeleteStatus: first, secondDeleteStatus: second });
        if (!isOk(first)) {
            return { outcome: 'inconclusive', summary: prose`The first DELETE answered HTTP ${first}.`, evidence };
        }
        if (second === 404) {
            return { outcome: 'confirmed', summary: prose`The first DELETE answered HTTP ${first} and the repeated one 404.`, evidence };
        }
        return { outcome: isOk(second) || isRefusal(second) ? 'refuted' : 'inconclusive', summary: prose`The repeated DELETE answered HTTP ${second}.`, evidence };
    },
};

// ---- P3A-9: series created by create_event --------------------------------------------------

interface SeriesCase { key: string; suffix: string; lines: readonly string[]; expected: number | null }

/** Fixed dates in January 2027 (a Monday is 2027-01-04). */
function seriesCases(): SeriesCase[] {
    const day = (d: number): number => Date.UTC(2027, 0, d);
    const tzUntil = day(6) + 10 * HOUR;
    const fourth = wallToInstant(tzUntil + 21 * DAY, easternOffset(tzUntil + 21 * DAY));
    return [
        { key: 'tzidWeeklyByday', suffix: 'p3a9tzweekly', lines: [`DTSTART;TZID=${NY}:${icalLocal(day(5) + 10 * HOUR)}`, `DTEND;TZID=${NY}:${icalLocal(day(5) + 11 * HOUR)}`, 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6'], expected: 6 },
        { key: 'tzidUntilUtc', suffix: 'p3a9tzuntil', lines: [`DTSTART;TZID=${NY}:${icalLocal(tzUntil)}`, `DTEND;TZID=${NY}:${icalLocal(tzUntil + HOUR)}`, `RRULE:FREQ=WEEKLY;UNTIL=${icalUtc(fourth + HOUR)}`], expected: 4 },
        { key: 'dateMonthlyUntil', suffix: 'p3a9datemon', lines: [`DTSTART;VALUE=DATE:${icalDate(day(15))}`, `DTEND;VALUE=DATE:${icalDate(day(16))}`, `RRULE:FREQ=MONTHLY;UNTIL=${icalDate(Date.UTC(2027, 3, 15))}`], expected: 4 },
        { key: 'floatingDailyInterval', suffix: 'p3a9fltdaily', lines: [`DTSTART:${icalLocal(day(7) + 9 * HOUR)}`, `DTEND:${icalLocal(day(7) + 10 * HOUR)}`, 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=5'], expected: 5 },
        { key: 'nonsense', suffix: 'p3a9nonsense', lines: [`DTSTART:${icalUtc(day(4) + 15 * HOUR)}`, `DTEND:${icalUtc(day(4) + 16 * HOUR)}`, 'RRULE:FREQ=WEEKLY;BYMONTHDAY=31;BYDAY=MO'], expected: null },
    ];
}

export const rruleCreateCheck: CheckDef = {
    id: 'write-rrule-create',
    planItem: `${PLAN_3A} (P3A-9): series created with an RRULE`,
    claim: 'A TZID weekly BYDAY=TU;COUNT=6 series, a TZID weekly series with a UTC UNTIL, a DATE monthly series with a DATE UNTIL and a floating daily INTERVAL=2;COUNT=5 series are accepted and expand to 6, 4, 4 and 5 instances (the nonsense rule FREQ=WEEKLY;BYMONTHDAY=31;BYDAY=MO is recorded, not judged).',
    needs: 'temp',
    async run(ctx): Promise<CheckOutput> {
        const temp = primary(ctx);
        const cases = seriesCases();
        const evidence: Evidence = {};
        const urls = new Map<string, string>();
        for (const c of cases) {
            const { url, uid } = newEvent(temp, c.suffix);
            const put = await tryWrite(ctx, url, calendarText([vevent(uid, stampNow(ctx), [...c.lines, `SUMMARY:${SUMMARY}`])]), evidence, c.key);
            if (put !== undefined) {
                urls.set(c.key, url);
            } else if (c.expected === null) {
                evidence.nonsenseDisposition = fixed(isRefusal(Number(evidence.nonsensePutStatus)) ? 'refused' : 'unread');
            }
        }
        const valid = cases.filter((c) => c.expected !== null);
        // Only a 4xx is a refusal; any other failure leaves that series unanswered.
        const refused = valid.filter((c) => !urls.has(c.key) && isRefusal(Number(evidence[`${c.key}PutStatus`]))).length;
        const unanswered = valid.filter((c) => !urls.has(c.key)).length - refused;
        const got = urls.size === 0 ? new Map<string, Expanded>() : await expandAll(ctx, temp, [...urls.values()], Date.UTC(2027, 0, 1), Date.UTC(2027, 4, 1));
        let matches = 0;
        let unread = unanswered;
        let wrong = 0;
        for (const c of cases) {
            const url = urls.get(c.key);
            const result = url === undefined ? undefined : got.get(url);
            if (url === undefined) {
                continue;
            }
            Object.assign(evidence, describeExpanded(c.key, result));
            const readable = result?.status === 207 && (!result.returned || expanded(result));
            const count = result?.returned === true ? result.events.length : 0;
            if (c.expected === null) {
                evidence.nonsenseDisposition = fixed(!readable ? 'unread' : count === 0 ? 'stored-no-instances' : count === 1 ? 'stored-one-instance' : 'stored-many-instances');
                continue;
            }
            evidence[`${c.key}Expected`] = c.expected;
            if (!readable || result?.returned !== true) {
                unread++;
                continue;
            }
            matches += count === c.expected ? 1 : 0;
            wrong += count === c.expected ? 0 : 1;
        }
        evidence.seriesAsClaimed = matches;
        if (matches === valid.length) {
            return { outcome: 'confirmed', summary: prose`All ${matches} valid series were accepted and expanded to the expected counts.`, evidence };
        }
        if (refused > 0 || wrong > 0) {
            return { outcome: 'refuted', summary: prose`${refused} valid series were refused and ${wrong} expanded to another count than expected.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`${unread} series could not be written or were not expanded by the server, so their counts cannot be read.`, evidence };
    },
};

export const WRITE_3A_CHECKS: CheckDef[] = [
    unknownZoneCheck, ianaZonesCheck, zoneChangeCheck, textRoundTripCheck, defaultAlarmsCheck, endOrderCheck, deleteSemanticsCheck, rruleCreateCheck,
];
