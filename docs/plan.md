# caldav-mcp: assessment and development plan

Status: the phase 0 probe is written. The owner has run its read-only mode and its `--write` mode against their own iCloud account, locally, on 2026-11-11, one run each. The invite and Lambda runs are outstanding. The phase 1 skeleton is built and not deployed. The auth and credential-storage code and the probe each had one independent review by a second Claude agent (same model family; no cross-family reviewer was available). The findings were fixed, except the items listed under "Accepted limitations".

## Goal

A cloud-hosted MCP server that gives Claude clients (Claude, Cowork, Duet) read and write
access to Apple iCloud calendars over CalDAV. It must not depend on a laptop being awake.
It mirrors the security and deployment strategy of
[hughescr/wildduck-mcp](https://github.com/hughescr/wildduck-mcp).

## Out of scope

- **Reminders and tasks.** Since iOS 13, upgraded Reminders lists live in a store that
  CalDAV cannot see. No other server-side API was found.
- **Contacts (CardDAV).** Excluded by decision. Attendees are given as plain email addresses.
- **Other CalDAV providers.** iCloud only for now, by the owner's decision of 2026-11-11.
  Named providers with fixed hosts would fit the current security model. An arbitrary server
  URL would replace the fixed-host rule with a weaker control.
- **Push notifications and caching.** The server holds no calendar data. Each tool call
  reads iCloud when it needs to. sync-collection is unused for now: it returns the whole
  collection and ignores limits, and the server has no cache to update.

## What iCloud provides

Apple has never documented its CalDAV server. The statuses below come from two sources.
"Confirmed" means the owner's probe runs: probe 0.1.0, report schema 2, one account, local,
2026-11-11. The read-only run sent 50 requests in 13 seconds. The `--write` run sent 104
requests in 33 seconds and ran 37 checks: 35 confirmed, 2 refuted, 0 inconclusive and 0
errors. It repeated every read-only finding with an identical result. It made two temporary
calendars, and both were deleted and verified gone. Everything else comes from other
clients' published test results (mainly python-caldav's iCloud compatibility profile, probed
October 2026) or has not been tested. Another account may behave differently. The probe is
described in [probe.md](probe.md).

The server code relies only on: discovery from `caldav.icloud.com` through
`current-user-principal` and `calendar-home-set`, HTTP Basic, and a Depth 1 PROPFIND listing
of the calendar home. It also assumes that a wrong password gives 401. That is untested.
If iCloud answers 403, the login throttle never counts it, because a 403 is treated as
temporary.

Confirmed in both runs, for this account:

- Discovery: `PROPFIND` on `https://caldav.icloud.com/` returned 207 with no redirect. The
  principal is on `caldav.icloud.com` with a relative href shaped `/<id>/principal/`. The
  calendar-home-set href is absolute, carries an explicit port, is shaped
  `/<id>/calendars/`, and its host matches `pNN-caldav.icloud.com`. A second discovery
  returned identical URLs.
- HTTP Basic with the app-specific password typed with hyphens was accepted. No
  `Set-Cookie` was seen.
- The phase 1 backend (`src/caldav/icloud.ts`) ran discover, validate and `listCalendars`
  against the real server. It listed 11 calendars, which equals the probe's own count of
  `VEVENT` collections.
- Collections under the calendar home: 16, of which 11 declare `VEVENT` and 5 are
  `VTODO`-only. Shared calendars live under the home, so `list_calendars` includes them.

Still open:

- The status for a wrong password (401 or 403) was deliberately not tested.
- Subscribed calendars: the account has none, so their behaviour is unknown.
- Response size: no size error occurred in either run. The largest response was the
  1631-item sync-collection reply. A larger account may behave differently.
- Invitations: the `--invite` run has not been done. They are advertised through
  `calendar-auto-schedule` and unconfirmed.
- Behaviour from AWS addresses: the Lambda run has not been done.
- `--cleanup` has not been run against the real server. The write run's own cleanup deleted
  both temporary calendars.
- A `TZID` that is unknown or unusual when a new event is sent without a `VTIMEZONE`. Only
  `Europe/Berlin` was tried.

| Capability | Status |
|---|---|
| Calendars and events: read | Confirmed (both runs, 2026-11-11). Time-range calendar-query worked: in the write run it returned exactly the one event inside the range and nothing for an adjacent empty range. calendar-multiget worked. |
| Events: create, update, delete | Confirmed (write run, 2026-11-11). Create: `PUT` with `If-None-Match: *` gives 201. Update with the exact ETag in `If-Match` gives 204. A stale ETag gives 412 for both `PUT` and `DELETE`, and the event is unchanged. |
| Calendars: create and delete | Confirmed (write run, 2026-11-11). `MKCALENDAR` at a client-chosen path gives 201. The calendar is visible and keeps its display name. There is no `Location` header. `DELETE` of the collection gives 204, and the calendar is then gone. |
| Round trip of an event (`PUT` then `GET`) | Confirmed (write run, 2026-11-11) for 6 events: nothing was changed, removed or added by the server, except the one `VTIMEZONE` noted below. The 6: `TZID=America/New_York` with an embedded `VTIMEZONE`; `TZID=Europe/Berlin` without one; all-day with an exclusive end; floating; UTC; an unknown `X-` property with a parameter plus a `VALARM`. Europe/Berlin was accepted with `DTSTART` and `DTEND` unchanged, and the server added one `VTIMEZONE` itself. `PRODID` and `DTSTAMP` were not changed, and `SEQUENCE` was not added or changed. |
| Authentication | Confirmed (both runs, 2026-11-11): HTTP Basic with an app-specific password on every request was accepted, with no cookie. No documented OAuth. Apple's "Account Data Sharing" is a pilot with no public technical documentation. The response to a wrong password is untested. |
| Discovery | Confirmed (both runs, 2026-11-11). Start at `caldav.icloud.com`, follow `current-user-principal` and `calendar-home-set` to a per-account host (`pNN-caldav.icloud.com`). Never hard-code that host. |
| Calendar properties | Confirmed (both runs, 2026-11-11). All 16 collections returned displayname, calendar-color, calendar-timezone, getctag, sync-token, supported-calendar-component-set, current-user-privilege-set and owner. 10 returned `invite`. The owner differs from the principal on 5. All 16 report write privilege. |
| Owned, shared and subscribed calendars | Confirmed (both runs, 2026-11-11) for owned and shared: 6 owned, 5 shared with the owner, 5 shared by the owner, all under the calendar home. Subscribed: untested, none in the account. |
| Free/busy query | Confirmed (both runs, 2026-11-11) as rejected: HTTP 400. Compute free time from events if it is ever needed. |
| Server-side recurrence expansion | Confirmed (both runs, 2026-11-11). In the read-only run, calendar-query with `expand` returned 13 instances from 3 recurring events, with `RECURRENCE-ID` and no `RRULE`. In the write run, a weekly series with one `RECURRENCE-ID` override and one `EXDATE` returned exactly the 5 expected instances: the override was applied, the `EXDATE` was respected, and there was no `RRULE`. All 5 instance start times were in UTC form, so the original `TZID` is not on the instance. The server therefore reads the zone name from the master event to show local times. |
| Server-side text search | Refuted (both runs, 2026-11-11): a `SUMMARY` text-match filter is ignored. In the write run it returned all 10 events in range, also for upper case and for a random word. |
| calendar-query filter on `UID` | Confirmed (both runs, 2026-11-11) as rejected: HTTP 412. Fetch by href or use calendar-multiget. |
| ETags | Confirmed (both runs, 2026-11-11): strong, quoted, and identical across REPORT, GET and PROPFIND. Create and update also return an `ETag` header, and the one from create equals the ETag a later PROPFIND shows. |
| Conditional writes | Confirmed (write run, 2026-11-11). `If-None-Match: *` on an existing resource is refused with 412. `If-Match: *` is broken and dangerous: on an existing event it is refused with 412, and on a missing resource it creates the event (201). |
| sync-collection | Confirmed (both runs, 2026-11-11) at Depth 0. The initial sync returned 1631 items and a token. Repeating with the token returned no changes. In the write run, after one change and one deletion, a sync with the earlier token reported exactly those two (the change with an ETag, the deletion as 404) and a new token. `limit` is ignored: asking for 1 returned 1631 and asking for 2 returned 12, with no 507 marker. An invalid token gives 403 with the `valid-sync-token` precondition. |
| Invitations when an event with attendees is saved | Advertised, not confirmed. The `DAV` header lists `calendar-auto-schedule`, `calendar-schedule` and `calendarserver-sharing`. The principal has a schedule-outbox URL and 7 `calendar-user-address-set` mailto addresses. Whether the server sends invitations is untested until the invite run. |
| Rate limits | Confirmed (write run, 2026-11-11) for a home connection: no 429 or 503 in 104 requests. The read-only part included a burst of 10 sequential and 5 parallel PROPFINDs. Median latency was 262 ms and the maximum 971 ms. No rate-limit headers. Not tested from AWS. |
| Behaviour from AWS addresses | Untested. No reports of blocking. |

Known quirks:

All five are confirmed (probe runs, 2026-11-11, one account).

- An event with `DTSTART` and neither `DTEND` nor `DURATION` is refused with HTTP 404, not
  with a status that names the problem.
- The same `UID` cannot exist in two calendars (412). A second resource with the same `UID`
  in the same calendar under another name is also refused (412).
- `If-Match: *` is broken and dangerous. On an existing event it is refused (412). On a
  missing resource it creates the event (201). Every write to an existing event must carry
  the exact ETag, and the server must never send `If-Match: *`.
- A calendar-query filter on `UID` returns 412.
- The sync-collection `limit` is ignored.

## Architecture

### Reused from wildduck-mcp

The OAuth authorization server (dynamic client registration, client metadata documents,
PKCE, rotating refresh tokens), the AES-GCM keyring held in an SSM SecureString, the
DynamoDB store, the Hono application on a Lambda Function URL behind CloudFront, the
bootstrap stack, CI with GitHub OIDC, and the error and request-budget conventions. The
login and consent pages are replaced by one page. See
[auth-design.md](auth-design.md).

Everything under `src/mail/` and `src/wildduck.ts` is replaced.

wildduck-mcp's DynamoDB adapter rejects the check-only transaction that its own
refresh-retry recovery sends, so that retry returns 503 there. This repository's copy
fixes it. wildduck-mcp is unchanged. Its owner should port the fix back.

### Runtime and toolchain

- Bun is the development toolchain: install, test, bundle (`Bun.build` with `target: 'node'`).
- Production runs on Lambda `nodejs26.x`.
- `Temporal` is built into both. Verified on Node v26.13.0 and Bun 1.4.4: both resolve a
  daylight-saving jump correctly and both throw `RangeError` for a nonexistent local time
  with `disambiguation: 'reject'`. No polyfill is planned.
- The Node build used for that check came from npm, not from the AWS image. The Lambda
  smoke test must assert `typeof Temporal === 'object'`.
- Tests run under Bun's engine and production runs under Node's. These are two different
  `Temporal` implementations. The datetime and recurrence test corpus must therefore run
  under **both** runtimes in CI.

### Authentication and access control

1. The user adds the connector URL. The client discovers the server's own OAuth endpoints
   and opens one page at `/authorize`.
2. That page shows the client, the requested scopes and two fields: Apple ID and
   app-specific password. There is no separate consent step. The password is never placed
   in a cookie.
3. The server checks the allowlist, reserves a login attempt, and proves the credentials
   with a discovery request to iCloud.
4. The server stores the Apple ID, the app-specific password and the discovered URLs,
   encrypted with the same account-bound AES-GCM scheme that wildduck-mcp uses.
5. The client receives only this server's short-lived access token and rotating refresh token.
6. A 401 from iCloud during a tool call marks the connection `reconnect_required`.

Replacing the stored password ends every existing grant for that account. Each client must
authorize again.

**Known weak point.** wildduck-mcp never stores a password. This server must, because
CalDAV has no session token. An app-specific password is not limited to calendars: it also
opens iCloud Mail and contacts. Mitigations: use a password generated only for this server,
which can be revoked at Apple on its own, and keep the encryption key outside the database.
Anyone who can read both the SSM keyring and the table, or who can deploy code to the
function, can decrypt stored passwords. The CI deploy role is denied direct table and
keyring access but can still deploy code.

Additional controls:

- **Allowlist of accounts.** `ALLOWED_APPLE_ID_HASHES` is a list of account hashes. A hash
  is a SHA-256 based pseudonym of the normalized Apple ID, produced by
  `bun run apple-id-hash`. It is enforced at login, at token refresh and on every MCP
  request. Without it, anyone could connect their own account to this deployment.

  Decision, 2026-11-11: the allowlist stays. It is limited to the Apple IDs of the owner and
  the owner's family, stored as account hashes. An open server would act as a
  password-testing relay against Apple for anyone on the internet.

  Practical note: enter each account with the address that person signs in with. The server
  compares the address typed on the login page, after trimming and lower-casing it. An
  address that a calendar was shared to is not necessarily that address.
- **Login throttle.** At most 5 attempts per account per 15 minutes. An attempt is
  reserved before the request to iCloud.
- **Fixed upstream host.** The login page accepts no server URL. Requests go only to
  `caldav.icloud.com` and to hosts matching the per-account pattern that discovery returns.
  This prevents the server from being used to send requests to arbitrary addresses.
  Redirects are followed at most 3 times and only to allowed hosts. Stored URLs are
  re-checked after decryption.
- **Scopes:** `calendar:read`, `calendar:write`, and a separate `calendar:invite` that needs
  its own consent checkbox, because saving an event with attendees may send invitations.

### Deployment

- The public hostname is `caldav-mcp.rungie.com`. The bootstrap template pins it as the only
  allowed value of `PublicDomainName`. The Bearer challenge header and the exported origin are
  built from that parameter.
- The first deployment follows the stages wildduck-mcp went through. The bootstrap stack is
  created with a placeholder `FunctionUrlOrigin`. The service is then deployed, which creates the
  real Function URL. The bootstrap stack is then updated with that origin, and the deployment
  verification runs. The README gives the steps. They have not been executed yet.
- The DynamoDB table stays at 1 RCU and 1 WCU.
- The keyring stays under the AWS-managed `aws/ssm` key.
- CI is the same as wildduck-mcp: actions are pinned by tag and the deploy job has no approval
  environment.
- The branch model is gitflow, as in wildduck-mcp. Work happens on `develop`. `main` receives
  merges only for releases, through the `postversion` script. Deployments run from `main`.

### Tools

`list_calendars`, `list_events`, `search_events`, `get_event`, `create_event`,
`update_event`, `delete_event`. Only `list_calendars` is built.

- Date ranges are required and capped at 366 days. Result counts are capped. Nothing is
  silently truncated: a capped result says so.
- `list_events` and `search_events` take their occurrences from iCloud's server-side expansion
  (`calendar-query` with `expand`). Converting an instant to a zone is unambiguous, so the
  server reads the zone name from the master event to show local times.
- `search_events` fetches the range and matches text in this server. The server ignores a
  text-match filter, so client-side matching is required.
- Shared calendars appear in `list_calendars`. Whether a calendar is owned, shared with the
  owner or shared by the owner can be read from `resourcetype`, `owner` and `invite`, and
  could be added to the tool output in phase 2.
- All calendar text (titles, notes, locations, attendee names) is untrusted data.

### Libraries

| Purpose | Library | Note |
|---|---|---|
| CalDAV protocol | A small client in `src/caldav/` | It runs over the guarded fetch, with `fast-xml-parser` behind a strict wrapper (`src/caldav/xml.ts`). |
| Parse and edit iCalendar | `ical.js` | It registers no time zones by default. |
| Recurrence expansion | iCloud, through `calendar-query` with `expand`. `rrule-temporal` is used in tests only, as a cross-check against the server's answer. | iCloud applies `RECURRENCE-ID` overrides and `EXDATE`s. The server does not merge them. |
| Date arithmetic | built-in `Temporal` | |
| Test-only cross-check | `node-ical` | A second implementation to compare expansion results against. |

The server does not use `tsdav` 2.5.0. It sends extra requests per calendar and a
`.well-known` lookup. It also reports 403, 5xx and parse failures as the same error, so
"wrong password" cannot be told apart from "temporarily unavailable". The other rows are
phase 2 choices.

Do not use `rrule` (unmaintained, known time-zone weaknesses).

A new event with a `TZID` is sent without a `VTIMEZONE` block. See datetime rule 6.

## Datetime rules

1. Tool inputs are a local wall-clock time plus an IANA zone name, or a plain date for an
   all-day event. A bare UTC offset is rejected.
2. Outputs give the local time with its zone and the UTC instant.
3. All-day events (`VALUE=DATE`, exclusive end date) and floating events (no zone) are never
   converted to UTC. Floating events are flagged as such.
4. A local time in a daylight-saving gap is an error. A repeated hour resolves to the first
   occurrence, as RFC 5545 states, for stored data.
5. A duration in days is calendar-day arithmetic, not multiples of 24 hours.
6. An embedded `VTIMEZONE` is preferred when present. Windows zone names are mapped to IANA
   names; an unknown zone is an error. For a new event, this server sends the IANA `TZID`
   without a `VTIMEZONE`, and iCloud adds the definition. This is confirmed for
   `Europe/Berlin` only. An unknown or unusual zone name is untested.
7. Updates edit the parsed original component, so unknown properties (`X-APPLE-*`, alarms,
   attachments) survive. An event is never regenerated from a simplified object. iCloud
   preserved an unknown `X-` property with a parameter, and a `VALARM`, unchanged on a round
   trip.
8. Editing a recurring event requires an explicit scope: `this`, `this_and_future`, or
   `all`. There is no default. Reading with iCloud's expansion does not change this: writes
   still edit the master event and its overrides.
   - `this`: a `RECURRENCE-ID` override in the same resource.
   - `this_and_future`: set `UNTIL` on the original series and create a new series.
     `RANGE=THISANDFUTURE` is not emitted.
9. Organizer edits increase `SEQUENCE` and refresh `DTSTAMP`. iCloud changes neither, so this
   server must.
10. Leap seconds need no handling.

## Write safety

- Every write to an existing event requires the opaque `expected_version` (the ETag) from a
  prior read, sent as an exact `If-Match`. A mismatch is a conflict error: iCloud answers 412
  to a stale ETag on both `PUT` and `DELETE`, and leaves the event unchanged.
- The server never sends `If-Match: *`. iCloud creates the resource when it is missing.
- The new ETag comes back in the `ETag` header on create (201) and on update (204), and it
  equals the ETag a later PROPFIND shows. No follow-up read is needed to learn it.
- Every write requires a stable `operation_id`. A create derives the event `UID` from it and
  sends `If-None-Match: *`, so a retry cannot make a duplicate: iCloud refuses the second
  `PUT` of the same resource with 412 and the server then verifies the stored event. The same
  `UID` under another resource name is also refused (412).
- After an uncertain outcome the server reports uncertainty. It does not claim success or
  failure.

## Phases

| Phase | Work | Done when | Status |
|---|---|---|---|
| 0 | Probe script, run locally and from a Lambda with a real account. Tests: requests from AWS addresses, discovery, server-side expansion, text search, sync-collection, shared and subscribed calendars, time-zone handling on round trip, whether invitations are sent. | Results recorded in `docs/`. | Probe written. Local read-only and `--write` runs done (one account, 2026-11-11). Invite and Lambda runs outstanding. |
| 1 | Skeleton from wildduck-mcp: OAuth, keyring, store, deployment, CI, adapted login page, allowlist, `list_calendars` only. | Deployed and connected from Claude. | Built. Not deployed. "Connected from Claude" not done. |
| 2 | Read path: time model, parsing, occurrences from iCloud's expansion, `list_events`, `search_events`, `get_event`. | The read path passes a corpus of awkward events under Node and Bun. Occurrences come from iCloud's expansion and are cross-checked in tests against `rrule-temporal` and `node-ical`. | Not started. |
| 3 | Writes for single events: create, update, delete, all-day, alarms. | Conflict and retry tests pass; verified in Calendar.app. | Not started. |
| 4 | Recurring writes with the three edit scopes. | Verified in Calendar.app across a daylight-saving change. | Not started. |
| 5 | Optional: attendees and invitations, a free-time finder. | Depends on phase 0 results. | Not started. |

Development is test-first. The corpus in phase 2 should include real exported events with
names and details replaced.

## Open decisions

No decisions are open, and phase 2 starts when the owner asks for it.

## Accepted limitations

- Allowlist membership is observable to someone probing the login endpoint.
- Anyone who knows an allowlisted Apple ID can block new connections for that account for
  15 minutes at a time. Existing grants keep working. Each such attempt is a real failed
  sign-in at Apple.
- There is no "forget this account" function. A stored password stays sealed in the table
  until it is replaced or the record expires (180 days).
- The table is 1 RCU and 1 WCU. A few unauthenticated login-page requests per second can
  exhaust it. The service then returns 503 until the burst ends.
- The keyring uses the AWS-managed `aws/ssm` key. Any AWS principal in the account that can
  read both the keyring parameter and the table can decrypt stored passwords.
- CI actions are trusted by tag, and deploys have no approval step.
- A rotation of the app-specific password signs out every client.
- Calendar `id` values returned by `list_calendars` contain the account's numeric iCloud
  path.
