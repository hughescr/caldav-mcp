/**
 * The production DownloadStore: one private S3 bucket (created by the bootstrap stack) and presigned GET links. The client
 * is created on first use, so reads and startup never touch S3. maxAttempts is 1: a retry would only spend the download's
 * 30 s budget. Objects use SSE-S3 (AES256) and `Cache-Control: private, no-store`; the bucket's lifecycle rule deletes
 * them after about a day.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { isValidBucketName } from '../config';
import { untilAborted, type DownloadStore } from './downloads';

/** The S3Client surface this store uses, so tests can stub it without any network. */
export interface S3ClientLike {
    send(command: PutObjectCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
    config: { credentials: () => Promise<{ expiration?: Date }> };
}

export interface S3DownloadStoreOptions {
    bucketName: string;
    client?: () => S3ClientLike;
    presign?: (client: S3ClientLike, command: GetObjectCommand, options: { expiresIn: number; signingDate: Date }) => Promise<string>;
    now?: () => number;
}

export function createS3DownloadStore(options: S3DownloadStoreOptions): DownloadStore {
    const { bucketName } = options;
    if (!isValidBucketName(bucketName)) { throw new Error('DOWNLOAD_BUCKET_NAME is not a valid S3 bucket name'); }
    const now = options.now ?? Date.now;
    let client: S3ClientLike | undefined;
    const lazyClient = (): S3ClientLike => {
        client ??= options.client?.() ?? new S3Client({ maxAttempts: 1 });
        return client;
    };
    const presign = options.presign ?? ((signer, command, presignOptions) => getSignedUrl(signer as S3Client, command, presignOptions));

    return {
        async putObject(object, signal) {
            await lazyClient().send(new PutObjectCommand({
                Bucket: bucketName,
                Key: object.key,
                Body: object.body,
                ContentLength: object.body.byteLength,
                ContentType: object.contentType,
                ContentDisposition: object.contentDisposition,
                CacheControl: 'private, no-store',
                ServerSideEncryption: 'AES256',
            }), { abortSignal: signal });
        },
        async presignGet(key, maxTtlSeconds, signal) {
            const signer = lazyClient();
            // The credential provider and the presigner take no abort signal: race the provider, and re-check afterwards.
            const credentials = await untilAborted(signer.config.credentials(), signal);
            if (signal.aborted) { throw new Error('download deadline passed'); }
            const start = now();
            // A presigned URL stops working when the signing credentials expire, so never promise longer than they last.
            const credentialSeconds = credentials.expiration === undefined ? maxTtlSeconds : Math.floor((credentials.expiration.getTime() - start) / 1000) - 5;
            const expiresIn = Math.min(maxTtlSeconds, credentialSeconds);
            if (!Number.isSafeInteger(expiresIn) || expiresIn < 1) { throw new Error('signing credentials expire too soon'); }
            const url = await untilAborted(presign(signer, new GetObjectCommand({ Bucket: bucketName, Key: key }), { expiresIn, signingDate: new Date(start) }), signal);
            if (signal.aborted) { throw new Error('download deadline passed'); }
            return { url, expiresAt: new Date(start + expiresIn * 1000) };
        },
    };
}
