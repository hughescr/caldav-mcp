import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One request as the fake upstream saw it. */
export interface RecordedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    redirect: RequestRedirect | undefined;
    hadSignal: boolean;
}

export type FakeHandler = (request: RecordedRequest, signal: AbortSignal | undefined) => Response | Promise<Response>;

export interface FakeFetch {
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    calls: RecordedRequest[];
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    new Headers(headers).forEach((value, key) => {
        out[key] = value;
    });
    return out;
}

async function bodyToString(body: BodyInit | null | undefined): Promise<string | null> {
    if (body === undefined || body === null) {
        return null;
    }
    return new Response(body).text();
}

/**
 * A fake upstream. `routes` maps `METHOD url` (or just `url`) to a handler.
 * An unmatched request is recorded and answered with 599 so tests notice it.
 */
export function createFakeFetch(routes: Record<string, FakeHandler> = {}): FakeFetch {
    const calls: RecordedRequest[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (input instanceof Request) {
            throw new Error('fake upstream expects the guarded fetch to pass a URL string');
        }
        const recorded: RecordedRequest = {
            url: String(input),
            method: init?.method ?? 'GET',
            headers: headersToRecord(init?.headers),
            body: await bodyToString(init?.body),
            redirect: init?.redirect,
            hadSignal: init?.signal instanceof AbortSignal,
        };
        calls.push(recorded);
        const handler = routes[`${recorded.method} ${recorded.url}`] ?? routes[recorded.url];
        if (!handler) {
            return new Response('no route', { status: 599 });
        }
        return handler(recorded, init?.signal ?? undefined);
    };
    return { fetch, calls };
}

export function xmlResponse(body: string, status = 207, extraHeaders: Record<string, string> = {}): Response {
    return new Response(body, {
        status,
        headers: { 'content-type': 'application/xml; charset=utf-8', ...extraHeaders },
    });
}

export function redirectResponse(location: string, status = 301): Response {
    return new Response(null, { status, headers: { location } });
}

/** Resolves only when the signal aborts, then rejects like fetch does. */
export function hangUntilAborted(signal: AbortSignal | undefined): Promise<Response> {
    return new Promise((_resolve, reject) => {
        if (!signal) {
            return;
        }
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

export function fixture(name: string): string {
    return readFileSync(join(import.meta.dir, name), 'utf8');
}
