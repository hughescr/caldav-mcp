import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
    CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, createMcpHandler, McpServer, PROTOCOL_VERSION_META_KEY, WebStandardStreamableHTTPServerTransport,
    type AuthInfo, type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { z } from 'zod';
import { bindCalendarService } from '../src/calendar/service';
import { handleMcp } from '../src/mcp';
import { loosenSchema, publishedOutputSchema } from '../src/published-schema';
import { FAKE_DISCOVERY, FakeICloud } from './helpers/fake-caldav-write';

const ERAS = ['2025-11-25', '2026-07-28'] as const;
const CANARY = 'canary-extra-field-value-7f3a';
const ajv = new AjvJsonSchemaValidator();
const accepts = (schema: unknown, value: unknown): boolean => ajv.getValidator(schema as Record<string, unknown>)(value).valid;

describe('loosenSchema: tuples become no stricter than the original', () => {
    test('a closed tuple (items: false) accepts an array of any of its entries, of any length', () => {
        const original = { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false };
        const copy = structuredClone(original);
        const loose = loosenSchema(original);
        expect(original).toEqual(copy);
        expect(accepts(original, ['x', 42])).toBe(true);
        for (const value of [['x', 42], ['x'], [], ['x', 42, 7], [42, 'x'], ['x', 'y', 42]]) { expect<unknown>([value, accepts(loose, value)]).toEqual([value, true]); }
        expect(accepts(loose, [true])).toBe(false);
        expect(loose).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } });
    });

    test('a closed tuple of one distinct entry schema becomes that entry as items', () => {
        const loose = loosenSchema({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'string' }], items: false });
        expect(loose).toEqual({ type: 'array', items: { type: 'string' } });
        expect(accepts(loose, ['a', 'b', 'c'])).toBe(true);
        expect(accepts(loose, [1])).toBe(false);
    });

    test('an open tuple (items absent or true) publishes no items at all: extra items of any type still validate', () => {
        for (const original of [
            { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] },
            { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: true },
        ]) {
            const copy = structuredClone(original);
            const loose = loosenSchema(original) as Record<string, unknown>;
            expect(original).toEqual(copy);
            expect(accepts(original, ['x', 42, { anything: [1] }])).toBe(true);
            expect(Object.hasOwn(loose, 'items')).toBe(false);
            expect(Object.hasOwn(loose, 'prefixItems')).toBe(false);
            for (const value of [['x', 42], ['x', 42, null, { a: 1 }, 'more'], [42, 'x'], []]) { expect<unknown>([value, accepts(loose, value)]).toEqual([value, true]); }
            expect(accepts(loose, 'not an array')).toBe(false);
        }
    });

    test('a tuple with a rest schema accepts any of the prefix entries and the rest schema, loosened', () => {
        const original = { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' } } } };
        const copy = structuredClone(original);
        const loose = loosenSchema(original);
        expect(original).toEqual(copy);
        expect(accepts(original, ['x', { id: 1 }])).toBe(true);
        for (const value of [['x', { id: 1 }], ['x', { id: 1, a_later_field: true }], ['x', 'y', { id: 2 }], [{ id: 3 }]]) { expect<unknown>([value, accepts(loose, value)]).toEqual([value, true]); }
        expect(accepts(loose, [7])).toBe(false);
        expect(loose).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'integer' } } }] } });
    });

    test('a tuple nested in an object property is handled the same way, and the input is not mutated', () => {
        const original = {
            type: 'object', additionalProperties: false,
            properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] }, closed: { type: 'array', prefixItems: [{ type: 'string' }], items: false } },
        };
        const copy = structuredClone(original);
        const loose = loosenSchema(original);
        expect(original).toEqual(copy);
        expect(accepts(loose, { pair: ['x', 42, 'extra'], closed: ['a', 'b'], a_later_field: 1 })).toBe(true);
    });
});

/** A strict output schema like the server's: every object rejects an unknown field. */
const strictOutput = z.strictObject({ id: z.string(), count: z.number(), inner: z.strictObject({ label: z.string() }) });
const valid = { id: 'a', count: 2, inner: { label: 'x' } };

function request(method: string, params: Record<string, unknown>, protocol: string): Request {
    const modern = protocol === '2026-07-28';
    return new Request('https://service.example/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
            ...(modern ? { 'Mcp-Method': method, ...(typeof params['name'] === 'string' ? { 'Mcp-Name': params['name'] } : {}) } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: modern ? { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: protocol, [CLIENT_INFO_META_KEY]: { name: 'test', version: '0' }, [CLIENT_CAPABILITIES_META_KEY]: {} } } : params }),
    });
}

const authInfo: AuthInfo = { token: 'synthetic', clientId: 'test', scopes: [] };

/** A bare SDK server (no shape or service layer) whose one tool returns `structured` directly, registered with the published output schema. */
function bareServer(outputSchema: StandardSchemaWithJSON, structured: () => unknown): McpServer {
    const server = new McpServer({ name: 'bare', version: '0' });
    server.registerTool('probe', { description: 'probe', inputSchema: z.strictObject({}), outputSchema }, async () => ({ structuredContent: structured() as Record<string, unknown>, content: [{ type: 'text' as const, text: 'ok' }] }));
    return server;
}

/** One request through the era's real transport; resolves to the parsed JSON-RPC reply and its text. */
async function send(makeServer: () => McpServer, method: string, params: Record<string, unknown>, protocol: string) {
    const http = request(method, params, protocol);
    let response: Response;
    if (protocol === '2026-07-28') {
        const handler = createMcpHandler(makeServer, { legacy: 'reject' });
        try { response = await handler.fetch(http, { authInfo }); } finally { await handler.close(); }
    } else {
        const server = makeServer();
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        try { response = await transport.handleRequest(http, { authInfo }); } finally { await server.close(); }
    }
    const text = await response.text();
    return { text, reply: JSON.parse(text) };
}

describe('the SDK validates a result with the strict schema although tools/list shows the loosened one', () => {
    for (const protocol of ERAS) {
        test(`era ${protocol}: a valid result passes; an unknown field and a wrong type are refused; tools/list has no additionalProperties`, async () => {
            const outputSchema = publishedOutputSchema(strictOutput);
            const call = async (structured: unknown) => send(() => bareServer(outputSchema, () => structured), 'tools/call', { name: 'probe', arguments: {} }, protocol);
            const refused = (reply: { result?: { isError?: boolean }; error?: unknown }) => reply.error !== undefined || reply.result?.isError === true;

            const ok = await call(valid);
            expect<unknown>([ok.reply.error, ok.reply.result?.isError, ok.reply.result?.structuredContent]).toEqual([undefined, undefined, valid]);

            for (const bad of [{ ...valid, a_later_field: CANARY }, { ...valid, inner: { label: 'x', a_later_field: CANARY } }]) {
                const result = await call(bad);
                expect<unknown>([refused(result.reply), result.text.includes(CANARY)]).toEqual([true, false]);
            }
            for (const bad of [{ ...valid, count: 'two' }, { ...valid, inner: { label: 7 } }]) {
                expect(refused((await call(bad)).reply)).toBe(true);
            }

            const listed = (await send(() => bareServer(outputSchema, () => valid), 'tools/list', {}, protocol)).reply.result.tools[0].outputSchema as Record<string, unknown>;
            expect(JSON.stringify(listed)).not.toContain('additionalProperties');
            expect(Object.keys(listed['properties'] as object).toSorted()).toEqual(['count', 'id', 'inner']);
            // The unwrapped schema would publish the closed form, so the loosening is what this test sees.
            const strictListed = (await send(() => bareServer(strictOutput, () => valid), 'tools/list', {}, protocol)).reply.result.tools[0].outputSchema;
            expect(JSON.stringify(strictListed)).toContain('"additionalProperties":false');
        });
    }
});

describe('the eight real tools register the wrapper as their output schema, so the SDK validates with the strict schema', () => {
    let spy: ReturnType<typeof spyOn<McpServer, 'registerTool'>> | undefined;
    afterEach(() => { spy?.mockRestore(); spy = undefined; });

    const TOOLS = ['create_event', 'delete_event', 'get_event', 'get_event_attachment_download', 'list_calendars', 'list_events', 'search_events', 'update_event'];

    for (const protocol of ERAS) {
        test(`era ${protocol}: each registered output schema rejects an unknown top-level field and an empty object, accepts nothing loosened, and publishes no additionalProperties`, async () => {
            spy = spyOn(McpServer.prototype, 'registerTool');
            const service = bindCalendarService({
                caldav: new FakeICloud(['/10000000001/calendars/work/']), connectionStatus: 'active', credentials: () => ({ accountId: 'C'.repeat(43), appleId: 'a@example.invalid', appPassword: 'p', ...FAKE_DISCOVERY, issuedAt: 1000 }),
                markReconnectRequired: async () => true, now: () => Date.UTC(2026, 10, 13, 9, 0, 0),
            });
            const response = await handleMcp(request('tools/list', {}, protocol), authInfo, service);
            expect(response.status).toBe(200);

            // Registrations, as the SDK stored them (the return value of registerTool), by tool name.
            const registered = new Map(spy.mock.calls.map((call, index) => [call[0], spy?.mock.results[index]?.value as { outputSchema?: StandardSchemaWithJSON } | undefined]));
            expect([...registered.keys()].toSorted()).toEqual(TOOLS);
            for (const name of TOOLS) {
                const outputSchema = registered.get(name)?.outputSchema;
                if (outputSchema === undefined) { throw new Error(`no output schema registered for ${name}`); }
                const standard = outputSchema['~standard'];
                // A permissive validator would accept both of these; the strict Zod schema refuses each.
                for (const value of [{ a_later_field: CANARY }, {}]) { expect<unknown>([name, (await standard.validate(value)).issues !== undefined]).toEqual([name, true]); }
                // And the published JSON Schema is the loosened one, so the wrapper (not the bare schema) was registered.
                expect<unknown>([name, standard.jsonSchema.output({ target: 'draft-2020-12' })['additionalProperties']]).toEqual([name, undefined]);
            }

            // For a tool whose result is easy to build: the valid result passes, and the same result with an unknown field is refused.
            const calendars = registered.get('list_calendars')?.outputSchema?.['~standard'];
            expect((await calendars?.validate({ calendars: [], truncated: false }))?.issues).toBeUndefined();
            expect((await calendars?.validate({ calendars: [], truncated: false, a_later_field: CANARY }))?.issues?.length).toBeGreaterThan(0);
        });
    }
});
