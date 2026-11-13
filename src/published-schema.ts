/**
 * The published form of a tool's output schema. tools/list shows field names and basic types only (with `required`,
 * nullable unions, local `$ref`s and the field descriptions), never a keyword that closes the schema, so a reply that gains a
 * field, a value or an entry still validates on a client holding older tool definitions (observed 2026-11-13: a client with
 * 1.1.1 definitions refused a 1.2.0 reply, "data must NOT have additional properties"). Only what is listed changes: the
 * schema's own validation is kept, so the SDK still checks every result with the strict Zod schema before sending.
 * Input schemas are never published this way: they stay strict, as the model's contract and the server's guard.
 */
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

/**
 * Keywords removed wherever they appear: each fails a reply that gains a field (additionalProperties and its kin), a value
 * (enum, const, pattern, format, bounds) or an entry (item counts), or adds a rule no basic type states.
 */
const CLOSING_KEYWORDS: ReadonlySet<string> = new Set([
    'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'patternProperties', 'minProperties', 'maxProperties', 'enum', 'const', 'pattern', 'format',
    'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems',
    'contains', 'minContains', 'maxContains', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas',
]);

const isSchemaObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One JSON Schema node in its published form; `properties` and `$defs` keys are names, so only their values are loosened. */
export function loosenSchema(node: unknown): unknown {
    if (!isSchemaObject(node)) { return node; }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
        if (CLOSING_KEYWORDS.has(key) || key === 'prefixItems' || (key === 'items' && !isSchemaObject(value))) { continue; }
        if ((key === 'properties' || key === '$defs') && isSchemaObject(value)) {
            out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, loosenSchema(child)]));
        } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
            // oneOf becomes anyOf: with every branch open, one value may match several branches.
            out[key === 'oneOf' ? 'anyOf' : key] = value.map(loosenSchema);
        } else {
            out[key] = key === 'items' ? loosenSchema(value) : value;
        }
    }
    // A closed tuple (items: false) or one with a rest schema becomes an array of any of its entry schemas (and of its rest
    // schema, if any). An open tuple (items absent or true) accepts any extra item, so it publishes no items at all: an
    // items schema there would be stricter than the original.
    const rest = node['items'];
    if (Array.isArray(node['prefixItems']) && (rest === false || isSchemaObject(rest))) {
        const entries = [...node['prefixItems'], ...(isSchemaObject(rest) ? [rest] : [])].map(loosenSchema);
        const distinct = [...new Map(entries.map(entry => [JSON.stringify(entry), entry])).values()];
        if (distinct.length > 0) { out['items'] = distinct.length === 1 ? distinct[0] : { anyOf: distinct }; }
    }
    return out;
}

/**
 * `schema` with tools/list showing its output JSON Schema in the published form; validation is the schema's own, unchanged.
 * mcp.ts registers every tool's output schema through this.
 */
export function publishedOutputSchema<Input, Output>(schema: StandardSchemaWithJSON<Input, Output>): StandardSchemaWithJSON<Input, Output> {
    const standard = schema['~standard'];
    return {
        '~standard': {
            version: standard.version,
            vendor: standard.vendor,
            validate: standard.validate,
            jsonSchema: { input: standard.jsonSchema.input, output: options => loosenSchema(standard.jsonSchema.output(options)) as Record<string, unknown> },
        },
    };
}
