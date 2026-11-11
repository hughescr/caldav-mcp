/**
 * Runtime settings that would expose the credentials. Checked by the CLI before it prompts
 * for anything, and by the Lambda handler before it sends anything.
 */
export type UnsafeSetting = 'BUN_CONFIG_VERBOSE_FETCH' | 'NODE_TLS_REJECT_UNAUTHORIZED';

type Env = Readonly<Record<string, string | undefined>>;

export const UNSAFE_MESSAGE: Record<UnsafeSetting, string> = {
    BUN_CONFIG_VERBOSE_FETCH: 'Refusing to run: BUN_CONFIG_VERBOSE_FETCH is set. It makes Bun print every request, including the Authorization header that carries the app-specific password. Unset it and run again.\n',
    NODE_TLS_REJECT_UNAUTHORIZED: 'Refusing to run: NODE_TLS_REJECT_UNAUTHORIZED=0 turns off TLS certificate checks, so the password could be sent to an impostor. Unset it and run again.\n',
};

export const EXTRA_CA_WARNING = 'Warning: NODE_EXTRA_CA_CERTS is set, so an extra certificate authority is trusted for the connection to iCloud. Continue only if you know why (for example a company proxy); otherwise unset it.\n';

/** The first setting that must stop the run, if any. Any non-empty BUN_CONFIG_VERBOSE_FETCH counts. */
export function unsafeSetting(env: Env): UnsafeSetting | undefined {
    const verbose = env.BUN_CONFIG_VERBOSE_FETCH;
    if (verbose !== undefined && verbose !== '') {
        return 'BUN_CONFIG_VERBOSE_FETCH';
    }
    if (env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0') {
        return 'NODE_TLS_REJECT_UNAUTHORIZED';
    }
    return undefined;
}

export function extraCaCertsSet(env: Env): boolean {
    const value = env.NODE_EXTRA_CA_CERTS;
    return value !== undefined && value !== '';
}
