# caldav-mcp: assessment and development plan

Status: plan only. No code exists yet. This design has not had an independent review.

## Goal

A cloud-hosted MCP server that gives Claude clients (Claude, Cowork, Duet) read and write
access to Apple iCloud calendars over CalDAV. It must not depend on a laptop being awake.
It mirrors the security and deployment strategy of
[hughescr/wildduck-mcp](https://github.com/hughescr/wildduck-mcp).

## Out of scope

- **Reminders and tasks.** Since iOS 13, upgraded Reminders lists live in a store that
  CalDAV cannot see. No other server-side API was found.
- **Contacts (CardDAV).** Excluded by decision. Attendees are given as plain email addresses.
- **Push notifications and caching.** The server holds no calendar data. Each tool call
  reads iCloud when it needs to.
- **Other CalDAV providers.** iCloud only for now, behind an interface that could take
  another provider later.

## What iCloud provides

Apple has never documented its CalDAV server. The points below come from other clients'
published test results (mainly python-caldav's iCloud compatibility profile, probed
October 2026) and must be confirmed by the phase 0 probe.

| Capability | Status |
|---|---|
| Calendars and events: read, create, update, delete | Works. |
| Authentication | HTTP Basic with Apple ID and an app-specific password on every request. No session token, no documented OAuth. Apple's "Account Data Sharing" is a pilot with no public technical documentation. |
| Discovery | Start at `caldav.icloud.com`, follow `current-user-principal` and `calendar-home-set` to a per-account host (`pNN-caldav.icloud.com`). Never hard-code that host. |
| Free/busy query | Rejected (HTTP 400). Compute free time from events if it is ever needed. |
| Server-side recurrence expansion | Unproven. Design for client-side expansion. |
| Server-side text search | Unproven. Design for client-side matching within a date range. |
| Invitations when an event with attendees is saved | Reported to be sent by the server. Unconfirmed. |
| Rate limits, behaviour from AWS addresses | No published limits. No reports of blocking. Untested. |

Known quirks:

- An event without `DTEND` or `DURATION` is refused.
- The same `UID` cannot exist in two calendars.
- `If-Match: *` is broken. Every write must carry the exact ETag.
- A calendar-query filter on `UID` returns 412. Fetch by href or use calendar-multiget.
- The sync-collection `limit` is ignored.

## Architecture

### Reused from wildduck-mcp

The OAuth authorization server (dynamic client registration, client metadata documents,
PKCE, consent page, rotating refresh tokens), the AES-GCM keyring held in an SSM
SecureString, the DynamoDB store, the Hono application on a Lambda Function URL behind
CloudFront, the bootstrap stack, CI with GitHub OIDC, and the error and request-budget
conventions.

Everything under `src/mail/` and `src/wildduck.ts` is replaced.

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
   and opens the server's login page.
2. The login page takes an Apple ID and an app-specific password. The server proves them
   with a discovery request to iCloud.
3. The server stores the Apple ID, the app-specific password and the discovered URLs,
   encrypted with the same account-bound AES-GCM scheme that wildduck-mcp uses.
4. The client receives only this server's short-lived access token and rotating refresh token.
5. A 401 from iCloud marks the connection `reconnect_required`.

**Known weak point.** wildduck-mcp never stores a password. This server must, because
CalDAV has no session token. An app-specific password is not limited to calendars: it also
opens iCloud Mail and contacts. Mitigations: use a password generated only for this server,
which can be revoked at Apple on its own, and keep the encryption key outside the database.

Additional controls:

- **Allowlist of Apple IDs** in configuration. Without it, anyone could connect their own
  account to this deployment.
- **Fixed upstream host.** The login page accepts no server URL. Requests go only to
  `caldav.icloud.com` and to hosts matching the per-account pattern that discovery returns.
  This prevents the server from being used to send requests to arbitrary addresses.
- **Scopes:** `calendar:read`, `calendar:write`, and a separate `calendar:invite` that needs
  its own consent checkbox, because saving an event with attendees may send invitations.

### Tools

`list_calendars`, `list_events`, `search_events`, `get_event`, `create_event`,
`update_event`, `delete_event`.

- Date ranges are required and capped at 366 days. Result counts are capped. Nothing is
  silently truncated: a capped result says so.
- `search_events` fetches the range and matches text in this server.
- All calendar text (titles, notes, locations, attendee names) is untrusted data.

### Libraries

| Purpose | Library | Note |
|---|---|---|
| CalDAV protocol | `tsdav` (2.2.0 or later) | Behind an interface. It has iCloud discovery fixes. |
| Parse and edit iCalendar | `ical.js` | It registers no time zones by default. |
| Recurrence expansion | `rrule-temporal` | It does not merge `RECURRENCE-ID` overrides. This server does that. |
| Date arithmetic | built-in `Temporal` | |
| Test-only cross-check | `node-ical` | A second implementation to compare expansion results against. |

Do not use `rrule` (unmaintained, known time-zone weaknesses).

Open item: how to emit a `VTIMEZONE` block for a new event with a `TZID`. Decide in phase 2.

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
   names; an unknown zone is an error.
7. Updates edit the parsed original component, so unknown properties (`X-APPLE-*`, alarms,
   attachments) survive. An event is never regenerated from a simplified object.
8. Editing a recurring event requires an explicit scope: `this`, `this_and_future`, or
   `all`. There is no default.
   - `this`: a `RECURRENCE-ID` override in the same resource.
   - `this_and_future`: set `UNTIL` on the original series and create a new series.
     `RANGE=THISANDFUTURE` is not emitted.
9. Organizer edits increase `SEQUENCE` and refresh `DTSTAMP`.
10. Leap seconds need no handling.

## Write safety

- Every write to an existing event requires the opaque `expected_version` (the ETag) from a
  prior read, sent as an exact `If-Match`. A mismatch is a conflict error.
- Every write requires a stable `operation_id`. A create derives the event `UID` from it, so
  a retry cannot make a duplicate: iCloud refuses the second `PUT` and the server then
  verifies the stored event.
- After an uncertain outcome the server reports uncertainty. It does not claim success or
  failure.

## Phases

| Phase | Work | Done when |
|---|---|---|
| 0 | Probe script, run locally and from a Lambda with a real account. Tests: requests from AWS addresses, discovery, server-side expansion, text search, sync-collection, shared and subscribed calendars, time-zone handling on round trip, whether invitations are sent. | Results recorded in `docs/`. |
| 1 | Skeleton from wildduck-mcp: OAuth, keyring, store, deployment, CI, adapted login page, allowlist, `list_calendars` only. | Deployed and connected from Claude. |
| 2 | Read path: time model, parsing, expansion with override merge, `list_events`, `search_events`, `get_event`. | Passes a corpus of awkward events under Node and Bun, cross-checked against `node-ical`. |
| 3 | Writes for single events: create, update, delete, all-day, alarms. | Conflict and retry tests pass; verified in Calendar.app. |
| 4 | Recurring writes with the three edit scopes. | Verified in Calendar.app across a daylight-saving change. |
| 5 | Optional: attendees and invitations, a free-time finder. | Depends on phase 0 results. |

Development is test-first. The corpus in phase 2 should include real exported events with
names and details replaced.

## Open decisions

1. **Auth code: copy or share.** Recommended: copy `src/auth/` from wildduck-mcp now and
   extract a shared package after both servers are stable. Cost: a security fix must be
   applied in both repositories until then.
2. **First build step.** Recommended: phase 0 probe and phase 1 skeleton together. The
   alternative is the probe alone, so that its results arrive before any skeleton exists.
3. **Hostname** for the CloudFront distribution in the existing hosted zone.
4. **Branch model.** Assumed to mirror wildduck-mcp: `develop` for development, `main` deploys.
