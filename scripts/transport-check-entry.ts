/**
 * Bundle entry for scripts/transport-check.mjs only; never deployed. It exposes the production managed-attachment fetcher
 * and policy, built with the same bundler settings as the Lambda, so the check runs that code under Node's real fetch. It
 * also exposes the iCloud backend, so the check can show that a resource href reaches the wire byte for byte under Node.
 */
export { AttachmentFetchError, createManagedAttachmentFetcher } from '../src/caldav/attachment-fetch';
export { createICloudBackend } from '../src/caldav/icloud';
export { checkManagedAttachmentUrl, MANAGED_ATTACHMENT_POLICY } from '../src/caldav/managed-attachment-policy';
export { MAX_DOWNLOAD_BYTES } from '../src/calendar/limits';
