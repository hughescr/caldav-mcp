import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createLambdaHandler, MAX_LAMBDA_PAYLOAD_BYTES } from '../src/handler';
import { lambdaEvent } from './helpers/lambda';

test('serialized request bound counts escaping/metadata before any application work', async () => {
    let calls = 0; const app = new Hono(); app.post('/mcp', context => { calls++; return context.json({ ok: true }); }); const invoke = createLambdaHandler(app);
    const escaped = lambdaEvent('/mcp', 'POST', '"'.repeat(MAX_LAMBDA_PAYLOAD_BYTES / 2));
    expect(Buffer.byteLength(escaped.body ?? '')).toBeLessThan(5 * 1024 * 1024);
    const denied = await invoke(escaped); expect(denied.statusCode).toBe(413); expect(JSON.parse(denied.body).error).toBe('payload_too_large'); expect(calls).toBe(0);
    const headerHeavy = lambdaEvent('/mcp', 'POST', '{}'); headerHeavy.headers.authorization = 'private-test-token'; headerHeavy.cookies = ['x='.padEnd(MAX_LAMBDA_PAYLOAD_BYTES, 'a')];
    const deniedHeaders = await invoke(headerHeavy); expect(deniedHeaders.statusCode).toBe(413); expect(deniedHeaders.body).not.toContain('private-test-token'); expect(calls).toBe(0);
});
test('encoded event bodies are counted and ordinary multi-megabyte JSON still reaches app', async () => {
    let calls = 0; const app = new Hono(); app.post('/mcp', async context => { calls++; return context.json({ bytes: (await context.req.arrayBuffer()).byteLength }); }); const invoke = createLambdaHandler(app);
    const encoded = lambdaEvent('/mcp', 'POST', Buffer.alloc(4_500_001).toString('base64')); encoded.isBase64Encoded = true;
    expect((await invoke(encoded)).statusCode).toBe(413); expect(calls).toBe(0);
    const size = 2 * 1024 * 1024; const ordinary = lambdaEvent('/mcp', 'POST', JSON.stringify({ attachment: Buffer.alloc(size).toString('base64') }));
    const accepted = await invoke(ordinary); expect(accepted.statusCode).toBe(200); expect(JSON.parse(accepted.body).bytes).toBe(Buffer.byteLength(ordinary.body ?? '')); expect(calls).toBe(1);
});
test('serialized response bound prevents silent omission and counts escaped JSON bodies', async () => {
    const app = new Hono(); app.get('/large', context => context.json({ labels: '"'.repeat(1_600_000), private: 'private-response-data' })); app.get('/small', context => { context.header('Set-Cookie', 'safe=value; Secure; HttpOnly'); return context.json({ ok: true }); });
    const invoke = createLambdaHandler(app); const denied = await invoke(lambdaEvent('/large'));
    expect(denied.statusCode).toBe(502); expect(JSON.parse(denied.body).error).toBe('response_too_large'); expect(denied.body).toContain('no data was silently dropped'); expect(denied.body).toContain('identical operation_id'); expect(denied.body).not.toContain('private-response-data'); expect(Buffer.byteLength(JSON.stringify(denied))).toBeLessThan(MAX_LAMBDA_PAYLOAD_BYTES);
    const ordinary = await invoke(lambdaEvent('/small')); expect(ordinary.statusCode).toBe(200); expect(JSON.parse(ordinary.body)).toEqual({ ok: true }); expect(ordinary.cookies).toEqual(['safe=value; Secure; HttpOnly']);
});
test('Lambda budget remains live after authentication and trusts only the bound server context', async () => {
    const { remainingRequestTimeMs } = await import('../src/request-budget');
    let remaining = 30_000, reads = 0; const app = new Hono();
    app.use('*', async (_context, next) => { expect(reads).toBe(0); await Promise.resolve(); remaining = 1900; await next(); });
    app.post('/mcp', context => context.json({ remaining: remainingRequestTimeMs() }));
    const invoke = createLambdaHandler(app); const event = lambdaEvent('/mcp', 'POST', JSON.stringify({ remainingRequestTimeMs: 999_999, getRemainingTimeInMillis: 999_999 })); event.headers['x-request-budget-ms'] = '999999'; event.headers['x-lambda-remaining-time'] = '999999';
    const serverContext = { getRemainingTimeInMillis() { expect(this).toBe(serverContext); reads++; return remaining; } };
    const result = await invoke(event, serverContext as import('@hono/aws-lambda').LambdaContext);
    expect(JSON.parse(result.body).remaining).toBe(1900); expect(reads).toBe(1); expect(remainingRequestTimeMs()).toBeUndefined();
    const absent = new Hono(); absent.post('/mcp', context => context.json({ remaining: remainingRequestTimeMs() ?? null }));
    const withoutContext = await createLambdaHandler(absent)(event); expect(JSON.parse(withoutContext.body).remaining).toBeNull();
});
test('concurrent Lambda invocations isolate live budgets and exhausted or invalid contexts fail closed', async () => {
    const { remainingRequestTimeMs } = await import('../src/request-budget');
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let firstRemaining = 15_000;
    const app = new Hono(); app.get('/first', async context => { entered.resolve(); await release.promise; return context.json({ remaining: remainingRequestTimeMs() }); }); app.get('/second', context => context.json({ remaining: remainingRequestTimeMs() }));
    const invoke = createLambdaHandler(app); const first = invoke(lambdaEvent('/first'), { getRemainingTimeInMillis: () => firstRemaining } as import('@hono/aws-lambda').LambdaContext); await entered.promise;
    const second = await invoke(lambdaEvent('/second'), { getRemainingTimeInMillis: () => 4000 } as import('@hono/aws-lambda').LambdaContext); expect(JSON.parse(second.body).remaining).toBe(4000); const absent = await invoke(lambdaEvent('/second')); expect(JSON.parse(absent.body).remaining).toBeUndefined(); firstRemaining = 1000; release.resolve(); expect(JSON.parse((await first).body).remaining).toBe(1000);
    for (const getter of [() => 0, () => NaN, () => { throw new Error('private budget failure'); }, undefined]) {
        const result = await invoke(lambdaEvent('/second'), { getRemainingTimeInMillis: getter } as unknown as import('@hono/aws-lambda').LambdaContext); expect(JSON.parse(result.body).remaining).toBe(0); expect(result.body).not.toContain('private');
    }
    expect(remainingRequestTimeMs()).toBeUndefined();
});
