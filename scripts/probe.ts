/**
 * Phase 0 probe: `bun run probe [-- --write | --invite | --cleanup | --json | --lambda <fn>]`.
 * See docs/probe.md. Credentials come only from prompts or PROBE_* environment variables.
 */
import { loadBackendFromSource } from './probe/backend-loader';
import { runCli } from './probe/cli';
import { runProbe } from './probe/core';
import { defaultInvokeDeps, invokeProbeLambda, removeTempDirsNow } from './probe/lambda-invoke';
import { promptHidden, promptLine } from './probe/prompt';
import { installSignalHandlers, type SignalState } from './probe/signals';

const FATAL = 'probe failed: internal error. No details are printed, so that no credential can leak.\n';

function randomHex(bytes: number): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

function restoreTerminal(): void {
    try {
        if (process.stdin.isTTY === true) {
            process.stdin.setRawMode(false);
        }
    } catch {
        // The terminal is already gone.
    }
}

if (import.meta.main) {
    // Captured once: the skeleton-backend check replaces the global fetch while it runs.
    const realFetch = globalThis.fetch;
    const fatal = (): void => {
        restoreTerminal();
        removeTempDirsNow();
        process.stderr.write(FATAL);
        process.exit(1);
    };
    process.on('uncaughtException', fatal);
    process.on('unhandledRejection', fatal);
    const state: SignalState = { started: false, lambda: process.argv.includes('--lambda'), controller: new AbortController() };
    installSignalHandlers(process, state, {
        stderr: (text) => { process.stderr.write(text); },
        exit: (code) => { process.exit(code); },
        restoreTerminal,
        removeTempDirs: removeTempDirsNow,
    });
    const code = await runCli(process.argv.slice(2), {
        env: process.env,
        isTTY: process.stdin.isTTY === true,
        promptLine: (question) => promptLine(question),
        promptHidden: (question) => promptHidden(question),
        stdout: (text) => { process.stdout.write(text); },
        stderr: (text) => { process.stderr.write(text); },
    }, {
        probe: (input, hooks) => {
            state.started = true;
            return runProbe(input, {
                fetch: (url, init) => realFetch(url, init),
                now: () => Date.now(),
                sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
                randomHex,
                signal: state.controller.signal,
                loadBackend: loadBackendFromSource,
                confirmCleanup: (candidates) => hooks.confirmCleanup(candidates),
            });
        },
        invokeLambda: (functionName, payload, region) => {
            state.started = true;
            return invokeProbeLambda(functionName, payload, region, defaultInvokeDeps(state.controller.signal));
        },
    });
    removeTempDirsNow();
    // The prompts can leave stdin referenced; exit explicitly once done.
    process.exit(code);
}
