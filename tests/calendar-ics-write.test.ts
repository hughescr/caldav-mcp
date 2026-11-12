import { describe, expect, test } from 'bun:test';
import {
    buildCreateResource, displayAlarm, escapeText, foldLine, IcsWriteError, isWrittenComponent, isWrittenProperty, parseAlarmOffset, parseRrule,
    quoteParameterValue, rruleProperty, sequenceProperty, serializeLines, serializeRrule, statusProperty, textProperty, timeProperty, transparencyProperty,
    type CreateEventInput, type IcsTime,
} from '../src/calendar/ics-write';
import { parseOriginalResource } from '../src/calendar/ical';
import type { EventComponent, RawProperty } from '../src/calendar/model';

// Expectations here are hand-written. Folding and fuzz checks use invariants computed by this file's own helpers, never the
// serializer's output as an oracle.

const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const octets = (text: string): number => Buffer.byteLength(text, 'utf8');
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function reasonOf(action: () => unknown): string | null {
    try { action(); } catch (error) { return error instanceof IcsWriteError ? error.reason : `other:${String(error)}`; }
    return null;
}

function fieldOf(action: () => unknown): string | null {
    try { action(); } catch (error) { return error instanceof IcsWriteError ? error.field : `other:${String(error)}`; }
    return null;
}

/** Physical lines of CRLF-only text, asserting there is no bare CR or LF anywhere. */
function physicalLines(text: string): string[] {
    expect<unknown>(text.endsWith('\r\n')).toBe(true);
    expect<unknown>(/\r(?!\n)|(?<!\r)\n/u.test(text)).toBe(false);
    return text.slice(0, -2).split('\r\n');
}

/**
 * Each physical line is at most 75 octets and decodes as strict UTF-8 on its own. For the folds of one logical line
 * (`oneLogicalLine`), every line after the first is a continuation starting with one space.
 */
function assertFolded(lines: readonly string[], oneLogicalLine = false): void {
    lines.forEach((line, index) => {
        expect<unknown>(octets(line)).toBeLessThanOrEqual(75);
        // A line cut inside a UTF-8 sequence would not survive a strict decode of its own bytes.
        expect<unknown>(strictUtf8.decode(Buffer.from(line, 'utf8'))).toBe(line);
        expect<unknown>(line.isWellFormed()).toBe(true);
        if (oneLogicalLine && index > 0) { expect<unknown>(line.startsWith(' ')).toBe(true); }
        if (!oneLogicalLine && index === 0) { expect<unknown>(line).toBe('BEGIN:VCALENDAR'); }
    });
}

/** Folds are maximal: a line was cut only because its next code point would have crossed 75 octets. */
function assertGreedy(lines: readonly string[]): void {
    for (let index = 0; index + 1 < lines.length; index++) {
        const next = String.fromCodePoint((lines[index + 1] ?? '').codePointAt(1) ?? 0x20);
        expect<unknown>(octets(lines[index] ?? '') + octets(next)).toBeGreaterThan(75);
    }
}

const unfold = (lines: readonly string[]): string => lines.map((line, index) => (index === 0 ? line : line.slice(1))).join('');

const BASE: CreateEventInput = {
    uid: 'cmcp1-Qm9yZWQtZXhhbXBsZS11aWQtdmFs',
    now: '20261112T181500Z',
    title: 'Weekly sync',
    start: { kind: 'zoned', local: '20261201T100000', tzid: 'America/New_York' },
    end: { kind: 'zoned', local: '20261201T103000', tzid: 'America/New_York' },
};

function master(text: string): EventComponent {
    const parsed = parseOriginalResource(text, {});
    expect<unknown>(parsed.overrides).toHaveLength(0);
    if (parsed.master === null) { throw new Error('no master'); }
    return parsed.master;
}

function one(component: EventComponent, name: string): RawProperty {
    const list = component.properties.get(name) ?? [];
    expect<unknown>(list).toHaveLength(1);
    const property = list[0];
    if (property === undefined) { throw new Error(`no ${name}`); }
    return property;
}

const textOf = (component: EventComponent, name: string): unknown => one(component, name).values[0];

// ---- Full resources ----

describe('buildCreateResource writes the design 4.2 resource byte for byte', () => {
    test('the design example: zoned weekly series with one alarm', () => {
        const text = buildCreateResource({ ...BASE, rrule: 'FREQ=WEEKLY;BYDAY=TU', alarms: [{ before_start: 'PT10M' }] });
        expect(text).toBe(crlf([
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//caldav-mcp//EN',
            'CALSCALE:GREGORIAN',
            'BEGIN:VEVENT',
            'UID:cmcp1-Qm9yZWQtZXhhbXBsZS11aWQtdmFs',
            'DTSTAMP:20261112T181500Z',
            'CREATED:20261112T181500Z',
            'LAST-MODIFIED:20261112T181500Z',
            'SEQUENCE:0',
            'DTSTART;TZID=America/New_York:20261201T100000',
            'DTEND;TZID=America/New_York:20261201T103000',
            'RRULE:FREQ=WEEKLY;BYDAY=TU',
            'SUMMARY:Weekly sync',
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            'DESCRIPTION:Reminder',
            'TRIGGER:-PT10M',
            'END:VALARM',
            'END:VEVENT',
            'END:VCALENDAR',
        ]));
    });

    test('every optional field, all-day dates, escaped text, in the fixed order', () => {
        const text = buildCreateResource({
            uid: 'cmcp1-abc_DEF-123',
            now: '20261112T000000Z',
            title: 'Party, with; friends\\fun',
            start: { kind: 'date', date: '20261224' },
            end: { kind: 'date', date: '20261225' },
            location: 'Room 1; Floor 2, East',
            description: 'Line1\nLine2\r\nLine3\rTab\there',
            status: 'TENTATIVE',
            transparency: 'TRANSPARENT',
            alarms: [{ before_start: 'P1D' }, { before_start: 'PT1H30M' }],
        });
        expect(text).toBe(crlf([
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//caldav-mcp//EN',
            'CALSCALE:GREGORIAN',
            'BEGIN:VEVENT',
            'UID:cmcp1-abc_DEF-123',
            'DTSTAMP:20261112T000000Z',
            'CREATED:20261112T000000Z',
            'LAST-MODIFIED:20261112T000000Z',
            'SEQUENCE:0',
            'DTSTART;VALUE=DATE:20261224',
            'DTEND;VALUE=DATE:20261225',
            'SUMMARY:Party\\, with\\; friends\\\\fun',
            'LOCATION:Room 1\\; Floor 2\\, East',
            'DESCRIPTION:Line1\\nLine2\\nLine3\\nTab\there',
            'STATUS:TENTATIVE',
            'TRANSP:TRANSPARENT',
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            'DESCRIPTION:Reminder',
            'TRIGGER:-P1D',
            'END:VALARM',
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            'DESCRIPTION:Reminder',
            'TRIGGER:-PT1H30M',
            'END:VALARM',
            'END:VEVENT',
            'END:VCALENDAR',
        ]));
    });

    test('UTC times and CONFIRMED/OPAQUE', () => {
        const text = buildCreateResource({
            ...BASE,
            start: { kind: 'utc', utc: '20261201T140000Z' },
            end: { kind: 'utc', utc: '20261201T150000Z' },
            status: 'CONFIRMED',
            transparency: 'OPAQUE',
        });
        expect(text).toBe(crlf([
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//caldav-mcp//EN',
            'CALSCALE:GREGORIAN',
            'BEGIN:VEVENT',
            'UID:cmcp1-Qm9yZWQtZXhhbXBsZS11aWQtdmFs',
            'DTSTAMP:20261112T181500Z',
            'CREATED:20261112T181500Z',
            'LAST-MODIFIED:20261112T181500Z',
            'SEQUENCE:0',
            'DTSTART:20261201T140000Z',
            'DTEND:20261201T150000Z',
            'SUMMARY:Weekly sync',
            'STATUS:CONFIRMED',
            'TRANSP:OPAQUE',
            'END:VEVENT',
            'END:VCALENDAR',
        ]));
    });

    test('a zone with a semicolon, colon or comma is DQUOTE-quoted and round-trips', () => {
        for (const [zone, written] of [['Etc/GMT+5', 'Etc/GMT+5'], ['Odd;Zone', '"Odd;Zone"'], ['Odd:Zone', '"Odd:Zone"'], ['Odd,Zone', '"Odd,Zone"'], ['Pacific Standard Time', 'Pacific Standard Time']] as const) {
            const text = buildCreateResource({
                ...BASE,
                start: { kind: 'zoned', local: '20261201T100000', tzid: zone },
                end: { kind: 'zoned', local: '20261201T110000', tzid: zone },
            });
            expect(physicalLines(text)).toContain(`DTSTART;TZID=${written}:20261201T100000`);
            const event = master(text);
            expect<unknown>(event.start).toEqual({ kind: 'zoned', local: '2026-12-01T10:00:00', tzid: zone });
            expect<unknown>(event.end).toEqual({ kind: 'zoned', local: '2026-12-01T11:00:00', tzid: zone });
        }
    });

    test('the parsed resource holds exactly the requested values', () => {
        const input: CreateEventInput = {
            ...BASE,
            title: 'Ünïcødé 😀 title, with; specials\\',
            location: 'Somewhere\nelse',
            description: 'Multi\r\nline\rdescription\twith tab',
            status: 'TENTATIVE',
            transparency: 'TRANSPARENT',
            rrule: 'freq=monthly;bymonthday=-1;count=12',
            alarms: [{ before_start: 'PT5M' }, { before_start: 'P1W' }],
        };
        const event = master(buildCreateResource(input));
        expect<unknown>(event.uid).toBe(BASE.uid);
        expect<unknown>(textOf(event, 'summary')).toBe('Ünïcødé 😀 title, with; specials\\');
        expect<unknown>(textOf(event, 'location')).toBe('Somewhere\nelse');
        expect<unknown>(textOf(event, 'description')).toBe('Multi\nline\ndescription\twith tab');
        expect<unknown>(textOf(event, 'status')).toBe('TENTATIVE');
        expect<unknown>(textOf(event, 'transp')).toBe('TRANSPARENT');
        expect<unknown>(textOf(event, 'sequence')).toBe(0);
        expect<unknown>(textOf(event, 'rrule')).toEqual({ freq: 'MONTHLY', bymonthday: -1, count: 12 });
        expect<unknown>(event.alarmCount).toBe(2);
        expect<unknown>(event.start).toEqual({ kind: 'zoned', local: '2026-12-01T10:00:00', tzid: 'America/New_York' });
        expect<unknown>([...event.properties.keys()].sort()).toEqual(['created', 'description', 'dtend', 'dtstamp', 'dtstart', 'last-modified', 'location', 'rrule', 'sequence', 'status', 'summary', 'transp', 'uid']);
    });
});

// ---- Injection ----

describe('client text can never create a line, property, parameter or component', () => {
    const ATTACKS = [
        'x\r\nATTENDEE:mailto:x@y',
        'x\nATTENDEE:mailto:x@y',
        'x\rATTENDEE:mailto:x@y',
        '\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:evil\r\nDTSTART:20261201T100000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT',
        'BEGIN:VALARM',
        '\nBEGIN:VALARM\nACTION:EMAIL\nATTENDEE:mailto:x@y\nTRIGGER:-PT1M\nEND:VALARM\n',
        'END:VEVENT',
        '\r\nEND:VCALENDAR\r\n',
        '\r\n ATTENDEE:mailto:folded@y',
        '\r\n\tATTENDEE:mailto:folded@y',
        ';X-PARAM=1:value',
        ':colon:start',
        '"quoted";A=B',
        '\\',
        '\\n',
    ];

    for (const field of ['title', 'location', 'description'] as const) {
        test(`${field}: each attack stays inside one property value`, () => {
            for (const attack of ATTACKS) {
                const text = buildCreateResource({ ...BASE, [field]: attack });
                const lines = physicalLines(text);
                assertFolded(lines);
                const parsed = parseOriginalResource(text, {});
                expect<unknown>(parsed.kind).toBe('single');
                expect<unknown>(parsed.overrides).toHaveLength(0);
                const event = parsed.master;
                if (event === null) { throw new Error('no master'); }
                expect<unknown>(event.alarmCount).toBe(0);
                expect<unknown>(event.properties.has('attendee')).toBe(false);
                expect<unknown>(event.uid).toBe(BASE.uid);
                const name = field === 'title' ? 'summary' : field;
                expect<unknown>(textOf(event, name)).toBe(attack.replaceAll(/\r\n|\r|\n/gu, '\n'));
                // Only the code-constant lines begin a logical line.
                const names = lines.filter(line => !line.startsWith(' ')).map(line => line.slice(0, line.search(/[;:]/u)));
                const expected = ['BEGIN', 'VERSION', 'PRODID', 'CALSCALE', 'BEGIN', 'UID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE', 'DTSTART', 'DTEND', 'SUMMARY'];
                if (field !== 'title') { expected.push(field.toUpperCase()); }
                expect<unknown>(names).toEqual([...expected, 'END', 'END']);
            }
        });
    }

    test('the classic CRLF attendee injection is written as one escaped SUMMARY', () => {
        const text = buildCreateResource({ ...BASE, title: 'x\r\nATTENDEE:mailto:x@y' });
        expect(physicalLines(text)).toContain('SUMMARY:x\\nATTENDEE:mailto:x@y');
    });

    test('NUL, other C0 controls, DEL and lone surrogates are refused in every text field, with no output', () => {
        const bad = ['\u0000', 'a\u0001b', '\u0008', '\u000B', '\u000C', '\u000E', '\u001B', '\u001F', '\u007F', '\uD800', '\uDFFF', 'a\uD83Db', '\uDE00\uD83D'];
        for (const field of ['title', 'location', 'description'] as const) {
            for (const value of bad) {
                let output: string | null = null;
                const reason = reasonOf(() => { output = buildCreateResource({ ...BASE, [field]: value }); });
                expect<unknown>(reason).toBe('text_not_representable');
                expect<unknown>(output).toBeNull();
                expect<unknown>(fieldOf(() => buildCreateResource({ ...BASE, [field]: value }))).toBe(field);
            }
        }
    });

    test('bidi controls, C1 controls and line/paragraph separators are not C0: kept verbatim, no normalisation (design 6.2)', () => {
        for (const value of ['\u202Eevil\u202C', '\u2066x\u2069', '\u200F\u200E', '\u0085', '\u2028\u2029', 'e\u0301', '\uFEFF']) {
            const event = master(buildCreateResource({ ...BASE, title: value }));
            expect<unknown>(textOf(event, 'summary')).toBe(value);
        }
    });

    test('escapeText table', () => {
        const table: [string, string][] = [
            ['', ''],
            ['plain', 'plain'],
            ['a\\b', 'a\\\\b'],
            ['a;b', 'a\\;b'],
            ['a,b', 'a\\,b'],
            ['a:b', 'a:b'],
            ['a"b', 'a"b'],
            ['a^b', 'a^b'],
            ['l1\r\nl2', 'l1\\nl2'],
            ['l1\nl2', 'l1\\nl2'],
            ['l1\rl2', 'l1\\nl2'],
            ['\n\r', '\\n\\n'],
            ['\r\n\r\n', '\\n\\n'],
            ['\r\r\n', '\\n\\n'],
            ['tab\tkept', 'tab\tkept'],
            ['\\n', '\\\\n'],
            ['😀', '😀'],
        ];
        for (const [input, written] of table) { expect(escapeText(input)).toBe(written); }
    });

    test('text length caps in UTF-16 units: title 1024, location 2048, description 8192', () => {
        expect(reasonOf(() => buildCreateResource({ ...BASE, title: 'a'.repeat(1024) }))).toBeNull();
        expect(reasonOf(() => buildCreateResource({ ...BASE, title: 'a'.repeat(1025) }))).toBe('text_too_long');
        expect(reasonOf(() => buildCreateResource({ ...BASE, location: 'a'.repeat(2048) }))).toBeNull();
        expect(reasonOf(() => buildCreateResource({ ...BASE, location: 'a'.repeat(2049) }))).toBe('text_too_long');
        expect(reasonOf(() => buildCreateResource({ ...BASE, description: 'a'.repeat(8192) }))).toBeNull();
        expect(reasonOf(() => buildCreateResource({ ...BASE, description: 'a'.repeat(8193) }))).toBe('text_too_long');
        expect(reasonOf(() => textProperty('SUMMARY', '😀'.repeat(512)))).toBeNull();
        expect(reasonOf(() => textProperty('SUMMARY', `${'😀'.repeat(512)}a`))).toBe('text_too_long');
    });
});

describe('parameter values', () => {
    test('quoteParameterValue table', () => {
        const table: [string, string][] = [
            ['America/New_York', 'America/New_York'],
            ['Pacific Standard Time', 'Pacific Standard Time'],
            ['A;B', '"A;B"'],
            ['A:B', '"A:B"'],
            ['A,B', '"A,B"'],
            ['Zürich', 'Zürich'],
            ['a'.repeat(128), 'a'.repeat(128)],
        ];
        for (const [input, written] of table) { expect(quoteParameterValue(input)).toBe(written); }
    });

    test('DQUOTE, caret, controls, empty, over 128 units and ill-formed text are refused (design 4.1 zone_not_representable)', () => {
        for (const zone of ['', 'a"b', 'X";ATTENDEE=mailto:x@y;X="', '^n', 'a^b', 'a'.repeat(129), 'a\tb', 'a\r\nb', 'a\nb', '\u0000', '\u007F', '\u001F', 'a\uD800']) {
            expect(reasonOf(() => quoteParameterValue(zone))).toBe('zone_not_representable');
            expect(reasonOf(() => buildCreateResource({
                ...BASE, start: { kind: 'zoned', local: '20261201T100000', tzid: zone }, end: { kind: 'zoned', local: '20261201T110000', tzid: 'UTC' },
            }))).toBe('zone_not_representable');
            expect(fieldOf(() => buildCreateResource({
                ...BASE, start: { kind: 'zoned', local: '20261201T100000', tzid: 'UTC' }, end: { kind: 'zoned', local: '20261201T110000', tzid: zone },
            }))).toBe('end');
        }
    });
});

// ---- Folding ----

describe('folding at 75 octets on code-point boundaries', () => {
    test('hand-written boundaries for 1-, 2-, 3- and 4-byte characters', () => {
        const a = (count: number): string => 'a'.repeat(count);
        // 8 octets of name and colon.
        expect(foldLine(`SUMMARY:${a(67)}`)).toEqual([`SUMMARY:${a(67)}`]);
        expect(foldLine(`SUMMARY:${a(68)}`)).toEqual([`SUMMARY:${a(67)}`, ' a']);
        expect(foldLine(`SUMMARY:${a(65)}é`)).toEqual([`SUMMARY:${a(65)}é`]);
        expect(foldLine(`SUMMARY:${a(66)}é`)).toEqual([`SUMMARY:${a(66)}`, ' é']);
        expect(foldLine(`SUMMARY:${a(64)}€`)).toEqual([`SUMMARY:${a(64)}€`]);
        expect(foldLine(`SUMMARY:${a(65)}€`)).toEqual([`SUMMARY:${a(65)}`, ' €']);
        expect(foldLine(`SUMMARY:${a(66)}€`)).toEqual([`SUMMARY:${a(66)}`, ' €']);
        expect(foldLine(`SUMMARY:${a(63)}😀`)).toEqual([`SUMMARY:${a(63)}😀`]);
        expect(foldLine(`SUMMARY:${a(64)}😀`)).toEqual([`SUMMARY:${a(64)}`, ' 😀']);
        expect(foldLine(`SUMMARY:${a(67)}😀`)).toEqual([`SUMMARY:${a(67)}`, ' 😀']);
        // A continuation carries 74 octets after its space.
        expect(foldLine(`SUMMARY:${a(67)}${'b'.repeat(74)}c`)).toEqual([`SUMMARY:${a(67)}`, ` ${'b'.repeat(74)}`, ' c']);
        expect(foldLine(`SUMMARY:${a(67)}${'b'.repeat(70)}😀`)).toEqual([`SUMMARY:${a(67)}`, ` ${'b'.repeat(70)}😀`]);
        expect(foldLine(`SUMMARY:${a(67)}${'b'.repeat(71)}😀`)).toEqual([`SUMMARY:${a(67)}`, ` ${'b'.repeat(71)}`, ' 😀']);
        // A space or tab after a fold is content: the continuation keeps it after its own leading space.
        expect(foldLine(`SUMMARY:${a(67)} x`)).toEqual([`SUMMARY:${a(67)}`, '  x']);
        expect(foldLine(`SUMMARY:${a(67)}\tx`)).toEqual([`SUMMARY:${a(67)}`, ' \tx']);
        expect(foldLine('')).toEqual(['']);
    });

    test('property test: every offset around the boundary, 2/3/4-byte characters, ZWJ emoji and combining marks', () => {
        const characters = ['é', 'ß', '€', '中', '😀', '𝄞', '👨\u200D👩\u200D👧\u200D👦', 'e\u0301', 'a\u0308\u0323', '🏳️‍🌈'];
        for (const character of characters) {
            for (let prefix = 0; prefix <= 160; prefix++) {
                for (const repeat of [1, 2, 7]) {
                    const logical = `DESCRIPTION:${'a'.repeat(prefix)}${character.repeat(repeat)}z`;
                    const lines = foldLine(logical);
                    assertFolded(lines, true);
                    assertGreedy(lines);
                    expect<unknown>(unfold(lines)).toBe(logical);
                }
            }
        }
    });

    test('serializeLines folds every logical line and ends every physical line with CRLF', () => {
        expect(serializeLines(['A:1', `B:${'x'.repeat(80)}`])).toBe(`A:1\r\nB:${'x'.repeat(73)}\r\n ${'x'.repeat(7)}\r\n`);
    });

    test('a CR, LF or ill-formed text inside a logical line is an assertion failure, never output', () => {
        for (const line of ['A:x\r\nB:y', 'A:x\ny', 'A:x\ry', 'A:\uD800']) {
            expect(reasonOf(() => foldLine(line))).toBe('line_invalid');
            expect(reasonOf(() => serializeLines(['A:1', line]))).toBe('line_invalid');
        }
    });

    test('an 8 KiB multilingual description folds legally and round-trips exactly', () => {
        const unit = 'Größe 中文 😀 👨\u200D👩\u200D👧 e\u0301; a,b\\c\n';
        let description = '';
        while (description.length + unit.length <= 8192) { description += unit; }
        description += 'x'.repeat(8192 - description.length);
        expect<unknown>(description.length).toBe(8192);
        const text = buildCreateResource({ ...BASE, description });
        const lines = physicalLines(text);
        assertFolded(lines);
        expect<unknown>(lines.length).toBeGreaterThan(150);
        expect<unknown>(textOf(master(text), 'description')).toBe(description);
    });

    test('a ZWJ emoji title of maximum length round-trips', () => {
        const family = '👨\u200D👩\u200D👧\u200D👦';
        const title = family.repeat(Math.floor(1024 / family.length));
        const text = buildCreateResource({ ...BASE, title });
        assertFolded(physicalLines(text));
        expect<unknown>(textOf(master(text), 'summary')).toBe(title);
    });
});

// ---- Seeded fuzz ----

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('seeded fuzz: 10k strings round-trip through parseOriginalResource or refuse with the right reason', () => {
    const ALPHABET = [
        '\u0000', '\u0001', '\u0007', '\u000B', '\u001F', '\u007F', '\r', '\n', '\r\n', '\t', ';', ':', ',', '"', '^', '\\', '\\n', ' ',
        'a', 'Z', '0', 'é', '€', '中', '😀', '👨\u200D👩', '\u0301', '\u202E', '\u2028', '\uD800', '\uDC00', '\uFFFD', 'BEGIN:VALARM', 'END:VEVENT',
    ];
    /** Independent oracle: refusal iff a lone surrogate, C0 other than TAB/CR/LF, or DEL. */
    const refusable = (value: string): boolean => !value.isWellFormed()
        || [...value].some(character => {
            const code = character.codePointAt(0) ?? 0;
            return (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) || code === 0x7F;
        });

    test('summary strings', () => {
        const random = mulberry32(0x5EED_0001);
        let accepted = 0;
        let refused = 0;
        for (let iteration = 0; iteration < 10_000; iteration++) {
            const length = Math.floor(random() * 40);
            let value = '';
            for (let index = 0; index < length; index++) { value += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? ''; }
            if (value.length > 1024) { value = value.slice(0, 1024); }
            let text: string | null = null;
            const reason = reasonOf(() => { text = buildCreateResource({ ...BASE, title: value }); });
            if (refusable(value)) {
                expect<unknown>(reason).toBe('text_not_representable');
                expect<unknown>(text).toBeNull();
                refused++;
                continue;
            }
            expect<unknown>(reason).toBeNull();
            if (text === null) { throw new Error('no output'); }
            const output: string = text;
            assertFolded(physicalLines(output));
            const event = master(output);
            expect<unknown>(event.alarmCount).toBe(0);
            expect<unknown>(event.properties.size).toBe(8);
            expect<unknown>(textOf(event, 'summary')).toBe(value.replaceAll(/\r\n|\r|\n/gu, '\n'));
            accepted++;
        }
        expect<unknown>(accepted).toBeGreaterThan(1000);
        expect<unknown>(refused).toBeGreaterThan(1000);
    });
});

// ---- Times, UID, enums ----

describe('time values come only from validated digits', () => {
    test('timeProperty writes the four forms', () => {
        expect(timeProperty('DTSTART', { kind: 'utc', utc: '20261201T140000Z' }).line).toBe('DTSTART:20261201T140000Z');
        expect(timeProperty('DTEND', { kind: 'zoned', local: '20261201T090000', tzid: 'Europe/Berlin' }).line).toBe('DTEND;TZID=Europe/Berlin:20261201T090000');
        expect(timeProperty('EXDATE', { kind: 'date', date: '20261224' }).line).toBe('EXDATE;VALUE=DATE:20261224');
        expect(timeProperty('EXDATE', { kind: 'floating', local: '20261224T090000' }).line).toBe('EXDATE:20261224T090000');
        expect(timeProperty('RECURRENCE-ID', { kind: 'zoned', local: '20261208T100000', tzid: 'America/New_York' }).line).toBe('RECURRENCE-ID;TZID=America/New_York:20261208T100000');
        expect(timeProperty('DTSTAMP', { kind: 'utc', utc: '20261113T090000Z' }).line).toBe('DTSTAMP:20261113T090000Z');
    });

    test('invalid digits are refused', () => {
        const bad: IcsTime[] = [
            { kind: 'utc', utc: '20261201T140000' },
            { kind: 'utc', utc: '2026-12-01T14:00:00Z' },
            { kind: 'utc', utc: '20260230T140000Z' },
            { kind: 'utc', utc: '20261301T140000Z' },
            { kind: 'utc', utc: '20261201T240000Z' },
            { kind: 'utc', utc: '20261201T236000Z' },
            { kind: 'utc', utc: '20261201T235960Z' },
            { kind: 'utc', utc: '20261201T140000Z\r\nATTENDEE:mailto:x@y' },
            { kind: 'zoned', local: '20261201T140000Z', tzid: 'UTC' },
            { kind: 'date', date: '2026122' },
            { kind: 'date', date: '20261232' },
            { kind: 'date', date: '20270229' },
            { kind: 'date', date: '00000101' },
            { kind: 'floating', local: '20261201' },
        ];
        for (const time of bad) { expect(reasonOf(() => timeProperty('DTSTART', time))).toBe(time.kind === 'floating' ? 'time_form_not_allowed' : 'time_invalid'); }
        for (const time of bad) { expect(reasonOf(() => timeProperty('EXDATE', time))).toBe('time_invalid'); }
        expect(reasonOf(() => timeProperty('DTSTART', { kind: 'date', date: '20280229' }))).toBeNull();
    });

    test('server stamps must be UTC; floating is only for copied master forms (EXDATE, RECURRENCE-ID)', () => {
        for (const name of ['DTSTAMP', 'CREATED', 'LAST-MODIFIED'] as const) {
            expect(reasonOf(() => timeProperty(name, { kind: 'date', date: '20261201' }))).toBe('time_form_not_allowed');
            expect(reasonOf(() => timeProperty(name, { kind: 'zoned', local: '20261201T100000', tzid: 'UTC' }))).toBe('time_form_not_allowed');
        }
        expect(reasonOf(() => timeProperty('DTSTART', { kind: 'floating', local: '20261201T100000' }))).toBe('time_form_not_allowed');
        expect(reasonOf(() => timeProperty('DTEND', { kind: 'floating', local: '20261201T100000' }))).toBe('time_form_not_allowed');
        expect(reasonOf(() => timeProperty('RECURRENCE-ID', { kind: 'floating', local: '20261201T100000' }))).toBeNull();
    });

    test('create refuses mixed start/end kinds, floating times and a non-UTC clock', () => {
        expect(reasonOf(() => buildCreateResource({ ...BASE, end: { kind: 'utc', utc: '20261201T150000Z' } }))).toBe('start_end_kind_mismatch');
        expect(reasonOf(() => buildCreateResource({ ...BASE, start: { kind: 'date', date: '20261201' }, end: { kind: 'utc', utc: '20261201T150000Z' } }))).toBe('start_end_kind_mismatch');
        expect(reasonOf(() => buildCreateResource({ ...BASE, start: { kind: 'floating', local: '20261201T100000' }, end: { kind: 'floating', local: '20261201T110000' } }))).toBe('time_form_not_allowed');
        expect(fieldOf(() => buildCreateResource({ ...BASE, start: { kind: 'floating', local: '20261201T100000' }, end: { kind: 'floating', local: '20261201T110000' } }))).toBe('start');
        expect(reasonOf(() => buildCreateResource({ ...BASE, now: '20261112T181500' }))).toBe('time_invalid');
        expect(fieldOf(() => buildCreateResource({ ...BASE, now: '20261112T181500' }))).toBe('now');
    });

    test('UID charset and length', () => {
        for (const uid of ['cmcp1-Qm9yZWQ', 'a', 'A.b_c~d@e+f=g-h', 'x'.repeat(255)]) { expect(reasonOf(() => buildCreateResource({ ...BASE, uid }))).toBeNull(); }
        for (const uid of ['', 'x'.repeat(256), 'a b', 'a;b', 'a,b', 'a:b', 'a\\b', 'a\r\nATTENDEE:mailto:x@y', 'ü', '"q"']) {
            expect(reasonOf(() => buildCreateResource({ ...BASE, uid }))).toBe('uid_invalid');
        }
    });

    test('enum and sequence values are checked at runtime too', () => {
        expect(statusProperty('CANCELLED').line).toBe('STATUS:CANCELLED');
        expect(transparencyProperty('OPAQUE').line).toBe('TRANSP:OPAQUE');
        expect(sequenceProperty(0).line).toBe('SEQUENCE:0');
        expect(sequenceProperty(2_147_483_647).line).toBe('SEQUENCE:2147483647');
        expect(reasonOf(() => statusProperty('NEEDS-ACTION' as 'CONFIRMED'))).toBe('enum_invalid');
        expect(reasonOf(() => statusProperty('CONFIRMED\r\nX:1' as 'CONFIRMED'))).toBe('enum_invalid');
        expect(reasonOf(() => transparencyProperty('opaque' as 'OPAQUE'))).toBe('enum_invalid');
        expect(reasonOf(() => buildCreateResource({ ...BASE, status: 'CANCELLED' as 'CONFIRMED' }))).toBe('enum_invalid');
        for (const value of [-1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY]) { expect(reasonOf(() => sequenceProperty(value))).toBe('sequence_invalid'); }
    });

    test('written values are registered: only this module can produce them', () => {
        const written = textProperty('SUMMARY', 'x');
        expect<unknown>(isWrittenProperty(written)).toBe(true);
        expect<unknown>(Object.isFrozen(written)).toBe(true);
        expect<unknown>(isWrittenProperty({ name: 'SUMMARY', line: 'SUMMARY:x' })).toBe(false);
        expect<unknown>(isWrittenProperty({ ...written })).toBe(false);
        const alarm = displayAlarm('PT10M');
        expect<unknown>(isWrittenComponent(alarm)).toBe(true);
        expect<unknown>(alarm.lines).toEqual(['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM']);
        expect<unknown>(isWrittenComponent({ ...alarm })).toBe(false);
    });
});

// ---- Grammars (design 6.4) ----

describe('alarm before_start duration grammar', () => {
    test('accepted, written as TRIGGER:-<text>', () => {
        for (const text of ['PT10M', 'P1W', 'P9999W', 'P1D', 'P0D', 'PT0S', 'P1DT2H', 'P1DT2H3M4S', 'PT1H30M', 'PT9999S', 'PT1H', 'PT1M1S', 'P2DT5M', 'PT010M']) {
            expect(parseAlarmOffset(text)).toBe(text);
            expect<unknown>(displayAlarm(text).lines[3]).toBe(`TRIGGER:-${text}`);
        }
    });

    test('refused: no component, wrong order, signs, case, units, fractions, breakouts', () => {
        for (const text of ['', 'P', 'PT', 'P1DT', 'P1W2D', 'P1WT1H', '-PT10M', '+PT10M', 'PT10m', 'pt10m', 'PT10M\r\nATTENDEE:mailto:x@y', 'PT10M;X=1', 'PT10M:', 'PT10000M',
            'P10000W', 'P1Y', 'P1M', 'PT1.5H', 'P1H', 'PT1M2H', 'PT1S1M', ' PT1M', 'PT1M ', 'PT1H1H', 'T1H', 'PT-1M', 'P1D2D']) {
            expect(reasonOf(() => parseAlarmOffset(text))).toBe('trigger_invalid');
            expect(reasonOf(() => buildCreateResource({ ...BASE, alarms: [{ before_start: text }] }))).toBe('trigger_invalid');
        }
    });

    test('at most ten alarms', () => {
        const alarms = Array.from({ length: 10 }, () => ({ before_start: 'PT1M' }));
        expect(reasonOf(() => buildCreateResource({ ...BASE, alarms }))).toBeNull();
        expect(reasonOf(() => buildCreateResource({ ...BASE, alarms: [...alarms, { before_start: 'PT1M' }] }))).toBe('too_many_alarms');
    });
});

describe('RRULE strict lexical grammar', () => {
    test('accepted and re-serialised from parsed parts, in source order', () => {
        const table: [string, IcsTime['kind'], string][] = [
            ['FREQ=WEEKLY;BYDAY=TU', 'zoned', 'FREQ=WEEKLY;BYDAY=TU'],
            ['freq=daily;interval=2', 'utc', 'FREQ=DAILY;INTERVAL=2'],
            ['BYDAY=MO,WE;FREQ=WEEKLY', 'utc', 'BYDAY=MO,WE;FREQ=WEEKLY'],
            ['FREQ=MONTHLY;BYDAY=-1FR', 'zoned', 'FREQ=MONTHLY;BYDAY=-1FR'],
            ['FREQ=MONTHLY;BYDAY=+2MO,1TU,53WE,-53TH', 'zoned', 'FREQ=MONTHLY;BYDAY=+2MO,1TU,53WE,-53TH'],
            ['FREQ=YEARLY;BYMONTH=1,2,12;BYMONTHDAY=-31,1,+31', 'date', 'FREQ=YEARLY;BYMONTH=1,2,12;BYMONTHDAY=-31,1,+31'],
            ['FREQ=WEEKLY;UNTIL=20271231T235959Z', 'utc', 'FREQ=WEEKLY;UNTIL=20271231T235959Z'],
            ['FREQ=WEEKLY;UNTIL=20271231T235959Z', 'zoned', 'FREQ=WEEKLY;UNTIL=20271231T235959Z'],
            ['FREQ=DAILY;UNTIL=20271231', 'date', 'FREQ=DAILY;UNTIL=20271231'],
            ['FREQ=DAILY;UNTIL=20271231T235959', 'floating', 'FREQ=DAILY;UNTIL=20271231T235959'],
            ['FREQ=DAILY;COUNT=10000', 'utc', 'FREQ=DAILY;COUNT=10000'],
            ['FREQ=DAILY;COUNT=1', 'utc', 'FREQ=DAILY;COUNT=1'],
            ['FREQ=DAILY;INTERVAL=1000', 'utc', 'FREQ=DAILY;INTERVAL=1000'],
            ['FREQ=DAILY;INTERVAL=007', 'utc', 'FREQ=DAILY;INTERVAL=7'],
            ['FREQ=MINUTELY;BYSECOND=0,60;BYMINUTE=0,59;BYHOUR=0,23', 'utc', 'FREQ=MINUTELY;BYSECOND=0,60;BYMINUTE=0,59;BYHOUR=0,23'],
            ['FREQ=YEARLY;BYYEARDAY=-366,366;BYWEEKNO=-53,53;BYSETPOS=-366,1', 'utc', 'FREQ=YEARLY;BYYEARDAY=-366,366;BYWEEKNO=-53,53;BYSETPOS=-366,1'],
            ['FREQ=WEEKLY;WKST=SU', 'utc', 'FREQ=WEEKLY;WKST=SU'],
            ['FREQ=SECONDLY', 'utc', 'FREQ=SECONDLY'],
            ['FREQ=HOURLY', 'utc', 'FREQ=HOURLY'],
            [`FREQ=YEARLY;BYMONTHDAY=${Array.from({ length: 64 }, (_, index) => String((index % 31) + 1)).join(',')}`, 'utc', `FREQ=YEARLY;BYMONTHDAY=${Array.from({ length: 64 }, (_, index) => String((index % 31) + 1)).join(',')}`],
        ];
        for (const [input, form, written] of table) {
            expect(serializeRrule(parseRrule(input, form), form)).toBe(written);
            expect(rruleProperty(input, form).line).toBe(`RRULE:${written}`);
        }
    });

    test('parsed parts are exposed for split planning and re-validated on serialisation', () => {
        const parsed = parseRrule('FREQ=WEEKLY;COUNT=5;BYDAY=TU', 'utc');
        expect<unknown>(parsed.parts).toEqual([{ key: 'FREQ', value: 'WEEKLY' }, { key: 'COUNT', value: '5' }, { key: 'BYDAY', value: 'TU' }]);
        const truncated = { parts: [...parsed.parts.filter(part => part.key !== 'COUNT'), { key: 'UNTIL' as const, value: '20261215T145959Z' }] };
        expect(serializeRrule(truncated, 'utc')).toBe('FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z');
        expect(reasonOf(() => serializeRrule({ parts: [...parsed.parts, { key: 'UNTIL', value: '20261215T145959Z' }] }, 'utc'))).toBe('rrule_until_count');
        expect(reasonOf(() => serializeRrule({ parts: [{ key: 'FREQ', value: 'WEEKLY\r\nATTENDEE:mailto:x@y' }] }, 'utc'))).toBe('rrule_syntax');
    });

    test('refused with a fixed reason', () => {
        const table: [string, IcsTime['kind'], string][] = [
            ['', 'utc', 'rrule_syntax'],
            ['BYDAY=MO', 'utc', 'rrule_freq_missing'],
            ['FREQ=WEEKLY;FREQ=DAILY', 'utc', 'rrule_duplicate_part'],
            ['FREQ=WEEKLY;BYDAY=MO;byday=TU', 'utc', 'rrule_duplicate_part'],
            ['FREQ=DAILY;COUNT=5;UNTIL=20270101T000000Z', 'utc', 'rrule_until_count'],
            ['FREQ=DAILY;INTERVAL=0', 'utc', 'rrule_value'],
            ['FREQ=DAILY;INTERVAL=1001', 'utc', 'rrule_value'],
            ['FREQ=DAILY;INTERVAL=00001', 'utc', 'rrule_value'],
            ['FREQ=DAILY;INTERVAL=+5', 'utc', 'rrule_value'],
            ['FREQ=DAILY;COUNT=0', 'utc', 'rrule_value'],
            ['FREQ=DAILY;COUNT=10001', 'utc', 'rrule_value'],
            ['FREQ=DAILY;COUNT=-1', 'utc', 'rrule_value'],
            ['FREQ=DAILY;BYSECOND=61', 'utc', 'rrule_value'],
            ['FREQ=DAILY;BYMINUTE=60', 'utc', 'rrule_value'],
            ['FREQ=DAILY;BYHOUR=24', 'utc', 'rrule_value'],
            ['FREQ=DAILY;BYHOUR=-1', 'utc', 'rrule_value'],
            ['FREQ=MONTHLY;BYMONTHDAY=0', 'utc', 'rrule_value'],
            ['FREQ=MONTHLY;BYMONTHDAY=32', 'utc', 'rrule_value'],
            ['FREQ=YEARLY;BYYEARDAY=367', 'utc', 'rrule_value'],
            ['FREQ=YEARLY;BYWEEKNO=54', 'utc', 'rrule_value'],
            ['FREQ=YEARLY;BYMONTH=13', 'utc', 'rrule_value'],
            ['FREQ=YEARLY;BYMONTH=0', 'utc', 'rrule_value'],
            ['FREQ=YEARLY;BYMONTH=+1', 'utc', 'rrule_value'],
            ['FREQ=YEARLY;BYSETPOS=0', 'utc', 'rrule_value'],
            ['FREQ=YEARLY;BYSETPOS=367', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;WKST=XX', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;WKST=1MO', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;BYDAY=+MO', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;BYDAY=54MO', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;BYDAY=0MO', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;BYDAY=100MO', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;BYDAY=MON', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;BYDAY=MO,,TU', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;BYDAY=', 'utc', 'rrule_value'],
            ['FREQ=WEEKLY;BYDAY=MO,', 'utc', 'rrule_value'],
            [`FREQ=YEARLY;BYMONTHDAY=${Array.from({ length: 65 }, () => '1').join(',')}`, 'utc', 'rrule_value'],
            ['FREQ=FORTNIGHTLY', 'utc', 'rrule_value'],
            ['FREQ=DAILY;', 'utc', 'rrule_syntax'],
            ['FREQ=DAILY;;COUNT=2', 'utc', 'rrule_syntax'],
            [';FREQ=DAILY', 'utc', 'rrule_syntax'],
            ['FREQ', 'utc', 'rrule_syntax'],
            ['FREQ==DAILY', 'utc', 'rrule_syntax'],
            ['=DAILY', 'utc', 'rrule_syntax'],
            ['FREQ=DAILY;X-FOO=1', 'utc', 'rrule_syntax'],
            ['FREQ=DAILY;BYEASTER=1', 'utc', 'rrule_unknown_part'],
            ['RRULE:FREQ=DAILY', 'utc', 'rrule_syntax'],
            ['FREQ=DAILY\r\nATTENDEE:mailto:x@y', 'utc', 'rrule_syntax'],
            ['FREQ=DAILY\nBEGIN:VALARM', 'utc', 'rrule_syntax'],
            ['FREQ=DAILY;COUNT=2:', 'utc', 'rrule_syntax'],
            ['FREQ=DAILY "x"', 'utc', 'rrule_syntax'],
            ['FREQ=DA\u0130LY', 'utc', 'rrule_syntax'],
            ['FREQ=DA\u0131LY', 'utc', 'rrule_syntax'],
            ['FREQ=DAILY\u0000', 'utc', 'rrule_syntax'],
            [`FREQ=DAILY;BYMONTHDAY=${'1,'.repeat(300)}1`, 'utc', 'rrule_too_long'],
            ['FREQ=DAILY;UNTIL=20270101', 'utc', 'rrule_until_form'],
            ['FREQ=DAILY;UNTIL=20270101', 'zoned', 'rrule_until_form'],
            ['FREQ=DAILY;UNTIL=20270101T000000', 'utc', 'rrule_until_form'],
            ['FREQ=DAILY;UNTIL=20270101T000000Z', 'date', 'rrule_until_form'],
            ['FREQ=DAILY;UNTIL=20270101T000000Z', 'floating', 'rrule_until_form'],
            ['FREQ=DAILY;UNTIL=20270230', 'date', 'rrule_value'],
            ['FREQ=DAILY;UNTIL=20271301T000000Z', 'utc', 'rrule_value'],
            ['FREQ=DAILY;UNTIL=20270101T250000Z', 'utc', 'rrule_value'],
        ];
        for (const [input, form, reason] of table) {
            expect<unknown>([input, reasonOf(() => parseRrule(input, form))]).toEqual([input, reason]);
        }
        expect(reasonOf(() => buildCreateResource({ ...BASE, rrule: 'FREQ=DAILY\r\nATTENDEE:mailto:x@y' }))).toBe('rrule_syntax');
        expect(fieldOf(() => buildCreateResource({ ...BASE, rrule: 'FREQ=DAILY;UNTIL=20270101' }))).toBe('rrule');
    });

    test('a long valid rule is accepted and anything over 512 characters refused before parsing', () => {
        // 64 items is the list cap, so the long rule spreads its length over three lists.
        const longRule = `FREQ=YEARLY;BYMONTHDAY=${Array.from({ length: 64 }, () => '31').join(',')};BYMONTH=${Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0')).join(',')};BYSETPOS=${Array.from({ length: 40 }, () => '-366').join(',')}`;
        expect<unknown>(longRule.length).toBeLessThanOrEqual(512);
        expect(reasonOf(() => parseRrule(longRule, 'utc'))).toBeNull();
        const padded = `${longRule};WKST=MO`.padEnd(513, 'X');
        expect<unknown>(padded.length).toBe(513);
        expect(reasonOf(() => parseRrule(padded, 'utc'))).toBe('rrule_too_long');
    });
});
