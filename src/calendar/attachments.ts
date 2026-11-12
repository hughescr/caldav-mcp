/**
 * Attachment metadata and reference indexing (design v3 section 5). Metadata never exposes URLs or bytes. ATTACH lines are
 * pre-scanned from the raw text because jCal keeps only the last value of a duplicated parameter.
 */
import { createHash } from 'node:crypto';
import type { AttachmentMetadata } from './event-schemas';
import { FILENAME_MAX, MAX_PARAMETERS_PER_PROPERTY, MAX_UNFOLDED_LINE_BYTES, MIME_MAX } from './limits';
import { IcalError, type AttachmentDescriptor, type AttachmentForm, type OriginalResource, type RawProperty } from './model';
import { sanitizeDisplayText } from './normalize';
import { storedTimeFromJcal, toEventTime } from './time-core';

/** One raw ATTACH content line, pre-scanned from the unfolded source before ICAL.parse collapses duplicate parameters. */
export interface AttachPrescan {
    /** Index of the owning VEVENT among the resource's VEVENTs, in source order. */
    componentIndex: number;
    /** Lower-case parameter names to every value in source order, duplicates preserved. */
    parameters: ReadonlyMap<string, readonly string[]>;
    valueText: string;
}

// ---- Pre-scan ----

/** Unfolds content lines: a physical line starting with SPACE or TAB continues the previous one. */
export function* unfoldLines(text: string): Generator<string> {
    let parts: string[] = [];
    let length = 0;
    const finish = (): string => {
        const line = parts.join('');
        if (Buffer.byteLength(line, 'utf8') > MAX_UNFOLDED_LINE_BYTES) { throw new IcalError('resource_too_large'); }
        return line;
    };
    for (const physical of text.split(/\r\n|\n|\r/u)) {
        const continuation = parts.length > 0 && (physical.startsWith(' ') || physical.startsWith('\t'));
        if (!continuation && parts.length > 0) {
            yield finish();
            parts = [];
            length = 0;
        }
        const part = continuation ? physical.slice(1) : physical;
        length += part.length;
        if (length > MAX_UNFOLDED_LINE_BYTES) { throw new IcalError('resource_too_large'); }
        parts.push(part);
    }
    if (parts.length > 0) { yield finish(); }
}

/** RFC 6868 parameter-value decoding, as the jCal parser applies it. */
function decodeParameterValue(raw: string): string {
    return raw.replaceAll(/\^([n'^])/gu, (_match, code: string) => (code === 'n' ? '\n' : code === "'" ? '"' : '^'));
}

// These are the RFC 5545 parameters whose separately quoted lists ical.js 2.2.1 recognizes.
// Other quoted-list spellings can expose apparent value text as parameters to that parser.
const QUOTED_PARAMETER_LISTS = new Set(['member', 'delegated-from', 'delegated-to']);

interface ParsedLine {
    name: string;
    parameters: Map<string, string[]>;
    value: string;
}

/** Splits one unfolded content line. Null when it has no name or no value separator. */
export function parseContentLine(line: string): ParsedLine | null {
    let index = 0;
    while (index < line.length && line[index] !== ':' && line[index] !== ';') { index++; }
    if (index === 0 || index >= line.length) { return null; }
    const name = line.slice(0, index).toLowerCase();
    const parameters = new Map<string, string[]>();
    let parameterCount = 0;
    while (line[index] === ';') {
        if (++parameterCount > MAX_PARAMETERS_PER_PROPERTY) { throw new IcalError('malformed'); }
        index++;
        const nameStart = index;
        while (index < line.length && line[index] !== '=' && line[index] !== ':' && line[index] !== ';') { index++; }
        const parameterName = line.slice(nameStart, index).toLowerCase();
        if (parameterName === '' || line[index] !== '=') { return null; }
        const values: string[] = [];
        if (line[index] === '=') {
            index++;
            let quotedList = false;
            for (;;) {
                let value: string;
                if (line[index] === '"') {
                    // Fail closed on syntax where our parameter boundaries would differ from ICAL.parse's.
                    if (values.length > 0 && (!quotedList || !QUOTED_PARAMETER_LISTS.has(parameterName))) { return null; }
                    quotedList = true;
                    const close = line.indexOf('"', index + 1);
                    if (close === -1) { return null; }
                    value = line.slice(index + 1, close);
                    index = close + 1;
                } else {
                    if (quotedList) { return null; }
                    const start = index;
                    while (index < line.length && line[index] !== ',' && line[index] !== ';' && line[index] !== ':') {
                        if (line[index] === '"') { return null; }
                        index++;
                    }
                    value = line.slice(start, index);
                }
                values.push(decodeParameterValue(value));
                if (line[index] === ',') { index++; continue; }
                break;
            }
        }
        if (parameterName !== '') {
            const accumulated = parameters.get(parameterName);
            if (accumulated === undefined) { parameters.set(parameterName, values); } else {
                for (const value of values) { accumulated.push(value); }
            }
        }
    }
    if (line[index] !== ':') { return null; }
    return { name, parameters, value: line.slice(index + 1) };
}

/** Pre-scans unfolded raw ATTACH lines. Duplicate ENCODING/VALUE/FMTTYPE or conflicting structure marks the attachment unsupported. */
export function prescanAttachProperties(calendarData: string): readonly AttachPrescan[] {
    const scans: AttachPrescan[] = [];
    const stack: string[] = [];
    let eventIndex = -1;
    for (const line of unfoldLines(calendarData)) {
        // Only structure and ATTACH lines are worth a full parse; every other property is skipped by its name alone.
        const nameEnd = line.search(/[:;]/u);
        const lineName = nameEnd < 0 ? '' : line.slice(0, nameEnd).toLowerCase();
        if (lineName !== 'begin' && lineName !== 'end' && lineName !== 'attach') { continue; }
        const parsed = parseContentLine(line);
        if (parsed === null) { continue; }
        if (parsed.name === 'begin') {
            const component = parsed.value.trim().toLowerCase();
            stack.push(component);
            if (component === 'vevent') { eventIndex++; }
        } else if (parsed.name === 'end') {
            stack.pop();
        } else if (parsed.name === 'attach' && stack.at(-1) === 'vevent') {
            scans.push({ componentIndex: eventIndex, parameters: parsed.parameters, valueText: parsed.value });
        }
    }
    return scans;
}

// ---- Descriptors ----

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Canonical alphabet and padding, with zero trailing bits, so one byte string has exactly one accepted encoding. */
function isCanonicalBase64(text: string): boolean {
    if (!BASE64_RE.test(text)) { return false; }
    if (text.endsWith('==')) { return (BASE64_ALPHABET.indexOf(text.charAt(text.length - 3)) & 0x0F) === 0; }
    if (text.endsWith('=')) { return (BASE64_ALPHABET.indexOf(text.charAt(text.length - 2)) & 0x03) === 0; }
    return true;
}

function sha256Hex(parts: readonly unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Parameter names sorted by code point with every value in source order: the raw tuple used for identity. */
function sortedParameters(parameters: ReadonlyMap<string, readonly string[]>): [string, readonly string[]][] {
    return [...parameters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function only(parameters: ReadonlyMap<string, readonly string[]>, name: string): string | null {
    const values = parameters.get(name);
    return values !== undefined && values.length === 1 ? (values[0] ?? null) : null;
}

/** SIZE must be a canonical safe non-negative integer; anything else is no claim. */
function canonicalSize(text: string | null): number | null {
    if (text === null || !/^(?:0|[1-9]\d{0,15})$/u.test(text)) { return null; }
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : null;
}

function describe(scan: AttachPrescan, component: 'master' | 'override', recurrenceId: RawProperty | null): Omit<AttachmentDescriptor, 'ordinal'> {
    const parameters = scan.parameters;
    const valueParam = parameters.get('value');
    const encoding = parameters.get('encoding');
    const valueType = valueParam !== undefined && valueParam.length === 1 ? (valueParam[0] ?? '').toLowerCase() : 'uri';
    const inline = (valueParam?.some(value => value.toUpperCase() === 'BINARY') ?? false) || encoding !== undefined;
    const managedParam = parameters.get('managed-id');
    const managedId = managedParam !== undefined && managedParam.length === 1 && (managedParam[0] ?? '') !== '' ? (managedParam[0] ?? null) : null;
    const form: AttachmentForm = inline ? 'inline' : managedId === null ? 'external_url' : 'managed';

    // Duplicate or conflicting structural declarations disable the attachment, never the event.
    const structural = ['value', 'encoding', 'fmttype', 'managed-id'].every(name => (parameters.get(name)?.length ?? 0) <= 1);
    let supported = structural;
    if (inline) {
        supported = structural && valueParam?.[0]?.toUpperCase() === 'BINARY' && encoding?.[0]?.toUpperCase() === 'BASE64' && managedParam === undefined && isCanonicalBase64(scan.valueText);
    } else if (encoding !== undefined || (valueParam !== undefined && valueParam[0]?.toUpperCase() !== 'URI') || (managedParam !== undefined && managedId === null)) {
        supported = false;
    }

    return {
        form,
        component,
        componentRecurrenceId: recurrenceId,
        managedId: inline ? null : managedId,
        uri: inline ? null : scan.valueText,
        inlineBase64: inline ? scan.valueText : null,
        filename: only(parameters, 'filename') ?? only(parameters, 'x-apple-filename'),
        contentType: only(parameters, 'fmttype'),
        declaredSize: canonicalSize(only(parameters, 'size')),
        fingerprint: sha256Hex(['attach-property/v1', valueType, scan.valueText, sortedParameters(parameters)]),
        structurallySupported: supported,
    };
}

/**
 * Builds the descriptors of one VEVENT's direct ATTACH properties, in source order. The ordinal of each is the count of
 * identical fingerprints earlier in the same component.
 */
export function describeComponentAttachments(scans: readonly AttachPrescan[], component: 'master' | 'override', recurrenceId: RawProperty | null): AttachmentDescriptor[] {
    const seen = new Map<string, number>();
    return scans.map(scan => {
        const base = describe(scan, component, recurrenceId);
        const ordinal = seen.get(base.fingerprint) ?? 0;
        seen.set(base.fingerprint, ordinal + 1);
        return { ...base, ordinal };
    });
}

// ---- References ----

export interface AttachmentIndexInput {
    /** The authenticated pseudonymous UpstreamCredentials.accountId, never caller input. */
    accountId: string;
    calendarId: string;
    href: string;
    resource: OriginalResource;
    prescan: readonly AttachPrescan[];
}

export interface AttachmentIndexEntry {
    /** `a1_` plus 43 base64url characters. */
    ref: string;
    descriptor: AttachmentDescriptor;
}

/** The raw RECURRENCE-ID tuple with lower-case, sorted parameters. Never the timezone-resolved value. */
function ridTuple(property: RawProperty): unknown[] {
    return [property.name, sortedParameters(property.params), property.type, property.values];
}

function componentKey(descriptor: AttachmentDescriptor): unknown[] {
    return descriptor.component === 'master' || descriptor.componentRecurrenceId === null ? ['master'] : ['override', ridTuple(descriptor.componentRecurrenceId)];
}

/** Resource-wide direct-VEVENT attachments (master and overrides, no VALARM). Duplicate or ambiguous refs throw IcalError('malformed'). */
export function buildAttachmentIndex(input: AttachmentIndexInput): readonly AttachmentIndexEntry[] {
    const components = [...(input.resource.master === null ? [] : [input.resource.master]), ...input.resource.overrides];
    const descriptors = components.flatMap(component => component.attachments);
    // The descriptors and the pre-scan come from the same text; a different count means the two readers disagree.
    if (descriptors.length !== input.prescan.length) { throw new IcalError('malformed'); }
    const entries = descriptors.map(descriptor => {
        const digest = createHash('sha256')
            .update(JSON.stringify(['caldav-mcp/attachment-ref/v1', input.accountId, input.calendarId, input.href, componentKey(descriptor), [descriptor.managedId, descriptor.fingerprint, descriptor.ordinal]]))
            .digest('base64url');
        return { ref: `a1_${digest}`, descriptor };
    });
    if (new Set(entries.map(entry => entry.ref)).size !== entries.length) { throw new IcalError('malformed'); }
    return entries;
}

// ---- Metadata ----

export function toAttachmentMetadata(entry: AttachmentIndexEntry, downloadSupported = false): AttachmentMetadata {
    const { descriptor } = entry;
    const filename = descriptor.filename === null ? null : sanitizeDisplayText(descriptor.filename, FILENAME_MAX);
    const contentType = descriptor.contentType === null ? null : sanitizeDisplayText(descriptor.contentType, MIME_MAX);
    const rid = descriptor.componentRecurrenceId;
    const ridValue = rid?.values[0];
    const stored = rid !== null && typeof ridValue === 'string' ? storedTimeFromJcal(rid.type, ridValue, rid.params.get('tzid')?.[0]) : null;
    const sanitized = (filename?.sanitized ?? false) || (contentType?.sanitized ?? false);
    const truncated = (filename?.truncated ?? false) || (contentType?.truncated ?? false);
    return {
        attachment_ref: entry.ref,
        component: descriptor.component,
        component_recurrence_id: stored === null ? null : toEventTime(stored),
        filename: filename?.text ?? null,
        content_type: contentType?.text ?? null,
        declared_size: descriptor.declaredSize,
        form: descriptor.form,
        download_supported: downloadSupported,
        ...(sanitized ? { sanitized: true as const } : {}),
        ...(truncated ? { truncated: true as const } : {}),
    };
}
