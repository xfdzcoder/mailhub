# Prisma tooling update (issue #17)

## Compatibility and dependency selection

Pin `prisma`, `@prisma/client`, and `@prisma/adapter-pg` to **7.10.1**.
Previously the manifest allowed `^7.8.0`, with 7.10.0 installed in the lockfile.
The [official 7.10.1 release notes](https://github.com/prisma/orm/releases/tag/7.10.1)
describe transaction correctness and dependency security fixes. The
[official migration guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)
requires compatible CLI/client updates and a driver adapter. The registry's
`latest` tag currently selects an 8.0.0 release candidate; this update deliberately
selects the stable 7.x patch, preserving the existing generator and configuration.

Published package metadata for all three 7.10.1 packages supports Node 24
(`^20.19 || ^22.12 || >=24.0` for CLI/client). The client requires TypeScript
`>=5.4.0`; the existing locked TypeScript satisfies that requirement. The adapter
accepts `pg ^8.16.3`; the existing application driver remains unchanged.
No schema, authentication, pool, TLS, generator, or Docker target changes are needed.

The CLI's `@prisma/config` now requires `deepmerge-ts 8.0.2` (already installed
elsewhere in the original lockfile), replacing its vulnerable nested 7.1.5 copy.
The CLI also requires `mysql2 3.24.4`, replacing 3.15.3 and its old escaping/queue
dependencies. These are upstream dependency constraints, with no overrides.
The published 7.10.1 engines package explicitly requires engines-version
`8.1.0-1.d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`; this is upstream metadata,
not an accidental Prisma 8 CLI/client upgrade. Unrelated lock entries are preserved.

## Audit and image boundaries

`npm audit --package-lock-only --json`, checked 2026-11-06:

| Full install / migration dependency tree | Before | After |
| --- | ---: | ---: |
| Critical | 1 | 1 |
| High | 5 | 1 |
| Moderate | 25 | 25 |
| Low | 4 | 4 |
| Total package findings | 35 | 31 |

The removed package findings are `prisma`, `@prisma/config`, `deepmerge-ts`,
and `mysql2`. Remaining package findings: `@jest/core`, `@jest/expect`,
`@jest/globals`, `@jest/reporters`, `@jest/transform`, `@tailwindcss/typography`,
`@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`,
`@typescript-eslint/type-utils`, `@typescript-eslint/typescript-estree`,
`@typescript-eslint/utils`, `babel-jest`, `babel-plugin-istanbul`,
`brace-expansion`, `deepmerge`, `eslint-config-next`, `glob`, `handlebars`,
`jest`, `jest-circus`, `jest-cli`, `jest-config`, `jest-resolve-dependencies`,
`jest-runner`, `jest-runtime`, `jest-snapshot`, `minimatch`,
`postcss-selector-parser`, `test-exclude`, `ts-jest`, `typescript-eslint`.
The remaining critical finding is `handlebars`; the high finding is
`brace-expansion`. Audit counts include dependency propagation and are not counts
of unique exploitable application vulnerabilities.

The `migrate` image inherits all dependencies from `deps`, so includes the CLI,
config, engines, dev and Studio packages as well as application dependencies.
The runtime installs dependencies separately after deleting devDependencies,
using `npm ci --omit=dev --omit=peer`, and copies the generated client. It should
include the client, PostgreSQL adapter and `pg`, but exclude the CLI, config,
engines, dev and Studio tooling. `scripts/ci/smoke.sh` now checks those boundaries
inside the actual images and reports installed versions before starting services.
Before and after, the runtime dependency audit (`npm audit --omit=dev --omit=peer`)
reports only two moderate package findings: `@tailwindcss/typography` and
`postcss-selector-parser`; no low, high or critical findings. This uses separate
clean installs with the same devDependency deletion and omit flags as Docker.

Local production-install inventories confirmed `@prisma/client` and
`@prisma/adapter-pg` changing from 7.10.0 to 7.10.1, with `pg` unchanged at
8.23.0. Both installs excluded `prisma`, `@prisma/config`, `@prisma/dev`,
`@prisma/engines` and `@prisma/studio-core`.

The runtime also includes a separately installed global `tsx` and Next standalone
output; a production dependency install alone is not a complete image inventory.

## Validation

The disposable Compose test now covers:

- A clean PostgreSQL database with two consecutive deployments.
- An existing initial schema, with only its applied migration marked resolved,
  upgraded through the remaining migrations, then deployed again.
- Exact preservation of a seeded user's identity, email, name and password hash,
  plus presence of the latest migration's session table.
- Actual image package inventories, Web startup and Worker heartbeat.

Run the Docker build and smoke commands in [ci.md](ci.md). No production database
or private credentials are used; the unique Compose project and volumes are
removed on exit.

Local checks used Node **24.11.1**:

- Clean full install, Prisma generation (client 7.10.1) and schema validation passed.
- ESLint passed with 87 existing warnings and no errors.
- Full Jest run passed: 100 suites, 525 tests.
- TypeScript (`tsc --noEmit`) passed.
- Production Next.js build passed. Redis connection-refused messages appeared
  because no Redis service is running locally; the build still completed.
- Shell syntax validation (`bash -n scripts/ci/smoke.sh`) passed.

Docker, Compose and PostgreSQL binaries are unavailable in this environment.
Actual image builds/inventories, clean PostgreSQL migration deployment,
existing-schema upgrade/data preservation, repeated deployment, and Web/Worker
container startup therefore remain **outstanding**, not passing results.
The local inventories above are dependency-install evidence only, not container
or Alpine/native-module validation. Run the documented Docker smoke checks before
merge. This change has no user-visible UI impact and needs no visual preview.
