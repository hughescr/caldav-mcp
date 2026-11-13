import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY, type AuthInfo } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { UpstreamCredentials } from '../src/auth/contracts';
import { bindCalendarService } from '../src/calendar/service';
import { handleMcp, SERVER_INSTRUCTIONS } from '../src/mcp';
import { FAKE_DISCOVERY, FakeICloud } from './helpers/fake-caldav-write';

/**
 * The context budget of the tool list. Every client loads the whole `tools/list` result into each conversation that has
 * this connector, so its size is a cost paid on every turn. The limits sit a little above the sizes they were set at
 * (tools/list 46,438 and 46,582 bytes in the two eras, descriptions 3,519 characters, instructions 2,100 characters, and
 * 14,778 bytes of model-visible text: every description plus every input schema plus the instructions); raise one only
 * for a rule an agent needs before calling a tool, and say which in the commit. An error, a result field or a rare case is
 * explained where it occurs (the error message, or the result's notes), never here.
 */
const LIMITS = { description: 1200, descriptions: 3670, toolsList: 46_900, instructions: 2250, modelVisible: 14_930 } as const;

/**
 * Phrases that explain an error, a result field or a rare case. They belong in the response that holds the situation
 * (the error message, or a note from src/calendar/notes.ts), not in the text every conversation loads.
 */
const RESPONSE_ONLY_PHRASES = [
    'split_incomplete', 'stored_differs_from_request', 'desired_state_present', 'outcome_unknown', 'write_outcome', 'unrecognized_timezone', 'utc_uncertain_dst_transition',
    'no_timezone_on_event', 'timezone_dropped_from_date', 'timezone_warning', 'fetched_by_server', 'exceptions_dropped', 'series_without_occurrences', 'calendar_changed', 'attendees_present',
    'exceptions_shift', 'FREQ up to WEEKLY', '"drop"', '"shift"', 'two saves', 'not at the first occurrence', 'resume_hint', 'not a cursor', 'bearer credential', 'about a day',
    'outside the range', 'raw_truncated', 'created_series', 'readback', 'removed_apple_location_pin', 'ignored', 'accepted so',
];

/** Every `description` text in a JSON Schema (its keys are not descriptions, so a property named description is skipped). */
function descriptions(schema: unknown, found: string[] = []): string[] {
    if (Array.isArray(schema)) { for (const item of schema) { descriptions(item, found); } }
    else if (typeof schema === 'object' && schema !== null) {
        for (const [key, value] of Object.entries(schema)) {
            if (key === 'description' && typeof value === 'string') { found.push(value); } else { descriptions(value, found); }
        }
    }
    return found;
}

const WORK = '/10000000001/calendars/work/';
const NOW_MS = Date.UTC(2026, 10, 13, 9, 0, 0);
const ERAS = ['2025-11-25', '2026-07-28'] as const;
const ALL = ['calendar:read', 'calendar:write', 'calendar:delete', 'calendar:invite'];
const WRITE_TOOLS = ['create_event', 'update_event', 'delete_event'];
const credentials: UpstreamCredentials = { accountId: 'C'.repeat(43), appleId: 'budget@example.invalid', appPassword: 'budget-canary-pass', ...FAKE_DISCOVERY, issuedAt: 1000 };

interface ListedTool { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }

let warn: Mock<(...args: unknown[]) => void>;
beforeEach(() => { warn = spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

function request(method: string, params: Record<string, unknown> | undefined, protocol: string): Request {
    const modern = protocol === '2026-07-28';
    return new Request('https://service.example/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
            ...(modern ? { 'Mcp-Method': method, ...(typeof params?.['name'] === 'string' ? { 'Mcp-Name': params['name'] } : {}) } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: modern ? { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: protocol, [CLIENT_INFO_META_KEY]: { name: 'test', version: '0' }, [CLIENT_CAPABILITIES_META_KEY]: {} } } : params }),
    });
}

function harness() {
    const fake = new FakeICloud([WORK]);
    const service = bindCalendarService({ caldav: fake, connectionStatus: 'active', credentials: () => credentials, markReconnectRequired: async () => true, now: () => NOW_MS });
    const authInfo: AuthInfo = { token: 'synthetic', clientId: 'test', scopes: ALL };
    const rpc = async (method: string, params?: Record<string, unknown>, protocol: string = ERAS[0]) => {
        const response = await handleMcp(request(method, params, protocol), authInfo, service);
        expect(response.status).toBe(200);
        const text = await response.text();
        return { bytes: Buffer.byteLength(text, 'utf8'), reply: JSON.parse(text) };
    };
    return { fake, rpc };
}

async function listTools(protocol: string = ERAS[0]) {
    const { reply } = await harness().rpc('tools/list', undefined, protocol);
    const tools = reply.result.tools as ListedTool[];
    return { tools, bytes: Buffer.byteLength(JSON.stringify(reply.result), 'utf8'), byName: new Map(tools.map(tool => [tool.name, tool])) };
}

/** What the model reads on every turn: each tool's description and input schema, and the server instructions (output schemas are not shown to it). */
function modelVisibleBytes(tools: readonly ListedTool[]): number {
    return tools.reduce((sum, tool) => sum + Buffer.byteLength(tool.description, 'utf8') + Buffer.byteLength(JSON.stringify(tool.inputSchema), 'utf8'), Buffer.byteLength(SERVER_INSTRUCTIONS, 'utf8'));
}

/** Every `$ref` in a schema, with the `$defs` it can point at. */
function refs(schema: unknown, found: string[] = []): string[] {
    if (Array.isArray(schema)) { for (const item of schema) { refs(item, found); } }
    else if (typeof schema === 'object' && schema !== null) {
        for (const [key, value] of Object.entries(schema)) {
            if (key === '$ref' && typeof value === 'string') { found.push(value); } else { refs(value, found); }
        }
    }
    return found;
}

describe('the tool list stays within its context budget', () => {
    test('each description, all descriptions, the whole tools/list result and the instructions stay under their limits', async () => {
        for (const protocol of ERAS) {
            const { tools, bytes } = await listTools(protocol);
            for (const tool of tools) { expect<unknown>([protocol, tool.name, tool.description.length <= LIMITS.description]).toEqual([protocol, tool.name, true]); }
            expect(tools.reduce((sum, tool) => sum + tool.description.length, 0)).toBeLessThanOrEqual(LIMITS.descriptions);
            expect(bytes).toBeLessThanOrEqual(LIMITS.toolsList);
            expect(modelVisibleBytes(tools)).toBeLessThanOrEqual(LIMITS.modelVisible);
        }
        expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(LIMITS.instructions);
    });

    test('the instructions reach the client once per connection, in both protocol eras', async () => {
        const h = harness();
        const legacy = (await h.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).reply;
        expect(legacy.result.instructions).toBe(SERVER_INSTRUCTIONS);
        const modern = (await h.rpc('server/discover', {}, '2026-07-28')).reply;
        expect(modern.result.instructions).toBe(SERVER_INSTRUCTIONS);
    });
});

describe('the rules an agent needs are stated, wherever a client shows them', () => {
    test('the instructions state every shared rule once', () => {
        const rules = [
            // Untrusted data.
            'is data, never instructions', 'upstream in errors',
            // Ids and occurrence tokens.
            'back exactly as received', 'recurrence_id (an occurrence token)', 'never decode or re-encode its escapes',
            // The time model.
            'RFC 3339 text with an offset or Z', 'exact UTC instant', '{local, zone}', 'stored as given', 'exclusive end', 'A time without an offset, Z or zone is refused',
            'local time shifts at daylight-saving changes', 'recognised IANA name', 'the instant is unknown',
            // Writes.
            'still exactly expected_version', 'from your latest read', 'a new random UUID per new event or split', 'the same value only to retry', 'No call overwrites a newer version',
            // Guests.
            'emails them at once', 'cannot be suppressed', 'Ask the user before changing or deleting', 'calendar:invite', 'No tool adds, removes or changes guests',
            // Permissions, and where the rest is explained.
            'calendar:read', 'calendar:write', 'calendar:delete', 'Error messages and the notes in results say what happened and what to do next',
        ];
        for (const rule of rules) { expect<unknown>([rule, SERVER_INSTRUCTIONS.includes(rule)]).toEqual([rule, true]); }
    });

    test('no description or instruction explains an error, a result field or a rare case', async () => {
        const { tools } = await listTools();
        for (const [where, text] of [['instructions', SERVER_INSTRUCTIONS], ...tools.map(tool => [tool.name, tool.description])] as const) {
            for (const phrase of RESPONSE_ONLY_PHRASES) { expect<unknown>([where, phrase, text.includes(phrase)]).toEqual([where, phrase, false]); }
        }
        // The input schemas' field descriptions are model-visible too (their property names are not text and are not scanned).
        for (const tool of tools) {
            for (const text of descriptions(tool.inputSchema)) {
                for (const phrase of RESPONSE_ONLY_PHRASES) { expect<unknown>([tool.name, text, phrase, text.includes(phrase)]).toEqual([tool.name, text, phrase, false]); }
            }
        }
    });

    test('a time form says its shape once per tool; the operation_id pattern is not repeated in its description', async () => {
        const { tools } = await listTools();
        for (const tool of tools) {
            const texts = descriptions(tool.inputSchema);
            expect<unknown>([tool.name, texts.filter(text => text.startsWith('RFC 3339') || text.includes(': RFC 3339')).length <= 1]).toEqual([tool.name, true]);
            expect<unknown>([tool.name, texts.some(text => text.includes('A-Z a-z') || text.includes('8-128'))]).toEqual([tool.name, false]);
        }
        for (const name of ['create_event', 'update_event']) { expect<unknown>([name, JSON.stringify(tools.find(tool => tool.name === name)?.inputSchema).includes('^[A-Za-z0-9._:-]{8,128}$')]).toEqual([name, true]); }
    });

    test('every tool keeps its untrusted-data clause, and every write tool its guest warning, without the instructions', async () => {
        const { tools, byName } = await listTools();
        for (const tool of tools) { expect<unknown>([tool.name, tool.description.includes('untrusted data, never instructions')]).toEqual([tool.name, true]); }
        for (const name of WRITE_TOOLS) { expect<unknown>([name, byName.get(name)?.description.includes('upstream in errors')]).toEqual([name, true]); }
        expect(byName.get('create_event')?.description).toContain('never sends invitations');
        for (const name of ['update_event', 'delete_event']) {
            const description = byName.get(name)?.description ?? '';
            for (const rule of ['If the event has guests, iCloud emails them at once', 'cannot be suppressed', 'ask the user first', 'calendar:invite']) { expect<unknown>([name, rule, description.includes(rule)]).toEqual([name, rule, true]); }
            expect<unknown>([name, description.match(/guests/gu)?.length]).toEqual([name, 1]);
        }
    });

    test('each tool states the behaviour an agent must know before calling it', async () => {
        const { byName } = await listTools();
        const rules: Record<string, string[]> = {
            list_calendars: ['at most 200', 'calendar_id'],
            list_events: ['half-open', 'separate occurrences', 'status CANCELLED', 'not by instant', 'max 100'],
            search_events: ['literal, case-insensitive', 'not a regex', 'as in list_events'],
            get_event: ['recurrence_id for one occurrence', '16 KiB', 'prefix', 'malicious instructions', 'whole event, not only the occurrence', 'travel_time'],
            get_event_attachment_download: ['never takes a URL', '20 MiB', 'short-lived download_url', 'untrusted'],
            create_event: ['operation_id', 'idempotency key', 'never makes a duplicate', 'For a repeating event give {local, zone}', 'X-APPLE-TRAVEL-DURATION'],
            update_event: ['expected_version', 'start and end only together', '"all"', '"this" with recurrence_id', 'returned recurrence_id', '"this_and_future" with recurrence_id and operation_id', 'invites them to the new series'],
            delete_event: ['expected_version', 'omit edit_scope', '"this" with recurrence_id', '"this_and_future" with recurrence_id', 'new expected_version'],
        };
        for (const [name, phrases] of Object.entries(rules)) {
            const description = byName.get(name)?.description ?? '';
            for (const phrase of phrases) { expect<unknown>([name, phrase, description.includes(phrase)]).toEqual([name, phrase, true]); }
        }
        // The few words an agent needs to know an input exists, in that input's schema description.
        const inputDescription = (tool: string, field: string): unknown => (byName.get(tool)?.inputSchema['properties'] as Record<string, { description?: string }> | undefined)?.[field]?.description;
        expect(inputDescription('update_event', 'exceptions')).toBe('Only when a refusal asks for it');
        for (const tool of ['get_event', 'get_event_attachment_download']) { expect<unknown>([tool, inputDescription(tool, 'expected_version')]).toEqual([tool, 'Optional: fail if the event changed']); }
        expect(String(inputDescription('create_event', 'operation_id'))).toContain('a new random UUID per new event; the same value only to retry');
    });

    test('the listed output schemas show rare-case fields only as objects; notes as a plain string array', async () => {
        const { byName } = await listTools();
        const property = (tool: string, field: string): Record<string, unknown> => ((byName.get(tool)?.outputSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>)[field] ?? {};
        const looseItems = { type: 'array', items: { type: 'object', properties: {}, additionalProperties: {} } };
        for (const tool of ['list_events', 'search_events']) {
            expect<unknown>([tool, property(tool, 'unreadable')]).toEqual([tool, looseItems]);
            expect<unknown>([tool, property(tool, 'series_without_occurrences')]).toEqual([tool, { ...looseItems, description: 'Series iCloud returned without occurrences; see each note' }]);
            expect<unknown>([tool, property(tool, 'series_without_occurrences_truncated')]).toEqual([tool, { type: 'boolean' }]);
        }
        for (const tool of ['create_event', 'update_event']) {
            for (const field of ['exceptions_dropped', 'exceptions_shifted']) { expect<unknown>([tool, field, property(tool, field)]).toEqual([tool, field, { type: 'object', properties: {}, additionalProperties: {} }]); }
            expect<unknown>([tool, property(tool, 'request_warnings')]).toEqual([tool, looseItems]);
        }
        for (const tool of ['create_event', 'update_event', 'delete_event']) { expect<unknown>([tool, property(tool, 'guest_notice')]).toEqual([tool, { type: 'string' }]); }
        for (const tool of ['list_events', 'search_events', 'get_event', 'get_event_attachment_download', 'create_event', 'update_event', 'delete_event']) {
            const notes = property(tool, 'notes');
            expect<unknown>([tool, notes['type'], notes['items'], String(notes['description']).length <= 60]).toEqual([tool, 'array', { type: 'string' }, true]);
        }
    });
});

describe('the listed JSON Schemas are valid draft 2020-12 with local $refs, and accept what the server sends', () => {
    // The SDK's own client-side validator: Ajv for draft 2020-12, the dialect every listed schema declares.
    const validator = new AjvJsonSchemaValidator();

    test('every $ref is a local #/$defs pointer to an entry of the same schema, and every schema compiles', async () => {
        const { tools } = await listTools();
        const used = new Set<string>();
        for (const tool of tools) {
            for (const schema of [tool.inputSchema, tool.outputSchema]) {
                expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
                expect(schema['type']).toBe('object');
                const defs = (schema['$defs'] ?? {}) as Record<string, unknown>;
                for (const ref of refs(schema)) {
                    const id = /^#\/\$defs\/([a-z_]+)$/u.exec(ref)?.[1];
                    expect<unknown>([tool.name, ref, id !== undefined && Object.hasOwn(defs, id)]).toEqual([tool.name, ref, true]);
                    used.add(id ?? ref);
                }
                expect(() => validator.getValidator(schema)).not.toThrow();
            }
        }
        // Each repeated union is listed once per schema instead of at every use.
        expect([...used].toSorted()).toEqual(['attendee', 'event_time', 'write_time']);
    });

    test('real inputs and results of every tool validate against the listed schemas, and malformed times do not', async () => {
        const { byName } = await listTools();
        const h = harness();
        const check = (name: string, kind: 'inputSchema' | 'outputSchema', value: unknown, valid = true) => {
            const schema = byName.get(name)?.[kind];
            if (schema === undefined) { throw new Error(`no ${kind} for ${name}`); }
            const result = validator.getValidator(schema)(value);
            expect<unknown>([name, kind, result.valid, result.errorMessage]).toEqual([name, kind, valid, valid ? undefined : expect.any(String)]);
        };
        const call = async (name: string, args: Record<string, unknown>) => {
            check(name, 'inputSchema', args);
            const result = (await h.rpc('tools/call', { name, arguments: args })).reply.result;
            expect<unknown>([name, result.isError, result.structuredContent?.error]).toEqual([name, undefined, undefined]);
            check(name, 'outputSchema', result.structuredContent);
            return result.structuredContent;
        };

        const zoned = await call('create_event', { calendar_id: WORK, operation_id: 'op-budget-zoned', title: 'Zoned', start: { local: '2026-12-02T09:00:00', zone: 'America/New_York' }, end: { local: '2026-12-02T10:00:00', zone: 'America/New_York' } });
        expect(zoned.event.start.zone).toBe('America/New_York');
        await call('create_event', { calendar_id: WORK, operation_id: 'op-budget-allday', title: 'All day', start: { date: '2026-12-24' }, end: { date: '2026-12-25' }, alarms: [{ before_start: 'PT10M' }], travel_time: 'PT30M' });
        const series = await call('create_event', { calendar_id: WORK, operation_id: 'op-budget-series', title: 'Weekly', start: '2026-12-07T15:00:00Z', end: { utc: '2026-12-07T16:00:00Z' }, recurrence: { rrule: 'FREQ=WEEKLY;COUNT=4' } });
        const listed = await call('list_events', { range: { start: '2026-12-01T00:00:00Z', end: '2027-01-01T00:00:00-05:00' }, limit: 100 });
        await call('search_events', { range: { start: '2026-12-01T00:00:00Z', end: '2027-01-01T00:00:00Z' }, query: 'weekly', fields: ['title'] });
        const occurrences = (listed.events as { resource_href: string; recurrence_id: string | null }[]).filter(row => row.resource_href === series.resource_href);
        expect(occurrences.length).toBe(4);
        await call('get_event', { calendar_id: WORK, resource_href: series.resource_href, recurrence_id: occurrences[1]?.recurrence_id, include_raw: true });
        const changed = await call('update_event', { calendar_id: WORK, resource_href: series.resource_href, expected_version: series.expected_version, edit_scope: 'this', recurrence_id: occurrences[1]?.recurrence_id, changes: { title: 'Moved', start: '2026-12-14T17:00:00Z', end: '2026-12-14T18:00:00Z' } });
        const deleted = await call('delete_event', { calendar_id: WORK, resource_href: series.resource_href, expected_version: changed.expected_version, edit_scope: 'this', recurrence_id: occurrences[2]?.recurrence_id });
        const moved = await call('update_event', { calendar_id: WORK, resource_href: series.resource_href, expected_version: deleted.expected_version, edit_scope: 'all', exceptions: 'drop', changes: { start: '2026-12-07T16:00:00Z', end: '2026-12-07T17:00:00Z', location: null } });
        expect<unknown>([moved.exceptions_dropped?.changed_occurrences, moved.exceptions_dropped?.deleted_occurrences, moved.exceptions_dropped?.changed[0]?.original_start]).toEqual([1, 1, { utc: '2026-12-14T15:00:00Z' }]);
        await call('delete_event', { calendar_id: WORK, resource_href: series.resource_href, expected_version: moved.expected_version, edit_scope: 'all' });

        // The JSON Schema says the same as Zod about malformed times: no time form without its required part, nothing extra.
        const create = { calendar_id: WORK, operation_id: 'op-budget-bad', title: 'x', end: '2026-12-01T10:00:00Z' };
        for (const start of [{ zone: 'America/New_York' }, { date: '2026-12-01', extra: true }, { utc: 1 }, 42]) { check('create_event', 'inputSchema', { ...create, start }, false); }

        // An opaque href of the measured shape is a valid input, and an unaddressable entry (null href) a valid result.
        check('get_event', 'inputSchema', { calendar_id: WORK, resource_href: `${WORK}x-apple-reminderkit%3A%252FSYNTHETIC%252F1.ics` });
        const unaddressable = { calendar: 0, resource_href: null, recurrence_id: null, reason: 'unsupported_resource_address' };
        check('list_events', 'outputSchema', { ...listed, unreadable: [unaddressable], unreadable_count: 1, complete: false });
    });
});
