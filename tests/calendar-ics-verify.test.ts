import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeEvents, editResource, verifyUntouched, type ComponentEdit, type EditPlan, type EventOutline, type NewComponentItem } from '../src/calendar/ics-edit';
import { verifyCreateOutcome, verifyEditOutcome, type CreateExpectation, type EditExpectation, type ExpectedProperty, type OutcomeVerdict } from '../src/calendar/ics-verify';
import {
    buildCreateResource, displayAlarm, rruleProperty, sequenceProperty, statusProperty, textProperty, timeProperty, transparencyProperty, travelDurationProperty, type CreateEventInput,
} from '../src/calendar/ics-write';

// Expectations are written by hand from the request, the way the write path must derive them; the editor's report is never
// consulted. Corruptions are applied to the editor's genuine output.

const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures/calendar/ics-write/apple-series.ics'), 'utf8');
const crlf = (physical: readonly string[]): string => `${physical.join('\r\n')}\r\n`;
const NOW = { kind: 'utc', utc: '20261113T090000Z' } as const;
const NY = 'America/New_York';
const RID_DEC08 = 'RECURRENCE-ID;TZID=America/New_York:20261208T100000';
const RID_DEC22 = 'RECURRENCE-ID;TZID=America/New_York:20261222T100000';
const zoned = (local: string): { kind: 'zoned'; local: string; tzid: string } => ({ kind: 'zoned', local, tzid: NY });

const text = (name: string, value: string): ExpectedProperty => ({ name, type: 'text', values: [value] });
const stamp = (name: string): ExpectedProperty => ({ name, type: 'date-time', values: ['2026-11-13T09:00:00Z'] });
const integer = (name: string, value: number): ExpectedProperty => ({ name, type: 'integer', values: [value] });
const local = (name: string, value: string): ExpectedProperty => ({ name, type: 'date-time', values: [value], params: { tzid: [NY] } });
const STAMPS = (sequence: number): ExpectedProperty[] => [stamp('DTSTAMP'), stamp('LAST-MODIFIED'), integer('SEQUENCE', sequence)];

const failure = (verdict: OutcomeVerdict): string | null => (verdict.ok ? null : verdict.reason);
/** Replace the first physical line equal to `from` (CRLF text). */
const swapLine = (source: string, from: string, ...to: string[]): string => {
    const physical = source.slice(0, -2).split('\r\n');
    const index = physical.indexOf(from);
    if (index === -1) { throw new Error(`no line ${from}`); }
    physical.splice(index, 1, ...to);
    return crlf(physical);
};
const insertAfter = (source: string, after: string, ...added: string[]): string => {
    const physical = source.slice(0, -2).split('\r\n');
    const index = physical.indexOf(after);
    if (index === -1) { throw new Error(`no line ${after}`); }
    physical.splice(index + 1, 0, ...added);
    return crlf(physical);
};

// ---- A master edit, its expectation, and the reviewer's counterexample ----

const MASTER_EDITS: ComponentEdit[] = [
    { op: 'set', property: textProperty('SUMMARY', 'new') },
    { op: 'remove', name: 'LOCATION' },
    { op: 'set', property: textProperty('DESCRIPTION', 'Agenda, v2\nsecond line') },
    { op: 'set', property: timeProperty('DTSTAMP', NOW) },
    { op: 'set', property: timeProperty('LAST-MODIFIED', NOW) },
    { op: 'set', property: sequenceProperty(4) },
    { op: 'set', property: statusProperty('CONFIRMED') },
];
const MASTER_EXPECTATION: EditExpectation = {
    target: {
        component: { kind: 'master' },
        properties: [text('SUMMARY', 'new'), { name: 'LOCATION', absent: true }, text('DESCRIPTION', 'Agenda, v2\nsecond line'), text('STATUS', 'CONFIRMED'), ...STAMPS(4)],
        companionsRemoved: ['X-APPLE-STRUCTURED-LOCATION', 'X-ALT-DESC'],
    },
};
const MASTER = editResource(FIXTURE, { target: { kind: 'master' }, edits: MASTER_EDITS });

describe('verifyEditOutcome: the reviewer counterexample and targeted corruptions', () => {
    test('the genuine master edit passes', () => {
        expect<unknown>(verifyEditOutcome(FIXTURE, MASTER.text, MASTER_EXPECTATION)).toEqual({ ok: true });
    });

    test('SUMMARY:new replaced by an ATTENDEE line passes verifyUntouched but not the intent gate', () => {
        const forged = swapLine(MASTER.text, 'SUMMARY:new', 'ATTENDEE:mailto:attacker@example.test');
        // The preservation check trusts the report for what the written line says.
        expect<unknown>(verifyUntouched(FIXTURE, forged, MASTER.report)).toEqual({ ok: true });
        expect<unknown>(verifyEditOutcome(FIXTURE, forged, MASTER_EXPECTATION)).toEqual({ ok: false, reason: 'scheduling_added', property: 'ATTENDEE/ORGANIZER' });
    });

    test('SUMMARY changed to a wrong value', () => {
        for (const wrong of ['SUMMARY:old', 'SUMMARY:new ', 'SUMMARY:New', 'SUMMARY;LANGUAGE=en:new', 'SUMMARY:ne\\w', 'SUMMARY:new\\n']) {
            expect<unknown>([wrong, verifyEditOutcome(FIXTURE, swapLine(MASTER.text, 'SUMMARY:new', wrong), MASTER_EXPECTATION)]).toEqual([wrong, { ok: false, reason: 'property_mismatch', property: 'SUMMARY' }]);
        }
        expect(failure(verifyEditOutcome(FIXTURE, swapLine(MASTER.text, 'SUMMARY:new'), MASTER_EXPECTATION))).toBe('property_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, swapLine(MASTER.text, 'SUMMARY:new', 'SUMMARY:new', 'SUMMARY:new'), MASTER_EXPECTATION))).toBe('property_mismatch');
        // Name case is not meaning.
        expect<unknown>(verifyEditOutcome(FIXTURE, swapLine(MASTER.text, 'SUMMARY:new', 'summary:new'), MASTER_EXPECTATION)).toEqual({ ok: true });
    });

    test('an edit that leaks into the VALARM DESCRIPTION', () => {
        const leaked = swapLine(MASTER.text, 'DESCRIPTION:Alarm description must stay', 'DESCRIPTION:new');
        expect<unknown>(verifyEditOutcome(FIXTURE, leaked, MASTER_EXPECTATION)).toEqual({ ok: false, reason: 'alarms_mismatch', property: 'VALARM' });
    });

    test('a changed TZID parameter on the untouched DTSTART', () => {
        const moved = swapLine(MASTER.text, 'DTSTART;TZID=America/New_York:20261201T100000', 'DTSTART;TZID=Europe/Berlin:20261201T100000');
        expect<unknown>(verifyEditOutcome(FIXTURE, moved, MASTER_EXPECTATION)).toEqual({ ok: false, reason: 'property_changed', property: null });
        const duplicated = swapLine(MASTER.text, 'DTSTART;TZID=America/New_York:20261201T100000', 'DTSTART;TZID=America/New_York;TZID=Europe/Berlin:20261201T100000');
        expect(failure(verifyEditOutcome(FIXTURE, duplicated, MASTER_EXPECTATION))).toBe('property_changed');
    });

    test('ATTENDEE and ORGANIZER in any spelling, anywhere, are refused', () => {
        const variants: string[][] = [
            ['a.attendee:mailto:x@example.test'],
            ['A.ATTENDEE;CN=x:mailto:x@example.test'],
            ['Attendee:mailto:x@example.test'],
            ['ATTEN', ' DEE:mailto:x@example.test'],
            ['ATTENDEE;CN="a:b":mailto:x', '\t@example.test'],
            ['organizer:mailto:me@example.test'],
            ['x.y.Organizer:mailto:me@example.test'],
        ];
        for (const added of variants) {
            expect<unknown>([added, verifyEditOutcome(FIXTURE, insertAfter(MASTER.text, 'SUMMARY:new', ...added), MASTER_EXPECTATION)])
                .toEqual([added, { ok: false, reason: 'scheduling_added', property: 'ATTENDEE/ORGANIZER' }]);
            // Also in the untouched override, the VTODO and at calendar level.
            for (const anchor of ['SUMMARY:Weekly sync (holiday edition)', 'SUMMARY:Unrelated todo', 'X-WR-CALNAME:Work']) {
                expect<unknown>([added, anchor, failure(verifyEditOutcome(FIXTURE, insertAfter(MASTER.text, anchor, ...added), MASTER_EXPECTATION))]).toEqual([added, anchor, 'scheduling_added']);
            }
        }
    });

    test('an ATTENDEE inside a VALARM: an added EMAIL alarm, or a line slipped into the existing alarm', () => {
        const email = ['BEGIN:VALARM', 'ACTION:EMAIL', 'ATTENDEE:mailto:x@example.test', 'SUMMARY:s', 'DESCRIPTION:d', 'TRIGGER:-PT5M', 'END:VALARM'];
        expect(failure(verifyEditOutcome(FIXTURE, insertAfter(MASTER.text, 'TRANSP:OPAQUE', ...email), MASTER_EXPECTATION))).toBe('scheduling_added');
        expect(failure(verifyEditOutcome(FIXTURE, insertAfter(MASTER.text, 'ACTION:DISPLAY', 'ATTENDEE:mailto:x@example.test'), MASTER_EXPECTATION))).toBe('scheduling_added');
        // Without an attendee, a new non-DISPLAY alarm is refused by its own rule.
        for (const action of ['ACTION:EMAIL', 'ACTION:AUDIO', 'ACTION:PROCEDURE', 'ACTION;X=1:DISPLAY', 'X-ACTION:DISPLAY']) {
            const alarm = ['BEGIN:VALARM', action, 'TRIGGER:-PT5M', 'END:VALARM'];
            expect<unknown>([action, failure(verifyEditOutcome(FIXTURE, insertAfter(MASTER.text, 'TRANSP:OPAQUE', ...alarm), MASTER_EXPECTATION))]).toEqual([action, 'alarm_action_added']);
        }
        expect(failure(verifyEditOutcome(FIXTURE, swapLine(MASTER.text, 'ACTION:DISPLAY', 'ACTION:EMAIL'), MASTER_EXPECTATION))).toBe('alarm_action_added');
    });

    test('a new ATTACH is refused anywhere', () => {
        for (const anchor of ['SUMMARY:new', 'SUMMARY:Weekly sync (moved)', 'X-WR-ALARMUID:OVR-ALARM']) {
            expect<unknown>([anchor, failure(verifyEditOutcome(FIXTURE, insertAfter(MASTER.text, anchor, 'a.attach:https://example.test/x'), MASTER_EXPECTATION))]).toEqual([anchor, 'attachment_added']);
        }
    });

    test('untouched components, calendar properties, companions and identity', () => {
        const table: [string, string][] = [
            [swapLine(MASTER.text, 'SUMMARY:Weekly sync (moved)', 'SUMMARY:Weekly sync (moved!)'), 'component_changed'],
            [swapLine(MASTER.text, 'TZNAME:EDT', 'TZNAME:XDT'), 'component_changed'],
            [swapLine(MASTER.text, 'SUMMARY:Unrelated todo', 'SUMMARY:x'), 'component_changed'],
            [swapLine(MASTER.text, 'X-WR-CALNAME:Work', 'X-WR-CALNAME:Home'), 'calendar_changed'],
            [insertAfter(MASTER.text, 'SUMMARY:new', 'X-ALT-DESC:<p>x</p>'), 'companion_present'],
            [insertAfter(MASTER.text, 'SUMMARY:new', 'X-NEW:1'), 'property_changed'],
            [swapLine(MASTER.text, 'COMMENT:second comment', 'COMMENT:second  comment'), 'property_changed'],
            [swapLine(MASTER.text, 'X-CUSTOM-FLAG:second copy kept'), 'property_changed'],
            [swapLine(MASTER.text, 'STATUS:CONFIRMED', 'STATUS:TENTATIVE'), 'property_mismatch'],
            [MASTER.text.replaceAll('UID:7F3A2C1E-5B4D-4E6F-8A9B-0C1D2E3F4A5B', 'UID:other'), 'identity_changed'],
            [MASTER.text.replace('\r\n', '\r'), 'line_endings'],
            [MASTER.text.replace('END:VCALENDAR', 'END:VCALENDAX'), 'after_unparseable'],
        ];
        for (const [after, reason] of table) { expect<unknown>(failure(verifyEditOutcome(FIXTURE, after, MASTER_EXPECTATION))).toBe(reason); }
        // Moving an untouched property relative to the others is a change.
        const reordered = swapLine(swapLine(MASTER.text, 'COMMENT:first comment'), 'COMMENT:second comment', 'COMMENT:second comment', 'COMMENT:first comment');
        expect(failure(verifyEditOutcome(FIXTURE, reordered, MASTER_EXPECTATION))).toBe('property_changed');
        // Refolding is not a change of meaning.
        const refolded = swapLine(MASTER.text, 'X-CUSTOM-FLAG:second copy kept', 'X-CUSTOM-FLAG:second', '  copy kept');
        expect<unknown>(verifyEditOutcome(FIXTURE, refolded, MASTER_EXPECTATION)).toEqual({ ok: true });
    });

    test('a malformed expectation is refused, never a pass', () => {
        const bad: unknown[] = [
            null,
            { target: { component: { kind: 'other' } } },
            { target: { component: { kind: 'master' }, properties: [{ name: 'ATTENDEE', type: 'cal-address', values: ['mailto:x'] }] } },
            { target: { component: { kind: 'master' }, properties: [{ name: 'UID', absent: true }] } },
            { target: { component: { kind: 'master' }, properties: [{ name: 'RRULE', absent: true }] } },
            { target: { component: { kind: 'master' }, properties: [{ name: 'X;Y', absent: true }] } },
            { target: { component: { kind: 'master' }, properties: [text('SUMMARY', 'a'), text('summary', 'b')] } },
            { target: { component: { kind: 'master' }, properties: [{ name: 'SUMMARY', type: 'text', values: ['new'], params: { value: ['TEXT'] } }] } },
            { target: { component: { kind: 'master' }, companionsRemoved: ['X-OTHER'] } },
            { target: { component: { kind: 'master' }, rrule: 'FREQ=DAILY\r\nATTENDEE:x' } },
            { target: { component: { kind: 'master' }, alarms: { kind: 'sometimes' } } },
        ];
        for (const expectation of bad) {
            expect<unknown>([expectation, failure(verifyEditOutcome(FIXTURE, MASTER.text, expectation as EditExpectation))]).toEqual([expectation, 'expectation_invalid']);
        }
    });
});

// ---- Expectation kinds, positive and negative ----

describe('verifyEditOutcome: each expectation kind', () => {
    test('alarms replaced, RRULE by decoded meaning', () => {
        const result = editResource(FIXTURE, {
            target: { kind: 'master' },
            edits: [
                { op: 'replace', property: rruleProperty('FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z', 'zoned') },
                { op: 'remove_alarms' },
                { op: 'add_alarm', alarm: displayAlarm('PT30M') },
                { op: 'add_alarm', alarm: displayAlarm('P1D') },
            ],
        });
        const expectation = (rrule: string, alarms: { trigger: string; description: string }[]): EditExpectation => ({ target: { component: { kind: 'master' }, rrule, alarms: { kind: 'replaced', alarms } } });
        const alarms = [{ trigger: '-P1D', description: 'Reminder' }, { trigger: '-PT30M', description: 'Reminder' }];
        for (const rrule of ['FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z', 'byday=tu;freq=weekly;until=20261215T145959Z', 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;UNTIL=20261215T145959Z'.replace(';INTERVAL=1', '')]) {
            expect<unknown>([rrule, verifyEditOutcome(FIXTURE, result.text, expectation(rrule, alarms))]).toEqual([rrule, { ok: true }]);
        }
        expect(failure(verifyEditOutcome(FIXTURE, result.text, expectation('FREQ=WEEKLY;BYDAY=WE;UNTIL=20261215T145959Z', alarms)))).toBe('rrule_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, result.text, expectation('FREQ=WEEKLY;BYDAY=TU;INTERVAL=2;UNTIL=20261215T145959Z', alarms)))).toBe('rrule_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, result.text, expectation('FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z', [{ trigger: '-PT15M', description: 'Reminder' }, alarms[1] as { trigger: string; description: string }])))).toBe('alarms_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, result.text, expectation('FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z', [alarms[0] as { trigger: string; description: string }])))).toBe('alarms_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, result.text, { target: { component: { kind: 'master' }, rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z' } }))).toBe('alarms_mismatch');
        // A written alarm with an extra line, a parameter or a changed description is not the expected alarm.
        for (const [from, to] of [['TRIGGER:-PT30M', 'TRIGGER;RELATED=END:-PT30M'], ['DESCRIPTION:Reminder', 'DESCRIPTION:Reminder!'], ['TRIGGER:-PT30M', 'TRIGGER:-PT30M\r\nX-EXTRA:1'], ['TRIGGER:-PT30M', 'TRIGGER:-PT30M\r\nTRIGGER:-PT30M']] as const) {
            const physical = result.text.slice(0, -2).split('\r\n');
            const index = physical.lastIndexOf(from);
            physical.splice(index, 1, ...to.split('\r\n'));
            expect<unknown>([to, failure(verifyEditOutcome(FIXTURE, crlf(physical), expectation('FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T145959Z', alarms)))]).toEqual([to, 'alarms_mismatch']);
        }
    });

    test('numeric RRULE parts compare by decoded value', () => {
        const series = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT', 'END:VCALENDAR']);
        const result = editResource(series, { target: { kind: 'master' }, edits: [{ op: 'replace', property: rruleProperty('FREQ=MONTHLY;INTERVAL=007;BYMONTHDAY=+31,05', 'utc') }] });
        expect(result.text).toContain('RRULE:FREQ=MONTHLY;INTERVAL=7;BYMONTHDAY=+31,5');
        for (const rrule of ['FREQ=MONTHLY;INTERVAL=007;BYMONTHDAY=+31,05', 'FREQ=MONTHLY;INTERVAL=7;BYMONTHDAY=31,5', 'BYMONTHDAY=31,005;INTERVAL=0007;FREQ=MONTHLY']) {
            expect<unknown>([rrule, verifyEditOutcome(series, result.text, { target: { component: { kind: 'master' }, rrule } })]).toEqual([rrule, { ok: true }]);
        }
        for (const rrule of ['FREQ=MONTHLY;INTERVAL=8;BYMONTHDAY=31,5', 'FREQ=MONTHLY;INTERVAL=7;BYMONTHDAY=5,31', 'FREQ=MONTHLY;INTERVAL=7;BYMONTHDAY=-31,5']) {
            expect<unknown>([rrule, failure(verifyEditOutcome(series, result.text, { target: { component: { kind: 'master' }, rrule } }))]).toEqual([rrule, 'rrule_mismatch']);
        }
    });

    test('alarms removed; unchanged is the default', () => {
        const result = editResource(FIXTURE, { target: { kind: 'master' }, edits: [{ op: 'remove_alarms' }] });
        expect<unknown>(verifyEditOutcome(FIXTURE, result.text, { target: { component: { kind: 'master' }, alarms: { kind: 'removed' } } })).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(FIXTURE, result.text, { target: { component: { kind: 'master' } } }))).toBe('alarms_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, FIXTURE.replaceAll('\n', '\r\n'), { target: { component: { kind: 'master' }, alarms: { kind: 'removed' } } }))).toBe('alarms_mismatch');
        // The untouched override keeps its alarm: removal applies to the target only.
        expect(failure(verifyEditOutcome(FIXTURE, swapLine(result.text, 'TRIGGER:-PT5M', 'TRIGGER:-PT6M'), { target: { component: { kind: 'master' }, alarms: { kind: 'removed' } } }))).toBe('component_changed');
    });

    test('RRULE removed', () => {
        const single = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'RRULE:FREQ=DAILY', 'EXDATE:20270112T100000Z', 'END:VEVENT', 'END:VCALENDAR']);
        const result = editResource(single, { target: { kind: 'master' }, edits: [{ op: 'remove', name: 'RRULE' }, { op: 'remove_all', name: 'EXDATE' }] });
        // The series becomes a single event, allowed only because the RRULE removal is expected.
        expect<unknown>(verifyEditOutcome(single, result.text, { target: { component: { kind: 'master' }, rrule: null, exdates: { kind: 'removed_all' } } })).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(single, result.text, { target: { component: { kind: 'master' }, rrule: null } }))).toBe('property_changed');
        expect(failure(verifyEditOutcome(single, result.text, { target: { component: { kind: 'master' }, exdates: { kind: 'removed_all' } } }))).toBe('identity_changed');
        expect(failure(verifyEditOutcome(single, single, { target: { component: { kind: 'master' }, rrule: null } }))).toBe('rrule_mismatch');
    });

    test('a single event becomes a series only by an expected RRULE', () => {
        const single = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'SUMMARY:s', 'END:VEVENT', 'END:VCALENDAR']);
        const result = editResource(single, { target: { kind: 'master' }, edits: [{ op: 'set', property: rruleProperty('FREQ=DAILY;COUNT=3', 'utc') }] });
        expect<unknown>(verifyEditOutcome(single, result.text, { target: { component: { kind: 'master' }, rrule: 'FREQ=DAILY;COUNT=3' } })).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(single, result.text, { target: { component: { kind: 'master' } } }))).toBe('identity_changed');
    });

    test('EXDATE added with the override of that occurrence removed (delete this)', () => {
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
        const expectation = (exdate: string, removeOverride: string | null): EditExpectation => ({
            target: { component: { kind: 'master' }, properties: STAMPS(4), exdates: { kind: 'added', values: [{ type: 'date-time', values: [exdate], params: { tzid: [NY] } }] } },
            ...(removeOverride === null ? {} : { removeOverride: { recurrenceId: removeOverride } }),
        });
        expect<unknown>(verifyEditOutcome(FIXTURE, result.text, expectation('2026-12-22T10:00:00', RID_DEC22))).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(FIXTURE, result.text, expectation('2026-12-23T10:00:00', RID_DEC22)))).toBe('exdate_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, result.text, expectation('2026-12-22T10:00:00', null)))).toBe('component_changed');
        expect(failure(verifyEditOutcome(FIXTURE, result.text, expectation('2026-12-22T10:00:00', RID_DEC08)))).toBe('component_changed');
        expect(failure(verifyEditOutcome(FIXTURE, result.text, expectation('2026-12-22T10:00:00', `${RID_DEC22}x`)))).toBe('override_mismatch');
        // An old EXDATE dropped or changed is not an addition.
        const dropped = swapLine(result.text, 'EXDATE;TZID=America/New_York:20261215T100000', 'EXDATE;TZID=America/New_York:20261216T100000');
        expect(failure(verifyEditOutcome(FIXTURE, dropped, expectation('2026-12-22T10:00:00', RID_DEC22)))).toBe('exdate_mismatch');
        const extra = insertAfter(result.text, 'EXDATE;TZID=America/New_York:20261222T100000', 'EXDATE;TZID=America/New_York:20261222T100000');
        expect(failure(verifyEditOutcome(FIXTURE, extra, expectation('2026-12-22T10:00:00', RID_DEC22)))).toBe('exdate_mismatch');
    });

    test('every EXDATE removed', () => {
        const result = editResource(FIXTURE, { target: { kind: 'master' }, edits: [{ op: 'remove_all', name: 'EXDATE' }] });
        expect<unknown>(verifyEditOutcome(FIXTURE, result.text, { target: { component: { kind: 'master' }, exdates: { kind: 'removed_all' } } })).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(FIXTURE, result.text, { target: { component: { kind: 'master' } } }))).toBe('property_changed');
        expect(failure(verifyEditOutcome(FIXTURE, FIXTURE, { target: { component: { kind: 'master' }, exdates: { kind: 'removed_all' } } }))).toBe('exdate_mismatch');
    });

    test('an existing override edited; the master and the other override must be untouched', () => {
        const result = editResource(FIXTURE, {
            target: { kind: 'override', recurrenceId: RID_DEC08 },
            edits: [{ op: 'set', property: textProperty('SUMMARY', 'Moved, renamed') }, { op: 'remove', name: 'LOCATION' }, { op: 'set', property: sequenceProperty(5) }, { op: 'set', property: transparencyProperty('TRANSPARENT') }],
        });
        const expectation: EditExpectation = {
            target: {
                component: { kind: 'override', recurrenceId: RID_DEC08 },
                properties: [text('SUMMARY', 'Moved, renamed'), { name: 'LOCATION', absent: true }, integer('SEQUENCE', 5), text('TRANSP', 'TRANSPARENT')],
                companionsRemoved: ['X-APPLE-STRUCTURED-LOCATION'],
            },
        };
        expect<unknown>(verifyEditOutcome(FIXTURE, result.text, expectation)).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(FIXTURE, result.text, { target: { ...expectation.target, component: { kind: 'master' } } as EditExpectation['target'] }))).toBe('component_changed');
        expect(failure(verifyEditOutcome(FIXTURE, result.text, { target: { ...expectation.target, component: { kind: 'override', recurrenceId: RID_DEC22 } } as EditExpectation['target'] }))).toBe('component_changed');
        expect(failure(verifyEditOutcome(FIXTURE, result.text, { target: { ...expectation.target, component: { kind: 'override', recurrenceId: `${RID_DEC08} ` } } as EditExpectation['target'] }))).toBe('target_not_found');
        expect(failure(verifyEditOutcome(FIXTURE, swapLine(result.text, 'DESCRIPTION:Override alarm', 'DESCRIPTION:x'), expectation))).toBe('alarms_mismatch');
    });

    test('a new override: every copyable master line copied, the written ones as expected, alarms copied', () => {
        const outline = describeEvents(FIXTURE);
        const master = outline.find(event => event.recurrenceId === null) as EventOutline;
        const notCopied = new Set(['rrule', 'rdate', 'exdate', 'exrule', 'dtstart', 'dtend', 'duration', 'dtstamp', 'last-modified', 'sequence']);
        const copies: NewComponentItem[] = master.properties.filter(line => !notCopied.has(line.name)).map(line => ({ copy_line: line.index }));
        const written = [
            timeProperty('RECURRENCE-ID', zoned('20270105T100000')),
            timeProperty('DTSTART', zoned('20270105T110000')),
            timeProperty('DTEND', zoned('20270105T113000')),
            timeProperty('DTSTAMP', NOW),
            timeProperty('LAST-MODIFIED', NOW),
            sequenceProperty(4),
        ];
        const alarm: NewComponentItem = { copy_component: master.alarms[0]?.begin ?? -1 };
        const plan = (items: NewComponentItem[]): EditPlan => ({ resource: [{ op: 'add_component', items }] });
        const expectation = (alarms: NonNullable<EditExpectation['addOverride']>['alarms'] = { kind: 'copied' }): EditExpectation => ({
            addOverride: {
                recurrenceId: { type: 'date-time', values: ['2027-01-05T10:00:00'], params: { tzid: [NY] } },
                properties: [local('DTSTART', '2027-01-05T11:00:00'), local('DTEND', '2027-01-05T11:30:00'), ...STAMPS(4)],
                alarms,
            },
        });
        const good = editResource(FIXTURE, plan([...copies, ...written, alarm])).text;
        expect<unknown>(verifyEditOutcome(FIXTURE, good, expectation())).toEqual({ ok: true });
        // The ATTACH copy of the master's line is allowed; a different one is not.
        expect(good.split('\r\n').filter(line => line.startsWith('ATTACH'))).toHaveLength(2);
        expect(failure(verifyEditOutcome(FIXTURE, good.replace(/(BEGIN:VEVENT\r\nCREATED[^]*?)ATTACH;FMTTYPE=application\/pdf/u, '$1ATTACH;FMTTYPE=application/zip'), expectation()))).not.toBeNull();
        expect(failure(verifyEditOutcome(FIXTURE, good, expectation({ kind: 'removed' })))).toBe('alarms_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, good, { addOverride: { ...expectation().addOverride, recurrenceId: { type: 'date-time', values: ['2027-01-06T10:00:00'], params: { tzid: [NY] } } } as EditExpectation['addOverride'] }))).toBe('override_mismatch');
        // Without an expected override, its copied ATTACH is already a new attachment (hard rules come first).
        expect(failure(verifyEditOutcome(FIXTURE, good, {}))).toBe('attachment_added');
        // Not every master line copied (the editor test's partial plan), a copied RRULE, a missing alarm copy.
        const partial = copies.filter((_, index) => index !== 3);
        expect(failure(verifyEditOutcome(FIXTURE, editResource(FIXTURE, plan([...partial, ...written, alarm])).text, expectation()))).toBe('override_mismatch');
        const rrule = master.properties.find(line => line.name === 'rrule')?.index ?? -1;
        expect(failure(verifyEditOutcome(FIXTURE, editResource(FIXTURE, plan([...copies, { copy_line: rrule }, ...written, alarm])).text, expectation()))).toBe('override_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, editResource(FIXTURE, plan([...copies, ...written])).text, expectation()))).toBe('alarms_mismatch');
        expect<unknown>(verifyEditOutcome(FIXTURE, editResource(FIXTURE, plan([...copies, ...written])).text, expectation({ kind: 'removed' }))).toEqual({ ok: true });
        const replaced = editResource(FIXTURE, plan([...copies, ...written, displayAlarm('PT10M')])).text;
        expect<unknown>(verifyEditOutcome(FIXTURE, replaced, expectation({ kind: 'replaced', alarms: [{ trigger: '-PT10M', description: 'Reminder' }] }))).toEqual({ ok: true });
        // A written DTSTART with the wrong time, a scheduling line written into the new override, an added second override.
        expect(failure(verifyEditOutcome(FIXTURE, swapLine(good, 'DTSTART;TZID=America/New_York:20270105T110000', 'DTSTART;TZID=America/New_York:20270105T104500'), expectation()))).toBe('property_mismatch');
        expect(failure(verifyEditOutcome(FIXTURE, insertAfter(good, 'SEQUENCE:4', 'ORGANIZER:mailto:me@example.test'), expectation()))).toBe('scheduling_added');
        const twice = editResource(FIXTURE, { resource: [{ op: 'add_component', items: [...copies, ...written, alarm] }, { op: 'add_component', items: [...copies, timeProperty('RECURRENCE-ID', zoned('20270112T100000')), ...written.slice(1), alarm] }] }).text;
        expect(failure(verifyEditOutcome(FIXTURE, twice, expectation()))).toBe('override_mismatch');
    });

    test('a new override of a floating series writes floating DTSTART/DTEND (finding 4)', () => {
        const series = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000', 'DTEND:20270111T110000', 'RRULE:FREQ=DAILY', 'SUMMARY:floating', 'END:VEVENT', 'END:VCALENDAR']);
        const master = describeEvents(series)[0] as EventOutline;
        const copies = master.properties.filter(line => ['uid', 'summary'].includes(line.name)).map(line => ({ copy_line: line.index }));
        const result = editResource(series, { resource: [{ op: 'add_component', items: [
            ...copies,
            timeProperty('RECURRENCE-ID', { kind: 'floating', local: '20270112T100000' }),
            timeProperty('DTSTART', { kind: 'floating', local: '20270112T120000' }, 'start', { overrideCopy: true }),
            timeProperty('DTEND', { kind: 'floating', local: '20270112T130000' }, 'end', { overrideCopy: true }),
        ] }] });
        expect(result.text).toContain('\r\nDTSTART:20270112T120000\r\n');
        const expectation: EditExpectation = { addOverride: {
            recurrenceId: { type: 'date-time', values: ['2027-01-12T10:00:00'] },
            properties: [{ name: 'DTSTART', type: 'date-time', values: ['2027-01-12T12:00:00'] }, { name: 'DTEND', type: 'date-time', values: ['2027-01-12T13:00:00'] }],
            alarms: { kind: 'copied' },
        } };
        expect<unknown>(verifyEditOutcome(series, result.text, expectation)).toEqual({ ok: true });
    });
});

// ---- Fuzz ----

describe('seeded fuzz: single-line corruptions of a correct output', () => {
    /** Logical lines (unfolded) of CRLF text. */
    const logical = (source: string): string[] => {
        const result: string[] = [];
        for (const line of source.slice(0, -2).split('\r\n')) {
            if ((line.startsWith(' ') || line.startsWith('\t')) && result.length > 0) { result[result.length - 1] += line.slice(1); } else { result.push(line); }
        }
        return result;
    };
    const REPLACEMENTS = ['X', '7', '\\', ';', ':', ',', 'é', '"', '=', '-', ' ', '0', 'Z', '.'];
    const FOREIGN = ['ATTENDEE:mailto:x@example.test', 'X-NEW:1', 'SUMMARY:new', 'BEGIN:VALARM', 'END:VEVENT', 'ATTACH:https://example.test/a', 'DESCRIPTION:Reminder', 'COMMENT:first comment'];

    // A second correct output: a new override built per design 3.3 (all copyable master lines, written times, alarm copy).
    const outline = describeEvents(FIXTURE).find(event => event.recurrenceId === null) as EventOutline;
    const notCopied = new Set(['rrule', 'rdate', 'exdate', 'exrule', 'dtstart', 'dtend', 'duration', 'dtstamp', 'last-modified', 'sequence']);
    const OVERRIDE = editResource(FIXTURE, { resource: [{ op: 'add_component', items: [
        ...outline.properties.filter(line => !notCopied.has(line.name)).map(line => ({ copy_line: line.index })),
        timeProperty('RECURRENCE-ID', zoned('20270105T100000')),
        timeProperty('DTSTART', zoned('20270105T110000')),
        timeProperty('DTEND', zoned('20270105T113000')),
        timeProperty('DTSTAMP', NOW),
        timeProperty('LAST-MODIFIED', NOW),
        sequenceProperty(4),
        { copy_component: outline.alarms[0]?.begin ?? -1 },
    ] }] }).text;
    const OVERRIDE_EXPECTATION: EditExpectation = { addOverride: {
        recurrenceId: { type: 'date-time', values: ['2027-01-05T10:00:00'], params: { tzid: [NY] } },
        properties: [local('DTSTART', '2027-01-05T11:00:00'), local('DTEND', '2027-01-05T11:30:00'), ...STAMPS(4)],
        alarms: { kind: 'copied' },
    } };

    test.each([['master edit', MASTER.text, MASTER_EXPECTATION], ['new override', OVERRIDE, OVERRIDE_EXPECTATION]] as const)('%s: 2000 seeded corruptions are each rejected unless the logical lines are unchanged', (_label, output, expectation) => {
        expect<unknown>(verifyEditOutcome(FIXTURE, output, expectation)).toEqual({ ok: true });
        let seed = 0x5eed;
        const random = (limit: number): number => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed % limit;
        };
        const good = logical(output);
        let rejected = 0;
        for (let iteration = 0; iteration < 2000; iteration++) {
            const lines = [...good];
            const index = random(lines.length);
            const line = lines[index] ?? '';
            const kind = random(4);
            if (kind === 0 && line.length > 0) {
                const position = random(line.length);
                const original = line[position] ?? '';
                const replacement = REPLACEMENTS[random(REPLACEMENTS.length)] ?? 'X';
                // A case-only change of a name is not a corruption of meaning; skip it.
                if (replacement.toLowerCase() === original.toLowerCase()) { continue; }
                lines[index] = `${line.slice(0, position)}${replacement}${line.slice(position + 1)}`;
            } else if (kind === 1) {
                lines.splice(index, 1);
            } else if (kind === 2) {
                lines.splice(index, 0, line);
            } else {
                lines.splice(index, 0, FOREIGN[random(FOREIGN.length)] ?? 'X-NEW:1');
            }
            const corrupted = crlf(lines);
            const verdict = verifyEditOutcome(FIXTURE, corrupted, expectation);
            const unchanged = JSON.stringify(logical(corrupted)) === JSON.stringify(good);
            expect<unknown>([iteration, kind, index, verdict.ok]).toEqual([iteration, kind, index, unchanged]);
            if (!verdict.ok) { rejected++; }
        }
        expect<unknown>(rejected).toBeGreaterThan(1500);
    });
});

// ---- Created resources ----

describe('verifyCreateOutcome', () => {
    const INPUT: CreateEventInput = {
        uid: 'cmcp1-abc', now: '20261112T181500Z', title: 'Weekly, sync', start: zoned('20261201T100000'), end: zoned('20261201T103000'),
        location: 'Room 1', alarms: [{ before_start: 'PT15M' }], rrule: 'FREQ=WEEKLY;BYDAY=TU', status: 'CONFIRMED',
    };
    const nowStamp = (name: string): ExpectedProperty => ({ name, type: 'date-time', values: ['2026-11-12T18:15:00Z'] });
    const EXPECTED: CreateExpectation = {
        properties: [
            text('UID', 'cmcp1-abc'), nowStamp('DTSTAMP'), nowStamp('CREATED'), nowStamp('LAST-MODIFIED'), integer('SEQUENCE', 0),
            local('DTSTART', '2026-12-01T10:00:00'), local('DTEND', '2026-12-01T10:30:00'), text('SUMMARY', 'Weekly, sync'), text('LOCATION', 'Room 1'), text('STATUS', 'CONFIRMED'),
        ],
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        alarms: [{ trigger: '-PT15M', description: 'Reminder' }],
    };
    const created = buildCreateResource(INPUT);

    test('the genuine resource passes', () => {
        expect<unknown>(verifyCreateOutcome(created, EXPECTED)).toEqual({ ok: true });
        const plain = buildCreateResource({ ...INPUT, rrule: undefined, alarms: undefined });
        expect<unknown>(verifyCreateOutcome(plain, { ...EXPECTED, rrule: undefined, alarms: [] })).toEqual({ ok: true });
    });

    test('corruptions and mismatches are refused', () => {
        const table: [string, CreateExpectation, string][] = [
            [insertAfter(created, 'SUMMARY:Weekly\\, sync', 'ATTENDEE:mailto:x@example.test'), EXPECTED, 'scheduling_added'],
            [insertAfter(created, 'SUMMARY:Weekly\\, sync', 'b.Organizer:mailto:x@example.test'), EXPECTED, 'scheduling_added'],
            [insertAfter(created, 'SUMMARY:Weekly\\, sync', 'ATTACH:https://example.test/a'), EXPECTED, 'attachment_added'],
            [swapLine(created, 'ACTION:DISPLAY', 'ACTION:EMAIL'), EXPECTED, 'alarm_action_added'],
            [insertAfter(created, 'SUMMARY:Weekly\\, sync', 'X-EXTRA:1'), EXPECTED, 'unexpected_property'],
            [swapLine(created, 'SUMMARY:Weekly\\, sync', 'SUMMARY:Weekly sync'), EXPECTED, 'property_mismatch'],
            [swapLine(created, 'TRIGGER:-PT15M', 'TRIGGER:-PT16M'), EXPECTED, 'alarms_mismatch'],
            [swapLine(created, 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'RRULE:FREQ=WEEKLY;BYDAY=WE'), EXPECTED, 'rrule_mismatch'],
            [insertAfter(created, 'CALSCALE:GREGORIAN', 'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'END:VTIMEZONE'), EXPECTED, 'component_changed'],
            [insertAfter(created, 'CALSCALE:GREGORIAN', 'BEGIN:VTODO', 'UID:t', 'END:VTODO'), EXPECTED, 'component_changed'],
            [insertAfter(created, 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:x'), EXPECTED, 'calendar_changed'],
            [created, { ...EXPECTED, properties: EXPECTED.properties.filter(property => property.name !== 'LOCATION') }, 'unexpected_property'],
            [created, { ...EXPECTED, rrule: undefined }, 'unexpected_property'],
            [created, { ...EXPECTED, alarms: [] }, 'alarms_mismatch'],
            [created, { ...EXPECTED, properties: [...EXPECTED.properties, text('DESCRIPTION', 'd')] }, 'property_mismatch'],
            [created, { ...EXPECTED, properties: [...EXPECTED.properties, { name: 'ATTENDEE', type: 'cal-address', values: ['mailto:x'] }] }, 'expectation_invalid'],
        ];
        for (const [resource, expectation, reason] of table) { expect<unknown>(failure(verifyCreateOutcome(resource, expectation))).toBe(reason); }
        const zone = insertAfter(created, 'CALSCALE:GREGORIAN', 'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'END:VTIMEZONE');
        expect<unknown>(verifyCreateOutcome(zone, { ...EXPECTED, vtimezoneCount: 1 })).toEqual({ ok: true });
    });

    test('travel time (addendum 1): the expected X-APPLE-TRAVEL-DURATION is a duration value; any other value or line is refused', () => {
        const travel: ExpectedProperty = { name: 'X-APPLE-TRAVEL-DURATION', type: 'duration', values: ['PT25M'] };
        const withTravel = buildCreateResource({ ...INPUT, travelDuration: 'PT25M' });
        const expected: CreateExpectation = { ...EXPECTED, properties: [...EXPECTED.properties, travel] };
        expect<unknown>(verifyCreateOutcome(withTravel, expected)).toEqual({ ok: true });
        const line = 'X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT25M';
        const table: [string, CreateExpectation, string][] = [
            [swapLine(withTravel, line, 'X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT26M'), expected, 'property_mismatch'],
            [swapLine(withTravel, line, 'X-APPLE-TRAVEL-DURATION:PT25M'), expected, 'property_mismatch'],
            [swapLine(withTravel, line, line, 'X-APPLE-TRAVEL-START;ROUTING=CAR;VALUE=URI:geo:1,2'), expected, 'unexpected_property'],
            [swapLine(withTravel, line, line, line), expected, 'property_mismatch'],
            [withTravel, EXPECTED, 'unexpected_property'],
            [created, expected, 'property_mismatch'],
        ];
        for (const [resource, expectation, reason] of table) { expect<unknown>(failure(verifyCreateOutcome(resource, expectation))).toBe(reason); }
    });
});

describe('verifyEditOutcome with travel time (addendum 1)', () => {
    const BEFORE = crlf([
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.1//EN', 'BEGIN:VEVENT', 'UID:travel-1', 'DTSTAMP:20261101T120000Z', 'SEQUENCE:2',
        'DTSTART:20270111T150000Z', 'DTEND:20270111T160000Z', 'SUMMARY:Dentist', 'LOCATION:Main St 1',
        'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE="Main St 1":geo:52.5,13.4',
        'X-APPLE-TRAVEL-START;ROUTING=CAR;VALUE=URI;X-ADDRESS=Home:geo:52.4,13.3',
        'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
        'X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT17M',
        'END:VEVENT', 'END:VCALENDAR',
    ]);
    const stamps = [stamp('DTSTAMP'), stamp('LAST-MODIFIED'), integer('SEQUENCE', 3)];
    const edits: ComponentEdit[] = [
        { op: 'set', property: travelDurationProperty('PT40M') },
        { op: 'set', property: timeProperty('DTSTAMP', NOW) }, { op: 'set', property: timeProperty('LAST-MODIFIED', NOW) }, { op: 'set', property: sequenceProperty(3) },
    ];
    const expectation: EditExpectation = { target: { component: { kind: 'master' }, properties: [{ name: 'X-APPLE-TRAVEL-DURATION', type: 'duration', values: ['PT40M'] }, ...stamps] } };

    test('a replaced duration passes; a changed travel start or a wrong duration is refused', () => {
        const after = editResource(BEFORE, { target: { kind: 'master' }, edits }).text;
        expect<unknown>(verifyEditOutcome(BEFORE, after, expectation)).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(BEFORE, swapLine(after, 'X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT40M', 'X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT41M'), expectation))).toBe('property_mismatch');
        expect(failure(verifyEditOutcome(BEFORE, swapLine(after, 'X-APPLE-TRAVEL-START;ROUTING=CAR;VALUE=URI;X-ADDRESS=Home:geo:52.4,13.3'), expectation))).toBe('property_changed');
        expect(failure(verifyEditOutcome(BEFORE, swapLine(after, 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:DISABLED'), expectation))).toBe('property_changed');
    });

    test('a removed duration passes as an absence; a removal that also took the travel start is refused', () => {
        const removal: ComponentEdit[] = [{ op: 'remove', name: 'X-APPLE-TRAVEL-DURATION' }, ...edits.slice(1)];
        const absent: EditExpectation = { target: { component: { kind: 'master' }, properties: [{ name: 'X-APPLE-TRAVEL-DURATION', absent: true }, ...stamps] } };
        const after = editResource(BEFORE, { target: { kind: 'master' }, edits: removal }).text;
        expect<unknown>(verifyEditOutcome(BEFORE, after, absent)).toEqual({ ok: true });
        expect(failure(verifyEditOutcome(BEFORE, swapLine(after, 'X-APPLE-TRAVEL-START;ROUTING=CAR;VALUE=URI;X-ADDRESS=Home:geo:52.4,13.3'), absent))).toBe('property_changed');
        expect(failure(verifyEditOutcome(BEFORE, after, expectation))).toBe('property_mismatch');
    });
});

// ---- Independence and cost ----

describe('independence and cost', () => {
    test('ics-verify.ts imports neither the editor nor the serializer, and never ical.js directly', () => {
        const source = readFileSync(join(import.meta.dir, '../src/calendar/ics-verify.ts'), 'utf8');
        const imports = [...source.matchAll(/^import[^;]*from '([^']+)';$/gmu)].map(match => match[1]);
        expect<unknown>(imports).toEqual(['./ical', './model']);
    });

    test('a 40,000-line alarm verifies in linear time', () => {
        const alarm = Array.from({ length: 40_000 }, (_, index) => `X-LINE-${String(index)}:v`);
        const before = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20270111T100000Z', 'RRULE:FREQ=DAILY', 'BEGIN:VALARM', 'ACTION:EMAIL', 'TRIGGER:-PT5M', ...alarm, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR']);
        const edited = editResource(before, { target: { kind: 'master' }, edits: [{ op: 'set', property: textProperty('SUMMARY', 's') }] }).text;
        let started = performance.now();
        expect<unknown>(verifyEditOutcome(before, edited, { target: { component: { kind: 'master' }, properties: [text('SUMMARY', 's')] } })).toEqual({ ok: true });
        expect<unknown>(performance.now() - started).toBeLessThan(2000);
        const removed = editResource(before, { target: { kind: 'master' }, edits: [{ op: 'remove_alarms' }] }).text;
        started = performance.now();
        expect<unknown>(verifyEditOutcome(before, removed, { target: { component: { kind: 'master' }, alarms: { kind: 'removed' } } })).toEqual({ ok: true });
        expect<unknown>(performance.now() - started).toBeLessThan(2000);
    });
});
