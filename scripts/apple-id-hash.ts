import { createInterface } from 'node:readline';
import { accountIdFor, normalizeAppleId } from '../src/account';

export interface AppleIdHashIo {
    /** True when stdin is a terminal, so a prompt should be shown. */
    isTTY: boolean;
    /** Reads exactly one line; undefined at end of input. */
    readLine(): Promise<string | undefined>;
    stdout(value: string): void;
    stderr(value: string): void;
}

/**
 * Prints the account id (allowlist entry) for one Apple ID read from a prompt or stdin.
 * The address is never accepted as an argument, so it stays out of shell history,
 * and it is never echoed back.
 */
export async function runAppleIdHash(args: readonly string[], io: AppleIdHashIo): Promise<number> {
    if (args.length > 0) {
        io.stderr('Command-line arguments are not accepted, so the Apple ID stays out of shell history. Run without arguments and type it at the prompt or pipe it on stdin.\n');
        return 1;
    }
    let line: string | undefined;
    try {
        if (io.isTTY) {
            io.stderr('Apple ID: ');
        }
        line = await io.readLine();
    } catch {
        // Reader errors are never forwarded.
        line = undefined;
    }
    const appleId = line === undefined ? undefined : normalizeAppleId(line);
    if (appleId === undefined) {
        io.stderr('Invalid Apple ID.\n');
        return 1;
    }
    io.stdout(`${accountIdFor(appleId)}\n`);
    return 0;
}

function stdinLineReader(): () => Promise<string | undefined> {
    const lines = createInterface({ input: process.stdin, terminal: false });
    const iterator = lines[Symbol.asyncIterator]();
    return async () => {
        try {
            const next = await iterator.next();
            return next.done === true ? undefined : next.value;
        } finally {
            lines.close();
        }
    };
}

if (import.meta.main) {
    process.exitCode = await runAppleIdHash(process.argv.slice(2), {
        isTTY: process.stdin.isTTY === true,
        readLine: stdinLineReader(),
        stdout: (value) => { process.stdout.write(value); },
        stderr: (value) => { process.stderr.write(value); },
    });
}
