/**
 * Bundles the probe's Lambda handler: dist/probe/handler.mjs and dist/probe.zip.
 * Pattern follows scripts/build.ts. src/caldav/icloud.ts is bundled when it exists, so the
 * skeleton-backend check also runs from Lambda.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface BuildProbeOptions {
    outDir?: string;
    zipPath?: string;
}

export interface BuildProbeResult {
    handlerPath: string;
    zipPath: string;
    backendBundled: boolean;
}

const ROOT = resolve(import.meta.dir, '..');

export async function buildProbe(options: BuildProbeOptions = {}): Promise<BuildProbeResult> {
    const outDir = options.outDir ?? join(ROOT, 'dist', 'probe');
    const zipPath = options.zipPath ?? join(ROOT, 'dist', 'probe.zip');
    await mkdir(outDir, { recursive: true });
    await mkdir(dirname(zipPath), { recursive: true });
    const backendPath = join(ROOT, 'src', 'caldav', 'icloud.ts');
    const backendBundled = existsSync(backendPath);
    const lambdaPath = join(ROOT, 'scripts', 'probe', 'lambda.ts');
    const entry = join(outDir, 'entry.ts');
    const source = backendBundled
        ? `import { createHandler } from ${JSON.stringify(lambdaPath)};\nimport * as backend from ${JSON.stringify(backendPath)};\nexport const handler = createHandler(async () => ({ status: 'loaded', module: { ...backend } }));\n`
        : `import { createHandler } from ${JSON.stringify(lambdaPath)};\nexport const handler = createHandler(async () => ({ status: 'absent' }));\n`;
    await Bun.write(entry, source);
    try {
        const result = await Bun.build({ entrypoints: [entry], outdir: outDir, target: 'node', format: 'esm', naming: 'handler.mjs', minify: true });
        if (!result.success) {
            throw new AggregateError(result.logs, 'Probe Lambda build failed');
        }
    } finally {
        await rm(entry, { force: true });
    }
    const handlerPath = join(outDir, 'handler.mjs');
    await rm(zipPath, { force: true });
    const archive = Bun.spawn(['zip', '-q', '-j', '-X', zipPath, handlerPath], { stdout: 'inherit', stderr: 'inherit' });
    if (await archive.exited !== 0) {
        throw new Error('Creating the probe Lambda zip failed');
    }
    return { handlerPath, zipPath, backendBundled };
}

if (import.meta.main) {
    const result = await buildProbe();
    process.stdout.write(`Built ${result.handlerPath} and ${result.zipPath} (skeleton backend ${result.backendBundled ? 'bundled' : 'not present, check will be skipped'}).\n`);
}
