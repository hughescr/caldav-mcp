#!/usr/bin/env bash
set -euo pipefail
: "${AWS_DEPLOYMENT_BUCKET_NAME:?Set this from the bootstrap ArtifactBucketName output}"
: "${AWS_EXECUTION_ROLE_ARN:?Set this from the bootstrap ExecutionRoleArn output}"
: "${SERVERLESS_ACCESS_KEY:?Set a Serverless Framework access key}"
: "${AUTH_KEYRING_PARAMETER:?Set the exact SSM keyring parameter name}"
: "${ALLOWED_APPLE_ID_HASHES:?Set the allowlisted account hashes (see bun run apple-id-hash); empty would lock everyone out}"
[[ "$AUTH_KEYRING_PARAMETER" == '/caldav-mcp/prod/auth-keyring' ]] || { echo 'Unexpected auth keyring parameter name' >&2; exit 1; }
node_modules/.bin/serverless deploy --stage prod
