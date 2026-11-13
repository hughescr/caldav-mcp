/**
 * Occurrence identity for the occurrence scopes (phase 3 design v2 section 3.2, ORCH B3 and ORCH-R; probe Run 7). Pure: the
 * stored resource, iCloud's expanded instances and the client's token in, a target or a fixed refusal out. No recurrence
 * expansion, no zone conversion, no Date and no Temporal: every comparison is between texts, and the only arithmetic is on
 * values that are already on one zone-free axis (UTC instants from iCloud, or the pseudo-UTC digits of DATE and floating
 * values), as ORCH-R allows.
 *
 * The facts this rests on (Run 7): an unmoved instance's expanded RECURRENCE-ID is the UTC form (the true instant for UTC and
 * TZID series, the date at T000000Z for DATE series, the wall digits with Z for floating series) and its DTSTART is the slot
 * in the master's form (P3B-1); an instance with a stored override carries that override's RECURRENCE-ID in its STORED form
 * and its times verbatim (P3B-2, outcome (a), and P3B-6); an override whose RECURRENCE-ID copies an expanded DTSTART text
 * replaces exactly that instance, in a DST repeated or skipped hour too (P3B-1, P3B-4). So:
 * - an EXISTING override is the stored override whose RECURRENCE-ID has the token (`occ1_` for UTC, DATE and floating
 *   forms, `occ2_` for the TZID form); the expansion must show it, with its own DTSTART;
 * - a NEW override is allowed only for an instance the expansion shows unmoved (UTC-form RECURRENCE-ID, no
 *   X-RECURRENCE-EXCEPTION, no stored override with that token), and its slot is the instance's DTSTART in the master's
 *   form, which must agree with the token where the form allows a lexical check;
 * - anything else fails closed: two stored overrides with the token, an expanded override no stored one matches, a form
 *   that differs from the master's, an unrecognised zone, another unmoved instance at the same local time (a DST repeated
 *   hour in a sub-daily series), a stored override that already uses the slot's text.
 */
import type { IcsTime } from './ics-write';
import type { EventComponent, OriginalResource, StoredTime } from './model';
import { formatInstant, isRecognizedZone, parseRangeBoundary, storedTimeFromJcal, type ParsedOccurrenceId } from './time-core';
import type { WriteErrorReason } from './write-schemas';

export type OccurrenceTargetCode = 'not_found' | 'occurrence_identity_unprovable' | 'unsupported_calendar_data' | 'edit_not_supported';

/** A target that cannot be named safely. Carries a fixed code and reason, never calendar text. */
export class OccurrenceTargetError extends Error {
    constructor(public readonly code: OccurrenceTargetCode, public readonly reason?: WriteErrorReason) { super(code); }
}

const unprovable = (reason: WriteErrorReason): OccurrenceTargetError => new OccurrenceTargetError('occurrence_identity_unprovable', reason);

/** `YYYY-MM-DD[THH:MM:SS[Z]]` as basic digits without the Z. */
const basic = (text: string): string => text.replaceAll(/[-:Z]/gu, '');

/** A stored time as a writable value of the same form. */
export function slotOf(time: StoredTime): IcsTime {
    switch (time.kind) {
        case 'utc': return { kind: 'utc', utc: `${basic(time.utc)}Z` };
        case 'zoned': return { kind: 'zoned', local: basic(time.local), tzid: time.tzid };
        case 'date': return { kind: 'date', date: basic(time.date) };
        case 'floating': return { kind: 'floating', local: basic(time.local) };
    }
}

/** The same form and the same text (TZID text included). */
export function sameSlot(a: IcsTime, b: IcsTime): boolean {
    switch (a.kind) {
        case 'utc': return b.kind === 'utc' && a.utc === b.utc;
        case 'zoned': return b.kind === 'zoned' && a.local === b.local && a.tzid === b.tzid;
        case 'date': return b.kind === 'date' && a.date === b.date;
        case 'floating': return b.kind === 'floating' && a.local === b.local;
    }
}

/** The value has the master's form: the same kind and, when zoned, the identical TZID text. */
export function inMasterForm(slot: IcsTime, master: StoredTime): boolean {
    if (slot.kind !== master.kind) { return false; }
    return slot.kind !== 'zoned' || (master.kind === 'zoned' && slot.tzid === master.tzid);
}

/**
 * The slot a token names in the master's form when that needs no expansion: an `occ2_` token of the master's TZID; an
 * `occ1_` token of a UTC, DATE (at T000000Z) or floating master. Null for an `occ1_` token of a zoned master (the local
 * slot is iCloud's to say) and for any mismatch.
 */
export function lexicalSlot(master: StoredTime, token: ParsedOccurrenceId): IcsTime | null {
    if (token.kind === 'stored') {
        return master.kind === 'zoned' && master.tzid === token.tzid ? { kind: 'zoned', local: basic(token.local), tzid: token.tzid } : null;
    }
    switch (master.kind) {
        case 'utc': return { kind: 'utc', utc: token.serverForm };
        case 'date': return token.serverForm.endsWith('T000000Z') ? { kind: 'date', date: token.serverForm.slice(0, 8) } : null;
        case 'floating': return { kind: 'floating', local: token.serverForm.slice(0, 15) };
        case 'zoned': return null;
    }
}

export type ResolvedOccurrence =
    /** The stored override of this occurrence; `slot` is its RECURRENCE-ID as stored. `instance` is iCloud's view of it. */
    | { kind: 'existing'; override: EventComponent; slot: IcsTime; instance: EventComponent }
    /** An unmoved instance with no override; `slot` is its DTSTART in the master's form, from iCloud's expansion. */
    | { kind: 'new'; slot: IcsTime; instance: EventComponent };

/**
 * Names the occurrence a token denotes, from the stored resource and iCloud's expansion of the SAME version (the caller
 * checks href, UID and ETag). Throws {@link OccurrenceTargetError}.
 */
export function resolveOccurrence(original: OriginalResource, token: ParsedOccurrenceId, expanded: readonly EventComponent[]): ResolvedOccurrence {
    const stored = original.overrides.filter(override => override.recurrenceId?.token === token.id);
    if (stored.length > 1) { throw new OccurrenceTargetError('unsupported_calendar_data', 'stored_data_not_editable'); }
    const instance = expanded.find(component => component.recurrenceId?.token === token.id);
    if (instance === undefined) { throw new OccurrenceTargetError('not_found'); }
    const override = stored[0];
    if (override !== undefined) {
        // iCloud returns an overridden instance with the override's own times (P3B-2); anything else is not this override.
        if (override.recurrenceId === null || !sameSlot(slotOf(instance.start), slotOf(override.start))) { throw unprovable('override_not_matched'); }
        return { kind: 'existing', override, slot: slotOf(override.recurrenceId.time), instance };
    }
    // An occ2_ token names a stored override by its text; none matched.
    if (token.kind === 'stored') { throw unprovable('override_not_matched'); }
    const master = original.master;
    if (master === null) { throw new OccurrenceTargetError('edit_not_supported', 'occurrence_only_resource'); }
    const rid = instance.recurrenceId;
    if (rid === null || rid.raw.params.size > 0 || rid.time.kind !== 'utc' || instance.properties.has('x-recurrence-exception')) { throw unprovable('override_not_matched'); }
    const slot = slotOf(instance.start);
    const agrees = ((): boolean => {
        switch (master.start.kind) {
            case 'utc': return slot.kind === 'utc' && slot.utc === token.serverForm;
            case 'date': return slot.kind === 'date' && `${slot.date}T000000Z` === token.serverForm;
            case 'floating': return slot.kind === 'floating' && `${slot.local}Z` === token.serverForm;
            case 'zoned': return slot.kind === 'zoned' && slot.tzid === master.start.tzid;
        }
    })();
    if (!agrees) { throw unprovable('form_mismatch'); }
    if (slot.kind === 'zoned') {
        if (!isRecognizedZone(slot.tzid)) { throw unprovable('unrecognized_zone'); }
        // Two unmoved instances at the same local time (a repeated hour of a sub-daily series): the text cannot say which.
        const twins = expanded.filter(component => component !== instance && component.recurrenceId?.time.kind === 'utc' && sameSlot(slotOf(component.start), slot));
        if (twins.length > 0) { throw unprovable('shares_time_with_other_occurrence'); }
    }
    // A stored override already using this text matches no instance (iCloud hides it, P3C-4): adding a second is ambiguous.
    if (original.overrides.some(item => item.recurrenceId !== null && sameSlot(slotOf(item.recurrenceId.time), slot))) { throw unprovable('override_exists_unmatched'); }
    return { kind: 'new', slot, instance };
}

// ---- Splits (design 3.5): the split point, UNTIL, the side of each exception, COUNT from the expansion ----

/** `YYYYMMDDTHHMMSSZ` as nanoseconds on its own axis (UTC, or the pseudo-UTC axis of DATE and floating values). */
function axisNs(serverForm: string): bigint | null {
    const text = `${serverForm.slice(0, 4)}-${serverForm.slice(4, 6)}-${serverForm.slice(6, 8)}T${serverForm.slice(9, 11)}:${serverForm.slice(11, 13)}:${serverForm.slice(13, 15)}Z`;
    return parseRangeBoundary(text)?.instantNs ?? null;
}

/**
 * The split point on iCloud's axis: the `occ1_` token (an expanded UTC-form RECURRENCE-ID). Null for an `occ2_` token: a
 * changed occurrence of a zoned series has no UTC instant in iCloud's text, and none is computed here.
 */
export function splitPoint(token: ParsedOccurrenceId): string | null {
    return token.kind === 'server' ? token.serverForm : null;
}

/**
 * UNTIL for the part before the split: the split point minus one second, zone-free (ORCH-R), written as RFC 5545 requires
 * for the master's form: UTC for UTC and zoned masters, floating digits for floating, the date for DATE masters.
 */
export function untilBefore(point: string, masterKind: StoredTime['kind']): string {
    const ns = axisNs(point);
    const text = ns === null ? null : formatInstant(ns - 1_000_000_000n);
    if (text === null) { throw new OccurrenceTargetError('edit_not_supported', 'rrule_not_editable'); }
    const digits = `${basic(text)}Z`;
    return masterKind === 'date' ? digits.slice(0, 8) : masterKind === 'floating' ? digits.slice(0, 15) : digits;
}

/** A zoned value this close to the split slot on the civil axis is unprovable: a DST overlap could reorder them. */
const GUARD_NS = 3n * 3600n * 1_000_000_000n;

export type Side = 'before' | 'after' | 'unprovable';

/**
 * Which side of the split a RECURRENCE-ID or EXDATE value lies on, by text only. A UTC-form value is compared with the split
 * point on iCloud's axis (the expanded UTC form of every master kind, and a stored UTC value). A DATE value of a DATE master
 * and a floating value of a floating master are on the same pseudo-UTC axis as the point. A zoned value of the master's TZID
 * is compared with the split slot's local digits when that slot is zoned, refusing within 3 hours. Anything else is
 * unprovable. `after` includes the split point itself.
 */
export function sideOf(value: StoredTime, master: StoredTime, point: string, slot: IcsTime): Side {
    const compare = (key: string): Side => (key < point ? 'before' : 'after');
    switch (value.kind) {
        case 'utc': return compare(`${basic(value.utc)}Z`);
        case 'date': return master.kind === 'date' ? compare(`${basic(value.date)}T000000Z`) : 'unprovable';
        case 'floating': return master.kind === 'floating' ? compare(`${basic(value.local)}Z`) : 'unprovable';
        case 'zoned': {
            if (master.kind !== 'zoned' || value.tzid !== master.tzid || slot.kind !== 'zoned' || slot.tzid !== value.tzid) { return 'unprovable'; }
            const a = axisNs(`${basic(value.local)}Z`);
            const b = axisNs(`${slot.local}Z`);
            if (a === null || b === null) { return 'unprovable'; }
            if (a !== b && (a > b ? a - b : b - a) < GUARD_NS) { return 'unprovable'; }
            return a < b ? 'before' : 'after';
        }
    }
}

/** Every EXDATE value of a component, as stored times (a comma list gives several). Null when a value is unreadable. */
export function exdateValues(component: EventComponent): StoredTime[] | null {
    const values: StoredTime[] = [];
    for (const property of component.properties.get('exdate') ?? []) {
        const tzids = property.params.get('tzid');
        if (tzids !== undefined && tzids.length !== 1) { return null; }
        for (const value of property.values) {
            const time = typeof value === 'string' ? storedTimeFromJcal(property.type, value, tzids?.[0]) : null;
            if (time === null) { return null; }
            values.push(time);
        }
    }
    return values;
}

/**
 * How many occurrences of the series come before the split, counted from iCloud's expansion of [series start, split]
 * (never computed from the rule). Null when that count cannot be proven from the text: an EXDATE before the split (an
 * excluded instance still counts towards COUNT but is not in the expansion, and nothing proves it matches an instance), a
 * stored override before the split that the expansion does not show (an orphan, or not covered), or any value whose side
 * is unprovable.
 */
export function occurrencesBefore(original: OriginalResource, expanded: readonly EventComponent[], point: string, slot: IcsTime): number | null {
    const master = original.master;
    if (master === null) { return null; }
    const exdates = exdateValues(master);
    if (exdates === null) { return null; }
    for (const value of exdates) {
        if (sideOf(value, master.start, point, slot) !== 'after') { return null; }
    }
    const shown = new Set(expanded.flatMap(component => (component.recurrenceId?.token === null || component.recurrenceId === null ? [] : [component.recurrenceId.token])));
    for (const override of original.overrides) {
        if (override.recurrenceId === null) { return null; }
        const side = sideOf(override.recurrenceId.time, master.start, point, slot);
        if (side === 'unprovable') { return null; }
        if (side === 'before' && (override.recurrenceId.token === null || !shown.has(override.recurrenceId.token))) { return null; }
    }
    let count = 0;
    for (const component of expanded) {
        if (component.recurrenceId === null) { return null; }
        const side = sideOf(component.recurrenceId.time, master.start, point, slot);
        if (side === 'unprovable') { return null; }
        if (side === 'before') { count++; }
    }
    return count;
}

// ---- Series moves (design 3.6, ORCH-R): shifting by one UTC delta ----

/** `YYYYMMDDTHHMMSSZ` plus `deltaSeconds`, on the UTC axis only. Null outside 0001-9999. */
export function shiftUtc(utc: string, deltaSeconds: bigint): string | null {
    const ns = axisNs(utc);
    const text = ns === null ? null : formatInstant(ns + deltaSeconds * 1_000_000_000n);
    return text === null ? null : `${basic(text)}Z`;
}

/** New minus old, in seconds, when both are UTC instants; null otherwise (a zoned, DATE or floating value needs no guess). */
export function utcDelta(from: IcsTime, to: IcsTime): bigint | null {
    if (from.kind !== 'utc' || to.kind !== 'utc') { return null; }
    const a = axisNs(from.utc);
    const b = axisNs(to.utc);
    return a === null || b === null ? null : (b - a) / 1_000_000_000n;
}
