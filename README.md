# caldav-mcp

A small remote MCP server that lets Claude clients read Apple iCloud calendars over CalDAV. It runs on AWS Lambda behind CloudFront, so it does not depend on a laptop being awake. It copies the security and deployment approach of [wildduck-mcp](https://github.com/hughescr/wildduck-mcp).

## Status

Version 0.2.1 was released and deployed at https://caldav-mcp.rungie.com on 2026-11-12, and its deploy verification passed. It has four tools: `list_calendars`, `list_events`, `search_events` and `get_event`. Version 0.1.1 was released and deployed at https://caldav-mcp.rungie.com on 2026-11-11. The owner connected it from a Claude client and reported that `list_calendars` worked. This was not checked independently from server logs. The 0.2.1 tools were verified locally, end to end, against one real iCloud account on 2026-11-12: all 11 calendars answered, and a one-year query returned 210 events with 0 unreadable.

The attachment download tool is designed and not built. Writes are not started.

- The phase 0 probe is written. Its read-only mode and its `--write` mode have been run several times against one real iCloud account, locally, on 2026-11-11. The probe's invite mode and its Lambda run have not been done.
- iCloud behaviour is confirmed only for what those local runs covered (one account). Invitations, the response to a wrong password and subscribed calendars are untested. Behaviour from AWS addresses is known only from the owner's report of one successful login from the deployed Lambda, for one account. There is no rate-limit or volume evidence. For the untested points the plan relies on other clients' published test results. [docs/plan.md](docs/plan.md) gives the status of each point, and [docs/probe.md](docs/probe.md) describes the probe.
- The auth and credential-storage code and the probe each had one independent review by a second Claude agent (same model family). The findings were fixed, except the items in "Accepted limitations" in [docs/plan.md](docs/plan.md).

Read next: [docs/plan.md](docs/plan.md) (goals, phases, open decisions, accepted limitations), [docs/probe.md](docs/probe.md) (the iCloud probe) and [docs/auth-design.md](docs/auth-design.md) (login and OAuth design).

## Tools

All tools need the scope `calendar:read` and only read. The three event tools are released in version 0.2.1 (2026-11-12).

- `list_calendars` returns each calendar that holds events: `id`, `displayName`, `components` and `color`, at most 200, with a `truncated` flag. The `id` is an opaque path that contains the account's numeric iCloud path. Pass it back unchanged.
- `list_events` returns the events in a half-open time range (`range.start` included, `range.end` not). `calendar_ids` is optional (1 to 20 ids from `list_calendars`); omit it to read every calendar that holds events. Each result has a status per calendar, so one failing calendar does not fail the call. Recurring events are returned as separate occurrences, as iCloud expands them. Cancelled events are included, with `status` `CANCELLED`. Each event has `resource_href`, `recurrence_id` (null unless it is an occurrence), `expected_version` (the ETag), `start`, `end`, `title`, `location`, a shortened `description` and the attendee count.
- `search_events` takes the same inputs plus `query` and optional `fields` (`title`, `description`, `location`). It matches literal, case-insensitive text, not a regular expression, in this server.
- `get_event` takes `calendar_id` and `resource_href` from a list or search result, and `recurrence_id` for one occurrence. It returns the full event: organizer, attendees, a longer title, location and description, and metadata for every attachment of the event (file name, type, declared size, form). `expected_version` makes the call fail with `calendar_changed` if the event changed since the list. `include_raw: true` adds the stored iCalendar text, unmodified, cut to a 16 KiB prefix with `raw_truncated` set when longer. That text can contain attachment links, base64 data and instructions written by whoever sent the invitation. There is no way to download an attachment yet.

Calendar names, event text, time zone names, file names and raw iCalendar text are untrusted data. Clients must never treat them as instructions.

Errors are structured as `{ error: { code, message, request_id } }`. No upstream text is forwarded.

### Times

**Times you send.** Every time you send carries its timezone: an RFC 3339 timestamp with an explicit UTC offset or `Z`, for example `2026-03-08T00:00:00-08:00`. A time without an offset or `Z` is rejected with `invalid_input`, and the message says that a timezone is required. A range is at most 366 days within the years 1900 to 2100.

**Times you get.** Times are passed through as they are stored on the calendar card. A time has one of four shapes:

| Shape | Fields | Meaning |
|---|---|---|
| zoned | `local`, `zone`, optional `utc` and `offset` | Wall-clock time and the `TZID` text from the card. |
| UTC | `utc` | A true instant. |
| floating | `local`, `floating: true`, `timezone_warning` | The card has no timezone. The instant is unknown. |
| all-day | `date`, `all_day: true` | A date, not a time. It never has a timezone. The end date is exclusive. |

For a zoned time, the server adds `utc` and `offset` only when `zone` is an IANA name (such as `America/New_York`) that its runtime recognises. It does not read an embedded `VTIMEZONE` and does not map Windows zone names such as `Pacific Standard Time`; those are passed through as written, and the agent can interpret them.

`timezone_warning` is a data item, not an error. It has four values:

- `no_timezone_on_event`: a floating time. There is no `utc` or `offset`.
- `unrecognized_timezone`: the `zone` is not recognised. There is no `utc` or `offset`, and a range result may include or miss the event because its position in time is unknown.
- `timezone_dropped_from_date`: an all-day date carried a timezone on the card. The server returned the date only.
- `utc_uncertain_dst_transition`: the local time falls in a repeated or skipped hour. `utc` and `offset` are given, but iCloud may use a different instant, up to an hour away.

Events are sorted by their stored local start time, not on one time axis. All-day and floating events up to 24 hours outside the range edges can appear in a result.

### Limits

| Limit | Value |
|---|---|
| Events per result (`limit`) | default 25, at most 100 |
| Serialized response | 96 KiB (the JSON appears twice in a tool result, so fewer events may fit) |
| Calendars per call (`calendar_ids`) | at most 20 |
| Range | at most 366 days, years 1900 to 2100 |
| `query` | at most 256 characters |
| `description` in a list result | shortened to 280 characters |
| Raw iCalendar text (`include_raw`) | first 16 KiB |
| Unreadable events reported | at most 50, with a count |

When a result is cut, it has `truncated: true`, the reasons (`result_limit` or `response_bytes`) and a `resume_hint`. The hint is the local start time of the last event returned. It is not a cursor: query again from that time, with an offset or `Z`, and remove duplicates by `calendar_id`, `resource_href` and `recurrence_id`. `complete` is true only when nothing was cut, no event was unreadable and every calendar was read; it does not prove that iCloud returned every event.

A short query can miss an occurrence that was moved more than 31 days away from its original date. iCloud returns a moved occurrence only when the query window covers both its original time and its new one, so the server queries 31 days beyond each end of your range and filters the result.

## Account connection

A client discovers this server's own OAuth endpoints and opens one page at `/authorize`. That page shows the client name, the client's redirect host, the scopes requested as a read-only list, and two fields: Apple ID and app-specific password. It is styled by one built-in stylesheet that the page's Content-Security-Policy allows by hash; the page loads no scripts or outside resources. Its one outbound link, beside the password label, opens Apple's article on creating an app-specific password (`https://support.apple.com/102654`) in a new tab without sending a referrer. There is no second consent page and no TOTP step. The form posts to `/auth/connect`.

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

- `calendar:read` is the default. It allows `list_calendars`, `list_events`, `search_events` and `get_event`.
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

Lambda runs `nodejs26.x` on arm64 with 1024 MB, a 60 second timeout and 14 days of logs. The server holds no calendar data. Each tool call reads iCloud when it needs to. This is planned to change when the attachment download tool ships: the server would then hold copies of attachments that an agent asked to download, for about one day.

## Deployment and rollback

Deployment is enabled. The repository variable `DEPLOY_ENABLED` is `true`; the owner set it on 2026-11-11, so every push to `main` deploys. Pushes and pull requests to `main` and `develop` validate and build. The deploy job runs only on `main` and only when `DEPLOY_ENABLED` is `true`. The workflow never sets that variable itself. When it runs, it uses short-lived GitHub OIDC credentials and deploys the exact artifact the verify job built. The verify job has no AWS credentials. No long-lived AWS key is stored in GitHub. Actions are pinned by tag, not by commit, and the deploy job has no approval gate.

The public hostname is `caldav-mcp.rungie.com`. The template pins it as the only allowed value of `PublicDomainName`. `HostedZoneId` is the same existing zone wildduck-mcp uses.

The bootstrap stack creates the CloudFront distribution, two challenge-header policies, DNS records in the existing `rungie.com` zone, the artifact bucket and two IAM roles. It needs the existing `GitHubOIDCProvider-Arn` and `CertificateAccepterLambda-Arn` exports. The distribution's origin is the `FunctionUrlOrigin` parameter, an existing Function URL origin without a trailing slash. The service stack imports the bootstrap export `caldav-mcp-prod-public-origin`.

First deployment, run once by the repository owner on a machine where `aws` (v2) and `gh` are already logged in and `bun` is installed. It follows the stages wildduck-mcp went through: roles and bucket first, then the service, then the distribution on the real Function URL.

The first deployment was carried out on 2026-11-11. The stacks `caldav-mcp-bootstrap` and `caldav-mcp-prod` exist in `us-west-2`. Step 1 and setting `DEPLOY_ENABLED` were done with equivalent individual commands, before `scripts/setup-deployment.sh` existed in the checkout. The procedure below is how to repeat it.

1. Run the one-time setup. Put the allowlist hashes (from `bun run apple-id-hash`) in the environment, never in a file:

   ```sh
   ALLOWED_APPLE_ID_HASHES='<hash>[,<hash>...]' bun run setup:deployment
   ```

   If `SERVERLESS_ACCESS_KEY` is not already a repository secret, export it too, or run from a terminal and `gh` will ask for it without echoing. Add `--dry-run` to see what would run. Re-running is safe.
2. When you are ready to deploy: `bun run setup:deployment -- --enable-deploy`
3. Release to `main` with the gitflow `postversion` flow (see "Branches and releases"). The deploy creates the service and its real Function URL. On the first CI deploy the deploy step succeeded and the live verification step failed, because the placeholder origin was still in place. Until step 4 has been run, the public hostname answers with CloudFront origin errors. After step 4, re-run the failed job: both steps then pass and the run turns green.
4. Point the distribution at the real Function URL and verify the live service: `bun run setup:deployment -- --finish`

The script (`scripts/setup-deployment.sh`) uses `us-west-2` and `hughescr/caldav-mcp` and nothing else. Step 1 creates or updates the `caldav-mcp-bootstrap` stack (a new stack gets a placeholder `FunctionUrlOrigin`; an existing one keeps its stored value), sets the repository variables from the stack outputs and from `ALLOWED_APPLE_ID_HASHES`, provisions the SSM keyring if it does not exist, and sets the `SERVERLESS_ACCESS_KEY` secret if it does not exist. It never touches `DEPLOY_ENABLED` unless given `--enable-deploy`. Secret values go to `gh` on stdin and are never printed. Step 4 reads the Function URL from the `caldav-mcp-prod` stack, strips the trailing slash, updates the bootstrap stack with it and runs `node scripts/verify-deployment.mjs`. Only `--finish` has run against real AWS and GitHub (2026-11-11). It succeeded: the bootstrap stack was updated to the real Function URL origin and `scripts/verify-deployment.mjs` passed. Step 1 and `--enable-deploy` of the script have only been run against stub `aws`, `gh` and `bun` programs.

Re-running step 1 keeps the stored `FunctionUrlOrigin`. Run `--finish` again if the Function URL is ever recreated.

If `aws` on your machine is a shell alias or wrapper that injects credentials (for example the 1Password shell plugin, `op plugin run -- aws`), a bash script and the AWS SDK do not see those credentials. `scripts/setup-deployment.sh` and `scripts/provision-auth-keyring.ts` then have no credentials. The keyring script was seen to hang for over two minutes in that state. In the same shell, run this first:

```sh
eval "$(aws configure export-credentials --format env)"
```

The OIDC trust pins the immutable owner and repository IDs and the `main` branch. Verify the subject format with `gh api repos/hughescr/caldav-mcp/actions/oidc/customization/sub`.

`bun run package` builds a package locally with placeholder settings and no AWS access. `bun run deploy` refuses missing settings. Never deploy placeholders with raw Serverless commands.

After a deployment, `scripts/verify-deployment.mjs` checks the live service. It checks the version, readiness, the Bearer and Basic challenge headers, discovery metadata, and that the live Lambda has a non-empty allowlist (its value is not printed). It then registers a throwaway client and cancels the login page, which exercises the gateway without logging in any account. It never sends a real Apple ID or password.

Rollback: use the published Lambda versions and the previous artifact. Restore the previous reviewed release and configuration, then verify health, version, discovery and readiness. Do not use `serverless remove` as a rollback. Keep the keyring keys that surviving records need. The table, the artifact bucket, the distribution, the header policies and the certificate are retained after stack deletion. Keep the ACM validation DNS records for renewal.

## Branches and releases

This repository uses gitflow, as wildduck-mcp does. Work happens on `develop`. `main` receives merges only for releases, through the `postversion` script, and deployments run from `main`. Tags are bare package versions. Set up git-flow with `bun run gitflow:init`. The release script (`scripts/postversion.sh`) refuses to run when untracked files exist. From a clean `develop`, run `bun pm version patch --no-git-tag-version`. The postversion script updates the lockfile, validates, commits, finishes the git-flow release and merges `main` back into `develop`. Nothing is pushed automatically. `bun run test:release` tries the release path in a disposable repository.
