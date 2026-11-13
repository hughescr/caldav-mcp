import { describe, expect, test } from 'bun:test';
import { buildDerivedResource, describeEvents, editResource, IcsEditError, type NewComponentItem } from '../src/calendar/ics-edit';
import { verifyDerivedOutcome, verifyEditOutcome, type DerivedExpectation, type EditExpectation, type OutcomeVerdict } from '../src/calendar/ics-verify';
import { exdateListProperty, rruleProperty, sequenceProperty, textProperty, timeProperty, uidProperty } from '../src/calendar/ics-write';

// Hand-written stored resources and expected texts for the occurrence-edit extensions of the editor and the intent gate:
// shifted RECURRENCE-IDs, several removed overrides, replaced EXDATE lines, scheduling copies into a new override (invite
// only), and the split's derived resource.

const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const failure = (verdict: OutcomeVerdict): string | null => (verdict.ok ? null : verdict.reason);
const NY = 'America/New_York';

const GUESTS = ['ORGANIZER;CN=Owner:mailto:owner@example.test', 'ATTENDEE;CN=Guest;PARTSTAT=ACCEPTED;SCHEDULE-STATUS=1.1:mailto:guest@example.test'];

const UTC_SERIES = crlf([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
    'BEGIN:VEVENT', 'UID:U-1', 'DTSTAMP:20261101T120000Z', 'SEQUENCE:1', 'DTSTART:20270105T150000Z', 'DTEND:20270105T153000Z', 'RRULE:FREQ=WEEKLY;COUNT=8',
    'EXDATE:20270119T150000Z,20270202T150000Z', 'SUMMARY:Sync', ...GUESTS,
    'BEGIN:VALARM', 'ACTION:AUDIO', 'TRIGGER:-PT5M', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:U-1', 'RECURRENCE-ID:20270126T150000Z', 'DTSTAMP:20261105T120000Z', 'DTSTART:20270126T150000Z', 'DTEND:20270126T153000Z', 'SUMMARY:Sync (agenda)', ...GUESTS, 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:U-1', 'RECURRENCE-ID:20270209T150000Z', 'DTSTAMP:20261105T120000Z', 'DTSTART:20270210T090000Z', 'DTEND:20270210T093000Z', 'SUMMARY:Sync (moved)', 'END:VEVENT',
    'END:VCALENDAR',
]);

const utc = (digits: string): { type: string; values: string[] } => ({ type: 'date-time', values: [`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(9, 11)}:${digits.slice(11, 13)}:${digits.slice(13, 15)}Z`] });

describe('series move with shifted exceptions: RECURRENCE-ID replaced in place, EXDATE lines replaced', () => {
    const plan = () => editResource(UTC_SERIES, {
        targets: [
            { target: { kind: 'master' }, edits: [
                { op: 'set', property: timeProperty('DTSTART', { kind: 'utc', utc: '20270105T160000Z' }) },
                { op: 'set', property: timeProperty('DTEND', { kind: 'utc', utc: '20270105T163000Z' }) },
                { op: 'remove_all', name: 'EXDATE' },
                { op: 'add', property: exdateListProperty([{ kind: 'utc', utc: '20270119T160000Z' }, { kind: 'utc', utc: '20270202T160000Z' }]) },
                { op: 'set', property: sequenceProperty(2) },
            ] },
            { target: { kind: 'override', recurrenceId: 'RECURRENCE-ID:20270126T150000Z' }, edits: [
                { op: 'replace_recurrence_id', property: timeProperty('RECURRENCE-ID', { kind: 'utc', utc: '20270126T160000Z' }) },
                { op: 'set', property: timeProperty('DTSTART', { kind: 'utc', utc: '20270126T160000Z' }) },
                { op: 'set', property: timeProperty('DTEND', { kind: 'utc', utc: '20270126T163000Z' }) },
            ] },
            { target: { kind: 'override', recurrenceId: 'RECURRENCE-ID:20270209T150000Z' }, edits: [
                { op: 'replace_recurrence_id', property: timeProperty('RECURRENCE-ID', { kind: 'utc', utc: '20270209T160000Z' }) },
            ] },
        ],
    });
    const expectation: EditExpectation = {
        targets: [
            { component: { kind: 'master' }, properties: [{ name: 'DTSTART', ...utc('20270105T160000Z') }, { name: 'DTEND', ...utc('20270105T163000Z') }, { name: 'SEQUENCE', type: 'integer', values: [2] }],
                exdates: { kind: 'replaced', lines: [{ type: 'date-time', values: ['2027-01-19T16:00:00Z', '2027-02-02T16:00:00Z'] }] } },
            { component: { kind: 'override', recurrenceId: 'RECURRENCE-ID:20270126T150000Z' }, recurrenceId: utc('20270126T160000Z'), properties: [{ name: 'DTSTART', ...utc('20270126T160000Z') }, { name: 'DTEND', ...utc('20270126T163000Z') }] },
            { component: { kind: 'override', recurrenceId: 'RECURRENCE-ID:20270209T150000Z' }, recurrenceId: utc('20270209T160000Z') },
        ],
    };

    test('the exact text and a passing verdict; guest lines of a shifted override count as the same component', () => {
        const { text } = plan();
        expect(text).toBe(crlf([
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
            'BEGIN:VEVENT', 'UID:U-1', 'DTSTAMP:20261101T120000Z', 'SEQUENCE:2', 'DTSTART:20270105T160000Z', 'DTEND:20270105T163000Z', 'RRULE:FREQ=WEEKLY;COUNT=8',
            'EXDATE:20270119T160000Z,20270202T160000Z', 'SUMMARY:Sync', ...GUESTS,
            'BEGIN:VALARM', 'ACTION:AUDIO', 'TRIGGER:-PT5M', 'END:VALARM', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:U-1', 'RECURRENCE-ID:20270126T160000Z', 'DTSTAMP:20261105T120000Z', 'DTSTART:20270126T160000Z', 'DTEND:20270126T163000Z', 'SUMMARY:Sync (agenda)', ...GUESTS, 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:U-1', 'RECURRENCE-ID:20270209T160000Z', 'DTSTAMP:20261105T120000Z', 'DTSTART:20270210T090000Z', 'DTEND:20270210T093000Z', 'SUMMARY:Sync (moved)', 'END:VEVENT',
            'END:VCALENDAR',
        ]));
        expect(verifyEditOutcome(UTC_SERIES, text, expectation)).toEqual({ ok: true });
    });

    test('a wrong shift, a kept old EXDATE, or a guest added to a shifted override is refused', () => {
        const { text } = plan();
        expect(failure(verifyEditOutcome(UTC_SERIES, text.replace('RECURRENCE-ID:20270209T160000Z', 'RECURRENCE-ID:20270209T170000Z'), expectation))).toBe('target_not_found');
        expect(failure(verifyEditOutcome(UTC_SERIES, text.replace('EXDATE:20270119T160000Z,20270202T160000Z', 'EXDATE:20270119T150000Z,20270202T160000Z'), expectation))).toBe('exdate_mismatch');
        const added = text.replace('SUMMARY:Sync (moved)\r\n', 'SUMMARY:Sync (moved)\r\nATTENDEE:mailto:new@example.test\r\n');
        expect(failure(verifyEditOutcome(UTC_SERIES, added, expectation))).toBe('scheduling_added');
        // A RECURRENCE-ID change the expectation does not name is a changed property.
        const { recurrenceId: _dropped, ...unnamed } = expectation.targets?.[2] ?? { component: { kind: 'master' } };
        expect(failure(verifyEditOutcome(UTC_SERIES, text, { targets: [...(expectation.targets ?? []).slice(0, 2), unnamed] }))).toBe('target_not_found');
    });

    test('replace_recurrence_id is refused on the master and needs a written RECURRENCE-ID', () => {
        const refusal = (run: () => unknown): string => { try { run(); } catch (error) { return error instanceof IcsEditError ? error.reason : 'other'; } return 'none'; };
        expect(refusal(() => editResource(UTC_SERIES, { target: { kind: 'master' }, edits: [{ op: 'replace_recurrence_id', property: timeProperty('RECURRENCE-ID', { kind: 'utc', utc: '20270126T160000Z' }) }] }))).toBe('property_absent');
        expect(refusal(() => editResource(UTC_SERIES, { target: { kind: 'override', recurrenceId: 'RECURRENCE-ID:20270126T150000Z' }, edits: [{ op: 'replace_recurrence_id', property: textProperty('SUMMARY', 'x') }] }))).toBe('edit_not_allowed');
    });
});

describe('several overrides removed in one pass (a split, a move that drops its exceptions)', () => {
    test('removeOverrides: both gone, nothing else changed; one left is refused', () => {
        const { text } = editResource(UTC_SERIES, {
            target: { kind: 'master' }, edits: [{ op: 'set', property: rruleProperty('FREQ=WEEKLY;UNTIL=20270125T235959Z', 'utc') }],
            resource: [{ op: 'remove_component', target: { kind: 'override', recurrenceId: 'RECURRENCE-ID:20270126T150000Z' } }, { op: 'remove_component', target: { kind: 'override', recurrenceId: 'RECURRENCE-ID:20270209T150000Z' } }],
        });
        const expectation: EditExpectation = {
            target: { component: { kind: 'master' }, rrule: 'FREQ=WEEKLY;UNTIL=20270125T235959Z' },
            removeOverrides: [{ recurrenceId: 'RECURRENCE-ID:20270126T150000Z' }, { recurrenceId: 'RECURRENCE-ID:20270209T150000Z' }],
        };
        expect(verifyEditOutcome(UTC_SERIES, text, expectation)).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(UTC_SERIES, text, { ...expectation, removeOverrides: expectation.removeOverrides?.slice(0, 1) }))).not.toBeNull();
        expect(failure(verifyEditOutcome(UTC_SERIES, text, { ...expectation, removeOverrides: [{ recurrenceId: 'RECURRENCE-ID:20270126T150000Z' }, { recurrenceId: 'RECURRENCE-ID:20270126T150000Z' }] }))).toBe('expectation_invalid');
    });
});

const ZONED_GUESTS = crlf([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN',
    'BEGIN:VTIMEZONE', `TZID:${NY}`, 'BEGIN:STANDARD', 'DTSTART:20071104T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:Z-1', 'DTSTAMP:20261101T120000Z', 'CREATED:20261101T120000Z', 'SEQUENCE:0', `DTSTART;TZID=${NY}:20261201T100000`, `DTEND;TZID=${NY}:20261201T103000`,
    'RRULE:FREQ=WEEKLY', `EXDATE;TZID=${NY}:20261229T100000`, 'SUMMARY:Weekly sync', ...GUESTS,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:Z-1', `RECURRENCE-ID;TZID=${NY}:20261222T100000`, 'DTSTAMP:20261105T120000Z', `DTSTART;TZID=${NY}:20261222T110000`, `DTEND;TZID=${NY}:20261222T113000`, 'SUMMARY:Weekly sync (late)', ...GUESTS, 'END:VEVENT',
    'END:VCALENDAR',
]);

describe('a new override of a series with guests copies the master\'s scheduling lines (invite only)', () => {
    const newOverride = (extra: readonly NewComponentItem[] = []) => {
        const master = describeEvents(ZONED_GUESTS)[0];
        const copies = (master?.properties ?? []).filter(line => !['rrule', 'exdate', 'dtstart', 'dtend', 'dtstamp', 'sequence'].includes(line.name)).map(line => ({ copy_line: line.index }));
        const alarm = master?.alarms[0];
        return editResource(ZONED_GUESTS, { resource: [{ op: 'add_component', items: [
            ...copies, timeProperty('DTSTART', { kind: 'zoned', local: '20261208T100000', tzid: NY }), timeProperty('DTEND', { kind: 'zoned', local: '20261208T103000', tzid: NY }),
            timeProperty('RECURRENCE-ID', { kind: 'zoned', local: '20261208T100000', tzid: NY }), ...extra,
            timeProperty('DTSTAMP', { kind: 'utc', utc: '20261113T090000Z' }), sequenceProperty(1), ...(alarm === undefined ? [] : [{ copy_component: alarm.begin }]),
        ] }] });
    };
    const expectation = (schedulingCopied: boolean): EditExpectation => ({
        addOverride: {
            recurrenceId: { type: 'date-time', values: ['2026-12-08T10:00:00'], params: { tzid: [NY] } },
            properties: [
                { name: 'DTSTART', type: 'date-time', values: ['2026-12-08T10:00:00'], params: { tzid: [NY] } }, { name: 'DTEND', type: 'date-time', values: ['2026-12-08T10:30:00'], params: { tzid: [NY] } },
                { name: 'DTSTAMP', type: 'date-time', values: ['2026-11-13T09:00:00Z'] }, { name: 'SEQUENCE', type: 'integer', values: [1] },
            ],
            alarms: { kind: 'copied' }, schedulingCopied,
        },
    });

    test('with the flag: exact copies pass; without it the same text is refused', () => {
        const { text } = newOverride();
        expect(verifyEditOutcome(ZONED_GUESTS, text, expectation(true))).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(ZONED_GUESTS, text, expectation(false)))).toBe('scheduling_added');
    });

    test('an altered or extra guest line, or one left out, is refused even with the flag', () => {
        const { text } = newOverride();
        // The new override is the last VEVENT; its copied lines precede its written ones.
        const at = text.lastIndexOf('BEGIN:VEVENT');
        const before = text.slice(0, at);
        const newPart = text.slice(at);
        expect(newPart).toContain(`RECURRENCE-ID;TZID=${NY}:20261208T100000`);
        expect(failure(verifyEditOutcome(ZONED_GUESTS, `${before}${newPart.replace('PARTSTAT=ACCEPTED', 'PARTSTAT=DECLINED')}`, expectation(true)))).toBe('scheduling_added');
        expect(failure(verifyEditOutcome(ZONED_GUESTS, `${before}${newPart.replace('ORGANIZER;CN=Owner:mailto:owner@example.test\r\n', '')}`, expectation(true)))).toBe('override_mismatch');
        expect(failure(verifyEditOutcome(ZONED_GUESTS, `${before}${newPart.replace('SUMMARY:Weekly sync\r\n', 'SUMMARY:Weekly sync\r\nATTENDEE:mailto:extra@example.test\r\n')}`, expectation(true)))).toBe('scheduling_added');
    });
});

describe('the derived resource of a split', () => {
    const NEW_UID = 'cmcp1-c3BsaXQtZXhhbXBsZS11aWQtdmFsdWU';
    const plan = (guests: boolean) => {
        const source = guests ? ZONED_GUESTS : ZONED_GUESTS.replaceAll(`${GUESTS.join('\r\n')}\r\n`, '');
        const master = describeEvents(source)[0];
        const skip = ['uid', 'rrule', 'exdate', 'dtstart', 'dtend', 'dtstamp', 'created', 'sequence', 'summary'];
        const items: NewComponentItem[] = [
            ...(master?.properties ?? []).filter(line => !skip.includes(line.name)).map(line => ({ copy_line: line.index })),
            timeProperty('DTSTART', { kind: 'zoned', local: '20261215T100000', tzid: NY }), timeProperty('DTEND', { kind: 'zoned', local: '20261215T103000', tzid: NY }),
            ...(master?.properties ?? []).filter(line => line.name === 'rrule' || line.name === 'exdate').map(line => ({ copy_line: line.index })),
            textProperty('SUMMARY', 'Weekly sync (new format)'),
            timeProperty('DTSTAMP', { kind: 'utc', utc: '20261113T090000Z' }), timeProperty('CREATED', { kind: 'utc', utc: '20261113T090000Z' }),
            timeProperty('LAST-MODIFIED', { kind: 'utc', utc: '20261113T090000Z' }), sequenceProperty(0),
            ...(master?.alarms ?? []).map(alarm => ({ copy_component: alarm.begin })),
        ];
        return { source, text: buildDerivedResource(source, { uid: uidProperty(NEW_UID), master: items, overrides: [`RECURRENCE-ID;TZID=${NY}:20261222T100000`] }) };
    };
    const expectation = (schedulingCopied: boolean): DerivedExpectation => ({
        uid: NEW_UID,
        master: {
            properties: [
                { name: 'DTSTART', type: 'date-time', values: ['2026-12-15T10:00:00'], params: { tzid: [NY] } }, { name: 'DTEND', type: 'date-time', values: ['2026-12-15T10:30:00'], params: { tzid: [NY] } },
                { name: 'SUMMARY', type: 'text', values: ['Weekly sync (new format)'] }, { name: 'DTSTAMP', type: 'date-time', values: ['2026-11-13T09:00:00Z'] },
                { name: 'CREATED', type: 'date-time', values: ['2026-11-13T09:00:00Z'] }, { name: 'LAST-MODIFIED', type: 'date-time', values: ['2026-11-13T09:00:00Z'] }, { name: 'SEQUENCE', type: 'integer', values: [0] },
            ],
            rrule: { kind: 'copied' }, exdates: 'copied', alarms: { kind: 'copied' },
        },
        overrides: [`RECURRENCE-ID;TZID=${NY}:20261222T100000`],
        schedulingCopied,
    });

    test('the exact text: our header, the VTIMEZONE copied, the new master, the override with only its UID replaced', () => {
        const { source, text } = plan(false);
        expect(text).toBe(crlf([
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//caldav-mcp//EN', 'CALSCALE:GREGORIAN',
            'BEGIN:VTIMEZONE', `TZID:${NY}`, 'BEGIN:STANDARD', 'DTSTART:20071104T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD', 'END:VTIMEZONE',
            'BEGIN:VEVENT', `UID:${NEW_UID}`, `DTSTART;TZID=${NY}:20261215T100000`, `DTEND;TZID=${NY}:20261215T103000`, 'RRULE:FREQ=WEEKLY', `EXDATE;TZID=${NY}:20261229T100000`,
            'SUMMARY:Weekly sync (new format)', 'DTSTAMP:20261113T090000Z', 'CREATED:20261113T090000Z', 'LAST-MODIFIED:20261113T090000Z', 'SEQUENCE:0',
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
            'BEGIN:VEVENT', `UID:${NEW_UID}`, `RECURRENCE-ID;TZID=${NY}:20261222T100000`, 'DTSTAMP:20261105T120000Z', `DTSTART;TZID=${NY}:20261222T110000`, `DTEND;TZID=${NY}:20261222T113000`, 'SUMMARY:Weekly sync (late)', 'END:VEVENT',
            'END:VCALENDAR',
        ]));
        expect(verifyDerivedOutcome(source, text, expectation(false))).toEqual({ ok: true });
    });

    test('guests: copied lines pass only with the invite flag, and only unaltered', () => {
        const { source, text } = plan(true);
        expect(verifyDerivedOutcome(source, text, expectation(true))).toEqual({ ok: true });
        expect(failure(verifyDerivedOutcome(source, text, expectation(false)))).toBe('scheduling_added');
        expect(failure(verifyDerivedOutcome(source, text.replace('PARTSTAT=ACCEPTED', 'PARTSTAT=TENTATIVE'), expectation(true)))).toBe('scheduling_added');
    });

    test('corruptions are refused: an extra line, a dropped copy, an old UID left, a changed RRULE, a missing zone, another override', () => {
        const { source, text } = plan(false);
        const verdict = (candidate: string, wanted: DerivedExpectation = expectation(false)): string | null => failure(verifyDerivedOutcome(source, candidate, wanted));
        expect(verdict(text.replace('SEQUENCE:0\r\n', 'SEQUENCE:0\r\nX-EXTRA:1\r\n'))).toBe('override_mismatch');
        expect(verdict(text.replace(`EXDATE;TZID=${NY}:20261229T100000\r\n`, ''))).toBe('exdate_mismatch');
        expect(verdict(text.replace(`UID:${NEW_UID}\r\nRECURRENCE-ID`, 'UID:Z-1\r\nRECURRENCE-ID'))).not.toBeNull();
        expect(verdict(text.replace('RRULE:FREQ=WEEKLY', 'RRULE:FREQ=DAILY'))).toBe('rrule_mismatch');
        expect(verdict(text.replace(/BEGIN:VTIMEZONE[^]*?END:VTIMEZONE\r\n/u, ''))).toBe('component_changed');
        expect(verdict(text, { ...expectation(false), overrides: [] })).toBe('override_mismatch');
        expect(verdict(text, { ...expectation(false), uid: 'other-uid' })).not.toBeNull();
        expect(verdict(text.replace('ACTION:DISPLAY', 'ACTION:EMAIL'))).toBe('alarms_mismatch');
    });

    test('the builder refuses copies from outside the master and a UID among the items', () => {
        const refusal = (run: () => unknown): string => { try { run(); } catch (error) { return error instanceof IcsEditError ? error.reason : 'other'; } return 'none'; };
        const override = describeEvents(ZONED_GUESTS)[1];
        expect(refusal(() => buildDerivedResource(ZONED_GUESTS, { uid: uidProperty(NEW_UID), master: [{ copy_line: override?.properties[0]?.index ?? -1 }], overrides: [] }))).toBe('copy_invalid');
        expect(refusal(() => buildDerivedResource(ZONED_GUESTS, { uid: uidProperty(NEW_UID), master: [uidProperty('X')], overrides: [] }))).toBe('component_invalid');
        expect(refusal(() => buildDerivedResource(ZONED_GUESTS, { uid: uidProperty(NEW_UID), master: [], overrides: ['RECURRENCE-ID:nope'] }))).toBe('target_not_found');
    });
});
