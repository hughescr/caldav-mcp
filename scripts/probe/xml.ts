import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Minimal namespace-stripping XML tree. Element names lose their prefix, which is
 * acceptable for the probe: the DAV, CalDAV and calendarserver names it inspects are
 * distinct by local name.
 */
export interface XmlNode {
    name: string;
    attrs: Record<string, string>;
    children: XmlNode[];
    text: string;
}

const parser = new XMLParser({
    preserveOrder: true,
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: true,
    htmlEntities: true,
});

type RawNode = Record<string, unknown>;

function convert(raw: RawNode): XmlNode | undefined {
    const name = Object.keys(raw).find((key) => key !== ':@');
    if (name === undefined || name === '#text' || name.startsWith('?')) {
        return undefined;
    }
    const attrsRaw = raw[':@'];
    const attrs: Record<string, string> = {};
    if (attrsRaw !== null && typeof attrsRaw === 'object') {
        for (const [key, value] of Object.entries(attrsRaw)) {
            if (typeof value === 'string' && !key.startsWith('xmlns')) {
                attrs[key.replace(/^[^:]*:/, '')] = value;
            }
        }
    }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    const content = raw[name];
    if (Array.isArray(content)) {
        for (const item of content as RawNode[]) {
            if (typeof item['#text'] === 'string') {
                node.text += item['#text'];
                continue;
            }
            const childNode = convert(item);
            if (childNode !== undefined) {
                node.children.push(childNode);
            }
        }
    }
    return node;
}

/** Root element, or undefined for empty, malformed or DOCTYPE-bearing input. */
export function parseXml(body: string): XmlNode | undefined {
    if (body.trim() === '' || /<!DOCTYPE/i.test(body) || XMLValidator.validate(body) !== true) {
        return undefined;
    }
    try {
        const parsed: unknown = parser.parse(body);
        if (!Array.isArray(parsed)) {
            return undefined;
        }
        for (const item of parsed as RawNode[]) {
            const node = convert(item);
            if (node !== undefined) {
                return node;
            }
        }
    } catch {
        return undefined;
    }
    return undefined;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
    return node?.children.find((c) => c.name === name);
}

export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
    return node === undefined ? [] : node.children.filter((c) => c.name === name);
}

export function descendants(node: XmlNode | undefined, name: string): XmlNode[] {
    const found: XmlNode[] = [];
    const walk = (current: XmlNode): void => {
        for (const c of current.children) {
            if (c.name === name) {
                found.push(c);
            }
            walk(c);
        }
    };
    if (node !== undefined) {
        walk(node);
    }
    return found;
}

/** Every element name below (and including) a node. */
export function elementNames(node: XmlNode | undefined): string[] {
    if (node === undefined) {
        return [];
    }
    const names = new Set<string>([node.name]);
    const walk = (current: XmlNode): void => {
        for (const c of current.children) {
            names.add(c.name);
            walk(c);
        }
    };
    walk(node);
    return [...names];
}

export function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function parseStatusLine(text: string | undefined): number | null {
    const match = /^\s*HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(text ?? '');
    return match?.[1] === undefined ? null : Number(match[1]);
}

export interface DavProp {
    status: number | null;
    node: XmlNode;
    text: string;
}

export interface DavResponse {
    href: string;
    /** Response-level status (for example 404 in sync-collection or multiget). */
    status: number | null;
    props: Map<string, DavProp>;
}

export interface Multistatus {
    root: XmlNode;
    responses: DavResponse[];
    syncToken: string | null;
}

export function parseMultistatus(body: string): Multistatus | undefined {
    const root = parseXml(body);
    if (root?.name !== 'multistatus') {
        return undefined;
    }
    const responses: DavResponse[] = childrenNamed(root, 'response').map((response) => {
        const props = new Map<string, DavProp>();
        for (const propstat of childrenNamed(response, 'propstat')) {
            const status = parseStatusLine(child(propstat, 'status')?.text);
            for (const p of child(propstat, 'prop')?.children ?? []) {
                props.set(p.name, { status, node: p, text: p.text.trim() });
            }
        }
        return {
            href: (child(response, 'href')?.text ?? '').trim(),
            status: parseStatusLine(child(response, 'status')?.text),
            props,
        };
    });
    const token = child(root, 'sync-token');
    return { root, responses, syncToken: token === undefined ? null : token.text.trim() };
}

/** A property only counts as returned when its propstat status is 200. */
export function okProp(response: DavResponse, name: string): DavProp | undefined {
    const p = response.props.get(name);
    return p !== undefined && p.status === 200 ? p : undefined;
}
