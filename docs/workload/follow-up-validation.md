# PR #49 follow-up validation

This continuation remains draft. The source tree integrates current `dev`
(`6d63cd2a5ba9fbfdb561c889b1633ef5510f5451`, verified against GitHub).
Fetch/merge could not update FETCH_HEAD/ORIG_HEAD because the worktree Git metadata
is mounted read-only. No metadata repair was attempted; a Git ancestry merge still
requires manual resolution. Dev-only changes were integrated verbatim, with
three-way conflict resolution preserving the workload changes and dev contracts.
The released #61 migration is byte-for-byte unchanged (SHA-256
`5bf05b5cf82d19194388bba1329ce81643a4cd17bf954434bf99540e8f7657ec`).
Send deadlines/indexes use a new additive migration. No deployment was performed.

## Adopted behavior

Outgoing send/draft writers reserve before writing (and before SMTP), publish an
exclusive temporary file atomically, measure the regular file, and commit the
attachment/reference/object/reservation together. Actual bytes replace estimates;
a PRESENT object is counted once, excluding its outstanding estimate. Ownership
comes from the account, including the principal that owns it. Organization and
principal limits default to 1 GiB and 256 MiB, configurable with positive decimal
`WORK_ORG_STORAGE_BYTES` and `WORK_PRINCIPAL_STORAGE_BYTES`. Admission fails closed
for incomplete inventory, owner conflicts, unowned files, symlinks/hard links,
observation drift, ERROR/ORPHAN/unknown objects or unresolved owner tombstones.
Readiness scans are capped at 10,000 objects/rows/directory entries; larger volumes
require an offline inventory design before adoption. These are attachment volume
budgets, not database/search/WAL quotas.

`reconcileAttachmentAccounting()` inventories disk, stored objects and legacy
rows independently. Shared canonical paths are measured once; remote-only metadata
is ignored. It rechecks live references under organization/object locks, retains
ownership after deletion and never deletes files. Unexpired writers are skipped.
Expired writers are fenced by incrementing the object revision under the same lock
used for publication; real committed references produce COMMITTED reservations,
otherwise EXPIRED with MISSING/ORPHAN/ERROR observations. Expiry alone grants no
right to delete a file. Releases are conditional/idempotent and preserve orphan
bytes. Writer cleanup checks generation, reservations and references before unlink;
post-commit draft replacement cleanup checks canonical aliases and re-stats. Legacy
files without an accounting identity must be inventoried before cleanup.

Work contexts renew/check Redis ownership immediately before later database,
queue, sync, search, summary, notification and send effects. Loss is permanent for
that invocation, including detached continuations after its scope closes. Trusted periodic
pollers and IMAP EXISTS triggers explicitly start fresh admission outside the old
scheduling scope; this boundary has a real-Redis regression fixture. SMTP
uses an abortable underlying socket; Graph/Gmail requests use the work signal.
Transactions check again before commit. An effect already accepted externally
cannot be recalled; durable send uncertainty fences replay of that operation.
Mixed older processes and external filesystem writers remain unsupported for
readiness. Inventory/reconciliation must run until stable before enabling new
writes on an existing volume. The dormant legacy attachment-repair helper is not
called by current lazy incoming sync; any future caller must adopt this protocol.

Sends require an explicit `Idempotency-Key`, scoped to authenticated organization,
user and account. The composer retains one ID per draft in session storage; rule
forwarding uses the source email ID. Payload hashes bind that ID, allowing separate
operations with identical content. PostgreSQL persists PREPARING before preparation,
DELIVERING before the delivery call, and DELIVERED after confirmation. Definite
pre-delivery exceptions, SMTP authentication failures and known connection-stage
failures permit same-ID retries. Partial recipient acceptance, lost final SMTP
acknowledgements, generic network failures and crashes in DELIVERING never
implicitly retry. Gmail delivery disables the generic HTTP response retry loop.
An abandoned PREPARING operation can be reclaimed after its persisted preparation
deadline (default 10 minutes). Recovery rotates the generation under a conditional
update; the old holder cannot transition to delivery, release the new claim, or
record its completion. The delivery transition checks the deadline atomically
using PostgreSQL time. Recovery alone does not send anything: an explicit same-ID,
same-content retry is required. DELIVERING is never reset by age or Redis loss.

All states count toward a default 1,000 retained operations per organization;
admission never evicts an unexpired marker. Retention defaults to seven days,
persisted from claim/retry and refreshed immediately before delivery. Thus an
uncertain delivery remains protected for the full replay window from the delivery
attempt. Successful completion does not shorten that deadline. After expiry,
operation identities may be reused: clients must use fresh IDs for new sends and
must not retry old requests outside the replay window. Existing markers receive a
full seven-day window on migration; existing preparation receives ten minutes.
Stop older API/worker processes before adopting this protocol, since they do not
check preparation deadlines.

`WORK_SEND_PREPARATION_MS` accepts 1,000–3,600,000; `WORK_SEND_REPLAY_MS` accepts
3,600,000–2,592,000,000; `WORK_SEND_RETAINED_PER_ORG` accepts 1–100,000. Invalid
values use defaults. Keep configuration consistent across API/worker processes.
Changing configuration does not shorten already-persisted replay deadlines.
The worker sweeps at startup and every minute, deleting at most 500 expired rows
and recovering at most 500 abandoned preparations per pass. Claim admission also
cleans at most 500 expired rows for its organization. Concurrent sweepers skip
locked rows. No live preparation or unexpired delivery marker is deleted; idle
tenants are cleaned by the worker without needing new sends.

## Repeat isolated verification

Use an otherwise empty, disposable loopback PostgreSQL database whose name ends
in `_test`. The integration fixture refuses other targets and removes its synthetic
data. Never point these commands at application data. Redis fixtures launch private
Unix-socket instances with persistence disabled; SMTP sinks bind only to loopback
on ephemeral ports. Fixtures use only synthetic example.test addresses/content.

```sh
export DATABASE_URL=postgresql://node@127.0.0.1:55449/mailhub_workload_test
export WORKLOAD_TEST_DATABASE_URL="$DATABASE_URL"
export WORKLOAD_TEST_REDIS_SERVER=/path/to/redis-server
npx prisma migrate deploy
npx prisma migrate deploy
npx jest --runInBand --forceExit src/__tests__/lib/workload/durable-accounting.test.ts src/__tests__/lib/workload/admission-redis.test.ts
```

The disposable fixtures cover synthetic 20-way storage/send/recovery contention,
real-byte budgets, expiry fencing, stale callbacks, finite 500-row sweeps,
all-state retention limits, SMTP acceptance with dropped acknowledgements,
partial acceptance, and Redis lease loss. The restart suite launches separate
processes that abandon preparation and persist delivery uncertainty, restarts both
PostgreSQL and Redis, then verifies preparation recovery and blocked delivery
replay from fresh processes. Run that suite in its own Jest process so unrelated
application pools do not remain connected during the deliberate database restart:

```sh
export WORKLOAD_TEST_PG_CTL=/path/to/pg_ctl
export WORKLOAD_TEST_PG_DATA=/tmp/mailhub-disposable/pgdata
npx jest --runInBand --forceExit src/__tests__/lib/workload/send-restart.test.ts
```

The restart opt-in requires a loopback `_test` database and a `/tmp/mailhub-*`
cluster directory. Omit the PostgreSQL restart variables for the regular full
suite. All fixtures use synthetic data, private Redis instances and loopback SMTP;
no production services or live mail are involved. This follow-up has no visual
layout change, so no preview files are required.

Verified on Node 24.22.3, PostgreSQL 15.20 and Redis 7.0.15: 866 Jest tests
passed in the full run (12 opt-in tests skipped), plus the separately run restart
test and three tooling compatibility checks. TypeScript, ESLint and production
build passed. Migrations deployed successfully twice, with the second deployment
reporting no pending migrations. Disposable services were stopped after testing.
