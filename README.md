# caldav-mcp

A small remote MCP server that lets Claude clients read Apple iCloud calendars over CalDAV. It runs on AWS Lambda behind CloudFront, so it does not depend on a laptop being awake. It copies the security and deployment approach of [wildduck-mcp](https://github.com/hughescr/wildduck-mcp).

## Status

This is the phase 1 skeleton. It is built and not deployed. The phase 0 probe is written. Its read-only mode and its `--write` mode have each been run once against one real iCloud account, locally, on 2026-11-11. The probe's invite mode and its Lambda run have not been done. The phase 1 backend ran discovery, validation and `list_calendars` against that account.

- One tool exists: `list_calendars`. It returns each calendar's `id`, `displayName`, `components` and `color`, capped at 200, with a `truncated` flag. The `id` contains the account's numeric iCloud path.
- Calendar names and colors are untrusted data. Clients must never treat them as instructions.
- iCloud behaviour is confirmed only for what the two local runs covered (read-only and `--write`, one account). Invitations, behaviour from AWS addresses, the response to a wrong password and subscribed calendars are untested. For those the plan relies on other clients' published test results. [docs/plan.md](docs/plan.md) gives the status of each point, and [docs/probe.md](docs/probe.md) describes the probe.
- The auth and credential-storage code and the probe each had one independent review by a second Claude agent (same model family). The findings were fixed, except the items in "Accepted limitations" in [docs/plan.md](docs/plan.md).

Read next: [docs/plan.md](docs/plan.md) (goals, phases, open decisions, accepted limitations), [docs/probe.md](docs/probe.md) (the iCloud probe) and [docs/auth-design.md](docs/auth-design.md) (login and OAuth design).

## Account connection

A client discovers this server's own OAuth endpoints and opens one page at `/authorize`. That page shows the client name, the client's redirect host, the scopes requested, and two fields: Apple ID and app-specific password. There is no second consent page and no TOTP step. The form posts to `/auth/connect`.

Use an app-specific password that you create only for this connector. Apple lets you revoke each one on its own.

**The password is stored.** wildduck-mcp never stores a password. This server has to, because CalDAV has no session token. Every iCloud request sends the Apple ID and the app-specific password. The server keeps them like this:

- They are encrypted with AES-GCM, bound to the account and to this stored connection.
- The key lives in an SSM SecureString keyring, outside the database.
- They are never put in a cookie, a hidden field, a redirect or a log.
- The client only ever receives this server's own short-lived tokens.

An app-specific password is not limited to calendars. It also opens iCloud Mail and contacts. That is the weak point of this design. The mitigations are the dedicated, separately revocable password, the key held outside the database, the allowlist below and the fixed-host rule. See "Known weak point" in [docs/plan.md](docs/plan.md).

### Allowlist

Only Apple IDs you list can connect. Without it, anyone could attach their own account to this deployment.

The list is the environment variable `ALLOWED_APPLE_ID_HASHES`: account hashes separated by commas. An account hash is the base64url SHA-256 of the lower-cased Apple ID with a fixed prefix. It is a pseudonym, not a secret. Produce one with:

```sh
bun run apple-id-hash
```

The script reads the Apple ID from a prompt or from stdin, never from arguments, and prints only the hash.

An empty or missing list means nobody can connect. A malformed entry stops the server from starting. The list is checked at login before any request to Apple, at code exchange and token refresh, and on every `/mcp` request. Not being on the list, a badly formed Apple ID and a wrong password all show the same failure page.

The login throttle allows 5 attempts per account in each 15-minute window. An attempt is reserved before the request to iCloud. A wrong password keeps its attempt counted until the window ends. A successful login or a temporary iCloud failure releases it. A full window is refused without contacting iCloud.

### Scopes

- `calendar:read` is the default. It allows `list_calendars`.
- `calendar:write` is reserved for later phases. No tool uses it yet.
- `calendar:invite` is also reserved. Saving an event with attendees may make iCloud send invitations, so requesting this scope adds a separate required checkbox on the login page.

### Token lifetimes

These match wildduck-mcp. Access tokens last five minutes. Grants and connections last at most 180 days. Refresh tokens rotate; an identical retry within ten seconds gets the same response, and a replay of an old token after that revokes the client's grant. Revocation at `/revoke` ends the access and refresh tokens.

The stored password is checked against iCloud when a code is issued or exchanged and when a refresh token is used. It is not checked on each `/mcp` request. The tool call itself reaches iCloud.

If iCloud answers a tool call, or a token request, with HTTP 401, the connection is marked `reconnect_required` and the user must connect again. A temporary iCloud or network problem returns `temporarily_unavailable` and keeps the grant. A 403 from iCloud is treated as temporary.

Replacing the stored password ends every existing grant for that account. Each client must authorize again. Only a repeat login with the identical, still-active credential keeps existing grants. See [docs/auth-design.md](docs/auth-design.md).

### Accepted limitations

- Allowlist membership is observable to someone probing the login endpoint.
- Anyone who knows an allowlisted Apple ID can block new connections for that account for 15 minutes at a time. Existing grants keep working. Each such attempt is a real failed sign-in at Apple.
- There is no "forget this account" function. A stored password stays sealed in the table until it is replaced or the record expires (180 days).

## Fixed upstream hosts

The login page accepts no server URL. The server sends requests only to `caldav.icloud.com` and to hosts shaped like `pNN-caldav.icloud.com`, which iCloud's discovery returns for each account. Requests must use HTTPS on the default port with no embedded credentials. Redirects are followed at most three times, and only to hosts that pass the same rule. A stored URL is checked again after decryption, every time it is used. Credentials are never sent anywhere else.

## Local validation

Use Node.js 26, Bun 1.4.4 or newer, `zip` and git-flow.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run validate
bun run dev
```

`bun run validate` runs the TypeScript check, Oxlint, the tests, the Lambda bundle and a smoke test on Node 26. `bun run dev` starts a local server on port 3000 (set `PORT` to change it). Leave the AWS settings unset and the server makes no AWS calls; see `.env.example`. Tests use injected fakes and never contact Apple or AWS.

## Runtime and storage

Environment variables:

- `PUBLIC_BASE_URL`: the canonical HTTPS origin. In production it is imported from the bootstrap stack. It is never taken from the Host header.
- `AUTH_KEYRING_PARAMETER`: the SSM parameter name, `/caldav-mcp/prod/auth-keyring`.
- `CREDENTIAL_TABLE_NAME`: the DynamoDB table.
- `ALLOWED_APPLE_ID_HASHES`: the allowlist above. Empty means nobody can connect.

Provision the keyring separately as an SSM Standard SecureString under the AWS-managed `aws/ssm` key. It is a new keyring. Never share it with wildduck-mcp. The shape is `{"activeKeyId":"v1","keys":{"v1":"<base64 of 32 random bytes>"}}`, at most four KiB. Generate the bytes in memory and send the value through stdin or API request data, not through command arguments, files or logs. CloudFormation does not create it. The runtime role can only read that one parameter. The CI deploy role is denied reading or writing its value, and is denied direct access to the table's items. It can still deploy code to the function, and that code runs with the runtime role. Anyone who can read both the keyring and the table, or who can deploy code, can decrypt stored passwords. The key is the AWS-managed `aws/ssm` key, so any principal in the account with `ssm:GetParameter` and table read can decrypt too.

To rotate, add a new key and change `activeKeyId`. Keep old keys while records or tokens still depend on them.

The DynamoDB table `caldav-mcp-prod-state` is provisioned at exactly 1 read and 1 write capacity unit, with no indexes and no autoscaling. The login page reads it before authentication, so a small burst of unauthenticated requests can exhaust it and make the service return 503. It is retained when the stack is deleted. Keys use the `caldav-mcp#` prefix, and runtime IAM enforces that prefix. The `expiresAt` TTL is only eventual cleanup; expiry is also checked on every read.

Lambda runs `nodejs26.x` on arm64 with 1024 MB, a 60 second timeout and 14 days of logs. The server holds no calendar data. Each tool call reads iCloud when it needs to.

## Deployment and rollback

Deployment is disabled. Pushes and pull requests to `main` and `develop` only validate and build. The deploy job runs only on `main` and only when the repository variable `DEPLOY_ENABLED` is `true`. Nothing in the workflow turns that on. When it runs, it uses short-lived GitHub OIDC credentials and deploys the exact artifact the verify job built. The verify job has no AWS credentials. No long-lived AWS key is stored in GitHub. Actions are pinned by tag, not by commit, and the deploy job has no approval gate.

The public hostname is `caldav-mcp.rungie.com`. The template pins it as the only allowed value of `PublicDomainName`. `HostedZoneId` is the same existing zone wildduck-mcp uses.

The bootstrap stack creates the CloudFront distribution, two challenge-header policies, DNS records in the existing `rungie.com` zone, the artifact bucket and two IAM roles. It needs the existing `GitHubOIDCProvider-Arn` and `CertificateAccepterLambda-Arn` exports. The distribution's origin is the `FunctionUrlOrigin` parameter, an existing Function URL origin without a trailing slash. The service stack imports the bootstrap export `caldav-mcp-prod-public-origin`.

First deployment, run by an administrator. This procedure has not been executed yet for this repository. It follows the stages wildduck-mcp went through: roles and bucket first, then the service, then the distribution on the real Function URL.

1. Create the bootstrap stack with a placeholder origin that is syntactically valid:

   ```sh
   aws cloudformation deploy --region us-west-2 \
     --stack-name caldav-mcp-bootstrap --template-file infra/bootstrap.yml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides "FunctionUrlOrigin=https://placeholder.lambda-url.us-west-2.on.aws"
   ```

   Until step 5 is done, the public hostname answers with CloudFront origin errors.
2. Read the stack outputs and set the repository variables `AWS_DEPLOY_ROLE_ARN`, `AWS_DEPLOYMENT_BUCKET_NAME` and `AWS_EXECUTION_ROLE_ARN`.
3. Provision the keyring and set `AUTH_KEYRING_PARAMETER=/caldav-mcp/prod/auth-keyring`. Set `ALLOWED_APPLE_ID_HASHES` from `bun run apple-id-hash`; the deploy refuses to start if it is empty. Add `SERVERLESS_ACCESS_KEY` as a repository secret, through the secret UI or stdin.
4. Set `DEPLOY_ENABLED=true` and deploy from `main`. This creates the service and its real Function URL. The CI verification step at the end of that run fails while the placeholder is in place; the deployment itself is not affected.
5. Update the bootstrap stack with the real Function URL origin, without a trailing slash. It is the `ApiLambdaFunctionUrl` output of the service stack `caldav-mcp-prod`:

   ```sh
   aws cloudformation deploy --region us-west-2 \
     --stack-name caldav-mcp-bootstrap --template-file infra/bootstrap.yml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides "FunctionUrlOrigin=$FUNCTION_URL_ORIGIN"
   ```

6. Run `node scripts/verify-deployment.mjs` with AWS credentials for the account.

Keep passing the real `FunctionUrlOrigin` on later bootstrap updates. Change it if the Function URL is ever recreated.

The OIDC trust pins the immutable owner and repository IDs and the `main` branch. Verify the subject format with `gh api repos/hughescr/caldav-mcp/actions/oidc/customization/sub`.

`bun run package` builds a package locally with placeholder settings and no AWS access. `bun run deploy` refuses missing settings. Never deploy placeholders with raw Serverless commands.

After a deployment, `scripts/verify-deployment.mjs` checks the live service. It checks the version, readiness, the Bearer and Basic challenge headers, discovery metadata, and that the live Lambda has a non-empty allowlist (its value is not printed). It then registers a throwaway client and cancels the login page, which exercises the gateway without logging in any account. It never sends a real Apple ID or password.

Rollback: use the published Lambda versions and the previous artifact. Restore the previous reviewed release and configuration, then verify health, version, discovery and readiness. Do not use `serverless remove` as a rollback. Keep the keyring keys that surviving records need. The table, the artifact bucket, the distribution, the header policies and the certificate are retained after stack deletion. Keep the ACM validation DNS records for renewal.

## Branches and releases

This repository uses gitflow, as wildduck-mcp does. Work happens on `develop`. `main` receives merges only for releases, through the `postversion` script, and deployments run from `main`. Tags are bare package versions. Set up git-flow with `bun run gitflow:init`. From a clean `develop`, run `bun pm version patch --no-git-tag-version`. The postversion script updates the lockfile, validates, commits, finishes the git-flow release and merges `main` back into `develop`. Nothing is pushed automatically. `bun run test:release` tries the release path in a disposable repository.
