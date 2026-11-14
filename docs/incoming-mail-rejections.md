# Incoming mail rejection persistence

The migration from #62 provides storage; #50 now applies this contract in the
Gmail and IMAP incoming workers. The migration creates an empty table on fresh and legacy
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
  UIDVALIDITY, or use a Message-ID header. A changed UIDVALIDITY is a new source. The locator is bounded to 1024 characters and 2048 UTF-8 bytes so it fits the unique index. If the selected server path exceeds this contract, treat the source identity as unavailable and preserve sync retry semantics.
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
Account deletion removes records immediately. The migration itself installs no policy or scheduler; the worker implements
these lifecycle decisions.

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

## Worker behavior and follow-up verification

`IncomingOutcome` distinguishes accepted content, durable policy rejection, and
retryable failure. Only `IncomingPolicyError` from measured message/decoded,
attachment, or part-count limits can produce a row. Response-wide limits,
transport errors, malformed provider data, parser exceptions, worker crashes,
timeouts, cancellation, missing source identity and database failures remain
retryable. Header/depth reason codes remain reserved vocabulary; no new header
or depth policy is enabled by this follow-up.

IMAP uses the selected mailbox path and UIDVALIDITY, never the app folder name.
Gmail uses its opaque message ID. An account-scoped PostgreSQL advisory lock
serializes bounded reads and rejection writes with explicit resync clearing.
The transaction is bounded to 120 seconds; contention/timeout rolls back and
retries. Atomic SQL upserts use database timestamps and preserve first rejection
and expiry, including submillisecond database precision. A policy version bump
must accompany any change to the complete `INCOMING_LIMITS` configuration.
Old-version records cannot suppress the new policy, and a superseded worker
returns a retryable outcome when it encounters newer evidence. Upserts cannot
downgrade a newer policy version. The account lock orders in-flight evaluations
and resets across worker processes.

`POST /api/accounts/[id]/sync` authorizes account access, waits for active
rejection evaluations, clears only that account's records and sync timestamps,
and queues a distinct resync job even if an initial sync is active. Watermark
updates use the original account `updatedAt` as an optimistic fence, preventing
pre-reset work from advancing the reset watermark. Gmail and historical queue
watermarks use the start cutoff, not the finish time. IMAP mailbox failures and
missing fetched bodies prevent watermark advancement. Later messages in the
same batch continue after a durable rejection or an individual transient error.

Startup cleanup precedes new content evaluation, and the worker runs cleanup
daily. Each indexed delete transaction removes at most 1,000 expired rows;
cleanup drains the backlog after downtime. No provider mutation is used.

Synthetic unit tests cover typed failures, persistence failure, scoped resets,
identity validation, bounded cleanup, and full multi-chunk attachment downloads
for Gmail and IMAP. `scripts/ci/incoming-rejections-worker.ts` adds executable
PostgreSQL acceptance coverage. Against a disposable fully migrated database,
set `DATABASE_URL` and `INCOMING_REJECTION_FIXTURE=1`, run
`npx tsx scripts/ci/incoming-rejections-worker.ts seed`, restart PostgreSQL, then
run the same command with `verify`. The separate processes verify durable
provider deduplication, ordinary successor messages after restart, fixed
retention across policy reevaluation, expiry, cleanup and an in-flight resync.
The fixtures use only synthetic `example.invalid` identities and remove them
after successful verification. Never run this fixture against deployed data.

Follow-up validation used Node 22.23.4, Node 24.22.3 and disposable PostgreSQL 18.6: all
migrations, the storage SQL fixtures across a database restart, and the worker
fixture across separate processes and another database restart passed. The
worker fixture also verifies that pre-resync work cannot advance a reset
watermark and that a current revision remains writable with PostgreSQL timestamp
precision. Lint, TypeScript, 884 tests and production build passed on Node 24. Redis
integration tests (11) remain skipped because Redis is unavailable; the full
Docker application smoke remains outstanding. This change has no visual presentation.
