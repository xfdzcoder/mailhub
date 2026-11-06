# Session storage rollout

This additive migration introduces auth_sessions. It does not change login,
refresh, logout, cookies, JWT lifetimes, or existing user and mail rows. The
follow-up authentication task must wait for this schema PR to be reviewed and
merged into dev. Do not treat this migration alone as session revocation support.

Each session stores a SHA-256 digest (64 hex characters), never a usable raw
refresh credential, with user and organization references, family/version fields,
rolling expiry and absolute expiry, and revocation/rotation timestamps. Membership
must still be checked by the future authentication implementation; these foreign
keys do not prove current membership or authorize a session.

Deploy using the migration target from this source revision, after a verified
backup. No backfill is needed: the table starts empty and existing authentication
continues unchanged until the separate behavior change. That change will define
legacy-session invalidation, rotation transactions, concurrent refresh handling,
absolute expiry, logout and password-change revocation.

Application rollback to the previous image can leave this unused table in place.
Do not drop it once a subsequent application begins storing active sessions.
A destructive database rollback is not part of this change. The pre-existing
missing application-table migrations remain a separate issue.
