# caldav-mcp: assessment and development plan

Status: the phase 0 probe is written. The owner has run its read-only mode and its `--write` mode against their own iCloud account, locally, on 2026-11-11, several times as the probe grew. The invite and Lambda runs are outstanding. The phase 1 skeleton was deployed on 2026-11-11 (version 0.1.1, https://caldav-mcp.rungie.com). The owner connected it from a Claude client and reports that it worked; this was not checked from server logs. Version 0.2.1 was deployed on 2026-11-12, and its deploy verification passed. It added phase 2 (`list_events`, `search_events`, `get_event`) to `list_calendars`. Version 0.3.0 is released and live on 2026-11-12. It adds the attachment download tool (phase 2b, `get_event_attachment_download`) and a restyled sign-in page with a help link to Apple's app-specific password article. The download tool was verified locally on 2026-11-12 against one real iCloud account with an in-memory store in place of S3: 6 managed attachments (PNG, JPEG and PDF, 35 KB to 19.2 MB) were fetched anonymously from Apple's attachment host and each staged copy began with the correct file signature, and 3 external-link attachments were returned as links without being fetched. The real S3 upload and presigned link were verified on 2026-11-12 on the live 0.3.0 service through a Claude client: a 43,935-byte managed PNG was staged, the presigned link returned exactly those bytes as a forced download with server-side encryption, and the unsigned object URL was refused with 403. A real inline attachment is still unverified; none exists in the owner's data. On develop, not released: the download result carries the link once in `structuredContent` and once in its text mirror, with no `resource_link` block; and an overridden instance of a zoned series, whose expanded `RECURRENCE-ID` iCloud sends in the stored `TZID` form, is read with an `occ2_` occurrence token instead of making its whole resource unreadable (see "Read behaviour that shapes the design"). Writes are designed, not built; a probe extension for them is in progress. The auth and credential-storage code and the probe each had one independent review by a second Claude agent (same model family; no cross-family reviewer was available). The findings were fixed, except the items listed under "Accepted limitations". The download tool had one independent security review by a different model family: no blockers, its findings were fixed, and the fixes were not re-reviewed. The sign-in page change had a separate independent security review, which found nothing beyond presentation.

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
- **Push notifications and caching.** No calendar data is retained except attachment copies
  staged in a private bucket for about one day, when an agent asks to download an
  attachment. Each tool call reads iCloud when it needs to. sync-collection is unused for
  now: it returns the whole collection and ignores limits, and the server has no cache to
  update.

## What iCloud provides

Apple has never documented its CalDAV server. The statuses below come from two sources.
"Confirmed" means the owner's probe runs: one account, local, 2026-11-11, several read-only
and `--write` runs as the probe grew. Each `--write` run made two temporary calendars, and
both were deleted and verified gone. "Refuted" means iCloud differs from the expectation
that the check encoded, which is often an RFC expectation. Everything else comes from other
clients' published test results (mainly python-caldav's iCloud compatibility profile, probed
October 2026) or has not been tested. Another account may behave differently. The probe is
described in [probe.md](probe.md).

The server code relies only on: discovery from `caldav.icloud.com` through
`current-user-principal` and `calendar-home-set`, HTTP Basic, and a Depth 1 PROPFIND listing
of the calendar home. It also assumes that a wrong password gives 401. That is untested.
If iCloud answers 403, the login throttle never counts it, because a 403 is treated as
temporary.

Confirmed in every run, for this account:

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
- Behaviour from AWS addresses: the probe's Lambda run has not been done. The owner reports one successful login through the deployed Lambda, which means one discovery and validation exchange with iCloud from an AWS address, for one account. This is the owner's report, not checked from server logs. It gives no rate-limit or volume evidence.
- `--cleanup` has not been run against the real server. The write run's own cleanup deleted
  both temporary calendars.
- A `TZID` that is unusual when a new event is sent without a `VTIMEZONE`. Only
  `Europe/Berlin` was tried. A made-up `TZID` sent with its own `VTIMEZONE` was accepted but
  stored as a floating time (see below). Whether iCloud keeps a real IANA `TZID` whose
  embedded rules differ from the tz database is unknown.
- Whether a managed-attachment URL expires. Six real managed attachments of the owner's
  were fetched anonymously on 2026-11-12 (local, one account), like the probe's own.

| Capability | Status |
|---|---|
| Calendars and events: read | Confirmed (probe runs, 2026-11-11). Time-range calendar-query worked: in the write run it returned exactly the one event inside the range and nothing for an adjacent empty range. calendar-multiget worked. |
| Events: create, update, delete | Confirmed (write run, 2026-11-11). Create: `PUT` with `If-None-Match: *` gives 201. Update with the exact ETag in `If-Match` gives 204. A stale ETag gives 412 for both `PUT` and `DELETE`, and the event is unchanged. |
| Calendars: create and delete | Confirmed (write run, 2026-11-11). `MKCALENDAR` at a client-chosen path gives 201. The calendar is visible and keeps its display name. There is no `Location` header. `DELETE` of the collection gives 204, and the calendar is then gone. |
| Round trip of an event (`PUT` then `GET`) | Confirmed (write run, 2026-11-11) for 6 events: nothing was changed, removed or added by the server, except the one `VTIMEZONE` noted below. The 6: `TZID=America/New_York` with an embedded `VTIMEZONE`; `TZID=Europe/Berlin` without one; all-day with an exclusive end; floating; UTC; an unknown `X-` property with a parameter plus a `VALARM`. Europe/Berlin was accepted with `DTSTART` and `DTEND` unchanged, and the server added one `VTIMEZONE` itself. `PRODID` and `DTSTAMP` were not changed, and `SEQUENCE` was not added or changed. |
| Authentication | Confirmed (probe runs, 2026-11-11): HTTP Basic with an app-specific password on every request was accepted, with no cookie. No documented OAuth. Apple's "Account Data Sharing" is a pilot with no public technical documentation. The response to a wrong password is untested. |
| Discovery | Confirmed (probe runs, 2026-11-11). Start at `caldav.icloud.com`, follow `current-user-principal` and `calendar-home-set` to a per-account host (`pNN-caldav.icloud.com`). Never hard-code that host. |
| Calendar properties | Confirmed (probe runs, 2026-11-11). All 16 collections returned displayname, calendar-color, calendar-timezone, getctag, sync-token, supported-calendar-component-set, current-user-privilege-set and owner. 10 returned `invite`. The owner differs from the principal on 5. All 16 report write privilege. |
| Owned, shared and subscribed calendars | Confirmed (probe runs, 2026-11-11) for owned and shared: 6 owned, 5 shared with the owner, 5 shared by the owner, all under the calendar home. Subscribed: untested, none in the account. |
| Free/busy query | Confirmed (probe runs, 2026-11-11) as rejected: HTTP 400. Compute free time from events if it is ever needed. |
| Server-side recurrence expansion | Confirmed (probe runs, 2026-11-11). calendar-query with `expand` returns one component per instance, with `RECURRENCE-ID`, with `DTEND` and without `RRULE`. A weekly series with one `RECURRENCE-ID` override and one `EXDATE` returned exactly the 5 expected instances: the override was applied and the `EXDATE` was respected. The expansion keeps the stored form of `DTSTART` and `DTEND`: zone-local with its `TZID`, all-day date, floating, or UTC. It drops the `VTIMEZONE` and keeps the `TZID` parameters. `RECURRENCE-ID` arrives with a `Z` on every instance without a stored override. That is a true instant only for a zoned or UTC series. For an all-day or floating series it is the local value with a `Z` appended. An instance with a stored override carries its `RECURRENCE-ID` in the stored form instead, and `X-RECURRENCE-EXCEPTION` (probe, 2026-11-12). See "Read behaviour that shapes the design" below. |
| Server-side text search | Refuted (probe runs, 2026-11-11): a `SUMMARY` text-match filter is ignored. In the write run it returned all 10 events in range, also for upper case and for a random word. |
| calendar-query filter on `UID` | Confirmed (probe runs, 2026-11-11) as rejected: HTTP 412. Fetch by href or use calendar-multiget. |
| ETags | Confirmed (probe runs, 2026-11-11): strong, quoted, and identical across an expanded calendar-query, calendar-multiget, GET and PROPFIND. The `expected_version` from `list_events` can therefore be passed to `get_event`. Create and update also return an `ETag` header, and the one from create equals the ETag a later PROPFIND shows. |
| Conditional writes | Confirmed (write run, 2026-11-11). `If-None-Match: *` on an existing resource is refused with 412. `If-Match: *` is broken and dangerous: on an existing event it is refused with 412, and on a missing resource it creates the event (201). |
| sync-collection | Confirmed (probe runs, 2026-11-11) at Depth 0. The initial sync returned 1631 items and a token. Repeating with the token returned no changes. In the write run, after one change and one deletion, a sync with the earlier token reported exactly those two (the change with an ETag, the deletion as 404) and a new token. `limit` is ignored: asking for 1 returned 1631 and asking for 2 returned 12, with no 507 marker. An invalid token gives 403 with the `valid-sync-token` precondition. |
| Invitations when an event with attendees is saved | Advertised, not confirmed. The `DAV` header lists `calendar-auto-schedule`, `calendar-schedule` and `calendarserver-sharing`. The principal has a schedule-outbox URL and 7 `calendar-user-address-set` mailto addresses. Whether the server sends invitations is untested until the invite run. |
| Rate limits | Confirmed (write run, 2026-11-11) for a home connection: no 429 or 503 in 104 requests. The read-only part included a burst of 10 sequential and 5 parallel PROPFINDs. Median latency was 262 ms and the maximum 971 ms. No rate-limit headers. Not tested from AWS. |
| Behaviour from AWS addresses | One login from the deployed Lambda succeeded, for one account (the owner's report, 2026-11-11, not checked from server logs). That is one discovery and validation exchange. No rate-limit or volume evidence. The probe's Lambda run has not been done. No reports of blocking. |

Known quirks:

All are confirmed (probe runs, 2026-11-11, one account).

- An event with `DTSTART` and neither `DTEND` nor `DURATION` is refused with HTTP 404, not
  with a status that names the problem.
- The same `UID` cannot exist in two calendars (412). A second resource with the same `UID`
  in the same calendar under another name is also refused (412).
- `If-Match: *` is broken and dangerous. On an existing event it is refused (412). On a
  missing resource it creates the event (201). Every write to an existing event must carry
  the exact ETag, and the server must never send `If-Match: *`.
- A calendar-query filter on `UID` returns 412.
- The sync-collection `limit` is ignored.
- A `POST` with `?action=attachment-remove` returns 200, but the attachment stays on the
  event and the ETag does not change. Phase 3 must not trust that status.
- iCloud rewrites a local time that falls in a skipped daylight-saving hour. A single event
  written at 02:30 on the spring-forward day in `America/New_York` came back at 00:00. A
  weekly series through that day shifted its instances.
- iCloud treats a local time in a repeated daylight-saving hour as the second occurrence.
  RFC 5545 and Temporal's default say the first. In `America/New_York` on the fall-back day,
  01:30 was selected as 06:30 UTC (EST), not 05:30 UTC (EDT).

### Read behaviour that shapes the design

Measured by the probe on one account, 2026-11-11.

- **Stored form survives expansion.** Zone-local times stay zone-local with their `TZID`,
  all-day dates stay dates, floating times stay floating and UTC times stay UTC. This holds
  for single events and for recurring series. The expansion drops the `VTIMEZONE`, so a
  `TZID` on an instance has no definition in the same response. A made-up `TZID` does not
  survive: iCloud strips it and stores the event as floating. The owner's account has no
  event with a `TZID` that is neither an IANA name nor defined in the same resource.
- **`RECURRENCE-ID` form.** An instance without a stored override has it as `…Z`. For a
  zoned or UTC series it is the true instant of the original slot. For an all-day series it
  is the date at midnight with a `Z`, and for a floating series it is the wall-clock time
  with a `Z`. Neither is an instant. An instance with a stored override, moved or not, has
  it in the stored form instead: `TZID=<zone>:` and the local time for a zoned series,
  `VALUE=DATE:` for an all-day series, the bare local time for a floating series, and `…Z`
  for a UTC series. Such an instance also carries `X-RECURRENCE-EXCEPTION`, and its
  `DTSTART` and `DTEND` are verbatim (probe, 2026-11-12). The owner's data has at least 3
  overrides in the zoned form. The server maps a `Z` date-time, a `VALUE=DATE` date (read
  as midnight) and a floating date-time (read as its wall-clock digits) with no other
  parameter to the same opaque `occ1_…Z` token, read in the form of the series, never as
  UTC for an all-day or floating series. On develop, not released: a local date-time whose
  only parameter is one `TZID` maps to an `occ2_` token that carries the local digits and
  the exact `TZID` text (base64url, at most 128 bytes of zone text, 192 characters in all).
  It is an identity by text, with no zone conversion, so it works for an unrecognised zone
  and for a local time in a repeated hour. `get_event` finds the stored override with the
  same `RECURRENCE-ID` text, queries its slot's local digits read as UTC and its own times,
  padded 24 hours, and returns the expanded instance with the same token. Any other
  parameter, a `TZID` on a date, or a longer `TZID` still leaves that one resource
  unreadable. Version 0.3.0 reports a resource with a zoned-form override as unreadable and
  drops all its occurrences from list and search results.
- **Time-range queries read all-day and floating values as UTC.** iCloud ignores the
  calendar's `calendar-timezone` for them. The server therefore sends a window built from
  both the requested instants and the requested civil digits read as UTC. After the query it
  keeps zoned and UTC events whose instants overlap the requested range. It keeps all-day,
  floating and unrecognised-zone events whose digits, read as UTC, overlap the range widened
  by 24 hours on each side. Events within that 24 hours outside the edges can appear in
  results.
- **Moved occurrences.** iCloud returns an occurrence that was moved to another time only
  when the query window covers both its original slot and its new time. A window that covers
  only the new time misses it. This was measured with the new time after the series' last
  instance and with it inside the series. The server therefore queries 31 days beyond each
  end of the requested range and filters afterwards. An occurrence moved more than 31 days
  from its original date can still be missed by a short query. The largest window sent is
  430 days (366 days of range plus the padding).
- **Text filters are ignored.** `search_events` matches text in the server.
- **Yearly all-day series on 29 February** clamp to 28 February in non-leap years. RFC 5545
  would skip those years. The server passes iCloud's expansion through, because it is what
  Apple Calendar shows. `rrule-temporal`, `node-ical` and `ical.js` all disagree with iCloud
  here, so none of them can serve as a test oracle for it.
- **Other expansion facts.** `RANGE=THISANDFUTURE` on an override is stored but ignored by
  the expansion: only the named instance moves. An all-day event with `DTEND` equal to
  `DTSTART` is accepted and read back unchanged, so the reader treats it as a one-day event.
  `calendar-data` from a REPORT and from a GET differ only in line endings.
- **Attachments are rare** in the owner's account: at least 6 managed and 3 external
  attachments, 0 inline. The external ones are `https` links to hosts outside Apple.
  iCloud preserves inline base64 and external-link attachments unchanged when they are
  written through CalDAV.
- **Managed attachments** (RFC 8607) are served from `gateway.icloud.com` over `https`. The
  URL has a file name in its path and no query string. It does not contain the `MANAGED-ID`
  or the account's id. A plain `GET` with no `Authorization` header and no cookies returned
  status 200 and the exact bytes for the one attachment the probe uploaded, so the URL
  works like a bearer link. The response had no `Content-Length`, ignored `Range` and did not
  redirect. The server therefore downloads managed attachments without credentials and never
  sends the CalDAV credentials to that host. The size limit rests on a hard 20 MiB cap on the
  streamed body, with the `SIZE` parameter of the `ATTACH` as a further upper bound.

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
- **Scopes:** `calendar:read`, `calendar:write`, `calendar:delete`, and a separate
  `calendar:invite`, because saving an event with attendees may send invitations. The user
  chooses on the login page which requested scopes to grant (on develop, not released; see
  "Scopes and consent" in [auth-design.md](auth-design.md)).

### Deployment

- The public hostname is `caldav-mcp.rungie.com`. The bootstrap template pins it as the only
  allowed value of `PublicDomainName`. The Bearer challenge header and the exported origin are
  built from that parameter.
- The first deployment follows the stages wildduck-mcp went through. The bootstrap stack is
  created with a placeholder `FunctionUrlOrigin`. The service is then deployed, which creates the
  real Function URL. The bootstrap stack is then updated with that origin, and the deployment
  verification runs. The README gives the steps. They were carried out on 2026-11-11.
- The DynamoDB table stays at 1 RCU and 1 WCU.
- The keyring stays under the AWS-managed `aws/ssm` key.
- CI is the same as wildduck-mcp: actions are pinned by tag and the deploy job has no approval
  environment.
- The branch model is gitflow, as in wildduck-mcp. Work happens on `develop`. `main` receives
  merges only for releases, through the `postversion` script. Deployments run from `main`.

### Tools

`list_calendars`, `list_events`, `search_events`, `get_event`,
`get_event_attachment_download`, `create_event`, `update_event`, `delete_event`.

Released in version 0.3.0 (2026-11-12): `list_calendars` (first released in 0.1.1), `list_events`,
`search_events` and `get_event` (first released in 0.2.1) and `get_event_attachment_download`.
All five need the scope `calendar:read`. Designed, not built: the three write tools.

- Date ranges are required and capped at 366 days, within the years 1900 to 2100. Each
  boundary must carry an explicit offset or `Z`. The range is half-open: the start is
  included, the end is not.
- `list_events` and `search_events` read several calendars in one call. `calendar_ids` is
  optional (1 to 20 ids from `list_calendars`); when it is omitted, every calendar that holds
  events is read. The result has a status for each calendar (`ok`, `not_found`,
  `reconnect_required`, `temporarily_unavailable`, `upstream_error`, `result_too_large` or
  `not_read`). One failing calendar does not fail the call.
- Result limits: `limit` defaults to 25 and is at most 100. The whole serialized response is
  capped at 96 KiB. The tool result carries the JSON twice (structured and text), which is
  why 100 full events do not always fit. When a result is cut, it has `truncated: true`, the
  reasons (`result_limit`, `response_bytes`) and a `resume_hint` with the civil start of the
  last event returned. The hint is not a cursor: the agent queries again from that time and
  removes duplicates by `calendar_id`, `resource_href` and `recurrence_id`.
- Events come from iCloud's server-side expansion (`calendar-query` with `expand`), one
  query per calendar, three calendars at a time. The server does not expand recurrences
  itself and does not fetch the original event for list or search. Results are sorted by the
  stored local start time, not on one time axis, because the zones differ.
- `search_events` fetches the range and matches text in this server, case-insensitively, as
  literal text, against the full title, description and location before they are shortened.
  The server ignores a text-match filter, so matching here is required.
- Cancelled events are shown, with `status: "CANCELLED"`.
- `get_event` takes `calendar_id` and `resource_href` from a list or search result, and
  `recurrence_id` for one occurrence. It returns the stored master or single event when
  `recurrence_id` is omitted. `expected_version` (the ETag from the list) turns a change in
  between into the error `calendar_changed`. It returns attendees, the organizer, attachment
  metadata for the master and every override, and the stored iCalendar text when
  `include_raw` is true. The raw text is unmodified, with attachment links and base64
  included; it is cut to a 16 KiB prefix with `raw_truncated` set when longer.
- An event the server cannot read goes into `unreadable` (at most 50 entries, with a
  count). It does not fail the call.
- Shared calendars appear in `list_calendars`. Whether a calendar is owned, shared with the
  owner or shared by the owner can be read from `resourcetype`, `owner` and `invite`. No tool
  returns it yet.
- All calendar text (titles, notes, locations, attendee names, time zone names, file names
  and the raw iCalendar text) is untrusted data.

`get_event_attachment_download` takes `calendar_id`, `resource_href`, an `attachment_ref`
from `get_event`, and optional `recurrence_id` and `expected_version`. It reads the event
from iCloud again and selects the attachment itself; it never takes a URL from the client.
It returns a short-lived link to a copy of the attachment, not the bytes in the tool
result:

- An inline attachment (base64 in the event) is decoded from the event and staged.
- A managed attachment is fetched from `gateway.icloud.com` without credentials (see
  "Managed attachments" above) and staged. The rules are in one reviewed module,
  `src/caldav/managed-attachment-policy.ts`: `https`, exactly that host, the default port,
  no user info or fragment, a `MANAGED-ID` on the `ATTACH`, and no path under the
  account's calendar home, no `.ics` path and no collection path. Redirects are refused, not
  followed. Owner decision OD9 allows credentials to go to an Apple download host that asks
  for a login (401 with a Basic challenge), but only to a host on a separate list. That list
  is empty, because no host has been seen to need a login.
- Any other link is not fetched, so the server cannot be used to reach other hosts. Its URL
  is returned as an external link with `fetched_by_server: false`. A `MANAGED-ID` link that
  the policy refuses is treated the same way. A link with a user name or password (even an
  empty one) is refused as `unsupported_attachment`, not returned with them stripped.

A staged copy is at most 20 MiB. It is written under a new random key in a private S3
bucket and served with a presigned link that lasts at most five minutes, always as a file
download. S3 deletes copies about a day after they are written.

### Libraries

| Purpose | Library | Note |
|---|---|---|
| CalDAV protocol | A small client in `src/caldav/` | It runs over the guarded fetch, with `fast-xml-parser` behind a strict wrapper (`src/caldav/xml.ts`). |
| Parse and edit iCalendar | `ical.js` | Reads use only `ICAL.parse`, which returns plain jCal arrays. It registers no time zones by default. |
| Recurrence expansion | iCloud, through `calendar-query` with `expand`. | iCloud applies `RECURRENCE-ID` overrides and `EXDATE`s. The server does not merge them. |
| Zone conversion | built-in `Temporal` | Used only to add `utc` and `offset` for IANA zone names. Range boundaries and event spans use integer arithmetic. |
| Attachment staging | `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, pinned at 3.1166.0 | One `PutObject` per download and a locally signed GET link. The client is created on the first download. |

The server does not use `tsdav` 2.5.0. It sends extra requests per calendar and a
`.well-known` lookup. It also reports 403, 5xx and parse failures as the same error, so
"wrong password" cannot be told apart from "temporarily unavailable". The other rows are
phase 2 choices.

Do not use `rrule` (unmaintained, known time-zone weaknesses). `rrule-temporal` and
`node-ical` are not dependencies, and the recurrence code in `ical.js` is not used. They
disagree with iCloud on the 29 February case, and iCloud's answer is the one that counts.

A new event with a `TZID` is sent without a `VTIMEZONE` block. See datetime rule 7.

## Datetime rules

Rules 1 to 6 apply to reads, which are built. Rules 7 and 8 record decisions for the write
phases, which are not built.

1. Every time that a client sends must carry its timezone: an RFC 3339 timestamp with an
   explicit UTC offset or `Z`. A time without one is rejected with `invalid_input`, whose
   message says that a timezone is required. An offset counts as a timezone.
2. Times that come from the calendar are passed through as stored. The agent always gets the
   timezone information that is on the calendar card. A time has one of four shapes:
   - zoned: `local` (wall-clock text) and `zone` (the `TZID` text, unchanged);
   - UTC: `utc`;
   - floating (no `TZID`, no `Z`): `local` and `floating: true`;
   - all-day: `date` and `all_day: true`.
3. For a zoned time whose `zone` is an IANA name that the runtime's `Temporal` recognises,
   the server adds `utc` (the instant) and `offset`, computed with `Temporal`'s default
   disambiguation. They are best-effort extras. For any other zone name they are absent.
   The server does not second-guess the stored values and does not cross-check iCloud's.
4. A time can carry a `timezone_warning`. It is a fixed data item, not an error. Its values:
   - `no_timezone_on_event`: a floating time. The event has no timezone, so the instant is
     unknown. There is no `utc` or `offset`.
   - `unrecognized_timezone`: the `zone` is not an IANA name that the runtime recognises
     (a Windows name such as `Pacific Standard Time`, for example). It is passed through
     with no `utc` or `offset`.
   - `timezone_dropped_from_date`: an all-day date carried a timezone, which the server
     dropped (rule 5).
   - `utc_uncertain_dst_transition`: the local time falls in a repeated or skipped hour of a
     recognised zone. `utc` and `offset` are still given, but iCloud may use a different
     instant. In a repeated hour iCloud uses the second occurrence and `Temporal`'s default
     is the first, so the extras can be an hour off. iCloud rewrites a skipped-hour time.
5. All-day events (`VALUE=DATE`) are dates, not times. They never carry a timezone, never
   get `utc` or `offset`, and never get the floating warning. The end date is exclusive. A
   stored date that carries a stray `TZID` is returned as the date only, with
   `timezone_warning: "timezone_dropped_from_date"`. This also applies in the other
   direction for writes: a client's all-day date that carries a timezone is accepted, the
   timezone is dropped, a plain `DATE` is sent to iCloud, and the write result carries the
   same warning.
6. The server does not read an embedded `VTIMEZONE` and does not map Windows zone names to
   IANA names. This is a decision, not a gap: the consumer is an agent that can read a zone
   name itself, and mapping zone names in code is unreliable. iCloud's expansion drops the
   `VTIMEZONE` anyway.
7. For writes, an unrecognised zone name is not pre-checked. It is sent to iCloud as given.
   If iCloud refuses it, the agent gets iCloud's status and a bounded, sanitised form of its
   message. For a new event this server sends the IANA `TZID` without a `VTIMEZONE`, and
   iCloud adds the definition. This is confirmed for `Europe/Berlin` only. A time in a
   skipped or repeated hour is not rejected either, but iCloud changes or reinterprets it
   (see "Known quirks"), so a write must not assume that iCloud stored the time it was sent.
8. A duration in days is calendar-day arithmetic, not multiples of 24 hours.
9. Updates edit the parsed original component, so unknown properties (`X-APPLE-*`, alarms,
   attachments) survive. An event is never regenerated from a simplified object. iCloud
   preserved an unknown `X-` property with a parameter, and a `VALARM`, unchanged on a round
   trip.
10. Editing a recurring event requires an explicit scope: `this`, `this_and_future`, or
    `all`. There is no default. Reading with iCloud's expansion does not change this: writes
    still edit the master event and its overrides.
    - `this`: a `RECURRENCE-ID` override in the same resource.
    - `this_and_future`: set `UNTIL` on the original series and create a new series.
      `RANGE=THISANDFUTURE` is not emitted, because iCloud ignores it when it expands.
11. Organizer edits increase `SEQUENCE` and refresh `DTSTAMP`. iCloud changes neither, so this
    server must.
12. Leap seconds need no handling.

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
| 1 | Skeleton from wildduck-mcp: OAuth, keyring, store, deployment, CI, adapted login page, allowlist, `list_calendars` only. | Deployed and connected from Claude. | Done 2026-11-11. Deployed (version 0.1.1, https://caldav-mcp.rungie.com) and connected from a Claude client, by the owner's report; not checked from server logs. |
| 2 | Read path: time model, parsing, occurrences from iCloud's expansion, `list_events`, `search_events`, `get_event`. | The read path passes a corpus of awkward events under Node and Bun. Occurrences come from iCloud's expansion and are passed through as it returns them. | Released in version 0.2.1 (2026-11-12). |
| 2b | Attachment download: `get_event_attachment_download` for inline and managed attachments, with short-lived staged copies. | An agent can download every attachment that iCloud holds for an event, including managed ones. The server keeps no calendar data except attachment copies staged for about one day. | Released in version 0.3.0 (2026-11-12). Verified locally against one real iCloud account with an in-memory store in place of S3: 6 managed attachments fetched and staged with correct file signatures, 3 external links returned without being fetched. The real S3 upload and presigned link were then verified on 2026-11-12 on the live service through a Claude client (a 43,935-byte managed PNG staged, downloaded byte-exact as a forced download with server-side encryption, the unsigned object URL refused with 403). A real inline download is not verified; none exists in the owner's data. |
| 3 | Writes for single events: create, update, delete, all-day, alarms. | Conflict and retry tests pass; verified in Calendar.app. | Designed, not built. A probe extension for writes is in progress. |
| 4 | Recurring writes with the three edit scopes. | Verified in Calendar.app across a daylight-saving change. | Not started. |
| 5 | Optional: attendees and invitations, a free-time finder. | Depends on phase 0 results. | Not started. |

Development is test-first. The corpus in phase 2 should include real exported events with
names and details replaced.

## Open decisions

No decisions are open.

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
- A short `list_events` or `search_events` query can miss an occurrence that was moved more
  than 31 days away from its original date. A calendar that silently omits events cannot be
  detected: `complete` reports only that this server finished processing.
- Results can include all-day and floating events up to 24 hours outside the range edges.
  They are passed through, not converted to a timezone.
- Results are sorted by stored local start time, which is not chronological across zones.
- `get_event` with `include_raw` returns the stored text unmodified, including attachment
  links. A managed attachment link works without credentials, so anyone who sees it can
  download that file. The raw text may also contain malicious instructions, like all
  calendar text.
- A download link from `get_event_attachment_download` works for anyone who holds it until
  it expires, at most five minutes after it was issued. Revoking a grant does not revoke a
  link already issued. Staged copies are deleted by an S3 lifecycle rule about a day after
  they are written; S3 does not promise the exact time.
- An external attachment link is returned as stored on the event and was not checked. It
  can point anywhere the event's author chose.
