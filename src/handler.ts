import { handle, type APIGatewayProxyResult, type LambdaContext, type LambdaEvent } from '@hono/aws-lambda';
import { createApp } from './app';
import { withRequestBudget } from './request-budget';
/** Conservative serialized-envelope bound, independent of the decoded HTTP cap.
 * Count JSON escaping, base64 bodies, headers, cookies and adapter metadata. */
export const MAX_LAMBDA_PAYLOAD_BYTES = 6_000_000;
const encodedSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function sizeError(response: boolean): APIGatewayProxyResult {
    return { statusCode: response ? 502 : 413, isBase64Encoded: false, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: response ? 'response_too_large' : 'payload_too_large', error_description: response ? 'The complete response exceeds the buffered transport bound; no data was silently dropped. For writes, check only the identical operation_id; do not retry with a new ID.' : 'The serialized request exceeds the buffered transport bound.' }) };
}
/** Factory keeps tests on the same adapter/guards as production. It installs no
 * authentication bypass; production always builds the normal configured app. */
export function createLambdaHandler(app = createApp()) {
    const invoke = handle(app);
    return async (event: LambdaEvent, context?: LambdaContext): Promise<APIGatewayProxyResult> => {
        if (encodedSize(event) > MAX_LAMBDA_PAYLOAD_BYTES) { return sizeError(false); }
        // Only the AWS-owned context supplies this getter; HTTP data cannot set it.
        // Read its live value at backend dispatch, after authentication, not here.
        const result = await (context && 'getRemainingTimeInMillis' in context
            ? withRequestBudget(() => context.getRemainingTimeInMillis(), () => invoke(event, context))
            : invoke(event, context));
        return encodedSize(result) > MAX_LAMBDA_PAYLOAD_BYTES ? sizeError(true) : result;
    };
}
export const handler = createLambdaHandler();
