/**
 * Ctrl-C (SIGINT), SIGTERM and SIGHUP are handled alike.
 *  - Before anything is sent (while prompting): restore the terminal and exit.
 *  - While a local probe runs: the first signal stops the checks and removes the temporary
 *    calendars; a second one exits at once.
 *  - While --lambda waits: the remote run cannot be stopped from here, and the message says
 *    so. The first signal stops waiting (the AWS CLI is killed and the local response
 *    directory removed); a second one exits at once.
 */
export type ProbeSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

const EXIT_CODE: Record<ProbeSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export interface SignalState {
    /** Set once the first request (or the Lambda invocation) may have been sent. */
    started: boolean;
    lambda: boolean;
    controller: AbortController;
}

export interface SignalIo {
    stderr(text: string): void;
    exit(code: number): void;
    restoreTerminal(): void;
    removeTempDirs(): void;
}

export interface SignalSource {
    on(signal: ProbeSignal, handler: () => void): unknown;
}

const LOCAL_FIRST = '\nInterrupted: stopping and removing temporary calendars (interrupt again to exit at once).\n';
const LOCAL_SECOND = '\nInterrupted again: exiting now. Run `bun run probe -- --cleanup` to remove any caldav-mcp-probe- calendar left behind.\n';
const LAMBDA_FIRST = '\nInterrupted: the run on AWS Lambda continues on AWS and cannot be stopped from here (it ends within the function timeout). '
    + 'If this was a --write run, wait five minutes for it to finish, then run `bun run probe -- --cleanup` and look in Calendar for any calendar named caldav-mcp-probe-…\n';
const BEFORE_START = '\nInterrupted: nothing was sent to the server.\n';

export function installSignalHandlers(source: SignalSource, state: SignalState, io: SignalIo): void {
    const handle = (signal: ProbeSignal): void => {
        if (!state.started) {
            io.restoreTerminal();
            io.removeTempDirs();
            io.stderr(BEFORE_START);
            io.exit(EXIT_CODE[signal]);
            return;
        }
        if (state.controller.signal.aborted) {
            io.removeTempDirs();
            io.stderr(state.lambda ? '\nInterrupted again: exiting now.\n' : LOCAL_SECOND);
            io.exit(EXIT_CODE[signal]);
            return;
        }
        io.stderr(state.lambda ? LAMBDA_FIRST : LOCAL_FIRST);
        state.controller.abort();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        source.on(signal, () => {
            handle(signal);
        });
    }
}
