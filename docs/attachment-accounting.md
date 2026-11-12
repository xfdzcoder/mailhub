# Durable attachment accounting foundation

This migration is inactive: no writer integration, enforcement, backfill, deletion,
cleanup or send changes. Existing attachment rows and storage layout remain intact.
PR #49 must remain draft until this prerequisite reaches dev; lease-loss fencing
and send-retry findings are separate work and are not resolved here.

## Inventory

`Attachment` belongs to Email, then EmailAccount and organization. Its nullable
Int sizeBytes is provider/legacy metadata, not proof of disk usage. Incoming
metadata-only IMAP/Gmail attachments can have null storagePath and remote part
references: these are not missing local files. attachment-storage.ts preserves
existing paths and can write files before database commit. attachment-retrieval.ts
reads local files or retrieves remote content. outgoing-files.ts stages UUID files
in .storage/attachments before send/draft transactions. Draft updates can replace
rows; omitted attachments preserve them. Existing paths may be reused by multiple
rows, including copies: summing attachment sizes double-counts. Historical sizes
may be null, zero or inaccurate; only successful stat of a regular file measures
local bytes. Existing file-existence helpers collapse errors and are unsuitable
for accounting observations.

## Identity and ownership

One object per canonical storage-root-relative key, independent of attachment ID.
Resolve historical absolute/relative aliases against the configured storage root;
reject traversal, symlinks and paths outside it for manual review. Do not move files.
Hard-link aliases require inode/device inspection and explicit review before totals
are trusted. References map many attachment IDs to one object. IDs intentionally
have no legacy foreign keys: cascading account/email deletion must not erase the
last durable evidence of physical bytes. Owner IDs are tombstones, not permission
grants. Cross-owner path conflicts remain unmeasured and block readiness until
reviewed; never silently transfer ownership. Unowned discovered files use null
owner IDs. Physical totals sum objects once, never references; organization totals
use the single durable owner. Account deletion retains ownership until reconciled.

UNMEASURED means no reliable observation; PRESENT requires measured bytes and an
observation time (zero is valid); MISSING requires confirmed ENOENT and null bytes.
ERROR means permission/I/O/unsupported-path failure; ORPHAN means an observed file
has no live reference or active writer. Unknown/error/orphan entries block quota
readiness, rather than being treated as zero. Re-stat after every mutation.

## Future writer and reconciliation protocol

Before writing, serialize by organization and object (consistent lock order),
insert a unique operationKey reservation and object identity in one transaction.
Retry the same operation key, never reserve twice. Validate owner/object agreement
under lock. RESERVED holds estimated bytes until COMMITTED, RELEASED or EXPIRED.
Write an exclusive temporary file then atomically publish; commit attachment,
reference, measured object and reservation together. Reused objects add references
without another physical charge. Future quota calculations must exclude reservations
for already charged objects and serialize all capacity decisions per organization.

Use revision compare-and-swap plus a fenced writer generation; a reconciler must
not overwrite a newer observation. Reservation expiry alone never authorizes file
removal or a stale writer commit. Stop/fence the writer and inspect references and
files before marking EXPIRED. Lease-loss handling remains a prerequisite to use.
Rollback releases reservations but leaves written bytes as orphan candidates.
Crash after write/before DB commit is recovered from reservation key and directory
inventory. Crash after commit is resolved by operationKey, without repeating send.

Reconciliation first inventories legacy rows and disk independently, groups paths,
measures regular files, records references and flags disagreements. Recheck under
locks before publishing observations; repeat scans until no concurrent drift remains.
Account deletion removes live references only after validating actual legacy rows;
retain object and owner tombstones. Unreferenced disk files become ORPHAN after
writer fencing and a grace period; this design never deletes them. Missing files
remain distinct from remote-only rows. Quotas require complete owner coverage,
resolved conflicts, no unknown observations and writer integration first.

## Deployment and rollback validation

Use disposable PostgreSQL only. Apply all migrations to an empty database using
`prisma migrate deploy`; repeat deploy (Prisma's migration ledger makes reapply a
no-op). Separately deploy the prior migrations, seed synthetic account/email and
attachment rows including shared paths, null/wrong sizes and remote-only metadata,
then deploy this migration. Verify legacy rows and synthetic file hashes unchanged
and all three new tables empty. Insert synthetic objects/references/reservations:
check unique keys reject duplicate paths and operation retries, multiple references
share one object, negative sizes/invalid states fail and PRESENT zero succeeds.
Confirm deleting a synthetic account cannot cascade into accounting evidence.

Application rollback needs no DDL: old code ignores these additive tables. For a
schema rollback on the disposable database only, drop reservations, references,
then objects in that order inside a transaction; verify legacy rows and file hashes
again. Never drop populated accounting evidence in production. A later forward
migration is required if the foundation needs revision after adoption.

Verified on disposable PostgreSQL 17: fresh deploy, upgrade with synthetic legacy
rows and a shared file, repeat deploy, uniqueness and size constraints, retention
of accounting evidence after account deletion, and schema rollback. The application
schema and its synthetic file survived upgrade and rollback. Also verified deployment
after the credential storage migration already ran on the database.
