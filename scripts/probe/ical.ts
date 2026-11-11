/** Just enough RFC 5545 parsing to compare what the probe wrote with what came back. */
export interface IcalProperty {
    name: string;
    params: Record<string, string>;
    value: string;
}

export interface IcalComponent {
    name: string;
    properties: IcalProperty[];
    components: IcalComponent[];
}

export function unfold(text: string): string[] {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
            lines[lines.length - 1] += line.slice(1);
        } else if (line !== '') {
            lines.push(line);
        }
    }
    return lines;
}

function parseLine(line: string): IcalProperty | undefined {
    let index = 0;
    let quoted = false;
    let nameEnd = -1;
    let colon = -1;
    for (; index < line.length; index++) {
        const c = line[index];
        if (c === '"') {
            quoted = !quoted;
        } else if (!quoted && c === ';' && nameEnd < 0) {
            nameEnd = index;
        } else if (!quoted && c === ':') {
            colon = index;
            break;
        }
    }
    if (colon < 0) {
        return undefined;
    }
    const name = line.slice(0, nameEnd < 0 ? colon : nameEnd).toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(name)) {
        return undefined;
    }
    const params: Record<string, string> = {};
    if (nameEnd >= 0) {
        const paramText = line.slice(nameEnd + 1, colon);
        let current = '';
        quoted = false;
        const pieces: string[] = [];
        for (const c of paramText) {
            if (c === '"') {
                quoted = !quoted;
                current += c;
            } else if (c === ';' && !quoted) {
                pieces.push(current);
                current = '';
            } else {
                current += c;
            }
        }
        pieces.push(current);
        for (const piece of pieces) {
            const eq = piece.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            const key = piece.slice(0, eq).toUpperCase();
            const raw = piece.slice(eq + 1);
            params[key] = raw.replace(/^"(.*)"$/, '$1');
        }
    }
    return { name, params, value: line.slice(colon + 1) };
}

/** Root component (normally VCALENDAR), or undefined when the text is not well formed. */
export function parseIcal(text: string): IcalComponent | undefined {
    const stack: IcalComponent[] = [];
    let root: IcalComponent | undefined;
    for (const line of unfold(text)) {
        const property = parseLine(line);
        if (property === undefined) {
            return undefined;
        }
        if (property.name === 'BEGIN') {
            const component: IcalComponent = { name: property.value.trim().toUpperCase(), properties: [], components: [] };
            const parent = stack.at(-1);
            if (parent === undefined) {
                if (root !== undefined) {
                    return undefined;
                }
                root = component;
            } else {
                parent.components.push(component);
            }
            stack.push(component);
        } else if (property.name === 'END') {
            const open = stack.pop();
            if (open?.name !== property.value.trim().toUpperCase()) {
                return undefined;
            }
        } else {
            const current = stack.at(-1);
            if (current === undefined) {
                return undefined;
            }
            current.properties.push(property);
        }
    }
    return stack.length === 0 ? root : undefined;
}

export function prop(component: IcalComponent, name: string): IcalProperty | undefined {
    return component.properties.find((p) => p.name === name);
}

export function props(component: IcalComponent, name: string): IcalProperty[] {
    return component.properties.filter((p) => p.name === name);
}

export function comps(component: IcalComponent, name: string): IcalComponent[] {
    return component.components.filter((c) => c.name === name);
}

/** Property values that are structural (dates, rules, enumerations) rather than user text. */
const STRUCTURAL = new Set([
    'BEGIN', 'END', 'VERSION', 'CALSCALE', 'METHOD', 'STATUS', 'TRANSP', 'CLASS', 'ACTION',
    'DTSTART', 'DTEND', 'DUE', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE', 'RRULE',
    'EXDATE', 'RDATE', 'RECURRENCE-ID', 'DURATION', 'TRIGGER', 'TZID', 'TZOFFSETFROM',
    'TZOFFSETTO', 'TZNAME', 'PRIORITY', 'PERCENT-COMPLETE', 'REPEAT', 'FREEBUSY',
]);
const TEXT_PARAMS = new Set(['CN', 'EMAIL', 'SENT-BY', 'DIR', 'DELEGATED-TO', 'DELEGATED-FROM', 'MEMBER', 'ALTREP']);

/** Every user-text value in a component tree, for the taint set. */
export function textValues(component: IcalComponent): string[] {
    const values: string[] = [];
    const walk = (c: IcalComponent): void => {
        for (const p of c.properties) {
            if (!STRUCTURAL.has(p.name)) {
                values.push(p.value);
                values.push(p.value.replace(/^mailto:/i, ''));
            }
            for (const [key, value] of Object.entries(p.params)) {
                if (TEXT_PARAMS.has(key) || key.startsWith('X-')) {
                    values.push(value);
                    values.push(value.replace(/^mailto:/i, ''));
                }
            }
        }
        for (const inner of c.components) {
            walk(inner);
        }
    };
    walk(component);
    return values;
}

export function buildIcal(lines: readonly string[]): string {
    return `${lines.join('\r\n')}\r\n`;
}

/** iCalendar UTC date-time, e.g. 20261111T150000Z. */
export function icalUtc(ms: number): string {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function icalDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Local (floating or TZID) date-time text for the same wall clock as the UTC instant. */
export function icalLocal(ms: number): string {
    return icalUtc(ms).replace(/Z$/, '');
}
