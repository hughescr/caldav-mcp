# Authentication and account connection

This service is an OAuth 2.1 authorization server and an MCP resource server in one Lambda. Clients get only this service's short-lived access tokens and rotating refresh tokens. The service holds the iCloud credential and uses it for CalDAV requests on the client's behalf.

The issuer is one configured HTTPS origin (`PUBLIC_BASE_URL`). It is never derived from `Host` or forwarded headers. The protected resource is exactly `${issuer}/mcp`.

## What is stored

DynamoDB holds four record kinds under the `caldav-mcp#` key namespace (`pk = caldav-mcp#<kind>#<id>`, `sk = STATE`). Every record has a `revision` for compare-and-swap writes and an `expiresAt` for TTL cleanup. Every use checks expiry itself; TTL never grants validity.

| Kind | Id | Contents |
|---|---|---|
| `connection` | account id | Status (`active`, `reconnect_required`, `revoked`), credential generation, sealed `UpstreamCredentials`. One record per Apple ID. |
| `grant` | random | Client, scopes, resource, credential generation, token version, refresh generation, hashes of the current and previous refresh secret, optional sealed 10-second refresh receipt. |
| `code` | hash of the code | Client, redirect URI, resource, scopes, PKCE challenge, credential generation, consumed marker. Lasts two minutes. |
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

One page, `GET /authorize`, shows the client name and identity host (the CIMD hostname, or "Registered OAuth client"), the redirect hostname, the requested scopes, an Apple ID field (`autocomplete="username"`), an app-specific password field (`type="password"`, `autocomplete="off"`, at most 256 characters), an `allow_invite` checkbox only when `calendar:invite` is requested, and "Connect and allow" / "Cancel" buttons. It posts to `/auth/connect`. There is no TOTP step and no separate consent step: the user's own app-specific password is the consent credential for this connector.

The flow cookie `__Host-caldav-flow` is sealed (`browser-flow` purpose), `Secure; HttpOnly; SameSite=Lax`, ten minutes, and holds only `{deadline, csrf, flowId, binding}`. `binding` is a digest of the public OAuth request fields.

`POST /auth/connect` runs in this order:

1. `Origin` must equal the issuer; the body is a bounded, duplicate-free form; the CSRF token and request binding must match the cookie.
2. `decision=cancel` redirects with `error=access_denied` (no credential is read or sent anywhere). Any decision other than `allow` is rejected.
3. If `calendar:invite` was requested, `allow_invite=yes` is required.
4. The Apple ID is normalized (trim, lowercase, plain ASCII address). The password is trimmed of surrounding whitespace only; hyphens are kept.
5. Allowlist check.
6. Throttle reservation: one sign-in attempt is counted before iCloud sees it (see "Login throttle").
7. `caldav.discover` proves the credentials with iCloud. Discovered URLs must pass the fixed-host rule. A rejected sign-in keeps its reservation; any other outcome releases it.
8. Duplicate check, then `connectOrReconnect`, then `issueCode`, then the redirect with `code`, `iss` and `state`.

Invalid Apple ID syntax, an empty or oversized password, a non-allowlisted Apple ID and a wrong password all return the same static page with HTTP 400: "Sign-in failed. Check the Apple ID and app-specific password, then start the connection again." A throttled account gets 429. An upstream temporary or protocol failure, a discovery URL outside the fixed hosts, or a store failure gets 503. Failures after discovery also render these static pages: a concurrent reconnect that wins the generation change, or a session check that now fails, gets the 400 page; a temporary store or upstream error while storing the credential or issuing the code gets the 503 page. Failure pages never echo submitted fields, and every one clears the flow cookie.

Form pages use `Referrer-Policy: same-origin` (so Chromium sends a trustworthy `Origin` on the POST) and a CSP of `default-src 'none'; style-src 'sha256-<hash of the page style>'; form-action 'self' <callback origin>; frame-ancestors 'none'; base-uri 'none'`. Redirects use `Referrer-Policy: no-referrer`. Every page the browser flow serves (the form and the 400, 429 and 503 failure pages) embeds the same single `<style>` block from `src/auth/page-style.ts`, and the CSP allows exactly that text by its SHA-256 hash, computed at module load. The pages have no `style=` attributes, no scripts and no third-party assets, so the policy needs neither `'unsafe-inline'` nor a nonce. Editing the style block changes the hash with it.

**Duplicate delivery.** If the active, unexpired connection already holds identical credentials (same Apple ID, same password compared in constant time, same URLs), it is reused without bumping the credential generation, so an already returned code stays valid and the grants of other clients already using that credential keep working. Each delivery still runs discovery, so it is re-proven with iCloud. Anything else, including the same password for a connection that is `reconnect_required`, expired or `revoked`, is a fresh, iCloud-proven replacement under the next credential generation. An unreadable old ciphertext (retired key, damage) never blocks a replacement.

**Reconnect.** A login for an Apple ID that already has a connection replaces its credential with a conditional generation change. That ends every existing grant for the account, for every client; each client must authorize again.

## Login throttle

At most five sign-in attempts per account in flight or failed at any moment of a fixed 15-minute window. Before the iCloud request, the login reserves an attempt with a conditional write that succeeds only while the window's count is below five. A revision conflict re-reads and retries, at most eight times; after that, or on any store error, the login fails closed with 503 and iCloud is not contacted. A full window gets the 429 page without an iCloud request, even with the right password.

The outcome decides what happens to the reservation:

- iCloud rejects the sign-in (`unauthorized`): the reservation stays and counts as a failure until the window ends.
- The sign-in succeeds, or iCloud has a temporary or protocol failure: the reservation is released. Release is best effort; if it fails, the login still completes and the attempt stays counted until the window ends.

So successful logins and temporary failures do not consume the budget, and concurrent requests can never put more than five attempts at Apple at once. When the window ends, the next reservation starts a new window on the same record.

Known limits: anyone who knows an allowlisted Apple ID can make five wrong attempts and block new connections for that account until the window ends (at most 15 minutes), and can repeat this every window; existing grants are unaffected. Each such attempt is a real failed sign-in at Apple, at most five per account per window. A request that dies between reservation and release (for example a Lambda timeout) holds its slot until the window ends.

## Tokens and grants

Unchanged from wildduck-mcp:

- Codes last two minutes and need S256 PKCE and exact client, redirect, resource and scope bindings. A native client's loopback redirect may vary its port only. Exchange consumes the code and creates the grant in one transaction conditioned on the connection's credential generation. A reused code is denied without revoking the grant, so a code thief cannot turn it into a revocation attack.
- Access tokens last five minutes. Grants and connections last at most 180 days, and a grant never outlives the connection generation it was issued for. Tokens are authenticated routing envelopes, so a random token fails before any read. Only hashes of refresh secrets persist.
- Refresh rotates in one conditional transition. An identical retry within ten seconds returns the same sealed response (the receipt), bound to the previous secret, client, resource and effective scopes. The receipt is disclosed only while the account is allowlisted, the connection is active with the grant's credential generation, and a check-only transaction on the grant and connection revisions succeeds. A replay outside the window revokes that client's grant. Wrong-client and random-token attempts never change anything.
- Dynamic client registration is stateless (signed client ids and secrets). Client ID metadata documents are fetched through `@better-auth/cimd` with public-IP DNS pinning, TLS identity checks, no redirects and a 5 KiB cap.
- Store reads are strongly consistent; unknown transaction outcomes are temporary errors, never conflicts. Operation ids bind exact payloads for bounded retries.
- The keyring is cached for at most five minutes, loads coalesce, and an expired cache fails closed if SSM is unavailable.

The engine validates the backend session at connect, code issue, code exchange and refresh. Here that is one CalDAV PROPFIND with the stored credentials; only a 207 multistatus counts as valid, a 401 is `expired`, and anything else (a plain 200 included) is temporary. A temporary failure keeps the code or refresh token usable and returns `503 temporarily_unavailable`. `expired` (a definitive 401, removal from the allowlist, or a stored credential that cannot be opened or re-validated) conditionally marks the observed connection `reconnect_required` and returns `invalid_grant` with "Reconnect your iCloud account and authorize this client again." `temporarily_unavailable` is reserved for keyring, store and upstream unavailability.

### Credential generations and grants

Every replacement of the stored credential increments the connection's credential generation. Codes and grants record the generation they were issued for, and a grant is valid only while it equals the connection's: access-token verification, refresh and refresh-receipt recovery all compare them, and refresh never moves a grant to a newer generation. So any replacement ends every earlier grant for the account. After the owner revokes the app-specific password at Apple and reconnects with a new one, every old refresh token fails with `invalid_grant` and every old access token gets the 401 bearer challenge on `/mcp`, so each client, and any client the owner did not authorize, must go through the login page again. The duplicate-delivery path is the only login that keeps the generation, so a second client connecting with the identical, still-active credential does not end the first client's grant.

## MCP requests and `reconnect_required`

`/mcp` verifies the access token (including the credential generation), checks the allowlist, reads the grant and connection, and builds a request-local calendar service. It makes no separate validation request: the tool call itself reaches iCloud. The credential is decrypted lazily, inside the bound service, only when a tool on an active connection needs iCloud; `initialize` and `tools/list` never decrypt, and an inactive or expired connection is never decrypted. A credential that cannot be opened or re-validated (`UnreadableCredentials`) is handled like a definitive 401: the tool returns `reconnect_required`, the connection is conditionally marked `reconnect_required`, and a new login replaces it.

The read tools (`list_calendars`, `list_events`, `search_events`, `get_event`) require `calendar:read`. Errors are structured `{ error: { code, message, request_id } }` with codes `reconnect_required`, `temporarily_unavailable`, `insufficient_scope`, `upstream_error`, `invalid_input`, `not_found`, `result_too_large`, `calendar_changed`, `unsupported_calendar_data`, `unsupported_attachment` and `verification_failed`, and a server-generated request id. No upstream text is forwarded. Only the tool name, request id and code are logged.

If iCloud answers a tool call with a definitive 401, the service marks the connection `reconnect_required` with a CAS on the revision it read, and returns `reconnect_required`. A connection reconnected concurrently is not overwritten. While a connection is `reconnect_required`, tool calls return that code without contacting iCloud; access tokens of the same generation stay valid until they expire, and refresh fails with `invalid_grant`. A fresh login restores service under the next credential generation, for newly authorized grants only: every earlier grant has ended. A 403 from iCloud is treated as temporary, not as invalid credentials.

## Differences from wildduck-mcp

Copied from wildduck-mcp and adapted, not shared. A security fix must be applied in both repositories.

- Names and domain separation: HKDF info, AAD prefix, cookie name, key namespace and keyring parameter all use `caldav-mcp`.
- Scopes are `calendar:read`, `calendar:write`, `calendar:invite` (default `calendar:read`), defined once as `SCOPES` in `src/auth/http.ts`.
- One login+consent page instead of login, TOTP and consent steps; the flow cookie carries no credentials.
- A stored password instead of a backend session token; the allowlist; the login throttle.
- The session validator decrypts and re-checks credentials, allowlist and hosts before calling `caldav.validate`; an unreadable credential is `expired`.
- A grant ends when the credential generation changes; refresh does not adopt a new generation.
- `/mcp` makes no per-request upstream validation call and decrypts only when a tool needs iCloud.
- The DynamoDB adapter accepts check-only transactions (conditions and no puts). The refresh-receipt authorization check needs them; wildduck-mcp's adapter rejects them.
