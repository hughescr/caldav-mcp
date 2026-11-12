/**
 * Minimal, namespace-aware XML reading for WebDAV multistatus responses.
 *
 * fast-xml-parser does the tokenizing only. Everything that matters for safety is done here:
 * - Elements and attributes are identified by namespace URI + local name, never by prefix.
 * - No DTD processing: any `<!` markup other than a comment or CDATA section is refused, so
 *   DOCTYPE/ENTITY declarations (billion laughs, XXE) never reach the parser.
 * - Only the five predefined entities and numeric character references are decoded; any other
 *   `&` is refused.
 * Every failure is CalDavError('protocol') with no input text attached.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
    MAX_PROPFIND_XML_ELEMENTS, MAX_PROPFIND_XML_NAMESPACE_DECLARATIONS,
    MAX_REPORT_XML_ELEMENTS, MAX_REPORT_XML_NAMESPACE_DECLARATIONS, MAX_XML_BINDINGS, MAX_XML_DEPTH,
} from '../calendar/limits';
import { CalDavError } from './contracts';

export const DAV_NS = 'DAV:';
export const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';
export const APPLE_ICAL_NS = 'http://apple.com/ns/ical/';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const MAX_DEPTH = MAX_XML_DEPTH;
// Discovery keeps its original protocol classification. Read profiles report bounded-work overflow as too_large.
const MAX_ELEMENTS = MAX_PROPFIND_XML_ELEMENTS;
const MAX_DECLARATIONS = MAX_PROPFIND_XML_NAMESPACE_DECLARATIONS;
/** Prefix bindings in scope at one element, counting the predeclared xml prefix and the default. */
const MAX_BINDINGS = MAX_XML_BINDINGS;
const WRAPPER = 'caldav-mcp-document';
const XML_DECLARATION = /^﻿?<\?xml[^?]*\?>/;
const ATTRIBUTE_PREFIX = '@_';
const TEXT_KEY = '#text';
const CDATA_KEY = '#cdata';
const ATTRIBUTES_KEY = ':@';

export interface XmlElement {
    /** Namespace URI; '' when the element is in no namespace. */
    readonly ns: string;
    readonly local: string;
    /** Unprefixed attributes by local name; prefixed ones as `{uri}local`. Namespace declarations excluded. */
    readonly attributes: ReadonlyMap<string, string>;
    readonly children: readonly XmlElement[];
    /** Concatenated direct text and CDATA content, entity-decoded (CDATA verbatim). */
    readonly text: string;
}

export interface DavPropstat {
    readonly status: number;
    readonly props: readonly XmlElement[];
}

export interface DavResponse {
    /** Trimmed href text, unresolved. */
    readonly href: string;
    /** Response-level status, or null when the response uses propstats. */
    readonly status: number | null;
    readonly propstats: readonly DavPropstat[];
}

type RawNode = Record<string, unknown>;

const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: ATTRIBUTE_PREFIX,
    allowBooleanAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: false,
    htmlEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    cdataPropName: CDATA_KEY,
    commentPropName: false,
    // +1 for the synthetic wrapper element.
    maxNestedTags: MAX_DEPTH + 1,
});

function protocol(): never {
    throw new CalDavError('protocol');
}

// XML 1.0 Char production: no C0 controls except tab/LF/CR, no U+FFFE/U+FFFF, no lone surrogates.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const ILLEGAL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Refuses every `<!` construct except comments and CDATA sections (so: no DOCTYPE, no ENTITY). */
function assertNoMarkupDeclarations(xml: string): void {
    let position = xml.indexOf('<!');
    while (position !== -1) {
        let end: number;
        if (xml.startsWith('<!--', position)) {
            end = xml.indexOf('-->', position + 4);
            end = end === -1 ? -1 : end + 3;
        } else if (xml.startsWith('<![CDATA[', position)) {
            end = xml.indexOf(']]>', position + 9);
            end = end === -1 ? -1 : end + 3;
        } else {
            return protocol();
        }
        if (end === -1) {
            return protocol();
        }
        position = xml.indexOf('<!', end);
    }
}

const ENTITY = /&(?:#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6})|(lt|gt|amp|apos|quot));|&/g;
const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', apos: '\'', quot: '"' };

function isXmlChar(codePoint: number): boolean {
    return codePoint === 0x9 || codePoint === 0xA || codePoint === 0xD
        || (codePoint >= 0x20 && codePoint <= 0xD7FF)
        || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
        || (codePoint >= 0x10000 && codePoint <= 0x10FFFF);
}

function decodeEntities(raw: string): string {
    if (!raw.includes('&')) {
        return raw;
    }
    return raw.replace(ENTITY, (_match, decimal?: string, hex?: string, named?: string) => {
        if (named !== undefined) {
            return PREDEFINED[named] ?? protocol();
        }
        const digits = decimal ?? hex;
        if (digits === undefined) {
            return protocol();
        }
        const codePoint = Number.parseInt(digits, decimal === undefined ? 16 : 10);
        return isXmlChar(codePoint) ? String.fromCodePoint(codePoint) : protocol();
    });
}

function splitName(qualified: string): [prefix: string, local: string] {
    const parts = qualified.split(':');
    if (parts.length === 1 && parts[0]) {
        return ['', parts[0]];
    }
    if (parts.length === 2 && parts[0] && parts[1]) {
        return [parts[0], parts[1]];
    }
    return protocol();
}

function elementName(node: RawNode): string {
    const names = Object.keys(node).filter((key) => key !== ATTRIBUTES_KEY);
    if (names.length !== 1 || !names[0]) {
        return protocol();
    }
    return names[0];
}

function rawAttributes(node: RawNode): [string, string][] {
    const raw = node[ATTRIBUTES_KEY];
    if (raw === undefined) {
        return [];
    }
    if (typeof raw !== 'object' || raw === null) {
        return protocol();
    }
    return Object.entries(raw).map(([key, value]) => {
        if (!key.startsWith(ATTRIBUTE_PREFIX) || typeof value !== 'string') {
            return protocol();
        }
        return [key.slice(ATTRIBUTE_PREFIX.length), decodeEntities(value)];
    });
}

function textOf(node: RawNode, key: string): string {
    const value = node[key];
    return typeof value === 'string' ? value : protocol();
}

function cdataOf(node: RawNode): string {
    const parts = node[CDATA_KEY];
    if (!Array.isArray(parts)) {
        return protocol();
    }
    return parts.map((part: unknown) => (isRawNode(part) ? textOf(part, TEXT_KEY) : protocol())).join('');
}

function isRawNode(value: unknown): value is RawNode {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Work still allowed for the rest of one document; every element and declaration spends from it. */
interface Budget {
    elements: number;
    declarations: number;
    overflow: 'protocol' | 'too_large';
}

function overflow(budget: Budget): never { throw new CalDavError(budget.overflow); }

function buildElement(node: RawNode, parentScope: ReadonlyMap<string, string>, depth: number, budget: Budget): XmlElement {
    if (depth > MAX_DEPTH || --budget.elements < 0) {
        return overflow(budget);
    }
    const qualified = elementName(node);
    const attributesRaw = rawAttributes(node);
    // Copy-on-write: an element without declarations shares its parent's scope, so the cost of
    // scopes is bounded by declarations x MAX_BINDINGS, never by elements x bindings.
    let declared: Map<string, string> | undefined;
    const declare = (prefix: string, value: string) => {
        if (--budget.declarations < 0) {
            return overflow(budget);
        }
        declared ??= new Map(parentScope);
        declared.set(prefix, value);
        if (declared.size > MAX_BINDINGS) {
            return overflow(budget);
        }
    };
    const plain: [string, string][] = [];
    for (const [name, value] of attributesRaw) {
        if (name === 'xmlns') {
            declare('', value);
        } else if (name.startsWith('xmlns:')) {
            const prefix = name.slice('xmlns:'.length);
            if (!prefix || prefix.includes(':') || value === '' || (prefix === 'xml') !== (value === XML_NS)) {
                return protocol();
            }
            declare(prefix, value);
        } else {
            plain.push([name, value]);
        }
    }
    const scope: ReadonlyMap<string, string> = declared ?? parentScope;

    const [prefix, local] = splitName(qualified);
    const ns = prefix ? scope.get(prefix) ?? protocol() : scope.get('') ?? '';

    const attributes = new Map<string, string>();
    for (const [name, value] of plain) {
        const [attrPrefix, attrLocal] = splitName(name);
        const key = attrPrefix ? `{${scope.get(attrPrefix) ?? protocol()}}${attrLocal}` : attrLocal;
        if (attributes.has(key)) {
            return protocol();
        }
        attributes.set(key, value);
    }

    const content = node[qualified];
    if (!Array.isArray(content)) {
        return protocol();
    }
    const children: XmlElement[] = [];
    let text = '';
    for (const child of content as unknown[]) {
        if (!isRawNode(child)) {
            return protocol();
        }
        if (TEXT_KEY in child) {
            text += decodeEntities(textOf(child, TEXT_KEY));
        } else if (CDATA_KEY in child) {
            text += cdataOf(child);
        } else {
            children.push(buildElement(child, scope, depth + 1, budget));
        }
    }
    return { ns, local, attributes, children, text };
}

/** Parses one XML document into a namespace-resolved element tree. Throws CalDavError('protocol'). */
export function parseXml(xml: string, profile: 'propfind' | 'membership' | 'report' = 'propfind'): XmlElement {
    if (typeof xml !== 'string' || ILLEGAL_CHAR.test(xml)) {
        return protocol();
    }
    // XML 1.0 section 2.11 applies to text and CDATA alike, before entity decoding.
    xml = xml.replace(/\r\n?/gu, '\n');
    assertNoMarkupDeclarations(xml);
    if (XMLValidator.validate(xml, { allowBooleanAttributes: false }) !== true) {
        return protocol();
    }
    // The parser drops text outside the root element, so parse inside a synthetic wrapper
    // (the declaration must go first) and inspect what sits at the top level ourselves.
    const body = xml.replace(XML_DECLARATION, '');
    let wrapped: unknown;
    try {
        wrapped = parser.parse(`<${WRAPPER}>${body}</${WRAPPER}>`);
    } catch {
        // Syntax was validated above; the tokenizer's remaining failure is its depth guard.
        throw new CalDavError(profile === 'propfind' ? 'protocol' : 'too_large');
    }
    const [wrapper, ...others] = Array.isArray(wrapped) ? (wrapped as unknown[]) : [];
    const top = isRawNode(wrapper) && others.length === 0 ? wrapper[WRAPPER] : undefined;
    if (!Array.isArray(top)) {
        return protocol();
    }
    const roots: RawNode[] = [];
    for (const node of top as unknown[]) {
        if (!isRawNode(node)) {
            return protocol();
        }
        if (TEXT_KEY in node) {
            if (textOf(node, TEXT_KEY).trim() !== '') {
                return protocol();
            }
        } else if (CDATA_KEY in node) {
            return protocol();
        } else {
            roots.push(node);
        }
    }
    const [root, ...extra] = roots;
    if (!root || extra.length > 0) {
        return protocol();
    }
    return buildElement(root, new Map([['xml', XML_NS]]), 1, {
        elements: profile === 'report' ? MAX_REPORT_XML_ELEMENTS : MAX_ELEMENTS,
        declarations: profile === 'report' ? MAX_REPORT_XML_NAMESPACE_DECLARATIONS : MAX_DECLARATIONS,
        overflow: profile === 'propfind' ? 'protocol' : 'too_large',
    });
}

export function isElement(element: XmlElement, ns: string, local: string): boolean {
    return element.ns === ns && element.local === local;
}

export function childrenNamed(element: XmlElement, ns: string, local: string): XmlElement[] {
    return element.children.filter((child) => isElement(child, ns, local));
}

const STATUS_LINE = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})(?:[ \t].*)?$/s;

function parseStatusLine(element: XmlElement): number {
    if (element.children.length > 0) {
        return protocol();
    }
    const match = STATUS_LINE.exec(element.text.trim());
    return match?.[1] ? Number(match[1]) : protocol();
}

function single(element: XmlElement, ns: string, local: string): XmlElement {
    const matches = childrenNamed(element, ns, local);
    return matches.length === 1 && matches[0] ? matches[0] : protocol();
}

/** The trimmed text of a DAV:href element, which must have no child elements and not be empty. */
export function hrefText(element: XmlElement): string {
    const text = element.text.trim();
    return element.children.length === 0 && text !== '' ? text : protocol();
}

function parseResponse(element: XmlElement): DavResponse {
    const href = hrefText(single(element, DAV_NS, 'href'));
    const statuses = childrenNamed(element, DAV_NS, 'status');
    const propstats = childrenNamed(element, DAV_NS, 'propstat').map((propstat) => ({
        status: parseStatusLine(single(propstat, DAV_NS, 'status')),
        props: single(propstat, DAV_NS, 'prop').children,
    }));
    if (statuses.length > 1 || (statuses.length === 0 && propstats.length === 0)) {
        return protocol();
    }
    const [status] = statuses;
    return { href, status: status ? parseStatusLine(status) : null, propstats };
}

/** Rejects partial-result markers anywhere in a namespace-resolved DAV document, never returning a prefix. */
export function assertCompleteMultistatus(element: XmlElement): void {
    if ((element.ns === DAV_NS || element.ns === CALDAV_NS)
        && (element.local === 'number-of-matches-within-limits' || element.local === 'limit')) {
        throw new CalDavError('too_large');
    }
    if (isElement(element, DAV_NS, 'status') && parseStatusLine(element) === 507) { throw new CalDavError('too_large'); }
    for (const child of element.children) { assertCompleteMultistatus(child); }
}

/** Parses a DAV:multistatus body; membership reads additionally refuse partial results and use read overflow codes. */
export function parseMultistatus(xml: string, membership = false): DavResponse[] {
    const root = parseXml(xml, membership ? 'membership' : 'propfind');
    if (!isElement(root, DAV_NS, 'multistatus')) {
        return protocol();
    }
    if (membership) {
        assertCompleteMultistatus(root);
        if (root.text.trim() !== '' || root.children.some((child) => !isElement(child, DAV_NS, 'response')
            && !isElement(child, DAV_NS, 'responsedescription'))) { return protocol(); }
    }
    return childrenNamed(root, DAV_NS, 'response').map(parseResponse);
}

/** The first property with this name from a 2xx propstat, or undefined. */
export function findOkProp(response: DavResponse, ns: string, local: string): XmlElement | undefined {
    for (const propstat of response.propstats) {
        if (propstat.status >= 200 && propstat.status < 300) {
            const found = propstat.props.find((prop) => isElement(prop, ns, local));
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}
