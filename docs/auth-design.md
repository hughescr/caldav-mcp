# Authentication and account connection

This service is an OAuth 2.1 authorization server and an MCP resource server in one Lambda. Clients get only this service's short-lived access tokens and rotating refresh tokens. The service holds the iCloud credential and uses it for CalDAV requests on the client's behalf.

The issuer is one configured HTTPS origin (`PUBLIC_BASE_URL`). It is never derived from `Host` or forwarded headers. The protected resource is exactly `${issuer}/mcp`.

## What is stored

DynamoDB holds five record kinds under the `caldav-mcp#` key namespace (`pk = caldav-mcp#<kind>#<id>`, `sk = STATE`). Every record has a `revision` for compare-and-swap writes and an `expiresAt` for TTL cleanup. Every use checks expiry itself; TTL never grants validity.

| Kind | Id | Contents |
|---|---|---|
| `connection` | account id | Status (`active`, `reconnect_required`, `revoked`), credential generation, sealed `UpstreamCredentials`. One record per Apple ID. |
| `grant` | random | Client, scopes, resource, credential generation, token version, refresh generation, hashes of the current and previous refresh secret, optional sealed 10-second refresh receipt. |
| `code` | hash of the code | Client, redirect URI, resource, scopes, PKCE challenge, credential generation, the authorization epoch that issued it, consumed marker. Lasts two minutes. |
| `consent` | `sha256(["caldav-mcp", 1, "consent", accountId, clientId])` | The client's current consent for the account: the random authorization epoch of its latest accepted consent submission, and the id of the grant created by exchanging that epoch's one code. Lasts at least as long as the connection generation it was written under (see "One consent per client"). |
| `throttle` | account id | Start of the current 15-minute window and the number of sign-in attempts counted in it (failed, plus reserved and still in flight). |

The account id is `base64url(sha256('caldav-mcp/account/v1:' + normalizedAppleId))` (`src/account.ts`). It is a pseudonym, not a secret. The plaintext Apple ID appears in DynamoDB only inside the sealed credential.

`UpstreamCredentials` is the sealed value:

```ts
{ accountId, appleId, appPassword, principalUrl, calendarHomeUrl, issuedAt }
```

The engine seals an explicit projection of exactly these fields. Lengths are bounded (Apple ID 255, password 256, each URL 2048), so a worst-case sealed credential is about 8 KiB of base64url, inside the adapter's 32 KiB ciphertext and 64 KiB record bounds.

## Why a password is stored, and how it is protected

CalDAV on iCloud authenticates every request with HTTP Basic: Apple ID and an app-specific password. There is no session token or documented OAuth, so the server cannot work without keeping the password. This is the main difference from wildduck-mcp, which never persists a password.

An app-specific password is not limited to calendars; it also opens iCloud Mail and Contacts. The login page therefore tells the user to create one only for this connector, never to use the main Apple Account password. Revoking it at Apple disconnects this service and nothing else. Reconnecting afterwards with a new password ends every existing grant for the account: every client, including any the user does not recognise, must authorize again (see "Credential generations and grants").

Protections:

- **Encryption.** AES-256-GCM with a fresh 12-byte nonce, a 16-byte tag, a versioned key id and AAD `["caldav-mcp", 1, "upstream-credentials", accountId, connectionId, credentialGeneration]`. Each purpose has its own key: HKDF-SHA256 over the root key with salt `caldav-mcp/auth/v1` and info set to the purpose name (here `upstream-credentials`; the other sealed purposes are `browser-flow` and `refresh-receipt`, and the HMAC purposes are `token-envelope`, `authorization-code`, `client-registration` and `client-secret`). Nonce and tag lengths are pinned: a sealed value with any other length is refused before decryption. A ciphertext cannot be moved to another account, connection or generation.
- **Key outside the database.** The keyring is an SSM SecureString, `/caldav-mcp/prod/auth-keyring`, provisioned once by `scripts/provision-auth-keyring.ts` and never shared with wildduck-mcp. The runtime can only read that one parameter.
- **Where the password exists.** In the single login POST, in the sealed record, and in request-local closures while a request runs. It is never in the flow cookie, a hidden form field, a redirect, a page, a log line, an error object returned to a client, MCP tool arguments or results, or `authInfo.extra`. Tests submit a canary password and check every response header and body on the success, wrong-password, throttled, temporary-failure and cancel paths, the console, and the raw JSON of everything written to the store.
- **Decryption re-checks.** `readCredentials` (`src/auth/caldav-session.ts`) requires the exact field set, `accountId` equal to the connection's, an Apple ID that is normalized and hashes to that account id, a bounded password, and both URLs passing the fixed-host rule. Any failure, including authenticated-decryption failure (tag or AAD mismatch, a key id no longer in the keyring), throws `UnreadableCredentials`. That is definitive for the record: the connection needs a new login (see "MCP requests and `reconnect_required`").
- **Lazy decryption.** The credential is decrypted only when a tool call on an active connection needs iCloud, inside the bound calendar service, and during the session checks of the token endpoints. `initialize`, `tools/list` and inactive connections never decrypt.
- **Fixed upstream host.** The login page accepts no server URL. Discovery starts at `https://caldav.icloud.com/`. Stored URLs must be `https:` on `caldav.icloud.com` or `pNN-caldav.icloud.com` with no user info or port (`isAllowedCalDavUrl` in `src/caldav/hosts.ts`). The login flow checks discovered URLs before storing them, and every decryption checks them again before use. The rule depends on TLS server authentication, so configuration load refuses to start when `NODE_TLS_REJECT_UNAUTHORIZED` is `0`.

What it does not protect against: anyone who can read the SSM parameter and the table together can decrypt every stored password. Plaintext strings in Lambda memory cannot be zeroed. There is no self-service "forget me": a `reconnect_required` record keeps its sealed (now useless) password until it is replaced or expires. Revoking the password at Apple is the user's control; the next login then ends every existing grant for the account.

## Allowlist

`ALLOWED_APPLE_ID_HASHES` is a comma-separated list of account ids, produced by `bun run apple-id-hash`. A malformed entry stops the service at configuration load. An empty or absent list lets nobody connect.

The allowlist is enforced in three places:

1. **Login**, after Apple ID normalization and before any upstream request or store write. A non-allowlisted Apple ID makes no iCloud request and creates no throttle record.
2. **Session validator**, used at connect, code issue, code exchange and refresh, and its local allowlist check in refresh-receipt recovery. A removed account is `expired`, which marks the connection `reconnect_required` and fails the token request with `invalid_grant`; a refresh retry inside the 10-second receipt window is refused with `invalid_grant` too.
3. **Every MCP request**, right after access-token verification. A removed account gets the 401 bearer challenge on its next request, with no upstream call.

Re-adding an account does not revive anything: its connection is `reconnect_required`, and the login that restores it replaces the credential, which ends every earlier grant.

Allowlist membership is observable to anyone probing the login endpoint, and this is an accepted limitation. A single attempt with a non-allowlisted Apple ID and a single wrong-password attempt with an allowlisted one return the same body and status. But the non-allowlisted request returns at once without an iCloud request, while the allowlisted one waits for iCloud, and after five wrong attempts an allowlisted Apple ID gets the 429 page while a non-allowlisted one never does.

## Login flow

One page, `GET /authorize`, shows the client name and identity host (the CIMD hostname, or "Registered OAuth client"), the redirect hostname, an Apple ID field (`autocomplete="username"`), an app-specific password field (`type="password"`, `autocomplete="off"`, at most 256 characters) with a "How do I generate an app-specific password?" link to Apple's instructions, the permission rows (see "Scopes and consent") with the muted line "Your choice replaces what this client was allowed before." under them, and "Connect and allow" / "Cancel" buttons. It posts to `/auth/connect`. There is no TOTP step and no separate consent step: the user's own app-specific password is the consent credential for this connector.

The flow cookie `__Host-caldav-flow` is sealed (`browser-flow` purpose), `Secure; HttpOnly; SameSite=Lax`, ten minutes, and holds only `{deadline, csrf, flowId, binding}`. `binding` is a digest of the public OAuth request fields.

`POST /auth/connect` runs in this order:

1. `Origin` must equal the issuer; the body is a bounded form in which only `grant` may repeat; the CSRF token and request binding must match the cookie.
2. `decision=cancel` redirects with `error=access_denied` (no credential is read or sent anywhere, and `grant` is ignored). Any decision other than `allow` is rejected.
3. The `grant` values are checked and the granted set computed; an empty grant gets the "Choose at least one permission" page (see "Scopes and consent").
4. The Apple ID is normalized (trim, lowercase, plain ASCII address). The password is trimmed of surrounding whitespace only; hyphens are kept.
5. Allowlist check.
6. Throttle reservation: one sign-in attempt is counted before iCloud sees it (see "Login throttle").
7. `caldav.discover` proves the credentials with iCloud. Discovered URLs must pass the fixed-host rule. A rejected sign-in keeps its reservation; any other outcome releases it.
8. Duplicate check, then `connectOrReconnect`, then `issueCode` with the granted scopes, then the redirect with `code`, `iss` and `state`. `issueCode` starts a new authorization epoch that replaces the client's earlier consent for the account (see "One consent per client").

Invalid Apple ID syntax, an empty or oversized password, a non-allowlisted Apple ID and a wrong password all return the same static page with HTTP 400: "Sign-in failed. Check the Apple ID and app-specific password, then start the connection again." A throttled account gets 429. An upstream temporary or protocol failure, a discovery URL outside the fixed hosts, or a store failure gets 503. Failures after discovery also render these static pages: a concurrent reconnect that wins the generation change, or a session check that now fails, gets the 400 page; a temporary store or upstream error while storing the credential or issuing the code gets the 503 page. Failure pages never echo submitted fields, and every one clears the flow cookie.

Form pages use `Referrer-Policy: same-origin` (so Chromium sends a trustworthy `Origin` on the POST) and a CSP of `default-src 'none'; style-src 'sha256-<hash of the page style>'; form-action 'self' <callback origin>; frame-ancestors 'none'; base-uri 'none'`. Redirects use `Referrer-Policy: no-referrer`. Every page the browser flow serves (the form, the empty-grant page and the 400, 429 and 503 failure pages) embeds the same single `<style>` block from `src/auth/page-style.ts`, and the CSP allows exactly that text by its SHA-256 hash, computed at module load. The pages have no `style=` attributes, no scripts and no third-party assets, so the policy needs neither `'unsafe-inline'` nor a nonce. The form's single `<a>` to Apple's app-specific password article (`https://support.apple.com/102654`, a fixed constant, `target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"`) is a navigation, which `default-src` does not govern, so the policy and `form-action` are unchanged; the page-level `same-origin` referrer policy stays because `no-referrer` would make Chromium send `Origin: null` on the POST. The link sits after the password input in the DOM (CSS `order` places it in the label row) and outside the `<label>`, so tabbing from the field is not detoured and clicking the link does not focus the field. Editing the style block changes the hash with it.

**Duplicate delivery.** If the active, unexpired connection already holds identical credentials (same Apple ID, same password compared in constant time, same URLs), it is reused without bumping the credential generation and without re-encrypting it, so the grants of other clients already using that credential keep working. For the submitting client, though, each accepted delivery is a new consent: the later delivery's code is the valid one, and the first delivery's code and any grant already made from it stop working (see "One consent per client"). Each delivery still runs discovery, so it is re-proven with iCloud. Anything else, including the same password for a connection that is `reconnect_required`, expired or `revoked`, is a fresh, iCloud-proven replacement under the next credential generation. An unreadable old ciphertext (retired key, damage) never blocks a replacement.

**Reconnect.** A login for an Apple ID that already has a connection replaces its credential with a conditional generation change. That ends every existing grant for the account, for every client; each client must authorize again.

## Scopes and consent

The owner's decision: "We want the user to be in full control of what they are allowing their agent to do." So the user picks the permissions on the login page.

Scopes are defined once in `src/auth/scopes.ts` (`SCOPES`, in page order, with their labels), re-exported by `src/auth/http.ts`, and advertised as `scopes_supported` in both metadata documents:

| Scope | Page row | `name="grant"` checkbox | Default |
|---|---|---|---|
| `calendar:read` | "Read your calendars and events (always included)", a fixed list row with the check marker, not an input | none | always granted when requested; the default when a client requests no scope |
| `calendar:write` | "Create and change events" | `value="calendar:write"` | ticked |
| `calendar:delete` | "Delete events (whole events, single occurrences, or all following occurrences)" | `value="calendar:delete"` | ticked |
| `calendar:invite` | SENSITIVE marker, "Change events that involve other people. iCloud emails them at once: invitations, updates and cancellations from your Apple Account. Has effect only together with create/change or delete." | `value="calendar:invite"` | not ticked |

Only requested scopes get a row, in the order above. With at least one checkbox the rows sit in a `<fieldset>` with the legend "Choose permissions"; each checkbox is a whole-row `<label>` at least 48 px high. A read-only request has nothing to choose and keeps the plain "Requested permissions" list.

The default tick state (write and delete ticked, invite not) is this implementation's choice, not the owner's: the user came to connect an agent to their calendar and can untick write or delete, while anything that makes iCloud send mail needs a deliberate tick.

The POST carries one `grant` field per ticked box. `grant` is the only field that may repeat. The granted set is computed after the CSRF and request-binding check, so it can only draw on the `scope` value bound into the flow:

- Every `grant` value must be a scope the page offered for this request (requested, and not `calendar:read`), and no value may appear twice. An unknown, empty, unrequested, duplicated or `calendar:read` value is `invalid_request` (a JSON 400), before any store write or iCloud request.
- Grant = requested ∩ {`calendar:read`} ∪ ticked.
- An empty grant (possible only when read was not requested) renders a fixed 400 page, "Choose at least one permission", and clears the flow cookie. This is decided before the allowlist, the throttle and iCloud: nothing is stored and no request is made.
- `issueCode` receives the granted set. The code record, the token response's `scope` (RFC 6749 §5.1: it states the granted set when it differs from the request) and the grant record all hold exactly that set.
- Refresh can keep or narrow the grant's scopes, never widen them (`invalid_scope`). A narrowing rewrites the grant record, and every access-token verification reads the grant's scopes, so it also applies to access tokens issued before it, from their next verification on. A request that was already verified and is still running is not stopped. A user who wants more must reconnect and tick the box.
- A completed consent replaces what the same client was allowed before, narrower or wider (see "One consent per client").

Each tool lists its required scopes, and all of them must be granted (`requiredScope` in `src/mcp.ts`, a non-empty list per tool). `insufficient_scope` names the missing scopes and tells the agent that the user must reconnect and tick the named checkbox, quoting its label; for `calendar:read` it says the page includes it whenever the client requests it.

`calendar:write` covers creating and changing events; deleting needs `calendar:delete`. Existing connections and grants are left as they are: nothing migrates, widens or narrows them, and a grant that holds `calendar:write` does not gain `calendar:delete`. A connection that wants the write tools or delete must reconnect and tick the boxes.

### One consent per client

The owner's requirement above means a reconnect must really narrow what a client can do. Each code exchange creates a separate grant, and a reconnect with the identical credential keeps the credential generation, so without a further rule a client's earlier, wider grant would stay valid next to the new one. The rule: when the user completes a consent for a client, that client's earlier grants and outstanding codes for the account stop working. Other clients' grants for the account are not affected. "The same client" means the same `client_id`.

Mechanism: one `consent` record per (account, `client_id`). Every accepted consent submission is its own authorization epoch: a fresh random 256-bit id, never reused. The record holds the current epoch and the id of the grant created from it, if any. "Accepted" means the POST passed the flow cookie, CSRF and binding checks, the empty-grant check, the allowlist and the throttle, and iCloud accepted the password. A resubmission of the same browser flow (a double click, a duplicate delivery, a delayed replay) is a new epoch like any other submission: the server does not consume the flow cookie, so the same flow can be posted again, even with different ticks. This rule is this implementation's, not the owner's.

- `issueCode` generates the new epoch and writes it to the record, replacing whatever epoch was there and dropping the grant id, in the same transaction that stores the epoch's one code. The transaction is conditioned on the record revision it read (or on the record's absence). From that commit on, every earlier grant of the client for the account is refused, and every earlier code fails at exchange because its epoch is no longer the current one. So the later accepted submission always wins, whatever each allows.
- Of two submissions racing at code issue, exactly one commits. The other's transaction fails its condition, its code is never stored, and the browser gets the 503 "temporarily unavailable" page; trying again starts a new epoch. Two valid codes never exist at once.
- `exchange` accepts a code only if its epoch is the record's current epoch and the record names no grant yet (one code per epoch, so the "code already used" rule is unchanged). It names the new grant in the record, in the same transaction that consumes the code and creates the grant, conditioned on the record revision it read: an epoch that starts in between makes the exchange fail with `invalid_grant`.
- An older epoch never comes back. If flow F issues code W, a later flow G replaces it, and a delayed copy of F's POST then arrives, that copy is accepted only because it carries F's cookie, CSRF token and binding and the password again, and it starts a third epoch. It replaces G's epoch, but W stays bound to F's first epoch and is still refused.
- `verifyAccess` refuses a grant the record does not name (`invalid_token`, the 401 bearer challenge on `/mcp`). Refresh and refresh-receipt recovery refuse it with `invalid_grant` and leave the grant record untouched. A refresh rotation and a receipt disclosure are each conditioned on the consent revision they read, so a replacement that commits while a refresh is in flight makes that refresh fail. A refresh that commits first returns tokens that are refused once the replacement commits. A stale refresh therefore never revives a replaced grant: validity is decided by the consent record, which a refresh never writes.
- A consent record that names another account or client under its key is a store fault (`temporarily_unavailable`), never a pass.
- The record's expiry is never earlier than the expiry of the connection generation it was written under, and every grant expires no later than its connection generation, so the record outlives every grant it can refuse. TTL deletion therefore cannot bring a replaced grant back.

When the replacement takes effect: at code issue, after the user pressed "Connect and allow" and iCloud accepted the password, not at the exchange. This timing is this implementation's choice, not the owner's. The reason: if the replacement waited for the exchange, the client being narrowed could keep its wider grant simply by never exchanging the new code. Issuing a code needs the Apple ID and the app-specific password, a matching CSRF token and flow binding, and an `Origin` equal to the issuer, so someone without the password cannot use this to cut off a working client. The cost: a consent whose code is never exchanged (the browser closed after "Connect and allow", or the redirect never reached the client) leaves the client with no working grant until it authorizes again. Cancel, a wrong password, an empty grant and a refused form change nothing, and the earlier grant keeps working.

Limits:

- A client that registers again through dynamic client registration gets a new `client_id`. Its old grants are then another client's: they keep working until they expire, until the user reconnects with a new app-specific password (which ends every grant of the account), or until the client revokes them. The data model has no more stable identity of a registered client to bind by.
- Two installations that share one `client_id` (for example a client ID metadata document URL used by every copy of an app) count as one client: connecting the second ends the first installation's grant.
- A request that was already verified and is still running is not stopped; the replacement applies from the next access-token verification.
- Grants and codes from before consent records existed: such a grant stays valid while its client has no consent record, so deploying this change signs nobody out; the client's first new consent ends it. A refresh of such a grant is conditioned on the record still being absent, so a refresh racing the first consent fails. Such a code (it has no epoch, and is at most two minutes old at deploy time) is refused at exchange.
- Rollback: an older build does not read consent records. After a rollback, every superseded grant that has not expired works again until it expires, its password is replaced or it is revoked. During the rollback window, codes issued by this build (they carry an `epoch` field) are refused by the older build's strict record validator, so their exchange fails with 503 until they expire and the user must connect again. After rolling forward again, codes the older build issued have no epoch and are refused, and grants it created for a client that already has a consent record are not named by that record and are refused too, so that client must connect again.
- An operator must not delete a consent record while any grant it refuses is still alive. A grant counts as current while its client has no consent record (the rule that keeps grants from before consent records working), so deleting the record makes every unexpired, unrevoked grant of that client for the account valid again, the superseded ones included. The record's expiry is set so that TTL deletion never does this.
- Each `/mcp` request and each refresh reads the consent record with a strongly consistent read, never cached. On the 1-read-unit table, a throttled read fails closed: the request gets HTTP 503 `temporarily_unavailable`, never a pass. An `/mcp` request reads three records (grant, connection, consent), each once: `verifyAccess` returns the connection record it checked, and `/mcp` uses it instead of reading the grant and connection again.

## Login throttle

At most five sign-in attempts per account in flight or failed at any moment of a fixed 15-minute window. Before the iCloud request, the login reserves an attempt with a conditional write that succeeds only while the window's count is below five. A revision conflict re-reads and retries, at most eight times; after that, or on any store error, the login fails closed with 503 and iCloud is not contacted. A full window gets the 429 page without an iCloud request, even with the right password.

The outcome decides what happens to the reservation:

- iCloud rejects the sign-in (`unauthorized`): the reservation stays and counts as a failure until the window ends.
- The sign-in succeeds, or iCloud has a temporary or protocol failure: the reservation is released. Release is best effort; if it fails, the login still completes and the attempt stays counted until the window ends.

So successful logins and temporary failures do not consume the budget, and concurrent requests can never put more than five attempts at Apple at once. When the window ends, the next reservation starts a new window on the same record.

Known limits: anyone who knows an allowlisted Apple ID can make five wrong attempts and block new connections for that account until the window ends (at most 15 minutes), and can repeat this every window; existing grants are unaffected. Each such attempt is a real failed sign-in at Apple, at most five per account per window. A request that dies between reservation and release (for example a Lambda timeout) holds its slot until the window ends.

## Tokens and grants

Unchanged from wildduck-mcp:

- Codes last two minutes and need S256 PKCE and exact client, redirect, resource and scope bindings. A native client's loopback redirect may vary its port only. Exchange consumes the code, creates the grant and names it in the client's consent record in one transaction conditioned on the connection's credential generation and the consent revision. A reused code is denied without revoking the grant, so a code thief cannot turn it into a revocation attack.
- Access tokens last five minutes. Grants and connections last at most 180 days, and a grant never outlives the connection generation it was issued for. Tokens are authenticated routing envelopes, so a random token fails before any read. Only hashes of refresh secrets persist.
- Refresh rotates in one conditional transition. An identical retry within ten seconds returns the same sealed response (the receipt), bound to the previous secret, client, resource and effective scopes. The receipt is disclosed only while the account is allowlisted, the connection is active with the grant's credential generation, the client's consent record still names the grant, and a check-only transaction on the grant, connection and consent revisions succeeds. A replay outside the window revokes that client's grant. Wrong-client and random-token attempts never change anything.
- Dynamic client registration is stateless (signed client ids and secrets). Client ID metadata documents are fetched through `@better-auth/cimd` with public-IP DNS pinning, TLS identity checks, no redirects and a 5 KiB cap.
- Store reads are strongly consistent; unknown transaction outcomes are temporary errors, never conflicts. Operation ids bind exact payloads for bounded retries.
- The keyring is cached for at most five minutes, loads coalesce, and an expired cache fails closed if SSM is unavailable.

The engine validates the backend session at connect, code issue, code exchange and refresh. Here that is one CalDAV PROPFIND with the stored credentials; only a 207 multistatus counts as valid, a 401 is `expired`, and anything else (a plain 200 included) is temporary. A temporary failure keeps the code or refresh token usable and returns `503 temporarily_unavailable`. `expired` (a definitive 401, removal from the allowlist, or a stored credential that cannot be opened or re-validated) conditionally marks the observed connection `reconnect_required` and returns `invalid_grant` with "Reconnect your iCloud account and authorize this client again." `temporarily_unavailable` is reserved for keyring, store and upstream unavailability.

### Credential generations and grants

Every replacement of the stored credential increments the connection's credential generation. Codes and grants record the generation they were issued for, and a grant is valid only while it equals the connection's: access-token verification, refresh and refresh-receipt recovery all compare them, and refresh never moves a grant to a newer generation. So any replacement ends every earlier grant for the account. After the owner revokes the app-specific password at Apple and reconnects with a new one, every old refresh token fails with `invalid_grant` and every old access token gets the 401 bearer challenge on `/mcp`, so each client, and any client the owner did not authorize, must go through the login page again. The duplicate-delivery path is the only login that keeps the generation, so a second client connecting with the identical, still-active credential does not end the first client's grant. The same client connecting again does end its own earlier grant, through its consent record (see "One consent per client").

## MCP requests and `reconnect_required`

`/mcp` verifies the access token (reading the grant, the connection and the client's consent record, and checking the credential generation and the consent), checks the allowlist, and builds a request-local calendar service from the connection record that verification returned. It makes no separate validation request: the tool call itself reaches iCloud. The credential is decrypted lazily, inside the bound service, only when a tool on an active connection needs iCloud; `initialize` and `tools/list` never decrypt, and an inactive or expired connection is never decrypted. A credential that cannot be opened or re-validated (`UnreadableCredentials`) is handled like a definitive 401: the tool returns `reconnect_required`, the connection is conditionally marked `reconnect_required`, and a new login replaces it.

The read tools (`list_calendars`, `list_events`, `search_events`, `get_event`, `get_event_attachment_download`) require `calendar:read`. The write tools require `calendar:read` plus `calendar:write` (`create_event`, `update_event`) or `calendar:delete` (`delete_event`); changing or deleting an event with attendees or an organizer also requires `calendar:invite`, checked after the event is read (`attendees_present`). Errors are structured `{ error: { code, message, request_id } }` with codes `reconnect_required`, `temporarily_unavailable`, `insufficient_scope`, `upstream_error`, `invalid_input`, `not_found`, `result_too_large`, `calendar_changed`, `unsupported_calendar_data`, `unsupported_attachment` and `verification_failed`, and a server-generated request id; the write tools add `create_conflict`, `read_only_calendar`, `forbidden`, `attendees_present`, `edit_not_supported`, `write_refused`, `outcome_unknown`, `occurrence_identity_unprovable` and `split_incomplete`, a fixed `reason` and `field`, for an iCloud refusal a bounded, sanitised `upstream` summary whose `detail` is untrusted, for a split whose second write did not apply the new series' `created_series` (href, ETag, outcome), and for `exceptions_choice_required` the counts of changed and deleted occurrences. The read tools forward no upstream text. Only the tool name, request id and code are logged.

If iCloud answers a tool call with a definitive 401, the service marks the connection `reconnect_required` with a CAS on the revision it read, and returns `reconnect_required`. A connection reconnected concurrently is not overwritten. While a connection is `reconnect_required`, tool calls return that code without contacting iCloud; access tokens of the same generation stay valid until they expire, and refresh fails with `invalid_grant`. A fresh login restores service under the next credential generation, for newly authorized grants only: every earlier grant has ended. A 403 from iCloud is treated as temporary, not as invalid credentials.

## Differences from wildduck-mcp

Copied from wildduck-mcp and adapted, not shared. A security fix must be applied in both repositories.

- Names and domain separation: HKDF info, AAD prefix, cookie name, key namespace and keyring parameter all use `caldav-mcp`.
- Scopes are `calendar:read`, `calendar:write`, `calendar:delete`, `calendar:invite` (default `calendar:read`), defined once as `SCOPES` in `src/auth/scopes.ts`, and the user chooses which requested scopes to grant (see "Scopes and consent").
- One login+consent page instead of login, TOTP and consent steps; the flow cookie carries no credentials.
- A stored password instead of a backend session token; the allowlist; the login throttle.
- The session validator decrypts and re-checks credentials, allowlist and hosts before calling `caldav.validate`; an unreadable credential is `expired`.
- A grant ends when the credential generation changes; refresh does not adopt a new generation.
- A grant also ends when its client completes a new consent for the account (the `consent` record).
- `/mcp` makes no per-request upstream validation call and decrypts only when a tool needs iCloud.
- The DynamoDB adapter accepts check-only transactions (conditions and no puts). The refresh-receipt authorization check needs them; wildduck-mcp's adapter rejects them.
