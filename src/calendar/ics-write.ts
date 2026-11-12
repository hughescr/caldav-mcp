/**
 * iCalendar serializer primitives for the write tools (phase 3 design v2 sections 4.1, 4.2, 6.2 and 6.4). Pure functions,
 * no I/O, no zone mapping, no date math and no VTIMEZONE generation.
 *
 * Injection safety rests on four rules:
 * - property, parameter and component names are code constants; client text is never a name;
 * - client TEXT is escaped (`\\`, `\;`, `\,`, line breaks as `\n`) and refused when it holds C0 controls other than TAB,
 *   CR and LF, DEL or lone surrogates; TZID is the only client parameter value and can never hold DQUOTE or `^`;
 * - time values are written only from validated digits, RRULE only after the strict grammar re-serialises it from parsed
 *   parts, and alarm offsets only after the exact duration grammar;
 * - every logical line is asserted free of CR and LF before it is folded at 75 octets on code-point boundaries, so no
 *   physical line ever splits a UTF-8 sequence (iCloud corrupts text folded inside one, probe Run 7).
 *
 * Every exported function either returns a complete value or throws {@link IcsWriteError}; no other exception and no
 * partially built string ever escapes. Written properties and components are frozen and registered, so the span editor
 * (`ics-edit.ts`) can tell a value this module produced from a forged one.
 */
import { isValidDateText, isValidLocalText } from './time-core';

// ---- Limits and constants ----

/** Physical line limit in octets, including the leading space of a continuation line (RFC 5545 section 3.1). */
export const MAX_LINE_OCTETS = 75;
/** Input caps in UTF-16 code units (design 6.5). */
export const TEXT_LIMITS = { SUMMARY: 1024, LOCATION: 2048, DESCRIPTION: 8192 } as const;
export const MAX_ZONE_LENGTH = 128;
export const MAX_RRULE_LENGTH = 512;
export const MAX_ALARMS = 10;
export const MAX_UID_LENGTH = 255;
export const MAX_SEQUENCE = 2_147_483_647;
export const PRODID = '-//caldav-mcp//EN';
/** The fixed DESCRIPTION of every alarm this server writes (design 4.2). */
export const ALARM_DESCRIPTION = 'Reminder';

// ---- Errors ----

export type IcsWriteErrorReason =
    | 'text_not_representable'
    | 'text_too_long'
    | 'zone_not_representable'
    | 'time_invalid'
    | 'time_form_not_allowed'
    | 'start_end_kind_mismatch'
    | 'uid_invalid'
    | 'enum_invalid'
    | 'sequence_invalid'
    | 'trigger_invalid'
    | 'too_many_alarms'
    | 'rrule_too_long'
    | 'rrule_syntax'
    | 'rrule_unknown_part'
    | 'rrule_duplicate_part'
    | 'rrule_value'
    | 'rrule_freq_missing'
    | 'rrule_until_count'
    | 'rrule_until_form'
    | 'line_invalid';

/**
 * A value that cannot be written. `field` names the create input field (`title`, `start`, `alarms`, …) when the failure
 * came from {@link buildCreateResource}, otherwise the property name; it never carries the offending text.
 */
export class IcsWriteError extends Error {
    constructor(public readonly reason: IcsWriteErrorReason, public readonly field: string | null = null) { super(reason); }
}

// ---- Written values ----

/** One logical content line produced by this module. Frozen and registered; build it only through the functions below. */
export interface WrittenProperty {
    /** Upper-case property name, a code constant. */
    readonly name: string;
    /** The unfolded logical line, without a line ending. */
    readonly line: string;
}

/** One whole component produced by this module: logical lines from `BEGIN` to `END`, without line endings. */
export interface WrittenComponent {
    readonly name: 'VALARM';
    readonly lines: readonly string[];
}

const writtenProperties = new WeakSet<object>();
const writtenComponents = new WeakSet<object>();

/** True only for a {@link WrittenProperty} this module produced; a copy or a hand-made object is false. */
export function isWrittenProperty(value: unknown): value is WrittenProperty {
    return typeof value === 'object' && value !== null && writtenProperties.has(value);
}

/** True only for a {@link WrittenComponent} this module produced. */
export function isWrittenComponent(value: unknown): value is WrittenComponent {
    return typeof value === 'object' && value !== null && writtenComponents.has(value);
}

function property(name: string, line: string): WrittenProperty {
    assertLogicalLine(line);
    const written: WrittenProperty = Object.freeze({ name, line });
    writtenProperties.add(written);
    return written;
}

// ---- Lines and folding ----

const NAME_RE = /^[A-Z][A-Z0-9-]*$/u;

/** Asserts a logical line is well-formed Unicode with a code-constant name and no CR or LF. */
function assertLogicalLine(line: string): void {
    if (typeof line !== 'string' || !line.isWellFormed() || /[\r\n]/u.test(line)) { throw new IcsWriteError('line_invalid'); }
    const nameEnd = line.search(/[;:]/u);
    if (nameEnd < 1 || !NAME_RE.test(line.slice(0, nameEnd))) { throw new IcsWriteError('line_invalid'); }
}

function codePointOctets(codePoint: number): number {
    return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/**
 * Folds one logical line into physical lines of at most 75 octets each, the leading space of a continuation included.
 * Cuts fall only between code points (never inside a UTF-8 sequence or a surrogate pair) and only when the next code point
 * would cross the limit. Returns the physical lines without line endings.
 */
export function foldLine(logical: string): string[] {
    if (typeof logical !== 'string' || !logical.isWellFormed() || /[\r\n]/u.test(logical)) { throw new IcsWriteError('line_invalid'); }
    const lines: string[] = [];
    let current = '';
    let used = 0;
    for (const character of logical) {
        const size = codePointOctets(character.codePointAt(0) ?? 0);
        if (used + size > MAX_LINE_OCTETS) {
            lines.push(current);
            current = ' ';
            used = 1;
        }
        current += character;
        used += size;
    }
    lines.push(current);
    return lines;
}

/** Folds every logical line and terminates every physical line with CRLF. */
export function serializeLines(logical: readonly string[]): string {
    const physical: string[] = [];
    for (const line of logical) {
        for (const part of foldLine(line)) { physical.push(part); }
    }
    return `${physical.join('\r\n')}\r\n`;
}

// ---- TEXT ----

// C0 controls other than TAB (09), LF (0A) and CR (0D), and DEL.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/**
 * RFC 5545 TEXT escaping (design 6.2): `\` to `\\`, `;` to `\;`, `,` to `\,`, each CRLF, CR or LF to `\n`; TAB is kept.
 * Lone surrogates, DEL and the other C0 controls are refused with `text_not_representable`. No Unicode normalisation:
 * bidi controls, C1 controls and U+2028/U+2029 pass through as text.
 */
export function escapeText(value: string, field: string | null = null): string {
    if (typeof value !== 'string' || !value.isWellFormed() || FORBIDDEN_TEXT_RE.test(value)) { throw new IcsWriteError('text_not_representable', field); }
    return value.replaceAll(/\r\n|[\r\n\\;,]/gu, match => (match === '\\' ? '\\\\' : match === ';' ? '\\;' : match === ',' ? '\\,' : '\\n'));
}

export type TextPropertyName = keyof typeof TEXT_LIMITS;

/** `SUMMARY`, `LOCATION` or `DESCRIPTION` with escaped client text, within the design 6.5 caps. */
export function textProperty(name: TextPropertyName, value: string, field: string | null = name): WrittenProperty {
    const limit = TEXT_LIMITS[name];
    if (typeof limit !== 'number') { throw new IcsWriteError('line_invalid', field); }
    const escaped = escapeText(value, field);
    if (value.length > limit) { throw new IcsWriteError('text_too_long', field); }
    return property(name, `${name}:${escaped}`);
}

// ---- Parameter values ----

// Every C0 control (TAB included), DEL, DQUOTE and the RFC 6868 caret.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_PARAMETER_RE = /[\u0000-\u001F\u007F"^]/u;

/**
 * The TZID parameter value as written (design 4.1, 6.2): 1–128 UTF-16 units of well-formed text without C0, DEL, DQUOTE or
 * `^`, DQUOTE-quoted when it holds `;`, `:` or `,`. A DQUOTE can never appear inside, so a value can never close its quote.
 */
export function quoteParameterValue(value: string, field: string | null = null): string {
    if (typeof value !== 'string' || value === '' || value.length > MAX_ZONE_LENGTH || !value.isWellFormed() || FORBIDDEN_PARAMETER_RE.test(value)) {
        throw new IcsWriteError('zone_not_representable', field);
    }
    return /[;:,]/u.test(value) ? `"${value}"` : value;
}

// ---- Times ----

/**
 * A validated time in basic iCalendar digits. Normalisation from the client's five input forms happens elsewhere
 * (`write-time.ts`); an offset arrives here already as the UTC instant. `floating` exists only for values copied in a
 * floating master's form (EXDATE, RECURRENCE-ID); a client time is never floating.
 */
export type IcsTime =
    | { kind: 'utc'; utc: string }
    | { kind: 'zoned'; local: string; tzid: string }
    | { kind: 'date'; date: string }
    | { kind: 'floating'; local: string };

export type StartForm = IcsTime['kind'];
export type TimePropertyName = 'DTSTART' | 'DTEND' | 'EXDATE' | 'RECURRENCE-ID' | 'DTSTAMP' | 'CREATED' | 'LAST-MODIFIED';

const STAMP_PROPERTIES: ReadonlySet<string> = new Set(['DTSTAMP', 'CREATED', 'LAST-MODIFIED']);
const FLOATING_ALLOWED: ReadonlySet<string> = new Set(['EXDATE', 'RECURRENCE-ID']);

const BASIC_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/u;
const BASIC_LOCAL_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/u;

function validBasicDate(text: string): boolean {
    const match = BASIC_DATE_RE.exec(text);
    return match !== null && isValidDateText(`${match[1]}-${match[2]}-${match[3]}`);
}

function validBasicLocal(text: string): boolean {
    const match = BASIC_LOCAL_RE.exec(text);
    return match !== null && isValidLocalText(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`);
}

function validBasicUtc(text: string): boolean {
    return text.endsWith('Z') && validBasicLocal(text.slice(0, -1));
}

/** `;TZID=…` or `;VALUE=DATE` and the value text, after validation. */
function timeParts(time: IcsTime, field: string | null): { parameters: string; value: string } {
    if (typeof time !== 'object' || time === null) { throw new IcsWriteError('time_invalid', field); }
    switch (time.kind) {
        case 'utc':
            if (typeof time.utc !== 'string' || !validBasicUtc(time.utc)) { throw new IcsWriteError('time_invalid', field); }
            return { parameters: '', value: time.utc };
        case 'zoned':
            if (typeof time.local !== 'string' || !validBasicLocal(time.local)) { throw new IcsWriteError('time_invalid', field); }
            return { parameters: `;TZID=${quoteParameterValue(time.tzid, field)}`, value: time.local };
        case 'date':
            if (typeof time.date !== 'string' || !validBasicDate(time.date)) { throw new IcsWriteError('time_invalid', field); }
            return { parameters: ';VALUE=DATE', value: time.date };
        case 'floating':
            if (typeof time.local !== 'string' || !validBasicLocal(time.local)) { throw new IcsWriteError('time_invalid', field); }
            return { parameters: '', value: time.local };
        default:
            throw new IcsWriteError('time_invalid', field);
    }
}

/**
 * A DATE or DATE-TIME property. Server stamps (`DTSTAMP`, `CREATED`, `LAST-MODIFIED`) must be UTC; floating is allowed only
 * for `EXDATE` and `RECURRENCE-ID` in a floating master's form. The form is checked before the digits.
 */
export function timeProperty(name: TimePropertyName, time: IcsTime, field: string | null = name): WrittenProperty {
    const kind = typeof time === 'object' && time !== null ? time.kind : undefined;
    if ((STAMP_PROPERTIES.has(name) && kind !== 'utc') || (kind === 'floating' && !FLOATING_ALLOWED.has(name))) {
        throw new IcsWriteError('time_form_not_allowed', field);
    }
    const { parameters, value } = timeParts(time, field);
    return property(name, `${name}${parameters}:${value}`);
}

// ---- UID, enums, SEQUENCE ----

const UID_RE = /^[A-Za-z0-9._~@+=-]+$/u;

/** A UID from the server's deterministic generator: 1–255 characters of `[A-Za-z0-9._~@+=-]`, no escaping ever needed. */
export function uidProperty(uid: string, field: string | null = 'UID'): WrittenProperty {
    if (typeof uid !== 'string' || uid.length > MAX_UID_LENGTH || !UID_RE.test(uid)) { throw new IcsWriteError('uid_invalid', field); }
    return property('UID', `UID:${uid}`);
}

export type EventStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
export type EventTransparency = 'OPAQUE' | 'TRANSPARENT';
const STATUSES: ReadonlySet<string> = new Set<EventStatus>(['CONFIRMED', 'TENTATIVE', 'CANCELLED']);
const TRANSPARENCIES: ReadonlySet<string> = new Set<EventTransparency>(['OPAQUE', 'TRANSPARENT']);

export function statusProperty(value: EventStatus, field: string | null = 'STATUS'): WrittenProperty {
    if (!STATUSES.has(value)) { throw new IcsWriteError('enum_invalid', field); }
    return property('STATUS', `STATUS:${value}`);
}

export function transparencyProperty(value: EventTransparency, field: string | null = 'TRANSP'): WrittenProperty {
    if (!TRANSPARENCIES.has(value)) { throw new IcsWriteError('enum_invalid', field); }
    return property('TRANSP', `TRANSP:${value}`);
}

/** `SEQUENCE:n` for an integer 0 ≤ n ≤ 2^31 − 1. */
export function sequenceProperty(value: number, field: string | null = 'SEQUENCE'): WrittenProperty {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SEQUENCE) { throw new IcsWriteError('sequence_invalid', field); }
    return property('SEQUENCE', `SEQUENCE:${String(value)}`);
}

// ---- Alarm offsets (design 6.4) ----

const ALARM_OFFSET_RE = /^P(?:(\d{1,4})W|(\d{1,4})D(?:T(?:(\d{1,4})H)?(?:(\d{1,4})M)?(?:(\d{1,4})S)?)?|T(?:(\d{1,4})H)?(?:(\d{1,4})M)?(?:(\d{1,4})S)?)$/u;

/**
 * The exact `before_start` grammar: `PnW`, `PnD[T…]` or `PT…` with 1–4 digit numbers in H, M, S order and at least one
 * number after `T`. Case-sensitive, unsigned. Returns the text unchanged, to be written as `TRIGGER:-<text>`.
 */
export function parseAlarmOffset(text: string, field: string | null = 'TRIGGER'): string {
    if (typeof text !== 'string') { throw new IcsWriteError('trigger_invalid', field); }
    const match = ALARM_OFFSET_RE.exec(text);
    if (match === null) { throw new IcsWriteError('trigger_invalid', field); }
    const afterT = text.indexOf('T');
    if (afterT !== -1 && !/\d/u.test(text.slice(afterT + 1))) { throw new IcsWriteError('trigger_invalid', field); }
    return text;
}

/** A display alarm `before_start` before the event start: ACTION:DISPLAY, DESCRIPTION:Reminder, TRIGGER:-<offset>. */
export function displayAlarm(beforeStart: string, field: string | null = 'TRIGGER'): WrittenComponent {
    const offset = parseAlarmOffset(beforeStart, field);
    const lines = Object.freeze(['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${ALARM_DESCRIPTION}`, `TRIGGER:-${offset}`, 'END:VALARM']);
    for (const line of lines) { assertLogicalLine(line); }
    const component: WrittenComponent = Object.freeze({ name: 'VALARM', lines });
    writtenComponents.add(component);
    return component;
}

// ---- RRULE (design 6.4) ----

export type RruleKey =
    | 'FREQ' | 'UNTIL' | 'COUNT' | 'INTERVAL' | 'BYSECOND' | 'BYMINUTE' | 'BYHOUR' | 'BYDAY'
    | 'BYMONTHDAY' | 'BYYEARDAY' | 'BYWEEKNO' | 'BYMONTH' | 'BYSETPOS' | 'WKST';

export interface RrulePart { readonly key: RruleKey; readonly value: string }
/** Parts in source order with canonical values. Semantics are iCloud's; the grammar is only lexical. */
export interface ParsedRrule { readonly parts: readonly RrulePart[] }

const FREQUENCIES: ReadonlySet<string> = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const WEEKDAYS: ReadonlySet<string> = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
const MAX_RRULE_LIST = 64;

/** A list of numbers: at most `digits` digits, inside min..max, sign allowed only when `signed`, zero only when min is 0. */
interface NumberRule { digits: number; min: number; max: number; signed: boolean }
const LIST_RULES: Readonly<Partial<Record<RruleKey, NumberRule>>> = {
    BYSECOND: { digits: 2, min: 0, max: 60, signed: false },
    BYMINUTE: { digits: 2, min: 0, max: 59, signed: false },
    BYHOUR: { digits: 2, min: 0, max: 23, signed: false },
    BYMONTHDAY: { digits: 2, min: 1, max: 31, signed: true },
    BYYEARDAY: { digits: 3, min: 1, max: 366, signed: true },
    BYWEEKNO: { digits: 2, min: 1, max: 53, signed: true },
    BYMONTH: { digits: 2, min: 1, max: 12, signed: false },
    BYSETPOS: { digits: 3, min: 1, max: 366, signed: true },
};
const SCALAR_RULES: Readonly<Partial<Record<RruleKey, NumberRule>>> = {
    INTERVAL: { digits: 4, min: 1, max: 1000, signed: false },
    COUNT: { digits: 5, min: 1, max: 10_000, signed: false },
};
const RRULE_KEYS: ReadonlySet<string> = new Set<RruleKey>([
    'FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST',
]);

/** Canonical decimal text of one bounded number, or null. A `+` sign is kept as written; `-0` and `+0` are never valid. */
function boundedNumber(text: string, rule: NumberRule): string | null {
    const match = (rule.signed ? /^([+-]?)(\d+)$/u : /^()(\d+)$/u).exec(text);
    if (match === null) { return null; }
    const digits = match[2] ?? '';
    if (digits.length > rule.digits) { return null; }
    const value = Number(digits);
    if (value < rule.min || value > rule.max) { return null; }
    return `${match[1] ?? ''}${String(value)}`;
}

function listItems(value: string): string[] | null {
    const items = value.split(',');
    if (items.length > MAX_RRULE_LIST || items.some(item => item === '')) { return null; }
    return items;
}

function byDay(item: string): string | null {
    const match = /^(?:([+-]?)(\d{1,2}))?([A-Z]{2})$/u.exec(item);
    if (match === null || !WEEKDAYS.has(match[3] ?? '')) { return null; }
    if (match[2] === undefined) { return match[3] ?? null; }
    const ordinal = Number(match[2]);
    if (ordinal < 1 || ordinal > 53) { return null; }
    return `${match[1] ?? ''}${String(ordinal)}${match[3] ?? ''}`;
}

const UNTIL_SHAPES: Readonly<Record<StartForm, RegExp>> = {
    date: /^\d{8}$/u,
    utc: /^\d{8}T\d{6}Z$/u,
    zoned: /^\d{8}T\d{6}Z$/u,
    floating: /^\d{8}T\d{6}$/u,
};

/** UNTIL form follows the start (RFC 5545: UTC when DTSTART is UTC or zoned, a DATE for a DATE start, floating digits for floating). */
function untilValue(value: string, startForm: StartForm, field: string | null): string {
    if (!/^\d{8}(?:T\d{6}Z?)?$/u.test(value)) { throw new IcsWriteError('rrule_value', field); }
    const shape = UNTIL_SHAPES[startForm];
    if (shape === undefined) { throw new IcsWriteError('rrule_until_form', field); }
    if (!shape.test(value)) { throw new IcsWriteError('rrule_until_form', field); }
    const valid = value.length === 8 ? validBasicDate(value) : value.endsWith('Z') ? validBasicUtc(value) : validBasicLocal(value);
    if (!valid) { throw new IcsWriteError('rrule_value', field); }
    return value;
}

function partValue(key: RruleKey, value: string, startForm: StartForm, field: string | null): string {
    const fail = (): never => { throw new IcsWriteError('rrule_value', field); };
    if (key === 'FREQ') { return FREQUENCIES.has(value) ? value : fail(); }
    if (key === 'WKST') { return WEEKDAYS.has(value) ? value : fail(); }
    if (key === 'UNTIL') { return untilValue(value, startForm, field); }
    const scalar = SCALAR_RULES[key];
    if (scalar !== undefined) { return boundedNumber(value, scalar) ?? fail(); }
    const items = listItems(value) ?? fail();
    if (key === 'BYDAY') { return items.map(item => byDay(item) ?? fail()).join(','); }
    const list = LIST_RULES[key] ?? fail();
    return items.map(item => boundedNumber(item, list) ?? fail()).join(',');
}

/**
 * Strict lexical RRULE grammar (design 6.4, ORCH S7). The text is at most 512 characters of `[A-Za-z0-9,;=+-]`, upper-cased,
 * then split into `KEY=VALUE` parts: each key from the RFC 5545 set at most once, `FREQ` required, `UNTIL` and `COUNT`
 * exclusive, numbers bounded, lists of at most 64 items, `UNTIL` in the form the start requires. No CR, LF, colon, quote or
 * any other breakout can pass the character set.
 */
export function parseRrule(text: string, startForm: StartForm, field: string | null = 'RRULE'): ParsedRrule {
    if (typeof text !== 'string') { throw new IcsWriteError('rrule_syntax', field); }
    if (text.length > MAX_RRULE_LENGTH) { throw new IcsWriteError('rrule_too_long', field); }
    // ASCII only before upper-casing, so no locale or special casing (U+0131, U+0130, ß) can manufacture a keyword.
    if (!/^[A-Za-z0-9,;=+-]+$/u.test(text)) { throw new IcsWriteError('rrule_syntax', field); }
    const seen = new Set<string>();
    const parts: RrulePart[] = [];
    for (const part of text.toUpperCase().split(';')) {
        const match = /^([A-Z]+)=([^=]*)$/u.exec(part);
        if (match === null) { throw new IcsWriteError('rrule_syntax', field); }
        const key = match[1] ?? '';
        if (!RRULE_KEYS.has(key)) { throw new IcsWriteError('rrule_unknown_part', field); }
        if (seen.has(key)) { throw new IcsWriteError('rrule_duplicate_part', field); }
        seen.add(key);
        parts.push({ key: key as RruleKey, value: match[2] ?? '' });
    }
    const canonical = parts.map(part => Object.freeze({ key: part.key, value: partValue(part.key, part.value, startForm, field) }));
    if (!seen.has('FREQ')) { throw new IcsWriteError('rrule_freq_missing', field); }
    if (seen.has('UNTIL') && seen.has('COUNT')) { throw new IcsWriteError('rrule_until_count', field); }
    return Object.freeze({ parts: Object.freeze(canonical) });
}

/** Re-serialises parsed parts, re-validating the result through {@link parseRrule}, so edited parts pass the same grammar. */
export function serializeRrule(rule: ParsedRrule, startForm: StartForm, field: string | null = 'RRULE'): string {
    if (typeof rule !== 'object' || rule === null || !Array.isArray(rule.parts)) { throw new IcsWriteError('rrule_syntax', field); }
    const text = rule.parts.map(part => `${String(part.key)}=${String(part.value)}`).join(';');
    return parseRrule(text, startForm, field).parts.map(part => `${part.key}=${part.value}`).join(';');
}

/** `RRULE:<canonical rule>` from client text or from parsed parts. */
export function rruleProperty(rule: string | ParsedRrule, startForm: StartForm, field: string | null = 'RRULE'): WrittenProperty {
    const text = typeof rule === 'string' ? serializeRrule(parseRrule(rule, startForm, field), startForm, field) : serializeRrule(rule, startForm, field);
    return property('RRULE', `RRULE:${text}`);
}

// ---- Create ----

/** Already validated create input (design 4.2); times are normalised by `write-time.ts`, `now` comes from an injected clock. */
export interface CreateEventInput {
    uid: string;
    /** Server clock as `YYYYMMDDTHHMMSSZ`, used for DTSTAMP, CREATED and LAST-MODIFIED. */
    now: string;
    title: string;
    start: IcsTime;
    end: IcsTime;
    location?: string | undefined;
    description?: string | undefined;
    status?: 'CONFIRMED' | 'TENTATIVE' | undefined;
    transparency?: EventTransparency | undefined;
    alarms?: readonly { before_start: string }[] | undefined;
    /** Client RRULE text; written only after the strict grammar. */
    rrule?: string | undefined;
}

const CREATE_STATUSES: ReadonlySet<string> = new Set(['CONFIRMED', 'TENTATIVE']);

/**
 * The complete VCALENDAR for `create_event`, CRLF line endings, folded. Property order is fixed: UID, DTSTAMP, CREATED,
 * LAST-MODIFIED, SEQUENCE:0, DTSTART, DTEND, RRULE, SUMMARY, LOCATION, DESCRIPTION, STATUS, TRANSP, then one VALARM per alarm.
 * No VTIMEZONE: a TZID is sent without one and iCloud adds it (ORCH S2). Every value is validated before any text is joined.
 */
export function buildCreateResource(input: CreateEventInput): string {
    if (typeof input !== 'object' || input === null) { throw new IcsWriteError('line_invalid'); }
    const startKind = typeof input.start === 'object' && input.start !== null ? input.start.kind : undefined;
    const endKind = typeof input.end === 'object' && input.end !== null ? input.end.kind : undefined;
    if (startKind === 'floating') { throw new IcsWriteError('time_form_not_allowed', 'start'); }
    if (endKind === 'floating') { throw new IcsWriteError('time_form_not_allowed', 'end'); }
    const lines: WrittenProperty[] = [
        uidProperty(input.uid, 'uid'),
        timeProperty('DTSTAMP', { kind: 'utc', utc: input.now }, 'now'),
        timeProperty('CREATED', { kind: 'utc', utc: input.now }, 'now'),
        timeProperty('LAST-MODIFIED', { kind: 'utc', utc: input.now }, 'now'),
        sequenceProperty(0),
        timeProperty('DTSTART', input.start, 'start'),
        timeProperty('DTEND', input.end, 'end'),
    ];
    if (startKind !== endKind) { throw new IcsWriteError('start_end_kind_mismatch', 'end'); }
    if (input.rrule !== undefined) { lines.push(rruleProperty(input.rrule, input.start.kind, 'rrule')); }
    lines.push(textProperty('SUMMARY', input.title, 'title'));
    if (input.location !== undefined) { lines.push(textProperty('LOCATION', input.location, 'location')); }
    if (input.description !== undefined) { lines.push(textProperty('DESCRIPTION', input.description, 'description')); }
    if (input.status !== undefined) {
        if (!CREATE_STATUSES.has(input.status)) { throw new IcsWriteError('enum_invalid', 'status'); }
        lines.push(statusProperty(input.status, 'status'));
    }
    if (input.transparency !== undefined) { lines.push(transparencyProperty(input.transparency, 'transparency')); }
    const alarms = input.alarms ?? [];
    if (!Array.isArray(alarms)) { throw new IcsWriteError('trigger_invalid', 'alarms'); }
    if (alarms.length > MAX_ALARMS) { throw new IcsWriteError('too_many_alarms', 'alarms'); }
    const alarmComponents = alarms.map(alarm => displayAlarm(typeof alarm === 'object' && alarm !== null ? alarm.before_start : '', 'alarms'));

    return serializeLines([
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        `PRODID:${PRODID}`,
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        ...lines.map(line => line.line),
        ...alarmComponents.flatMap(component => component.lines),
        'END:VEVENT',
        'END:VCALENDAR',
    ]);
}
