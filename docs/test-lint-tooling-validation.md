# Test and lint glob compatibility

Issue #65 updates the development dependency tree, also installed in the Docker
migration target. It does not change the npm bundled in the base image (#60),
application dependencies, lint suppressions, or the release gate policy (#29).

## Parent releases checked first

Registry manifests checked on 2026-11-14 with `npm view <package>@latest`:

| Parent | Latest release | Relevant dependency ranges |
| --- | --- | --- |
| Jest (`@jest/reporters`, `jest-config`, `jest-runtime`) | 30.5.2 | `glob: ^13.0.6` |
| `babel-plugin-istanbul` | 8.0.0 | `test-exclude: ^7.0.1` |
| `test-exclude` | 8.0.0 | `glob: ^13.0.6`, `minimatch: ^10.2.2` |
| `@typescript-eslint/typescript-estree` | 8.72.2 | `minimatch: ^10.2.2` |

None accepts both fixed majors. Updating parents alone, including overriding
`test-exclude` to 8, would still leave these findings. Keep the existing parent
versions and scope overrides to the five consumers instead of replacing every
copy of minimatch.

The [glob advisory](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4)
is fixed in 14.0.2 and later. The
[minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
affects versions 7 through 11.0.0. The selected versions are glob 14.0.6 and
minimatch 11.0.8. ESLint and its plugins retain minimatch 3.1.5: that version is
outside the affected range and has a different CommonJS callable API.

## Override evaluation

- Jest's three consumers retain the CommonJS `glob.sync` API and options used
  for project expansion, extension resolution and coverage selection. Glob 14
  also brings its own compatible minimatch 11 and path-scurry 3 dependencies.
- `test-exclude` 7 uses `{ glob }` with `glob.sync` and promise-based `glob`, and
  `{ minimatch }` with `dot: true`. The new majors preserve those APIs. Fixtures
  check `.ts`/`.tsx` brace patterns, dotfiles, directory and test exclusions,
  negated exclusions that reinclude a file, node_modules exclusion, outside-root
  rejection, and empty matches. Both synchronous and asynchronous selection are
  checked, including the optimized glob ignore path without negated exclusions.
- TypeScript ESLint uses the named `minimatch` export for project-service
  `allowDefaultProject` selection with `dot: true`. A real parser invocation
  checks a matching dotfile and rejection of a nested file. ESLint's real config
  separately checks source selection and `.next`, `out`, `build`, and
  `next-env.d.ts` ignores.

These checks passed against the original tree before the overrides and against
an `npm ci` installation of the updated lockfile. They run before Jest in
`npm test`, using Node's test runner so they can exercise the actual installed
CommonJS consumers outside Jest's module loader. Jest discovery selects the same
119 test files before and after. Remove each override once its parent accepts
the patched major, retaining these compatibility checks.

## Node 24 verification

Validation uses Node 24.22.3 and npm 10.9.9:

```sh
npm ci
npx --no-install prisma generate
npm run lint
npm test -- --runInBand --coverage --coverageReporters=json-summary --coverageReporters=text-summary
npx --no-install tsc --noEmit
npm run build
npm ls glob minimatch --all
npm audit --json
npm audit --omit=dev --omit=peer --json
```

The complete installed tree has no glob or minimatch audit findings. The audit
changes from 27 entries (4 low, 23 moderate) to 6 low entries, all originating
from the existing `deepmerge` advisory and its Jest parents. These are propagated
package findings, not six distinct advisories. The runtime dependency audit
(`--omit=dev --omit=peer`) has zero findings. This verifies the shared dependency
tree used by development and migration; it does not claim an audit of the base
image's bundled npm or a new container scan.

Lint, TypeScript and the production build pass. The normal and coverage test
runs both pass: 117 Jest suites / 843 tests passed, with the existing 2 suites /
11 tests skipped, plus all 3 new compatibility checks. Coverage reports 59.75%
statements and 61.73% lines. Initial coverage runs hit an existing JWT
one-second boundary race and a controlled HTTPS test timeout while the build
was competing for resources; both full runs pass after the build completes,
without changing those tests or their timeouts. The build exits successfully
but logs Redis connection refusals because no local Redis service is running.
