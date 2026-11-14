# Protected integration credential storage

Issue #26 prepares storage only. Baseline: v0.4.0, application-table prerequisite
#52, merge 9416bf605f865d451f9a199cd94781f9d1ee2f24. The prepared worktree HEAD
and recorded origin/dev both reference that commit. A read-only GitHub API
check (`gh api repos/xfdzcoder/mailhub/branches/dev --jq .commit.sha`) also
returned that exact SHA. No branch/worktree workflow changes were needed.

## Inventory and boundary

| Source | Protected payload for a future writer |
| --- | --- |
| `experiment_settings.ai_api_key` | Organization AI API key, including OpenAI-compatible and Claude credentials |
| `experiment_settings.ai_base_url` | Entire custom endpoint: userinfo, path tokens, query parameters and fragment can contain credentials |
| `notification_webhooks.config` / TELEGRAM | Entire config, including `botToken` and `chatId` (destination identifier) |
| `notification_webhooks.config` / WECOM | Entire config, including `webhookUrl` and its query key |
| `notification_webhooks.config` / GENERIC | Entire config: `secret`, full `url` (userinfo/path/query/fragment), all `headers` including Authorization, cookies, API keys and arbitrary sensitive headers |

Encrypting the entire webhook config avoids guessing which provider-specific or
future fields are secrets. Preserve unknown JSON properties. AI provider/model,
custom prompts, names and activation flags stay in existing fields. Shared process
AI keys (`AI_API_KEY`, etc.), search-service keys and outbound policy configuration
are environment configuration, not organization database backfill targets.
Mail-account password/OAuth ciphertext and `src/lib/crypto.ts` remain untouched.
Provider error/log redaction and any historical secret-bearing logs are separate
follow-ups; this schema change does not claim to protect existing plaintext.

## Storage contract reserved for the follow-up

Both source rows gain nullable `credentialsEncrypted`, `credentialsFormatVersion`
and `credentialsKeyVersion` (mapped snake_case SQL columns). All three must be
null or all populated with nonempty ciphertext/key ID and a positive format
version. Checks are added NOT VALID to avoid scanning legacy rows; PostgreSQL
enforces them on new/updated rows. A later operator step can validate constraints
after backfill. No default, SQL encryption, data rewrite or automatic runtime adoption.
The key version is an opaque, non-secret key-registry ID, never key material.
The database permits future positive versions; readers must reject unsupported
versions explicitly, without guessing or falling back after authentication failure.

Reserve format **1** for AES-256-GCM with a fresh random 12-byte nonce per write,
16-byte authentication tag, encoded as `base64(nonce):base64(tag):base64(ciphertext)`.
Encrypt UTF-8 JSON: AI `{ "aiApiKey": string|null, "aiBaseUrl": string|null }`;
webhook `{ "config": <original JSON value> }`. AAD is UTF-8 JSON serialization
of `["mailhub.integration",1,table,organizationId,id,keyVersion]`, using physical
table names and canonical lowercase UUIDs. Bind row identity, tenant, format and
key ID to prevent ciphertext substitution. This defines a future implementation
contract; this change adds no encryption helper, key configuration or runtime use.
Do not reinterpret the existing mail-account `iv:tag:ciphertext` hex format.

## Bounded, resumable backfill plan (not executed by this change)

1. Deploy this additive migration first. Schedule a separately reviewed operator
   tool; never run backfill from SQL migration or application startup. Test only
   with synthetic fixtures. Verify database identity, applied migration, supported
   format, key registry and encryption/decryption round trip before each run.
2. Pause legacy credential mutation endpoints/workers for the backfill window,
   or first deploy coordinated writers that atomically refresh/invalidate the
   protected fields on every credential change. **Do not backfill alongside
   uncoordinated legacy writers**: they can change plaintext after a successful
   compare-and-set, leaving stale ciphertext. Runtime switching remains separate.
3. Process each table independently with keyset pagination by stable row UUID `id`,
   not offset, organization slug or display name. Capture a maximum ID for each
   pass; fetch at most 100 rows per batch and stop after 1,000 rows or 30 seconds
   per invocation. Persist table, last committed ID, pass upper bound, format,
   key version and aggregate counts in an operator checkpoint, never secrets.
4. Read source fields, organization ID, type (webhooks), updated_at and target
   tuple. For all-null target tuples, encrypt a snapshot in memory with the
   pinned key ID. In a short transaction update only if ID, organization ID,
   source values (`IS NOT DISTINCT FROM`, JSONB equality for config), type,
   updated_at and all-null target tuple still match. Check affected-row count.
   Commit checkpoint only after database commit. Skip CAS conflicts, count them,
   and revisit them in a full reconciliation pass. Never overwrite populated
   ciphertext just because a process restarted. Multiple tools may race safely
   through CAS, but the writer coordination in step 2 remains required.
5. On restart verify checkpoint database identity, migration and key ID; require
   explicit operator action if keys/config changed. Re-read populated tuples,
   authenticate/decrypt using their recorded format/key ID and compare recovered
   payload with current source. Unknown version, missing key, corruption or
   mismatch stops cutover; record IDs/counts only. Do not silently replace a
   mismatched tuple. Retain old keys until all referencing rows and backups expire;
   changing the active key must not relabel old ciphertext. Rotation is separate.
6. Re-scan from the beginning after each pass to find inserts below the cursor,
   CAS conflicts and skipped rows. Converge with coordinated writers or a final
   mutation freeze; prove zero missing/mismatched rows before any runtime switch.
   Explicitly encode absent/empty AI values; do not confuse them with an
   unprocessed all-null tuple. Deletions require no backfill; row identity is not
   reusable. Stop on repeated failures rather than retrying without a bound.

Rollback before cutover: stop the tool, keep legacy readers/writers, preserve all
plaintext and keys. Prefer leaving unused nullable columns in place. If abandoning
a populated run, clear all three fields atomically only for verified run-owned
rows using CAS on the exact target tuple; never clear another run's output. After
a runtime cutover, rollback requires the follow-up's dual-write/reconciliation
procedure to ensure plaintext is current. Dropping columns is optional destructive
cleanup requiring a separate reviewed migration after all new consumers stop.
No plaintext removal, endpoint changes, provider redaction, key rotation or
runtime switching is included here.

## Validation evidence (2026-11-12)

Used Node **24.11.1** throughout. Only a newly initialized, disposable local
PostgreSQL **18.6** cluster on port 55426 was used; no deployed database or
existing credentials were accessed. The integration script never consumes
`DATABASE_URL`: it requires an explicit loopback test-server URL, creates two
uniquely named databases, and drops those databases on exit. The server user
needs CREATE DATABASE permission. Use an isolated test cluster, not a local
production tunnel.

```sh
npm ci
npx --no-install prisma generate
npx --no-install prisma validate
CREDENTIAL_STORAGE_TEST_SERVER_URL=postgresql://postgres:synthetic-only@127.0.0.1:55426/postgres \
  node scripts/ci/protected-credentials.mjs
npm run lint
npm test -- --runInBand
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

All commands passed (generation was invoked directly through the equivalent
`node node_modules/prisma/build/index.js generate`). PostgreSQL was provisioned
with temporary tooling outside the repository; no package dependencies changed.
The storage script applies the full migration chain to a fresh database, and
separately deploys all pre-change migrations to recreate v0.4.0 before inserting
synthetic rows and upgrading. It verifies exact preservation of AI/webhook data,
URL components, headers, unknown config properties and mail-account ciphertext;
legacy SQL writes; reads/writes through a generated pre-change Prisma client;
nullable legacy tuples; incomplete/invalid tuple rejection; and repeated
`prisma migrate deploy` preserving both plaintext and populated target tuples.

ESLint: no errors or warnings. TypeScript: passed. Full Jest rerun: **117 suites,
843 tests passed**, 2 suites / 11 tests skipped by the existing suite. The first
run had one unrelated JWT wall-clock expiry test fail under concurrent cold
checks; that file passed all 21 tests in isolation, and the full rerun passed.
Production build completed; it emitted Redis connection-refused messages because
Redis was not running. Schema validation passed. This storage-only change has no
visible UI change, so no visual preview was generated.

## Runtime protection (#27)

Configure `INTEGRATION_CREDENTIAL_KEYS` as a JSON object of opaque key IDs to
base64-encoded 32-byte keys, and `INTEGRATION_CREDENTIAL_ACTIVE_KEY` as the writer
key ID. This registry is separate from mail-account encryption. Readers use each
row's recorded key and reject partial tuples, unknown versions, missing keys and
authentication failures. Only an entirely absent tuple permits legacy reads.
Settings mutations dual-write source and protected data atomically; retain legacy
columns for rollback/reconciliation. The guard migration rejects old credential
writers on populated rows unless they also replace ciphertext. Deploy it before
backfill. Settings responses contain presence flags only, with no partial key,
endpoint, webhook config or protected storage metadata.

The explicit operator tool is `npx tsx scripts/backfill-integration-credentials.ts`.
It requires `INTEGRATION_BACKFILL_DATABASE_URL`, `INTEGRATION_BACKFILL_CHECKPOINT`,
and `INTEGRATION_BACKFILL_COORDINATED=yes`, plus the key registry. Never point it
at production without separate operator review. It checks the guard migration,
database identity and encryption round trip, pins the checkpoint key, authenticates
populated rows, and uses exact JSONB row snapshots for CAS. Each invocation reads
at most 100 rows per batch and 1,000 per invocation, stopping between batches after
30 seconds. Checkpoints contain IDs and counts, never credentials. Re-run with the
same checkpoint to resume. After completion start a fresh checkpoint for a full
reconciliation pass, including inserts below the prior cursor and CAS conflicts.
Completion of one pass does not prove convergence. Do not cut over deployments
until a full reconciliation has zero conflicts/missing/mismatched rows. Rotation,
legacy-column removal and production backfill remain separate operator actions.

Validation for #27 used Node 24.22.3 and a new disposable PostgreSQL cluster on
loopback port 55427, with generated synthetic rows only. The runtime integration
check (`scripts/ci/integration-credentials-runtime.mjs`, using the same explicit
`CREDENTIAL_STORAGE_TEST_SERVER_URL` as the storage check) verifies a 1,003-row
bounded pass, checkpoint resume, full reconciliation, ciphertext preservation,
old-writer rejection, checkpoint key mismatch and corrupted ciphertext rejection.
The existing fresh/upgrade migration storage checks also pass unchanged in intent.
No production backfill or real-key rotation was performed; mail-account crypto
and legacy columns are retained.

Final Node 24 checks: ESLint and TypeScript passed; 120 Jest suites / 855 tests
passed (2 suites / 11 tests remain skipped by the existing suite). Production
build passed with disposable PostgreSQL and Redis running. Protected model reads
were verified for OpenAI-compatible and Claude calls. Saved webhook tests resolve
credentials server-side with tenant-scoped lookup. Browser preview capture was
attempted but blocked by missing Chromium system library `libglib-2.0.so.0`;
the transient preview manifest records the required tooling.
