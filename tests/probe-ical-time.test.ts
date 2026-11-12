import { describe, expect, test } from 'bun:test';
import { classifyTzid, dateShape, isDateValue, kindOf } from '../scripts/probe/ical-time';
import type { IcalProperty } from '../scripts/probe/ical';
import { zoneValidator } from '../scripts/probe/tz';

const p = (value: string, params: Record<string, string> = {}): IcalProperty => ({ name: 'DTSTART', params, value });

describe('time value kinds', () => {
    test('utc, tzid, date and floating are told apart, and a missing property is none', () => {
        expect(kindOf(p('20270301T090000Z'))).toBe('utc');
        expect(kindOf(p('20270301T090000', { TZID: 'America/New_York' }))).toBe('tzid');
        expect(kindOf(p('20270301', { VALUE: 'DATE' }))).toBe('date');
        expect(kindOf(p('20270301'))).toBe('invalid');
        expect(kindOf(p('20270301', { VALUE: 'DATE-TIME' }))).toBe('invalid');
        expect(kindOf(p('garbageZ'))).toBe('invalid');
        expect(kindOf(p('garbage'))).toBe('invalid');
        expect(kindOf(p('20270301T090000'))).toBe('floating');
        expect(kindOf(undefined)).toBe('none');
    });

    test('a TZID parameter on a DATE value is still a date; a Z wins over a TZID parameter', () => {
        expect(kindOf(p('20270301', { VALUE: 'DATE', TZID: 'America/New_York' }))).toBe('date');
        expect(isDateValue(p('20270301', { TZID: 'x' }))).toBe(false);
        expect(kindOf(p('20270301T090000Z', { TZID: 'America/New_York' }))).toBe('utc');
    });
});

describe('values the probe may record for its own events', () => {
    test('only strict date and date-time shapes pass; anything else becomes a placeholder', () => {
        expect(String(dateShape('20270301T090000Z'))).toBe('20270301T090000Z');
        expect(String(dateShape('20270301T090000'))).toBe('20270301T090000');
        expect(String(dateShape('20270301'))).toBe('20270301');
        expect(String(dateShape('Dentist 20270301'))).toBe('<other>');
        expect(String(dateShape('20270301T090000Z;x'))).toBe('<other>');
        expect(String(dateShape(undefined))).toBe('<none>');
    });
});

describe('TZID classes', () => {
    test('windows-like, mozilla-prefix and other', () => {
        for (const windows of ['Eastern Standard Time', 'W. Europe Standard Time', '(UTC-05:00) Eastern Time (US & Canada)', 'Customized Time Zone', 'tzone://Microsoft/Custom']) {
            expect(classifyTzid(windows)).toBe('windows');
        }
        expect(classifyTzid('/mozilla.org/20050126_1/America/New_York')).toBe('mozilla');
        for (const other of ['Nowhere/Land', 'GMT-5', 'Probe/Custom', '']) {
            expect(classifyTzid(other)).toBe('other');
        }
    });

    test('IANA validity comes from the built-in Temporal, and offsets are not zone names', () => {
        const isIanaZone = zoneValidator();
        expect(isIanaZone('America/New_York')).toBe(true);
        expect(isIanaZone('Europe/Berlin')).toBe(true);
        expect(isIanaZone('UTC')).toBe(true);
        expect(isIanaZone('Eastern Standard Time')).toBe(false);
        expect(isIanaZone('Probe/Custom')).toBe(false);
        expect(isIanaZone('+05:00')).toBe(false);
        expect(isIanaZone('/mozilla.org/20050126_1/America/New_York')).toBe(false);
        expect(isIanaZone('')).toBe(false);
        expect(isIanaZone('America/New_York')).toBe(true);
    });
});
