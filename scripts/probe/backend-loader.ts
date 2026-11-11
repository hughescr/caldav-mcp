import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BackendLoad } from './types';

/**
 * Loads src/caldav/icloud.ts if it exists. The specifier is computed at run time so the
 * probe still type-checks and bundles while that module does not exist yet.
 */
export async function loadBackendFromSource(): Promise<BackendLoad> {
    const url = new URL('../../src/caldav/icloud.ts', import.meta.url);
    let path: string;
    try {
        path = fileURLToPath(url);
    } catch {
        return { status: 'absent' };
    }
    if (!existsSync(path)) {
        return { status: 'absent' };
    }
    try {
        const mod: unknown = await import(url.href);
        return mod !== null && typeof mod === 'object' ? { status: 'loaded', module: mod as Record<string, unknown> } : { status: 'import_failed' };
    } catch {
        return { status: 'import_failed' };
    }
}
