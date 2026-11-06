# Mailbox OAuth authorization transactions

Google and Microsoft authorization initiation uses the existing server session and
current organization membership. Redis stores a random 256-bit state transaction
for 600 seconds, bound to provider, session, user, organization and exact callback
URI, with the requested mailbox, label and a random PKCE verifier. Both providers
receive an S256 challenge; only the token endpoint POST receives the verifier.
Redis authorization commands have a three-second timeout and bounded retries,
independent of BullMQ's connection policy. Redis failure fails authorization closed.

Set NEXT_PUBLIC_APP_URL to the trusted application origin (HTTPS, or HTTP on
loopback for local development), without a path, credentials, query or fragment.
There is no request-origin fallback. Register the corresponding
/api/accounts/oauth/google/callback and /api/accounts/oauth/microsoft/callback
URIs with the providers. Callback request origin and path must match the configured
URI; forwarded headers are not trusted to choose the redirect destination.

An atomic Lua operation checks all bindings and deletes the transaction before
processing a matching callback. Rejections, missing codes, token exchange failures,
and identity failures consume it: restart via /init for a fresh authorization.
Never retry a consumed callback. A mismatched caller cannot consume another
session's transaction. Expired or unknown state also requires a restart. An
ambiguous Redis failure may have consumed state, so restart rather than replay.
Session validity and current membership are checked at callback entry and again
after provider calls. Google requires a verified userinfo email; Microsoft uses
Graph mail, falling back to userPrincipalName. The normalized provider mailbox must
match the mailbox reviewed at initiation before credential persistence. Existing
ownership/admin authorization remains in force; omitted replacement refresh tokens
preserve existing encrypted tokens. No migration or connected-account cleanup is
required. External account validation and general origin/rate-limit policy remain
separate work.

Tests use synthetic providers and an in-memory Redis command double to exercise
flow and binding failures; they do not constitute live provider or Redis integration
evidence. Provider protocol references:
- https://developers.google.com/identity/protocols/oauth2/native-app#step1-code-verifier
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
