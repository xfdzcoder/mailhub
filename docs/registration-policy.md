# Self-registration policy

Self-registration is closed by default. The registration API returns 403 before
parsing the body, hashing passwords, or accessing the database unless the server
operator explicitly sets `REGISTRATION_MODE=open`. Unset, empty, `closed`, and
unrecognized values all fail closed. The registration page displays the API error.

Upgrading changes the default for instances that previously accepted registrations
without explicit configuration. Operators who intentionally host open registration
must set `REGISTRATION_MODE=open` on Web and restart it. Existing users, login,
password changes, organization member administration, and mailbox access are not
changed. No database migration or account deletion is performed.

For a new private instance, initialize an administrator with `npm run create-admin`
in the trusted source/tooling environment with database access. Use protected
environment configuration or the interactive tool instead of putting a password in
shell arguments or public configuration. The runtime image intentionally does not
include maintenance scripts; do not enable public registration just to bootstrap it.

Invite-only registration is not implemented by this change; `invite` remains closed
until a separate invitation workflow is available. This switch does not implement
rate limiting or replace instance access controls. To recover from an unexpected
configuration problem, keep registration closed while existing users continue to
sign in. Do not roll back by silently reopening registration.
