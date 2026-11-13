# Incoming mail rejection persistence

Issue #56 adds storage only. No sync worker, policy decision, UI, resync endpoint,
or cleanup scheduler uses this table yet; #50 must adopt this contract before
recording rejections. The migration creates an empty table on fresh and legacy
PostgreSQL databases without inspecting or modifying existing mail.

## Identity and privacy

`IncomingMailRejection` belongs to an email account and is deleted by its foreign
key cascade when that account is deleted. All reads, updates and deletes must be
scoped to the authorized account; uniqueness is not an authorization check.

- IMAP identity is `(accountId, mailbox, uidValidity, uid)`. Store the actual
  selected server mailbox path, not an application folder category such as
  `inbox`. Preserve case and server namespace; normalize only the protocol's
  case-insensitive INBOX spelling to `INBOX`. UIDVALIDITY and UID are positive
  unsigned 32-bit values stored as BigInt. Never substitute zero, omit
  UIDVALIDITY, or use a Message-ID header. A changed UIDVALIDITY is a new source.
- Gmail identity is `(accountId, providerMessageId)`, using the opaque Gmail
  message ID, not its thread ID or RFC Message-ID. Labels are not identity.
- The migration checks that exactly one provider shape is present and uses
  bytewise identity comparisons. Nullable unique indexes are safe because the
  matching shape requires every component of its unique key to be non-null.

Retain only these source locators, a small allowlisted reason, positive integer
`policyVersion`, and timestamps. No content, subjects, sender/recipient addresses,
headers, attachments, raw errors or provider diagnostics belong here. Mailbox paths
and provider IDs are necessary locators, not fields for diagnostic text.

Initial reason codes are `message_size_limit`, `header_size_limit`,
`mime_depth_limit`, `mime_part_limit`, and `attachment_size_limit`. These describe
storage vocabulary, not enabled policies or threshold values. Extend the SQL
allowlist in an additive migration when a new deterministic reason is needed.
Transient network, authentication, parsing-library or provider failures are not
policy rejections and must not be recorded as one of these reasons.

## Recording and lifecycle contract for #50

Record only a deterministic rejection with a complete source identity. Use an
atomic upsert on the applicable unique key (Prisma's compound unique selector or
PostgreSQL `ON CONFLICT`); concurrent retries must not create additional rows.
On conflict update `lastRejectedAt`, `reasonCode`, and `policyVersion`, preserving
`firstRejectedAt` and `expiresAt`. Generate a UUID for inserts. For example:

```sql
INSERT INTO incoming_mail_rejections
  (id, account_id, provider, mailbox, uid_validity, uid, reason_code, policy_version)
VALUES ($1, $2, 'imap', $3, $4, $5, $6, $7)
ON CONFLICT (account_id, mailbox, uid_validity, uid) DO UPDATE
SET last_rejected_at = GREATEST(incoming_mail_rejections.last_rejected_at, EXCLUDED.last_rejected_at),
    reason_code = EXCLUDED.reason_code, policy_version = EXCLUDED.policy_version;
```

First/last rejection timestamps default to the database transaction time. Expiry
is fixed at at most 30 days from the first rejection; retries must never extend
it. Expired rows are not suppression evidence. #50 must delete expired rows
before replacing an expired identity, and provide daily indexed cleanup with
`DELETE FROM incoming_mail_rejections WHERE expires_at <= CURRENT_TIMESTAMP`.
Thus logical retention is 30 days; physical deletion is due at the next daily
cleanup (at most 31 days while the service is operating). After downtime, cleanup
must run on startup before processing mail. PostgreSQL does not automatically
expire rows; this storage-only change installs no scheduler.

`policyVersion` identifies the complete incoming policy configuration, including
thresholds. A policy change must use a new version: records from previous
versions remain historical evidence until expiry but cannot suppress reevaluation.
There is one current outcome per source, not an unlimited history of attempts.
An explicit user resync must clear this account's rejection records before
reevaluation, regardless of version. #50 must coordinate resync/policy transitions
with in-flight workers to prevent old work from restoring stale suppression.
Account deletion removes records immediately. None of these decisions is wired
into sync by this prerequisite migration.

## Isolated PostgreSQL verification

`scripts/ci/smoke.sh` applies the full migrations to a fresh PostgreSQL database
and upgrades a separate database from the initial schema with a synthetic legacy
user. It runs `incoming-rejections.sql` in both, restarts PostgreSQL, then runs
`incoming-rejections-after-restart.sql`. These fixtures verify both provider keys,
retries, account separation, mailbox case/path, UIDVALIDITY and UID separation,
invalid identities/reasons/retention, foreign keys, durable timestamps, expiry
cleanup and scoped account deletion. All fixtures are synthetic and cleaned up.
The Compose project uses isolated services and volumes; never run the fixture
SQL against deployed data. No visual behavior changes or previews are needed.

Local validation for this change applied every migration in order to isolated
PostgreSQL 16.4 databases, one fresh and one seeded with a synthetic user after
the initial migration. Both fixture files passed, including a real PostgreSQL
process restart between them. `bash -n scripts/ci/smoke.sh` also passed. The full
Docker application smoke test was not run locally because Docker is unavailable.
