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
    private readonly servers = new Map<string, CalendarServer>();

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
    /** Answers every query and multiget for this calendar that has no queued script, for as many calls as a test makes. */
    serve(calendarId: string, server: CalendarServer): this {
        this.servers.set(calendarId, server);
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
        return this.run(this.queryScripts.get(query.calendarId)?.shift() ?? this.servers.get(query.calendarId)?.query, [], query, options);
    }
    async multigetEvents(_auth: CalDavAuth, _discovery: Discovery, query: MultigetArgs, options?: DavCallOptions): Promise<readonly ResourceLookup[]> {
        this.calls.push({ method: 'multigetEvents', calendarId: query.calendarId, hrefs: [...query.hrefs], options });
        return this.run(this.multigetScripts.get(query.calendarId)?.shift() ?? this.servers.get(query.calendarId)?.multiget, query.hrefs.map((href): ResourceLookup => ({ kind: 'not_found', href })), query, options);
    }
}

/** Standing answers for one calendar, used by `serve`. */
export interface CalendarServer {
    query?: (query: QueryArgs) => readonly CalendarResource[];
    multiget?: (query: MultigetArgs) => readonly ResourceLookup[];
}

// ---- The measured expanded shape of overridden instances (probe Run 7, check write-override-expanded-shape) ----

/** The form of a series' DTSTART, which decides the stored form of an override's RECURRENCE-ID. */
export type SeriesForm = { kind: 'tzid'; tzid: string } | { kind: 'date' } | { kind: 'floating' };

/** One instance of a series as the expanded REPORT returns it. */
export interface MeasuredInstance {
    /** `DTSTART/DTEND/RECURRENCE-ID` value texts, in the format of the probe's `…MovedTuples` evidence. */
    tuple: string;
    /**
     * Where the fake places the instance when it compares it with a query window, as basic UTC `[start, end, original slot]`.
     * The fake does no timezone arithmetic, so the test states these instants.
     */
    utc: readonly [string, string, string];
    /** Set for an overridden instance: the override's SUMMARY. */
    overrideSummary?: string;
}

export interface MeasuredSeries {
    href: string;
    etag: string;
    uid: string;
    form: SeriesForm;
    /** The master's SUMMARY and RRULE. */
    summary: string;
    rrule: string;
    instances: readonly MeasuredInstance[];
}

function timeLine(name: string, form: SeriesForm, value: string): string {
    if (value.endsWith('Z')) { return `${name}:${value}`; }
    switch (form.kind) {
        case 'tzid': return `${name};TZID=${form.tzid}:${value}`;
        case 'date': return `${name};VALUE=DATE:${value}`;
        case 'floating': return `${name}:${value}`;
    }
}

function splitTuple(instance: MeasuredInstance): [string, string, string] {
    const [start, end, rid, ...rest] = instance.tuple.split('/');
    if (start === undefined || end === undefined || rid === undefined || rest.length > 0) { throw new Error('bad tuple'); }
    // As measured: an overridden instance carries the stored form, every other instance of a non-UTC series the `…Z` form.
    if ((instance.overrideSummary !== undefined) === rid.endsWith('Z')) { throw new Error('tuple RID form does not match the measured shape'); }
    return [start, end, rid];
}

/**
 * One expanded resource in the measured shape: no VERSION/PRODID, LF, DTSTART/DTEND in the series' form, RECURRENCE-ID `…Z`
 * for an instance without an override and in the stored form for one with, which also carries X-RECURRENCE-EXCEPTION. The
 * probe recorded that property's name only; its value here is invented.
 */
export function measuredExpandedText(series: MeasuredSeries, instances: readonly MeasuredInstance[] = series.instances): string {
    const events = instances.map(instance => {
        const [start, end, rid] = splitTuple(instance);
        return [
            'BEGIN:VEVENT', `UID:${series.uid}`, timeLine('DTSTART', series.form, start), timeLine('DTEND', series.form, end), timeLine('RECURRENCE-ID', series.form, rid),
            `SUMMARY:${instance.overrideSummary ?? series.summary}`, ...(instance.overrideSummary === undefined ? [] : ['X-RECURRENCE-EXCEPTION:TRUE']), 'END:VEVENT',
        ].join('\n');
    });
    return `BEGIN:VCALENDAR\n${events.join('\n')}\nEND:VCALENDAR\n`;
}

/** The stored resource: a master on the first instance's slot with the RRULE, and one override per overridden instance. */
export function measuredOriginalText(series: MeasuredSeries): string {
    const [first] = series.instances;
    if (first === undefined) { throw new Error('empty series'); }
    const [, , firstRid] = splitTuple(first);
    const [firstStart, firstEnd] = splitTuple(first);
    if (!firstRid.endsWith('Z')) { throw new Error('the first instance must not be overridden'); }
    const master = ['BEGIN:VEVENT', `UID:${series.uid}`, timeLine('DTSTART', series.form, firstStart), timeLine('DTEND', series.form, firstEnd), `RRULE:${series.rrule}`, `SUMMARY:${series.summary}`, 'END:VEVENT'];
    const overrides = series.instances.filter(instance => instance.overrideSummary !== undefined).flatMap(instance => {
        const [start, end, rid] = splitTuple(instance);
        return ['BEGIN:VEVENT', `UID:${series.uid}`, timeLine('RECURRENCE-ID', series.form, rid), timeLine('DTSTART', series.form, start), timeLine('DTEND', series.form, end), `SUMMARY:${instance.overrideSummary ?? ''}`, 'END:VEVENT'];
    });
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic//EN', ...master, ...overrides, 'END:VCALENDAR', ''].join('\n');
}

/**
 * A standing server for measured series. A query returns the instances whose original slot is inside the window and whose
 * actual interval overlaps it (probe Run 5: a moved occurrence is returned only when the window covers both), and omits a
 * resource with no such instance. A multiget returns the stored resource. Basic UTC texts compare as strings.
 */
export function measuredSeriesServer(series: readonly MeasuredSeries[]): CalendarServer {
    const inWindow = (window: { startUtc: string; endUtc: string }, instance: MeasuredInstance): boolean => {
        const [start, end, slot] = instance.utc;
        const actual = start === end ? window.startUtc <= start && start < window.endUtc : start < window.endUtc && end > window.startUtc;
        return actual && window.startUtc <= slot && slot < window.endUtc;
    };
    return {
        query: ({ range }) => series.flatMap(item => {
            const selected = item.instances.filter(instance => inWindow(range, instance));
            return selected.length === 0 ? [] : [{ href: item.href, etag: item.etag, calendarData: measuredExpandedText(item, selected) }];
        }),
        multiget: ({ hrefs }) => hrefs.map((href): ResourceLookup => {
            const item = series.find(candidate => candidate.href === href);
            return item === undefined ? { kind: 'not_found', href } : { kind: 'found', resource: { href, etag: item.etag, calendarData: measuredOriginalText(item) } };
        }),
    };
}

export { FAKE_DISCOVERY };

/** A well-formed canonical calendar path under the fake home, for tests. */
export function fakeCalendarPath(name: string): string {
    return `/10000000001/calendars/${name}/`;
}
