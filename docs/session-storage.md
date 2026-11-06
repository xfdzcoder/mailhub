# Server-managed sessions

The reviewed `auth_sessions` migration is additive. Session behavior now depends
on that table and the separate `20261106000000_add_user_disabled_at` migration.
Apply both through the normal migration process before starting this application
revision. Existing migrations and mail data are unchanged. Existing users receive
`disabled_at = NULL`; no session backfill is performed.

## Lifetimes and authorization

Password login and open self-registration create a server session. Access JWTs
last 15 minutes; refresh JWTs have a rolling seven-day expiry. Both are bounded
by the session's original 30-day absolute deadline. `JWT_EXPIRES_IN` no longer
extends access lifetimes. JWT verification requires HS256, JWT header type,
issuer `mailhub`, audience `mailhub:session`, access/refresh type, subject,
issued-at, expiry, user, organization, role, session ID and integer token version.
Refresh tokens use the separate refresh signing key derivation.

Every API authentication checks the active, unexpired session, enabled user,
and current organization membership. The database role controls authorization;
JWT roles are never authoritative. Access tokens remain usable across successful
refresh rotations until their own expiry, subject to those live checks. APIs
never accept a refresh token as an access credential. The page proxy can admit a
valid current refresh credential to load the application shell; data APIs still
require explicit refresh rotation. OAuth callbacks also check the live session.
Already-open realtime streams are outside this change's revalidation scope.

Legacy tokens without server session claims require a new password login. There
is no dual-acceptance period. Rollback to the old authentication implementation
would restore its stateless-token behavior and must not be treated as preserving
revocation guarantees. Keep the additive tables/column on application rollback.

## Rotation, replay and concurrency

Only a SHA-256 digest of the current refresh JWT is stored. One session row is
one refresh family, with a stable session/family ID and increasing token version.
Login, refresh, password changes and account disabling acquire a PostgreSQL user
row lock first. Refresh then locks the session row, checks the current digest and
version, and replaces them inside the same transaction. Signing or transaction
failure sends no cookies and leaves the prior credential usable after rollback.
The password hash is rechecked under the user lock when creating a session, so
an earlier password comparison cannot bypass a concurrent password change.

Only one concurrent use of a refresh credential succeeds. A request with the
immediately previous version, received less than five seconds after rotation,
gets `409 REFRESH_CONFLICT`. It gets no credentials and does not change cookies
or extend any deadline. This is a bounded conflict response, never old-token
acceptance. Other digest/version mismatches revoke every active row in the
family and return `401 AUTH_REQUIRED`. The revocation commits before the error
is returned. Different login sessions have independent families.

The browser shares one refresh promise per tab and uses Web Locks across tabs
where available. Without Web Locks, a loser can wait 250 ms and retry refresh
once using the browser's shared cookies. If the winning response has not arrived,
a second conflict remains recoverable on a later request; it does not force
logout or delete the winning cookie. Reusing the old credential after the
five-second conflict window revokes the family, requiring login. No raw old
credential or replacement credential is retained for recovery.

## HTTP and client contract

`POST /api/auth/refresh` rotates both HttpOnly, SameSite=Lax cookies together;
Secure is enabled in production. Cookie expirations match the bounded token
expirations. Token responses are `Cache-Control: no-store`.

Ordinary API authentication returns `401 AUTH_EXPIRED` when access credentials
are missing, expired or invalid, allowing an explicit refresh. Inactive sessions,
disabled users and removed memberships return `401 AUTH_REQUIRED`. Refresh
returns 401 for definitive rejection, 409 for the bounded conflict, and 503 for
transaction/service failures. Rejected refresh responses never write cookies,
preventing a losing response from erasing another tab's newly rotated cookie.

The fetch interceptor refreshes only an explicit `AUTH_EXPIRED` response on a
same-origin API request, including `/api/auth/me` and password changes. It retries
the original request once, retaining Request bodies. Login, registration, logout
and refresh endpoints are excluded. Unrelated 401 responses do not trigger
refresh. `AUTH_REQUIRED` redirects to login. Network/service failures and repeated
conflicts leave the page recoverable instead of forcing logout.

## Revocation

Logout revokes the current session before deleting both cookies. Password changes
atomically update the password and revoke all of that user's sessions, including
the current session, then delete its cookies. The user must log in again.

`disableUser(userId)` in `src/lib/auth/sessions.ts` is the administrative service
for atomically setting `disabled_at` and revoking that user's sessions across
organizations. There is no existing global user-administration endpoint in this
repository; this change does not grant organization admins global disabling
powers. The enabled-user check also fails closed if an operator sets the column
outside that service. Re-enabling a user must not un-revoke old session rows.

Removing a membership revokes only that user's sessions in that organization in
the deletion transaction. A demotion changes authorization on the next request
without logging out the user. Other users and organizations retain their sessions.

## Validation for issue #18

Validation used Node **24.22.2** (the supported Node 24 baseline). Commands were
run with the Node 24 binary directory prepended to `PATH`:

- `npm ci --ignore-scripts`: installed the locked dependency tree.
- `npx prisma generate`: generated Prisma Client successfully without connecting
  to a database.
- `npm run lint`: passed, with 83 warnings and zero errors. Removed obsolete
  suppressions only for the replaced authentication/client code and tests.
- `npm test -- --runInBand`: passed, 103 suites and 584 tests.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed (Next.js production compilation and page generation).

Regressions use synthetic JWTs and mocked, isolated database fixtures, including
transaction rollback, the explicit PostgreSQL lock statements/order, concurrent
refresh, replay revocation, password/disable revocation, scoped membership removal,
current-role authorization, cookie failures and bounded client recovery. These
checks do **not** constitute a real PostgreSQL concurrency or migration test:
PostgreSQL and Docker executables are unavailable in this environment. Real
cross-tab browser cookie/Web Locks behavior was not exercised; the browser
contract is covered by isolated fetch/lock fixtures. No deployed mailboxes,
production databases or production credentials were used. No UI layout changed,
so there is no visual preview artifact.
