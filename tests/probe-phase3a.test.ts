/**
 * Phase 3a checks of probe 0.6.0 (design §8.1), against the fake iCloud: the outcome for the
 * behaviour probe-evidence.md measured (ICLOUD_MEASURED) or the fake's labelled guess, and at
 * least one divergent server for each.
 */
import { describe, expect, test } from 'bun:test';
import { TEXT_VALUES, foldOctets, unescapeText } from '../scripts/probe/checks/write-3a';
import type { ProbeReport } from '../scripts/probe/types';
import { FAKE_NOW, ICLOUD_MEASURED, PLAIN, seedCalendar, standardAccount, utc, type FakeBehaviour, type FakeICloud } from './fixtures/probe/fake-icloud';
import { READ_ONLY, WRITE, check, probe } from './fixtures/probe/harness';

const creds = { appleId: PLAIN.appleId, appPassword: PLAIN.appPassword };
const DAY = 86_400_000;

async function run(behaviour: Partial<FakeBehaviour> = {}, setup?: (fake: FakeICloud) => void): Promise<{ fake: FakeICloud; report: ProbeReport }> {
    const fake = standardAccount(PLAIN, behaviour);
    setup?.(fake);
    return { fake, report: await probe(fake, WRITE, creds) };
}

const putsTo = (fake: FakeICloud, suffix: string) => fake.requests.filter((r) => r.method === 'PUT' && r.url.pathname.endsWith(`-${suffix}.ics`));

describe('write-unknown-zone (P3A-1)', () => {
    test('the fake’s guess (kept as sent) refutes, and records each disposition', async () => {
        const { report } = await run(ICLOUD_MEASURED);
        const result = check(report, 'write-unknown-zone');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence).toMatchObject({ accepted: 3, refused: 0, windowsDisposition: 'kept-tzid', aliasDisposition: 'kept-tzid', unknownDisposition: 'kept-tzid', windowsVtimezoneForSentTzid: true, windowsEtagHeaderEqualsStored: true });
    });

    test('a server that refuses unknown zones confirms, with the refusal recorded', async () => {
        const { report } = await run({ ...ICLOUD_MEASURED, unknownTzidPut: 'refuse' });
        const result = check(report, 'write-unknown-zone');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ refused: 3, windowsPutStatus: 400, windowsPreconditions: ['valid-calendar-object-resource'] });
    });

    test('a server that stores unknown zones floating refutes with the floating disposition', async () => {
        const { report } = await run({ ...ICLOUD_MEASURED, unknownTzidPut: 'floating' });
        expect(check(report, 'write-unknown-zone').evidence).toMatchObject({ windowsDisposition: 'floating', unknownDisposition: 'floating', windowsVtimezoneForSentTzid: false });
    });
});

describe('write-iana-zones (P3A-2)', () => {
    test('measured behaviour (a VTIMEZONE is added, the ETag header matches) confirms', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        expect(check(report, 'write-iana-zones').outcome).toBe('confirmed');
        expect(putsTo(fake, 'p3a2lordhowe')[0]?.body).toContain('DTSTART;TZID=Australia/Lord_Howe:');
        expect(putsTo(fake, 'p3a2lordhowe')[0]?.body).not.toContain('BEGIN:VTIMEZONE');
    });

    test('a server that adds no VTIMEZONE, or sends no ETag on 201, refutes', async () => {
        const noZone = await run({ ...ICLOUD_MEASURED, addsVtimezone: false });
        expect(check(noZone.report, 'write-iana-zones')).toMatchObject({ outcome: 'refuted', evidence: { kolkataVtimezoneForSentTzid: false, kolkataDisposition: 'kept-tzid' } });
        const noEtag = await run({ ...ICLOUD_MEASURED, putReturnsEtag: false });
        expect(check(noEtag.report, 'write-iana-zones')).toMatchObject({ outcome: 'refuted', evidence: { kolkataEtagHeaderEqualsStored: null } });
    });
});

describe('write-zone-change (P3A-3)', () => {
    test('a span-edited update keeps untouched lines, bumps SEQUENCE and confirms', async () => {
        const { report, fake } = await run(ICLOUD_MEASURED);
        const result = check(report, 'write-zone-change');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ newYorkVtimezoneBefore: true, berlinTzidKept: true, localDigitsKept: true, newYorkVtimezoneAfter: true, berlinVtimezoneAfter: true, sequenceAfter: 1 });
        const [create, update] = putsTo(fake, 'p3a3zone');
        expect(update?.headers.get('if-match')).not.toBeNull();
        expect(update?.body).toContain('DTSTART;TZID=Europe/Berlin:');
        expect(update?.body).toContain('SEQUENCE:1');
        // The VTIMEZONE iCloud added is sent back unchanged.
        expect(update?.body).toContain('BEGIN:VTIMEZONE\r\nTZID:America/New_York');
        expect(create?.body).not.toContain('BEGIN:VTIMEZONE');
    });

    test('a refused update refutes', async () => {
        const { report } = await run({ ...ICLOUD_MEASURED, hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-p3a3zone.ics') && req.headers.has('if-match') ? new Response(null, { status: 412 }) : undefined) });
        expect(check(report, 'write-zone-change')).toMatchObject({ outcome: 'refuted', evidence: { updatePutStatus: 412 } });
    });
});

describe('write-text-roundtrip (P3A-4)', () => {
    test('the sent body really folds inside UTF-8 sequences, and the helpers are exact', () => {
        const folded = foldOctets(`DESCRIPTION:${TEXT_VALUES.DESCRIPTION}`);
        expect(folded.insideUtf8).toBeGreaterThan(0);
        expect(Buffer.byteLength(TEXT_VALUES.DESCRIPTION)).toBeGreaterThanOrEqual(8192);
        expect(unescapeText('a\\, b\\; c\\\\ d\\n e\\N')).toBe('a, b; c\\ d\n e\n');
        expect(TEXT_VALUES.SUMMARY.startsWith('caldav-mcp probe ')).toBe(true);
    });

    test('a server that unfolds as octets and keeps the text confirms', async () => {
        const { report } = await run();
        const result = check(report, 'write-text-roundtrip');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ summaryDecodedEqual: true, locationDecodedEqual: true, descriptionDecodedEqual: true, descriptionFoldedAsSent: false, receivedDescriptionContinuationLines: 0 });
        expect(result.evidence.sentFoldsInsideUtf8).toBeGreaterThan(0);
    });

    test('a server that re-folds at character boundaries still confirms and records the re-fold', async () => {
        const { report } = await run({ foldOnGet: true });
        const result = check(report, 'write-text-roundtrip');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ receivedPhysicalLinesOver75Octets: 0, receivedFoldsInsideUtf8: 0 });
        expect(result.evidence.receivedDescriptionContinuationLines).toBeGreaterThan(100);
    });

    test('a server that changes the escaping refutes', async () => {
        const { report } = await run({
            transformResponse: async (req, res) => (req.method === 'GET' && req.url.pathname.endsWith('-p3a4text.ics') ? new Response((await res.text()).replaceAll('\\,', ','), { status: res.status, headers: res.headers }) : res),
        });
        expect(check(report, 'write-text-roundtrip')).toMatchObject({ outcome: 'confirmed' });
        const lost = await run({
            transformResponse: async (req, res) => (req.method === 'GET' && req.url.pathname.endsWith('-p3a4text.ics') ? new Response((await res.text()).replaceAll('\\n', ' '), { status: res.status, headers: res.headers }) : res),
        });
        expect(check(lost.report, 'write-text-roundtrip')).toMatchObject({ outcome: 'refuted', evidence: { summaryDecodedEqual: false } });
    });
});

describe('write-error-bodies (P3A-5)', () => {
    test('empty and DAV:error bodies confirm; the invalid PUT is recorded', async () => {
        const { report } = await run({ ...ICLOUD_MEASURED, endBeforeStart: 'refuse' });
        const result = check(report, 'write-error-bodies');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ invalidPutStatus: 400, invalidAccepted: false });
        expect(result.evidence.refusals).toBeGreaterThan(3);
        expect(result.evidence.refusalPreconditions).toContain('valid-calendar-object-resource');
        expect(result.evidence).toMatchObject({ refusalRootElements: ['error'] });
    });

    test('an HTML refusal body refutes', async () => {
        const { report } = await run({ hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-p3a5invalid.ics') ? new Response('<html><body>nope</body></html>', { status: 400, headers: { 'content-type': 'text/html' } }) : undefined) });
        const result = check(report, 'write-error-bodies');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence.refusalContentTypes).toMatchObject({ html: 1 });
    });
});

describe('write-default-alarms (P3A-6)', () => {
    test('no alarm added confirms; a server-added VALARM refutes', async () => {
        expect(check((await run()).report, 'write-default-alarms').outcome).toBe('confirmed');
        const added = await run({
            transformResponse: async (req, res) => (req.method === 'GET' && req.url.pathname.endsWith('-p3a6alarm.ics')
                ? new Response((await res.text()).replace('END:VEVENT', 'X-APPLE-DEFAULT-ALARM:TRUE\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT'), { status: 200, headers: res.headers })
                : res),
        });
        expect(check(added.report, 'write-default-alarms')).toMatchObject({ outcome: 'refuted', evidence: { valarms: 1, defaultAlarmProperty: true } });
    });
});

describe('write-end-order (P3A-7)', () => {
    test('the fake’s guess (every end accepted) refutes; a server that refuses ends before starts confirms', async () => {
        const accepting = check((await run()).report, 'write-end-order');
        expect(accepting).toMatchObject({ outcome: 'refuted', evidence: { equalPutStatus: 201, sameZoneBeforePutStatus: 201, instantBeforePutStatus: 201, endInstantBeforeStartInCrossCase: true, asClaimed: 1 } });
        const refusing = check((await run({ endBeforeStart: 'refuse' })).report, 'write-end-order');
        expect(refusing).toMatchObject({ outcome: 'confirmed', evidence: { equalPutStatus: 201, sameZoneBeforePutStatus: 400, instantBeforePutStatus: 400 } });
    });
});

describe('write-delete-semantics (P3A-8)', () => {
    test('204 then 404 confirms; a 412 on the repeat refutes', async () => {
        expect(check((await run()).report, 'write-delete-semantics')).toMatchObject({ outcome: 'confirmed', evidence: { firstDeleteStatus: 204, secondDeleteStatus: 404 } });
        let deletes = 0;
        const { report } = await run({ hook: (req) => (req.method === 'DELETE' && req.url.pathname.endsWith('-p3a8delete.ics') && ++deletes === 2 ? new Response(null, { status: 412 }) : undefined) });
        expect(check(report, 'write-delete-semantics')).toMatchObject({ outcome: 'refuted', evidence: { secondDeleteStatus: 412 } });
    });
});

describe('write-rrule-create (P3A-9)', () => {
    test('measured expansion confirms the four counts; the nonsense rule’s disposition follows the server', async () => {
        const refused = check((await run(ICLOUD_MEASURED)).report, 'write-rrule-create');
        expect(refused).toMatchObject({
            outcome: 'confirmed',
            evidence: { tzidWeeklyBydayCount: 6, tzidUntilUtcCount: 4, dateMonthlyUntilCount: 4, floatingDailyIntervalCount: 5, nonsensePutStatus: 400, nonsenseDisposition: 'refused' },
        });
        expect(check((await run({ ...ICLOUD_MEASURED, weeklyByMonthDay: 'no-instances' })).report, 'write-rrule-create').evidence).toMatchObject({ nonsenseDisposition: 'stored-no-instances' });
        expect(check((await run({ ...ICLOUD_MEASURED, weeklyByMonthDay: 'ignored' })).report, 'write-rrule-create').evidence).toMatchObject({ nonsenseDisposition: 'stored-many-instances' });
    });

    test('a server that does not expand is inconclusive, and a wrong count refutes', async () => {
        expect(check((await run()).report, 'write-rrule-create').outcome).toBe('inconclusive');
        // RFC 5545 skips months without the day; a server that clamped monthly DATE rules would give another count.
        const { report } = await run({ ...ICLOUD_MEASURED, hook: (req) => (req.method === 'PUT' && req.url.pathname.endsWith('-p3a9fltdaily.ics') ? new Response(null, { status: 403 }) : undefined) });
        expect(check(report, 'write-rrule-create')).toMatchObject({ outcome: 'refuted', evidence: { floatingDailyIntervalPutStatus: 403 } });
    });
});

describe('every phase 3 event stays in the temporary calendar and --cleanup can remove it', () => {
    test('measured run with undeletable calendars: at most 100 probe events, all recognised by --cleanup', async () => {
        const { fake, report } = await run({ ...ICLOUD_MEASURED, deleteCollection: 'fails' });
        expect(report.cleanup?.allRemoved).toBe(false);
        const writes = fake.requests.filter((r) => ['PUT', 'DELETE', 'POST', 'MKCALENDAR'].includes(r.method));
        expect(writes.every((r) => /\/caldav-mcp-probe-[0-9a-f]{8}\//.test(r.url.pathname))).toBe(true);
        const left = [...fake.calendars.values()].filter((c) => c.id.startsWith('caldav-mcp-probe-'));
        expect(Math.max(...left.map((c) => c.events.size))).toBeGreaterThan(50);
        expect(Math.max(...left.map((c) => c.events.size))).toBeLessThanOrEqual(100);
        fake.behaviour.deleteCollection = 'works';
        const cleaned = await probe(fake, { write: false, invite: false, cleanup: true }, creds, { confirmCleanup: async () => true });
        expect(check(cleaned, 'cleanup-leftovers').evidence).toMatchObject({ found: 2, candidates: 2, removalVerified: 2 });
        expect([...fake.calendars.keys()].filter((id) => id.startsWith('caldav-mcp-probe-'))).toEqual([]);
    });
});

describe('census-recurrence-shapes (P3A-10, read-only)', () => {
    const lines = (...l: string[]): string => `${['BEGIN:VCALENDAR', 'VERSION:2.0', ...l, 'END:VCALENDAR'].join('\r\n')}\r\n`;

    test('counts shapes from the strictness census without a request of its own', async () => {
        const plain = standardAccount();
        await probe(plain, READ_ONLY, creds);
        const fake = standardAccount();
        const report = await probe(fake, READ_ONLY, creds);
        expect(fake.requests.length).toBe(plain.requests.length);
        const result = check(report, 'census-recurrence-shapes');
        expect(result.outcome).toBe('confirmed');
        expect(result.evidence).toMatchObject({ recurringMasters: 1, rruleEndCount: 1, mastersWithoutSequence: 6, formMismatches: 0 });
    });

    test('an override in another form than its master, a comma EXDATE list and RELATED-TO are counted, and refute', async () => {
        const fake = standardAccount();
        const at = utc(FAKE_NOW + 3 * DAY);
        seedCalendar(fake, {
            id: 'odd', displayName: 'Odd', events: [{
                name: 'odd.ics',
                ical: lines(
                    'BEGIN:VEVENT', 'UID:odd', `DTSTAMP:${at}`, `DTSTART:${at}`, `DTEND:${at}`, 'RRULE:FREQ=DAILY;UNTIL=20270101', 'SEQUENCE:2', 'SUMMARY:Odd',
                    'EXDATE:20261116T120000Z,20261117T120000Z', 'RELATED-TO;RELTYPE=X-CALENDARSERVER-RECURRENCE-SET:abc', 'END:VEVENT',
                    'BEGIN:VEVENT', 'UID:odd', `DTSTAMP:${at}`, 'RECURRENCE-ID;TZID=America/New_York:20261115T070000', 'DTSTART;TZID=America/New_York:20261115T080000', 'DTEND;TZID=America/New_York:20261115T090000', 'SUMMARY:Odd', 'END:VEVENT',
                ),
            }],
        });
        const result = check(await probe(fake, READ_ONLY, creds), 'census-recurrence-shapes');
        expect(result.outcome).toBe('refuted');
        expect(result.evidence).toMatchObject({
            'overrideRid:utc>tzid': 1, 'exdate:utc>utc': 2, exdateCommaLists: 1, rruleEndUntilDate: 1, relatedToRecurrenceSet: 1, recurringMastersWithSequence: 1, overridesMovedOrReformed: 1, formMismatches: 1,
        });
    });
});
