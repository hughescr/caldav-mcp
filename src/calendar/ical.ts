/**
 * The only module that may import ical.js, and only `ICAL.parse` (jCal arrays). No ICAL.Component, Time, Timezone or Event, no
 * hydration and no iterators: the jCal is validated here as untrusted data. VTIMEZONE components are counted and ignored, so
 * a hostile embedded rule can never be evaluated. The ban is enforced by `.oxlintrc.json` and tests/calendar-api-ban.test.ts.
 */
import ICAL from 'ical.js';
import { describeComponentAttachments, parseContentLine, prescanAttachProperties, unfoldLines, type AttachPrescan } from './attachments';
import { createReadBudget, type ResourceWork } from './budget';
import { MAX_EXPANDED_VEVENTS_PER_CALENDAR, MAX_ICS_NESTING, MAX_ORIGINAL_VEVENTS, MAX_PARAMETERS_PER_PROPERTY, MAX_RESOURCE_BYTES } from './limits';
import {
    IcalError, type AttachmentDescriptor, type EventComponent, type ExpandedResource, type JCalValue, type OriginalResource, type RawProperty, type RecurrenceIdInfo, type StoredTime,
} from './model';
import { eventSpan, occurrenceIdFromRecurrenceId, storedTimeFromJcal } from './time-core';

export interface ParseOptions {
    /** Charges lines and properties; throws BudgetError when a shared or per-resource cap is exceeded. */
    work?: ResourceWork;
}

const MALFORMED = 'malformed';
const MAX_VEVENTS_READ = Math.max(MAX_ORIGINAL_VEVENTS, MAX_EXPANDED_VEVENTS_PER_CALENDAR);

// ---- Untrusted jCal validation ----

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJCalValue(value: unknown, depth: number): JCalValue {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return value; }
    if (depth >= MAX_ICS_NESTING) { throw new IcalError(MALFORMED); }
    if (Array.isArray(value)) { return value.map(item => toJCalValue(item, depth + 1)); }
    if (isRecord(value)) { return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJCalValue(item, depth + 1)])); }
    throw new IcalError(MALFORMED);
}

function readParameters(raw: unknown): Map<string, string[]> {
    if (!isRecord(raw)) { throw new IcalError(MALFORMED); }
    const entries = Object.entries(raw);
    if (entries.length > MAX_PARAMETERS_PER_PROPERTY) { throw new IcalError(MALFORMED); }
    const params = new Map<string, string[]>();
    for (const [key, value] of entries) {
        let values: string[];
        if (typeof value === 'string') {
            values = [value];
        } else if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
            values = [...value];
        } else {
            throw new IcalError(MALFORMED);
        }
        const name = key.toLowerCase();
        params.set(name, [...(params.get(name) ?? []), ...values]);
    }
    return params;
}

function readProperty(raw: unknown): RawProperty {
    if (!Array.isArray(raw) || raw.length < 4) { throw new IcalError(MALFORMED); }
    const items: unknown[] = raw;
    const [name, params, type, ...values] = items;
    if (typeof name !== 'string' || name === '' || typeof type !== 'string') { throw new IcalError(MALFORMED); }
    return { name: name.toLowerCase(), params: readParameters(params), type, values: values.map(value => toJCalValue(value, 0)) };
}

interface ComponentShape { name: string; properties: unknown[]; children: unknown[] }

function readShape(raw: unknown): ComponentShape {
    if (!Array.isArray(raw) || raw.length !== 3) { throw new IcalError(MALFORMED); }
    const items: unknown[] = raw;
    const [name, properties, children] = items;
    if (typeof name !== 'string' || !Array.isArray(properties) || !Array.isArray(children)) { throw new IcalError(MALFORMED); }
    return { name: name.toLowerCase(), properties, children };
}

// ---- Resource-level reading ----

interface ParsedEvent { properties: RawProperty[]; alarmCount: number }
interface ParsedResource { events: ParsedEvent[]; vtimezoneCount: number }

function countLines(text: string): number {
    let lines = 1;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === 0x0A || (code === 0x0D && text.charCodeAt(index + 1) !== 0x0A)) { lines++; }
    }
    return lines;
}

const TIME_PROPERTIES = new Set(['dtstart', 'dtend', 'recurrence-id', 'due', 'dtstamp', 'created', 'completed', 'last-modified']);

/** Validate source spelling before ical.js can repair it by slicing fixed positions. */
function validateTimeLiteral(line: NonNullable<ReturnType<typeof parseContentLine>>): void {
    if (!TIME_PROPERTIES.has(line.name) && !(line.name === 'trigger' && line.parameters.get('value')?.[0]?.toUpperCase() === 'DATE-TIME')) { return; }
    const types = line.parameters.get('value');
    if (types !== undefined && types.length !== 1) { throw new IcalError(MALFORMED); }
    const type = (types?.[0] ?? 'DATE-TIME').toUpperCase();
    const value = line.value;
    const date = type === 'DATE';
    if (!(date ? /^\d{8}$/u : /^\d{8}T\d{6}Z?$/u).test(value) || (!date && type !== 'DATE-TIME')) { throw new IcalError(MALFORMED); }
    const civil = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    const jcal = date ? civil : `${civil}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}${value.endsWith('Z') ? 'Z' : ''}`;
    if (storedTimeFromJcal(date ? 'date' : 'date-time', jcal, undefined) === null) { throw new IcalError(MALFORMED); }
}

/** Bounded linear lexical pass, including ignored components and duplicate parameter names. */
function preflight(calendarData: string, work: ResourceWork): void {
    work.chargeLines(countLines(calendarData));
    const stack: string[] = [];
    let properties = 0;
    try {
        for (const text of unfoldLines(calendarData)) {
            if (text === '') { continue; }
            const line = parseContentLine(text);
            if (line === null) { throw new IcalError(MALFORMED); }
            if (line.name === 'begin') {
                if (stack.length >= MAX_ICS_NESTING) { throw new IcalError(MALFORMED); }
                stack.push(line.value.toLowerCase());
            } else if (line.name === 'end') {
                if (stack.pop() !== line.value.toLowerCase()) { throw new IcalError(MALFORMED); }
            } else {
                properties++;
                validateTimeLiteral(line);
            }
        }
        if (stack.length !== 0) { throw new IcalError(MALFORMED); }
    } finally {
        // Charge once before ICAL.parse, including work consumed by a malformed resource. Lines already bound this pass.
        work.chargeProperties(properties);
    }
}

/** ICAL.parse is the only ical.js call. Its error messages quote input lines, so a failure is discarded, never forwarded. */
function parseJcal(calendarData: string): unknown {
    try {
        return ICAL.parse(calendarData);
    } catch {
        throw new IcalError(MALFORMED);
    }
}

/**
 * `versionRequired` is true for original resources. iCloud's expanded REPORT omits VERSION and PRODID from the VCALENDAR
 * (measured), so there VERSION is optional; when present it must still be exactly one `2.0`. PRODID is never required and
 * VCALENDAR-level extension properties (X-EXPANDED, X-MASTER-*) are ignored.
 */
function readResource(calendarData: string, work: ResourceWork, versionRequired: boolean): ParsedResource {
    // Every UTF-8 byte is at least one UTF-16 unit, and at most three: only the ambiguous middle needs an exact count.
    if (calendarData.length > MAX_RESOURCE_BYTES || (calendarData.length * 3 > MAX_RESOURCE_BYTES && Buffer.byteLength(calendarData, 'utf8') > MAX_RESOURCE_BYTES)) {
        throw new IcalError('resource_too_large');
    }
    preflight(calendarData, work);
    const root = readShape(parseJcal(calendarData));
    if (root.name !== 'vcalendar') { throw new IcalError(MALFORMED); }
    const versions = root.properties.map(readProperty).filter(property => property.name === 'version');
    const version = versions[0];
    if (versions.length > 1 || (versions.length === 0 && versionRequired)) { throw new IcalError(MALFORMED); }
    if (version !== undefined && (version.values.length !== 1 || version.values[0] !== '2.0')) { throw new IcalError(MALFORMED); }

    const events: ParsedEvent[] = [];
    let vtimezoneCount = 0;
    for (const child of root.children) {
        const shape = readShape(child);
        if (shape.name === 'vtimezone') {
            // After lexical safety checks, ignore the jCal properties and rules; no timezone evaluation.
            vtimezoneCount++;
            continue;
        }
        if (shape.name !== 'vevent') { continue; }
        // Bounds the work before the per-kind caps below: no resource may hold more VEVENTs than either kind allows.
        if (events.length >= MAX_VEVENTS_READ) { throw new IcalError('resource_too_large'); }
        let alarmCount = 0;
        for (const nested of shape.children) {
            const nestedShape = readShape(nested);
            if (nestedShape.name === 'vevent' || nestedShape.name === 'vcalendar' || nestedShape.name === 'vtimezone') { throw new IcalError(MALFORMED); }
            if (nestedShape.name === 'valarm') { alarmCount++; }
        }
        events.push({ properties: shape.properties.map(readProperty), alarmCount });
    }
    return { events, vtimezoneCount };
}

// ---- One VEVENT ----

function singleProperty(map: ReadonlyMap<string, readonly RawProperty[]>, name: string): RawProperty | null {
    const list = map.get(name);
    if (list === undefined) { return null; }
    if (list.length !== 1) { throw new IcalError(MALFORMED); }
    return list[0] ?? null;
}

function stringValue(property: RawProperty): string {
    const value = property.values[0];
    if (property.values.length !== 1 || typeof value !== 'string') { throw new IcalError(MALFORMED); }
    return value;
}

function storedTime(property: RawProperty): StoredTime {
    const tzids = property.params.get('tzid');
    if (tzids !== undefined && tzids.length !== 1) { throw new IcalError(MALFORMED); }
    const stored = storedTimeFromJcal(property.type, stringValue(property), tzids?.[0]);
    if (stored === null) { throw new IcalError(MALFORMED); }
    return stored;
}

function recurrenceIdInfo(property: RawProperty): RecurrenceIdInfo {
    const time = storedTime(property);
    return { raw: property, time, token: occurrenceIdFromRecurrenceId(property.type, stringValue(property), property.params.size > 0) };
}

function buildEvent(parsed: ParsedEvent, scans: readonly AttachPrescan[] | null, expanded: boolean): EventComponent {
    const properties = new Map<string, RawProperty[]>();
    for (const property of parsed.properties) {
        const list = properties.get(property.name);
        if (list === undefined) { properties.set(property.name, [property]); } else { list.push(property); }
    }
    const uidProperty = singleProperty(properties, 'uid');
    const startProperty = singleProperty(properties, 'dtstart');
    if (uidProperty === null || startProperty === null) { throw new IcalError(MALFORMED); }
    const uid = stringValue(uidProperty);
    if (uid === '') { throw new IcalError(MALFORMED); }
    const endProperty = singleProperty(properties, 'dtend');
    const durationProperty = singleProperty(properties, 'duration');
    const ridProperty = singleProperty(properties, 'recurrence-id');

    const start = storedTime(startProperty);
    const end = endProperty === null ? null : storedTime(endProperty);
    const duration = durationProperty === null ? null : stringValue(durationProperty);
    const recurrenceId = ridProperty === null ? null : recurrenceIdInfo(ridProperty);
    // Structural validity only: literal civil order, DATE/timed mixes, DTEND with DURATION. A surprising UTC order is not an error.
    eventSpan(start, end, duration);

    const retainsRecurrenceRules = properties.has('rrule') || properties.has('rdate') || properties.has('exdate');
    if (expanded) {
        // T0-DECISION: a structurally valid but non-server-form expanded RID is unsupported, never a guessed token.
        if (retainsRecurrenceRules) { throw new IcalError('unsupported_recurrence_data'); }
        if (recurrenceId !== null && recurrenceId.token === null) { throw new IcalError('unsupported_recurrence_id'); }
    }

    let attachments: AttachmentDescriptor[] = [];
    if (scans !== null) {
        const direct = properties.get('attach')?.length ?? 0;
        // The pre-scan and the jCal read the same text; a different count means they disagree about the structure.
        if (direct !== scans.length) { throw new IcalError(MALFORMED); }
        attachments = describeComponentAttachments(scans, recurrenceId === null ? 'master' : 'override', ridProperty);
    }

    let extensionPropertyCount = 0;
    for (const [name, list] of properties) {
        if (name.startsWith('x-')) { extensionPropertyCount += list.length; }
    }
    return { uid, start, end, duration, recurrenceId, properties, alarmCount: parsed.alarmCount, extensionPropertyCount, attachments, retainsRecurrenceRules };
}

function singleUid(components: readonly EventComponent[]): void {
    if (new Set(components.map(component => component.uid)).size > 1) { throw new IcalError(MALFORMED); }
}

/** Identity of an original RECURRENCE-ID: the raw tuple, so two components with the same one are indistinguishable. */
function ridKey(info: RecurrenceIdInfo): string {
    return JSON.stringify([[...info.raw.params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), info.raw.type, info.raw.values]);
}

/**
 * Parses one expanded REPORT resource. VERSION is optional (VERSION:2.0 if present) and valid singleton VEVENT structure; expanded
 * resources need no master. Throws IcalError for a malformed or unsupported resource; ignores VTIMEZONE structurally.
 */
export function parseExpandedResource(calendarData: string, options: ParseOptions): ExpandedResource {
    const parsed = readResource(calendarData, options.work ?? createReadBudget().newResourceWork(), false);
    if (parsed.events.length === 0) { throw new IcalError(MALFORMED); }
    if (parsed.events.length > MAX_EXPANDED_VEVENTS_PER_CALENDAR) { throw new IcalError('resource_too_large'); }
    const components = parsed.events.map(event => buildEvent(event, null, true));
    singleUid(components);
    const tokens = components.flatMap(component => (component.recurrenceId?.token === null || component.recurrenceId === null ? [] : [component.recurrenceId.token]));
    if (new Set(tokens).size !== tokens.length) { throw new IcalError(MALFORMED); }
    return { components, vtimezoneCount: parsed.vtimezoneCount };
}

/**
 * Parses one original multiget resource into master/single/occurrence-only form with overrides, rejecting duplicate UID,
 * DTSTART, DTEND, DURATION and RECURRENCE-ID, multiple masters, conflicting end/duration and malformed nesting.
 */
export function parseOriginalResource(calendarData: string, options: ParseOptions): OriginalResource {
    const parsed = readResource(calendarData, options.work ?? createReadBudget().newResourceWork(), true);
    if (parsed.events.length === 0) { throw new IcalError(MALFORMED); }
    if (parsed.events.length > MAX_ORIGINAL_VEVENTS) { throw new IcalError('resource_too_large'); }
    const scansByComponent = new Map<number, AttachPrescan[]>();
    for (const scan of prescanAttachProperties(calendarData)) {
        const list = scansByComponent.get(scan.componentIndex);
        if (list === undefined) { scansByComponent.set(scan.componentIndex, [scan]); } else { list.push(scan); }
    }
    const components = parsed.events.map((event, index) => buildEvent(event, scansByComponent.get(index) ?? [], false));
    singleUid(components);

    const masters = components.filter(component => component.recurrenceId === null);
    const overrides = components.filter(component => component.recurrenceId !== null);
    if (masters.length > 1) { throw new IcalError(MALFORMED); }
    const keys = overrides.flatMap(component => (component.recurrenceId === null ? [] : [ridKey(component.recurrenceId)]));
    if (new Set(keys).size !== keys.length) { throw new IcalError(MALFORMED); }

    const master = masters[0] ?? null;
    if (master === null) { return { kind: 'occurrence_only', master: null, overrides, vtimezoneCount: parsed.vtimezoneCount }; }
    const kind = overrides.length > 0 || master.retainsRecurrenceRules ? 'series' : 'single';
    return { kind, master, overrides, vtimezoneCount: parsed.vtimezoneCount };
}
