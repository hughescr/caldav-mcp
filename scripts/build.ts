import { mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const settings = { target: 'node', format: 'esm', sourcemap: 'external', minify: true } as const;
const result = await Bun.build({ ...settings, entrypoints: ['src/handler.ts'], outdir: 'dist', naming: 'handler.mjs' });
if (!result.success) {
    throw new AggregateError(result.logs, 'Lambda build failed');
}
// The managed-attachment fetcher, built the same way, for the Node transport check (scripts/transport-check.mjs). Not deployed.
const check = await Bun.build({ ...settings, entrypoints: ['scripts/transport-check-entry.ts'], outdir: 'dist/transport-check', naming: 'attachment-fetch.mjs' });
if (!check.success) {
    throw new AggregateError(check.logs, 'Transport check build failed');
}

const archive = Bun.spawn(['zip', '-q', '-j', '-X', 'dist/function.zip', 'dist/handler.mjs', 'dist/handler.mjs.map'], { stdout: 'inherit', stderr: 'inherit' });
if (await archive.exited !== 0) {
    throw new Error('Creating the Lambda deployment zip failed');
}
