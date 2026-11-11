import type { LambdaEvent } from '@hono/aws-lambda';

export function lambdaEvent(path: string, method = 'GET', body?: string): Extract<LambdaEvent, { rawPath: string }> {
    const url = new URL(path, 'https://service.example');
    return {
        version: '2.0',
        routeKey: '$default',
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers: { host: 'service.example', 'content-type': 'application/json' },
        requestContext: {
            accountId: 'test', apiId: 'test', authentication: null, authorizer: {}, domainName: 'service.example',
            domainPrefix: 'example', requestId: 'test', routeKey: '$default', stage: '$default', time: '', timeEpoch: 0,
            http: { method, path: url.pathname, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        },
        isBase64Encoded: false,
        body: body ?? null,
    };
}
