/**
 * Comparison of requested values with the RAW stored resource (ORCH S3; design 4.5 and 5.4), not with the presentation
 * shape. A requested property is "as requested" when the stored component has exactly one logical line of that name and
 * its text equals the line this server wrote, after unfolding and line-ending normalisation (property and parameter text
 * compared exactly, the name case-insensitively); a requested removal when no line of that name is left. Alarms compare
 * the multiset of TRIGGER lines of the component's VALARMs only, nothing else of an alarm.
 *
 * The reader here is deliberately small and independent of the editor and the verifier: it only splits logical lines and
 * nests BEGIN/END. Text that does not nest is unreadable (null), which callers treat as "not as requested".
 */
import type { StoredField } from './write-schemas';

export interface StoredLine {
    /** Upper-case property name as written (group prefix included). */
    readonly name: string;
    /** The unfolded logical line with the name upper-cased. */
    readonly text: string;
}

export interface StoredEvent {
    /** The unfolded RECURRENCE-ID line (name upper-cased), or null for the master or a single event. */
    readonly rid: string | null;
    /** Direct property lines, in order. */
    readonly lines: readonly StoredLine[];
    /** TRIGGER lines (unfolded, name upper-cased) of the directly nested VALARMs. */
    readonly triggers: readonly string[];
}

function logicalLines(text: string): string[] | null {
    if (/\r(?!\n)/u.test(text)) { return null; }
    const physical = text.split(/\r?\n/u);
    if (physical.at(-1) === '') { physical.pop(); }
    const logical: string[] = [];
    for (const line of physical) {
        if (line.startsWith(' ') || line.startsWith('\t')) {
            if (logical.length === 0) { return null; }
            logical[logical.length - 1] += line.slice(1);
        } else if (line !== '') {
            logical.push(line);
        }
    }
    return logical;
}

function nameOf(line: string): string | null {
    const end = line.search(/[;:]/u);
    return end < 1 ? null : line.slice(0, end).toUpperCase();
}

/** An unfolded logical line with its property name upper-cased, the form every comparison here uses. */
export function normaliseLine(line: string): string {
    const name = nameOf(line);
    return name === null ? line : `${name}${line.slice(name.length)}`;
}

/** The top-level VEVENTs of a stored resource, or null when its lines do not nest. */
export function storedEvents(text: string): StoredEvent[] | null {
    const lines = logicalLines(text);
    if (lines === null) { return null; }
    const events: StoredEvent[] = [];
    const stack: string[] = [];
    let current: { rid: string | null; lines: StoredLine[]; triggers: string[] } | null = null;
    for (const line of lines) {
        const name = nameOf(line);
        if (name === null) { return null; }
        const normalised = `${name}${line.slice(name.length)}`;
        if (name === 'BEGIN' || name === 'END') {
            const component = line.slice(name.length + 1).toUpperCase();
            if (name === 'BEGIN') {
                stack.push(component);
                if (stack.length === 2 && component === 'VEVENT') { current = { rid: null, lines: [], triggers: [] }; }
            } else {
                if (stack.pop() !== component) { return null; }
                if (stack.length === 1 && component === 'VEVENT' && current !== null) {
                    events.push(current);
                    current = null;
                }
            }
            continue;
        }
        if (current === null) { continue; }
        if (stack.length === 2) {
            current.lines.push({ name, text: normalised });
            if (name === 'RECURRENCE-ID') { current.rid = normalised; }
        } else if (stack.length === 3 && stack[2] === 'VALARM' && name === 'TRIGGER') {
            current.triggers.push(normalised);
        }
    }
    return stack.length === 0 ? events : null;
}

/** One requested property: the line this server writes, or null for a removal. */
export interface FieldLine {
    readonly field: StoredField;
    /** Upper-case property name. */
    readonly name: string;
    readonly line: string | null;
}

/** What one component should hold after the request. */
export interface ComponentRequest {
    /** The RECURRENCE-ID line of the target override, or null for the master. */
    readonly rid: string | null;
    readonly fields: readonly FieldLine[];
    /** The TRIGGER lines the alarms should have (empty: no alarm), or undefined when alarms were not requested. */
    readonly triggers?: readonly string[] | undefined;
    /** Names that must be absent afterwards (the Apple companions a LOCATION or DESCRIPTION change removes). */
    readonly absent?: readonly string[] | undefined;
}

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
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

/** The requested fields of one component that the stored component does not hold as requested, in request order. */
export function differingFields(stored: StoredEvent | undefined, request: ComponentRequest): StoredField[] {
    const differs: StoredField[] = [];
    for (const field of request.fields) {
        const lines = stored?.lines.filter(line => line.name === field.name).map(line => line.text) ?? null;
        const ok = lines !== null && (field.line === null ? lines.length === 0 : lines.length === 1 && lines[0] === field.line);
        if (!ok && !differs.includes(field.field)) { differs.push(field.field); }
    }
    if (request.triggers !== undefined && (stored === undefined || !sameMultiset(stored.triggers, request.triggers))) { differs.push('alarms'); }
    return differs;
}

/** The stored component for a request: the master (no RECURRENCE-ID) or the override with that exact RECURRENCE-ID line. */
export function storedComponent(events: readonly StoredEvent[], rid: string | null): StoredEvent | undefined {
    const matches = events.filter(event => event.rid === rid);
    return matches.length === 1 ? matches[0] : undefined;
}

/**
 * What the stored resource must hold after a request:
 * - `components`: each request in the component it names (the master, or the override with that RECURRENCE-ID line);
 * - `every_event`: the same request in EVERY VEVENT of the resource as it is now (`edit_scope: "all"`), so a component another
 *   client added since the original was read counts too. The `rid` of the request is ignored.
 */
export type StoredExpectation =
    | { readonly kind: 'components'; readonly requests: readonly ComponentRequest[] }
    | { readonly kind: 'every_event'; readonly request: ComponentRequest };

function holdsIn(stored: StoredEvent, request: ComponentRequest): boolean {
    return differingFields(stored, request).length === 0 && (request.absent ?? []).every(name => !stored.lines.some(line => line.name === name));
}

/**
 * Every requested field as requested and every required absence absent. For `every_event` the component set must also be
 * reconcilable: exactly one master and no two components with the same RECURRENCE-ID line; otherwise it does not hold.
 */
export function holdsExpectation(events: readonly StoredEvent[] | null, expectation: StoredExpectation): boolean {
    if (events === null) { return false; }
    if (expectation.kind === 'components') {
        return expectation.requests.every(request => {
            const stored = storedComponent(events, request.rid);
            return stored !== undefined && holdsIn(stored, request);
        });
    }
    const rids = events.map(event => event.rid);
    if (rids.filter(rid => rid === null).length !== 1 || new Set(rids).size !== rids.length) { return false; }
    return events.every(event => holdsIn(event, expectation.request));
}

/** The requested fields the stored resource does not hold as requested (unordered, without duplicates). */
export function storedDifferences(events: readonly StoredEvent[] | null, expectation: StoredExpectation): StoredField[] {
    const fields = new Set<StoredField>();
    if (expectation.kind === 'components') {
        for (const request of expectation.requests) {
            for (const field of differingFields(events === null ? undefined : storedComponent(events, request.rid), request)) { fields.add(field); }
        }
    } else if (events === null || events.length === 0) {
        for (const field of differingFields(undefined, expectation.request)) { fields.add(field); }
    } else {
        for (const event of events) {
            for (const field of differingFields(event, expectation.request)) { fields.add(field); }
        }
    }
    return [...fields];
}
