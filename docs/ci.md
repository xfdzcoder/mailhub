# Fork development CI

The fork validates pushes to `dev`, `fix/**`, `feat/**`, `test/**`, and `ci/**`,
and pull requests targeting `main` or `dev`. Validation uses Node 20 and runs
`npm ci`, Prisma generation, ESLint, all Jest tests, TypeScript, and Next.js build.
Manual dispatch requires the workflow to exist on the repository's default branch.

Only `dev` builds in `xfdzcoder/mailhub` can publish to GHCR, after validation and
container smoke tests. Publishing uses the job-scoped `GITHUB_TOKEN` with
`packages: write`; validation and pull requests do not publish packages.
The tested runtime is pushed as `ghcr.io/xfdzcoder/mailhub:dev` and
`:sha-<full-commit-sha>`. Source and revision labels identify the source commit.
Use a SHA tag or digest for deployments and rollbacks. Deployment remains manual.
This initial pipeline builds linux/amd64. It does not publish release tags.
Future fork release naming is `v<upstream-version>-fork.<n>` for Git tags and
`<upstream-version>-fork.<n>` for image tags.

## Existing lint debt

`eslint-suppressions.json` records existing errors by file and rule count using
ESLint bulk suppressions. CI never regenerates it: excess errors and unused
suppressions fail validation. Existing warnings remain visible. This does not
remove debt or detect equal-count replacements within the same file and rule.
Fix violations incrementally and prune resolved suppressions; do not grow the
baseline to make a failing change pass. No tests are skipped.

## Container smoke test

```sh
docker build --target runner -t mailhub-smoke:runtime .
docker build --target migrate -t mailhub-smoke:migrate .
bash scripts/ci/smoke.sh
```

The `migrate` target includes the installed Prisma CLI and `prisma.config.ts`.
The runtime does not download a migration tool at startup. Production migration
is a separate manual operation after a backup; build the migration target from
the same source commit as the runtime.

Smoke tests create a unique temporary Compose project with PostgreSQL, Redis,
and Meilisearch. They run migrations twice, disable AI/embeddings in that test
DB, and verify the final runtime's Web endpoint and Worker heartbeat. The project
and its volumes are removed on exit. No real mail accounts or deployment secrets
are required. Missing upstream migrations for signatures, experiment settings,
notification webhooks, and summary runs remain a separate issue: this test does
not claim schema completeness or exercise real email synchronization.
