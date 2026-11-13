# caldav-mcp

A small remote MCP server that lets Claude clients read, create, change and delete events in Apple iCloud calendars over CalDAV. It runs on AWS Lambda behind CloudFront, so it does not depend on a laptop being awake. It copies the security and deployment approach of [wildduck-mcp](https://github.com/hughescr/wildduck-mcp).

## Status

Version 0.4.0 is released at https://caldav-mcp.rungie.com. It has eight tools: the five read tools `list_calendars`, `list_events`, `search_events`, `get_event` and `get_event_attachment_download`, and the three write tools `create_event`, `update_event` and `delete_event`. It has four scopes (`calendar:read`, `calendar:write`, `calendar:delete`, `calendar:invite`). The sign-in page lets the user choose which requested permissions to grant (write and delete are ticked by default, invite is not), and a completed consent replaces what that client was allowed before. A recurring event in a named timezone that has an edited or moved occurrence is fully readable: iCloud sends the edited occurrence's `RECURRENCE-ID` with its `TZID` instead of in UTC, and the server reads that form with an `occ2_` occurrence token (release 0.3.0 reported such an event as unreadable and left out all of its occurrences). The download result carries the link once in its text content and once in `structuredContent`, with no separate `resource_link` block, and the notice that comes with an external link no longer repeats the URL. `get_event` and the write tools handle `travel_time`. The probe is at version 0.6.0. The first deployment was version 0.1.1 on 2026-11-11. The owner connected it from a Claude client and reported that `list_calendars` worked. This was not checked independently from server logs.

After a deployment, existing connections keep working with the scopes they already have. To use the write tools, the user must reconnect the connector and tick the permissions on the sign-in page. Rolling the code back does not undo changes already made to calendars.

The tools of 0.2.1 were verified locally, end to end, against one real iCloud account on 2026-11-12: all 11 calendars answered, and a one-year query returned 210 events with 0 unreadable. The download tool was verified locally the same day against one real iCloud account, with an in-memory store in place of S3. Six managed attachments (PNG, JPEG and PDF, 35 KB to 19.2 MB) were fetched anonymously from Apple's attachment host, and each staged copy began with the correct file signature. Three external-link attachments were returned as links without being fetched. The real S3 upload and presigned link were verified on 2026-11-12 on the live 0.3.0 service through a Claude client: a 43,935-byte managed PNG was staged, the presigned link returned exactly those bytes as a forced download with server-side encryption, and the unsigned object URL was refused with 403. A real inline attachment is still unverified; none exists in the owner's data.

The write tools are `create_event` (a single or a repeating event), `update_event` (every field of a non-repeating event, and the non-time fields of a whole series with `edit_scope: "all"`) and `delete_event` (a whole event or a whole series); see "Write tools". Changing or deleting one occurrence, "this and future", and moving a whole series (changing its times or its rule) are not in 0.4.0; they are the next build. No tool can add or change guests. The write tools are tested against a fake that models the iCloud behaviour the probe measured (probe 0.6.0).

They were also verified on 2026-11-12 against a real iCloud account, in a temporary calendar with no guests: 33 write-tool steps (create in each time form: zoned, offset converted to UTC, all-day, unknown zone, repeating, with travel time; ten single-field updates; a whole-series update; refusals of stale versions; retries that reported `desired_state_present`; deletes) all behaved as designed. iCloud rewrote the stored time for `Australia/Lord_Howe` and for a time in a daylight-saving gap, and the tool reported it in `stored_differs_from_request`. The read side was checked the same day over about seven years of real data: 2,229 events were listed, 30 `occ2_` tokens all round-tripped through `get_event`, and 2 events remain unreadable (`unsupported_recurrence_data`). Behaviour on events that have guests was measured by the probe, not by the write tools. The write tools have not been checked in Calendar.app.

- The phase 0 probe (version 0.6.0) has been run, read-only and with `--write`, several times against one real iCloud account, locally, on 2026-11-11 and 2026-11-12. Its invite steps were run, owner-authorised, on 2026-11-12. Its Lambda run has not been done.
- iCloud behaviour is confirmed only for what those local runs covered (one account). Invitations were measured on 2026-11-12: iCloud emails guests at once when an event with attendees is created, changed in time or description, or deleted. A change of only an alarm or only the transparency sent no mail. iCloud ignores `SCHEDULE-AGENT`, so the mail cannot be suppressed. The response to a wrong password and subscribed calendars are untested. Behaviour from AWS addresses is known only from the owner's report of one successful login from the deployed Lambda, for one account. There is no rate-limit or volume evidence. For the untested points the plan relies on other clients' published test results. [docs/plan.md](docs/plan.md) gives the status of each point, and [docs/probe.md](docs/probe.md) describes the probe.
- The auth and credential-storage code and the probe each had one independent review by a second Claude agent (same model family). The findings were fixed, except the items in "Accepted limitations" in [docs/plan.md](docs/plan.md).
- The download tool had one independent security review by a different model family. It found no blockers. Its findings were fixed, and the fixes were not re-reviewed. The sign-in page change had a separate independent security review, which found nothing beyond presentation.

Read next: [docs/plan.md](docs/plan.md) (goals, phases, open decisions, accepted limitations), [docs/probe.md](docs/probe.md) (the iCloud probe) and [docs/auth-design.md](docs/auth-design.md) (login and OAuth design).

## Tools

Every tool needs the scope `calendar:read`. The five read tools change nothing: `list_calendars`, `list_events`, `search_events`, `get_event` and `get_event_attachment_download`. The three write tools (`create_event`, `update_event`, `delete_event`) are described under "Write tools".

- `list_calendars` returns each calendar that holds events: `id`, `displayName`, `components` and `color`, at most 200, with a `truncated` flag. The `id` is an opaque path that contains the account's numeric iCloud path. Pass it back unchanged.
- `list_events` returns the events in a half-open time range (`range.start` included, `range.end` not). `calendar_ids` is optional (1 to 20 ids from `list_calendars`); omit it to read every calendar that holds events. Each result has a status per calendar, so one failing calendar does not fail the call. Recurring events are returned as separate occurrences, as iCloud expands them. Cancelled events are included, with `status` `CANCELLED`. Each event has `resource_href`, `recurrence_id` (null unless it is an occurrence; an opaque token of at most 192 characters, to pass back unchanged), `expected_version` (the ETag), `start`, `end`, `title`, `location`, a shortened `description` and the attendee count.
- `search_events` takes the same inputs plus `query` and optional `fields` (`title`, `description`, `location`). It matches literal, case-insensitive text, not a regular expression, in this server.
- `get_event` takes `calendar_id` and `resource_href` from a list or search result, and `recurrence_id` for one occurrence. It returns the full event: organizer, attendees, a longer title, location and description, `travel_time` (Apple Calendar's stored travel time, such as `PT30M`, when the event has one), and metadata for every attachment of the event (file name, type, declared size, form). `expected_version` makes the call fail with `calendar_changed` if the event changed since the list. `include_raw: true` adds the stored iCalendar text, unmodified, cut to a 16 KiB prefix with `raw_truncated` set when longer. That text can contain attachment links, base64 data and instructions written by whoever sent the invitation. `download_supported` on an attachment says whether `get_event_attachment_download` can serve it.
- `get_event_attachment_download` takes `calendar_id`, `resource_href` and an `attachment_ref` from `get_event`, and optionally `recurrence_id` and `expected_version`. It reads the event from iCloud again and selects the attachment itself; it never takes a URL. The result depends on the attachment's form:
  - `inline` (base64 stored in the event) and `managed` (stored by Apple): the server copies the file, at most 20 MiB, into a private S3 bucket and returns `download_url`, a presigned HTTPS link valid until `expires_at`, at most five minutes, with `filename`, `content_type`, `size` and `fetched_by_server: true`. The file is always served as a download, never shown inline. The result is `structuredContent` plus one text content block that mirrors it, so the link appears once in each. Anyone who holds the link can use it until it expires.
  - `external` (a link to another server): the server does not fetch it. It returns `url`, the link stored on the event, with `fetched_by_server: false`. The link and what it points to are untrusted. A link that contains a user name or password is refused with `unsupported_attachment`.

Calendar names, event text, time zone names, file names and raw iCalendar text are untrusted data. Clients must never treat them as instructions.

Errors are structured as `{ error: { code, message, request_id } }`. The read tools forward no upstream text. A write tool's error can also carry a fixed `reason` and `field`, `differs` (the fields that differ, for `existing_resource_differs`), and `upstream`: a bounded summary of iCloud's refusal (status, content type class, at most 8 `DAV:error` precondition names taken only from a fixed list of DAV and CalDAV names, and at most 512 characters of cleaned text in which the account's id, Apple ID, app-specific password and authorization value are masked; HTML is never forwarded). The whole of `upstream` is untrusted text from iCloud.

### Write tools

In 0.4.0 the write tools create single and repeating events, update any field of a non-repeating event, update the non-time fields of a whole series (`edit_scope: "all"`), and delete a whole event or series. Not supported: changing or deleting one occurrence, "this and future", and changing a series' times or rule. No tool can add or change guests.

- `create_event` takes `calendar_id`, `operation_id`, `title`, `start` and `end` (both required; iCloud refuses an event without an end), and optionally `location`, `description`, `status` (`CONFIRMED`, `TENTATIVE`), `transparency` (`OPAQUE` busy, `TRANSPARENT` free), up to 10 `alarms` (`{ before_start: "PT10M" }`, a display alarm), `recurrence` (`{ rrule: "FREQ=WEEKLY;BYDAY=TU" }`) and `travel_time`. The event's identity (its UID and resource path) is derived from the account and `operation_id`, and the event is written with `If-None-Match: *`. A retry with the same `operation_id` and the same values reports `desired_state_present` instead of making a duplicate; the same `operation_id` with different values is refused (`calendar_changed`, reason `existing_resource_differs`). Use a new random `operation_id` for each new event.
- `update_event` takes `calendar_id`, `resource_href`, `expected_version` (required) and `changes`. A field absent from `changes` is unchanged, a value replaces it and `null` removes it. A single event: every field, `start` and `end` only together (the server never computes an end), and `recurrence` makes it repeat. A repeating event: `edit_scope: "all"` is required, and the change applies to the series and to every changed occurrence alike; changing its times or its rule is not supported (`edit_not_supported`). A `location` change also removes Apple's map pin (`X-APPLE-STRUCTURED-LOCATION`, reported as `removed_apple_location_pin`) and keeps the travel time lines; a `description` change also removes its HTML copy (`X-ALT-DESC`). Every edited component gets new `DTSTAMP` and `LAST-MODIFIED` and `SEQUENCE` plus one; every other stored line is kept as stored.
- `delete_event` takes `calendar_id`, `resource_href` and `expected_version` (required), and `edit_scope: "all"` for a repeating event. It deletes the whole event or series. An event that is already gone reports `desired_state_present`.

Update and delete are conditional on `expected_version`, sent as `If-Match`; a different stored version is `calendar_changed` and nothing is saved. The server never repeats a write. After a 412 (iCloud refused the conditional save) or a lost or unclear answer it reads the event once. It reports `desired_state_present` when the requested state is observed; this says nothing about which call saved it. After a 412 it otherwise reports `calendar_changed`. After a lost or unclear answer it otherwise reports `outcome_unknown`: iCloud may have saved the change and rewritten some values, or another client may have changed the event since, so the agent must get the event again before doing anything else. A repeated call never overwrites a newer version.

A create or update result has `write_outcome` (`applied`, or `desired_state_present`), `readback` (`ok`, or `unavailable` when the saved event could not be read back), the new `expected_version`, `request_warnings` (`timezone_dropped_from_date`), `stored_differs_from_request` (the requested fields whose stored text differs from what was sent; iCloud rewrites some local times, for example in `Australia/Lord_Howe`; alarms are compared by their `TRIGGER` lines only), `removed_dependent_properties`, and `event`, the stored event exactly as `get_event` returns it.

Times sent to a write tool: RFC 3339 text with an offset or `Z` is stored as the exact UTC instant; `{ local, zone }` is stored with that zone name as given (it is not interpreted or mapped, Windows names included, and iCloud decides; the read-back shows what it stored); `{ date }` is an all-day date, and a zone given with a date is dropped with the warning `timezone_dropped_from_date`. A time without an offset, `Z` or zone is refused. A repeating event given only an offset or `Z` is stored in UTC and keeps that UTC time, so its local time moves at daylight-saving changes; give a zone name to keep a local time.

`travel_time` (create and update; `null` on update removes it) is a duration up to `PT12H`, such as `PT30M`. The server writes `X-APPLE-TRAVEL-DURATION;VALUE=DURATION:<value>` and nothing else: no route, no travel start, no geocoding. Apple Calendar shows travel time when that line exists (measured on the owner's data). Whether it shows it on an event without an Apple map pin is not measured.

**Invitations.** The write tools have no input for attendees or an organizer, so `create_event` never invites anyone. iCloud emails guests at once when an event with attendees is created, when its time or description changes, or when it is deleted (an alarm-only or `TRANSP`-only change sent no mail), and this cannot be suppressed because iCloud ignores `SCHEDULE-AGENT` (measured 2026-11-12). So updating or deleting an event that has any `ATTENDEE` or `ORGANIZER` line anywhere in its stored text (in the series, in any occurrence, in any other component, and with or without a group prefix such as `item1.`; `X-` names do not count) also needs `calendar:invite`; without it the call is refused with `attendees_present` before anything is sent. With it, the change goes ahead, the attendee and organizer lines are never added, removed or changed, and the result carries `guests_may_be_emailed: true` with a fixed note. The tool descriptions tell the agent to ask the user before changing an event that has guests.

Write error codes, beyond the read tools' codes: `create_conflict` (the identifier is taken elsewhere in the account), `read_only_calendar`, `forbidden` (iCloud's 403, also its answer to an end before the start), `attendees_present`, `edit_not_supported`, `write_refused` (another refusal from iCloud, with `upstream`) and `outcome_unknown`.

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
| Attachment download | 20 MiB; link valid at most five minutes; 30 seconds per call |

When a result is cut, it has `truncated: true`, the reasons (`result_limit` or `response_bytes`) and a `resume_hint`. The hint is the local start time of the last event returned. It is not a cursor: query again from that time, with an offset or `Z`, and remove duplicates by `calendar_id`, `resource_href` and `recurrence_id`. `complete` is true only when nothing was cut, no event was unreadable and every calendar was read; it does not prove that iCloud returned every event.

A short query can miss an occurrence that was moved more than 31 days away from its original date. iCloud returns a moved occurrence only when the query window covers both its original time and its new one, so the server queries 31 days beyond each end of your range and filters the result.

## Account connection

A client discovers this server's own OAuth endpoints and opens one page at `/authorize`. That page shows the client name, the client's redirect host, two fields (Apple ID and app-specific password) and the requested permissions. Read access, when requested, is a fixed row; every other requested permission is a checkbox the user can tick or untick (see "Scopes"). It is styled by one built-in inline style block that the page's Content-Security-Policy allows by hash; the page loads no scripts or outside resources. A help link beside the password field opens Apple's article on app-specific passwords. Its one outbound link, beside the password label, opens Apple's article on creating an app-specific password (`https://support.apple.com/102654`) in a new tab without sending a referrer. There is no second consent page and no TOTP step. The form posts to `/auth/connect`.

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

The user decides on the login page which of the requested permissions the client gets. The scopes and their checkbox labels:

| Scope | On the login page | Used by |
|---|---|---|
| `calendar:read` | Fixed row "Read your calendars and events (always included)". It is the default when a client requests no scope. | every tool |
| `calendar:write` | Checkbox "Create and change events", ticked by default | `create_event`, `update_event` (with `calendar:read`) |
| `calendar:delete` | Checkbox "Delete events (whole events, single occurrences, or all following occurrences)", ticked by default | `delete_event` (with `calendar:read`) |
| `calendar:invite` | Checkbox marked SENSITIVE, "Change events that involve other people. iCloud emails them at once: invitations, updates and cancellations from your Apple Account. Has effect only together with create/change or delete.", not ticked by default | additionally `update_event` and `delete_event` on an event with attendees or an organizer, checked after the event is read (`attendees_present`) |

The label of `calendar:delete` also mentions single and following occurrences; in 0.4.0 `delete_event` deletes a whole event or series only.

A checkbox appears only for a scope the client requested. The client gets read (if it asked for it) plus the boxes left ticked, and the token response's `scope` names exactly that set, which may be narrower than the request. If nothing is granted (possible only when the client did not request read), the page says "Choose at least one permission", and nothing is stored and iCloud is not contacted. A refresh can keep or narrow the granted scopes, never widen them; a narrowing applies to earlier access tokens from their next verification on. To grant more, reconnect and tick the box. Each completed consent replaces what that client (the same `client_id`) was allowed before, for that account: its earlier grants and codes stop working as soon as the user presses "Connect and allow" and iCloud accepts the password, and other clients are not affected. This holds for a second submission of the same page too (a double click or a resent form): the later submission wins, and only its code works. A client that registers again gets a new `client_id`, and its old grants then live until they expire, the password is replaced, or they are revoked (see "One consent per client" in [docs/auth-design.md](docs/auth-design.md)). A tool called without a scope it needs returns `insufficient_scope`, naming the scope and the checkbox to tick.

`calendar:write` covers creating and changing events; deleting needs `calendar:delete`. Grants are never widened: a connection made before the write scopes existed keeps only the scopes it has, and must reconnect and tick the boxes to use the write tools.

### Token lifetimes

These match wildduck-mcp. Access tokens last five minutes. Grants and connections last at most 180 days. Refresh tokens rotate; an identical retry within ten seconds gets the same response, and a replay of an old token after that revokes the client's grant. Revocation at `/revoke` ends the access and refresh tokens.

The stored password is checked against iCloud when a code is issued or exchanged and when a refresh token is used. It is not checked on each `/mcp` request. The tool call itself reaches iCloud.

If iCloud answers a tool call, or a token request, with HTTP 401, the connection is marked `reconnect_required` and the user must connect again. A temporary iCloud or network problem returns `temporarily_unavailable` and keeps the grant. A 403 from iCloud is treated as temporary by the read tools; for a write it is `read_only_calendar` or `forbidden`, since iCloud also answers 403 to event data it refuses.

Replacing the stored password ends every existing grant for that account. Each client must authorize again. Only a repeat login with the identical, still-active credential keeps existing grants, and then only those of other clients: the client that logged in again keeps only its new grant. See [docs/auth-design.md](docs/auth-design.md).

### Accepted limitations

- Allowlist membership is observable to someone probing the login endpoint.
- Anyone who knows an allowlisted Apple ID can block new connections for that account for 15 minutes at a time. Existing grants keep working. Each such attempt is a real failed sign-in at Apple.
- There is no "forget this account" function. A stored password stays sealed in the table until it is replaced or the record expires (180 days).

## Fixed upstream hosts

The login page accepts no server URL. The server sends CalDAV requests only to `caldav.icloud.com` and to hosts shaped like `pNN-caldav.icloud.com`, which iCloud's discovery returns for each account. Requests must use HTTPS on the default port with no embedded credentials. Redirects are followed at most three times, and only to hosts that pass the same rule. A stored URL is checked again after decryption, every time it is used.

The one other host is `gateway.icloud.com`, for managed attachments, and only for a `GET` without credentials or cookies. The rules are in `src/caldav/managed-attachment-policy.ts`: the `ATTACH` must carry a `MANAGED-ID`, and a link under the account's calendar home, to an `.ics` file or to a collection is never fetched. A redirect from that host is refused, not followed. Owner decision OD9 allows the credentials to be sent to an Apple download host that answers 401 with a Basic challenge, but only to a host on a separate list in that module, and that list is empty. Credentials are never sent anywhere else. Other attachment links are never fetched.

## Local validation

Use Node.js 26, Bun 1.4.4 or newer, `zip` and git-flow.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run validate
bun run dev
```

`bun run validate` runs the TypeScript check, Oxlint, the tests, the Lambda bundle and two checks on Node 26: a smoke test of the bundle, and a transport check that runs the built managed-attachment fetcher with Node's own fetch against a local server on 127.0.0.1 (a redirect is not followed, no Authorization or Cookie is sent, gzip is refused, a body over 20 MiB and a stalled body are cut off). `bun run dev` starts a local server on port 3000 (set `PORT` to change it). Leave the AWS settings unset and the server makes no AWS calls; see `.env.example`. Tests use injected fakes and never contact Apple or AWS.

## Runtime and storage

Environment variables:

- `PUBLIC_BASE_URL`: the canonical HTTPS origin. In production it is imported from the bootstrap stack. It is never taken from the Host header.
- `AUTH_KEYRING_PARAMETER`: the SSM parameter name, `/caldav-mcp/prod/auth-keyring`.
- `CREDENTIAL_TABLE_NAME`: the DynamoDB table.
- `ALLOWED_APPLE_ID_HASHES`: the allowlist above. Empty means nobody can connect.
- `DOWNLOAD_BUCKET_NAME`: the private bucket for staged attachment copies. In production it is imported from the bootstrap stack. Unset disables staging only: inline and managed downloads fail with `temporarily_unavailable`, external links still work, and the other tools are unaffected.

Provision the keyring separately as an SSM Standard SecureString under the AWS-managed `aws/ssm` key. It is a new keyring. Never share it with wildduck-mcp. The shape is `{"activeKeyId":"v1","keys":{"v1":"<base64 of 32 random bytes>"}}`, at most four KiB. Generate the bytes in memory and send the value through stdin or API request data, not through command arguments, files or logs. CloudFormation does not create it. The runtime role can only read that one parameter. The CI deploy role is denied reading or writing its value, and is denied direct access to the table's items. It can still deploy code to the function, and that code runs with the runtime role. Anyone who can read both the keyring and the table, or who can deploy code, can decrypt stored passwords. The key is the AWS-managed `aws/ssm` key, so any principal in the account with `ssm:GetParameter` and table read can decrypt too.

To rotate, add a new key and change `activeKeyId`. Keep old keys while records or tokens still depend on them.

The DynamoDB table `caldav-mcp-prod-state` is provisioned at exactly 1 read and 1 write capacity unit, with no indexes and no autoscaling. The login page reads it before authentication, so a small burst of unauthenticated requests can exhaust it and make the service return 503. It is retained when the stack is deleted. Keys use the `caldav-mcp#` prefix, and runtime IAM enforces that prefix. The `expiresAt` TTL is only eventual cleanup; expiry is also checked on every read.

Lambda runs `nodejs26.x` on arm64 with 1024 MB, a 60 second timeout and 14 days of logs. No calendar data is retained except attachment copies staged in a private bucket for about one day, with eventual lifecycle cleanup. Each tool call reads iCloud when it needs to.

The download bucket belongs to the bootstrap stack. It blocks all public access, enforces bucket-owner object ownership, encrypts with SSE-S3 (AES256), refuses non-TLS requests, has no versioning and no CORS, and a lifecycle rule expires everything under `downloads/` after one day. S3 runs lifecycle rules about once a day, so a copy can last somewhat longer than 24 hours. Each download writes a new object under `downloads/v1/<hash of the account id>/<256 random bits>`, with no file name, event or account id in the key. The runtime role may only `PutObject` and `GetObject` under `downloads/`. Download links are presigned for at most five minutes, shorter if the signing credentials expire sooner. A link stays valid until it expires even if the grant is revoked; rolling back or disabling the tool stops new links only.

## Deployment and rollback

Deployment is enabled. The repository variable `DEPLOY_ENABLED` is `true`; the owner set it on 2026-11-11, so every push to `main` deploys. Pushes and pull requests to `main` and `develop` validate and build. The deploy job runs only on `main` and only when `DEPLOY_ENABLED` is `true`. The workflow never sets that variable itself. When it runs, it uses short-lived GitHub OIDC credentials and deploys the exact artifact the verify job built. The verify job has no AWS credentials. No long-lived AWS key is stored in GitHub. Actions are pinned by tag, not by commit, and the deploy job has no approval gate.

The public hostname is `caldav-mcp.rungie.com`. The template pins it as the only allowed value of `PublicDomainName`. `HostedZoneId` is the same existing zone wildduck-mcp uses.

The bootstrap stack creates the CloudFront distribution, two challenge-header policies, DNS records in the existing `rungie.com` zone, the artifact bucket, the attachment download bucket and its TLS-only policy, and two IAM roles. It needs the existing `GitHubOIDCProvider-Arn` and `CertificateAccepterLambda-Arn` exports. The distribution's origin is the `FunctionUrlOrigin` parameter, an existing Function URL origin without a trailing slash. The service stack imports the bootstrap exports `caldav-mcp-prod-public-origin` and `caldav-mcp-prod-download-bucket`. The CI deploy role has no rights on the download bucket; only the bootstrap stack, run by the owner, creates or changes it.

**The service stack imports `caldav-mcp-prod-download-bucket`**, so the owner must have updated the bootstrap stack (which adds the private download bucket) before a service deploy; the deploy fails until that export exists. Run step 1 below again (`bun run setup:deployment`; it updates the existing stack and keeps the stored `FunctionUrlOrigin`), or deploy `infra/bootstrap.yml` to `caldav-mcp-bootstrap` with `aws cloudformation deploy --region us-west-2 --stack-name caldav-mcp-bootstrap --template-file infra/bootstrap.yml --capabilities CAPABILITY_NAMED_IAM`. After a service deploy, `scripts/verify-deployment.mjs` checks that the function received `DOWNLOAD_BUCKET_NAME`.

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

Rollback: use the published Lambda versions and the previous artifact. Restore the previous reviewed release and configuration, then verify health, version, discovery and readiness. Do not use `serverless remove` as a rollback. Keep the keyring keys that surviving records need. Rolling back the code does not undo changes already made to calendars. Rolling back to a release without consent records makes a client's superseded, unexpired grants work again, and that release refuses (with 503) the codes the newer build issued; never delete `consent` records by hand (see "One consent per client" in [docs/auth-design.md](docs/auth-design.md)). The table, the artifact bucket, the distribution, the header policies and the certificate are retained after stack deletion. The download bucket is not: it holds only disposable copies. A non-empty bucket blocks deletion of the bootstrap stack: CloudFormation cannot delete a bucket that holds any object, so the stack delete fails. The lifecycle rule is eventual (S3 runs it about once a day, and a new download can land at any time), so waiting does not guarantee an empty bucket. Stop new downloads, empty the bucket (`aws s3 rm s3://<bucket> --recursive`; it is unversioned), then delete the stack. Rolling the service back to a release without the download tool leaves the bucket and its export in place; that is harmless. Keep the ACM validation DNS records for renewal.

## Branches and releases

This repository uses gitflow, as wildduck-mcp does. Work happens on `develop`. `main` receives merges only for releases, through the `postversion` script, and deployments run from `main`. Tags are bare package versions. Set up git-flow with `bun run gitflow:init`. The release script (`scripts/postversion.sh`) refuses to run when untracked files exist. From a clean `develop`, run `bun pm version patch --no-git-tag-version`. The postversion script updates the lockfile, validates, commits, finishes the git-flow release and merges `main` back into `develop`. Nothing is pushed automatically. `bun run test:release` tries the release path in a disposable repository.
