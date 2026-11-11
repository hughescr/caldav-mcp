import { CalDavError, type CalDavAuth, type CalDavBackend, type CalendarSummary, type Discovery } from '../../src/caldav/contracts';

/** Synthetic iCloud-shaped discovery result; the DSID is fabricated. */
export const FAKE_DISCOVERY: Discovery = Object.freeze({
    principalUrl: 'https://p01-caldav.icloud.com/10000000001/principal/',
    calendarHomeUrl: 'https://p01-caldav.icloud.com/10000000001/calendars/',
});

export type ValidateResult = 'valid' | 'expired' | 'temporary';
export type FakeMethod = 'discover' | 'validate' | 'listCalendars';

export interface FakeCall {
    method: FakeMethod;
    appleId: string;
    appPassword: string;
    discovery?: Discovery;
}

/** A scripted outcome: a value to return, an error to throw, or a function computing either. */
export type Outcome<T> = T | Error | ((auth: CalDavAuth, discovery?: Discovery) => Promise<T> | T);

interface FakeAccount {
    appPassword: string;
    discovery: Discovery;
    calendars: CalendarSummary[];
}

interface Scripts {
    discover: Outcome<Discovery>[];
    validate: Outcome<ValidateResult>[];
    listCalendars: Outcome<CalendarSummary[]>[];
}

/**
 * In-memory CalDavBackend for tests. Each method first consumes a queued scripted outcome,
 * then falls back to the account table: a matching password succeeds, any other is a
 * definitive 'unauthorized' (discover/listCalendars) or 'expired' (validate).
 * Every call is logged, including the credentials it received.
 */
export class FakeCalDav implements CalDavBackend {
    readonly calls: FakeCall[] = [];
    private readonly accounts = new Map<string, FakeAccount>();
    private readonly scripts: Scripts = { discover: [], validate: [], listCalendars: [] };
    /** Sticky validate result applied after scripts, before the account table. */
    validateOverride: ValidateResult | undefined;

    addAccount(appleId: string, appPassword: string, options: { discovery?: Discovery; calendars?: CalendarSummary[] } = {}): this {
        this.accounts.set(appleId, { appPassword, discovery: options.discovery ?? FAKE_DISCOVERY, calendars: options.calendars ?? [] });
        return this;
    }

    setPassword(appleId: string, appPassword: string): void {
        const account = this.accounts.get(appleId);
        if (!account) {
            throw new Error('Unknown fake account');
        }
        account.appPassword = appPassword;
    }

    setCalendars(appleId: string, calendars: CalendarSummary[]): void {
        const account = this.accounts.get(appleId);
        if (!account) {
            throw new Error('Unknown fake account');
        }
        account.calendars = calendars;
    }

    script<M extends FakeMethod>(method: M, ...outcomes: Scripts[M]): this {
        (this.scripts[method] as unknown[]).push(...outcomes);
        return this;
    }

    count(method?: FakeMethod): number {
        return method === undefined ? this.calls.length : this.calls.filter(call => call.method === method).length;
    }

    private log(method: FakeMethod, auth: CalDavAuth, discovery?: Discovery): void {
        this.calls.push({ method, appleId: auth.appleId, appPassword: auth.appPassword, ...(discovery === undefined ? {} : { discovery: { ...discovery } }) });
    }

    private async run<T>(outcome: Outcome<T>, auth: CalDavAuth, discovery?: Discovery): Promise<T> {
        if (outcome instanceof Error) {
            throw outcome;
        }
        if (typeof outcome === 'function') {
            return (outcome as (auth: CalDavAuth, discovery?: Discovery) => Promise<T> | T)(auth, discovery);
        }
        return structuredClone(outcome);
    }

    private account(auth: CalDavAuth): FakeAccount | undefined {
        const account = this.accounts.get(auth.appleId);
        return account && account.appPassword === auth.appPassword ? account : undefined;
    }

    async discover(auth: CalDavAuth): Promise<Discovery> {
        this.log('discover', auth);
        const scripted = this.scripts.discover.shift();
        if (scripted !== undefined) {
            return this.run(scripted, auth);
        }
        const account = this.account(auth);
        if (!account) {
            throw new CalDavError('unauthorized');
        }
        return { ...account.discovery };
    }

    async validate(auth: CalDavAuth, discovery: Discovery): Promise<ValidateResult> {
        this.log('validate', auth, discovery);
        const scripted = this.scripts.validate.shift();
        if (scripted !== undefined) {
            return this.run(scripted, auth, discovery);
        }
        if (this.validateOverride !== undefined) {
            return this.validateOverride;
        }
        const account = this.account(auth);
        return account && account.discovery.principalUrl === discovery.principalUrl && account.discovery.calendarHomeUrl === discovery.calendarHomeUrl ? 'valid' : 'expired';
    }

    async listCalendars(auth: CalDavAuth, discovery: Discovery): Promise<CalendarSummary[]> {
        this.log('listCalendars', auth, discovery);
        const scripted = this.scripts.listCalendars.shift();
        if (scripted !== undefined) {
            return this.run(scripted, auth, discovery);
        }
        const account = this.account(auth);
        if (!account) {
            throw new CalDavError('unauthorized');
        }
        return structuredClone(account.calendars);
    }
}
