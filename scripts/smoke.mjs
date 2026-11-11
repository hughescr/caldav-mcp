import assert from 'node:assert/strict';
import { handler } from '../dist/handler.mjs';

assert.equal(Number(process.versions.node.split('.')[0]), 26, 'Smoke test must execute under Node 26');

// Temporal must be built in: no polyfill is bundled or planned.
assert.equal(typeof Temporal, 'object', 'Temporal must be a built-in global on the production runtime');
// 2026-03-08 02:30 does not exist in America/Los_Angeles (clocks jump 02:00 -> 03:00).
const beforeJump = Temporal.ZonedDateTime.from('2026-03-08T01:30:00[America/Los_Angeles]');
const afterJump = beforeJump.add({ hours: 1 });
assert.equal(afterJump.toString(), '2026-03-08T03:30:00-07:00[America/Los_Angeles]', 'Adding one hour must cross the daylight-saving jump');
assert.equal(beforeJump.offset, '-08:00');
assert.equal(afterJump.offset, '-07:00');
assert.equal(beforeJump.add({ days: 1 }).toPlainTime().toString(), '01:30:00', 'A one-day duration is calendar-day arithmetic');
assert.throws(
    () => Temporal.ZonedDateTime.from({ timeZone: 'America/Los_Angeles', year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, { disambiguation: 'reject' }),
    RangeError,
    'A nonexistent local time must be rejected',
);

const event = (path, headers = {}) => ({
    version: '2.0', routeKey: '$default', rawPath: path, rawQueryString: '', headers: { host: 'example.lambda-url.us-west-2.on.aws', ...headers },
    requestContext: { accountId: 'local', apiId: 'local', domainName: 'example.lambda-url.us-west-2.on.aws', domainPrefix: 'local', requestId: 'smoke', routeKey: '$default', stage: '$default', time: '', timeEpoch: 0, http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'node-smoke' } },
    isBase64Encoded: false,
});
const health = await handler(event('/healthz'), {});
assert.equal(health.statusCode, 200);
assert.equal(JSON.parse(health.body).service, 'caldav-mcp');
const mcp = await handler(event('/mcp', { authorization: 'Bearer fabricated' }), {});
assert.equal(mcp.statusCode, 503, 'Unconfigured authentication must fail closed');
assert.equal((await handler(event('/readyz'), {})).statusCode, 503);
