# Phase 0 probe: run instructions

The probe checks what Apple's iCloud CalDAV server really does, for every point that
[plan.md](plan.md) marks unproven, unconfirmed, untested or reported, and for each item under
"Known quirks". Each check reports `confirmed`, `refuted`, `inconclusive`, `skipped` or `error`
against one exact claim.

**Status: the read-only and `--write` modes have each been run once against a real iCloud
account, from a laptop, on 2026-11-11 (read-only: 17 checks, 16 confirmed, 1 refuted; write:
37 checks, 35 confirmed, 2 refuted, both temporary calendars removed and verified). The
`--invite` and `--cleanup` modes have only been run against the simulated CalDAV server in the
test suite, and the Lambda path has never been run against real AWS.** Expect some checks to
come back `inconclusive` on the first real run of a mode. That is a result, not a failure.

## What each mode can change in your account

| Mode | Requests sent | What can change |
|---|---|---|
| default (read-only) | `OPTIONS`, `PROPFIND`, `REPORT`, `GET` only | Nothing. The HTTP layer refuses every other method. |
| `--write` | adds `MKCALENDAR`, `PUT`, `DELETE` | Creates up to two calendars named `caldav-mcp-probe-<8 hex digits>`, writes synthetic events into them (summary "caldav-mcp probe event", dated 10 to 47 days ahead), then deletes both calendars and checks they are gone. Your devices may show these calendars for a moment. `PUT` and `DELETE` outside those calendars are refused by the HTTP layer. None of these events has attendees. |
| `--write --invite` | as `--write` | Additionally saves one event with you as organizer and one attendee address you supply. See [the invite run](#3-invite-run-optional-sends-a-real-invitation) before using it. |
| `--cleanup` | the read-only methods, plus `DELETE` | Deletes only calendars the probe itself left behind, and only after you type `delete` (rules below). |

All requests go only to `https://caldav.icloud.com` and to hosts matching `pNN-caldav.icloud.com`,
checked before every request and every redirect. Requests are sent sequentially, at least
150 ms apart, with one exception: the pacing check sends one short burst of 10 sequential
`PROPFIND`s without the 150 ms spacing, followed by 5 `PROPFIND`s in parallel. At most 400
requests per run, each with a 20 s timeout (8 s for cleanup requests); date-range queries stay
within about 60 days either side of today. A check stops on HTTP 429 or 503 and records
`Retry-After`; after three such answers the run stops making new requests and only cleans up.

### A rejected password is tried once

The first request of every run is an authenticated `PROPFIND` that proves the credentials
(the probe does not start with an `OPTIONS` request, because a server may answer that without
checking the password). After the first HTTP 401 from any request, the probe sends nothing
else in that run; every later request fails at once with the fixed code `unauthorized`. The
only exception is one `DELETE` attempt for each temporary calendar a `--write` run already
created; if that is also refused, even that stops. So **a wrong password costs exactly one
failed sign-in**. The run ends with:

> Authentication failed (HTTP 401) on the first request, so nothing else was sent. Check the
> Apple ID and the app-specific password. Do not retry repeatedly: each attempt with a wrong
> password counts as a failed sign-in, and repeated failures can lock the Apple ID.

and exit status 1. Fix the Apple ID or password before trying again, rather than re-running.

### Settings the probe refuses

Before it prompts for anything, the probe stops (exit status 2, fixed message) when:

- `BUN_CONFIG_VERBOSE_FETCH` is set to anything: Bun would print every request, including the
  `Authorization` header that carries the password;
- `NODE_TLS_REJECT_UNAUTHORIZED` is `0`: certificate checks would be off.

It prints a warning (and records `environment.extraCaCertsSet: true`) when `NODE_EXTRA_CA_CERTS`
is set, because an extra certificate authority is then trusted for the connection to iCloud.
The Lambda handler refuses the same two settings with `{"error":"unsafe_environment"}`.

## Prerequisites

1. Bun 1.4.4 or later (`bun --version`), and `bun install` run in this repository.
2. A **dedicated** app-specific password for the probe:
   1. Sign in at <https://account.apple.com>.
   2. Open **Sign-In and Security**, then **App-Specific Passwords**.
   3. Generate a password with a label such as `caldav-mcp probe`.
   4. Copy it exactly as shown (`xxxx-xxxx-xxxx-xxxx`). The probe sends it exactly as typed and
      records only whether it contained hyphens. It does not try other spellings, because
      repeated failed sign-ins could lock the account.
   5. Revoke it on the same page when you have finished with the probe.

An app-specific password also opens iCloud Mail and Contacts, so do not reuse one created
for anything else.

## Supplying credentials

The probe never accepts credentials as command-line arguments (it refuses any unknown argument
with exit status 2) and never reads them from a file or writes them anywhere.

**Use the built-in prompts.** Run the probe with no `PROBE_*` variables set. It asks for the
Apple ID, then for the password with echo turned off. The prompts are written to stderr, so
they still appear when stdout is redirected to a file (as in every example below).

**Environment variables are for non-interactive use only** (no terminal on stdin). Read the
values into shell variables that are not exported, and pass them to the one command that needs
them, so they never sit in your environment or your shell history. The `read` syntax differs
between shells:

bash:

```bash
read -r -p 'Apple ID: ' probe_id
read -rs -p 'App-specific password: ' probe_pw; echo
PROBE_APPLE_ID="$probe_id" PROBE_APP_PASSWORD="$probe_pw" bun run probe -- --json > docs/probe-results/local-read-only.json
unset probe_id probe_pw
```

zsh (the macOS default shell):

```zsh
read -r 'probe_id?Apple ID: '
read -rs 'probe_pw?App-specific password: '; echo
PROBE_APPLE_ID="$probe_id" PROBE_APP_PASSWORD="$probe_pw" bun run probe -- --json > docs/probe-results/local-read-only.json
unset probe_id probe_pw
```

The same pattern works for every command below: put the `PROBE_…=` assignments in front of
the one `bun run probe …` command.

## Running on your laptop

Create the results directory once:

```bash
mkdir -p docs/probe-results
```

Exit status: 0 when the run finished; 1 when it failed, stopped on a 401, or a probe calendar
remains or could not be verified as removed; 2 for a usage error, a refused setting, or a
missing confirmation.

### 1. Read-only run (start here)

```bash
bun run probe -- --json > docs/probe-results/local-read-only.json
```

Without `--json` the probe prints a text report followed by the JSON. If it reports HTTP 401,
stop and check the Apple ID and password (see above) rather than retrying.

### 2. Write run

```bash
bun run probe -- --write --json > docs/probe-results/local-write.json
```

At the end the probe always sends a `DELETE` for every calendar it tried to create (a 404 answer
is fine), checks with `PROPFIND` that each answers 404, and then lists your calendar home once.
If MKCALENDAR answered with a `Location` header naming another address, that address is used
instead, but only when it is directly inside your calendar home, was not there before the run,
and shows the probe's own calendar name.

Removal is reported as verified only when the final listing shows none of this run's
`caldav-mcp-probe-…` calendars anywhere. Otherwise the report says **TEMPORARY CALENDAR NOT
REMOVED** at the top and bottom (and on stderr), names the calendar, and the command exits
with status 1. If the leftover is at an address the server chose (not
`…/caldav-mcp-probe-<hex>/`), the message says that `--cleanup` will not remove it and that it
must be deleted by hand in Calendar.

**After every `--write` run, open Calendar (or icloud.com/calendar) and check that no calendar
named `caldav-mcp-probe-…` is left.** Delete any you find.

Ctrl-C, `SIGTERM` or `SIGHUP` once stops the checks and still removes the calendars; a second
one exits at once (then run `--cleanup`, below, and check Calendar).

### 3. Invite run (optional; sends a real invitation)

`--invite` saves one event that lists an attendee address you supply. Before using it, know
that:

- iCloud may deliver a real invitation. An iCloud recipient may get it inside the Calendar app
  rather than as an email; anyone else is likely to get an email.
- The recipient sees your address and your name as the organizer.
- The probe deletes the event straight away. Deleting it may or may not send the recipient a
  cancellation.

Use an attendee address you control and can check. The probe prints this warning and asks you
to type `send`:

```bash
bun run probe -- --write --invite --json > docs/probe-results/local-invite.json
```

Without a terminal, also pass the address and the confirmation, for that one command
(bash: `read -r -p 'Invitation recipient: ' probe_to`; zsh: `read -r 'probe_to?Invitation recipient: '`):

```bash
PROBE_APPLE_ID="$probe_id" PROBE_APP_PASSWORD="$probe_pw" PROBE_INVITE_ATTENDEE="$probe_to" PROBE_INVITE_CONFIRM=send bun run probe -- --write --invite --json > docs/probe-results/local-invite.json
```

Afterwards, **check that mailbox (and, for an iCloud address, that account's Calendar) by
hand** and note whether an invitation, and a cancellation, arrived. The probe cannot see
either; it records only iCloud's `SCHEDULE-STATUS` code and `Schedule-Tag` header.

### 4. Cleanup

```bash
bun run probe -- --cleanup
```

A calendar is deleted only when **all** of these hold:

1. its display name is exactly `caldav-mcp-probe-` followed by 8 lower-case hex digits;
2. its address is directly inside your calendar home and its last segment is that same name
   (the address the probe's own MKCALENDAR uses);
3. it is a plain calendar you own: not shared in either direction, not a subscription, no
   sharing or invitation property, no other owner;
4. everything in it was written by the probe: each item is named `<UID>.ics` with a UID of the
   form `caldav-mcp-probe-<hex>-<suffix>`, contains only events with that UID and a summary
   starting `caldav-mcp probe `, and there are at most 50 items.

The probe then lists the candidates (only names of exactly that form are ever printed) and asks
you to type `delete`. Without a terminal, set `PROBE_CLEANUP_CONFIRM=delete` for that one
command. Anything else deletes nothing. The HTTP layer enforces rules 1 and 2 again on every
cleanup `DELETE`.

The report states exactly how many calendars were deleted and verified gone, and lists every
probe-named calendar that was found but not deleted, with a reason code:

| Reason | Meaning | What to do |
|---|---|---|
| `url_not_probe_pattern` | The name is right but the address is not `…/caldav-mcp-probe-<hex>/` | `--cleanup` will not remove it; delete it by hand in Calendar if it is a leftover |
| `shared`, `subscribed`, `sharing_property`, `not_owned`, `not_calendar` | Rule 3 failed | Delete it by hand only if it is yours to remove |
| `foreign_resource`, `too_many_resources`, `contents_unreadable` | Rule 4 failed or could not be checked | Look inside it in Calendar first |
| `registration_refused` | The HTTP-layer safety check refused it | Delete it by hand only if it is yours to remove |
| `not_confirmed` | You did not type `delete` | Run `--cleanup` again |

Calendars whose name merely starts with `caldav-mcp-probe-` (for example one you named
`caldav-mcp-probe-notes`) are never deleted or printed; the report only counts them
(`lookalikesIgnored`). The command exits with status 1 if any probe-named calendar is left.

## Running from AWS Lambda

This answers "behaviour from AWS addresses". It uses a throwaway function that you delete
afterwards. **Untested against real AWS**: the commands below follow AWS CLI v2 syntax as
documented, but have not been run.

The credentials travel only in the invocation payload: the local `bun run probe -- --lambda`
collects them (prompt, or environment as above) and passes the payload to `aws lambda invoke`
on stdin (`--payload fileb:///dev/stdin`). They never appear in an argument, a file or a Lambda
environment variable, and the function writes nothing to its logs. The response is written to a
private temporary directory outside the repository, read, printed and removed (also on Ctrl-C
and on a fatal error).

So that the credentials can only reach your probe function, `--lambda`:

- accepts only a function **name** matching `caldav-mcp-probe` followed by at most 40 letters,
  digits, `_` or `-` (no ARNs; a following flag such as `--write` is never taken as the name);
- requires `AWS_REGION` (or `AWS_DEFAULT_REGION`) to be a region such as `us-west-2`, and exits
  with status 2 before prompting if it is missing or malformed;
- runs the AWS CLI with `--region <region> --endpoint-url https://lambda.<region>.amazonaws.com
  --output json --no-cli-pager --no-cli-auto-prompt`, removes `AWS_ENDPOINT_URL` and every
  `AWS_ENDPOINT_URL_*` variable from its environment, and turns retries off (so a timeout
  cannot run the probe twice).

Use the region you intend to deploy to:

```bash
export AWS_REGION=us-west-2
```

### 1. Build

```bash
bun run build:probe
```

This writes `dist/probe/handler.mjs` and `dist/probe.zip`. If `src/caldav/icloud.ts` exists it is
bundled, so the skeleton-backend check also runs from Lambda.

### 2. Create a logging-only role

```bash
aws iam create-role --role-name caldav-mcp-probe-role --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
```

```bash
aws iam attach-role-policy --role-name caldav-mcp-probe-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

```bash
ROLE_ARN=$(aws iam get-role --role-name caldav-mcp-probe-role --query Role.Arn --output text)
```

A new role can take a few seconds before Lambda accepts it; if the next command says the role
cannot be assumed, wait ten seconds and repeat it.

### 3. Create the function

```bash
aws lambda create-function --function-name caldav-mcp-probe --runtime nodejs26.x --architectures arm64 --handler handler.handler --timeout 300 --memory-size 256 --role "$ROLE_ARN" --zip-file fileb://dist/probe.zip
```

```bash
aws lambda wait function-active-v2 --function-name caldav-mcp-probe
```

Use the 300 s timeout. The probe stops starting new checks when less than 140 s remain: enough
for every cleanup request (at most 13, each with an 8 s timeout and at most 2 s of waiting)
plus one spare.

### 4. Invoke

```bash
bun run probe -- --lambda caldav-mcp-probe --json > docs/probe-results/lambda-read-only.json
```

```bash
bun run probe -- --lambda caldav-mcp-probe --write --json > docs/probe-results/lambda-write.json
```

`--lambda caldav-mcp-probe --cleanup` asks you to type `delete` before invoking (or reads
`PROBE_CLEANUP_CONFIRM=delete`), because the function cannot ask; it then applies the same
rules as a local `--cleanup` without listing the candidates first. The event carries
`cleanupConfirmed: true`, and the function refuses a cleanup event without it.

If the invocation fails, the probe prints only a fixed code (`aws_cli_failed`, `function_error`,
`lambda_status`, `invoke_failed`, `interrupted`), because AWS CLI output can contain account
details.

Ctrl-C during `--lambda` does **not** stop the run on AWS: it continues until it finishes or the
function times out. The probe says so, stops waiting and removes its local temporary directory.
If it was a `--write` run, wait five minutes, then run `bun run probe -- --cleanup` locally and
check Calendar for any calendar named `caldav-mcp-probe-…`.

### 5. Delete everything

```bash
aws lambda delete-function --function-name caldav-mcp-probe
```

```bash
aws iam detach-role-policy --role-name caldav-mcp-probe-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

```bash
aws iam delete-role --role-name caldav-mcp-probe-role
```

```bash
aws logs delete-log-group --log-group-name /aws/lambda/caldav-mcp-probe
```

The last command fails harmlessly if no log group was created.

## What the report contains

Every run prints a text report followed by the same report as JSON (`--json` prints only the
JSON). The JSON (schema version 2) has: schema version, probe version, timestamp, run location
(`local` or `lambda`), the AWS region on Lambda, the mode flags, totals, `auth`
(`{ rejected, onFirstRequest }`: whether a 401 stopped the run), `environment`
(`{ extraCaCertsSet }`), a `cleanup` section in write and cleanup runs, and one entry per check:
`{ id, planItem, claim, outcome, summary, evidence }`.

The `cleanup` section is `{ tempCalendars, notDeleted, deleted, allRemoved }`: the calendars the
probe deleted or tried to delete (each with `removalVerified`), the probe-named calendars found
but not deleted (each with a `reason` from the table above, or `still_listed` /
`server_chosen_url` in a write run, and `cleanupCanRemove`), how many were deleted and verified
gone, and `allRemoved`, which is true only when every deletion was verified and nothing was
left.

Evidence is limited to HTTP status codes, counts, booleans, response header **names**, DAV
capability tokens, element and property names, timings, and the *shapes* of hrefs, ETags and
sync tokens. For example, an href appears as `/<id>/calendars/<id>/`, an ETag as
`{"quoted":true,"weak":false,"length":34}`, and the per-account host only as
`homeHostMatchesPerAccountPattern: true`. A server-supplied name is shown only when it looks
like a name (a letter, then letters, digits, `:`, `_`, `.` or `-`, at most 64 characters, no
run of five digits) and, unless it is a standard header, element or property name, does not
overlap any value seen from the account; otherwise it appears as `<other>`.

It is designed to be safe to share. It never contains your Apple ID, password, DSID or other
account numbers, calendar names (except the probe's own `caldav-mcp-probe-…` names), event
titles, descriptions, locations, attendees or UIDs, ETag values, or sync tokens.

A second layer is a safety net in case a check ever puts a value seen from the server or typed
by you into the report. It looks only at the parts of the report that vary from run to run: the
numbers and names inserted into a summary, and evidence values that are not the probe's own
codes, standard protocol names, href shapes or its `caldav-mcp-probe-…` names. A part that
contains such a value is replaced as a whole by `<scrubbed>`. The probe's own text (ids, plan
items, claims, the fixed wording of summaries, evidence key names and its own codes) is never
changed, so the report reads the same whatever words your calendars hold.
`redaction.scrubbedOccurrences` counts the replacements and should be 0. With `--lambda`, the
report that comes back is checked again on your machine against your Apple ID, password and
invite address (whole values only), and any string that contains one is replaced whole and
added to that count. Reports produced by probe version 0.1.0 could reveal a short word from
the account's data when `redaction.scrubbedOccurrences` was not 0; check that field before
sharing an older report.

The test suite runs the whole probe against a simulated server seeded with marker strings in
every one of those places (including hostile header, element and property names) and fails if
any of them appears in the output, raw, URL-encoded or base64-encoded. It also seeds short
words that occur inside the probe's own text ("side", "time", "probe" and others) and requires
every mode's report to be byte-identical to a run with neutral words. Read the JSON before
sharing it all the same.

## Handing the results back

Either commit the JSON files under `docs/probe-results/` (one per run, named for location and
mode as above), or paste the JSON into the conversation. For the invite run, add one line saying
whether the invitation and the cancellation arrived, and where (email or Calendar).

## Checks and what they test

| Check id | Plan item |
|---|---|
| `discovery`, `discovery-stability` | Discovery via `caldav.icloud.com` to a `pNN-caldav` host; stored URLs stable |
| `auth-app-password` | HTTP Basic with the app-specific password as typed (records only whether it had hyphens) |
| `dav-capabilities`, `scheduling-properties` | Capability tokens (`calendar-auto-schedule` etc.) and organizer properties |
| `collections` | Owned, shared-with-me, shared-by-me and subscribed calendars; components; write privilege |
| `time-range`, `write-time-range` | Time-range filtering |
| `free-busy-query` | "Free/busy query rejected (HTTP 400)" |
| `expand-read`, `write-expand` | Server-side recurrence expansion |
| `text-match-read`, `write-text-match` | Server-side text search |
| `uid-filter`, `multiget` | "UID filter returns 412"; calendar-multiget by href |
| `sync-collection`, `sync-limit`, `write-sync-changes`, `write-sync-limit` | sync-collection, and "limit is ignored" |
| `etag-shape` | ETags usable as exact `If-Match` |
| `request-pacing` | Throttling observed (429/503, `Retry-After`) including the 10 + 5 request burst |
| `skeleton-backend` | `src/caldav/icloud.ts` discover and list against the real server (only after the probe's own discovery succeeded) |
| `write-mkcalendar` | MKCALENDAR creates a VEVENT calendar (and whether the server answered with its own `Location`) |
| `write-create-if-none-match` | A second create with `If-None-Match: *` is refused (create-retry safety) |
| `write-if-match-exact`, `write-if-match-stale`, `write-if-match-star` | Exact, stale and `*` `If-Match` |
| `write-no-end`, `write-duplicate-uid` | Known quirks: no `DTEND`/`DURATION`; same UID in two calendars |
| `roundtrip-*`, `server-rewrites` | Time zones (with and without `VTIMEZONE`), all-day, floating, UTC, unknown properties and alarms; what the server rewrites |
| `write-invite` | Invitations sent by the server (`--invite` only) |
| `write-delete-calendar` | The temporary calendars are deleted, verified gone, and absent from the final listing |
| `cleanup-leftovers` | `--cleanup` only |
