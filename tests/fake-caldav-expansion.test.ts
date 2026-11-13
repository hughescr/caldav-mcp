import { describe, expect, test } from 'bun:test';
import { FAKE_DISCOVERY, FakeICloud } from './helpers/fake-caldav-write';

// The fake's expanded REPORT reproduces the tuples measured in probe Run 7 (probe-out/write-0.6-run1.json): each case
// below states the check it comes from. Tuples are DTSTART/DTEND/RECURRENCE-ID values of each returned instance.

const CAL = '/10000000001/calendars/work/';
const AUTH = { appleId: 'fake@example.invalid', appPassword: 'unused' };
const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const calendar = (events: readonly (readonly string[])[]): string => crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...events.flatMap(lines => ['BEGIN:VEVENT', 'UID:fake-uid', ...lines, 'END:VEVENT']), 'END:VCALENDAR']);

async function tuples(fake: FakeICloud, startUtc: string, endUtc: string): Promise<string[]> {
    const resources = await fake.queryEvents(AUTH, FAKE_DISCOVERY, { calendarId: CAL, range: { startUtc, endUtc } });
    return resources.flatMap(resource => resource.calendarData.split('BEGIN:VEVENT').slice(1).map(block => {
        const value = (name: string): string => block.split('\n').find(line => line.startsWith(name))?.replace(/^[^:]*:/u, '') ?? '-';
        return `${value('DTSTART')}/${value('DTEND')}/${value('RECURRENCE-ID')}`;
    }));
}

describe('fake expansion (measured shapes)', () => {
    test('unmoved instances: master form for DTSTART/DTEND, UTC-form RECURRENCE-ID (P3B-1 before tuples)', async () => {
        const fake = new FakeICloud([CAL]);
        fake.seed(CAL, `${CAL}tz.ics`, calendar([['DTSTART;TZID=America/New_York:20270406T100000', 'DTEND;TZID=America/New_York:20270406T110000', 'RRULE:FREQ=WEEKLY;COUNT=6']]));
        fake.seed(CAL, `${CAL}date.ics`, calendar([['DTSTART;VALUE=DATE:20270408', 'DTEND;VALUE=DATE:20270409', 'RRULE:FREQ=WEEKLY;COUNT=6']]));
        fake.seed(CAL, `${CAL}float.ics`, calendar([['DTSTART:20270409T090000', 'DTEND:20270409T100000', 'RRULE:FREQ=WEEKLY;COUNT=6']]));
        const all = await tuples(fake, '20270401T000000Z', '20270601T000000Z');
        expect(all.slice(0, 2)).toEqual(['20270406T100000/20270406T110000/20270406T140000Z', '20270413T100000/20270413T110000/20270413T140000Z']);
        expect(all).toContain('20270408/20270409/20270408T000000Z');
        expect(all).toContain('20270409T090000/20270409T100000/20270409T090000Z');
        expect(all).toHaveLength(18);
    });

    test('an overridden instance keeps its stored RECURRENCE-ID form and verbatim times; a moved one needs both windows (P3B-2, Run 5)', async () => {
        const fake = new FakeICloud([CAL]);
        fake.seed(CAL, `${CAL}tz.ics`, calendar([
            ['DTSTART;TZID=America/New_York:20270406T100000', 'DTEND;TZID=America/New_York:20270406T110000', 'RRULE:FREQ=WEEKLY;COUNT=6'],
            ['RECURRENCE-ID;TZID=America/New_York:20270420T100000', 'DTSTART;TZID=America/New_York:20270420T100000', 'DTEND;TZID=America/New_York:20270420T110000', 'SUMMARY:o'],
            ['RECURRENCE-ID;TZID=America/New_York:20270427T100000', 'DTSTART;TZID=America/New_York:20270429T100000', 'DTEND;TZID=America/New_York:20270429T110000', 'SUMMARY:m'],
        ]));
        expect(await tuples(fake, '20270401T000000Z', '20270601T000000Z')).toEqual([
            '20270406T100000/20270406T110000/20270406T140000Z', '20270413T100000/20270413T110000/20270413T140000Z', '20270420T100000/20270420T110000/20270420T100000',
            '20270429T100000/20270429T110000/20270427T100000', '20270504T100000/20270504T110000/20270504T140000Z', '20270511T100000/20270511T110000/20270511T140000Z',
        ]);
        // Only the moved slot's day: the moved instance is not returned (its new time is outside).
        expect(await tuples(fake, '20270427T000000Z', '20270428T000000Z')).toEqual([]);
        const raw = await fake.queryEvents(AUTH, FAKE_DISCOVERY, { calendarId: CAL, range: { startUtc: '20270419T000000Z', endUtc: '20270421T000000Z' } });
        expect(raw[0]?.calendarData).toContain('X-RECURRENCE-EXCEPTION');
        expect(raw[0]?.calendarData).not.toContain('VTIMEZONE');
    });

    test('a UTC RECURRENCE-ID on a TZID master replaces its instance (P3B-6)', async () => {
        const fake = new FakeICloud([CAL]);
        fake.seed(CAL, `${CAL}tz.ics`, calendar([
            ['DTSTART;TZID=America/New_York:20270706T100000', 'DTEND;TZID=America/New_York:20270706T110000', 'RRULE:FREQ=WEEKLY;COUNT=6'],
            ['RECURRENCE-ID:20270720T140000Z', 'DTSTART;TZID=America/New_York:20270720T100000', 'DTEND;TZID=America/New_York:20270720T110000', 'SUMMARY:o'],
        ]));
        expect(await tuples(fake, '20270719T000000Z', '20270721T000000Z')).toEqual(['20270720T100000/20270720T110000/20270720T140000Z']);
    });

    test('DST: the repeated hour resolves to the second 01:30, the skipped hour to 01:30 EST (P3B-4 tuples)', async () => {
        const fake = new FakeICloud([CAL]);
        fake.seed(CAL, `${CAL}rep.ics`, calendar([['DTSTART;TZID=America/New_York:20271031T013000', 'DTEND;TZID=America/New_York:20271031T023000', 'RRULE:FREQ=WEEKLY;COUNT=3']]));
        expect(await tuples(fake, '20271030T000000Z', '20271116T000000Z')).toEqual([
            '20271031T013000/20271031T023000/20271031T053000Z', '20271107T013000/20271107T013000/20271107T063000Z', '20271114T013000/20271114T023000/20271114T063000Z',
        ]);
        const gap = new FakeICloud([CAL]);
        gap.seed(CAL, `${CAL}gap.ics`, calendar([['DTSTART;TZID=America/New_York:20270307T023000', 'DTEND;TZID=America/New_York:20270307T033000', 'RRULE:FREQ=WEEKLY;COUNT=2']]));
        expect(await tuples(gap, '20270306T000000Z', '20270316T000000Z')).toEqual(['20270307T023000/20270307T033000/20270307T073000Z', '20270314T013000/20270314T033000/20270314T063000Z']);
        // An override whose RECURRENCE-ID copies the expanded DTSTART text replaces exactly that instance (P3B-4).
        gap.externalEdit(CAL, `${CAL}gap.ics`, text => text.replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:fake-uid\r\nRECURRENCE-ID;TZID=America/New_York:20270314T013000\r\nDTSTART;TZID=America/New_York:20270314T013000\r\nDTEND;TZID=America/New_York:20270314T033000\r\nSUMMARY:o\r\nEND:VEVENT\r\nEND:VCALENDAR'));
        expect(await tuples(gap, '20270306T000000Z', '20270316T000000Z')).toEqual(['20270307T023000/20270307T033000/20270307T073000Z', '20270314T013000/20270314T033000/20270314T013000']);
    });

    test('UNTIL truncation, EXDATE in each form, orphan overrides hidden (P3C-1, P3B-5, P3C-4)', async () => {
        const fake = new FakeICloud([CAL]);
        fake.seed(CAL, `${CAL}a.ics`, calendar([
            ['DTSTART;TZID=America/New_York:20270223T100000', 'DTEND;TZID=America/New_York:20270223T110000', 'RRULE:FREQ=WEEKLY;UNTIL=20270316T135959Z', 'EXDATE;TZID=America/New_York:20270302T100000'],
            ['RECURRENCE-ID:20270330T140000Z', 'DTSTART:20270330T140000Z', 'DTEND:20270330T150000Z', 'SUMMARY:orphan'],
        ]));
        expect(await tuples(fake, '20270201T000000Z', '20270501T000000Z')).toEqual(['20270223T100000/20270223T110000/20270223T150000Z', '20270309T100000/20270309T110000/20270309T150000Z']);
        const date = new FakeICloud([CAL]);
        date.seed(CAL, `${CAL}d.ics`, calendar([['DTSTART;VALUE=DATE:20270204', 'DTEND;VALUE=DATE:20270205', 'RRULE:FREQ=WEEKLY;UNTIL=20270217', 'EXDATE;VALUE=DATE:20270211']]));
        expect(await tuples(date, '20270201T000000Z', '20270301T000000Z')).toEqual(['20270204/20270205/20270204T000000Z']);
    });

    test('unmodelled rules throw instead of guessing', async () => {
        const fake = new FakeICloud([CAL]);
        fake.seed(CAL, `${CAL}m.ics`, calendar([['DTSTART:20270101T100000Z', 'DTEND:20270101T110000Z', 'RRULE:FREQ=MONTHLY']]));
        expect(tuples(fake, '20270101T000000Z', '20270201T000000Z')).rejects.toThrow('unmodelled');
    });
});
