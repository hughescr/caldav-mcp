import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    describeEvents, editResource, IcsEditError, verifyUntouched, type ComponentEdit, type EditPlan, type EditReport, type EventOutline, type NewComponentItem, type ResourceEdit,
} from '../src/calendar/ics-edit';
import {
    displayAlarm, rruleProperty, sequenceProperty, statusProperty, textProperty, timeProperty, transparencyProperty, uidProperty, type WrittenProperty,
} from '../src/calendar/ics-write';
import { parseOriginalResource } from '../src/calendar/ical';
import type { EventComponent, OriginalResource } from '../src/calendar/model';

// Expected outputs are hand-written: physical lines of the input fixture (by 1-based line number, read from the file, never
// from the editor) spliced with hand-written new lines. The fixture is LF; every output must be CRLF.

const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures/calendar/ics-write/apple-series.ics'), 'utf8');
const PHYSICAL = FIXTURE.slice(0, -1).split('\n');
/** Fixture physical lines a..b, 1-based and inclusive, exactly as in the file. */
const lines = (first: number, last = first): string[] => PHYSICAL.slice(first - 1, last);
const crlf = (physical: readonly string[]): string => `${physical.join('\r\n')}\r\n`;
const octets = (text: string): number => Buffer.byteLength(text, 'utf8');

const NOW = { kind: 'utc', utc: '20261113T090000Z' } as const;
const RID_DEC08 = 'RECURRENCE-ID;TZID=America/New_York:20261208T100000';
const RID_DEC22 = 'RECURRENCE-ID;TZID=America/New_York:20261222T100000';
const zoned = (local: string): { kind: 'zoned'; local: string; tzid: string } => ({ kind: 'zoned', local, tzid: 'America/New_York' });

function reasonOf(action: () => unknown): string | null {
    try { action(); } catch (error) { return error instanceof IcsEditError ? error.reason : `other:${String(error)}`; }
    return null;
}

const parse = (text: string): OriginalResource => parseOriginalResource(text, {});
function masterOf(resource: OriginalResource): EventComponent {
    if (resource.master === null) { throw new Error('no master'); }
    return resource.master;
}
const valueOf = (component: EventComponent | undefined, name: string): unknown => component?.properties.get(name)?.[0]?.values[0];

/** Logical lines as arrays of physical lines, by this file's own splitter. */
function logical(text: string): string[][] {
    const physical = text.split(/\r\n|\n/u);
    if (physical.at(-1) === '') { physical.pop(); }
    const result: string[][] = [];
    for (const line of physical) {
        const last = result.at(-1);
        if (last !== undefined && (line.startsWith(' ') || line.startsWith('\t'))) { last.push(line); } else { result.push([line]); }
    }
    return result;
}

const MASTER_EDITS: ComponentEdit[] = [
    { op: 'set', property: textProperty('SUMMARY', 'Weekly sync — renamed') },
    { op: 'remove', name: 'LOCATION' },
    { op: 'set', property: textProperty('DESCRIPTION', `New agenda, ${'x'.repeat(88)}`) },
    { op: 'set', property: timeProperty('DTSTAMP', NOW) },
    { op: 'set', property: timeProperty('LAST-MODIFIED', NOW) },
    { op: 'set', property: sequenceProperty(4) },
    { op: 'set', property: statusProperty('CONFIRMED') },
];

const MASTER_EXPECTED = crlf([
    ...lines(1, 25),
    'DTSTAMP:20261113T090000Z',
    'LAST-MODIFIED:20261113T090000Z',
    'SEQUENCE:4',
    ...lines(29, 33),
    'SUMMARY:Weekly sync — renamed',
    `DESCRIPTION:New agenda\\, ${'x'.repeat(50)}`,
    ` ${'x'.repeat(38)}`,
    ...lines(42, 48),
    'STATUS:CONFIRMED',
    ...lines(49, 93),
]);

describe('the fixture is what the tests assume', () => {
    test('Apple-style shape: 91-octet iCloud folds, a TAB continuation, a fold after a trailing space, LF endings', () => {
        expect<unknown>(PHYSICAL).toHaveLength(93);
        expect<unknown>(FIXTURE.includes('\r')).toBe(false);
        expect<unknown>(PHYSICAL.filter(line => octets(line) === 91).length).toBeGreaterThanOrEqual(3);
        expect<unknown>(PHYSICAL[39]?.startsWith('\t')).toBe(true);
        expect<unknown>(PHYSICAL[38]?.endsWith(' ')).toBe(true);
        expect<unknown>(lines(34)).toEqual(['SUMMARY:Weekly sync']);
        expect<unknown>(lines(58)).toEqual(['END:VEVENT']);
        expect<unknown>(lines(65)).toEqual([RID_DEC08]);
        expect<unknown>(lines(82)).toEqual([RID_DEC22]);
        const parsed = parse(FIXTURE);
        expect<unknown>([parsed.kind, parsed.overrides.length, parsed.vtimezoneCount, masterOf(parsed).alarmCount]).toEqual(['series', 2, 1, 1]);
    });

    test('describeEvents lists the top-level VEVENTs with logical line indices', () => {
        const outline = describeEvents(FIXTURE);
        expect<unknown>(outline.map(event => [event.begin, event.end, event.recurrenceId, event.alarms])).toEqual([
            [22, 53, null, [{ begin: 44, end: 51 }]],
            [54, 71, RID_DEC08, [{ begin: 65, end: 70 }]],
            [72, 82, RID_DEC22, []],
        ]);
        expect<unknown>(outline[0]?.properties.find(line => line.name === 'location')).toEqual({
            index: 34, name: 'location', text: 'LOCATION:Konferenzraum Süd – Gebäude 4\\, Straße der Einheit 12\\; 10117 Berlin\\, Deutschland (Eingang über den Innenhof)',
        });
    });
});

describe('master edits', () => {
    test('replace, remove (with Apple companions), add before the first nested BEGIN; everything else byte-equal', () => {
        const result = editResource(FIXTURE, { target: { kind: 'master' }, edits: MASTER_EDITS });
        expect(result.text).toBe(MASTER_EXPECTED);
        expect<unknown>(result.report).toEqual({
            removed: [25, 26, 27, 33, 34, 35, 36, 37],
            written: [25, 26, 27, 33, 34, 41],
            copied: [],
            target: { begin: 22, end: 53 },
            removedComponents: [],
            changes: [
                { action: 'replaced', name: 'SUMMARY', reason: 'requested', original: 33, output: 33 },
                { action: 'removed', name: 'LOCATION', reason: 'requested', original: 34, output: null },
                { action: 'removed', name: 'X-APPLE-STRUCTURED-LOCATION', reason: 'paired', original: 35, output: null },
                { action: 'replaced', name: 'DESCRIPTION', reason: 'requested', original: 36, output: 34 },
                { action: 'removed', name: 'X-ALT-DESC', reason: 'paired', original: 37, output: null },
                { action: 'replaced', name: 'DTSTAMP', reason: 'requested', original: 25, output: 25 },
                { action: 'replaced', name: 'LAST-MODIFIED', reason: 'requested', original: 26, output: 26 },
                { action: 'replaced', name: 'SEQUENCE', reason: 'requested', original: 27, output: 27 },
                { action: 'added', name: 'STATUS', reason: 'requested', original: null, output: 41 },
            ],
        });
        expect<unknown>(verifyUntouched(FIXTURE, result.text, result.report)).toEqual({ ok: true });
    });

    test('round trip: parsed values equal the requested ones, overrides deep-equal, the VALARM keeps its own SUMMARY/DESCRIPTION', () => {
        const before = parse(FIXTURE);
        const after = parse(editResource(FIXTURE, { target: { kind: 'master' }, edits: MASTER_EDITS }).text);
        const event = masterOf(after);
        expect<unknown>(valueOf(event, 'summary')).toBe('Weekly sync — renamed');
        expect<unknown>(valueOf(event, 'description')).toBe(`New agenda, ${'x'.repeat(88)}`);
        expect<unknown>(valueOf(event, 'status')).toBe('CONFIRMED');
        expect<unknown>(valueOf(event, 'sequence')).toBe(4);
        for (const name of ['location', 'x-apple-structured-location', 'x-alt-desc']) { expect<unknown>(event.properties.has(name)).toBe(false); }
        for (const name of ['uid', 'created', 'dtstart', 'dtend', 'rrule', 'exdate', 'x-custom-flag', 'comment', 'attach', 'transp', 'x-apple-travel-advisory-behavior']) {
            expect<unknown>([name, event.properties.get(name)]).toEqual([name, masterOf(before).properties.get(name)]);
        }
        expect<unknown>(event.alarmCount).toBe(1);
        expect<unknown>(after.overrides.map(override => override.properties)).toEqual(before.overrides.map(override => override.properties));
        expect<unknown>(after.vtimezoneCount).toBe(1);
        expect(MASTER_EXPECTED).toContain(crlf(lines(49, 56)));
    });

    test('CRLF, LF, mixed and unterminated input give the same CRLF output', () => {
        const variants = [
            FIXTURE,
            FIXTURE.replaceAll('\n', '\r\n'),
            PHYSICAL.map((line, index) => `${line}${index % 3 === 0 ? '\r\n' : '\n'}`).join(''),
            FIXTURE.slice(0, -1),
            FIXTURE.replaceAll('\n', '\r\n').slice(0, -2),
        ];
        for (const input of variants) {
            const result = editResource(input, { target: { kind: 'master' }, edits: MASTER_EDITS });
            expect(result.text).toBe(MASTER_EXPECTED);
            expect<unknown>(verifyUntouched(input, result.text, result.report)).toEqual({ ok: true });
        }
    });

    test('a lone CR anywhere is refused: it is a line break to the pre-scan but data to ICAL.parse', () => {
        expect(reasonOf(() => editResource(FIXTURE.replaceAll('\n', '\r'), { target: { kind: 'master' }, edits: MASTER_EDITS }))).toBe('lone_cr');
        expect(reasonOf(() => editResource(FIXTURE.replace('SUMMARY:Weekly sync\n', 'SUMMARY:Weekly\rATTENDEE:mailto:x@y\n'), { target: { kind: 'master' }, edits: [] }))).toBe('lone_cr');
        expect(reasonOf(() => describeEvents(FIXTURE.replace('\n', '\r')))).toBe('lone_cr');
    });

    test('replacing the RRULE and the alarms: VALARMs removed whole, the new one before END', () => {
        const result = editResource(FIXTURE, {
            target: { kind: 'master' },
            edits: [
                { op: 'replace', property: rruleProperty('FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z', 'zoned') },
                { op: 'remove_alarms' },
                { op: 'add_alarm', alarm: displayAlarm('PT30M') },
            ],
        });
        expect(result.text).toBe(crlf([
            ...lines(1, 30),
            'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z',
            ...lines(32, 48),
            ...lines(57),
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            'DESCRIPTION:Reminder',
            'TRIGGER:-PT30M',
            'END:VALARM',
            ...lines(58, 93),
        ]));
        expect<unknown>(result.report.removed).toEqual([30, 44, 45, 46, 47, 48, 49, 50, 51]);
        expect<unknown>(result.report.written).toEqual([30, 45, 46, 47, 48, 49]);
        const event = masterOf(parse(result.text));
        expect<unknown>(valueOf(event, 'rrule')).toEqual({ freq: 'WEEKLY', byday: 'TU', until: '2026-12-15T14:59:59Z' });
        expect<unknown>(event.alarmCount).toBe(1);
    });

    test('a new property in a component without nested components goes before END', () => {
        const text = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'DTEND:20270111T110000Z', 'END:VEVENT', 'END:VCALENDAR']);
        const result = editResource(text, { target: { kind: 'master' }, edits: [{ op: 'set', property: transparencyProperty('TRANSPARENT') }, { op: 'add_alarm', alarm: displayAlarm('PT1M') }] });
        expect(result.text).toBe(crlf([
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'DTEND:20270111T110000Z', 'TRANSP:TRANSPARENT',
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT1M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
        ]));
    });

    test('DESCRIPTION on an event whose only DESCRIPTION is inside its VALARM adds a direct one', () => {
        const text = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'SUMMARY:s', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:alarm text', 'SUMMARY:alarm summary', 'TRIGGER:-PT5M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR']);
        const result = editResource(text, {
            target: { kind: 'master' },
            edits: [{ op: 'set', property: textProperty('DESCRIPTION', 'event text') }, { op: 'set', property: textProperty('SUMMARY', 'new') }, { op: 'remove', name: 'LOCATION' }],
        });
        expect(result.text).toBe(crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'SUMMARY:new', 'DESCRIPTION:event text', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:alarm text', 'SUMMARY:alarm summary', 'TRIGGER:-PT5M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR']));
    });

    test('a replaced DTSTART/DTEND pair and a removed DURATION', () => {
        const text = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'DURATION:PT1H', 'END:VEVENT', 'END:VCALENDAR']);
        const result = editResource(text, {
            target: { kind: 'master' },
            edits: [
                { op: 'replace', property: timeProperty('DTSTART', zoned('20270111T090000')) },
                { op: 'set', property: timeProperty('DTEND', zoned('20270111T100000')) },
                { op: 'remove', name: 'DURATION' },
            ],
        });
        expect(result.text).toBe(crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART;TZID=America/New_York:20270111T090000', 'DTEND;TZID=America/New_York:20270111T100000', 'END:VEVENT', 'END:VCALENDAR']));
    });
});

describe('override edits', () => {
    test('only the selected override changes; its VALARM DESCRIPTION, the master and the other override are byte-equal', () => {
        const result = editResource(FIXTURE, {
            target: { kind: 'override', recurrenceId: RID_DEC08 },
            edits: [
                { op: 'set', property: textProperty('SUMMARY', 'Moved, renamed') },
                { op: 'remove', name: 'LOCATION' },
                { op: 'set', property: sequenceProperty(5) },
                { op: 'set', property: timeProperty('DTSTAMP', NOW) },
                { op: 'set', property: timeProperty('LAST-MODIFIED', NOW) },
                { op: 'set', property: transparencyProperty('TRANSPARENT') },
            ],
        });
        expect(result.text).toBe(crlf([
            ...lines(1, 61),
            'DTSTAMP:20261113T090000Z',
            'LAST-MODIFIED:20261113T090000Z',
            'SEQUENCE:5',
            ...lines(65, 67),
            'SUMMARY:Moved\\, renamed',
            'TRANSP:TRANSPARENT',
            ...lines(70, 93),
        ]));
        expect<unknown>(result.report.target).toEqual({ begin: 54, end: 71 });
        const before = parse(FIXTURE);
        const after = parse(result.text);
        expect<unknown>(masterOf(after).properties).toEqual(masterOf(before).properties);
        expect<unknown>(after.overrides[1]?.properties).toEqual(before.overrides[1]?.properties);
        expect<unknown>(valueOf(after.overrides[0], 'summary')).toBe('Moved, renamed');
        expect<unknown>(after.overrides[0]?.properties.has('location')).toBe(false);
        expect<unknown>(after.overrides[0]?.alarmCount).toBe(1);
    });

    test('the selector is the exact unfolded RECURRENCE-ID line text', () => {
        for (const recurrenceId of ['RECURRENCE-ID;TZID=America/New_York:20261208T100001', 'recurrence-id;TZID=America/New_York:20261208T100000', `${RID_DEC08} `, 'RECURRENCE-ID:20261208T150000Z', '20261208T100000']) {
            expect(reasonOf(() => editResource(FIXTURE, { target: { kind: 'override', recurrenceId }, edits: [{ op: 'set', property: sequenceProperty(5) }] }))).toBe('target_not_found');
        }
    });

    test('delete one occurrence: EXDATE after the existing EXDATE lines, its override removed whole', () => {
        const result = editResource(FIXTURE, {
            target: { kind: 'master' },
            edits: [
                { op: 'add', property: timeProperty('EXDATE', zoned('20261222T100000')) },
                { op: 'set', property: sequenceProperty(4) },
                { op: 'set', property: timeProperty('DTSTAMP', NOW) },
                { op: 'set', property: timeProperty('LAST-MODIFIED', NOW) },
            ],
            resource: [{ op: 'remove_component', target: { kind: 'override', recurrenceId: RID_DEC22 } }],
        });
        expect(result.text).toBe(crlf([
            ...lines(1, 25),
            'DTSTAMP:20261113T090000Z',
            'LAST-MODIFIED:20261113T090000Z',
            'SEQUENCE:4',
            ...lines(29, 33),
            'EXDATE;TZID=America/New_York:20261222T100000',
            ...lines(34, 76),
            ...lines(88, 93),
        ]));
        expect<unknown>(result.report.removedComponents).toEqual([{ begin: 72, end: 82 }]);
        const after = parse(result.text);
        expect<unknown>(after.overrides).toHaveLength(1);
        expect<unknown>(masterOf(after).properties.get('exdate')?.map(property => property.values[0])).toEqual(['2026-12-15T10:00:00', '2026-12-29T10:00:00', '2026-12-22T10:00:00']);
    });

    test('a first EXDATE goes in the new-property position', () => {
        const text = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART;VALUE=DATE:20270111', 'RRULE:FREQ=DAILY', 'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', 'DESCRIPTION:x', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR']);
        const result = editResource(text, { target: { kind: 'master' }, edits: [{ op: 'add', property: timeProperty('EXDATE', { kind: 'date', date: '20270112' }) }, { op: 'add', property: timeProperty('EXDATE', { kind: 'date', date: '20270113' }) }] });
        expect(result.text).toBe(crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART;VALUE=DATE:20270111', 'RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:20270112', 'EXDATE;VALUE=DATE:20270113', 'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', 'DESCRIPTION:x', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR']));
    });

    test('dropping every EXDATE (series move with exceptions: drop)', () => {
        const result = editResource(FIXTURE, { target: { kind: 'master' }, edits: [{ op: 'remove_all', name: 'EXDATE' }] });
        expect(result.text).toBe(crlf([...lines(1, 31), ...lines(34, 93)]));
    });

    test('add a new override before END:VCALENDAR from byte copies of master lines plus written lines', () => {
        const outline = describeEvents(FIXTURE);
        const master = outline.find(event => event.recurrenceId === null) as EventOutline;
        const index = (name: string): number => master.properties.find(line => line.name === name)?.index ?? -1;
        const items: NewComponentItem[] = [
            { copy_line: index('created') },
            { copy_line: index('uid') },
            { copy_line: index('summary') },
            { copy_line: index('location') },
            { copy_line: index('x-apple-structured-location') },
            { copy_line: index('description') },
            { copy_line: index('x-alt-desc') },
            { copy_line: index('x-custom-flag') },
            { copy_line: index('transp') },
            timeProperty('DTSTART', zoned('20270105T110000')),
            timeProperty('DTEND', zoned('20270105T113000')),
            timeProperty('RECURRENCE-ID', zoned('20270105T100000')),
            timeProperty('DTSTAMP', NOW),
            timeProperty('LAST-MODIFIED', NOW),
            sequenceProperty(4),
            { copy_component: master.alarms[0]?.begin ?? -1 },
        ];
        const result = editResource(FIXTURE, { resource: [{ op: 'add_component', items }] });
        expect(result.text).toBe(crlf([
            ...lines(1, 92),
            'BEGIN:VEVENT',
            ...lines(24),
            ...lines(25),
            ...lines(34),
            ...lines(35, 36),
            ...lines(37, 38),
            ...lines(39, 40),
            ...lines(41),
            ...lines(42),
            ...lines(48),
            'DTSTART;TZID=America/New_York:20270105T110000',
            'DTEND;TZID=America/New_York:20270105T113000',
            'RECURRENCE-ID;TZID=America/New_York:20270105T100000',
            'DTSTAMP:20261113T090000Z',
            'LAST-MODIFIED:20261113T090000Z',
            'SEQUENCE:4',
            ...lines(49, 56),
            'END:VEVENT',
            ...lines(93),
        ]));
        expect<unknown>(result.report.target).toBeNull();
        expect<unknown>(result.report.copied.map(copy => copy.original)).toEqual([23, 24, 33, 34, 35, 36, 37, 38, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
        expect<unknown>(verifyUntouched(FIXTURE, result.text, result.report)).toEqual({ ok: true });
        const before = parse(FIXTURE);
        const after = parse(result.text);
        expect<unknown>(after.overrides).toHaveLength(3);
        const added = after.overrides[2];
        expect<unknown>(added?.recurrenceId?.raw.values).toEqual(['2027-01-05T10:00:00']);
        for (const name of ['summary', 'location', 'x-apple-structured-location', 'description', 'x-alt-desc']) {
            expect<unknown>(added?.properties.get(name)).toEqual(masterOf(before).properties.get(name));
        }
        expect<unknown>(added?.alarmCount).toBe(1);
        expect<unknown>(masterOf(after).properties).toEqual(masterOf(before).properties);
    });
});

describe('refusals', () => {
    const SIMPLE = (...extra: string[]): string => crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'DTEND:20270111T110000Z', ...extra, 'END:VEVENT', 'END:VCALENDAR']);
    const masterPlan = (...edits: ComponentEdit[]): EditPlan => ({ target: { kind: 'master' }, edits });

    test('an edited singleton that occurs twice is an error; unedited duplicates and duplicate parameters are preserved', () => {
        const text = SIMPLE('SUMMARY:one', 'SUMMARY:two', 'X-FOO;X-A=1;X-A=2:v', 'X-FOO;X-A=1;X-A=2:v');
        expect(reasonOf(() => editResource(text, masterPlan({ op: 'set', property: textProperty('SUMMARY', 'x') })))).toBe('duplicate_property');
        expect(reasonOf(() => editResource(text, masterPlan({ op: 'replace', property: textProperty('SUMMARY', 'x') })))).toBe('duplicate_property');
        expect(reasonOf(() => editResource(text, masterPlan({ op: 'remove', name: 'SUMMARY' })))).toBe('duplicate_property');
        expect(reasonOf(() => editResource(text, masterPlan({ op: 'remove', name: 'X-FOO' })))).toBe('duplicate_property');
        const result = editResource(text, masterPlan({ op: 'set', property: textProperty('LOCATION', 'here') }));
        expect(result.text).toBe(SIMPLE('SUMMARY:one', 'SUMMARY:two', 'X-FOO;X-A=1;X-A=2:v', 'X-FOO;X-A=1;X-A=2:v', 'LOCATION:here'));
    });

    test('a duplicated Apple companion makes the paired edit an error', () => {
        const text = SIMPLE('DESCRIPTION:d', 'X-ALT-DESC:a', 'X-ALT-DESC:b');
        expect(reasonOf(() => editResource(text, masterPlan({ op: 'set', property: textProperty('DESCRIPTION', 'x') })))).toBe('duplicate_property');
        expect(reasonOf(() => editResource(text, masterPlan({ op: 'remove', name: 'DESCRIPTION' })))).toBe('duplicate_property');
    });

    test('a duplicate SUMMARY in another VEVENT does not block an edit of the master', () => {
        const text = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:m', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:u1', 'RECURRENCE-ID:20270112T100000Z', 'DTSTART:20270112T100000Z', 'SUMMARY:a', 'SUMMARY:b', 'END:VEVENT', 'END:VCALENDAR']);
        const result = editResource(text, masterPlan({ op: 'set', property: textProperty('SUMMARY', 'n') }));
        expect(result.text).toBe(text.replace('SUMMARY:m', 'SUMMARY:n'));
        expect(reasonOf(() => editResource(text, { target: { kind: 'override', recurrenceId: 'RECURRENCE-ID:20270112T100000Z' }, edits: [{ op: 'set', property: textProperty('SUMMARY', 'n') }] }))).toBe('duplicate_property');
    });

    test('identity, structure and multi-valued names', () => {
        expect(reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'set', property: uidProperty('other') })))).toBe('edit_not_allowed');
        expect(reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'set', property: timeProperty('RECURRENCE-ID', NOW) })))).toBe('edit_not_allowed');
        for (const name of ['UID', 'RECURRENCE-ID', 'DTSTART', 'BEGIN', 'END', 'EXDATE', 'X-FOO;X=1', 'X-FOO:x', '', 'SUMMARY\r\nATTENDEE']) {
            expect([name, reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'remove', name })))]).toEqual([name, 'edit_not_allowed']);
        }
        expect(reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'set', property: timeProperty('EXDATE', zoned('20261222T100000')) })))).toBe('edit_not_allowed');
        expect(reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'add', property: textProperty('SUMMARY', 'x') })))).toBe('edit_not_allowed');
        expect(reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'remove_all', name: 'SUMMARY' })))).toBe('edit_not_allowed');
        expect(reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'replace', property: statusProperty('CONFIRMED') })))).toBe('property_absent');
        expect(reasonOf(() => editResource(FIXTURE, { resource: [{ op: 'remove_component', target: { kind: 'master' } as unknown as { kind: 'override'; recurrenceId: string } }] }))).toBe('edit_not_allowed');
    });

    test('conflicting edits', () => {
        const conflicts: EditPlan[] = [
            masterPlan({ op: 'set', property: textProperty('SUMMARY', 'a') }, { op: 'set', property: textProperty('SUMMARY', 'b') }),
            masterPlan({ op: 'set', property: textProperty('LOCATION', 'a') }, { op: 'remove', name: 'X-APPLE-STRUCTURED-LOCATION' }),
            masterPlan({ op: 'remove', name: 'LOCATION' }, { op: 'set', property: textProperty('LOCATION', 'a') }),
            masterPlan({ op: 'remove_alarms' }, { op: 'remove_alarms' }),
            masterPlan({ op: 'add', property: timeProperty('EXDATE', zoned('20261222T100000')) }, { op: 'remove_all', name: 'EXDATE' }),
            { target: { kind: 'override', recurrenceId: RID_DEC22 }, edits: [{ op: 'set', property: sequenceProperty(9) }], resource: [{ op: 'remove_component', target: { kind: 'override', recurrenceId: RID_DEC22 } }] },
            { resource: [{ op: 'remove_component', target: { kind: 'override', recurrenceId: RID_DEC22 } }, { op: 'remove_component', target: { kind: 'override', recurrenceId: RID_DEC22 } }] },
        ];
        const reasons = conflicts.map(plan => reasonOf(() => editResource(FIXTURE, plan)));
        expect<unknown>(reasons).toEqual(['conflicting_edits', 'conflicting_edits', 'conflicting_edits', 'conflicting_edits', 'conflicting_edits', 'conflicting_edits', 'conflicting_edits']);
    });

    test('forged values are refused: only ics-write output is accepted', () => {
        const forged = { name: 'SUMMARY', line: 'SUMMARY:x\r\nATTENDEE:mailto:x@y' } as WrittenProperty;
        expect(reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'set', property: forged })))).toBe('value_not_written');
        expect(reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'set', property: { ...textProperty('SUMMARY', 'x') } })))).toBe('value_not_written');
        expect(reasonOf(() => editResource(FIXTURE, masterPlan({ op: 'add_alarm', alarm: { name: 'VALARM', lines: ['BEGIN:VALARM', 'END:VALARM'] } })))).toBe('value_not_written');
        const items = [forged as unknown as NewComponentItem];
        expect(reasonOf(() => editResource(FIXTURE, { resource: [{ op: 'add_component', items }] }))).toBe('value_not_written');
        expect(reasonOf(() => editResource(FIXTURE, { resource: [{ op: 'add_component', items: ['BEGIN:VALARM' as unknown as NewComponentItem] }] }))).toBe('value_not_written');
    });

    test('new components need exactly one UID and one RECURRENCE-ID, and copies only from VEVENT lines and VALARMs', () => {
        const outline = describeEvents(FIXTURE);
        const uidLine = outline[0]?.properties.find(line => line.name === 'uid')?.index ?? -1;
        const rid = timeProperty('RECURRENCE-ID', zoned('20270105T100000'));
        const start = timeProperty('DTSTART', zoned('20270105T100000'));
        const add = (...items: NewComponentItem[]): ResourceEdit[] => [{ op: 'add_component', items }];
        expect(reasonOf(() => editResource(FIXTURE, { resource: add({ copy_line: uidLine }, start) }))).toBe('component_invalid');
        expect(reasonOf(() => editResource(FIXTURE, { resource: add({ copy_line: uidLine }, { copy_line: uidLine }, rid, start) }))).toBe('component_invalid');
        expect(reasonOf(() => editResource(FIXTURE, { resource: add(rid, start) }))).toBe('component_invalid');
        // The VTIMEZONE's TZID line, the calendar's PRODID and BEGIN:VEVENT itself are not copyable lines.
        for (const copy of [6, 2, 22, -1, 1.5, 999]) {
            expect([copy, reasonOf(() => editResource(FIXTURE, { resource: add({ copy_line: uidLine }, rid, start, { copy_line: copy }) }))]).toEqual([copy, 'copy_invalid']);
        }
        // The DAYLIGHT sub-component of the VTIMEZONE is not a VALARM.
        expect(reasonOf(() => editResource(FIXTURE, { resource: add({ copy_line: uidLine }, rid, start, { copy_component: 7 }) }))).toBe('copy_invalid');
        // A second override for an existing occurrence fails the output re-parse.
        const duplicate = timeProperty('RECURRENCE-ID', zoned('20261208T100000'));
        expect(reasonOf(() => editResource(FIXTURE, { resource: add({ copy_line: uidLine }, duplicate, start) }))).toBe('output_invalid');
    });

    test('targets', () => {
        const occurrenceOnly = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'RECURRENCE-ID:20270112T100000Z', 'DTSTART:20270112T100000Z', 'END:VEVENT', 'END:VCALENDAR']);
        expect(reasonOf(() => editResource(occurrenceOnly, masterPlan({ op: 'set', property: sequenceProperty(1) })))).toBe('target_not_found');
        expect(reasonOf(() => editResource(occurrenceOnly, { target: { kind: 'override', recurrenceId: 'RECURRENCE-ID:20270112T100000Z' }, edits: [{ op: 'set', property: sequenceProperty(1) }] }))).toBeNull();
        expect(reasonOf(() => editResource(FIXTURE, { edits: [{ op: 'set', property: sequenceProperty(1) }] }))).toBe('target_not_found');
        expect(reasonOf(() => editResource(FIXTURE, { target: { kind: 'other' } as unknown as { kind: 'master' }, edits: [] }))).toBe('target_not_found');
    });

    test('input structure: unparseable, blank lines, nesting and parameters on BEGIN/END', () => {
        const plan = masterPlan({ op: 'set', property: sequenceProperty(1) });
        const table: [string, string][] = [
            [SIMPLE().replace('END:VEVENT\r\n', ''), 'original_unparseable'],
            [SIMPLE().replace('END:VEVENT', 'END:VTODO'), 'original_unparseable'],
            [` ${SIMPLE()}`, 'original_unparseable'],
            ['', 'original_unparseable'],
            [`${SIMPLE()}${SIMPLE()}`, 'original_unparseable'],
            [SIMPLE().replace('UID:u1\r\n', 'UID:u1\r\n\r\n'), 'blank_line'],
            [`${SIMPLE()}\r\n`, 'blank_line'],
            [SIMPLE().replace('BEGIN:VEVENT', 'BEGIN;X=1:VEVENT'), 'original_unparseable'],
        ];
        for (const [text, reason] of table) { expect<unknown>([text, reasonOf(() => editResource(text, plan))]).toEqual([text, reason]); }
    });

    test('an output over the 2 MiB resource cap is refused; a non-object plan is refused', () => {
        const base = SIMPLE('X-BIG:');
        const filler = 2 * 1024 * 1024 - Buffer.byteLength(base, 'utf8') - 100;
        const text = SIMPLE(`X-BIG:${'a'.repeat(filler)}`);
        expect(reasonOf(() => editResource(text, masterPlan({ op: 'set', property: sequenceProperty(1) })))).toBeNull();
        expect(reasonOf(() => editResource(text, masterPlan({ op: 'set', property: textProperty('DESCRIPTION', 'd'.repeat(8192)) })))).toBe('output_too_large');
        expect(reasonOf(() => editResource(text, null as unknown as EditPlan))).toBe('edit_not_allowed');
    });

    test('stored text the read path accepts is preserved verbatim even when this server would never write it', () => {
        const text = SIMPLE('X-FOO:a\u0000b', 'X-BAR;X-P=^n:raw \\x escapes');
        expect(editResource(text, masterPlan({ op: 'set', property: sequenceProperty(1) })).text).toBe(SIMPLE('X-FOO:a\u0000b', 'X-BAR;X-P=^n:raw \\x escapes', 'SEQUENCE:1'));
    });
});

// ---- Independent verification ----

describe('verifyUntouched catches a corrupted emit or report', () => {
    const good = editResource(FIXTURE, { target: { kind: 'master' }, edits: MASTER_EDITS });
    const outLines = good.text.slice(0, -2).split('\r\n');
    const withLines = (mutate: (physical: string[]) => void): string => {
        const copy = [...outLines];
        mutate(copy);
        return crlf(copy);
    };
    const reason = (after: string, report: EditReport = good.report): string | null => {
        const verdict = verifyUntouched(FIXTURE, after, report);
        return verdict.ok ? null : verdict.reason;
    };

    test('the genuine output passes', () => {
        expect(reason(good.text)).toBeNull();
    });

    test('content and folding of untouched lines', () => {
        expect(reason(good.text.replace('DTSTART;TZID=America/New_York:20261201T100000', 'DTSTART;TZID=America/New_York:20261201T110000'))).toBe('untouched_changed');
        expect(reason(good.text.replace('BEGIN:VTODO', 'BEGIN:VTODo'))).toBe('untouched_changed');
        // Same unfolded content, different folding: still a change of physical lines.
        expect(reason(good.text.replace('\r\n ttachments/notes.pdf', 'ttachments/notes.pdf'))).toBe('untouched_changed');
        const overrideEdit = editResource(FIXTURE, { target: { kind: 'override', recurrenceId: RID_DEC08 }, edits: [{ op: 'set', property: sequenceProperty(5) }] });
        expect<unknown>(verifyUntouched(FIXTURE, overrideEdit.text, overrideEdit.report)).toEqual({ ok: true });
        const swapped = overrideEdit.text.replace('\r\n\t日本語', '\r\n 日本語');
        expect<unknown>(swapped).not.toBe(overrideEdit.text);
        expect<unknown>(verifyUntouched(FIXTURE, swapped, overrideEdit.report)).toEqual({ ok: false, reason: 'untouched_changed', line: 36 });
    });

    test('line endings, missing and extra lines', () => {
        expect(reason(good.text.replace('VERSION:2.0\r\n', 'VERSION:2.0\n'))).toBe('line_endings');
        expect(reason(good.text.slice(0, -2))).toBe('line_endings');
        expect(reason(withLines(physical => { physical.splice(1, 1); }))).toBe('untouched_changed');
        expect(reason(withLines(physical => { physical.pop(); }))).toBe('line_count');
        // An injected line among untouched ones is neither kept nor reported as written.
        expect(reason(withLines(physical => { physical.splice(30, 0, 'ATTENDEE:mailto:x@y'); }))).toBe('untouched_changed');
        expect(reason(withLines(physical => { physical.push('ATTENDEE:mailto:x@y'); }))).toBe('line_count');
    });

    test('written lines must be legal folds', () => {
        const long = `SUMMARY:${'y'.repeat(70)}`;
        expect(reason(good.text.replace('SUMMARY:Weekly sync — renamed', long))).toBe('written_line_invalid');
        expect(reason(good.text.replace(`\r\n ${'x'.repeat(38)}`, `\r\n\t${'x'.repeat(38)}`))).toBe('written_line_invalid');
        expect(reason(good.text.replace(`\r\n ${'x'.repeat(38)}`, '\r\n '))).toBe('written_line_invalid');
    });

    test('a report that hides or misplaces a change', () => {
        expect(reason(good.text, { ...good.report, removed: good.report.removed.slice(1) })).toBe('untouched_changed');
        expect(reason(good.text, { ...good.report, written: [...good.report.written].reverse() })).toBe('report_invalid');
        expect(reason(good.text, { ...good.report, removed: [-1, ...good.report.removed] })).toBe('report_invalid');
        expect(reason(good.text, { ...good.report, target: { begin: 54, end: 71 } })).toBe('scope_violation');
        expect(reason(good.text, { ...good.report, target: null })).toBe('scope_violation');
        expect(reason(good.text, { ...good.report, copied: [{ output: 33, original: 33 }] })).toBe('copy_mismatch');
        expect(reason(good.text, { ...good.report, removedComponents: [{ begin: 54, end: 71 }] })).toBe('scope_violation');
        // Removing a VTIMEZONE line and claiming it was in the target.
        const vtimezoneGone = withLines(physical => { physical.splice(6, 1); });
        expect(reason(vtimezoneGone, { ...good.report, removed: [6, ...good.report.removed], written: good.report.written.map(index => index - 1) })).toBe('scope_violation');
        // Removing one line of a nested VALARM is not a whole-alarm removal.
        const alarmLine = withLines(physical => { physical.splice(physical.indexOf('SUMMARY:Alarm summary must stay'), 1); });
        // Original logical line 49 is the master VALARM's SUMMARY (BEGIN:VALARM is 44).
        const alarmIndex = 49;
        expect(reason(alarmLine, { ...good.report, removed: [...good.report.removed, alarmIndex].sort((a, b) => a - b) })).toBe('scope_violation');
    });
});

// ---- Large inline ATTACH ----

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

/** This file's own folder: at most `limit` octets per physical line on code points, continuation char `marker`. */
function refold(text: string, limit: number, marker: string): string[] {
    const out: string[] = [];
    let current = '';
    let used = 0;
    for (const character of text) {
        const size = octets(character);
        if (used + size > limit && current !== '' && current !== marker) {
            out.push(current);
            current = marker;
            used = 1;
        }
        current += character;
        used += size;
    }
    out.push(current);
    return out;
}

describe('a 100 KB inline base64 ATTACH survives byte for byte', () => {
    const random = mulberry32(0xA77AC4);
    const bytes = Buffer.from(Array.from({ length: 75_000 }, () => Math.floor(random() * 256)));
    const attach = refold(`ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=application/octet-stream;X-APPLE-FILENAME=blob.bin:${bytes.toString('base64')}`, 91, ' ');
    const input = crlf([...lines(1, 47), ...attach, ...lines(48, 93)]);

    test('master edits leave the attachment lines identical and its decoded value equal', () => {
        expect<unknown>(attach.length).toBeGreaterThan(1000);
        const result = editResource(input, { target: { kind: 'master' }, edits: MASTER_EDITS });
        expect(result.text).toContain(crlf(attach));
        expect<unknown>(verifyUntouched(input, result.text, result.report)).toEqual({ ok: true });
        const before = masterOf(parse(input)).attachments;
        const after = masterOf(parse(result.text)).attachments;
        expect<unknown>(after).toEqual(before);
        expect<unknown>(after.find(attachment => attachment.form === 'inline')?.inlineBase64).toBe(bytes.toString('base64'));
    });
});

// ---- Seeded fuzz ----

describe('seeded fuzz: random edits never change an untouched logical line', () => {
    const SOURCE = logical(FIXTURE);
    const TEXT_ALPHABET = ['a', 'Z', ' ', '\t', ';', ',', ':', '"', '^', '\\', '\n', '\r\n', 'é', '€', '中', '😀', 'é', '‮', 'BEGIN:VALARM', 'END:VEVENT'];

    function randomInput(random: () => number): string {
        const physical: string[] = [];
        for (const group of SOURCE) {
            const unfolded = group.map((part, index) => (index === 0 ? part : part.slice(1))).join('');
            const limit = random() < 0.5 ? 1000 : 10 + Math.floor(random() * 110);
            physical.push(...refold(unfolded, limit, random() < 0.5 ? ' ' : '\t'));
        }
        const endings = physical.map(() => (random() < 0.5 ? '\r\n' : '\n'));
        const text = physical.map((line, index) => `${line}${endings[index] ?? '\n'}`).join('');
        return random() < 0.2 ? text.replace(/\r?\n$/u, '') : text;
    }

    function randomText(random: () => number): string {
        let value = '';
        const length = Math.floor(random() * 120);
        for (let index = 0; index < length; index++) { value += TEXT_ALPHABET[Math.floor(random() * TEXT_ALPHABET.length)] ?? ''; }
        return value.slice(0, 1024);
    }

    test('500 seeded plans on randomly re-folded, mixed-ending inputs', () => {
        const random = mulberry32(0xF0221);
        const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
        for (let iteration = 0; iteration < 500; iteration++) {
            const input = randomInput(random);
            const targetIndex = Math.floor(random() * 3);
            const outline = describeEvents(input);
            const targetOutline = outline[targetIndex] as EventOutline;
            const target = targetOutline.recurrenceId === null ? { kind: 'master' as const } : { kind: 'override' as const, recurrenceId: targetOutline.recurrenceId };
            const edits: ComponentEdit[] = [];
            const edited = new Set<string>();
            if (random() < 0.6) { edits.push({ op: 'set', property: textProperty('SUMMARY', randomText(random)) }); edited.add('summary'); }
            if (random() < 0.4) {
                edits.push(random() < 0.5 ? { op: 'remove', name: 'LOCATION' } : { op: 'set', property: textProperty('LOCATION', randomText(random)) });
                edited.add('location').add('x-apple-structured-location');
            }
            if (random() < 0.4) {
                edits.push(random() < 0.5 ? { op: 'remove', name: 'DESCRIPTION' } : { op: 'set', property: textProperty('DESCRIPTION', randomText(random).repeat(5).slice(0, 8192)) });
                edited.add('description').add('x-alt-desc');
            }
            if (random() < 0.3) { edits.push({ op: 'set', property: statusProperty(pick(['CONFIRMED', 'TENTATIVE', 'CANCELLED'] as const)) }); edited.add('status'); }
            if (random() < 0.3) { edits.push({ op: 'set', property: transparencyProperty(pick(['OPAQUE', 'TRANSPARENT'] as const)) }); edited.add('transp'); }
            if (random() < 0.7) { edits.push({ op: 'set', property: sequenceProperty(Math.floor(random() * 100)) }, { op: 'set', property: timeProperty('DTSTAMP', NOW) }); edited.add('sequence').add('dtstamp'); }
            let alarms = false;
            if (random() < 0.3) { edits.push({ op: 'remove_alarms' }); alarms = true; }
            if (random() < 0.3) { edits.push({ op: 'add_alarm', alarm: displayAlarm(pick(['PT5M', 'P1D', 'PT1H30M'])) }); }
            if (targetOutline.recurrenceId === null && random() < 0.4) { edits.push({ op: 'add', property: timeProperty('EXDATE', zoned(`202701${String(10 + Math.floor(random() * 18))}T100000`)) }); edited.add('exdate'); }
            if (targetOutline.recurrenceId === null && random() < 0.3) { edits.push({ op: 'replace', property: rruleProperty(pick(['FREQ=WEEKLY;BYDAY=TU;COUNT=5', 'FREQ=DAILY', 'FREQ=WEEKLY;UNTIL=20271231T235959Z']), 'zoned') }); edited.add('rrule'); }
            const resource: ResourceEdit[] = [];
            let removedSpan: { begin: number; end: number } | null = null;
            const others = outline.filter((event, index) => index !== targetIndex && event.recurrenceId !== null);
            if (others.length > 0 && random() < 0.3) {
                const victim = pick(others);
                resource.push({ op: 'remove_component', target: { kind: 'override', recurrenceId: victim.recurrenceId ?? '' } });
                removedSpan = { begin: victim.begin, end: victim.end };
            }

            const result = editResource(input, { target, edits, resource });
            expect<unknown>(verifyUntouched(input, result.text, result.report)).toEqual({ ok: true });

            // Independently of the report: every logical line outside the target and the removed override, and every
            // target line whose name was not edited, is in the output, in order, with identical physical lines.
            const before = logical(input);
            const after = logical(result.text);
            const mustKeep: number[] = [];
            let depthInTarget = 0;
            for (const [index, group] of before.entries()) {
                const text = group.map((part, position) => (position === 0 ? part : part.slice(1))).join('');
                const name = text.slice(0, text.search(/[;:]/u)).toLowerCase();
                if (removedSpan !== null && index >= removedSpan.begin && index <= removedSpan.end) { continue; }
                if (index > targetOutline.begin && index < targetOutline.end) {
                    if (name === 'begin') { depthInTarget++; }
                    const inAlarm = depthInTarget > 0;
                    if (name === 'end') { depthInTarget--; }
                    if (inAlarm ? alarms : edited.has(name)) { continue; }
                }
                mustKeep.push(index);
            }
            let cursor = 0;
            for (const index of mustKeep) {
                const wanted = JSON.stringify(before[index]);
                while (cursor < after.length && JSON.stringify(after[cursor]) !== wanted) { cursor++; }
                expect<unknown>([iteration, index, cursor < after.length]).toEqual([iteration, index, true]);
                cursor++;
            }
            expect<unknown>(/\r(?!\n)|(?<!\r)\n/u.test(result.text)).toBe(false);

            // Every VEVENT other than the target and the removed override parses to deep-equal properties.
            const parsedBefore = parse(input);
            const parsedAfter = parse(result.text);
            const key = (component: EventComponent): string => JSON.stringify(component.recurrenceId?.raw.values ?? null);
            const inOrder = (resourceValue: OriginalResource): EventComponent[] => [masterOf(resourceValue), ...resourceValue.overrides];
            const beforeEvents = inOrder(parsedBefore);
            const skipped = new Set([key(beforeEvents[targetIndex] as EventComponent)]);
            if (removedSpan !== null) { skipped.add(key(beforeEvents[outline.findIndex(event => event.begin === removedSpan?.begin)] as EventComponent)); }
            const afterByKey = new Map(inOrder(parsedAfter).map(component => [key(component), component]));
            for (const component of beforeEvents.filter(event => !skipped.has(key(event)))) {
                expect<unknown>(afterByKey.get(key(component))?.properties).toEqual(component.properties);
                expect<unknown>(afterByKey.get(key(component))?.alarmCount).toBe(component.alarmCount);
            }
            expect<unknown>(afterByKey.size).toBe(beforeEvents.length - (removedSpan === null ? 0 : 1));
            expect<unknown>(parsedAfter.vtimezoneCount).toBe(parsedBefore.vtimezoneCount);
        }
    });
});

// ---- Security review findings ----

const simple = (...extra: string[]): string => crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'DTEND:20270111T110000Z', ...extra, 'END:VEVENT', 'END:VCALENDAR']);

describe('an override this writer generated can be edited again (finding 1)', () => {
    const series = (tzid: string): string => crlf([
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1',
        timeProperty('DTSTART', { kind: 'zoned', local: '20261201T100000', tzid }).line,
        timeProperty('DTEND', { kind: 'zoned', local: '20261201T103000', tzid }).line,
        'RRULE:FREQ=WEEKLY', 'SUMMARY:s', 'END:VEVENT', 'END:VCALENDAR',
    ]);

    test('quoted, spaced and non-ASCII zones: add the override, describe it, edit it, remove it', () => {
        for (const tzid of ['America/New_York', 'Pacific Standard Time', 'A,B', 'A;B', 'a/b:c;d,e', 'Zürich/東京']) {
            const original = series(tzid);
            const master = describeEvents(original)[0] as EventOutline;
            const uid = master.properties.find(line => line.name === 'uid')?.index ?? -1;
            const rid = timeProperty('RECURRENCE-ID', { kind: 'zoned', local: '20261208T100000', tzid });
            const added = editResource(original, { resource: [{ op: 'add_component', items: [
                { copy_line: uid }, rid, timeProperty('DTSTART', { kind: 'zoned', local: '20261208T110000', tzid }), textProperty('SUMMARY', 'moved'),
            ] }] }).text;
            const outline = describeEvents(added);
            expect<unknown>([tzid, outline.map(event => event.recurrenceId)]).toEqual([tzid, [null, rid.line]]);
            const parsed = parse(added).overrides[0];
            expect<unknown>([tzid, parsed?.recurrenceId?.raw.params.get('tzid')]).toEqual([tzid, [tzid]]);
            const edited = editResource(added, { target: { kind: 'override', recurrenceId: rid.line }, edits: [{ op: 'set', property: textProperty('SUMMARY', 'again') }] }).text;
            expect<unknown>([tzid, valueOf(parse(edited).overrides[0], 'summary')]).toEqual([tzid, 'again']);
            const removed = editResource(edited, { resource: [{ op: 'remove_component', target: { kind: 'override', recurrenceId: rid.line } }] }).text;
            expect(removed).toBe(original);
        }
    });

    test('a backslash zone never reaches the editor: the writer refuses it before a RECURRENCE-ID exists', () => {
        for (const tzid of [String.raw`A\nB`, String.raw`A\,B`, String.raw`A\;B`, String.raw`A\\B`]) {
            expect<unknown>([tzid, (() => { try { timeProperty('RECURRENCE-ID', { kind: 'zoned', local: '20261208T100000', tzid }); return null; } catch (error) { return (error as { reason?: string }).reason; } })()]).toEqual([tzid, 'zone_not_representable']);
        }
        // Stored text with such a RECURRENCE-ID (not written by this server) stays unsupported rather than mis-addressed.
        const stored = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', String.raw`RECURRENCE-ID;TZID=A\nB:20261208T100000`, String.raw`DTSTART;TZID=A\nB:20261208T100000`, 'END:VEVENT', 'END:VCALENDAR']);
        expect(reasonOf(() => describeEvents(stored))).toBe('tree_mismatch');
    });
});

describe('verification is linear in the resource size (finding 2)', () => {
    const alarmLines = (count: number): string[] => Array.from({ length: count }, (_, index) => `X-LINE-${String(index)}:v`);
    const withAlarm = (count: number): string => simple('RRULE:FREQ=DAILY', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', ...alarmLines(count), 'END:VALARM');
    const addOverrideCopying = (text: string): EditPlan => {
        const master = describeEvents(text)[0] as EventOutline;
        return { resource: [{ op: 'add_component', items: [
            { copy_line: master.properties.find(line => line.name === 'uid')?.index ?? -1 },
            timeProperty('RECURRENCE-ID', { kind: 'utc', utc: '20270112T100000Z' }),
            timeProperty('DTSTART', { kind: 'utc', utc: '20270112T100000Z' }),
            { copy_component: master.alarms[0]?.begin ?? -1 },
        ] }] };
    };
    const stepsOf = (before: string, plan: EditPlan): { steps: number; lines: number } => {
        const result = editResource(before, plan);
        const meter = { steps: 0 };
        expect<unknown>(verifyUntouched(before, result.text, result.report, { meter })).toEqual({ ok: true });
        return { steps: meter.steps, lines: result.text.split('\r\n').length + before.split('\r\n').length };
    };

    test('remove_alarms over 1k, 10k and 40k alarm lines: scope checks cost O(lines)', () => {
        const removeAlarms: EditPlan = { target: { kind: 'master' }, edits: [{ op: 'remove_alarms' }] };
        for (const count of [1000, 10_000, 40_000]) {
            const { steps, lines: total } = stepsOf(withAlarm(count), removeAlarms);
            // The quadratic version re-scanned the whole alarm for each of its lines: about count² steps.
            expect<unknown>([count, steps <= 4 * total]).toEqual([count, true]);
        }
    });

    test('a large copied alarm in an added override: 1k, 10k and 24k lines (the output must stay within 50,000 lines)', () => {
        for (const count of [1000, 10_000, 24_000]) {
            const before = withAlarm(count);
            const { steps, lines: total } = stepsOf(before, addOverrideCopying(before));
            expect<unknown>([count, steps <= 4 * total]).toEqual([count, true]);
        }
    });

    test('wall-clock bound for whole edits of a 40k-line alarm (generous: CI is about 3x slower than a laptop)', () => {
        const before = withAlarm(40_000);
        let started = performance.now();
        editResource(before, { target: { kind: 'master' }, edits: [{ op: 'remove_alarms' }] });
        expect<unknown>(performance.now() - started).toBeLessThan(2000);
        // Copying it doubles the output past the 50,000-line read cap: refused as too large, after the linear verification.
        started = performance.now();
        expect(reasonOf(() => editResource(before, addOverrideCopying(before)))).toBe('output_too_large');
        expect<unknown>(performance.now() - started).toBeLessThan(2000);
    });

    test('many removed overrides and many EXDATE lines stay linear too', () => {
        const overrides = Array.from({ length: 1500 }, (_, index) => {
            const day = new Date(Date.UTC(2027, 0, 12) + index * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
            return ['BEGIN:VEVENT', 'UID:u1', `RECURRENCE-ID:${day}T100000Z`, `DTSTART:${day}T110000Z`, 'END:VEVENT'];
        });
        const exdates = Array.from({ length: 8000 }, (_, index) => `EXDATE:${new Date(Date.UTC(1990, 0, 1) + index * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '')}T100000Z`);
        const before = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'RRULE:FREQ=DAILY', ...exdates, 'END:VEVENT', ...overrides.flat(), 'END:VCALENDAR']);
        const rids = overrides.map(lines => lines[2] as string);
        const plan: EditPlan = {
            target: { kind: 'master' },
            edits: [{ op: 'remove_all', name: 'EXDATE' }, { op: 'set', property: sequenceProperty(1) }],
            resource: rids.slice(0, 1000).map(recurrenceId => ({ op: 'remove_component', target: { kind: 'override', recurrenceId } })),
        };
        const started = performance.now();
        const { steps, lines: total } = stepsOf(before, plan);
        expect<unknown>(steps <= 4 * total).toBe(true);
        expect<unknown>(performance.now() - started).toBeLessThan(4000);
    });
});

describe('paired companions clear the logical field (finding 5)', () => {
    test('remove DESCRIPTION when only X-ALT-DESC is present removes the companion, reported as paired', () => {
        const result = editResource(simple('SUMMARY:s', 'X-ALT-DESC;FMTTYPE=text/html:<p>old</p>'), { target: { kind: 'master' }, edits: [{ op: 'remove', name: 'DESCRIPTION' }] });
        expect(result.text).toBe(simple('SUMMARY:s'));
        expect<unknown>(result.report.changes).toEqual([{ action: 'removed', name: 'X-ALT-DESC', reason: 'paired', original: 7, output: null }]);
    });

    test('remove LOCATION when only X-APPLE-STRUCTURED-LOCATION is present removes the companion, reported as paired', () => {
        const result = editResource(simple('X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Here:geo:1,2', 'SUMMARY:s'), { target: { kind: 'master' }, edits: [{ op: 'remove', name: 'LOCATION' }] });
        expect(result.text).toBe(simple('SUMMARY:s'));
        expect<unknown>(result.report.changes).toEqual([{ action: 'removed', name: 'X-APPLE-STRUCTURED-LOCATION', reason: 'paired', original: 6, output: null }]);
    });

    test('with both present each is reported once, the companion as paired; with neither nothing changes', () => {
        const result = editResource(simple('LOCATION:l', 'X-APPLE-STRUCTURED-LOCATION;VALUE=URI:geo:1,2', 'DESCRIPTION:d', 'X-ALT-DESC:a'), {
            target: { kind: 'master' }, edits: [{ op: 'remove', name: 'LOCATION' }, { op: 'remove', name: 'DESCRIPTION' }],
        });
        expect(result.text).toBe(simple());
        expect<unknown>(result.report.changes.map(change => [change.name, change.reason])).toEqual([
            ['LOCATION', 'requested'], ['X-APPLE-STRUCTURED-LOCATION', 'paired'], ['DESCRIPTION', 'requested'], ['X-ALT-DESC', 'paired'],
        ]);
        const none = editResource(simple('SUMMARY:s'), { target: { kind: 'master' }, edits: [{ op: 'remove', name: 'LOCATION' }, { op: 'remove', name: 'DESCRIPTION' }] });
        expect(none.text).toBe(simple('SUMMARY:s'));
        expect<unknown>(none.report.changes).toEqual([]);
    });

    test('set DESCRIPTION when only X-ALT-DESC is present adds the text and removes the companion', () => {
        const result = editResource(simple('X-ALT-DESC:a'), { target: { kind: 'master' }, edits: [{ op: 'set', property: textProperty('DESCRIPTION', 'd') }] });
        expect(result.text).toBe(simple('DESCRIPTION:d'));
        expect<unknown>(result.report.changes.map(change => [change.action, change.name, change.reason])).toEqual([['added', 'DESCRIPTION', 'requested'], ['removed', 'X-ALT-DESC', 'paired']]);
    });
});

describe('names that only resemble the edited one are never selected (finding 6)', () => {
    const setSummary: EditPlan = { target: { kind: 'master' }, edits: [{ op: 'set', property: textProperty('SUMMARY', 'new') }] };
    const replaceSummary: EditPlan = { target: { kind: 'master' }, edits: [{ op: 'replace', property: textProperty('SUMMARY', 'new') }] };
    const removeSummary: EditPlan = { target: { kind: 'master' }, edits: [{ op: 'remove', name: 'SUMMARY' }] };

    test('grouped names and prefix collisions', () => {
        for (const lookalike of ['a.SUMMARY:grouped', 'A.summary:grouped', 'SUMMARY-X:suffix', 'X-SUMMARY:prefix', 'SUMMARYX:joined', 'X-APPLE-SUMMARY:x']) {
            const text = simple(lookalike);
            expect<unknown>([lookalike, reasonOf(() => editResource(text, replaceSummary))]).toEqual([lookalike, 'property_absent']);
            expect<unknown>([lookalike, editResource(text, setSummary).text]).toEqual([lookalike, simple(lookalike, 'SUMMARY:new')]);
            expect<unknown>([lookalike, editResource(text, removeSummary).text]).toEqual([lookalike, text]);
        }
    });

    test('lower-case component markers still delimit components: an alarm SUMMARY is never the event SUMMARY', () => {
        const text = crlf(['begin:vcalendar', 'VERSION:2.0', 'begin:vevent', 'UID:u1', 'DTSTART:20270111T100000Z', 'Begin:Valarm', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'SUMMARY:alarm', 'end:valarm', 'end:vevent', 'end:vcalendar']);
        expect(reasonOf(() => editResource(text, replaceSummary))).toBe('property_absent');
        expect(editResource(text, setSummary).text).toBe(crlf(['begin:vcalendar', 'VERSION:2.0', 'begin:vevent', 'UID:u1', 'DTSTART:20270111T100000Z', 'SUMMARY:new', 'Begin:Valarm', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'SUMMARY:alarm', 'end:valarm', 'end:vevent', 'end:vcalendar']));
        expect(editResource(text, removeSummary).text).toBe(text);
        expect<unknown>(describeEvents(text).map(event => [event.begin, event.end, event.alarms])).toEqual([[2, 10, [{ begin: 5, end: 9 }]]]);
    });

    test('a lower-case summary IS the SUMMARY (names are case-insensitive)', () => {
        expect(editResource(simple('summary:old'), setSummary).text).toBe(simple('SUMMARY:new'));
    });
});

describe('stored escape pairs split at every fold boundary survive untouched (finding 6)', () => {
    test('\\\\, \\n, \\, and \\; split between the two characters of the pair, or around them', () => {
        const value = String.raw`a\\b\nc\,d\;e\Nf`;
        const decoded = 'a\\b\nc,d;e\nf';
        const logicalLine = `SUMMARY:${value}`;
        for (let cut = 1; cut < logicalLine.length; cut++) {
            for (const continuation of [' ', '\t']) {
                const folded = [logicalLine.slice(0, cut), `${continuation}${logicalLine.slice(cut)}`];
                const text = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', ...folded, 'END:VEVENT', 'END:VCALENDAR']);
                expect<unknown>([cut, valueOf(masterOf(parse(text)), 'summary')]).toEqual([cut, decoded]);
                const result = editResource(text, { target: { kind: 'master' }, edits: [{ op: 'set', property: sequenceProperty(1) }] });
                expect<unknown>([cut, result.text]).toEqual([cut, crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', ...folded, 'SEQUENCE:1', 'END:VEVENT', 'END:VCALENDAR'])]);
                expect<unknown>([cut, valueOf(masterOf(parse(result.text)), 'summary')]).toEqual([cut, decoded]);
            }
        }
    });

    test('a written replacement folded through an escape pair decodes to the client text', () => {
        for (let pad = 0; pad <= 70; pad++) {
            const wanted = `${'x'.repeat(pad)}\\;,\n${'y'.repeat(70)}`;
            const result = editResource(FIXTURE, { target: { kind: 'master' }, edits: [{ op: 'set', property: textProperty('SUMMARY', wanted) }] });
            expect<unknown>([pad, valueOf(masterOf(parse(result.text)), 'summary')]).toEqual([pad, wanted]);
        }
    });
});
