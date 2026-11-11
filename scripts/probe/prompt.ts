import { createInterface } from 'node:readline';

export interface PromptOutput {
    write(text: string): unknown;
}

export interface HiddenInput {
    isTTY?: boolean;
    setRawMode(mode: boolean): unknown;
    on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
    removeListener(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
    resume(): unknown;
    pause(): unknown;
}

/** Visible one-line prompt on stderr. Undefined on end of input or Ctrl-C. */
export function promptLine(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<string | undefined> {
    return new Promise((resolve) => {
        const rl = createInterface({ input, output, terminal: true });
        let answered = false;
        rl.on('SIGINT', () => {
            rl.close();
        });
        rl.on('close', () => {
            if (!answered) {
                output.write('\n');
                resolve(undefined);
            }
        });
        rl.question(question, (answer) => {
            answered = true;
            rl.close();
            resolve(answer);
        });
    });
}

/**
 * Reads a line with terminal echo disabled (raw mode). Nothing typed is ever written back.
 * Undefined when there is no TTY, on Ctrl-C, or on Ctrl-D with nothing typed.
 */
export function promptHidden(question: string, input: HiddenInput = process.stdin, output: PromptOutput = process.stderr): Promise<string | undefined> {
    return new Promise((resolve) => {
        if (input.isTTY !== true) {
            resolve(undefined);
            return;
        }
        output.write(question);
        let value = '';
        const decoder = new TextDecoder();
        const finish = (result: string | undefined): void => {
            input.removeListener('data', onData);
            input.setRawMode(false);
            input.pause();
            output.write('\n');
            resolve(result);
        };
        const onData = (chunk: string | Uint8Array): void => {
            const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            for (const ch of text) {
                if (ch === '\r' || ch === '\n') {
                    finish(value);
                    return;
                }
                if (ch === '\u0003') {
                    finish(undefined);
                    return;
                }
                if (ch === '\u0004') {
                    if (value === '') {
                        finish(undefined);
                        return;
                    }
                    continue;
                }
                if (ch === '\u007f' || ch === '\b') {
                    value = [...value].slice(0, -1).join('');
                    continue;
                }
                if (ch === '\u001b') {
                    // Escape sequences (arrow keys and the like) are dropped with the rest of the chunk.
                    break;
                }
                if (ch >= ' ') {
                    value += ch;
                }
            }
        };
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
    });
}
