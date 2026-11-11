import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProbe } from '../scripts/build-probe';

test('bundles a Node handler that rejects a bad event without network or console output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caldav-mcp-probe-build-'));
    try {
        const result = await buildProbe({ outDir: join(dir, 'probe'), zipPath: join(dir, 'probe.zip') });
        expect(existsSync(result.handlerPath)).toBe(true);
        expect(existsSync(result.zipPath)).toBe(true);
        expect(existsSync(join(dir, 'probe', 'entry.ts'))).toBe(false);
        const script = `import(${JSON.stringify(`file://${result.handlerPath}`)}).then(async (m) => { globalThis.fetch = () => { throw new Error('network used'); }; const r = await m.handler({ appleId: 'x' }); process.stdout.write('RESULT ' + JSON.stringify(r)); });`;
        const child = Bun.spawn(['node', '--input-type=module', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        expect(code).toBe(0);
        expect(stdout).toBe('RESULT {"error":"invalid_event"}');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}, 30_000);
