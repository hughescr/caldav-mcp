import { describe, expect, test } from 'bun:test';
import { parseExpandedResource, parseOriginalResource } from '../src/calendar/ical';
import { normalizeFullEvent, normalizeSlimEvent, sanitizeDisplayText } from '../src/calendar/normalize';
import { buildAttachmentIndex, prescanAttachProperties, toAttachmentMetadata } from '../src/calendar/attachments';
import { matchesQuery, normalizeQuery } from '../src/calendar/search';
import { IcalError } from '../src/calendar/model';
import { listEventsInputSchema } from '../src/calendar/event-schemas';
import { occurrenceIdFromJcal, rangeTransportWindow, toEventTime } from '../src/calendar/time-core';
import times from './fixtures/calendar/time-forms/expected.json';
import provider from './fixtures/calendar/provider-authority/expected.json';
import attachments from './fixtures/calendar/attachments/expected.json';
import parser from './fixtures/calendar/parser/expected.json';

const fixture = (path: string) => Bun.file(new URL(`./fixtures/calendar/${path}`, import.meta.url)).text();
const timeIcs = await fixture('time-forms/expanded.ics');
const attachmentIcs = await fixture('attachments/original.ics');
const context = { calendar: 0, resourceHref: '/10000000001/calendars/work/event.ics', etag: '"v1"', recurring: true };
const normalize = (ics: string) => parseExpandedResource(ics, {}).components.map(component => normalizeSlimEvent(component, context));
const fullContext = { ...context, calendarId: '/10000000001/calendars/work/', view: 'single' as const };

// All fixture expectations are hand-written and synthetic, from probe evidence; no recurrence engine is invoked.
describe('P2 pass-through and provider authority', () => {
    for (let index = 0; index < times.starts.length; index++) {
        test(`preserves card time form/warning ${index} and opaque RID independently`, () => {
            const event = normalize(timeIcs)[index];
            expect<unknown>(event?.start).toEqual(times.starts[index]);
            expect<unknown>(event?.recurrence_id).toBe(times.tokens[index]);
        });
    }
    test('keeps repeated-hour equal endpoint and uses Temporal extra, never iCloud RID as endpoint', () => {
        const event = normalize(timeIcs)[7];
        expect<unknown>(event?.end).toEqual(times.starts[7]);
        expect<unknown>(event?.recurrence_id).toBe('occ1_20271107T063000Z');
    });
    test('cancelled is shown in slim and full output', () => {
        const component = parseExpandedResource(timeIcs, {}).components[9];
        expect<unknown>(component).toBeDefined();
        if (component === undefined) { throw new Error('missing cancelled component'); }
        expect<unknown>(normalizeSlimEvent(component, context).status).toBe('CANCELLED');
        expect<unknown>(normalizeFullEvent(component, { ...fullContext, view: 'occurrence' }).status).toBe('CANCELLED');
    });
    test('iCloud Feb-28 clamping wins without recurrence synthesis', async () => {
        const events = normalize(await fixture('provider-authority/expanded.ics'));
        expect<unknown>(events.map(event => 'date' in event.start ? event.start.date : null)).toEqual(provider.clamped_dates);
        expect<unknown>(events).toHaveLength(3);
    });
    test('equal DATE end is not publicly replaced by next day', async () => {
        const [event] = normalize(await fixture('provider-authority/equal-date.ics'));
        expect<unknown>(event?.start).toEqual(provider.equal_start);
        expect<unknown>(event?.end).toEqual(provider.equal_end);
        expect<unknown>(event?.duration).toBeNull();
    });
    test('RANGE is retained in original but never locally propagates effective text/start', async () => {
        const original = parseOriginalResource(await fixture('provider-authority/range-original.ics'), {});
        expect<unknown>(original.overrides[0]?.recurrenceId?.raw.params.get('range')).toEqual(['THISANDFUTURE']);
        const events = normalize(await fixture('provider-authority/range-expanded.ics'));
        expect<unknown>(events.map(event => 'utc' in event.start ? event.start.utc : null)).toEqual(provider.range_starts);
        expect<unknown>(events.map(event => event.title)).toEqual(provider.range_titles);
    });
    test('occurrence-only original has no invented master', async () => {
        const resource = parseOriginalResource(await fixture('original-get/detached.ics'), {});
        expect<unknown>(resource.kind).toBe('occurrence_only');
        expect<unknown>(resource.master).toBeNull();
        expect<unknown>(resource.overrides).toHaveLength(1);
        const override = resource.overrides[0];
        if (override === undefined) { throw new Error('missing detached override'); }
        expect<unknown>(normalizeFullEvent(override, { ...fullContext, view: 'occurrence' }).start).toEqual({ date: '2026-12-14', all_day: true });
    });
});

describe('P2 structural validation and bounded parsing', () => {
    test('rejects malformed literal resource rather than clamping its date', async () => {
        const bad = await fixture('parser/malformed.ics');
        expect<unknown>(() => parseExpandedResource(bad, {})).toThrow(new IcalError('malformed'));
    });
    const single = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:synthetic\nDTSTART:20270111T100000Z\nDTEND:20270111T110000Z\nSUMMARY:Good\nEND:VEVENT\nEND:VCALENDAR\n';
    const badCases: [string, string, 'malformed' | 'unsupported_recurrence_data' | 'unsupported_recurrence_id'][] = [
        ['duplicate DTSTART', single.replace('SUMMARY:Good', 'DTSTART:20270112T100000Z'), 'malformed'],
        ['duplicate UID', single.replace('SUMMARY:Good', 'UID:other'), 'malformed'],
        ['DTEND plus DURATION', single.replace('SUMMARY:Good', 'DURATION:PT1H'), 'malformed'],
        ['hour 24', single.replace('T100000Z', 'T240000Z'), 'malformed'],
        ['second 60', single.replace('T100000Z', 'T100060Z'), 'malformed'],
        ['retained RRULE', single.replace('SUMMARY:Good', 'RRULE:FREQ=DAILY;COUNT=2'), 'unsupported_recurrence_data'],
        ['retained RDATE', single.replace('SUMMARY:Good', 'RDATE:20270112T100000Z'), 'unsupported_recurrence_data'],
        ['retained EXDATE', single.replace('SUMMARY:Good', 'EXDATE:20270112T100000Z'), 'unsupported_recurrence_data'],
        ['parameterized expanded RID', single.replace('SUMMARY:Good', 'RECURRENCE-ID;TZID=UTC:20270111T100000Z'), 'unsupported_recurrence_id'],
    ];
    for (const [label, input, reason] of badCases) {
        test(`rejects ${label} with fixed resource reason`, () => {
            // ORCHESTRATOR-RULING: a structurally valid but non-server-form expanded RID has its own reason (unsupported_recurrence_id), so it degrades alone; it is never a guessed token.
            expect<unknown>(() => parseExpandedResource(input, {})).toThrow(new IcalError(reason));
        });
    }
    test('duplicate expanded tokens are malformed even when moved starts differ', () => {
        const component = 'BEGIN:VEVENT\nUID:synthetic\nDTSTART:20270111T100000Z\nDTEND:20270111T110000Z\nRECURRENCE-ID:20270111T100000Z\nEND:VEVENT\n';
        expect<unknown>(() => parseExpandedResource(`BEGIN:VCALENDAR\nVERSION:2.0\n${component}${component.replaceAll('DTSTART:20270111', 'DTSTART:20270112')}END:VCALENDAR\n`, {})).toThrow(new IcalError('malformed'));
    });
    test('rejects multiple original masters rather than selecting first', () => {
        const component = single.slice(single.indexOf('BEGIN:VEVENT'), single.indexOf('END:VCALENDAR'));
        expect<unknown>(() => parseOriginalResource(single.replace('END:VCALENDAR', `${component}END:VCALENDAR`), {})).toThrow(new IcalError('malformed'));
    });
    test('positive source interval in a gap is not rejected because enrichment reverses its UTC extras', () => {
        // OD3/OD8: pass through source times; a surprising best-effort UTC order is not a structural error.
        const ics = single.replace('DTSTART:20270111T100000Z', 'DTSTART;TZID=America/New_York:20270314T023000').replace('DTEND:20270111T110000Z', 'DTEND;TZID=America/New_York:20270314T030000');
        const [event] = normalize(ics);
        expect<unknown>(event?.start).toEqual({ local: '2027-03-14T02:30:00', zone: 'America/New_York', utc: '2027-03-14T07:30:00Z', offset: '-04:00', timezone_warning: 'utc_uncertain_dst_transition' });
        expect<unknown>(event?.end).toEqual({ local: '2027-03-14T03:00:00', zone: 'America/New_York', utc: '2027-03-14T07:00:00Z', offset: '-04:00' });
    });
    test('resource byte cap is checked before parsing', () => {
        expect<unknown>(() => parseExpandedResource(`${single}${' '.repeat(2 * 1024 * 1024)}`, {})).toThrow(new IcalError('resource_too_large'));
    });
    test('hostile SECONDLY VTIMEZONE is ignored in a killable child within 2 seconds', () => {
        // T0-DECISION: real child-process timeout (not fake timers) is necessary to kill a synchronous hostile parser.
        const module = new URL('../src/calendar/ical.ts', import.meta.url).href;
        const normalizeModule = new URL('../src/calendar/normalize.ts', import.meta.url).href;
        const file = new URL('./fixtures/calendar/parser/hostile.ics', import.meta.url).pathname;
        const code = `import {parseExpandedResource} from ${JSON.stringify(module)}; import {normalizeSlimEvent} from ${JSON.stringify(normalizeModule)}; const r=parseExpandedResource(await Bun.file(${JSON.stringify(file)}).text(),{}); process.stdout.write(JSON.stringify({count:r.vtimezoneCount,start:normalizeSlimEvent(r.components[0],${JSON.stringify(context)}).start}));`;
        const child = Bun.spawnSync([process.execPath, '--eval', code], { timeout: parser.wall_clock_bound_ms, stdout: 'pipe', stderr: 'pipe' });
        expect<unknown>(child.stderr.toString()).toBe('');
        expect<unknown>(child.exitCode).toBe(0);
        expect<unknown>(JSON.parse(child.stdout.toString())).toEqual({ count: parser.vtimezone_count, start: parser.hostile_start });
    });
});

describe('P2 attachment identity and metadata', () => {
    const index = (ics = attachmentIcs, accountId = 'synthetic-account', href = context.resourceHref) => buildAttachmentIndex({ accountId, calendarId: fullContext.calendarId, href, resource: parseOriginalResource(ics, {}), prescan: prescanAttachProperties(ics) });
    test('pre-scan preserves duplicate structural parameters before last-wins jCal', () => {
        const scanned = prescanAttachProperties(attachmentIcs);
        expect<unknown>(scanned[4]?.parameters.get('encoding')).toEqual(attachments.duplicate_encoding);
    });
    test('enumerates resource-wide VEVENT attachments, excludes VALARM, assigns duplicate ordinals', () => {
        const entries = index();
        expect<unknown>(entries).toHaveLength(attachments.total);
        expect<unknown>(entries.map(entry => entry.descriptor.form)).toEqual(attachments.forms);
        expect<unknown>(entries.map(entry => entry.descriptor.ordinal)).toEqual(attachments.ordinals);
        expect<unknown>(entries.map(entry => entry.descriptor.structurallySupported)).toEqual(attachments.supported_structure);
        expect<unknown>(new Set(entries.map(entry => entry.ref)).size).toBe(6);
        expect<unknown>(entries[1]?.descriptor.fingerprint).toBe(entries[2]?.descriptor.fingerprint);
    });
    test('R1 metadata contains neither URLs nor base64 and managed fields match measured forms', () => {
        const metadata = index().map(entry => toAttachmentMetadata(entry));
        expect<unknown>(metadata[0]).toEqual({ attachment_ref: expect.stringMatching(/^a1_[A-Za-z0-9_-]{43}$/u), ...attachments.managed_metadata });
        expect<unknown>(metadata[3]?.declared_size).toBeNull();
        expect<unknown>(metadata[5]?.component_recurrence_id).toEqual(attachments.override_display);
        expect<unknown>(metadata.every(item => item.download_supported === false)).toBe(true);
        const serialized = JSON.stringify(metadata);
        for (const secret of ['https:', 'SGk=', 'synthetic-managed', 'alarm-only']) { expect<unknown>(serialized).not.toContain(secret); }
    });
    test('refs bind account/href, remain stable under unrelated display changes and raw RID alone keys component', () => {
        const original = index();
        expect<unknown>(index(attachmentIcs.replace('SUMMARY:Attachment metadata', 'SUMMARY:Changed prose')).map(entry => entry.ref)).toEqual(original.map(entry => entry.ref));
        expect<unknown>(index(attachmentIcs, 'other-account').map(entry => entry.ref)).not.toEqual(original.map(entry => entry.ref));
        expect<unknown>(index(attachmentIcs, 'synthetic-account', '/10000000001/calendars/work/other.ics').map(entry => entry.ref)).not.toEqual(original.map(entry => entry.ref));
        const reordered = attachmentIcs.replace('FILENAME=probe.txt;FMTTYPE=text/plain;MANAGED-ID=synthetic-managed;SIZE=32', 'SIZE=32;MANAGED-ID=synthetic-managed;FMTTYPE=text/plain;FILENAME=probe.txt');
        expect<unknown>(index(reordered).map(entry => entry.ref)).toEqual(original.map(entry => entry.ref));
        // Equal resolved instant is NOT equal identity: raw UTC RID differs from the raw TZID tuple.
        const utcRid = attachmentIcs.replace('RECURRENCE-ID;TZID=America/New_York:20270112T050000', 'RECURRENCE-ID:20270112T100000Z');
        expect<unknown>(index(utcRid).slice(0, 5).map(entry => entry.ref)).toEqual(original.slice(0, 5).map(entry => entry.ref));
        expect<unknown>(index(utcRid)[5]?.ref).not.toBe(original[5]?.ref);
    });
    for (const replacement of ['ENCODING=BASE64;VALUE=BINARY;VALUE=BINARY', 'ENCODING=BASE64;FMTTYPE=text/plain;FMTTYPE=text/html', 'ENCODING=BASE64;ENCODING=8BIT']) {
        test(`duplicate/conflicting ATTACH ${replacement} keeps event and disables attachment`, () => {
            const mutated = attachmentIcs.replace('ENCODING=BASE64;ENCODING=BASE64', replacement);
            expect<unknown>(index(mutated)[4]?.descriptor.structurallySupported).toBe(false);
        });
    }
    test('noncanonical base64 is metadata-only, not a resource error', () => {
        const entries = index(attachmentIcs.replaceAll(':SGk=', ':SGk==='));
        expect<unknown>(entries[1]?.descriptor.structurallySupported).toBe(false);
        expect<unknown>(entries[1]?.descriptor.form).toBe('inline');
    });
});

describe('P2 display and literal text search', () => {
    test('sanitizes display controls only, keeps empty text and never splits a surrogate', () => {
        expect<unknown>(sanitizeDisplayText('A\u0000‮B\r\nשלום😀', 10)).toEqual({ text: 'A��B\nשלום', sanitized: true, truncated: true });
        expect<unknown>(sanitizeDisplayText('', 10)).toEqual({ text: '', sanitized: false, truncated: false });
    });
    test('query trims/NFC/lowercases and treats regex metacharacters literally', () => {
        expect<unknown>(normalizeQuery('  CAFÉ  ')).toBe('café');
        expect<unknown>(matchesQuery({ title: 'CAFÉ [a.*]', description: null, location: null }, 'café', ['title'])).toBe(true);
        expect<unknown>(matchesQuery({ title: 'abc', description: null, location: null }, 'a.*', ['title'])).toBe(false);
        expect<unknown>(matchesQuery({ title: '[a.*]', description: null, location: null }, 'a.*', ['title'])).toBe(true);
    });
    test('OR search uses full text before slim truncation and selected fields only', () => {
        const text = { title: 'x'.repeat(300) + ' needle', description: 'somewhere', location: null };
        expect<unknown>(matchesQuery(text, 'needle', ['title'])).toBe(true);
        expect<unknown>(matchesQuery(text, 'needle', ['description', 'location'])).toBe(false);
        expect<unknown>(matchesQuery(text, 'somewhere', ['title', 'description'])).toBe(true);
    });
});

describe('P0 regression anchors and Run5 required correction with hand-written expectations', () => {
    test('missing timezone has one fixed error, leap-second and hour-24 never enter a REPORT', () => {
        for (const start of ['2027-01-11T00:00:00', '2027-01-11T00:00:60Z', '2027-01-11T24:00:00Z']) {
            const parsed = listEventsInputSchema.safeParse({ range: { start, end: '2027-01-12T00:00:00Z' } });
            expect<unknown>(parsed.success).toBe(false);
            if (!parsed.success) { expect<unknown>(parsed.error.issues.every(issue => issue.message === 'Invalid calendar, event, occurrence, attachment or range arguments. A timezone is required for client-supplied times: use an explicit offset or Z.')).toBe(true); }
        }
    });
    test('Run5 offset/civil union pads31days and rounds fractions outward', () => {
        expect<unknown>(rangeTransportWindow({ start: '2027-01-11T00:00:00.1+05:30', end: '2027-01-12T00:00:00.1+05:30' })).toEqual({ startUtc: '20261210T183000Z', endUtc: '20270212T000001Z' });
        expect<unknown>(occurrenceIdFromJcal('2026-12-11T00:00:00Z', false)).toBe('occ1_20261211T000000Z');
        expect<unknown>(occurrenceIdFromJcal('2026-12-11T00:00:00Z', true)).toBeNull();
    });
    test('OD10 Windows zone is passed through as unrecognized without UTC or offset', () => {
        expect<unknown>(toEventTime({ kind: 'zoned', local: '2027-03-14T09:00:00', tzid: 'Eastern Standard Time' })).toEqual(times.starts[5]);
    });
    test('pure time subset is independent of Pacific/Honolulu process TZ', () => {
        const module = new URL('../src/calendar/time-core.ts', import.meta.url).href;
        const code = `import {toEventTime,occurrenceIdFromJcal} from ${JSON.stringify(module)};process.stdout.write(JSON.stringify([toEventTime({kind:'zoned',local:'2027-03-14T09:00:00',tzid:'America/New_York'}),occurrenceIdFromJcal('2026-12-11T00:00:00Z',false)]));`;
        const child = Bun.spawnSync([process.execPath, '--eval', code], { env: { ...process.env, TZ: 'Pacific/Honolulu' }, timeout: 2000, stdout: 'pipe', stderr: 'pipe' });
        expect<unknown>(child.stderr.toString()).toBe('');
        expect<unknown>(child.exitCode).toBe(0);
        expect<unknown>(JSON.parse(child.stdout.toString())).toEqual([times.starts[2], 'occ1_20261211T000000Z']);
    });
});
