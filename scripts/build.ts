import { mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const result = await Bun.build({ entrypoints: ['src/handler.ts'], outdir: 'dist', target: 'node', format: 'esm', naming: 'handler.mjs', sourcemap: 'external', minify: true });
if (!result.success) {
    throw new AggregateError(result.logs, 'Lambda build failed');
}

const archive = Bun.spawn(['zip', '-q', '-j', '-X', 'dist/function.zip', 'dist/handler.mjs', 'dist/handler.mjs.map'], { stdout: 'inherit', stderr: 'inherit' });
if (await archive.exited !== 0) {
    throw new Error('Creating the Lambda deployment zip failed');
}
