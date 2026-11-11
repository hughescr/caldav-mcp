import { describe, expect, test } from 'bun:test';
import { installSignalHandlers, type ProbeSignal, type SignalState } from '../scripts/probe/signals';

function setup(state: Partial<SignalState> = {}) {
    const handlers = new Map<ProbeSignal, () => void>();
    const err: string[] = [];
    const exits: number[] = [];
    let restored = 0;
    let removed = 0;
    const full: SignalState = { started: false, lambda: false, controller: new AbortController(), ...state };
    installSignalHandlers({ on: (signal, fn) => { handlers.set(signal, fn); } }, full, {
        stderr: (t) => { err.push(t); },
        exit: (code) => { exits.push(code); },
        restoreTerminal: () => { restored++; },
        removeTempDirs: () => { removed++; },
    });
    const fire = (signal: ProbeSignal): void => handlers.get(signal)?.();
    return { fire, err, exits, state: full, counts: () => ({ restored, removed }), handlers };
}

describe('signals (m4)', () => {
    test('SIGINT, SIGTERM and SIGHUP are all handled', () => {
        const s = setup();
        expect([...s.handlers.keys()].toSorted()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
    });

    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
        test(`${signal} while the probe runs stops the checks and removes temporary calendars, like the first Ctrl-C`, () => {
            const s = setup({ started: true });
            s.fire(signal);
            expect(s.state.controller.signal.aborted).toBe(true);
            expect(s.exits).toEqual([]);
            expect(s.err.join('')).toContain('removing temporary calendars');
            s.fire(signal);
            expect(s.exits).toEqual([code]);
            expect(s.counts().removed).toBe(1);
            expect(s.err.join('')).toContain('--cleanup');
        });

        test(`${signal} before anything was sent restores the terminal and exits`, () => {
            const s = setup({ started: false });
            s.fire(signal);
            expect(s.exits).toEqual([code]);
            expect(s.counts()).toEqual({ restored: 1, removed: 1 });
            expect(s.err.join('')).toContain('nothing was sent');
        });
    }
});

describe('Ctrl-C with --lambda tells the truth (m3)', () => {
    test('the remote run continues; the message says so and points to --cleanup', () => {
        const s = setup({ started: true, lambda: true });
        s.fire('SIGINT');
        const text = s.err.join('');
        expect(text).toContain('continues on AWS');
        expect(text).toContain('--cleanup');
        expect(text).not.toContain('removing temporary calendars');
        expect(s.state.controller.signal.aborted).toBe(true);
        s.fire('SIGINT');
        expect(s.exits).toEqual([130]);
        expect(s.counts().removed).toBe(1);
    });
});
