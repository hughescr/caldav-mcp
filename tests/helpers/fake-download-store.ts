import type { DownloadStore, StagedObject } from '../../src/calendar/downloads';

/** In-memory DownloadStore. Records every object and signing call; never touches a network. */
export class FakeDownloadStore implements DownloadStore {
    readonly objects = new Map<string, StagedObject>();
    readonly signed: { key: string; maxTtlSeconds: number }[] = [];
    putError: Error | null = null;
    signError: Error | null = null;
    /** Seconds the fake signer grants; defaults to the requested maximum. */
    grantSeconds: number | null = null;
    constructor(private readonly now: () => number = Date.now) {}

    async putObject(object: StagedObject, signal: AbortSignal): Promise<void> {
        if (signal.aborted) { throw new Error('aborted'); }
        if (this.putError !== null) { throw this.putError; }
        this.objects.set(object.key, { ...object, body: object.body.slice() });
    }

    async presignGet(key: string, maxTtlSeconds: number, signal: AbortSignal): Promise<{ url: string; expiresAt: Date }> {
        if (signal.aborted) { throw new Error('aborted'); }
        if (this.signError !== null) { throw this.signError; }
        this.signed.push({ key, maxTtlSeconds });
        const seconds = this.grantSeconds ?? maxTtlSeconds;
        return { url: `https://downloads.s3.example.invalid/${key}?X-Amz-Signature=fake`, expiresAt: new Date(this.now() + seconds * 1000) };
    }
}
