import { describe, expect, test } from 'bun:test';
import { parseExpandedResource, parseOriginalResource } from '../src/calendar/ical';
import { normalizeFullEvent, normalizeSlimEvent, sanitizeDisplayText } from '../src/calendar/normalize';
import { buildAttachmentIndex, prescanAttachProperties, toAttachmentMetadata } from '../src/calendar/attachments';
import { createReadBudget } from '../src/calendar/budget';
import { BudgetError, IcalError } from '../src/calendar/model';
import { attendeeSchema, fullEventSchema, slimEventSchema } from '../src/calendar/event-schemas';
import { MAX_UNFOLDED_LINE_BYTES } from '../src/calendar/limits';

// Supplementary P2 behaviour beyond the T0 contract cases: error discard, structure, display and attachment edge cases.

const wrap = (...components: string[]): string => `BEGIN:VCALENDAR\nVERSION:2.0\n${components.join('')}END:VCALENDAR\n`;
const event = (...lines: string[]): string => `BEGIN:VEVENT\nUID:u1\nDTSTART:20270111T100000Z\nDTEND:20270111T110000Z\n${lines.map(line => `${line}\n`).join('')}END:VEVENT\n`;
const slimContext = { calendar: 2, resourceHref: '/1/calendars/c/e.ics', etag: '"e"', recurring: false };
const fullContext = { ...slimContext, calendarId: '/1/calendars/c/', view: 'single' as const };

function reasonOf(action: () => unknown): string | null {
    try { action(); } catch (error) { return error instanceof IcalError ? error.reason : `other:${String(error)}`; }
    return null;
}

describe('typed errors never carry parser text', () => {
    const SECRET = 'TOP-SECRET-LINE-CONTENT';
    for (const [label, input] of [
        ['garbage line', `BEGIN:VCALENDAR\n${SECRET}\nEND:VCALENDAR\n`],
        ['unterminated component', `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:${SECRET}\n`],
        ['empty input', ''],
        ['two calendars', `${wrap(event())}${wrap(event())}`],
    ] as const) {
        test(`${label} yields a bare malformed error without a cause`, () => {
            try {
                parseExpandedResource(input, {});
                throw new Error('should have thrown');
            } catch (error) {
                expect<unknown>(error).toBeInstanceOf(IcalError);
                expect<unknown>((error as IcalError).message).toBe('malformed');
                expect<unknown>((error as IcalError).cause).toBeUndefined();
                expect<unknown>(String((error as IcalError).stack)).not.toContain(SECRET);
            }
        });
    }
});

test('an expanded RID outside server form is distinct from retained recurrence rules', () => {
    // ORCHESTRATOR-RULING: iCloud emits VALUE=DATE recurrence ids in expanded data (measured)
    // Probe Run 7: an overridden instance of a TZID series carries its RECURRENCE-ID in the stored TZID form.
    for (const rid of ['RECURRENCE-ID;VALUE=DATE:20270111', 'RECURRENCE-ID:20270111T100000', 'RECURRENCE-ID;TZID=America/New_York:20270111T100000']) {
        expect(reasonOf(() => parseExpandedResource(wrap(event(rid)), {}))).toBeNull();
    }
    for (const rid of ['RECURRENCE-ID;TZID=America/New_York;X-FOO=1:20270111T100000', 'RECURRENCE-ID;VALUE=DATE;X-FOO=1:20270111', 'RECURRENCE-ID;VALUE=DATE;TZID=America/New_York:20270111']) {
        expect(reasonOf(() => parseExpandedResource(wrap(event(rid)), {}))).toBe('unsupported_recurrence_id');
    }
    expect(reasonOf(() => parseExpandedResource(wrap(event('RECURRENCE-ID;VALUE=DATE:20270230')), {}))).toBe('malformed');
    expect(reasonOf(() => parseExpandedResource(wrap(event('RECURRENCE-ID:20270111T240000')), {}))).toBe('malformed');
    expect(reasonOf(() => parseExpandedResource(wrap(event('RRULE:FREQ=DAILY')), {}))).toBe('unsupported_recurrence_data');
});

describe('structure', () => {
    test('requires VERSION 2.0 exactly once when VERSION is present', () => {
        // ORCHESTRATOR-RULING: iCloud's expanded REPORT omits VERSION and PRODID (measured)
        expect<unknown>(reasonOf(() => parseExpandedResource('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u\nDTSTART:20270111T100000Z\nEND:VEVENT\nEND:VCALENDAR\n', {}))).toBeNull();
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(event()).replace('VERSION:2.0', 'VERSION:1.0'), {}))).toBe('malformed');
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(event()).replace('VERSION:2.0', 'VERSION:2.0\nVERSION:2.0'), {}))).toBe('malformed');
    });
    test('a resource without any VEVENT is malformed, not an empty success', () => {
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(), {}))).toBe('malformed');
    });
    test('multiple UIDs, nested VEVENT and a missing UID or DTSTART are malformed', () => {
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(event(), event().replace('UID:u1', 'UID:u2')), {}))).toBe('malformed');
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap('BEGIN:VEVENT\nUID:u\nDTSTART:20270111T100000Z\nBEGIN:VEVENT\nUID:u\nDTSTART:20270111T100000Z\nEND:VEVENT\nEND:VEVENT\n'), {}))).toBe('malformed');
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap('BEGIN:VEVENT\nDTSTART:20270111T100000Z\nEND:VEVENT\n'), {}))).toBe('malformed');
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap('BEGIN:VEVENT\nUID:u\nEND:VEVENT\n'), {}))).toBe('malformed');
    });
    test('DATE and timed values may not be mixed, and a negative same-zone interval is malformed', () => {
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(event().replace('DTSTART:20270111T100000Z', 'DTSTART;VALUE=DATE:20270111')), {}))).toBe('malformed');
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(event().replace('DTEND:20270111T110000Z', 'DTEND:20270111T090000Z')), {}))).toBe('malformed');
    });
    test('counts and ignores VTIMEZONE and VALARM, keeps unknown and extension properties', () => {
        const tz = 'BEGIN:VTIMEZONE\nTZID:X\nBEGIN:STANDARD\nDTSTART:19000101T000000\nRRULE:FREQ=SECONDLY\nEND:STANDARD\nEND:VTIMEZONE\n';
        const alarm = 'BEGIN:VALARM\nACTION:AUDIO\nTRIGGER:-PT5M\nEND:VALARM\nBEGIN:VALARM\nACTION:AUDIO\nTRIGGER:-PT10M\nEND:VALARM\n';
        const resource = parseExpandedResource(wrap(tz, tz, event('X-APPLE-A:1', 'X-B;P=1:2', 'CATEGORIES:a').replace('END:VEVENT\n', `${alarm}END:VEVENT\n`)), {});
        expect<unknown>(resource.vtimezoneCount).toBe(2);
        const [component] = resource.components;
        expect<unknown>(component?.alarmCount).toBe(2);
        expect<unknown>(component?.extensionPropertyCount).toBe(2);
        expect<unknown>(component?.properties.has('categories')).toBe(true);
        expect<unknown>(component?.properties.has('trigger')).toBe(false);
    });
    test('untrusted parameter names stay data in a Map', () => {
        const [component] = parseExpandedResource(wrap(event('X-A;CONSTRUCTOR=2;TOSTRING=3;HASOWNPROPERTY=4:v', 'TOSTRING:5', 'HASOWNPROPERTY:6')), {}).components;
        const property = component?.properties.get('x-a')?.[0];
        expect<unknown>([property?.params.get('constructor'), property?.params.get('tostring'), property?.params.get('hasownproperty')]).toEqual([['2'], ['3'], ['4']]);
        expect<unknown>(property?.params.get('valueof')).toBeUndefined();
        expect<unknown>(component?.properties.get('tostring')?.[0]?.values).toEqual(['5']);
        expect<unknown>(component?.properties.get('valueof')).toBeUndefined();
    });
    test('property names that make ical.js return no value type are malformed, not a crash', () => {
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(event('__PROTO__:5')), {}))).toBe('malformed');
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(event('CONSTRUCTOR:6')), {}))).toBe('malformed');
    });
    test('too many parameters on one property is malformed', () => {
        const parameters = Array.from({ length: 40 }, (_unused, index) => `P${index}=1`).join(';');
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(event(`X-A;${parameters}:v`)), {}))).toBe('malformed');
    });
    test('literal invalid zone and DURATION text is carried or rejected, never repaired', () => {
        expect<unknown>(reasonOf(() => parseExpandedResource(wrap(event().replace('DTEND:20270111T110000Z', 'DURATION:P1Y')), {}))).toBe('malformed');
        const [component] = parseExpandedResource(wrap(event().replace('DTEND:20270111T110000Z', 'DURATION:PT90M')), {}).components;
        expect<unknown>(component?.end).toBeNull();
        expect<unknown>(component && normalizeSlimEvent(component, slimContext).duration).toBe('PT90M');
    });
});

describe('lexical preflight', () => {
    test('counts duplicate parameter occurrences before jCal collapses them', () => {
        for (const name of ['ATTACH', 'X-A']) {
            expect(reasonOf(() => parseOriginalResource(wrap(event(`${name}${';X=a'.repeat(33)}:https://example.invalid/a`)), {}))).toBe('malformed');
        }
        expect(prescanAttachProperties(wrap(event('ATTACH;X=a;X=b:https://example.invalid/a')))[0]?.parameters.get('x')).toEqual(['a', 'b']);
    });
    test('shares folded-line and parameter limits with the attachment pre-scan', () => {
        const parameters = ';X="a;b:c"'.repeat(32);
        const folded = parameters.replaceAll(';X=', '\r\n ;X=');
        expect(reasonOf(() => parseOriginalResource(wrap(event(`ATTACH${folded}:https://example.invalid/a`)), {}))).toBeNull();
        for (const parameter of ['MEMBER', 'DELEGATED-TO', 'DELEGATED-FROM']) {
            expect(reasonOf(() => parseOriginalResource(wrap(event(`ATTENDEE;${parameter}="mailto:a@example.invalid","mailto:b@example.invalid":mailto:c@example.invalid`)), {}))).toBeNull();
        }
        expect(reasonOf(() => prescanAttachProperties(wrap(event(`ATTACH${folded};X=z:https://example.invalid/a`))))).toBe('malformed');
        const line = `ATTACH:${'a'.repeat(MAX_UNFOLDED_LINE_BYTES - 7)}`;
        expect(prescanAttachProperties(wrap(event(line)))[0]?.valueText.length).toBe(MAX_UNFOLDED_LINE_BYTES - 7);
        expect(reasonOf(() => prescanAttachProperties(wrap(event(`${line}\r\n x`))))).toBe('resource_too_large');
        expect(reasonOf(() => prescanAttachProperties(wrap(event(`ATTACH:${'界'.repeat(Math.ceil(MAX_UNFOLDED_LINE_BYTES / 3))}`))))).toBe('resource_too_large');
    });
    test('charges properties inside ignored components before handing off to jCal', () => {
        let lines = 0;
        let properties = 0;
        const text = wrap('BEGIN:VTIMEZONE\nTZID:X\nX-IGNORED:value\nEND:VTIMEZONE\n', event());
        parseOriginalResource(text, { work: { chargeLines(count) { lines += count; }, chargeProperties(count) { properties += count; } } });
        expect(lines).toBe(text.split('\n').length);
        expect(properties).toBe(6);
    });
    test('caps actual component nesting even inside ignored VTIMEZONE', () => {
        expect(reasonOf(() => parseOriginalResource(wrap(`BEGIN:VTIMEZONE\n${'BEGIN:X-A\n'.repeat(8)}${'END:X-A\n'.repeat(8)}END:VTIMEZONE\n`, event()), {}))).toBe('malformed');
    });
    test('near-cap duplicate ATTACH payload is rejected within a killable two-second bound', () => {
        // A real process deadline is required to kill synchronous parser work.
        const module = new URL('../src/calendar/ical.ts', import.meta.url).pathname;
        const code = `import { parseOriginalResource } from ${JSON.stringify(module)};
            const text = 'BEGIN:VCALENDAR\\nVERSION:2.0\\nBEGIN:VEVENT\\nUID:u\\nDTSTART:20270111T100000Z\\nATTACH' + ';X=a'.repeat(400000) + ':https://example.invalid/a\\nEND:VEVENT\\nEND:VCALENDAR\\n';
            try { parseOriginalResource(text, {}); process.exit(2); } catch (e) { if (e.message !== 'malformed') process.exit(3); }`;
        const started = performance.now();
        const child = Bun.spawnSync([process.execPath, '--eval', code], { timeout: 2000, stdout: 'pipe', stderr: 'pipe' });
        expect(child.exitCode).toBe(0);
        expect(performance.now() - started).toBeLessThan(2000);
    });
    test('ambiguous parameter syntax cannot hide duplicate parameters from the preflight', () => {
        for (const prefix of [';X=a,"', ';X="a","', ';X:https://example.invalid/a']) {
            const module = new URL('../src/calendar/ical.ts', import.meta.url).pathname;
            const code = `import { parseOriginalResource } from ${JSON.stringify(module)};
                const text = 'BEGIN:VCALENDAR\\nVERSION:2.0\\nBEGIN:VEVENT\\nUID:u\\nDTSTART:20270111T100000Z\\nATTACH' + ${JSON.stringify(prefix)} + ';X=a'.repeat(400000) + '":https://example.invalid/a\\nEND:VEVENT\\nEND:VCALENDAR\\n';
                try { parseOriginalResource(text, {}); process.exit(2); } catch (e) { if (e.message !== 'malformed') process.exit(3); }`;
            const child = Bun.spawnSync([process.execPath, '--eval', code], { timeout: 2000, stdout: 'pipe', stderr: 'pipe' });
            expect(child.exitCode).toBe(0);
        }
    });
    test('rejects raw time literals that ical.js would repair', () => {
        for (const name of ['DTSTART', 'DTEND', 'RECURRENCE-ID', 'DUE', 'DTSTAMP', 'CREATED', 'COMPLETED', 'LAST-MODIFIED']) {
            for (const suffix of [':20270111X100000Z', ';VALUE=DATE:20270111garbage', ':20270111T100000+0100', ':20270111T240000Z', ':20270111T106000Z', ':20270111T100060Z', ';VALUE=DATE:20270111T100000Z', ';VALUE=DATE-TIME:20270111']) {
                const text = wrap(event().replace(/^DTSTART:.*\n|^DTEND:.*\n/gmu, '')).replace('UID:u1\n', `UID:u1\n${name}${suffix}\n${name === 'DTSTART' ? '' : 'DTSTART:20270111T100000Z\n'}`);
                for (const parse of [parseOriginalResource, parseExpandedResource]) { expect(reasonOf(() => parse(text, {}))).toBe('malformed'); }
            }
        }
    });
});

describe('work budget', () => {
    test('charges lines and properties and propagates BudgetError untouched', () => {
        const budget = createReadBudget();
        const work = budget.newResourceWork();
        parseExpandedResource(wrap(event('SUMMARY:x')), { work });
        const tooManyLines = wrap(event(...Array.from({ length: 50_001 }, (_unused, index) => `X-N${index % 10}:v`)));
        let caught: unknown;
        try { parseExpandedResource(tooManyLines, { work: budget.newResourceWork() }); } catch (error) { caught = error; }
        expect<unknown>(caught).toBeInstanceOf(BudgetError);
        expect<unknown>((caught as BudgetError).kind).toBe('work');
    });
    test('a default budget still caps lines per resource when none is injected', () => {
        const tooManyLines = wrap(event(...Array.from({ length: 50_001 }, () => 'X-N:v')));
        expect<unknown>(() => parseExpandedResource(tooManyLines, {})).toThrow(BudgetError);
    });
});

describe('original resources', () => {
    const master = (extra = ''): string => `BEGIN:VEVENT\nUID:u1\nDTSTART:20270111T100000Z\nDTEND:20270111T110000Z\n${extra}END:VEVENT\n`;
    const override = (rid: string, extra = ''): string => `BEGIN:VEVENT\nUID:u1\n${rid}\nDTSTART:20270112T120000Z\nDTEND:20270112T130000Z\n${extra}END:VEVENT\n`;
    test('classifies single, series and occurrence-only resources', () => {
        expect<unknown>(parseOriginalResource(wrap(master()), {}).kind).toBe('single');
        expect<unknown>(parseOriginalResource(wrap(master('RRULE:FREQ=DAILY\n')), {}).kind).toBe('series');
        expect<unknown>(parseOriginalResource(wrap(master(), override('RECURRENCE-ID:20270112T100000Z')), {}).kind).toBe('series');
        const detached = parseOriginalResource(wrap(override('RECURRENCE-ID:20270112T100000Z')), {});
        expect<unknown>([detached.kind, detached.master]).toEqual(['occurrence_only', null]);
        expect<unknown>(reasonOf(() => parseOriginalResource(wrap(), {}))).toBe('malformed');
    });
    test('keeps RRULE, EXDATE and RDATE on an original master and the token of a plain override', () => {
        const resource = parseOriginalResource(wrap(master('RRULE:FREQ=DAILY\nEXDATE:20270113T100000Z\n'), override('RECURRENCE-ID:20270112T100000Z')), {});
        expect<unknown>(resource.master?.retainsRecurrenceRules).toBe(true);
        expect<unknown>(resource.overrides[0]?.recurrenceId?.token).toBe('occ1_20270112T100000Z');
    });
    test('rejects two overrides with the same raw RID tuple and mixed UIDs', () => {
        expect<unknown>(reasonOf(() => parseOriginalResource(wrap(master(), override('RECURRENCE-ID:20270112T100000Z'), override('RECURRENCE-ID:20270112T100000Z')), {}))).toBe('malformed');
        expect<unknown>(reasonOf(() => parseOriginalResource(wrap(master(), override('RECURRENCE-ID:20270112T100000Z').replace('UID:u1', 'UID:u2')), {}))).toBe('malformed');
    });
    test('equal instants with different raw RID tuples are distinct overrides', () => {
        const resource = parseOriginalResource(wrap(master(), override('RECURRENCE-ID;TZID=UTC:20270112T100000Z'), override('RECURRENCE-ID:20270112T100000Z')), {});
        expect<unknown>(resource.overrides).toHaveLength(2);
        expect<unknown>(resource.overrides.map(component => component.recurrenceId?.token)).toEqual([null, 'occ1_20270112T100000Z']);
    });
    test('an invalid RID literal is malformed', () => {
        expect<unknown>(reasonOf(() => parseOriginalResource(wrap(master(), override('RECURRENCE-ID:20270230T100000Z')), {}))).toBe('malformed');
    });
});

describe('slim and full normalization', () => {
    test('fills pass-through fields and omits CONFIRMED and OPAQUE', () => {
        const [component] = parseExpandedResource(wrap(event('SUMMARY:Lunch\\, today', 'LOCATION:Cafe', 'DESCRIPTION:Line1\\nLine2', 'STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'ATTENDEE;CN=A:mailto:a@x.test', 'ATTENDEE:mailto:b@x.test')), {}).components;
        if (component === undefined) { throw new Error('missing'); }
        const slim = normalizeSlimEvent(component, slimContext);
        expect<unknown>(slim).toEqual({
            calendar: 2, resource_href: '/1/calendars/c/e.ics', recurrence_id: null, expected_version: '"e"', recurring: false,
            start: { utc: '2027-01-11T10:00:00Z' }, end: { utc: '2027-01-11T11:00:00Z' }, duration: null,
            title: 'Lunch, today', location: 'Cafe', description: 'Line1\nLine2', attendees_count: 2,
        });
        expect<unknown>(slimEventSchema.safeParse(slim).success).toBe(true);
    });
    test('tentative and transparent are shown; unknown enum values are absent', () => {
        const [tentative] = parseExpandedResource(wrap(event('STATUS:TENTATIVE', 'TRANSP:TRANSPARENT')), {}).components;
        const [odd] = parseExpandedResource(wrap(event('STATUS:X-ODD')), {}).components;
        if (tentative === undefined || odd === undefined) { throw new Error('missing'); }
        expect<unknown>(normalizeSlimEvent(tentative, slimContext)).toMatchObject({ status: 'TENTATIVE', transparency: 'TRANSPARENT' });
        expect<unknown>('status' in normalizeSlimEvent(odd, slimContext)).toBe(false);
    });
    test('truncates and flags slim prose with its own flags and a shared sanitized flag', () => {
        const [component] = parseExpandedResource(wrap(event(`SUMMARY:${'t'.repeat(300)}`, `DESCRIPTION:${'d'.repeat(281)}`, 'LOCATION:a\u0001b')), {}).components;
        if (component === undefined) { throw new Error('missing'); }
        const slim = normalizeSlimEvent(component, slimContext);
        expect<unknown>([slim.title?.length, slim.description?.length, slim.location]).toEqual([256, 280, 'a�b']);
        expect<unknown>([slim.title_truncated, slim.description_truncated, slim.location_truncated, slim.sanitized]).toEqual([true, true, undefined, true]);
        expect<unknown>(slimEventSchema.safeParse(slim).success).toBe(true);
    });
    test('full event adds identity, organizer, attendees capped at 100 and omitted counts', () => {
        const attendees = Array.from({ length: 101 }, (_unused, index) => `ATTENDEE;CN=N${index};ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:n${index}@x.test`);
        const [component] = parseExpandedResource(wrap(event('ORGANIZER;CN=Boss;ROLE=ODD:mailto:boss@x.test', 'X-A:1', ...attendees).replace('END:VEVENT\n', 'BEGIN:VALARM\nACTION:AUDIO\nTRIGGER:-PT5M\nEND:VALARM\nEND:VEVENT\n')), {}).components;
        if (component === undefined) { throw new Error('missing'); }
        const full = normalizeFullEvent(component, { ...fullContext, view: 'series_master' });
        expect<unknown>(full.uid).toBe('u1');
        expect<unknown>(full.view).toBe('series_master');
        expect<unknown>(full.end_exclusive).toBe(true);
        expect<unknown>(full.organizer).toEqual({ address: 'mailto:boss@x.test', name: 'Boss', role: null, participation: null });
        expect<unknown>(full.attendees).toHaveLength(100);
        expect<unknown>(full.attendees[0]).toEqual({ address: 'mailto:n0@x.test', name: 'N0', role: 'OPT-PARTICIPANT', participation: 'ACCEPTED' });
        expect<unknown>(full.attendees_truncated).toBe(true);
        expect<unknown>(full.attendees_count).toBe(101);
        expect<unknown>(full.omitted).toEqual({ alarms: 1, extension_properties: 1 });
        expect<unknown>(fullEventSchema.safeParse(full).success).toBe(true);
        expect<unknown>(attendeeSchema.safeParse(full.organizer).success).toBe(true);
    });
    test('a UID the output cannot carry makes only the full view unreadable', () => {
        const [component] = parseExpandedResource(wrap(event().replace('UID:u1', `UID:${'u'.repeat(1025)}`)), {}).components;
        if (component === undefined) { throw new Error('missing'); }
        expect<unknown>(normalizeSlimEvent(component, slimContext).title).toBeNull();
        expect<unknown>(reasonOf(() => normalizeFullEvent(component, fullContext))).toBe('malformed');
    });
});

describe('display sanitizer edge cases', () => {
    test('normalizes lone CR and CRLF, replaces lone surrogates and keeps TAB, LF and RLM', () => {
        expect<unknown>(sanitizeDisplayText('a\rb\r\nc\td\n‏e', 100)).toEqual({ text: 'a\nb\nc\td\n‏e', sanitized: false, truncated: false });
        expect<unknown>(sanitizeDisplayText('x\uD800y\uDC00z', 100)).toEqual({ text: 'x�y�z', sanitized: true, truncated: false });
        expect<unknown>(sanitizeDisplayText('\u007F⁦‮', 100)).toEqual({ text: '���', sanitized: true, truncated: false });
    });
    test('never splits a surrogate pair at the limit and does not report cut-off replacements', () => {
        expect<unknown>(sanitizeDisplayText('ab😀', 3)).toEqual({ text: 'ab', sanitized: false, truncated: true });
        expect<unknown>(sanitizeDisplayText('ab😀', 4)).toEqual({ text: 'ab😀', sanitized: false, truncated: false });
        expect<unknown>(sanitizeDisplayText('ab\u0000', 2)).toEqual({ text: 'ab', sanitized: false, truncated: true });
        expect<unknown>(sanitizeDisplayText('abc', 0)).toEqual({ text: '', sanitized: false, truncated: true });
    });
});

describe('attachment edge cases', () => {
    const resourceHref = '/1/calendars/c/e.ics';
    const index = (ics: string) => buildAttachmentIndex({ accountId: 'acct', calendarId: '/1/calendars/c/', href: resourceHref, resource: parseOriginalResource(ics, {}), prescan: prescanAttachProperties(ics) });
    const withAttach = (...lines: string[]): string => wrap(event(...lines));

    test('pre-scan unfolds lines, decodes parameters and only sees direct VEVENT attachments', () => {
        const ics = wrap(event('ATTACH;FILENAME="a, b;c.txt";X-NOTE=^n^\'^^:https://a.test/x', 'ATTACH;VALUE=BINARY;ENCODING=BASE64:SG', ' k=', 'BEGIN:VALARM', 'ATTACH:https://alarm.test/', 'END:VALARM'));
        const scans = prescanAttachProperties(ics);
        expect<unknown>(scans).toHaveLength(2);
        expect<unknown>(scans[0]?.parameters.get('filename')).toEqual(['a, b;c.txt']);
        expect<unknown>(scans[0]?.parameters.get('x-note')).toEqual(['\n"^']);
        expect<unknown>(scans[0]?.valueText).toBe('https://a.test/x');
        expect<unknown>(scans[1]?.valueText).toBe('SGk=');
        expect<unknown>(scans.map(scan => scan.componentIndex)).toEqual([0, 0]);
    });
    test('component index counts VEVENTs in source order', () => {
        const ics = wrap(event('ATTACH:https://a.test/1'), event('ATTACH:https://a.test/2').replace('UID:u1', 'UID:u1').replace('DTSTART:', 'RECURRENCE-ID:20270111T100000Z\nDTSTART:'));
        expect<unknown>(prescanAttachProperties(ics).map(scan => scan.componentIndex)).toEqual([0, 1]);
    });
    test('SIZE must be a canonical safe integer and FILENAME falls back to X-APPLE-FILENAME', () => {
        const entries = index(withAttach(
            'ATTACH;SIZE=0;FILENAME=a.txt:https://a.test/0', 'ATTACH;SIZE=-1:https://a.test/1', 'ATTACH;SIZE=1.5:https://a.test/2',
            'ATTACH;SIZE=99999999999999999999:https://a.test/3', 'ATTACH;X-APPLE-FILENAME=b.txt:https://a.test/4', 'ATTACH;FILENAME=a;FILENAME=b:https://a.test/5',
        ));
        expect<unknown>(entries.map(entry => entry.descriptor.declaredSize)).toEqual([0, null, null, null, null, null]);
        expect<unknown>(entries.map(entry => entry.descriptor.filename)).toEqual(['a.txt', null, null, null, 'b.txt', null]);
    });
    test('MANAGED-ID makes a URI managed, an empty one does not, and inline beats MANAGED-ID as unsupported', () => {
        const entries = index(withAttach('ATTACH;MANAGED-ID=m1:https://a.test/m', 'ATTACH;MANAGED-ID=:https://a.test/e', 'ATTACH;MANAGED-ID=m2;VALUE=BINARY;ENCODING=BASE64:SGk=', 'ATTACH;MANAGED-ID=a;MANAGED-ID=b:https://a.test/d'));
        expect<unknown>(entries.map(entry => [entry.descriptor.form, entry.descriptor.structurallySupported])).toEqual([['managed', true], ['external_url', false], ['inline', false], ['external_url', false]]);
        expect<unknown>(entries[0]?.descriptor.managedId).toBe('m1');
        expect<unknown>(entries[2]?.descriptor.managedId).toBeNull();
    });
    test('inline base64 must be canonical, with zero trailing bits', () => {
        const entries = index(withAttach('ATTACH;VALUE=BINARY;ENCODING=BASE64:SGk=', 'ATTACH;VALUE=BINARY;ENCODING=BASE64:SGl=', 'ATTACH;VALUE=BINARY;ENCODING=BASE64:SGk', 'ATTACH;VALUE=BINARY;ENCODING=BASE64:', 'ATTACH;VALUE=BINARY;ENCODING=BASE64:QQ==', 'ATTACH;VALUE=BINARY;ENCODING=BASE64:QR=='));
        expect<unknown>(entries.map(entry => entry.descriptor.structurallySupported)).toEqual([true, false, false, true, true, false]);
        expect<unknown>(entries.every(entry => entry.descriptor.uri === null)).toBe(true);
    });
    test('metadata sanitizes and flags display text without exposing the URI', () => {
        const [entry] = index(withAttach(`ATTACH;FILENAME=x\u0001${'n'.repeat(300)}.txt;FMTTYPE=text/plain:https://secret.test/path?token=1`));
        if (entry === undefined) { throw new Error('missing'); }
        const metadata = toAttachmentMetadata(entry, true);
        expect<unknown>(metadata.filename).toHaveLength(255);
        expect<unknown>(metadata.filename?.startsWith('x�nnn')).toBe(true);
        expect<unknown>([metadata.sanitized, metadata.truncated, metadata.download_supported]).toEqual([true, true, true]);
        expect<unknown>(JSON.stringify(metadata)).not.toContain('secret.test');
    });
    test('identity ignores parameter order and case but not parameter values', () => {
        const a = index(withAttach('ATTACH;FMTTYPE=text/plain;FILENAME=a.txt:https://a.test/x'));
        const b = index(withAttach('ATTACH;filename=a.txt;fmttype=text/plain:https://a.test/x'));
        const c = index(withAttach('ATTACH;FMTTYPE=text/plain;FILENAME=b.txt:https://a.test/x'));
        expect<unknown>(a[0]?.ref).toBe(b[0]?.ref);
        expect<unknown>(a[0]?.ref).not.toBe(c[0]?.ref);
    });
    test('a disagreeing pre-scan is malformed rather than silently misattributed', () => {
        const ics = withAttach('ATTACH:https://a.test/x');
        expect<unknown>(reasonOf(() => buildAttachmentIndex({ accountId: 'acct', calendarId: '/1/calendars/c/', href: resourceHref, resource: parseOriginalResource(ics, {}), prescan: [] }))).toBe('malformed');
    });
});
