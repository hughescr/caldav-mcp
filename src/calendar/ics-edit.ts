/**
 * Lossless span editor for stored event text (phase 3 design v2 section 6.3, ORCH S1). Pure; parsing for verification goes
 * through `parseOriginalResource` only.
 *
 * The editor reads the ORIGINAL resource as physical lines (CRLF or LF, any legal folding with SPACE or TAB continuations,
 * iCloud's 91-octet lines included), groups them into logical lines with their physical spans, and builds a component tree
 * that must agree with `parseOriginalResource` (same VEVENTs in order, same UID and RECURRENCE-ID, same alarm and VTIMEZONE
 * counts). Component edits address one or several distinct components (the master VEVENT, or the override whose
 * RECURRENCE-ID line has exactly a given text), all in one pass, and touch only their direct logical properties, or whole
 * nested VALARMs when alarms are replaced; resource-level edits add a VEVENT before `END:VCALENDAR` or remove an override
 * VEVENT.
 *
 * Output guarantee: line contents preserved, line endings normalised. Every logical line outside the edited spans is
 * emitted with exactly its original physical lines (same content, same folding); every physical line of the output ends
 * with CRLF, including the last. Only lines the editor writes are folded, at 75 octets on code-point boundaries.
 *
 * The result carries a machine-checkable {@link EditReport}; {@link verifyUntouched} re-derives the line structure of both
 * texts with its own code and proves the untouched lines equal. `editResource` runs that check and a re-parse of the
 * output before returning, and never returns text that fails either. Neither proves that the CHANGED lines say what was
 * asked: that is `verifyEditOutcome` in `ics-verify.ts`, which the write path must run before every PUT.
 *
 * Every pass here is linear in the number of lines (2 MiB / 50,000-line resources): no per-line rescans of a span.
 * Measured versus assumed: line handling is checked against the local parser only; iCloud's treatment of NEL, U+2028,
 * U+2029 or a BOM inside stored TEXT, and of a backslash in a parameter value, is NOT measured. Such stored lines are kept
 * byte for byte when untouched; a RECURRENCE-ID whose TZID holds a backslash fails the agreement check (`tree_mismatch`).
 */
import { parseContentLine } from './attachments';
import type { ResourceWork } from './budget';
import { foldLine, isWrittenComponent, isWrittenProperty, MAX_LINE_OCTETS, type WrittenComponent, type WrittenProperty } from './ics-write';
import { parseOriginalResource } from './ical';
import { MAX_ICS_NESTING } from './limits';
import { BudgetError, IcalError, type EventComponent, type OriginalResource } from './model';

// ---- Errors ----

export type IcsEditErrorReason =
    | 'lone_cr'
    | 'blank_line'
    | 'malformed'
    | 'original_unparseable'
    | 'tree_mismatch'
    | 'target_not_found'
    | 'target_ambiguous'
    | 'duplicate_property'
    | 'property_absent'
    | 'edit_not_allowed'
    | 'conflicting_edits'
    | 'value_not_written'
    | 'component_invalid'
    | 'copy_invalid'
    | 'output_too_large'
    | 'output_invalid';

/**
 * An edit that cannot be made. The caller maps every reason to `unsupported_calendar_data` (or to an internal error for
 * `value_not_written`, `conflicting_edits` and `output_invalid`, which mean a server defect). Never carries resource text.
 */
export class IcsEditError extends Error {
    constructor(public readonly reason: IcsEditErrorReason) { super(reason); }
}

// ---- Plan ----

/** The master VEVENT, or the override whose unfolded RECURRENCE-ID logical line equals `recurrenceId` exactly. */
export type ComponentSelector = { kind: 'master' } | { kind: 'override'; recurrenceId: string };

/**
 * `set`, `replace` and `remove` of LOCATION or DESCRIPTION edit the logical field, not one line: they also remove its fixed
 * Apple companion (X-APPLE-STRUCTURED-LOCATION, X-ALT-DESC), reported as a `removed` change with reason `paired`. This holds
 * when the property itself is absent: `remove DESCRIPTION` on an event with only X-ALT-DESC removes X-ALT-DESC (and
 * `remove LOCATION` with only X-APPLE-STRUCTURED-LOCATION removes that), so a cleared field keeps no stale companion copy.
 */
export type ComponentEdit =
    /** Replace the property of that name in place, or add it when absent. More than one occurrence is an error. */
    | { op: 'set'; property: WrittenProperty }
    /** Replace the property of that name in place; it must occur exactly once. */
    | { op: 'replace'; property: WrittenProperty }
    /**
     * Remove the property of that name if present; more than one occurrence is an error. For LOCATION and DESCRIPTION the
     * companion is removed too, also when the property itself is absent (clearing the field; see above).
     */
    | { op: 'remove'; name: string }
    /** Remove every occurrence of a multi-valued property (`EXDATE`, `RDATE`). */
    | { op: 'remove_all'; name: string }
    /** Add one line of a multi-valued property, after the last line of the same name, else in the new-property position. */
    | { op: 'add'; property: WrittenProperty }
    /** Remove every VALARM nested directly in the component. */
    | { op: 'remove_alarms' }
    /** Add one VALARM before the component's END. */
    | { op: 'add_alarm'; alarm: WrittenComponent };

/** One line of a new VEVENT: a written property or alarm, or a byte-for-byte copy from the original. */
export type NewComponentItem =
    | WrittenProperty
    | WrittenComponent
    /** A direct property line of any top-level VEVENT, by logical line index (see {@link describeEvents}). */
    | { copy_line: number }
    /** A whole VALARM nested in a top-level VEVENT, by the logical index of its BEGIN line. */
    | { copy_component: number };

export type ResourceEdit =
    /** A new VEVENT (an override) inserted before END:VCALENDAR. It needs exactly one UID and one RECURRENCE-ID. */
    | { op: 'add_component'; items: readonly NewComponentItem[] }
    /** Remove one whole override VEVENT. The master is never removed (a whole-resource delete is a DELETE request). */
    | { op: 'remove_component'; target: { kind: 'override'; recurrenceId: string } };

/** The edits of one component. */
export interface ComponentPlan {
    readonly target: ComponentSelector;
    readonly edits: readonly ComponentEdit[];
}

/**
 * One pass over the resource. Component edits name one component (`target` with `edits`) or several (`targets`, each a
 * distinct component; for `edit_scope: "all"`), never both forms; all of them, and the resource edits, are planned on one
 * reading of the original and emitted in one pass.
 */
export interface EditPlan {
    target?: ComponentSelector | undefined;
    edits?: readonly ComponentEdit[] | undefined;
    targets?: readonly ComponentPlan[] | undefined;
    resource?: readonly ResourceEdit[] | undefined;
}

/**
 * `work`: makes the work charge for each parse. When given, a BudgetError it throws (the invocation's shared caps or its
 * deadline) propagates unchanged for the caller to map; without it each parse has its own default budget, and a budget
 * failure is reported as an edit error like any unreadable text.
 */
export interface EditOptions {
    readonly work?: (() => ResourceWork) | undefined;
}

// ---- Report ----

export interface EditChange {
    action: 'replaced' | 'removed' | 'added';
    /** Upper-case property name, or VEVENT/VALARM for a whole component. */
    name: string;
    /** `paired` for the fixed Apple companions removed with LOCATION and DESCRIPTION. */
    reason: 'requested' | 'paired';
    /** Logical line index in the original (the BEGIN line for a component), or null for an addition. */
    original: number | null;
    /** Logical line index in the output (the BEGIN line for a component), or null for a removal. */
    output: number | null;
}

/** Logical line indices are 0-based positions in each text's sequence of logical lines (BEGIN and END lines included). */
export interface EditReport {
    /** Original logical lines absent from the output (removed or replaced), ascending. */
    removed: readonly number[];
    /** Output logical lines the editor wrote (new, replacement or copied), ascending. */
    written: readonly number[];
    /** Written output lines that are byte-for-byte copies of an original line. */
    copied: readonly { output: number; original: number }[];
    /** The edited components' BEGIN and END in the original, ascending by BEGIN; empty when the plan had no component edits. */
    targets: readonly { begin: number; end: number }[];
    /** Whole VEVENTs removed, as original BEGIN/END indices. */
    removedComponents: readonly { begin: number; end: number }[];
    changes: readonly EditChange[];
}

export interface EditResult { text: string; report: EditReport }

// ---- Outline (for building plans) ----

export interface OutlineLine { index: number; name: string; text: string }
export interface EventOutline {
    begin: number;
    end: number;
    /** Unfolded RECURRENCE-ID logical line, or null for the master. */
    recurrenceId: string | null;
    /** Direct property lines in source order (lower-case names). */
    properties: readonly OutlineLine[];
    /** Directly nested VALARMs. */
    alarms: readonly { begin: number; end: number }[];
}

// ---- Tree ----

interface Line {
    physical: string[];
    text: string;
    name: string;
    value: string;
    parameters: ReadonlyMap<string, readonly string[]>;
}

interface ComponentNode {
    name: string;
    begin: number;
    end: number;
    parent: ComponentNode | null;
    direct: number[];
    children: ComponentNode[];
}

interface Tree {
    lines: Line[];
    root: ComponentNode;
    events: ComponentNode[];
    parsed: OriginalResource;
    /** VEVENTs without a RECURRENCE-ID, and VEVENTs by the exact text of each of their RECURRENCE-ID lines: built once. */
    masters: ComponentNode[];
    byRecurrenceId: Map<string, ComponentNode[]>;
}

function splitPhysical(text: string): string[] {
    if (/\r(?!\n)/u.test(text)) { throw new IcsEditError('lone_cr'); }
    const physical = text.split(/\r?\n/u);
    if (physical.at(-1) === '') { physical.pop(); }
    return physical;
}

function buildLines(text: string): Line[] {
    const groups: string[][] = [];
    for (const physical of splitPhysical(text)) {
        if (physical === '') { throw new IcsEditError('blank_line'); }
        const first = physical.charCodeAt(0);
        if (first === 0x20 || first === 0x09) {
            const group = groups.at(-1);
            if (group === undefined) { throw new IcsEditError('malformed'); }
            group.push(physical);
        } else {
            groups.push([physical]);
        }
    }
    return groups.map(physical => {
        const unfolded = physical.map((part, index) => (index === 0 ? part : part.slice(1))).join('');
        let parsed: ReturnType<typeof parseContentLine>;
        try {
            parsed = parseContentLine(unfolded);
        } catch {
            throw new IcsEditError('malformed');
        }
        if (parsed === null) { throw new IcsEditError('malformed'); }
        return { physical, text: unfolded, name: parsed.name, value: parsed.value, parameters: parsed.parameters };
    });
}

function buildTree(lines: readonly Line[]): ComponentNode {
    let root: ComponentNode | null = null;
    const stack: ComponentNode[] = [];
    for (const [index, line] of lines.entries()) {
        if (line.name === 'begin' || line.name === 'end') {
            if (line.parameters.size > 0 || !/^[A-Za-z0-9-]+$/u.test(line.value)) { throw new IcsEditError('malformed'); }
        }
        if (line.name === 'begin') {
            if (stack.length >= MAX_ICS_NESTING) { throw new IcsEditError('malformed'); }
            const parent = stack.at(-1) ?? null;
            if (parent === null && root !== null) { throw new IcsEditError('malformed'); }
            const node: ComponentNode = { name: line.value.toLowerCase(), begin: index, end: -1, parent, direct: [], children: [] };
            if (parent === null) { root = node; } else { parent.children.push(node); }
            stack.push(node);
        } else if (line.name === 'end') {
            const node = stack.pop();
            if (node === undefined || node.name !== line.value.toLowerCase()) { throw new IcsEditError('malformed'); }
            node.end = index;
        } else {
            const node = stack.at(-1);
            if (node === undefined) { throw new IcsEditError('malformed'); }
            node.direct.push(index);
        }
    }
    if (stack.length > 0 || root === null || root.name !== 'vcalendar') { throw new IcsEditError('malformed'); }
    return root;
}

/** RFC 5545 TEXT unescaping exactly as ical.js applies it, for comparing a raw UID with the parsed one. */
function decodeText(value: string): string {
    return value.replaceAll(/\\\\|\\;|\\,|\\[Nn]/gu, match => (match === '\\\\' ? '\\' : match === '\\;' ? ';' : match === '\\,' ? ',' : '\n'));
}

function directLines(tree: { lines: readonly Line[] }, node: ComponentNode, name: string): number[] {
    return node.direct.filter(index => tree.lines[index]?.name === name);
}

function lineAt(lines: readonly Line[], index: number): Line {
    const line = lines[index];
    if (line === undefined) { throw new IcsEditError('malformed'); }
    return line;
}

/** The tree's VEVENT and the parser's component describe the same UID, RECURRENCE-ID and alarm count. */
function sameEvent(lines: readonly Line[], node: ComponentNode, component: EventComponent): boolean {
    const uids = node.direct.filter(index => lines[index]?.name === 'uid');
    const rids = node.direct.filter(index => lines[index]?.name === 'recurrence-id');
    const uid = uids.length === 1 ? lines[uids[0] ?? -1] : undefined;
    if (uid === undefined || decodeText(uid.value) !== component.uid) { return false; }
    if (node.children.filter(child => child.name === 'valarm').length !== component.alarmCount) { return false; }
    const parsedRid = component.recurrenceId;
    if (rids.length === 0 || parsedRid === null) { return rids.length === 0 && parsedRid === null; }
    const rid = rids.length === 1 ? lines[rids[0] ?? -1] : undefined;
    const parsedValue = parsedRid.raw.values[0];
    if (rid === undefined || typeof parsedValue !== 'string' || parsedValue.replaceAll(/[-:]/gu, '') !== rid.value) { return false; }
    // ICAL.parse moves VALUE into the jCal type, so it is not compared as a parameter.
    const names = (parameters: ReadonlyMap<string, readonly string[]>): string => JSON.stringify([...parameters.keys()].filter(name => name !== 'value').sort());
    return names(rid.parameters) === names(parsedRid.raw.params) && JSON.stringify(rid.parameters.get('tzid') ?? null) === JSON.stringify(parsedRid.raw.params.get('tzid') ?? null);
}

/** Parse options for one parse: the caller's work, or the parser's own default budget. */
function parseOptions(options: EditOptions): { work?: ResourceWork } {
    return options.work === undefined ? {} : { work: options.work() };
}

/** Parses with the read path, builds the span tree and requires both to agree. */
function readTree(original: string, options: EditOptions): Tree {
    if (typeof original !== 'string') { throw new IcsEditError('malformed'); }
    // Lone CR is a line break to the read path's pre-scan but data to ICAL.parse; refuse before either sees it.
    if (/\r(?!\n)/u.test(original)) { throw new IcsEditError('lone_cr'); }
    let parsed: OriginalResource;
    try {
        parsed = parseOriginalResource(original, parseOptions(options));
    } catch (error) {
        // The caller's budget is the caller's to report.
        if (error instanceof BudgetError && options.work !== undefined) { throw error; }
        // IcalError (malformed, too large) or BudgetError (line/property work caps): either way not editable.
        throw new IcsEditError('original_unparseable');
    }
    const lines = buildLines(original);
    const root = buildTree(lines);
    const events = root.children.filter(child => child.name === 'vevent');
    const masters: ComponentNode[] = [];
    const overrides: ComponentNode[] = [];
    const byRecurrenceId = new Map<string, ComponentNode[]>();
    for (const event of events) {
        const rids = directLines({ lines }, event, 'recurrence-id');
        (rids.length === 0 ? masters : overrides).push(event);
        for (const index of rids) {
            const text = lineAt(lines, index).text;
            const list = byRecurrenceId.get(text);
            if (list === undefined) { byRecurrenceId.set(text, [event]); } else if (!list.includes(event)) { list.push(event); }
        }
    }
    const vtimezones = root.children.filter(child => child.name === 'vtimezone').length;
    if (masters.length !== (parsed.master === null ? 0 : 1) || overrides.length !== parsed.overrides.length || vtimezones !== parsed.vtimezoneCount) {
        throw new IcsEditError('tree_mismatch');
    }
    const master = masters[0];
    if (master !== undefined && (parsed.master === null || !sameEvent(lines, master, parsed.master))) { throw new IcsEditError('tree_mismatch'); }
    overrides.forEach((node, index) => {
        const component = parsed.overrides[index];
        if (component === undefined || !sameEvent(lines, node, component)) { throw new IcsEditError('tree_mismatch'); }
    });
    return { lines, root, events, parsed, masters, byRecurrenceId };
}

/** O(1) per selector through the tree's index, so selecting every component of a series stays linear. */
function selectEvent(tree: Tree, selector: ComponentSelector): ComponentNode {
    if (typeof selector !== 'object' || selector === null) { throw new IcsEditError('target_not_found'); }
    let matches: readonly ComponentNode[];
    if (selector.kind === 'master') {
        matches = tree.masters;
    } else if (selector.kind === 'override' && typeof selector.recurrenceId === 'string') {
        matches = tree.byRecurrenceId.get(selector.recurrenceId) ?? [];
    } else {
        throw new IcsEditError('target_not_found');
    }
    if (matches.length > 1) { throw new IcsEditError('target_ambiguous'); }
    const match = matches[0];
    if (match === undefined) { throw new IcsEditError('target_not_found'); }
    return match;
}

/**
 * The top-level VEVENTs of a resource with logical line indices, for building plans (selectors and copy references).
 * Applies the same parsing and agreement checks as {@link editResource}.
 */
export function describeEvents(original: string, options: EditOptions = {}): EventOutline[] {
    const tree = readTree(original, options);
    return tree.events.map(event => {
        const rid = directLines(tree, event, 'recurrence-id')[0];
        return {
            begin: event.begin,
            end: event.end,
            recurrenceId: rid === undefined ? null : lineAt(tree.lines, rid).text,
            properties: event.direct.map(index => ({ index, name: lineAt(tree.lines, index).name, text: lineAt(tree.lines, index).text })),
            alarms: event.children.filter(child => child.name === 'valarm').map(child => ({ begin: child.begin, end: child.end })),
        };
    });
}

// ---- Editing ----

/** Never set, replaced or removed: identity and structure. */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(['begin', 'end', 'uid', 'recurrence-id']);
/** Replaceable but never removed: a VEVENT without DTSTART does not parse. */
const NOT_REMOVABLE: ReadonlySet<string> = new Set([...FORBIDDEN_NAMES, 'dtstart']);
/** Properties that may legitimately repeat; edited only with `add` and `remove_all`. */
const MULTI_VALUED: ReadonlySet<string> = new Set(['exdate', 'rdate']);
/** Fixed companions removed with their property on any change (design 4.3). */
const PAIRED: Readonly<Record<string, readonly string[]>> = { location: ['x-apple-structured-location'], description: ['x-alt-desc'] };
const NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/u;

type Emit = { kind: 'written'; text: string; change: number | null } | { kind: 'copy'; source: number; change: number | null };
interface Insertion { gap: number; priority: number; sequence: number; emits: Emit[] }

class Planner {
    readonly claimed = new Set<number>();
    readonly replaced = new Map<number, Emit[]>();
    readonly deletedRanges: { begin: number; end: number }[] = [];
    readonly insertions: Insertion[] = [];
    readonly changes: EditChange[] = [];
    readonly removedComponents: { begin: number; end: number }[] = [];

    constructor(readonly tree: Tree) {}

    claim(index: number): void {
        if (this.claimed.has(index)) { throw new IcsEditError('conflicting_edits'); }
        this.claimed.add(index);
    }

    change(action: EditChange['action'], name: string, reason: EditChange['reason'], original: number | null): number {
        this.changes.push({ action, name: name.toUpperCase(), reason, original, output: null });
        return this.changes.length - 1;
    }

    replace(index: number, property: WrittenProperty, name: string): void {
        this.claim(index);
        this.replaced.set(index, [{ kind: 'written', text: property.line, change: this.change('replaced', name, 'requested', index) }]);
    }

    remove(index: number, name: string, reason: EditChange['reason']): void {
        this.deleteRange(index, index);
        this.change('removed', name, reason, index);
    }

    deleteRange(begin: number, end: number): void {
        for (let index = begin; index <= end; index++) { this.claim(index); }
        this.deletedRanges.push({ begin, end });
    }

    insert(gap: number, priority: number, emits: Emit[]): void {
        this.insertions.push({ gap, priority, sequence: this.insertions.length, emits });
    }
}

function writtenProperty(value: unknown): WrittenProperty {
    if (!isWrittenProperty(value)) { throw new IcsEditError('value_not_written'); }
    return value;
}

function editName(raw: unknown): string {
    if (typeof raw !== 'string' || !NAME_RE.test(raw)) { throw new IcsEditError('edit_not_allowed'); }
    return raw.toLowerCase();
}

function applyComponentEdits(planner: Planner, target: ComponentNode, edits: readonly ComponentEdit[]): void {
    const { tree } = planner;
    const editedNames = new Map<string, 'single' | 'add'>();
    const claimName = (name: string, mode: 'single' | 'add'): void => {
        const previous = editedNames.get(name);
        if (previous !== undefined && (previous !== 'add' || mode !== 'add')) { throw new IcsEditError('conflicting_edits'); }
        editedNames.set(name, mode);
    };
    const occurrences = (name: string): number[] => directLines(tree, target, name);
    const single = (name: string): number | null => {
        const found = occurrences(name);
        if (found.length > 1) { throw new IcsEditError('duplicate_property'); }
        return found[0] ?? null;
    };
    const firstChild = target.children[0];
    const propertyGap = firstChild === undefined ? target.end : firstChild.begin;
    const removePaired = (name: string): void => {
        for (const companion of PAIRED[name] ?? []) {
            claimName(companion, 'single');
            const index = single(companion);
            if (index !== null) { planner.remove(index, companion, 'paired'); }
        }
    };
    let alarmsRemoved = false;

    for (const edit of edits) {
        if (typeof edit !== 'object' || edit === null) { throw new IcsEditError('edit_not_allowed'); }
        switch (edit.op) {
            case 'set':
            case 'replace': {
                const property = writtenProperty(edit.property);
                const name = editName(property.name);
                if (FORBIDDEN_NAMES.has(name) || MULTI_VALUED.has(name)) { throw new IcsEditError('edit_not_allowed'); }
                claimName(name, 'single');
                const index = single(name);
                if (index !== null) {
                    planner.replace(index, property, name);
                } else if (edit.op === 'replace') {
                    throw new IcsEditError('property_absent');
                } else {
                    planner.insert(propertyGap, 0, [{ kind: 'written', text: property.line, change: planner.change('added', name, 'requested', null) }]);
                }
                removePaired(name);
                break;
            }
            case 'remove': {
                const name = editName(edit.name);
                if (NOT_REMOVABLE.has(name) || MULTI_VALUED.has(name)) { throw new IcsEditError('edit_not_allowed'); }
                claimName(name, 'single');
                const index = single(name);
                if (index !== null) { planner.remove(index, name, 'requested'); }
                removePaired(name);
                break;
            }
            case 'remove_all': {
                const name = editName(edit.name);
                if (!MULTI_VALUED.has(name)) { throw new IcsEditError('edit_not_allowed'); }
                claimName(name, 'single');
                for (const index of occurrences(name)) { planner.remove(index, name, 'requested'); }
                break;
            }
            case 'add': {
                const property = writtenProperty(edit.property);
                const name = editName(property.name);
                if (!MULTI_VALUED.has(name)) { throw new IcsEditError('edit_not_allowed'); }
                claimName(name, 'add');
                const last = occurrences(name).at(-1);
                planner.insert(last === undefined ? propertyGap : last + 1, 0, [{ kind: 'written', text: property.line, change: planner.change('added', name, 'requested', null) }]);
                break;
            }
            case 'remove_alarms': {
                if (alarmsRemoved) { throw new IcsEditError('conflicting_edits'); }
                alarmsRemoved = true;
                for (const child of target.children.filter(node => node.name === 'valarm')) {
                    planner.deleteRange(child.begin, child.end);
                    planner.change('removed', 'VALARM', 'requested', child.begin);
                }
                break;
            }
            case 'add_alarm': {
                if (!isWrittenComponent(edit.alarm) || edit.alarm.name !== 'VALARM') { throw new IcsEditError('value_not_written'); }
                const change = planner.change('added', 'VALARM', 'requested', null);
                planner.insert(target.end, 1, edit.alarm.lines.map((text, position) => ({ kind: 'written', text, change: position === 0 ? change : null })));
                break;
            }
            default:
                throw new IcsEditError('edit_not_allowed');
        }
    }
}

function applyResourceEdits(planner: Planner, edits: readonly ResourceEdit[]): void {
    const { tree } = planner;
    const copyableLines = new Set<number>();
    const copyableAlarms = new Map<number, ComponentNode>();
    for (const event of tree.events) {
        for (const index of event.direct) { copyableLines.add(index); }
        for (const child of event.children) {
            if (child.name === 'valarm') { copyableAlarms.set(child.begin, child); }
        }
    }
    for (const edit of edits) {
        if (typeof edit !== 'object' || edit === null) { throw new IcsEditError('edit_not_allowed'); }
        if (edit.op === 'remove_component') {
            if (typeof edit.target !== 'object' || edit.target === null || edit.target.kind !== 'override') { throw new IcsEditError('edit_not_allowed'); }
            const node = selectEvent(tree, edit.target);
            planner.deleteRange(node.begin, node.end);
            planner.removedComponents.push({ begin: node.begin, end: node.end });
            planner.change('removed', 'VEVENT', 'requested', node.begin);
        } else if (edit.op === 'add_component') {
            if (!Array.isArray(edit.items)) { throw new IcsEditError('component_invalid'); }
            const change = planner.change('added', 'VEVENT', 'requested', null);
            const emits: Emit[] = [{ kind: 'written', text: 'BEGIN:VEVENT', change }];
            const counts = { uid: 0, rid: 0 };
            const count = (name: string): void => {
                if (name === 'uid') { counts.uid++; }
                if (name === 'recurrence-id') { counts.rid++; }
            };
            for (const item of edit.items as readonly unknown[]) {
                if (isWrittenProperty(item)) {
                    count(item.name.toLowerCase());
                    emits.push({ kind: 'written', text: item.line, change: null });
                } else if (isWrittenComponent(item)) {
                    for (const text of item.lines) { emits.push({ kind: 'written', text, change: null }); }
                } else if (typeof item === 'object' && item !== null && 'copy_line' in item) {
                    const index = item.copy_line;
                    if (typeof index !== 'number' || !copyableLines.has(index)) { throw new IcsEditError('copy_invalid'); }
                    count(lineAt(tree.lines, index).name);
                    emits.push({ kind: 'copy', source: index, change: null });
                } else if (typeof item === 'object' && item !== null && 'copy_component' in item) {
                    const index = item.copy_component;
                    const node = typeof index === 'number' ? copyableAlarms.get(index) : undefined;
                    if (node === undefined) { throw new IcsEditError('copy_invalid'); }
                    for (let source = node.begin; source <= node.end; source++) { emits.push({ kind: 'copy', source, change: null }); }
                } else {
                    throw new IcsEditError('value_not_written');
                }
            }
            if (counts.uid !== 1 || counts.rid !== 1) { throw new IcsEditError('component_invalid'); }
            emits.push({ kind: 'written', text: 'END:VEVENT', change: null });
            planner.insert(tree.root.end, 2, emits);
        } else {
            throw new IcsEditError('edit_not_allowed');
        }
    }
}

function emit(planner: Planner): EditResult {
    const { tree } = planner;
    // Gaps strictly inside a deleted range. Ranges are disjoint (every line is claimed once), so marking them is linear.
    const insideDeleted = new Uint8Array(tree.lines.length + 1);
    for (const range of planner.deletedRanges) {
        for (let gap = range.begin + 1; gap <= range.end; gap++) { insideDeleted[gap] = 1; }
    }
    for (const insertion of planner.insertions) {
        if (insideDeleted[insertion.gap] === 1) { throw new IcsEditError('conflicting_edits'); }
    }
    const byGap = new Map<number, Insertion[]>();
    for (const insertion of planner.insertions) {
        const list = byGap.get(insertion.gap);
        if (list === undefined) { byGap.set(insertion.gap, [insertion]); } else { list.push(insertion); }
    }
    const physical: string[] = [];
    const written: number[] = [];
    const copied: { output: number; original: number }[] = [];
    const removed: number[] = [];
    let output = 0;
    const put = (item: Emit): void => {
        if (item.kind === 'written') {
            for (const part of foldLine(item.text)) { physical.push(part); }
        } else {
            for (const part of lineAt(tree.lines, item.source).physical) { physical.push(part); }
            copied.push({ output, original: item.source });
        }
        const change = item.change === null ? undefined : planner.changes[item.change];
        if (change !== undefined) { change.output = output; }
        written.push(output);
        output++;
    };
    for (let index = 0; index <= tree.lines.length; index++) {
        const pending = (byGap.get(index) ?? []).sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
        for (const insertion of pending) {
            for (const item of insertion.emits) { put(item); }
        }
        if (index === tree.lines.length) { break; }
        const replacement = planner.replaced.get(index);
        if (replacement !== undefined) {
            removed.push(index);
            for (const item of replacement) { put(item); }
        } else if (planner.claimed.has(index)) {
            removed.push(index);
        } else {
            for (const part of lineAt(tree.lines, index).physical) { physical.push(part); }
            output++;
        }
    }
    return {
        text: `${physical.join('\r\n')}\r\n`,
        report: {
            removed,
            written,
            copied,
            targets: [],
            removedComponents: [...planner.removedComponents].sort((a, b) => a.begin - b.begin),
            changes: planner.changes,
        },
    };
}

/**
 * Applies a plan to the original stored text in one pass: one reading of the original, every component's edits planned on
 * it, one emit, one {@link verifyUntouched} and one re-parse of the output (VTIMEZONE count unchanged, VEVENT count as
 * planned), so editing every component of a series is linear in the resource, not quadratic. Throws {@link IcsEditError}
 * (or the caller's BudgetError, see {@link EditOptions}); never returns partially edited text. Those checks prove
 * preservation, not intent: the caller must still run `verifyEditOutcome` (`ics-verify.ts`) with an expectation derived
 * from the request before sending the text.
 */
/** The plan's component edits as one list; the two forms are exclusive. */
function componentPlans(plan: EditPlan): readonly ComponentPlan[] {
    const edits = plan.edits ?? [];
    if (!Array.isArray(edits)) { throw new IcsEditError('edit_not_allowed'); }
    if (plan.targets !== undefined) {
        if (!Array.isArray(plan.targets) || plan.target !== undefined || plan.edits !== undefined) { throw new IcsEditError('edit_not_allowed'); }
        return plan.targets;
    }
    if (plan.target !== undefined) { return [{ target: plan.target, edits }]; }
    if (edits.length > 0) { throw new IcsEditError('target_not_found'); }
    return [];
}

export function editResource(original: string, plan: EditPlan, options: EditOptions = {}): EditResult {
    if (typeof plan !== 'object' || plan === null) { throw new IcsEditError('edit_not_allowed'); }
    const plans = componentPlans(plan);
    const resourceEdits = plan.resource ?? [];
    if (!Array.isArray(resourceEdits)) { throw new IcsEditError('edit_not_allowed'); }
    const tree = readTree(original, options);
    const planner = new Planner(tree);
    const targets: ComponentNode[] = [];
    const selected = new Set<ComponentNode>();
    for (const item of plans) {
        if (typeof item !== 'object' || item === null || !Array.isArray(item.edits)) { throw new IcsEditError('edit_not_allowed'); }
        const target = selectEvent(tree, item.target);
        // Two plans for one component would be two independent edits of the same lines.
        if (selected.has(target)) { throw new IcsEditError('conflicting_edits'); }
        selected.add(target);
        targets.push(target);
        applyComponentEdits(planner, target, item.edits);
    }
    applyResourceEdits(planner, resourceEdits);
    const result = emit(planner);
    const report: EditReport = { ...result.report, targets: targets.map(node => ({ begin: node.begin, end: node.end })).sort((a, b) => a.begin - b.begin) };

    const verdict = verifyUntouched(original, result.text, report);
    if (!verdict.ok) { throw new IcsEditError('output_invalid'); }
    let parsed: OriginalResource;
    try {
        parsed = parseOriginalResource(result.text, parseOptions(options));
    } catch (error) {
        if (error instanceof BudgetError && options.work !== undefined) { throw error; }
        // Over 2 MiB (IcalError) or over the per-resource line or property cap (BudgetError): too large for the read path.
        const tooLarge = (error instanceof IcalError && error.reason === 'resource_too_large') || error instanceof BudgetError;
        throw new IcsEditError(tooLarge ? 'output_too_large' : 'output_invalid');
    }
    const added = resourceEdits.filter(edit => edit.op === 'add_component').length;
    const eventCount = (resource: OriginalResource): number => (resource.master === null ? 0 : 1) + resource.overrides.length;
    if (parsed.vtimezoneCount !== tree.parsed.vtimezoneCount || eventCount(parsed) !== eventCount(tree.parsed) + added - report.removedComponents.length) {
        throw new IcsEditError('output_invalid');
    }
    return { text: result.text, report };
}

// ---- Independent verification ----

export type VerifyFailure =
    | 'line_endings'
    | 'report_invalid'
    | 'untouched_changed'
    | 'line_count'
    | 'written_line_invalid'
    | 'copy_mismatch'
    | 'scope_violation';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure; line: number | null };

/** Counts the scope checks' inner steps, so tests can prove the verification is linear in the number of lines. */
export interface VerifyMeter { steps: number }
export interface VerifyOptions { meter?: VerifyMeter | undefined }

/**
 * A PRESERVATION check only. Proves, without the editor's tree or planner, that every original logical line the report
 * does not list as removed is in the output, in order, with identical physical lines; that the output uses CRLF only; that
 * every written line is folded at 75 octets on code-point boundaries (copies must equal their source exactly); and that
 * removals and writes stay inside the edited components (each a distinct top-level VEVENT kept in the output), whole
 * removed VEVENTs or whole added VEVENTs.
 *
 * It trusts the report for WHAT changed: a written line is accepted whatever it says, so an emit that wrote
 * `ATTENDEE:mailto:…` where `SUMMARY:new` was planned passes here. Intent is checked by `verifyEditOutcome`
 * (`ics-verify.ts`) against an expectation derived from the request, never from this report.
 *
 * Linear: membership of whole spans uses prefix counts, removed components are marked once. `options.meter` counts the
 * steps of those scope checks for tests.
 */
export function verifyUntouched(before: string, after: string, report: EditReport, options: VerifyOptions = {}): VerifyResult {
    const meter = options.meter ?? { steps: 0 };
    const fail = (reason: VerifyFailure, line: number | null = null): VerifyResult => ({ ok: false, reason, line });
    if (typeof before !== 'string' || typeof after !== 'string') { return fail('report_invalid'); }
    if (!after.endsWith('\r\n') || /\r(?!\n)|(?<!\r)\n/u.test(after)) { return fail('line_endings'); }
    if (/\r(?!\n)/u.test(before)) { return fail('line_endings'); }

    const group = (physicalLines: string[]): string[][] => {
        const logical: string[][] = [];
        for (const physical of physicalLines) {
            const last = logical.at(-1);
            if (last !== undefined && (physical.startsWith(' ') || physical.startsWith('\t'))) { last.push(physical); } else { logical.push([physical]); }
        }
        return logical;
    };
    const beforePhysical = before.split(/\r?\n/u);
    if (beforePhysical.at(-1) === '') { beforePhysical.pop(); }
    const oldLines = group(beforePhysical);
    const newLines = group(after.slice(0, -2).split('\r\n'));

    const ascending = (values: unknown, limit: number): values is readonly number[] => Array.isArray(values)
        && values.every((value, index) => Number.isInteger(value) && value >= 0 && value < limit && (index === 0 || value > (values[index - 1] as number)));
    if (typeof report !== 'object' || report === null || !ascending(report.removed, oldLines.length) || !ascending(report.written, newLines.length) || !Array.isArray(report.copied) || !Array.isArray(report.removedComponents)) {
        return fail('report_invalid');
    }
    const removed = new Set(report.removed);
    const written = new Set(report.written);

    // Kept lines, matched in order.
    const keptMap = new Map<number, number>();
    let cursor = 0;
    for (let index = 0; index < oldLines.length; index++) {
        if (removed.has(index)) { continue; }
        while (written.has(cursor)) { cursor++; }
        const kept = newLines[cursor];
        if (kept === undefined) { return fail('line_count', index); }
        const original = oldLines[index] ?? [];
        if (kept.length !== original.length || kept.some((part, position) => part !== original[position])) { return fail('untouched_changed', index); }
        keptMap.set(index, cursor);
        cursor++;
    }
    while (written.has(cursor)) { cursor++; }
    if (cursor !== newLines.length) { return fail('line_count', cursor); }

    // Written lines: legal folds, or exact copies.
    const copies = new Map<number, number>();
    for (const copy of report.copied) {
        if (typeof copy !== 'object' || copy === null || !written.has(copy.output) || !Number.isInteger(copy.original) || copy.original < 0 || copy.original >= oldLines.length) {
            return fail('report_invalid');
        }
        copies.set(copy.output, copy.original);
    }
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    for (const index of report.written) {
        const lines = newLines[index] ?? [];
        const source = copies.get(index);
        if (source !== undefined) {
            const original = oldLines[source] ?? [];
            if (lines.length !== original.length || lines.some((part, position) => part !== original[position])) { return fail('copy_mismatch', index); }
            continue;
        }
        for (const [position, part] of lines.entries()) {
            const bytes = Buffer.from(part, 'utf8');
            let decoded: string;
            try { decoded = utf8.decode(bytes); } catch { return fail('written_line_invalid', index); }
            if (!part.isWellFormed() || decoded !== part || bytes.length > MAX_LINE_OCTETS || (position > 0 && (part.length < 2 || !part.startsWith(' ')))) {
                return fail('written_line_invalid', index);
            }
        }
    }

    // Scope, from an independent BEGIN/END scan of each text.
    const oldShape = nesting(oldLines);
    const newShape = nesting(newLines);
    if (oldShape === null || newShape === null) { return fail('scope_violation'); }
    // Prefix counts make every "is this whole span listed" question O(1), so the scope checks are linear in the line count.
    // (Scanning the span for each of its lines was quadratic: one 49,000-line VALARM cost billions of lookups.)
    const removedBefore = prefixCounts(oldLines.length, report.removed, meter);
    const writtenBefore = prefixCounts(newLines.length, report.written, meter);
    const allIn = (counts: Int32Array, begin: number, end: number): boolean => {
        meter.steps++;
        return begin >= 0 && end >= begin && end + 1 < counts.length && (counts[end + 1] ?? 0) - (counts[begin] ?? 0) === end - begin + 1;
    };
    // The edited components: distinct top-level VEVENTs of the original, each kept (BEGIN and END) in the output.
    if (!Array.isArray(report.targets)) { return fail('report_invalid'); }
    const targetBegins = new Set<number>();
    const keptTargetBegins = new Set<number>();
    for (const target of report.targets as readonly unknown[]) {
        meter.steps++;
        if (typeof target !== 'object' || target === null) { return fail('scope_violation'); }
        const { begin, end } = target as { begin: unknown; end: unknown };
        if (typeof begin !== 'number' || typeof end !== 'number' || targetBegins.has(begin) || !oldShape.isTopLevelEvent(begin) || oldShape.endOf.get(begin) !== end) { return fail('scope_violation'); }
        targetBegins.add(begin);
        const keptBegin = keptMap.get(begin);
        if (keptBegin === undefined || newShape.endOf.get(keptBegin) !== keptMap.get(end)) { return fail('scope_violation'); }
        keptTargetBegins.add(keptBegin);
    }
    // Per original line, whether it lies inside a whole removed VEVENT: marked once per span, never searched per line.
    const inRemovedComponent = new Uint8Array(oldLines.length);
    for (const span of report.removedComponents) {
        if (typeof span !== 'object' || span === null || !oldShape.isTopLevelEvent(span.begin) || oldShape.endOf.get(span.begin) !== span.end || !allIn(removedBefore, span.begin, span.end)) {
            return fail('scope_violation', typeof span === 'object' && span !== null ? span.begin : null);
        }
        // Spans are distinct top-level components, so they never overlap and the marking is linear overall.
        for (let line = span.begin; line <= span.end; line++) { meter.steps++; inRemovedComponent[line] = 1; }
    }
    for (const index of report.removed) {
        meter.steps++;
        if (inRemovedComponent[index] === 1) { continue; }
        // Inside a target: a direct property, or a line of a nested VALARM that is removed whole. Its BEGIN and END stay.
        const top = oldShape.top[index] ?? -1;
        if (!targetBegins.has(top) || index === top || index === oldShape.endOf.get(top)) { return fail('scope_violation', index); }
        const nested = oldShape.nested[index] ?? -1;
        if (nested === -1) { continue; }
        const nestedEnd = oldShape.endOf.get(nested);
        if (oldShape.nameOf.get(nested) !== 'VALARM' || nestedEnd === undefined || !allIn(removedBefore, nested, nestedEnd)) { return fail('scope_violation', index); }
    }
    for (const index of report.written) {
        meter.steps++;
        const top = newShape.top[index] ?? -1;
        // Inside a target's span; its own BEGIN and END are kept lines, never written.
        if (keptTargetBegins.has(top)) { continue; }
        // Elsewhere only as part of a whole top-level VEVENT the editor wrote.
        const end = newShape.endOf.get(top);
        if (top === -1 || !newShape.isTopLevelEvent(top) || end === undefined || !allIn(writtenBefore, top, end)) { return fail('scope_violation', index); }
    }
    return { ok: true };
}

/** `counts[i]` = how many of the ascending, in-range `indices` are below `i`; length `size + 1`. */
function prefixCounts(size: number, indices: readonly number[], meter: VerifyMeter): Int32Array {
    const marks = new Uint8Array(size);
    for (const index of indices) { marks[index] = 1; }
    const counts = new Int32Array(size + 1);
    for (let line = 0; line < size; line++) {
        meter.steps++;
        counts[line + 1] = (counts[line] ?? 0) + (marks[line] ?? 0);
    }
    return counts;
}

interface Nesting {
    /** Per logical line, the BEGIN index of the top-level component that contains it (its own index for that BEGIN), or -1. */
    top: number[];
    /** Per logical line, the BEGIN index of the component nested directly in its top-level component, or -1. */
    nested: number[];
    endOf: Map<number, number>;
    nameOf: Map<number, string>;
    isTopLevelEvent: (begin: number) => boolean;
}

/** BEGIN/END structure of grouped logical lines, written separately from the editor's tree. Null when unbalanced. */
function nesting(lines: readonly (readonly string[])[]): Nesting | null {
    const stack: number[] = [];
    const top: number[] = [];
    const nested: number[] = [];
    const endOf = new Map<number, number>();
    const nameOf = new Map<number, string>();
    const depthOf = new Map<number, number>();
    for (const [index, physical] of lines.entries()) {
        const text = physical.map((part, position) => (position === 0 ? part : part.slice(1))).join('');
        const colon = text.indexOf(':');
        const head = (colon < 0 ? text : text.slice(0, colon)).toUpperCase();
        const value = colon < 0 ? '' : text.slice(colon + 1).toUpperCase();
        if (head === 'BEGIN') {
            depthOf.set(index, stack.length);
            nameOf.set(index, value);
            stack.push(index);
        }
        top.push(stack[1] ?? -1);
        nested.push(stack[2] ?? -1);
        if (head === 'END') {
            const begin = stack.pop();
            if (begin === undefined || nameOf.get(begin) !== value) { return null; }
            endOf.set(begin, index);
        }
    }
    if (stack.length > 0) { return null; }
    return { top, nested, endOf, nameOf, isTopLevelEvent: begin => depthOf.get(begin) === 1 && nameOf.get(begin) === 'VEVENT' };
}
