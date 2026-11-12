# Phase 0 probe: run instructions

The probe checks what Apple's iCloud CalDAV server really does, for every point that
[plan.md](plan.md) marks unproven, unconfirmed, untested or reported, and for each item under
"Known quirks". Each check reports `confirmed`, `refuted`, `inconclusive`, `skipped` or `error`
against one exact claim.

**Status: the current probe version is 0.5.0.** The read-only mode and the `--write` mode have
been run against a real iCloud account, locally: both with version 0.4.1, and `--write` (which
includes every read-only check) with version 0.5.0. The `--invite` and `--cleanup` modes have
been tested only against the simulated CalDAV server, and the Lambda path has not been run
against real AWS. An `inconclusive` result is useful evidence, not a failed run.

The write-only managed-upload experiment (see [attachment checks](#attachment-checks)) fetches
the attachment that the probe itself uploaded, first without credentials. It sends Basic
credentials to an `*.icloud.com` attachment host only if that host answers 401 or 403 to the
anonymous request. The read-only attachment rules are stricter: they fetch an owner attachment
only on the two CalDAV hosts.

## What each mode can change in your account

| Mode | Requests sent | What can change |
|---|---|---|
| default (read-only) | `OPTIONS`, `PROPFIND`, `REPORT`, `GET` only | Nothing. The HTTP layer refuses every other method. (One `GET`, with `Range: bytes=0-0`, may fetch one managed attachment of yours; see [the attachment checks](#attachment-checks).) |
| `--write` | adds `MKCALENDAR`, `PUT`, `DELETE`, and `POST` for the two managed-attachment actions only | Creates up to two calendars named `caldav-mcp-probe-<8 hex digits>` (the first with a `calendar-timezone` of America/Los_Angeles, so floating times can be tested; if the server refuses that, the `MKCALENDAR` is repeated once without it), writes synthetic events into them (summary "caldav-mcp probe event", dated 10 to 80 days ahead; the phase 2 checks also write series up to about a year ahead, events on 2027-03-14 and 2027-11-07 (the days the clocks change in America/New_York) and one yearly all-day series starting on 2028-02-29; the attachment checks write three events, one of which gets a 32-byte text file attached), then cleanup is attempted, and calendar removal verified where possible. Your devices may show these calendars for a moment. `PUT`, `DELETE` and `POST` outside those calendars are refused by the HTTP layer, and the only `POST`s it accepts are `?action=attachment-add` and `?action=attachment-remove&managed-id=…` on a `.ics` event directly inside one of them. None of these events has attendees. |
| `--write --invite` | as `--write` | Additionally saves one event with you as organizer and one attendee address you supply. See [the invite run](#3-invite-run-optional-sends-a-real-invitation) before using it. |
| `--cleanup` | the read-only methods, plus `DELETE` | Deletes only calendars the probe itself left behind, and only after you type `delete` (rules below). |

The general sender allows only `https://caldav.icloud.com` and hosts matching `pNN-caldav.icloud.com`,
checked before every request and redirect. This remains the rule for all owner-data attachment
fetches. A separate write-only transport permits the probe's verified upload on an `*.icloud.com`
host, plus one anonymous redirect to `*.icloud.com` or `*.icloud-content.com`. It accepts only
HTTPS/default-port URLs without userinfo or fragments, never carries cookies, and never forwards
Authorization on a redirect, even to the same host. See [attachment checks](#attachment-checks).
Requests are sent sequentially, at least
150 ms apart, with one exception: the pacing check sends one short burst of 10 sequential
`PROPFIND`s without the 150 ms spacing, followed by 5 `PROPFIND`s in parallel. At most 400
requests per run, each with a 20 s timeout (8 s for cleanup, at most 10 s for managed-upload downloads). Date-range queries on
your calendars stay within about 60 days either side of today, with one exception: the
strictness census asks each calendar (at most 10) once for about 3 years either side. In
`--write` mode one check also queries the probe's own temporary calendar over 2028 to 2037. Most
checks stop on HTTP 429 or 503 and record `Retry-After`; managed-download steps record the status
and use the same transport cooldown. After three such answers the run stops making new requests
and only cleans up.

Request totals depend on the number of calendars and events, redirects, refusals and cleanup
retries; the hard limit is 400, with a reserve for cleanup. The phase 2 read checks add at most
49 requests over the basic checks, plus at most 2 attachment-fetch requests. The ETag comparison
reuses an expanded window and adds one multiget (at most two requests if an expansion was not
already cached). The write-expansion checks add 66 requests, or 67 if the calendar-timezone is
refused, and attachment writes add at most 14. See the per-check budgets below. These are budgets,
not promises about a real account's total. In the standard fake account, version 0.5.0 sends
**54 requests read-only and 184 with `--write` when expansion is enabled**. With the fake's default
expansion-disabled behavior, the totals are **54 and 170** (the two moved-override sanity checks
skip 8 and 6 narrow queries respectively). These totals include the ETag comparison and the
managed attachment's anonymous 401 followed by its authenticated GET.

### A rejected password is tried once

The first request of every run is an authenticated `PROPFIND` that proves the credentials
(the probe does not start with an `OPTIONS` request, because a server may answer that without
checking the password). After the first HTTP 401 from an authenticated request, the probe sends nothing
else in that run; the latch is set as soon as response headers arrive, before reading the body,
even if the body errors, times out or exceeds the cap. Every later ordinary request fails at
once with the fixed code `unauthorized`. The
only exception is one `DELETE` attempt for each temporary calendar a `--write` run already
created; if that is also refused, even that stops. So **a wrong password costs exactly one
failed sign-in**. An anonymous 401 in the managed-upload experiment is a challenge, not a
rejected login: only that experiment's initial 401/403 permits one Basic attempt to the exact
ATTACH URL. A 401 on its anonymous redirect hop never triggers Basic or the latch.
The run with a wrong password ends with:

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

Cleanup is attempted, and calendar removal verified where possible: the probe attempts a
`DELETE` for every calendar URL it requested in `MKCALENDAR` (a 404 answer is fine), checks
with `PROPFIND` for 404/410, and lists your calendar home once. Timeouts, request limits and
the 401 latch can prevent these steps from completing.

A `Location` is accepted only when its canonical URL equals the URL requested in `MKCALENDAR`.
A differing or invalid Location stops that creation check as `inconclusive`, with fixed evidence
and a manual-cleanup note. It is never registered, queried for adoption, written into or deleted;
cleanup is still attempted for the requested URL. This intentionally sacrifices compatibility
with servers that choose a new collection URL: a redirect or matching display name cannot
prove that such a URL belongs to the probe rather than the owner.

Removal is reported as verified only when the final listing shows none of this run's
`caldav-mcp-probe-…` calendars anywhere. Otherwise the report says **TEMPORARY CALENDAR NOT
REMOVED** at the top and bottom (and on stderr), names the calendar, and the command exits
with status 1. If the leftover is at an address the server chose (not
`…/caldav-mcp-probe-<hex>/`), the message says that `--cleanup` will not remove it and that it
must be deleted by hand in Calendar.

**After every `--write` run, open Calendar (or icloud.com/calendar) and check that no calendar
named `caldav-mcp-probe-…` is left.** Delete any you find.

Ctrl-C, `SIGTERM` or `SIGHUP` once stops the checks; cleanup is attempted, and calendar removal
verified where possible. A second signal exits at once (then run `--cleanup`, below, and check Calendar).

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
overlap any value seen from the account; otherwise it appears as `<other>`. Only lists explicitly
constructed as server-supplied names undergo that late name check, not arrays of fixed codes or
synthetic dates.

From your own events the report holds only counts and the fixed names of value forms (`utc`,
`tzid`, `date`, `floating`, `none`, used as evidence keys): never a title, UID, href,
time-zone name, date or time. Dates and times appear only for events the probe wrote itself in
`--write` mode, in its own temporary calendars, and only in a strict form (8 digits, or 8
digits, `T`, 6 digits and an optional `Z`; anything else is shown as `<other>`). Before describing
any synthetic event read-back, its final GET URL must be directly inside the probe's calendar,
and every VEVENT must have exactly the UID the probe authored. An expanded REPORT must finish
at that calendar URL, and each selected resource must pass the same UID check. A provenance
failure is `inconclusive` and emits only fixed status/count evidence, never returned values.
This also applies to attachment write read-backs, including the one after removal.

Attachments follow the same rule. From your own events the report holds only counts and members
of fixed enums (the form of an `ATTACH`, the *class* of its host and scheme, size buckets, the
top-level media type, which parameters are present): never a URL, host name, path, file name,
`MANAGED-ID`, media type, size or any other value. Values of an attachment are recorded only for
the attachment the probe itself uploads in `--write` mode, and even there never a URL, path or
file name. Besides host class and equality booleans, that verified upload may report an
N-masked hostname, path-segment classes, identifier-presence booleans and allowlisted query
parameter names, under the exact rules [below](#managed-upload-url-shape). UID/ATTACH provenance
mismatches publish no host or path evidence and send no download request.

It is designed to be safe to share. It never contains your Apple ID, password, DSID or other
account numbers, calendar names (except the probe's own `caldav-mcp-probe-…` names), event
titles, descriptions, locations, attendees or UIDs, time-zone names, the dates or times of
your events, ETag values, or sync tokens.

A second layer is a safety net in case a check ever puts a value seen from the server or typed
by you into the report. It looks only at the parts of the report that vary from run to run: the
numbers and names inserted into a summary, and evidence values that are not the probe's own
codes, standard protocol names, href shapes or its `caldav-mcp-probe-…` names. A part that
contains such a value is replaced as a whole by `<scrubbed>`. The probe's own text (ids, plan
items, claims, the fixed wording of summaries, evidence key names and its own codes) is never
changed, so the report reads the same whatever words your calendars hold. Synthetic date evidence
carries an explicit in-memory provenance marker until rendering, constructed only from values the
probe generated or a synthetic read-back whose URL and UIDs were verified. It is never rewritten
based on owner data. The conservative N-masked hostname of a provenance-verified managed upload
or its download redirect carries the same explicit marker. Arbitrary server strings have no such
exemption, even if date-shaped.
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
every mode's report to be byte-identical to a run with neutral words. Read-only and write runs
also compare accounts whose owner text contains synthetic-date/numeric collisions (including
`20280229` and `2028`) with same-length neutral text: the entire reports must be byte-identical,
with zero scrubbed occurrences, including the attachment checks. Read the JSON before sharing it
all the same.

## Evidence for the phase 2 read path

Probe version 0.5.0 includes checks whose main product is evidence for designing the phase
2 read path: what expansion does to the form of each value, whether a calendar-query can stand in
for a GET, how large the data is, how lax real data is, and how attachments are stored and served.
They run in the commands above, with
no new flag or prompt: the read-only ones in every mode, the `--write` ones in `--write` runs.
Write the JSON to new file names (for example `docs/probe-results/local-read-only-0.5.json` and
`docs/probe-results/local-write-0.5.json`) so that earlier results are kept. Each check still
reports `confirmed`, `refuted`, `inconclusive`, `skipped` or `error` against its claim, but for
these checks the evidence matters more than the outcome. A check that cannot answer (no
recurring event in the window, an HTTP error, throttling, a response over the body cap) reports
`inconclusive` with what it did gather, and the run goes on.

A *form* is one of: `utc` (DATE-TIME ending in `Z`), `tzid` (DATE-TIME with a `TZID`
parameter), `date` (a date-shaped value explicitly declared `VALUE=DATE`) or `floating`
(DATE-TIME with neither); `none` means the property is absent, and `invalid` means the value does
not have a valid lexical form for its declaration. A date-shaped value without `VALUE=DATE`,
including one explicitly declared `VALUE=DATE-TIME`, is invalid, not an all-day event. The census
counts invalid values and declaration/lexical mismatches separately, and treats RRULE keys and
values case-insensitively. In the cross-tabs below, a key such as `tzid>utc` is a count of expanded
instances whose original was a `tzid` value and whose expanded value is `utc`.

### Read-only checks (run in every mode)

Unless the table says otherwise they work on the ±60 day window the existing checks use (the
same days, fixed at the start of the run), over the same calendars (at most 10, owned first),
and record counts and form names only.

| Check id | What it does | What it records |
|---|---|---|
| `expand-forms` | Queries every calendar that has events in the window with `calendar-data/expand` (the `expand-read` query is reused, not repeated) and joins each expanded resource, by href, to the unexpanded original from the same window. | Cross-tabs of the original master's DTSTART form against the expanded DTSTART form, the same for RECURRENCE-ID (original master's DTSTART form against the expanded RECURRENCE-ID form) and for DTEND (original master's DTEND form against the expanded DTEND form), separately for recurring (`recurringDtstart`, `recurringRecurrenceId`, `recurringDtend`) and non-recurring resources (`nonrecurring…`), counted per expanded instance. VTIMEZONE components in the originals and in the expanded resources; expanded TZID values with no matching VTIMEZONE in the same expanded resource (`expandedTzidWithoutVtimezone`); expanded instances with DURATION, with DTEND, with both and with neither, and how many original masters have DURATION. Each instance is joined to a unique original master by UID within its resource; recurrence is classified per UID. Records `instancesCompared`, orphan (`instancesWithoutOriginalMaster`) and ambiguous-master counts, plus incomplete-resource counts. Refuted when a compared form changed, a non-recurring UID gained a RECURRENCE-ID, or a TZID has no VTIMEZONE; confirmed only with nonzero, complete comparison coverage, otherwise inconclusive. |
| `etag-expand-vs-multiget` | Takes up to 20 distinct hrefs from one cached expanded ±60-day calendar-query response (including getetag) and sends one calendar-multiget for the same hrefs. | Counts only: `compared`, `equal`, `different`, `missing` (including ambiguous or failed responses). Confirmed only with >0 compared, equal ETags and exactly one successful response per href, without unexpected responses; any observed difference refutes, otherwise inconclusive. No owner hrefs or ETags are reported. |
| `calendar-data-vs-get` | For up to 5 recurring resources (those with overrides first), compares the calendar-data of the calendar-query with a `GET` of the same href. | How many were byte-identical, identical once line endings are normalised, had equal ETags and equal override (RECURRENCE-ID) counts, and the override counts in each form. Booleans and counts only. |
| `limit-recurrence-set` | One `REPORT` with `<C:calendar-data><C:limit-recurrence-set …/></C:calendar-data>` on the calendar with most overrides, compared with the plain query of the same window. | HTTP status, resources and total override counts of both forms, how many resources still carry `RRULE`, and the response sizes. Joins canonical hrefs and verifies readable data, the same masters per UID, and retained/removed override multisets (`overridesVerifiedRetained`, `overridesVerifiedRemoved`). Confirmed only with complete coverage and fewer verified overrides; missing/duplicate/unexpected resources, unreadable data, lost/changed masters or unexpected/changed overrides are inconclusive, as are equal override counts or no overrides. |
| `payload-sizes` | Per calendar that has events: unexpanded and expanded queries for a 31-day window starting now (2 requests), next to the ±60 day queries that other checks already made. | One record per calendar by index (`calendar0`, `calendar1`, …, never a name): response body bytes of the four queries, the largest single calendar-data in bytes, the largest VEVENT count in one resource (unexpanded and expanded), and how many resources exceed 256 KiB; and the same totals for the run. |
| `strictness-census` | One unexpanded query per calendar over about 3 years either side of today (`wideWindowDays`, 1095). A response over the 8 MiB body cap is counted (`calendarsOverBodyCap`) and the next calendar is read. | Counts of: DATE events with DTEND at or before DTSTART; timed events with DTEND before DTSTART; DTSTART/DTEND of different forms; a TZID parameter on a DATE value; TZIDs that are neither a valid IANA zone (the runtime's built-in `Temporal`) nor defined by a VTIMEZONE in the same resource, by class only (`unresolvedTzidWindowsLike`, `unresolvedTzidMozillaPrefix`, `unresolvedTzidOther`); VTIMEZONE observances whose recurrence is not a yearly RRULE; `RANGE` parameters on RECURRENCE-ID; VEVENTs with neither DTEND nor DURATION; resources with duplicate UID, DTSTART, DTEND, DURATION or RECURRENCE-ID in one VEVENT; resources with more than one UID; resources with overrides and no master. Also records `invalidTimeValues` and `declaredTimeFormMismatch`; coverage counters distinguish `resourcesFetched`, successfully parsed `resources`, `resourcesMissingCalendarData`, `resourcesParseFailed`, calendar failures and malformed 207 bodies. Any observed anomaly refutes even with partial coverage; confirmation requires complete, successfully parsed coverage (`coverageComplete: true`) and nonempty data. A cap, failed/timed-out calendar, missing data or parse failure otherwise makes the result inconclusive. If the runtime has no `Temporal` (`temporalAvailable: false`), the TZID counts stay zero and a run with no other anomaly is inconclusive. |
| `multiget-bulk` | One `calendar-multiget` of up to 100 hrefs of the calendar with most events (all of them if fewer). The list is cut short only so the answer stays under half of the body cap. | Hrefs requested, whether the list was cut (`requestTrimmedBySize`), HTTP status, responses returned, responses with calendar-data, per-href statuses other than 200, and exact canonical-href coverage/readability booleans with duplicate/unexpected-href counts. Confirmation requires exactly one successful, readable calendar-data response per requested href and no other href. Missing, duplicate or unexpected hrefs and unreadable data are inconclusive; explicit per-href failures refute. |

Requests added to a read-only run: `expand-forms` one per calendar with events (minus the one
`expand-read` already sends), `calendar-data-vs-get` up to 5, `limit-recurrence-set` 1,
`payload-sizes` 2 per calendar with events, `strictness-census` 1 per calendar, `multiget-bulk`
1, and `etag-expand-vs-multiget` 1 (at most 2 if its expansion was not cached). For 10 calendars
that is conservatively at most 10 + 5 + 1 + 20 + 10 + 1 + 2 = 49. All are `REPORT` or `GET`.
Unreadable 207 bodies and failed per-resource/property statuses cannot establish an empty window:
they make the affected comparison inconclusive rather than silently skipping an empty calendar.

### `--write` checks

Each check writes one or two events into the first temporary calendar (the one with the
explicit calendar-timezone), reads back what it needs, and records values, because the events
are the probe's own. The events carry the usual probe UID and summary, have no attendees, and
are subject to the same cleanup as every other write check: cleanup is attempted, and calendar
removal verified where possible, including on failure paths. These checks
run after all the older write checks, so they do not change the older checks' counts.

| Check id | What it writes | What it records |
|---|---|---|
| `write-expand-date` | A weekly `VALUE=DATE` series, `COUNT=4`. | Expanded DTSTART, DTEND and RECURRENCE-ID forms and values; how many starts and ends fall on the expected days; `instanceTuplesMatch` compares the exact multiset of all three values (duplicates do not count as missing instances). Confirmation requires the expected tuples and declared forms. |
| `write-expand-floating` | A weekly floating series, `COUNT=4`. | The same tuple-multiset and form checks, including both endpoints and RECURRENCE-ID, and how many starts equal the wall-clock values sent. |
| `write-expand-tzid-dst` | A weekly `TZID=America/New_York` series with its VTIMEZONE, starting the week before the next March daylight-time change, `COUNT=4`. | Expanded forms and values; whether each expanded instant equals the expected instant (`instantMatches`: `instance0` to `instance3`). |
| `write-custom-tzid` | A weekly series in the custom `TZID=Probe/Custom` with an embedded VTIMEZONE using the pre-2007 US rules (daylight time from the first Sunday of April), on three Mondays in March, when those rules and tzdb's differ by an hour. | Whether the `PUT` was accepted (status, preconditions); whether the VTIMEZONE came back unchanged (`vtimezonePreserved`, `vtimezoneRulesPreserved`); the expanded forms and values; how many returned instants equal the embedded-rules answer, the tzdb answer, or neither. `instanceTuplesMatch` requires the full expected three-instance multiset (DTSTART, DTEND, RECURRENCE-ID); subsets and duplicates cannot confirm. If expansion keeps the TZID the rules cannot be seen and the check is `inconclusive`. |
| `write-moved-overrides` | Two daily UTC series (`COUNT=5`, 10:00Z on days D to D+4, D being 50 days after the base day), each with one override whose RECURRENCE-ID is a slot inside the series and whose DTSTART is moved past the series' last instance: `movedIn` moves day D+1 to D+20, `movedOut` moves day D+3 to D+10. Every query is sent twice: with `<C:expand>`, and as a plain time-range query that returns the stored data. | First a sanity step: the wide window D-1 to D+30 must return exactly the 5 expected instances when expanded and the 2 stored components (master and override) when plain, for each series (`sanityPassed`); otherwise `inconclusive` with the raw counts and the narrow windows are not evaluated (`narrowClaimsEvaluated: false`). Then, per series, the window around the moved slot (the override has RECURRENCE-ID outside it and DTSTART inside) must return exactly the override when expanded and select the resource when plain, and the window around the original slot must return no instance and select nothing. For every query: status, whether the resource was returned, the instance count, the forms, and the sorted `DTSTART/DTEND/RECURRENCE-ID` tuples (`-` for an absent property); the verdict compares the multisets of tuples. `confirmed` when all four claims hold for both series, `refuted` when the sanity step passed and one fails. |
| `write-moved-override-in-span` | Series C: weekly UTC, `COUNT=10`, Tuesday 2027-01-05 at 10:00Z–11:00Z; the third instance (Tuesday 2027-01-19) moves to Thursday 2027-01-21 at the same time. | Wide sanity `[2027-01-04, 2027-03-10)` must return exactly the ten expected expanded tuples and master plus override in plain mode. Otherwise inconclusive, with narrow queries skipped. Then queries Thursday only `[Jan 21, Jan 22)`, vacated Tuesday only `[Jan 19, Jan 20)`, and Monday–Friday `[Jan 18, Jan 23)`, each expanded and plain. All boundaries are 00:00Z. Counts, forms and provenance-checked tuples are published for all queries. Confirmed only when Thursday expansion returns exactly the moved instance; refuted when it returns none; inconclusive on unexpected tuples, failed sanity or unreadable responses. Tuesday, week and plain narrow answers are diagnostic, not extra verdict requirements. Series A/B are unchanged. |
| `write-dst-repeated-hour` | A non-recurring event at `DTSTART;TZID=America/New_York:20271107T013000` to `T023000` (01:30 occurs twice that day) with an embedded VTIMEZONE, and a weekly series (`COUNT=3`) from `20271031T013000` in the same zone, whose second instance falls in the repeated hour. | The stored forms on `GET` (`…StoredDtstart`, `…StoredDtend`, forms, whether the TZID is the one sent), the expanded forms and tuples of both (the series' RECURRENCE-ID is a UTC instant: 05:30Z is the first 01:30, EDT; 06:30Z the second, EST), and which of the windows 05:15Z to 05:45Z and 06:15Z to 06:45Z on that day select each (`…InWindow1`, `…InWindow2`). `confirmed` when every readable signal puts it at the first occurrence (RFC 5545 section 3.3.5) and coverage is complete, `refuted` when a signal puts it at the second and none at the first, `inconclusive` otherwise. The verdict rests on DTSTART and RECURRENCE-ID: a DTEND that falls in or after a clock change can be derived two ways (the wall-clock end, or the start plus the master's duration), so either is accepted for the verdict and `endsPlausibleWhereReadable` records whether the ends were one of them. Expansion that keeps the TZID cannot be read as an instant; the windows decide only after structure validation: exactly 1 non-recurring and 3 series instances, unique DTSTART/RECURRENCE-ID identities, valid declared forms and the expected series slots. Missing, duplicate or structurally invalid instances make coverage incomplete and the verdict inconclusive, with counts. |
| `write-dst-skipped-hour` | The same shape on the day the clocks go forward: an event at `20270314T023000` to `T033000` (02:30 does not exist) and a weekly series from `20270307T023000`. | Whether each `PUT` was accepted (`singlePutStatus`, `seriesPutStatus`, preconditions on a refusal), the stored forms, the expanded tuples, and which of the windows 07:15Z to 07:45Z and 06:15Z to 06:45Z select each. RFC 5545 reads it with the offset before the gap: 02:30 EST is 07:30Z (the 06:30Z to 07:30Z reading is selected by both windows). `confirmed` at 07:30Z with complete coverage, `refuted` at another instant, `inconclusive` if a `PUT` was refused or data is missing or unreadable (the status is still recorded). |
| `write-dst-utc-in-repeated-hour` | The control: two one-hour UTC events, 05:30Z and 06:30Z on 2027-11-07. | Stored and expanded forms and tuples (they must stay UTC and distinct) and the selections of the two windows above plus 06:45Z to 07:15Z, which overlaps only the second event; each event must be selected by exactly the windows that overlap it (the first by the first two, the second by the last two). `confirmed` when everything matches, `refuted` when a stored value, an expanded instance or a selection differs, `inconclusive` without complete coverage. |
| `write-feb29` | A yearly `VALUE=DATE` series from 2028-02-29, `COUNT=3`. | The instances and dates returned when expanded over 2028-01-01 to 2037-01-01, and whether they are exactly the three leap days. |
| `write-floating-time-range` | A floating event at 23:30 to 23:59 and a one-day `VALUE=DATE` event; 4 time-range queries with UTC boundaries chosen so that reading them in UTC or in America/Los_Angeles gives different answers. | Whether the calendar-timezone kept is the probe's own (`calendarTimezoneKept`); which events each window returned; whether each kind is read in UTC or in the calendar-timezone. Inconclusive if the server did not keep the probe's calendar-timezone. |
| `write-date-zero-length` | A `VALUE=DATE` event with DTEND equal to DTSTART. | Accepted or refused (status, preconditions); the values read back; `bothEndpointsPreserved` requires both DTSTART and DTEND equal the sent date and still explicitly VALUE=DATE; how it expands. |
| `write-range-thisandfuture` | A weekly series, `COUNT=4`, with an override `RECURRENCE-ID;RANGE=THISANDFUTURE` that moves one instance by 2 hours. | Accepted or refused; whether `RANGE` survived read-back with the value THISANDFUTURE (case-insensitive, `rangeValuePreserved`); the expanded instances, and whether later instances were moved too (`shiftedInstances`). |

`write-mkcalendar` also records whether the calendar-timezone was sent, whether the server then
returned some calendar-timezone (`calendarTimezonePresent`), whether the returned one is the probe's (`calendarTimezoneKept`: it holds the
America/Los_Angeles VTIMEZONE; only a boolean is recorded), and whether the server refused the
property (`calendarTimezoneRefused`), in which case the `MKCALENDAR` was repeated once without
it.

Requests added to a `--write` run, beyond the read-only ones: for the checks of version 0.2.0,
9 `PUT`s, 1 expanded `REPORT` for each of `write-expand-date`, `-floating`, `-tzid-dst`,
`-feb29`, `write-custom-tzid`, `write-date-zero-length` and `write-range-thisandfuture` (7), 1
`GET` each for the last three of those (3) and 4 for `write-floating-time-range` (the
`write-moved-overrides` events and queries are counted below): 23 in all, and 24 if the first
`MKCALENDAR` is repeated. The remaining expansion and daylight-time checks send:

| Check | Requests |
|---|---|
| `write-moved-overrides` | 12: 2 `PUT`s, 2 wide `REPORT`s (expanded, plain), and 4 narrow `REPORT`s for each series (moved slot and original slot, each expanded and plain). A refused `PUT` ends it with 2 or fewer; a failed sanity step skips the 8 narrow ones. |
| `write-moved-override-in-span` | 9: 1 `PUT`, 2 wide `REPORT`s and 6 narrow `REPORT`s (three windows, expanded and plain). Failed sanity skips the 6 narrow requests. |
| `write-dst-repeated-hour`, `write-dst-skipped-hour` | 7 each: 2 `PUT`s, 2 `GET`s, 1 expanded `REPORT` of both events, 2 window `REPORT`s. A refused `PUT` also skips its `GET`. |
| `write-dst-utc-in-repeated-hour` | 8: the same with 3 windows. |

### Attachment checks

The probe asks what iCloud does with attachments (iCalendar `ATTACH`): inline
(`ATTACH;ENCODING=BASE64;VALUE=BINARY:…`), a plain URI, or a CalDAV *managed attachment*
(RFC 8607: the file is stored on the server and the event carries
`ATTACH;MANAGED-ID=…;FMTTYPE=…;SIZE=…;FILENAME=…:https://…`; the DAV header advertises
`calendar-managed-attachments`). What it cannot know beforehand, and the checks find out: whether
iCloud accepts `POST <event>?action=attachment-add` with HTTP Basic and an app-specific password,
which host serves the attachment URL, and whether that host accepts the same Basic credentials.

Host classes: `caldav-root` (`caldav.icloud.com`),
`caldav-partition` (`pNN-caldav.icloud.com`; these two are the general sender's allowed hosts),
`icloud-other` (any other `*.icloud.com`), `icloud-content` (`*.icloud-content.com`),
`apple-other` (`*.apple.com`, `*.me.com`, `*.mac.com`), `other` and `unparseable`. Scheme classes:
`https`, `http`, `other`. An owner's attachment URL is requested only when it passes the general
guard (https, one of the two allowed hosts, default port, no encoded dots or slashes);
anything else is classified and left alone. Only a verified probe upload uses the broader,
challenge-gated experiment below.

**Read-only (every mode)**

| Check id | What it does | What it records |
|---|---|---|
| `attachment-census` | Counts `ATTACH` properties in the wide unexpanded responses the `strictness-census` already fetched; it sends no request. Confirmed when every `ATTACH` is a managed attachment on an allowed host; refuted when any other kind exists; inconclusive when there are none or not every calendar could be read. | VEVENTs with at least one `ATTACH`, total `ATTACH` properties, the most on one VEVENT; counts by form (`inline-binary`, `uri-managed`, `uri-unmanaged`); for URI forms, counts by scheme class and by host class, managed and unmanaged apart; how many have `FMTTYPE`, `SIZE`, `FILENAME`, `MANAGED-ID`, `X-APPLE-FILENAME`, or any other `X-` parameter (names not recorded); the declared `SIZE` of URI forms and the estimated decoded size of inline ones in the buckets `lt64KiB`, `lt1MiB`, `lt5MiB`, `lt20MiB`, `ge20MiB`, `missingOrInvalid`; `FMTTYPE` top-level types (`application`, `image`, `text`, `audio`, `video`, `other`, `missing`). |
| `attachment-fetch` | Sends one `GET` with `Range: bytes=0-0` and your credentials for one managed attachment whose URL is on an allowed host (one with a declared `SIZE` if there is one). A redirect is classified and followed once, only if its target is also an allowed host. At most 2 requests. The retained body is truncated to 64 KiB and discarded after classification; reading stops after the chunk that crosses the limit, so that final network chunk can be larger than the retained limit. Confirmed on HTTP 200 or 206; refuted on a 4xx; inconclusive otherwise. | Status, whether it redirected and the target's host class and scheme class, whether it was followed, the final status, whether `Content-Length`, `Content-Range` and `Accept-Ranges` were present, the top-level content-type class, and whether the total size (from `Content-Range`, else `Content-Length`) equals the declared `SIZE` (`null` when either is missing). With no managed attachment on an allowed host nothing is requested: `inconclusive`, reason `none-found` (no managed attachment at all) or `host-not-allowed` (they are all elsewhere). |

**`--write`** (after all the other write checks; the events are the probe's own and have the usual
probe UID and summary, so `--cleanup` recognises them if a deletion fails)

| Check id | What it writes | What it records |
|---|---|---|
| `write-attachment-managed` | Writes one event and adds a 32-byte text file with `POST ?action=attachment-add` (`Content-Type: text/plain`, `Content-Disposition: attachment; filename="probe-attachment.txt"`, `Prefer: return=representation`). Verifies the read-back's synthetic UID and exactly one URI-managed ATTACH with nonempty MANAGED-ID, SIZE=32, matching FILENAME, and matching Cal-Managed-ID if that header was present. Only then reports URL shape and runs the bounded download experiment below. Sends attachment-remove when possible, then reads the event immediately and at most twice more, 2 s apart, stopping when the ATTACH disappears. | Add status/preconditions and header/representation presence; `attachmentProvenanceVerified`; after verification, ATTACH parameters and host/scheme classes, URL shape, ETag change and download fields below. Removal evidence is independent of the download verdict: remove status, `afterRemoveReads` (at most 3), last event status, `attachGoneAfterRemove`, `etagChangedAfterRemove` (against the pre-remove ETag; null when unavailable). If the check ends early removal is still attempted when possible. Calendar cleanup always runs; disposal of stored attachment bytes is not verified. There is no post-removal attachment download. |
| `write-attachment-inline` | Two events: one with an inline base64 `ATTACH` (`FMTTYPE=text/plain`, 32 bytes), one with `ATTACH:https://example.invalid/probe.txt` (never fetched). | For each: the `PUT` status and preconditions, whether the `ATTACH` came back `preserved`, `converted-to-managed`, `dropped` or `modified`, how many came back, their parameter names, and whether the value is unchanged. Preserved requires exactly one ATTACH per event with the same value and parameters (ENCODING, VALUE and FMTTYPE are compared case-insensitively); duplicate properties or a dropped FMTTYPE are modifications. |

#### Managed-upload URL shape

Only after upload provenance passes:

- `urlHostMasked`: parsed lower-case hostname, at most 64 characters, ending `.icloud.com`;
  every label starts with a letter, contains only `[a-z0-9-]`, ends with a letter/digit, and no
  label starts `xn--`. Every digit run becomes **one `N`** (`p123-a45.icloud.com` →
  `pN-aN.icloud.com`). Other hosts get only their fixed class, never a masked name. The same rule
  applies to redirect Location hosts; `.icloud-content.com` redirects have class only.
- `pathSegmentCount` and `pathSegmentClasses`: split the encoded pathname on `/`, excluding
  the leading and one trailing empty segment (interior empty segments remain `other`). Classes,
  in order: `literal:attachment`, `literal:attachments`, `literal:calendars` for those exact
  allowlisted strings; `digits` for all digits; `uuid` for case-insensitive 8-4-4-4-12 hex;
  `hex` for nonempty all-hex; `filename` for `[a-z0-9_-]+\.[a-z0-9]{1,8}` case-insensitively;
  otherwise `other`. Neither filenames nor arbitrary path literals are emitted.
- `managedIdInPath`, `managedIdInQuery`: substring presence in the percent-decoded path/query
  (raw text if decoding fails). `principalIdPresent`: whether the numeric id from the discovered
  `/digits/calendars/` home appears in either. These are booleans, never the identifier.
- `queryPresent` and sorted, deduplicated `queryParameterNames`: exact names `action`,
  `managed-id`, `token`, `download`; every other name maps to `other`. No query values.

#### Managed-upload download steps

Each step is one GET, `redirect: manual`, `Range: bytes=0-63`, no cookies, timeout at most 10 s,
retained body capped at **65,536 bytes**, sharing the ordinary request count, pacing, cooldown,
deadline and credential latch. A stream chunk can be larger than the retained cap; reading is
cancelled as soon as that cap is exceeded. Bodies are used only for exact equality and discarded.

1. `anonymous`: the exact ATTACH value just read, only HTTPS/default port on a host ending
   `.icloud.com`, without userinfo or fragment, and **no Authorization**.
2. `authenticated`: only after step 1 returned 401 or 403, the same exact URL with the account's
   Basic authorization. No second attempt. A 401 sets the credential latch before body reading.
3. `redirect`: if step 1 or 2 returned a 3xx with a Location, one HTTPS/default-port GET to that
   resolved Location on a host ending `.icloud.com` or `.icloud-content.com`, without userinfo or
   fragment, **no Authorization**, even on the same host. No more hops and no sign-in retry there.

For each attempted step the report includes status, Content-Length/Content-Range presence,
whether Content-Length equals 32 (null when absent/invalid), content-type top-level class,
body equality and truncation, and WWW-Authenticate scheme names. Scheme names are lower-cased,
sorted and deduplicated: `basic`, `bearer`, `digest`, `x-mobileme-authtoken`, else `other`;
realms, parameters and tokens are never reported. Each 3xx records the Location host class,
conservative masked host when allowed, and same-host boolean (null for missing/invalid Location).

The check verdict is **confirmed** when any step returned exactly the 32 uploaded bytes;
`matchedAnonymous`, `matchedAuthenticated`, `matchedRedirect` say which. It is **refuted** when
all permitted steps completed without those bytes, including an HTTP refusal or error status;
**inconclusive** on skipped/blocked steps or transport errors unless bytes were already confirmed.
A refused add remains refuted; unverified event/ATTACH provenance is inconclusive, with no URL
shape or download. Removal results do not change a completed download verdict.

Attachment request budget in version 0.5.0:

| Mode | Added at most | Of which |
|---|---|---|
| default (read-only) | 2 | `attachment-fetch`: 1 `GET`, plus 1 more if it redirects to an allowed host. `attachment-census`: 0. |
| `--write` | 2 + 14 = 16 | The 2 above; `write-attachment-managed`: 1 `PUT`, 1 `POST` add, 1 event `GET`, at most 3 download GETs, 1 `POST` remove, at most 3 event GETs = at most 10. Normally 6 with anonymous delivery, 7 with a challenge, 8 with challenge plus redirect, before delayed-removal retries. `write-attachment-inline`: 2 `PUT`s + 2 `GET`s = 4. Refused add costs 2. |

**A 401 or 403 on these requests.** A 403/405 on attachment-add is recorded as refuted without
retry. A 401 on any authenticated attachment request (`POST`, owner-data GET, or the managed
experiment's `authenticated` step) latches the run immediately. Only one DELETE per registered
temporary calendar remains permitted, and if that DELETE returns 401 even cleanup stops.
Anonymous download responses never reject credentials: an initial 401/403 permits the one Basic
attempt above, and a redirect-hop 401 permits nothing further. After the latch, cleanup verification
requests are blocked. Check Calendar and use the manual-recovery steps if removal is unverified.

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
| `expand-forms`, `write-expand-date`, `write-expand-floating`, `write-expand-tzid-dst`, `write-feb29` | Phase 2: what expansion does to UTC, TZID, DATE and floating values, VTIMEZONE and DURATION |
| `write-custom-tzid`, `write-moved-overrides`, `write-moved-override-in-span`, `write-range-thisandfuture` | Phase 2: custom TZIDs and their rules, overrides moved across the window, `RANGE=THISANDFUTURE` |
| `write-dst-repeated-hour`, `write-dst-skipped-hour`, `write-dst-utc-in-repeated-hour` | Phase 2: which instant iCloud assigns to a TZID time that occurs twice or not at all on a clock-change day, with a UTC control |
| `write-floating-time-range`, `write-date-zero-length` | Phase 2: floating and DATE values against UTC boundaries; a zero-length all-day event |
| `calendar-data-vs-get`, `limit-recurrence-set`, `multiget-bulk` | Phase 2: calendar-query against GET, `limit-recurrence-set`, a 100-href multiget |
| `payload-sizes`, `strictness-census` | Phase 2: response sizes; how lax the real data is |
| `attachment-census`, `attachment-fetch`, `write-attachment-managed`, `write-attachment-inline` | Phase 2: how attachments are stored (inline, managed, URI), where managed ones are hosted, whether they can be fetched and added with Basic credentials, what a `PUT` does to inline and external ones |
| `text-match-read`, `write-text-match` | Server-side text search |
| `uid-filter`, `multiget` | "UID filter returns 412"; calendar-multiget by href |
| `sync-collection`, `sync-limit`, `write-sync-changes`, `write-sync-limit` | sync-collection, and "limit is ignored" |
| `etag-shape` | ETags usable as exact `If-Match` |
| `etag-expand-vs-multiget` | Phase 2: ETag equality between expanded calendar-query and multiget, with complete per-href coverage |
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
