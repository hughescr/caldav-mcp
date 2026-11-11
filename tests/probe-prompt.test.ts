import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { promptHidden } from '../scripts/probe/prompt';

class FakeTty extends EventEmitter {
    isTTY = true;
    raw: boolean[] = [];
    paused = true;
    setRawMode(mode: boolean): this {
        this.raw.push(mode);
        return this;
    }
    resume(): this {
        this.paused = false;
        return this;
    }
    pause(): this {
        this.paused = true;
        return this;
    }
}

function output(): { write(text: string): boolean; text: string } {
    const o = { text: '', write: (t: string) => { o.text += t; return true; } };
    return o;
}

test('reads with raw mode on, never echoes, handles backspace, and restores the terminal', async () => {
    const input = new FakeTty();
    const out = output();
    const pending = promptHidden('Password: ', input, out);
    input.emit('data', 'abcd-efgx');
    input.emit('data', Buffer.from('\u007fh-ijkl\r'));
    expect(await pending).toBe('abcd-efgh-ijkl');
    expect(out.text).toBe('Password: \n');
    expect(input.raw).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(input.listenerCount('data')).toBe(0);
});

test('Ctrl-C and Ctrl-D on an empty line cancel; no TTY returns nothing', async () => {
    for (const key of ['\u0003', '\u0004']) {
        const input = new FakeTty();
        const pending = promptHidden('P: ', input, output());
        input.emit('data', key);
        expect(await pending).toBeUndefined();
        expect(input.raw).toEqual([true, false]);
    }
    const notTty = new FakeTty();
    notTty.isTTY = false;
    expect(await promptHidden('P: ', notTty, output())).toBeUndefined();
    expect(notTty.raw).toEqual([]);
});
