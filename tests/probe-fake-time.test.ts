/** The fake's time engine has to be right before the probe's checks can be tested against it. */
import { describe, expect, test } from 'bun:test';
import { parseIcal } from '../scripts/probe/ical';
import { embeddedZones, expandResource, limitRecurrenceSet, occurrences, utc, type TimeEnv } from './fixtures/probe/fake-time';

const ENV: TimeEnv = { floating: undefined, embedded: new Map(), tzPolicy: 'embedded-first', unknownTzid: 'use-embedded', overrideMatching: 'actual', thisAndFuture: 'ignored', feb29: 'skip' };
const wrap = (body: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const OPTIONS = { style: 'utc-all', keepDuration: false } as const;
const FOREVER = Date.UTC(2040, 0, 1);

function starts(ical: string, env: TimeEnv = ENV): string[] {
    const root = parseIcal(ical);
    return root === undefined ? [] : occurrences(root, FOREVER, env).map((o) => utc(o.start));
}

describe('fake time engine', () => {
    test('a weekly TZID series keeps its wall-clock time across the March change', () => {
        const ical = wrap(['BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID=America/New_York:20270307T090000', 'DTEND;TZID=America/New_York:20270307T100000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'END:VEVENT']);
        expect(starts(ical)).toEqual(['20270307T140000Z', '20270314T130000Z', '20270321T130000Z', '20270328T130000Z']);
    });

    test('embedded rules are used for a custom TZID, and the policy chooses the source', () => {
        const custom = [
            'BEGIN:VTIMEZONE', 'TZID:Probe/Custom',
            'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'DTSTART:19870405T020000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU', 'END:DAYLIGHT',
            'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'DTSTART:19971026T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
            'END:VTIMEZONE',
        ];
        const ical = wrap([...custom, 'BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID=Probe/Custom:20270315T090000', 'DTEND;TZID=Probe/Custom:20270315T100000', 'END:VEVENT']);
        const embedded = embeddedZones(parseIcal(ical));
        expect(starts(ical, { ...ENV, embedded })).toEqual(['20270315T140000Z']);
        expect(starts(ical, { ...ENV, embedded, unknownTzid: 'as-new-york' })).toEqual(['20270315T130000Z']);
        expect(starts(ical, { ...ENV, embedded, unknownTzid: 'as-utc' })).toEqual(['20270315T090000Z']);
    });

    test('floating and DATE values sit in UTC or in the calendar zone', () => {
        const floating = wrap(['BEGIN:VEVENT', 'UID:a', 'DTSTART:20270601T233000', 'DTEND:20270601T235900', 'END:VEVENT']);
        const dated = wrap(['BEGIN:VEVENT', 'UID:b', 'DTSTART;VALUE=DATE:20270601', 'END:VEVENT']);
        const both = (env: TimeEnv): string[] => [...starts(floating, env), ...starts(dated, env)];
        const losAngeles = embeddedZones(parseIcal(wrap(['BEGIN:VTIMEZONE', 'TZID:America/Los_Angeles', 'BEGIN:STANDARD', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT', 'END:VTIMEZONE']))).get('America/Los_Angeles');
        expect(both(ENV)).toEqual(['20270601T233000Z', '20270601T000000Z']);
        expect(both({ ...ENV, floating: losAngeles })).toEqual(['20270602T063000Z', '20270601T070000Z']);
    });

    test('yearly on February 29 follows the leap-year policy', () => {
        const ical = wrap(['BEGIN:VEVENT', 'UID:a', 'DTSTART;VALUE=DATE:20280229', 'DTEND;VALUE=DATE:20280301', 'RRULE:FREQ=YEARLY;COUNT=3', 'END:VEVENT']);
        expect(starts(ical)).toEqual(['20280229T000000Z', '20320229T000000Z', '20360229T000000Z']);
        expect(starts(ical, { ...ENV, feb29: 'clamp' })).toEqual(['20280229T000000Z', '20290228T000000Z', '20300228T000000Z']);
        expect(starts(ical, { ...ENV, feb29: 'roll' })).toEqual(['20280229T000000Z', '20290301T000000Z', '20300301T000000Z']);
    });

    test('expansion keeps or converts forms as the style says', () => {
        const ical = wrap(['BEGIN:VEVENT', 'UID:a', 'DTSTART;VALUE=DATE:20270601', 'DTEND;VALUE=DATE:20270602', 'RRULE:FREQ=WEEKLY;COUNT=2', 'END:VEVENT']);
        const range = [Date.UTC(2027, 4, 1), Date.UTC(2027, 7, 1)] as const;
        expect(expandResource(ical, ...range, ENV, OPTIONS)).toContain('DTSTART:20270601T000000Z');
        expect(expandResource(ical, ...range, ENV, { ...OPTIONS, style: 'keep-forms' })).toContain('DTSTART;VALUE=DATE:20270601');
        expect(expandResource(ical, ...range, ENV, { ...OPTIONS, style: 'keep-forms' })).toContain('RECURRENCE-ID;VALUE=DATE:20270608');
        expect(expandResource(ical, ...range, ENV, { ...OPTIONS, style: 'date-as-utc' })).toContain('DTEND:20270602T000000Z');
    });

    test('a moved override counts by its own times or by its original slot', () => {
        const ical = wrap([
            'BEGIN:VEVENT', 'UID:a', 'DTSTART:20270601T100000Z', 'DTEND:20270601T110000Z', 'RRULE:FREQ=WEEKLY;COUNT=2', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:a', 'RECURRENCE-ID:20270608T100000Z', 'DTSTART:20270610T100000Z', 'DTEND:20270610T110000Z', 'END:VEVENT',
        ]);
        const window = [Date.UTC(2027, 5, 9), Date.UTC(2027, 5, 12)] as const;
        expect(expandResource(ical, ...window, ENV, OPTIONS)).toContain('DTSTART:20270610T100000Z');
        expect(expandResource(ical, ...window, { ...ENV, overrideMatching: 'original-slot' }, OPTIONS)).not.toContain('DTSTART:');
    });

    test('a time that occurs twice is the first occurrence unless the policy says second; a time that does not exist is read before the gap unless it says after', () => {
        const at = (local: string): string => wrap(['BEGIN:VEVENT', 'UID:a', `DTSTART;TZID=America/New_York:${local}`, `DTEND;TZID=America/New_York:${local}`, 'END:VEVENT']);
        const repeated = at('20271107T013000');
        expect(starts(repeated)).toEqual(['20271107T053000Z']);
        expect(starts(repeated, { ...ENV, repeatedHour: 'first' })).toEqual(['20271107T053000Z']);
        expect(starts(repeated, { ...ENV, repeatedHour: 'second' })).toEqual(['20271107T063000Z']);
        const skipped = at('20270314T023000');
        expect(starts(skipped)).toEqual(['20270314T073000Z']);
        expect(starts(skipped, { ...ENV, skippedHour: 'after-gap' })).toEqual(['20270314T063000Z']);
        // Times that are neither repeated nor skipped do not depend on either policy.
        const plain = at('20271107T033000');
        expect(starts(plain, { ...ENV, repeatedHour: 'second', skippedHour: 'after-gap' })).toEqual(['20271107T083000Z']);
    });

    test('limit-recurrence-set drops overrides outside the window and keeps the master', () => {
        const ical = wrap([
            'BEGIN:VEVENT', 'UID:a', 'DTSTART:20270601T100000Z', 'DTEND:20270601T110000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:a', 'RECURRENCE-ID:20270608T100000Z', 'DTSTART:20270608T120000Z', 'DTEND:20270608T130000Z', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:a', 'RECURRENCE-ID:20270622T100000Z', 'DTSTART:20270622T120000Z', 'DTEND:20270622T130000Z', 'END:VEVENT',
        ]);
        const limited = limitRecurrenceSet(ical, Date.UTC(2027, 5, 1), Date.UTC(2027, 5, 15), ENV);
        expect(limited.match(/RECURRENCE-ID/g)?.length).toBe(1);
        expect(limited).toContain('RRULE:FREQ=WEEKLY;COUNT=4');
    });
});
