import type { CalDavAuth, CalendarSummary, Discovery } from '../../src/caldav/contracts';
import type { CalDavReadBackend, CalendarResource, DavCallOptions, ResourceLookup } from '../../src/caldav/read-contracts';
import { FAKE_DISCOVERY } from './fake-caldav';

export type ReadMethod = 'listCalendars' | 'queryEvents' | 'multigetEvents';

export interface FakeReadCall {
    method: ReadMethod;
    calendarId?: string;
    range?: { startUtc: string; endUtc: string };
    hrefs?: readonly string[];
    options: DavCallOptions | undefined;
}

type Scripted<T, Q> = T | Error | ((query: Q, options: DavCallOptions | undefined) => T | Promise<T>);
type QueryArgs = { calendarId: string; range: { startUtc: string; endUtc: string } };
type MultigetArgs = { calendarId: string; hrefs: readonly string[] };

/** A held call: the fake waits until the test settles it, which lets tests control concurrency and the clock. */
export interface Hold<T> {
    /** Resolves once the fake backend has actually started the held call. */
    started: Promise<void>;
    release(value: T): void;
    fail(error: Error): void;
}

/**
 * In-memory CalDavReadBackend for tests. Calls are logged with the options they received, in-flight concurrency is
 * measured, and any call can be held until the test releases it. Scripts are per calendar and consumed in order; with no
 * script a query returns no resources and a multiget returns not_found for every href. It never touches a network.
 */
export class FakeCalDavRead implements CalDavReadBackend {
    readonly calls: FakeReadCall[] = [];
    inFlight = 0;
    maxInFlight = 0;
    private calendars: CalendarSummary[] = [];
    private listScripts: Scripted<CalendarSummary[], undefined>[] = [];
    private readonly queryScripts = new Map<string, Scripted<readonly CalendarResource[], QueryArgs>[]>();
    private readonly multigetScripts = new Map<string, Scripted<readonly ResourceLookup[], MultigetArgs>[]>();

    setCalendars(calendars: CalendarSummary[]): this {
        this.calendars = calendars;
        return this;
    }
    scriptList(...outcomes: Scripted<CalendarSummary[], undefined>[]): this {
        this.listScripts.push(...outcomes);
        return this;
    }
    scriptQuery(calendarId: string, ...outcomes: Scripted<readonly CalendarResource[], QueryArgs>[]): this {
        this.queryScripts.set(calendarId, [...(this.queryScripts.get(calendarId) ?? []), ...outcomes]);
        return this;
    }
    scriptMultiget(calendarId: string, ...outcomes: Scripted<readonly ResourceLookup[], MultigetArgs>[]): this {
        this.multigetScripts.set(calendarId, [...(this.multigetScripts.get(calendarId) ?? []), ...outcomes]);
        return this;
    }

    /** Holds the next query for this calendar until released or failed. */
    holdQuery(calendarId: string): Hold<readonly CalendarResource[]> {
        return this.hold<readonly CalendarResource[], QueryArgs>(outcome => this.scriptQuery(calendarId, outcome));
    }
    holdMultiget(calendarId: string): Hold<readonly ResourceLookup[]> {
        return this.hold<readonly ResourceLookup[], MultigetArgs>(outcome => this.scriptMultiget(calendarId, outcome));
    }
    private hold<T, Q>(script: (outcome: Scripted<T, Q>) => void): Hold<T> {
        const started = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<T>();
        script(async (_query: Q, options: DavCallOptions | undefined) => {
            started.resolve();
            options?.signal?.addEventListener('abort', () => gate.reject(new Error('aborted')), { once: true });
            return gate.promise;
        });
        return { started: started.promise, release: value => gate.resolve(value), fail: error => gate.reject(error) };
    }

    count(method?: ReadMethod): number {
        return method === undefined ? this.calls.length : this.calls.filter(call => call.method === method).length;
    }

    private async run<T, Q>(scripted: Scripted<T, Q> | undefined, fallback: T, query: Q, options: DavCallOptions | undefined): Promise<T> {
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
            if (options?.signal?.aborted) { throw new Error('aborted'); }
            if (scripted === undefined) { return structuredClone(fallback); }
            if (scripted instanceof Error) { throw scripted; }
            if (typeof scripted === 'function') { return await (scripted as (q: Q, o: DavCallOptions | undefined) => T | Promise<T>)(query, options); }
            return structuredClone(scripted);
        } finally {
            this.inFlight--;
        }
    }

    async listCalendars(_auth: CalDavAuth, _discovery: Discovery, options?: DavCallOptions): Promise<CalendarSummary[]> {
        this.calls.push({ method: 'listCalendars', options });
        return this.run(this.listScripts.shift(), this.calendars, undefined, options);
    }
    async queryEvents(_auth: CalDavAuth, _discovery: Discovery, query: QueryArgs, options?: DavCallOptions): Promise<readonly CalendarResource[]> {
        this.calls.push({ method: 'queryEvents', calendarId: query.calendarId, range: { ...query.range }, options });
        return this.run(this.queryScripts.get(query.calendarId)?.shift(), [], query, options);
    }
    async multigetEvents(_auth: CalDavAuth, _discovery: Discovery, query: MultigetArgs, options?: DavCallOptions): Promise<readonly ResourceLookup[]> {
        this.calls.push({ method: 'multigetEvents', calendarId: query.calendarId, hrefs: [...query.hrefs], options });
        return this.run(this.multigetScripts.get(query.calendarId)?.shift(), query.hrefs.map((href): ResourceLookup => ({ kind: 'not_found', href })), query, options);
    }
}

export { FAKE_DISCOVERY };

/** A well-formed canonical calendar path under the fake home, for tests. */
export function fakeCalendarPath(name: string): string {
    return `/10000000001/calendars/${name}/`;
}
