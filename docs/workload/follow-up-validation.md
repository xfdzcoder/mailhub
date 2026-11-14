# PR #49 follow-up validation

This continuation remains draft. Git integration with `origin/dev` failed because
ORIG_HEAD is on a read-only filesystem. No metadata repair was attempted. The #48
outgoing helpers, bounded send/draft paths and regression fixtures, and #61's
accounting migration/models/contract were copied from the available `origin/dev`
source for compatibility testing. Resolve the dev merge manually before review;
no branch, issue, PR, deployment or production migration was created here.

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
PREPARING crashes and uncertain deliveries require investigation; there is no
automatic age-based reset. A tenant may have at most 1,000 unresolved operations.

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

Verified with Node 22.23.4, PostgreSQL 15.20 and Redis 7.0.15: 16 integration scenarios,
including synthetic 20-way storage/send contention, duplicate release, real-byte
budget denial, shared aliases, rollback cleanup, crash recovery, expiry fencing,
unowned/symlink readiness denial, actual database writes denied after Redis lease
loss, SMTP socket cancellation before DATA, independent identical sends, definitive
pre-delivery/authentication retries, partial recipient acceptance, and accepted DATA
with a dropped final acknowledgement. `--forceExit` closes Jest after assertions;
the application pool/Bull infrastructure retains process handles. No live mail or
production services are involved. The feature has no visual layout change, so no
preview files are required.

Final checks: all 871 tests across 122 suites with both Redis opt-ins and the
PostgreSQL opt-in enabled; TypeScript; ESLint (zero errors, 83 existing warnings);
and production build against disposable services. An initial full run hit the
existing JWT collection-time expiry-boundary test flake; a repeat passed without
changing that unrelated test or authentication code.
