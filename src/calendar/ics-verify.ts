/**
 * Independent intent gate for the write path (security review finding 3). The write path calls {@link verifyEditOutcome}
 * (or {@link verifyCreateOutcome}) immediately before every PUT, with an expectation it derives from the REQUEST, never from
 * the editor's report. `ics-edit.ts`'s `verifyUntouched` proves that untouched lines are preserved; it trusts the editor
 * for what changed. This module checks what changed.
 *
 * Independence: nothing here imports `ics-edit.ts` or `ics-write.ts`. Both texts are parsed with `parseOriginalResource`
 * (the project's only parser; never ICAL.parse directly) for decoded values, and with this file's own logical-line reader for
 * structure, multiplicity, order, duplicate parameters (which ical.js collapses) and nested components (which the parser
 * only counts). The two readings must agree, else `structure_mismatch`.
 *
 * What "unchanged" means, precisely:
 * - calendar-level properties: the same logical lines (unfolded text), in the same order;
 * - every component other than the targets (one, or several distinct ones checked in the same single pass), the removed
 *   override and the added override (other VEVENTs, VTIMEZONEs, VTODOs, unknown components, with everything nested in
 *   them): the same logical lines in the same order, and in the same order relative to each other;
 * - each target's other direct properties (every name the expectation does not name): the same logical lines in the same
 *   relative order (names, parameters, values, multiplicity), and per name deep-equal decoded properties. Order-insensitive
 *   only where the editor may legally place a line: an expected property, a removed companion and an added EXDATE may sit
 *   anywhere among the direct properties; replaced alarms and an added override's lines are compared as multisets.
 * - the target's nested components: identical, except VALARMs as the alarm expectation says.
 * Folding is not compared (physical lines are `verifyUntouched`'s job); line text is compared after unfolding.
 *
 * Hard rules, whatever the expectation says (checked first):
 * - no ATTENDEE or ORGANIZER logical line in any component unless the before-text held the identical line in the same
 *   component (name matched case-insensitively after unfolding, group prefixes such as `a.ATTENDEE` included); a new
 *   component may hold none;
 * - no new ATTACH (an added override may hold only identical copies of the master's);
 * - no VALARM whose ACTION is not exactly DISPLAY unless the identical VALARM was there before in the same component (an
 *   added override may copy the master's).
 *
 * Linear in the size of both texts, however many targets. Failures carry a fixed reason and, at most, a property name taken from the expectation;
 * never resource text.
 */
import { parseOriginalResource, type ParseOptions } from './ical';
import { BudgetError, type EventComponent, type JCalValue, type OriginalResource, type RawProperty } from './model';

/** The parser's work charge, named through the parser so this module's imports stay the parser and the model. */
type ResourceWork = NonNullable<ParseOptions['work']>;

// ---- Expectations ----

/** A decoded property value as `parseOriginalResource` reports it. */
export interface ExpectedValue {
    /** jCal value type: `text`, `date-time`, `date`, `integer`, `duration`, `uri`, … (VALUE=DATE becomes `date`). */
    readonly type: string;
    /** Decoded jCal values: TEXT unescaped (a written CR LF or CR reads back as LF), times as `YYYY-MM-DDTHH:MM:SS[Z]`. */
    readonly values: readonly JCalValue[];
    /** The exact parameter set other than VALUE, lower-case names. Omitted means no parameters. */
    readonly params?: Readonly<Record<string, readonly string[]>> | undefined;
}

/** One intended property: exactly one occurrence with this value afterwards. */
export interface ExpectedProperty extends ExpectedValue {
    /** Property name, case-insensitive. Never RRULE (use `rrule`), EXDATE (use `exdates`), identity or scheduling names. */
    readonly name: string;
}

export type PropertyExpectation = ExpectedProperty | { readonly name: string; readonly absent: true };

/** The Apple companions removed with LOCATION and DESCRIPTION; each listed one must be absent afterwards. */
export type Companion = 'X-APPLE-STRUCTURED-LOCATION' | 'X-ALT-DESC';

/** One display alarm as the writer produces it: ACTION:DISPLAY, DESCRIPTION, TRIGGER and nothing else. */
export interface ExpectedAlarm {
    /** The whole TRIGGER value, e.g. `-PT15M`. Compared exactly; TRIGGER must have no parameters. */
    readonly trigger: string;
    /** The decoded DESCRIPTION text. */
    readonly description: string;
}

export type AlarmExpectation =
    | { readonly kind: 'unchanged' }
    /** Every old VALARM gone; exactly these DISPLAY alarms, in any order. */
    | { readonly kind: 'replaced'; readonly alarms: readonly ExpectedAlarm[] }
    | { readonly kind: 'removed' };

export type ExdateExpectation =
    /** Every EXDATE line of before is kept (same text, same relative order); exactly these are added. */
    | { readonly kind: 'added'; readonly values: readonly ExpectedValue[] }
    | { readonly kind: 'removed_all' }
    /** None of before's EXDATE lines is left; exactly these lines (one decoded property each, any order) are present. */
    | { readonly kind: 'replaced'; readonly lines: readonly ExpectedValue[] };

/** The master VEVENT, or the override whose unfolded RECURRENCE-ID logical line equals `recurrenceId` exactly. */
export type TargetSelector = { readonly kind: 'master' } | { readonly kind: 'override'; readonly recurrenceId: string };

export interface TargetExpectation {
    readonly component: TargetSelector;
    readonly properties?: readonly PropertyExpectation[] | undefined;
    readonly companionsRemoved?: readonly Companion[] | undefined;
    /** Omitted means unchanged. */
    readonly alarms?: AlarmExpectation | undefined;
    readonly exdates?: ExdateExpectation | undefined;
    /** Omitted: compared like any other property. `null`: absent afterwards. Text: one RRULE decoding to the same rule. */
    readonly rrule?: string | null | undefined;
    /**
     * Override targets only: the decoded RECURRENCE-ID the component has afterwards (a series move shifts it). Omitted:
     * unchanged. The target is found by its old RECURRENCE-ID text before and at the same position afterwards.
     */
    readonly recurrenceId?: ExpectedValue | undefined;
}

export interface AddedOverrideExpectation {
    /** The decoded RECURRENCE-ID of the new override; it must not exist before. */
    readonly recurrenceId: ExpectedValue;
    /** The written properties (DTSTART, DTEND, DTSTAMP, LAST-MODIFIED, SEQUENCE and the changes), or absences. */
    readonly properties: readonly PropertyExpectation[];
    readonly companionsRemoved?: readonly Companion[] | undefined;
    /** `copied`: exactly the master's VALARMs, line-identical. */
    readonly alarms: { readonly kind: 'copied' } | { readonly kind: 'replaced'; readonly alarms: readonly ExpectedAlarm[] } | { readonly kind: 'removed' };
    /**
     * The one narrow exception to "no new ATTENDEE/ORGANIZER" (set only when the grant includes calendar:invite): the new
     * override holds byte-equal copies of the master's ATTENDEE and ORGANIZER lines, every one of them and nothing else, as
     * an occurrence of a series with guests must (probe Run 8, I6). Without it a new override may hold none.
     */
    readonly schedulingCopied?: boolean | undefined;
}

/**
 * Derived by the caller from the request. Every other direct property of an added override must be a line-identical copy
 * of a master line, and every master line must be copied, except the names in {@link OVERRIDE_NOT_COPIED}, the expected
 * names and the removed companions (design 3.3).
 */
export interface EditExpectation {
    readonly target?: TargetExpectation | undefined;
    /**
     * Several targets checked in one verification (`edit_scope: "all"`): each names a distinct component, and each is checked
     * exactly like `target`. Exclusive with `target`.
     */
    readonly targets?: readonly TargetExpectation[] | undefined;
    readonly addOverride?: AddedOverrideExpectation | undefined;
    readonly removeOverride?: { readonly recurrenceId: string } | undefined;
    /** Several whole overrides removed (a split, a series move that drops its exceptions); combined with `removeOverride`. */
    readonly removeOverrides?: readonly { readonly recurrenceId: string }[] | undefined;
}

/**
 * `work`: makes the work charge for each parse of either text. When given, a BudgetError it throws (the invocation's shared
 * caps or its deadline) propagates out of the verify call unchanged: running out of budget is not a verdict about the text.
 */
export interface OutcomeOptions {
    readonly work?: (() => ResourceWork) | undefined;
}

export interface CreateExpectation {
    /** Every direct property of the one VEVENT except RRULE; nothing else may be present. */
    readonly properties: readonly ExpectedProperty[];
    readonly rrule?: string | undefined;
    readonly alarms: readonly ExpectedAlarm[];
    /** Default 0: the writer never generates a VTIMEZONE. */
    readonly vtimezoneCount?: number | undefined;
}

/** Master lines a new override never copies (design 3.3). */
export const OVERRIDE_NOT_COPIED: readonly string[] = ['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'DTSTART', 'DTEND', 'DURATION', 'DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE'];

// ---- Verdicts ----

export type OutcomeFailure =
    | 'expectation_invalid'
    | 'line_endings'
    | 'before_unparseable'
    | 'after_unparseable'
    | 'structure_mismatch'
    | 'identity_changed'
    | 'scheduling_added'
    | 'attachment_added'
    | 'alarm_action_added'
    | 'calendar_changed'
    | 'component_changed'
    | 'target_not_found'
    | 'property_mismatch'
    | 'property_changed'
    | 'companion_present'
    | 'rrule_mismatch'
    | 'exdate_mismatch'
    | 'alarms_mismatch'
    | 'override_mismatch'
    | 'unexpected_property';

/** `property` is an upper-case name from the expectation or a fixed label, never text from either resource. */
export type OutcomeVerdict = { ok: true } | { ok: false; reason: OutcomeFailure; property: string | null };

class Refusal extends Error {
    constructor(readonly reason: OutcomeFailure, readonly property: string | null = null) { super(reason); }
}

const refuse = (reason: OutcomeFailure, property: string | null = null): never => { throw new Refusal(reason, property); };

function verdictOf(run: () => void): OutcomeVerdict {
    try {
        run();
        return { ok: true };
    } catch (error) {
        if (error instanceof Refusal) { return { ok: false, reason: error.reason, property: error.property }; }
        // Only `parse` lets one through, and only from the caller's own budget (OutcomeOptions).
        if (error instanceof BudgetError) { throw error; }
        // Anything else is a malformed expectation reaching code that assumed its shape.
        return { ok: false, reason: 'expectation_invalid', property: null };
    }
}

// ---- Logical lines and components (this module's own reader) ----

interface VLine {
    /** Unfolded logical line. */
    readonly text: string;
    /** Upper-case name as written, group prefix included. */
    readonly name: string;
    /** Upper-case name without a group prefix, trimmed: what the hard rules match. */
    readonly bareName: string;
    readonly paramNames: readonly string[];
    readonly value: string;
}

interface VNode {
    readonly name: string;
    readonly begin: number;
    end: number;
    readonly direct: number[];
    readonly children: VNode[];
}

interface Doc {
    readonly lines: readonly VLine[];
    readonly root: VNode;
}

/** Name, parameter names and value of one unfolded line; DQUOTE-aware, like RFC 5545. Null when malformed. */
function splitLine(text: string): { name: string; paramNames: string[]; value: string } | null {
    let index = 0;
    while (index < text.length && text[index] !== ';' && text[index] !== ':') {
        if (text[index] === '"') { return null; }
        index++;
    }
    if (index === 0 || index >= text.length) { return null; }
    const name = text.slice(0, index);
    const paramNames: string[] = [];
    while (text[index] === ';') {
        index++;
        const start = index;
        while (index < text.length && text[index] !== '=' && text[index] !== ';' && text[index] !== ':') { index++; }
        if (text[index] !== '=' || index === start) { return null; }
        paramNames.push(text.slice(start, index).toLowerCase());
        index++;
        for (;;) {
            if (text[index] === '"') {
                const close = text.indexOf('"', index + 1);
                if (close === -1) { return null; }
                index = close + 1;
            } else {
                while (index < text.length && text[index] !== ',' && text[index] !== ';' && text[index] !== ':') {
                    if (text[index] === '"') { return null; }
                    index++;
                }
            }
            if (text[index] === ',') { index++; continue; }
            break;
        }
    }
    if (text[index] !== ':') { return null; }
    return { name, paramNames, value: text.slice(index + 1) };
}

function bare(name: string): string {
    return name.slice(name.lastIndexOf('.') + 1).trim().toUpperCase();
}

function readDoc(text: string, unparseable: OutcomeFailure): Doc {
    const physical = text.split(/\r?\n/u);
    if (physical.at(-1) === '') { physical.pop(); }
    const groups: string[] = [];
    for (const part of physical) {
        if (part === '') { refuse('structure_mismatch'); }
        const first = part.charCodeAt(0);
        if (first === 0x20 || first === 0x09) {
            if (groups.length === 0) { refuse(unparseable); }
            groups[groups.length - 1] += part.slice(1);
        } else {
            groups.push(part);
        }
    }
    const lines: VLine[] = groups.map(logical => {
        const split = splitLine(logical);
        if (split === null) { return refuse(unparseable); }
        return { text: logical, name: split.name.toUpperCase(), bareName: bare(split.name), paramNames: split.paramNames, value: split.value };
    });
    let root: VNode | null = null;
    const stack: VNode[] = [];
    for (const [index, line] of lines.entries()) {
        if (line.name === 'BEGIN' || line.name === 'END') {
            if (line.paramNames.length > 0) { refuse('structure_mismatch'); }
            const component = line.value.toUpperCase();
            if (line.name === 'BEGIN') {
                const parent = stack.at(-1);
                if (parent === undefined && root !== null) { refuse('structure_mismatch'); }
                const node: VNode = { name: component, begin: index, end: -1, direct: [], children: [] };
                if (parent === undefined) { root = node; } else { parent.children.push(node); }
                stack.push(node);
            } else {
                const node = stack.pop();
                if (node === undefined || node.name !== component) { return refuse('structure_mismatch'); }
                node.end = index;
            }
            continue;
        }
        const owner = stack.at(-1);
        if (owner === undefined) { return refuse('structure_mismatch'); }
        owner.direct.push(index);
    }
    if (root === null || stack.length > 0 || (root as VNode).name !== 'VCALENDAR') { return refuse('structure_mismatch'); }
    return { lines, root };
}

function lineAt(doc: Doc, index: number): VLine {
    return doc.lines[index] ?? refuse('structure_mismatch');
}

/** The logical lines of a whole component, BEGIN to END. */
function blockOf(doc: Doc, node: VNode): string[] {
    const block: string[] = [];
    for (let index = node.begin; index <= node.end; index++) { block.push(lineAt(doc, index).text); }
    return block;
}

const blockKey = (block: readonly string[]): string => JSON.stringify(block);

function directWithName(doc: Doc, node: VNode, name: string): VLine[] {
    return node.direct.map(index => lineAt(doc, index)).filter(line => line.name === name);
}

/** RFC 5545 TEXT unescaping, as the local parser applies it; this module's own copy. */
function decodeText(value: string): string {
    return value.replaceAll(/\\\\|\\;|\\,|\\[Nn]/gu, match => (match === '\\\\' ? '\\' : match === '\\;' ? ';' : match === '\\,' ? ',' : '\n'));
}

// ---- Parsed values ----

/** Canonical JSON: object keys sorted, so two decodings of the same value compare equal whatever the source order. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) { return `[${value.map(canonical).join(',')}]`; }
    if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

function rawKey(property: RawProperty): string {
    const params = [...property.params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return canonical([property.name, property.type, property.values, params]);
}

function expectedKey(name: string, expected: ExpectedValue): string {
    const params = Object.entries(expected.params ?? {}).map(([key, values]) => [key.toLowerCase(), [...values]] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return canonical([name.toLowerCase(), expected.type, expected.values, params]);
}

function parse(text: string, failure: OutcomeFailure, options: OutcomeOptions): OriginalResource {
    try {
        return parseOriginalResource(text, options.work === undefined ? {} : { work: options.work() });
    } catch (error) {
        if (error instanceof BudgetError && options.work !== undefined) { throw error; }
        return refuse(failure);
    }
}

/** An RRULE text decoded by the same parser, through a minimal resource. Only the RRULE character set is accepted. */
function decodeRrule(text: unknown): string {
    if (typeof text !== 'string' || text.length === 0 || text.length > 512 || !/^[A-Za-z0-9,;=+-]+$/u.test(text) || /[\r\n]/u.test(text)) { return refuse('expectation_invalid', 'RRULE'); }
    const resource = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:rrule-probe', 'DTSTART:20000101T000000Z', `RRULE:${text.toUpperCase()}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    let parsed: OriginalResource;
    try { parsed = parseOriginalResource(resource, {}); } catch { return refuse('expectation_invalid', 'RRULE'); }
    const rule = parsed.master?.properties.get('rrule');
    if (rule?.length !== 1 || rule[0] === undefined) { return refuse('expectation_invalid', 'RRULE'); }
    return recurKey(rule[0]);
}

/** A recur value with every list part as an array, so `BYDAY=TU` and a one-item list compare equal. */
function recurKey(property: RawProperty): string {
    const normalised = property.values.map(value => (typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Array.isArray(item) ? item : [item]]))
        : value));
    return canonical([property.type, normalised, [...property.params.keys()].sort()]);
}

// ---- Agreement between the two readings ----

interface EventView {
    readonly node: VNode;
    readonly parsed: EventComponent;
    /** Unfolded RECURRENCE-ID line, or null for the master. */
    readonly rid: string | null;
}

interface Reading {
    readonly doc: Doc;
    readonly parsed: OriginalResource;
    readonly events: readonly EventView[];
    readonly master: EventView | null;
}

function read(text: string, unparseable: OutcomeFailure, options: OutcomeOptions): Reading {
    if (typeof text !== 'string') { return refuse(unparseable); }
    // A lone CR is a break to some readers and data to others; refuse it in either text.
    if (/\r(?!\n)/u.test(text)) { refuse('line_endings'); }
    const parsed = parse(text, unparseable, options);
    const doc = readDoc(text, unparseable);
    const veventNodes = doc.root.children.filter(child => child.name === 'VEVENT');
    const masters: VNode[] = [];
    const overrides: VNode[] = [];
    for (const node of veventNodes) { (directWithName(doc, node, 'RECURRENCE-ID').length === 0 ? masters : overrides).push(node); }
    if (masters.length !== (parsed.master === null ? 0 : 1) || overrides.length !== parsed.overrides.length) { refuse('structure_mismatch'); }
    if (doc.root.children.filter(child => child.name === 'VTIMEZONE').length !== parsed.vtimezoneCount) { refuse('structure_mismatch'); }
    const view = (node: VNode, component: EventComponent | null | undefined): EventView => {
        if (component === null || component === undefined) { return refuse('structure_mismatch'); }
        agree(doc, node, component);
        const rids = directWithName(doc, node, 'RECURRENCE-ID');
        return { node, parsed: component, rid: rids[0]?.text ?? null };
    };
    const master = masters[0] === undefined ? null : view(masters[0], parsed.master);
    const overrideViews = overrides.map((node, index) => view(node, parsed.overrides[index]));
    const byNode = new Map<VNode, EventView>([...(master === null ? [] : [[master.node, master] as const]), ...overrideViews.map(item => [item.node, item] as const)]);
    const events = veventNodes.map(node => byNode.get(node) ?? refuse('structure_mismatch'));
    return { doc, parsed, events, master };
}

/** The same direct property names with the same multiplicity, the same UID and the same VALARM count. */
function agree(doc: Doc, node: VNode, component: EventComponent): void {
    const counts = new Map<string, number>();
    for (const index of node.direct) {
        const name = lineAt(doc, index).name.toLowerCase();
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if (counts.size !== component.properties.size) { refuse('structure_mismatch'); }
    for (const [name, list] of component.properties) {
        if (counts.get(name) !== list.length) { refuse('structure_mismatch'); }
    }
    const uid = directWithName(doc, node, 'UID');
    if (uid.length !== 1 || decodeText(uid[0]?.value ?? '') !== component.uid) { refuse('structure_mismatch'); }
    if (node.children.filter(child => child.name === 'VALARM').length !== component.alarmCount) { refuse('structure_mismatch'); }
}

// ---- Hard rules ----

const SCHEDULING: ReadonlySet<string> = new Set(['ATTENDEE', 'ORGANIZER']);

/**
 * THE scheduling-name policy, shared by the hard rules here and the write path's attendee gate: a property name is ATTENDEE
 * or ORGANIZER after an optional group prefix (`item1.ATTENDEE`) is stripped, case-insensitively. Extension names such as
 * `X-ATTENDEE` are not scheduling properties.
 */
export function isSchedulingName(name: string): boolean {
    return SCHEDULING.has(bare(name));
}

/**
 * True when any content line anywhere in `text` (every component, nested or unknown wrappers included, after unfolding)
 * has a scheduling name by {@link isSchedulingName}. One linear pass over the text, no parser, so it also sees what a
 * parser skips. A line's name ends at its first `;` or `:`. Every CR, LF or CRLF counts as a line break and a continuation
 * without a line before it counts as a line of its own: an ambiguous text yields more candidate names, never fewer.
 */
export function hasSchedulingLine(text: string): boolean {
    const scheduling = (line: string | null): boolean => {
        if (line === null) { return false; }
        const delimiter = line.search(/[;:]/u);
        return isSchedulingName(delimiter === -1 ? line : line.slice(0, delimiter));
    };
    let logical: string | null = null;
    for (const physical of text.split(/\r\n|\n|\r/u)) {
        const continuation = physical.startsWith(' ') || physical.startsWith('\t');
        if (continuation && logical !== null) {
            logical += physical.slice(1);
            continue;
        }
        if (scheduling(logical)) { return true; }
        logical = physical === '' ? null : physical;
    }
    return scheduling(logical);
}
/** Names an expectation may never name: identity, structure, scheduling and attachments. */
const NEVER_EXPECTED: ReadonlySet<string> = new Set(['BEGIN', 'END', 'UID', 'RECURRENCE-ID', 'ATTENDEE', 'ORGANIZER', 'ATTACH']);

const MASTER_KEY = 'VEVENT master';
const OVERRIDE_PREFIX = 'VEVENT override ';
const overrideKey = (rid: string): string => `${OVERRIDE_PREFIX}${rid}`;

/**
 * Component keys, JSON `[top, path]`: `top` is the VEVENT's identity (master, or its RECURRENCE-ID text) or the name and
 * ordinal of another top-level component; `path` the names of the nesting below it. VALARMs of one VEVENT share a key.
 */
function componentKeys(reading: Reading): Map<VNode, string> {
    const keys = new Map<VNode, string>();
    const ordinals = new Map<string, number>();
    const eventByNode = new Map(reading.events.map(event => [event.node, event]));
    const walk = (node: VNode, top: string, path: string): void => {
        keys.set(node, JSON.stringify([top, path]));
        for (const child of node.children) { walk(child, top, `${path}/${child.name}`); }
    };
    keys.set(reading.doc.root, JSON.stringify(['VCALENDAR', '']));
    for (const child of reading.doc.root.children) {
        const event = eventByNode.get(child);
        let top: string;
        if (event !== undefined) {
            top = event.rid === null ? MASTER_KEY : overrideKey(event.rid);
        } else {
            const ordinal = ordinals.get(child.name) ?? 0;
            ordinals.set(child.name, ordinal + 1);
            top = `${child.name} #${String(ordinal)}`;
        }
        walk(child, top, '');
    }
    return keys;
}

interface Inventory {
    /** Per component key: multiset of scheduling lines, ATTACH lines and non-DISPLAY VALARM blocks. */
    readonly scheduling: Map<string, Map<string, number>>;
    readonly attach: Map<string, Map<string, number>>;
    readonly alarms: Map<string, Map<string, number>>;
}

function bump(map: Map<string, Map<string, number>>, key: string, item: string): void {
    let inner = map.get(key);
    if (inner === undefined) { inner = new Map(); map.set(key, inner); }
    inner.set(item, (inner.get(item) ?? 0) + 1);
}

function inventory(reading: Reading): Inventory {
    const result: Inventory = { scheduling: new Map(), attach: new Map(), alarms: new Map() };
    const keys = componentKeys(reading);
    const walk = (node: VNode): void => {
        const key = keys.get(node) ?? refuse('structure_mismatch');
        for (const index of node.direct) {
            const line = lineAt(reading.doc, index);
            if (isSchedulingName(line.name)) { bump(result.scheduling, key, line.text); }
            if (line.bareName === 'ATTACH') { bump(result.attach, key, line.text); }
        }
        for (const child of node.children) {
            if (child.name === 'VALARM' && !isDisplayAlarm(reading.doc, child)) { bump(result.alarms, key, blockKey(blockOf(reading.doc, child))); }
            walk(child);
        }
    };
    walk(reading.doc.root);
    return result;
}

/** Exactly one ACTION line, with no parameters and the value DISPLAY (case-insensitive, as RFC 5545 enumerations are). */
function isDisplayAlarm(doc: Doc, node: VNode): boolean {
    const actions = node.direct.map(index => lineAt(doc, index)).filter(line => line.bareName === 'ACTION');
    return actions.length === 1 && actions[0]?.name === 'ACTION' && actions[0].paramNames.length === 0 && actions[0].value.toUpperCase() === 'DISPLAY';
}

/** Every after item under a key must be in before under the same key, or under its entry in `extraSources` when it has one. */
function subset(after: Map<string, Map<string, number>>, before: Map<string, Map<string, number>>, reason: OutcomeFailure, label: string, extraSources: ReadonlyMap<string, string>): void {
    for (const [key, items] of after) {
        const source = extraSources.has(key) ? before.get(extraSources.get(key) ?? '') : before.get(key);
        for (const [item, count] of items) {
            if ((source?.get(item) ?? 0) < count) { refuse(reason, label); }
        }
    }
}

interface CopySources {
    /** An override VEVENT new in `after` may hold copies of the master's attachments and non-DISPLAY alarms. */
    readonly masterCopies: boolean;
    /** ... and of the master's scheduling lines (calendar:invite; AddedOverrideExpectation.schedulingCopied). */
    readonly schedulingCopies: boolean;
    /** Override tops renamed by a RECURRENCE-ID change: after top → before top (the same component, shifted). */
    readonly renamed: ReadonlyMap<string, string>;
}

const NO_COPIES: CopySources = { masterCopies: false, schedulingCopies: false, renamed: new Map() };

/**
 * Every scheduling line, attachment and non-DISPLAY alarm afterwards was already in the same component before. A renamed
 * override is the same component; a new override may copy the master's as `sources` allows. Scheduling lines of a new
 * override are allowed only with `schedulingCopies`; the added-override check then requires them to be exact copies.
 */
function hardRules(before: Reading | null, after: Reading, sources: CopySources): void {
    const empty: Inventory = { scheduling: new Map(), attach: new Map(), alarms: new Map() };
    const old = before === null ? empty : inventory(before);
    const now = inventory(after);
    const known = new Set(before === null ? [] : before.events.map(event => (event.rid === null ? MASTER_KEY : overrideKey(event.rid))));
    const sourcesFor = (map: Map<string, Map<string, number>>, fromMaster: boolean): Map<string, string> => {
        const copies = new Map<string, string>();
        for (const key of map.keys()) {
            const [top, path] = JSON.parse(key) as [string, string];
            const renamed = sources.renamed.get(top);
            if (renamed !== undefined) {
                copies.set(key, JSON.stringify([renamed, path]));
            } else if (fromMaster && before !== null && top.startsWith(OVERRIDE_PREFIX) && !known.has(top)) {
                copies.set(key, JSON.stringify([MASTER_KEY, path]));
            }
        }
        return copies;
    };
    subset(now.scheduling, old.scheduling, 'scheduling_added', 'ATTENDEE/ORGANIZER', sourcesFor(now.scheduling, sources.schedulingCopies));
    subset(now.attach, old.attach, 'attachment_added', 'ATTACH', sourcesFor(now.attach, sources.masterCopies));
    subset(now.alarms, old.alarms, 'alarm_action_added', 'VALARM', sourcesFor(now.alarms, sources.masterCopies));
}

// ---- Expectation checks ----

function upperName(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/u.test(value)) { return refuse('expectation_invalid', label); }
    return value.toUpperCase();
}

function validValue(expected: ExpectedValue, label: string): void {
    if (typeof expected !== 'object' || expected === null || typeof expected.type !== 'string' || !Array.isArray(expected.values)) { refuse('expectation_invalid', label); }
    const params = expected.params ?? {};
    if (typeof params !== 'object' || params === null) { refuse('expectation_invalid', label); }
    for (const [key, values] of Object.entries(params)) {
        if (key.toLowerCase() === 'value' || !Array.isArray(values) || !values.every(item => typeof item === 'string')) { refuse('expectation_invalid', label); }
    }
}

interface PropertyPlan {
    readonly expected: Map<string, ExpectedProperty | null>;
    readonly companions: Set<string>;
}

/** `reserved`: names expressed by another field of the expectation. `uidAllowed` only for a created resource. */
function propertyPlan(properties: readonly PropertyExpectation[] | undefined, companions: readonly Companion[] | undefined, reserved: readonly string[], uidAllowed = false): PropertyPlan {
    const plan: PropertyPlan = { expected: new Map(), companions: new Set() };
    if (properties !== undefined && !Array.isArray(properties)) { refuse('expectation_invalid'); }
    for (const property of properties ?? []) {
        if (typeof property !== 'object' || property === null) { refuse('expectation_invalid'); }
        const name = upperName(property.name, 'name');
        if ((NEVER_EXPECTED.has(name) && !(uidAllowed && name === 'UID')) || reserved.includes(name) || plan.expected.has(name)) { refuse('expectation_invalid', name); }
        if ('absent' in property) {
            if (property.absent !== true) { refuse('expectation_invalid', name); }
            plan.expected.set(name, null);
        } else {
            validValue(property, name);
            plan.expected.set(name, property);
        }
    }
    if (companions !== undefined && !Array.isArray(companions)) { refuse('expectation_invalid'); }
    for (const companion of companions ?? []) {
        if (companion !== 'X-APPLE-STRUCTURED-LOCATION' && companion !== 'X-ALT-DESC') { refuse('expectation_invalid', 'companion'); }
        if (plan.expected.has(companion)) { refuse('expectation_invalid', companion); }
        plan.companions.add(companion);
    }
    return plan;
}

/** Each expected property: exactly one line and one decoded property with that value, no duplicate parameter; absences absent. */
function checkExpected(doc: Doc, view: EventView, plan: PropertyPlan): void {
    for (const [name, expected] of plan.expected) {
        const lines = directWithName(doc, view.node, name);
        const parsed = view.parsed.properties.get(name.toLowerCase()) ?? [];
        if (expected === null) {
            if (lines.length > 0 || parsed.length > 0) { refuse('property_mismatch', name); }
            continue;
        }
        const line = lines[0];
        const property = parsed[0];
        if (lines.length !== 1 || parsed.length !== 1 || line === undefined || property === undefined) { return refuse('property_mismatch', name); }
        if (new Set(line.paramNames).size !== line.paramNames.length) { refuse('property_mismatch', name); }
        if (rawKey(property) !== expectedKey(name, expected)) { refuse('property_mismatch', name); }
    }
    for (const companion of plan.companions) {
        if (directWithName(doc, view.node, companion).length > 0 || view.parsed.properties.has(companion.toLowerCase())) { refuse('companion_present', companion); }
    }
}

/** The direct lines and decoded properties not named in `handled`: identical sequences and deep-equal per-name lists. */
function checkOthers(before: Reading, beforeView: EventView, after: Reading, afterView: EventView, handled: ReadonlySet<string>): void {
    const others = (reading: Reading, view: EventView): string[] => view.node.direct.map(index => lineAt(reading.doc, index)).filter(line => !handled.has(line.name)).map(line => line.text);
    const old = others(before, beforeView);
    const now = others(after, afterView);
    if (old.length !== now.length || old.some((text, index) => text !== now[index])) { refuse('property_changed'); }
    const names = new Set([...beforeView.parsed.properties.keys(), ...afterView.parsed.properties.keys()]);
    for (const name of names) {
        if (handled.has(name.toUpperCase())) { continue; }
        const a = (beforeView.parsed.properties.get(name) ?? []).map(rawKey);
        const b = (afterView.parsed.properties.get(name) ?? []).map(rawKey);
        if (a.length !== b.length || a.some((key, index) => key !== b[index])) { refuse('property_changed'); }
    }
}

function validAlarms(alarms: unknown): readonly ExpectedAlarm[] {
    if (!Array.isArray(alarms)) { return refuse('expectation_invalid', 'VALARM'); }
    for (const alarm of alarms as unknown[]) {
        if (typeof alarm !== 'object' || alarm === null || typeof (alarm as ExpectedAlarm).trigger !== 'string' || typeof (alarm as ExpectedAlarm).description !== 'string') {
            refuse('expectation_invalid', 'VALARM');
        }
    }
    return alarms as readonly ExpectedAlarm[];
}

/** One VALARM exactly as specified: ACTION:DISPLAY, one DESCRIPTION, one TRIGGER, no parameters, nothing else. */
function alarmSpecKey(doc: Doc, node: VNode): string | null {
    if (node.children.length > 0 || node.direct.length !== 3) { return null; }
    const byName = new Map<string, VLine>();
    for (const index of node.direct) {
        const line = lineAt(doc, index);
        if (line.paramNames.length > 0 || byName.has(line.name)) { return null; }
        byName.set(line.name, line);
    }
    const action = byName.get('ACTION');
    const description = byName.get('DESCRIPTION');
    const trigger = byName.get('TRIGGER');
    if (action === undefined || description === undefined || trigger === undefined || action.value.toUpperCase() !== 'DISPLAY') { return null; }
    return canonical([trigger.value, decodeText(description.value)]);
}

function checkReplacedAlarms(doc: Doc, alarms: readonly VNode[], expected: readonly ExpectedAlarm[]): void {
    if (alarms.length !== expected.length) { refuse('alarms_mismatch', 'VALARM'); }
    const wanted = new Map<string, number>();
    for (const alarm of expected) {
        const key = canonical([alarm.trigger, alarm.description]);
        wanted.set(key, (wanted.get(key) ?? 0) + 1);
    }
    for (const node of alarms) {
        const key = alarmSpecKey(doc, node);
        const left = key === null ? 0 : wanted.get(key) ?? 0;
        if (key === null || left === 0) { refuse('alarms_mismatch', 'VALARM'); }
        wanted.set(key as string, left - 1);
    }
}

function nested(doc: Doc, node: VNode): { alarms: VNode[]; others: string[] } {
    const alarms = node.children.filter(child => child.name === 'VALARM');
    const others = node.children.filter(child => child.name !== 'VALARM').map(child => blockKey(blockOf(doc, child)));
    return { alarms, others };
}

function checkTarget(before: Reading, beforeView: EventView, after: Reading, afterView: EventView, target: TargetExpectation): void {
    const plan = propertyPlan(target.properties, target.companionsRemoved, TARGET_RESERVED);
    checkExpected(after.doc, afterView, plan);
    const handled = new Set<string>([...plan.expected.keys(), ...plan.companions]);

    if (target.recurrenceId !== undefined) {
        handled.add('RECURRENCE-ID');
        const lines = directWithName(after.doc, afterView.node, 'RECURRENCE-ID');
        const rid = afterView.parsed.recurrenceId?.raw;
        if (lines.length !== 1 || rid === undefined || rawKey(rid) !== expectedKey('RECURRENCE-ID', target.recurrenceId)) { refuse('override_mismatch', 'RECURRENCE-ID'); }
    }

    if (target.rrule !== undefined) {
        handled.add('RRULE');
        const rules = afterView.parsed.properties.get('rrule') ?? [];
        const lines = directWithName(after.doc, afterView.node, 'RRULE');
        if (target.rrule === null) {
            if (rules.length > 0 || lines.length > 0) { refuse('rrule_mismatch', 'RRULE'); }
        } else {
            const wanted = decodeRrule(target.rrule);
            if (rules.length !== 1 || lines.length !== 1 || rules[0] === undefined || recurKey(rules[0]) !== wanted) { refuse('rrule_mismatch', 'RRULE'); }
        }
    }

    if (target.exdates !== undefined) {
        handled.add('EXDATE');
        checkExdates(before, beforeView, after, afterView, target.exdates);
    }

    checkOthers(before, beforeView, after, afterView, handled);

    const old = nested(before.doc, beforeView.node);
    const now = nested(after.doc, afterView.node);
    if (old.others.length !== now.others.length || old.others.some((key, index) => key !== now.others[index])) { refuse('component_changed'); }
    const alarms = target.alarms ?? { kind: 'unchanged' };
    if (typeof alarms !== 'object' || alarms === null) { refuse('expectation_invalid', 'VALARM'); }
    if (alarms.kind === 'unchanged') {
        const a = old.alarms.map(node => blockKey(blockOf(before.doc, node)));
        const b = now.alarms.map(node => blockKey(blockOf(after.doc, node)));
        if (a.length !== b.length || a.some((key, index) => key !== b[index])) { refuse('alarms_mismatch', 'VALARM'); }
    } else if (alarms.kind === 'removed') {
        if (now.alarms.length > 0) { refuse('alarms_mismatch', 'VALARM'); }
    } else if (alarms.kind === 'replaced') {
        checkReplacedAlarms(after.doc, now.alarms, validAlarms(alarms.alarms));
    } else {
        refuse('expectation_invalid', 'VALARM');
    }
}

function checkExdates(before: Reading, beforeView: EventView, after: Reading, afterView: EventView, exdates: ExdateExpectation): void {
    const nowLines = directWithName(after.doc, afterView.node, 'EXDATE');
    const nowParsed = afterView.parsed.properties.get('exdate') ?? [];
    if (typeof exdates !== 'object' || exdates === null) { refuse('expectation_invalid', 'EXDATE'); }
    if (exdates.kind === 'removed_all') {
        if (nowLines.length > 0 || nowParsed.length > 0) { refuse('exdate_mismatch', 'EXDATE'); }
        return;
    }
    if (exdates.kind === 'replaced') {
        if (!Array.isArray(exdates.lines) || nowLines.length !== exdates.lines.length || nowParsed.length !== exdates.lines.length) { refuse('exdate_mismatch', 'EXDATE'); }
        const wanted = new Map<string, number>();
        for (const value of exdates.lines) {
            const key = expectedKey('EXDATE', value);
            wanted.set(key, (wanted.get(key) ?? 0) + 1);
        }
        for (const property of nowParsed) {
            const left = wanted.get(rawKey(property)) ?? 0;
            if (left === 0) { refuse('exdate_mismatch', 'EXDATE'); }
            wanted.set(rawKey(property), left - 1);
        }
        return;
    }
    if (exdates.kind !== 'added' || !Array.isArray(exdates.values) || exdates.values.length === 0) { return refuse('expectation_invalid', 'EXDATE'); }
    for (const value of exdates.values) { validValue(value, 'EXDATE'); }
    const oldLines = directWithName(before.doc, beforeView.node, 'EXDATE').map(line => line.text);
    // Old lines are kept in order: an ordered subsequence of the new lines, the rest being exactly the additions.
    let cursor = 0;
    for (const line of nowLines) {
        if (cursor < oldLines.length && line.text === oldLines[cursor]) { cursor++; }
    }
    if (cursor !== oldLines.length || nowLines.length !== oldLines.length + exdates.values.length) { refuse('exdate_mismatch', 'EXDATE'); }
    const remaining = new Map<string, number>();
    for (const property of nowParsed) { remaining.set(rawKey(property), (remaining.get(rawKey(property)) ?? 0) + 1); }
    const take = (key: string): void => {
        const left = remaining.get(key) ?? 0;
        if (left === 0) { refuse('exdate_mismatch', 'EXDATE'); }
        remaining.set(key, left - 1);
    };
    for (const property of beforeView.parsed.properties.get('exdate') ?? []) { take(rawKey(property)); }
    for (const value of exdates.values) { take(expectedKey('EXDATE', value)); }
}

function checkAddedOverride(before: Reading, after: Reading, view: EventView, expectation: AddedOverrideExpectation): void {
    const master = before.master ?? refuse('override_mismatch', 'RECURRENCE-ID');
    validValue(expectation.recurrenceId, 'RECURRENCE-ID');
    const rid = view.parsed.recurrenceId?.raw;
    if (view.rid === null || rid === undefined || rawKey(rid) !== expectedKey('RECURRENCE-ID', expectation.recurrenceId)) { refuse('override_mismatch', 'RECURRENCE-ID'); }
    if (before.events.some(event => event.rid === view.rid)) { refuse('override_mismatch', 'RECURRENCE-ID'); }
    const plan = propertyPlan(expectation.properties, expectation.companionsRemoved, OVERRIDE_RESERVED);
    checkExpected(after.doc, view, plan);

    // Every other direct line is a copy of a master line, and every copyable master line is copied (multisets).
    const skip = new Set<string>([...plan.expected.keys(), ...plan.companions, 'RECURRENCE-ID']);
    const notCopied = new Set<string>([...skip, ...OVERRIDE_NOT_COPIED]);
    const copies = new Map<string, number>();
    for (const index of master.node.direct) {
        const line = lineAt(before.doc, index);
        if (!notCopied.has(line.name)) { copies.set(line.text, (copies.get(line.text) ?? 0) + 1); }
    }
    for (const index of view.node.direct) {
        const line = lineAt(after.doc, index);
        if (skip.has(line.name)) { continue; }
        const left = notCopied.has(line.name) ? 0 : copies.get(line.text) ?? 0;
        if (left === 0) { refuse('override_mismatch', 'copy'); }
        copies.set(line.text, left - 1);
    }
    for (const left of copies.values()) {
        if (left !== 0) { refuse('override_mismatch', 'copy'); }
    }

    const own = nested(after.doc, view.node);
    if (own.others.length > 0) { refuse('override_mismatch', 'component'); }
    const alarms = expectation.alarms;
    if (typeof alarms !== 'object' || alarms === null) { refuse('expectation_invalid', 'VALARM'); }
    if (alarms.kind === 'copied') {
        const wanted = new Map<string, number>();
        for (const node of nested(before.doc, master.node).alarms) {
            const key = blockKey(blockOf(before.doc, node));
            wanted.set(key, (wanted.get(key) ?? 0) + 1);
        }
        if (own.alarms.length !== [...wanted.values()].reduce((sum, count) => sum + count, 0)) { refuse('alarms_mismatch', 'VALARM'); }
        for (const node of own.alarms) {
            const key = blockKey(blockOf(after.doc, node));
            const left = wanted.get(key) ?? 0;
            if (left === 0) { refuse('alarms_mismatch', 'VALARM'); }
            wanted.set(key, left - 1);
        }
    } else if (alarms.kind === 'removed') {
        if (own.alarms.length > 0) { refuse('alarms_mismatch', 'VALARM'); }
    } else if (alarms.kind === 'replaced') {
        checkReplacedAlarms(after.doc, own.alarms, validAlarms(alarms.alarms));
    } else {
        refuse('expectation_invalid', 'VALARM');
    }
}


function validSelector(selector: unknown): TargetSelector {
    if (typeof selector !== 'object' || selector === null) { return refuse('expectation_invalid', 'target'); }
    const candidate = selector as TargetSelector;
    if (candidate.kind === 'master') { return candidate; }
    if (candidate.kind === 'override' && typeof candidate.recurrenceId === 'string' && candidate.recurrenceId !== '') { return candidate; }
    return refuse('expectation_invalid', 'target');
}

const TARGET_RESERVED = ['RRULE', 'EXDATE'];
const OVERRIDE_RESERVED = ['RRULE', 'RDATE', 'EXDATE', 'EXRULE'];

function validAlarmExpectation(alarms: unknown, kinds: readonly string[]): void {
    if (typeof alarms !== 'object' || alarms === null || !kinds.includes((alarms as { kind?: unknown }).kind as string)) { refuse('expectation_invalid', 'VALARM'); }
    if ((alarms as { kind: string }).kind === 'replaced') { validAlarms((alarms as { alarms: unknown }).alarms); }
}

const selectorKey = (selector: TargetSelector): string => (selector.kind === 'master' ? MASTER_KEY : overrideKey(selector.recurrenceId));

/** The expectation's targets as one list (`target` and `targets` are exclusive), each naming a distinct component. */
function targetList(expectation: EditExpectation): readonly TargetExpectation[] {
    if (expectation.targets === undefined) { return expectation.target === undefined ? [] : [expectation.target]; }
    if (!Array.isArray(expectation.targets) || expectation.target !== undefined) { return refuse('expectation_invalid', 'target'); }
    return expectation.targets;
}

/** The whole expectation is checked before either text is read, so a malformed one is never reported as a text mismatch. */
function validateEditExpectation(expectation: EditExpectation): void {
    if (typeof expectation !== 'object' || expectation === null) { refuse('expectation_invalid'); }
    const { addOverride, removeOverride } = expectation;
    const keys = new Set<string>();
    for (const target of targetList(expectation)) {
        if (typeof target !== 'object' || target === null) { refuse('expectation_invalid', 'target'); }
        const key = selectorKey(validSelector(target.component));
        if (keys.has(key)) { refuse('expectation_invalid', 'target'); }
        keys.add(key);
        propertyPlan(target.properties, target.companionsRemoved, TARGET_RESERVED);
        if (target.recurrenceId !== undefined) {
            if (target.component.kind !== 'override') { refuse('expectation_invalid', 'RECURRENCE-ID'); }
            validValue(target.recurrenceId, 'RECURRENCE-ID');
        }
        if (target.alarms !== undefined) { validAlarmExpectation(target.alarms, ['unchanged', 'replaced', 'removed']); }
        if (target.rrule !== undefined && target.rrule !== null) { decodeRrule(target.rrule); }
        const exdates = target.exdates;
        if (exdates !== undefined) {
            if (typeof exdates !== 'object' || exdates === null) { refuse('expectation_invalid', 'EXDATE'); }
            if (exdates.kind === 'added') {
                if (!Array.isArray(exdates.values) || exdates.values.length === 0) { refuse('expectation_invalid', 'EXDATE'); }
                for (const value of exdates.values) { validValue(value, 'EXDATE'); }
            } else if (exdates.kind === 'replaced') {
                if (!Array.isArray(exdates.lines) || exdates.lines.length === 0) { refuse('expectation_invalid', 'EXDATE'); }
                for (const value of exdates.lines) { validValue(value, 'EXDATE'); }
            } else if (exdates.kind !== 'removed_all') {
                refuse('expectation_invalid', 'EXDATE');
            }
        }
    }
    if (addOverride !== undefined) {
        if (typeof addOverride !== 'object' || addOverride === null) { refuse('expectation_invalid', 'addOverride'); }
        validValue(addOverride.recurrenceId, 'RECURRENCE-ID');
        propertyPlan(addOverride.properties, addOverride.companionsRemoved, OVERRIDE_RESERVED);
        validAlarmExpectation(addOverride.alarms, ['copied', 'replaced', 'removed']);
    }
    if (removeOverride !== undefined && (typeof removeOverride !== 'object' || removeOverride === null || typeof removeOverride.recurrenceId !== 'string' || removeOverride.recurrenceId === '')) {
        refuse('expectation_invalid', 'removeOverride');
    }
    const removals = expectation.removeOverrides;
    if (removals !== undefined && !Array.isArray(removals)) { refuse('expectation_invalid', 'removeOverride'); }
    for (const removal of removals ?? []) {
        if (typeof removal !== 'object' || removal === null || typeof removal.recurrenceId !== 'string' || removal.recurrenceId === '') { refuse('expectation_invalid', 'removeOverride'); }
    }
    const removed = removedRids(expectation);
    if (removed.size !== (removeOverride === undefined ? 0 : 1) + (removals?.length ?? 0)) { refuse('expectation_invalid', 'removeOverride'); }
    for (const rid of removed) {
        if (keys.has(overrideKey(rid))) { refuse('expectation_invalid', 'target'); }
    }
}

/** Every override RECURRENCE-ID text the expectation removes (`removeOverride` and `removeOverrides`). */
function removedRids(expectation: EditExpectation): Set<string> {
    const rids = new Set<string>();
    if (expectation.removeOverride !== undefined) { rids.add(expectation.removeOverride.recurrenceId); }
    for (const removal of expectation.removeOverrides ?? []) { rids.add(removal.recurrenceId); }
    return rids;
}

function lineList(doc: Doc, node: VNode): string[] {
    return node.direct.map(index => lineAt(doc, index).text);
}

/**
 * Checks an edited resource against the request-derived expectation. `before` is the stored text the edit started from,
 * `after` the text about to be sent. Returns `{ ok: true }` only when every rule in the module comment holds.
 */
export function verifyEditOutcome(before: string, after: string, expectation: EditExpectation, options: OutcomeOptions = {}): OutcomeVerdict {
    return verdictOf(() => {
        validateEditExpectation(expectation);
        const old = read(before, 'before_unparseable', options);
        const now = read(after, 'after_unparseable', options);
        // Targets by component key: every lookup below is O(1), so checking every component of a series stays linear.
        const targets = new Map<string, TargetExpectation>();
        for (const target of targetList(expectation)) { targets.set(selectorKey(validSelector(target.component)), target); }
        const eventKey = (event: EventView | undefined): string | undefined => (event === undefined ? undefined : event.rid === null ? MASTER_KEY : overrideKey(event.rid));
        const masterTarget = targets.get(MASTER_KEY);
        // A target whose RECURRENCE-ID is expected to change: the old key before, the same component afterwards.
        const renamedKey = new Map<string, ExpectedValue>();
        for (const [key, target] of targets) {
            if (target.recurrenceId !== undefined) { renamedKey.set(key, target.recurrenceId); }
        }
        // The hard rules come first, so a forbidden line is reported as such. A renamed override's lines are judged against
        // the same component before: the after override whose RECURRENCE-ID decodes to the expected value (pairing below
        // then requires it at the target's position).
        const afterByRid = new Map<string, string>();
        for (const event of now.events) {
            const raw = event.parsed.recurrenceId?.raw;
            if (raw !== undefined && event.rid !== null) { afterByRid.set(rawKey(raw), event.rid); }
        }
        const renamedTops = new Map<string, string>();
        for (const [key, value] of renamedKey) {
            const rid = afterByRid.get(expectedKey('RECURRENCE-ID', value));
            if (rid !== undefined) { renamedTops.set(overrideKey(rid), key); }
        }
        hardRules(old, now, { masterCopies: expectation.addOverride !== undefined, schedulingCopies: expectation.addOverride?.schedulingCopied === true, renamed: renamedTops });

        // Identity: one UID throughout, and the same kind. A single event becomes a series only by an expected RRULE, a
        // series a single event only by an expected RRULE removal on the master (and nothing else recurring left).
        const uidOf = (reading: Reading): string => (reading.parsed.master ?? reading.parsed.overrides[0])?.uid ?? refuse('structure_mismatch');
        if (uidOf(old) !== uidOf(now)) { refuse('identity_changed', 'UID'); }
        const becameSeries = old.parsed.kind === 'single' && now.parsed.kind === 'series' && typeof masterTarget?.rrule === 'string';
        const becameSingle = old.parsed.kind === 'series' && now.parsed.kind === 'single' && masterTarget?.rrule === null;
        if (old.parsed.kind !== now.parsed.kind && !becameSeries && !becameSingle) { refuse('identity_changed', 'kind'); }

        const oldCalendar = lineList(old.doc, old.doc.root);
        const nowCalendar = lineList(now.doc, now.doc.root);
        if (oldCalendar.length !== nowCalendar.length || oldCalendar.some((text, index) => text !== nowCalendar[index])) { refuse('calendar_changed'); }
        const removed = removedRids(expectation);

        // Pair the top-level components in order; the added override is the one after-component without a partner.
        const oldView = new Map(old.events.map(event => [event.node, event]));
        const nowView = new Map(now.events.map(event => [event.node, event]));
        const oldTop = old.doc.root.children.filter(node => {
            const rid = oldView.get(node)?.rid;
            return rid === undefined || rid === null || !removed.has(rid);
        });
        for (const rid of removed) {
            if (old.events.filter(event => event.rid === rid).length !== 1) { refuse('override_mismatch', 'removeOverride'); }
        }
        // Each target names exactly one component of the original.
        const oldCounts = new Map<string, number>();
        for (const event of old.events) {
            const key = eventKey(event) ?? '';
            oldCounts.set(key, (oldCounts.get(key) ?? 0) + 1);
        }
        for (const key of targets.keys()) {
            if (oldCounts.get(key) !== 1) { refuse('target_not_found', 'target'); }
        }
        let added: EventView | null = null;
        const pairedTargets = new Map<string, [EventView, EventView]>();
        let cursor = 0;
        const nowTop = now.doc.root.children;
        for (const node of oldTop) {
            const oldEvent = oldView.get(node);
            const key = eventKey(oldEvent);
            const isTarget = key !== undefined && targets.has(key);
            let partner = nowTop[cursor];
            const matches = (candidate: VNode | undefined): boolean => {
                if (candidate === undefined) { return false; }
                const renamed = key === undefined ? undefined : renamedKey.get(key);
                if (isTarget && renamed !== undefined) {
                    const rid = nowView.get(candidate)?.parsed.recurrenceId?.raw;
                    return rid !== undefined && rawKey(rid) === expectedKey('RECURRENCE-ID', renamed);
                }
                if (isTarget) { return eventKey(nowView.get(candidate)) === key; }
                return blockKey(blockOf(old.doc, node)) === blockKey(blockOf(now.doc, candidate));
            };
            if (!matches(partner) && expectation.addOverride !== undefined && added === null && partner !== undefined && nowView.get(partner)?.rid !== null && nowView.has(partner)) {
                added = nowView.get(partner) ?? null;
                cursor++;
                partner = nowTop[cursor];
            }
            if (!matches(partner)) { refuse(isTarget ? 'target_not_found' : 'component_changed'); }
            if (isTarget && key !== undefined && oldEvent !== undefined && partner !== undefined) { pairedTargets.set(key, [oldEvent, nowView.get(partner) ?? refuse('structure_mismatch')]); }
            cursor++;
        }
        if (cursor < nowTop.length && expectation.addOverride !== undefined && added === null) {
            const candidate = nowTop[cursor];
            added = candidate === undefined ? null : nowView.get(candidate) ?? null;
            if (added === null || added.rid === null) { refuse('override_mismatch', 'addOverride'); }
            cursor++;
        }
        if (cursor !== nowTop.length) {
            if (expectation.addOverride === undefined) { refuse('component_changed'); }
            refuse('override_mismatch', 'addOverride');
        }
        if (expectation.addOverride !== undefined && added === null) { refuse('override_mismatch', 'addOverride'); }

        for (const [key, target] of targets) {
            const paired = pairedTargets.get(key);
            if (paired === undefined) { return refuse('target_not_found', 'target'); }
            checkTarget(old, paired[0], now, paired[1], target);
        }
        if (expectation.addOverride !== undefined && added !== null) { checkAddedOverride(old, now, added, expectation.addOverride); }
    });
}

// ---- A new resource derived from a stored one (the future part of a split) ----

/** Master lines the new master of a split never copies: identity, rules, times and stamps are expected, not copied. */
export const DERIVED_NOT_COPIED: readonly string[] = ['UID', 'RECURRENCE-ID', 'RRULE', 'RDATE', 'EXRULE', 'EXDATE', 'DTSTART', 'DTEND', 'DURATION', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE'];

export interface DerivedMasterExpectation {
    /** The written properties (DTSTART, DTEND, DTSTAMP, CREATED, LAST-MODIFIED, SEQUENCE and the changes), or absences. Never UID. */
    readonly properties: readonly PropertyExpectation[];
    readonly companionsRemoved?: readonly Companion[] | undefined;
    /** Text: exactly one RRULE decoding to this rule. `copied`: the original master's one RRULE line, unchanged. */
    readonly rrule: string | { readonly kind: 'copied' };
    /** `copied`: exactly the original master's EXDATE lines, in order. `none`: no EXDATE. */
    readonly exdates: 'copied' | 'none';
    readonly alarms: { readonly kind: 'copied' } | { readonly kind: 'replaced'; readonly alarms: readonly ExpectedAlarm[] } | { readonly kind: 'removed' };
}

/** Derived by the caller from the request, the deterministic UID and the stored text (design 3.5). */
export interface DerivedExpectation {
    /** The new resource's UID (from operation_id); every VEVENT must carry it. */
    readonly uid: string;
    readonly master: DerivedMasterExpectation;
    /** The original overrides copied whole (their UID line excepted), by RECURRENCE-ID text, in order. */
    readonly overrides: readonly string[];
    /**
     * Set only when the grant includes calendar:invite. The ONE exception to "no new ATTENDEE/ORGANIZER": each VEVENT of
     * the new resource then holds exactly the scheduling lines of the stored component it comes from (master from master,
     * override from the same override), byte-equal, all of them and nothing else. Without it there may be none at all.
     */
    readonly schedulingCopied: boolean;
}

const UID_TEXT_RE = /^[A-Za-z0-9._~@+=-]{1,255}$/u;

function validateDerived(expectation: DerivedExpectation): PropertyPlan {
    if (typeof expectation !== 'object' || expectation === null || typeof expectation.uid !== 'string' || !UID_TEXT_RE.test(expectation.uid)) { return refuse('expectation_invalid', 'UID'); }
    const master = expectation.master;
    if (typeof master !== 'object' || master === null) { return refuse('expectation_invalid', 'master'); }
    const plan = propertyPlan(master.properties, master.companionsRemoved, OVERRIDE_RESERVED);
    const rule = master.rrule;
    if (typeof rule === 'string') { decodeRrule(rule); } else if (typeof rule !== 'object' || rule === null || rule.kind !== 'copied') { refuse('expectation_invalid', 'RRULE'); }
    if (master.exdates !== 'copied' && master.exdates !== 'none') { refuse('expectation_invalid', 'EXDATE'); }
    validAlarmExpectation(master.alarms, ['copied', 'replaced', 'removed']);
    if (!Array.isArray(expectation.overrides) || !expectation.overrides.every(rid => typeof rid === 'string' && rid !== '') || new Set(expectation.overrides).size !== expectation.overrides.length) {
        refuse('expectation_invalid', 'overrides');
    }
    if (typeof expectation.schedulingCopied !== 'boolean') { refuse('expectation_invalid', 'schedulingCopied'); }
    return plan;
}

/** Multiset equality of two line-text lists. */
function sameLines(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) { return false; }
    const counts = new Map<string, number>();
    for (const item of a) { counts.set(item, (counts.get(item) ?? 0) + 1); }
    for (const item of b) {
        const left = counts.get(item) ?? 0;
        if (left === 0) { return false; }
        counts.set(item, left - 1);
    }
    return true;
}

/** Scheduling lines of a whole component (nested components included), as unfolded texts. */
function schedulingLinesOf(doc: Doc, node: VNode): string[] {
    const lines: string[] = [];
    for (let index = node.begin; index <= node.end; index++) {
        const line = lineAt(doc, index);
        if (isSchedulingName(line.name)) { lines.push(line.text); }
    }
    return lines;
}

/**
 * Checks the new resource of a split against the request-derived expectation, with the stored resource it comes from.
 * Holds only when: calendar level is exactly VERSION, PRODID and CALSCALE; the top-level components are the original's
 * VTIMEZONEs (line-identical, in order), the new master, then exactly the expected overrides in order, nothing else; every
 * VEVENT has the expected UID; the master holds the expected properties, the expected RRULE (or the original's line), the
 * original's EXDATE lines (or none), the expected alarms, and otherwise exactly line-identical copies of every original
 * master line not in {@link DERIVED_NOT_COPIED} and not expected; each copied override is line-identical to the original
 * except its direct UID line, which is `UID:<uid>`; and the scheduling rule of {@link DerivedExpectation.schedulingCopied}.
 * ATTACH and non-DISPLAY alarms can only be copies (by the copy rules above).
 */
export function verifyDerivedOutcome(before: string, after: string, expectation: DerivedExpectation, options: OutcomeOptions = {}): OutcomeVerdict {
    return verdictOf(() => {
        const plan = validateDerived(expectation);
        const old = read(before, 'before_unparseable', options);
        const now = read(after, 'after_unparseable', options);
        const oldMaster = old.master ?? refuse('structure_mismatch', 'master');
        const nowMaster = now.master ?? refuse('component_changed', 'VEVENT');
        if (now.parsed.kind !== 'series') { refuse('identity_changed', 'kind'); }

        // Calendar level: only the header this server writes.
        const seen = new Set<string>();
        for (const index of now.doc.root.direct) {
            const line = lineAt(now.doc, index);
            if (!['VERSION', 'PRODID', 'CALSCALE'].includes(line.name) || seen.has(line.name)) { refuse('calendar_changed'); }
            seen.add(line.name);
        }

        // Top level: the original's VTIMEZONEs, then the master, then the expected overrides; nothing else.
        const oldZones = old.doc.root.children.filter(child => child.name === 'VTIMEZONE').map(node => blockKey(blockOf(old.doc, node)));
        const nowZones = now.doc.root.children.filter(child => child.name === 'VTIMEZONE').map(node => blockKey(blockOf(now.doc, node)));
        if (oldZones.length !== nowZones.length || oldZones.some((key, index) => key !== nowZones[index])) { refuse('component_changed', 'VTIMEZONE'); }
        if (now.doc.root.children.length !== nowZones.length + now.events.length) { refuse('component_changed'); }
        const [first, ...rest] = now.events;
        if (first !== nowMaster || rest.length !== expectation.overrides.length || rest.some((event, index) => event.rid !== expectation.overrides[index])) { refuse('override_mismatch', 'overrides'); }
        for (const event of now.events) {
            if (event.parsed.uid !== expectation.uid) { refuse('identity_changed', 'UID'); }
        }

        // Scheduling lines: none, or exactly the source component's (calendar:invite).
        const oldByRid = new Map(old.events.map(event => [event.rid, event]));
        for (const event of now.events) {
            const source = oldByRid.get(event.rid);
            const lines = schedulingLinesOf(now.doc, event.node);
            if (!expectation.schedulingCopied) {
                if (lines.length > 0) { refuse('scheduling_added', 'ATTENDEE/ORGANIZER'); }
            } else if (source === undefined || !sameLines(lines, schedulingLinesOf(old.doc, source.node))) {
                refuse('scheduling_added', 'ATTENDEE/ORGANIZER');
            }
        }

        // The master.
        checkExpected(now.doc, nowMaster, plan);
        const handled = new Set<string>([...plan.expected.keys(), ...plan.companions, 'UID', 'RRULE', 'EXDATE']);
        const rules = nowMaster.parsed.properties.get('rrule') ?? [];
        const ruleLines = directWithName(now.doc, nowMaster.node, 'RRULE');
        const rule = expectation.master.rrule;
        if (typeof rule === 'string') {
            if (rules.length !== 1 || ruleLines.length !== 1 || rules[0] === undefined || recurKey(rules[0]) !== decodeRrule(rule)) { refuse('rrule_mismatch', 'RRULE'); }
        } else {
            const oldRules = directWithName(old.doc, oldMaster.node, 'RRULE').map(line => line.text);
            if (oldRules.length !== 1 || ruleLines.length !== 1 || ruleLines[0]?.text !== oldRules[0]) { refuse('rrule_mismatch', 'RRULE'); }
        }
        const nowExdates = directWithName(now.doc, nowMaster.node, 'EXDATE').map(line => line.text);
        const oldExdates = expectation.master.exdates === 'copied' ? directWithName(old.doc, oldMaster.node, 'EXDATE').map(line => line.text) : [];
        if (nowExdates.length !== oldExdates.length || nowExdates.some((text, index) => text !== oldExdates[index])) { refuse('exdate_mismatch', 'EXDATE'); }
        const uids = directWithName(now.doc, nowMaster.node, 'UID');
        if (uids.length !== 1 || uids[0]?.text !== `UID:${expectation.uid}`) { refuse('identity_changed', 'UID'); }
        const notCopied = new Set<string>([...handled, ...DERIVED_NOT_COPIED]);
        const wanted = oldMaster.node.direct.map(index => lineAt(old.doc, index)).filter(line => !notCopied.has(line.name)).map(line => line.text);
        const copied = nowMaster.node.direct.map(index => lineAt(now.doc, index)).filter(line => !handled.has(line.name));
        if (copied.some(line => notCopied.has(line.name)) || !sameLines(wanted, copied.map(line => line.text))) { refuse('override_mismatch', 'copy'); }
        const own = nested(now.doc, nowMaster.node);
        if (own.others.length > 0) { refuse('component_changed', 'VEVENT'); }
        const alarms = expectation.master.alarms;
        if (alarms.kind === 'copied') {
            const source = nested(old.doc, oldMaster.node).alarms.map(node => blockKey(blockOf(old.doc, node)));
            if (!sameLines(source, own.alarms.map(node => blockKey(blockOf(now.doc, node))))) { refuse('alarms_mismatch', 'VALARM'); }
        } else if (alarms.kind === 'removed') {
            if (own.alarms.length > 0) { refuse('alarms_mismatch', 'VALARM'); }
        } else {
            checkReplacedAlarms(now.doc, own.alarms, validAlarms(alarms.alarms));
        }

        // The copied overrides: line-identical but for the direct UID line.
        for (const [index, rid] of expectation.overrides.entries()) {
            const source = old.events.filter(event => event.rid === rid);
            const target = rest[index];
            if (source.length !== 1 || source[0] === undefined || target === undefined) { return refuse('override_mismatch', 'overrides'); }
            const node = source[0].node;
            const uidIndex = node.direct.find(line => lineAt(old.doc, line).name === 'UID');
            const expected: string[] = [];
            for (let line = node.begin; line <= node.end; line++) { expected.push(line === uidIndex ? `UID:${expectation.uid}` : lineAt(old.doc, line).text); }
            if (blockKey(expected) !== blockKey(blockOf(now.doc, target.node))) { refuse('override_mismatch', 'copy'); }
        }
    });
}

/**
 * Checks a resource about to be created: one VEVENT holding exactly the expected properties (plus the expected RRULE), only
 * the expected DISPLAY alarms, no ATTENDEE, ORGANIZER or ATTACH anywhere, no other component than `vtimezoneCount`
 * VTIMEZONEs (default none), and only VERSION, PRODID and CALSCALE at calendar level.
 */
export function verifyCreateOutcome(text: string, expectation: CreateExpectation, options: OutcomeOptions = {}): OutcomeVerdict {
    return verdictOf(() => {
        // The whole expectation first, before the text is read.
        if (typeof expectation !== 'object' || expectation === null || !Array.isArray(expectation.properties)) { refuse('expectation_invalid'); }
        const plan = propertyPlan(expectation.properties, undefined, OVERRIDE_RESERVED, true);
        for (const value of plan.expected.values()) {
            if (value === null) { refuse('expectation_invalid'); }
        }
        const vtimezones = expectation.vtimezoneCount ?? 0;
        if (!Number.isInteger(vtimezones) || vtimezones < 0) { refuse('expectation_invalid', 'VTIMEZONE'); }
        const wantedRule = expectation.rrule === undefined ? null : decodeRrule(expectation.rrule);
        const alarms = validAlarms(expectation.alarms);

        const now = read(text, 'after_unparseable', options);
        hardRules(null, now, NO_COPIES);
        const events = now.doc.root.children.filter(child => child.name === 'VEVENT');
        const zones = now.doc.root.children.filter(child => child.name === 'VTIMEZONE');
        if (events.length !== 1 || now.events.length !== 1 || now.master === null || now.parsed.overrides.length > 0) { refuse('component_changed', 'VEVENT'); }
        if (zones.length !== vtimezones || now.doc.root.children.length !== 1 + vtimezones) { refuse('component_changed', 'VTIMEZONE'); }
        const seen = new Set<string>();
        for (const index of now.doc.root.direct) {
            const line = lineAt(now.doc, index);
            if (!['VERSION', 'PRODID', 'CALSCALE'].includes(line.name) || seen.has(line.name)) { refuse('calendar_changed', line.name === 'VERSION' || line.name === 'PRODID' || line.name === 'CALSCALE' ? line.name : null); }
            seen.add(line.name);
        }
        const view = now.master as EventView;
        checkExpected(now.doc, view, plan);
        const allowed = new Set<string>(plan.expected.keys());
        if (wantedRule !== null) {
            allowed.add('RRULE');
            const rules = view.parsed.properties.get('rrule') ?? [];
            if (rules.length !== 1 || rules[0] === undefined || recurKey(rules[0]) !== wantedRule || directWithName(now.doc, view.node, 'RRULE').length !== 1) { refuse('rrule_mismatch', 'RRULE'); }
        }
        for (const index of view.node.direct) {
            if (!allowed.has(lineAt(now.doc, index).name)) { refuse('unexpected_property'); }
        }
        const own = nested(now.doc, view.node);
        if (own.others.length > 0) { refuse('component_changed', 'VEVENT'); }
        checkReplacedAlarms(now.doc, own.alarms, alarms);
        if ((now.parsed.kind === 'series') !== (wantedRule !== null)) { refuse('identity_changed', 'kind'); }
    });
}
