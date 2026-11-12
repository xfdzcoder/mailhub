# Node / Alpine base image findings (issue #60)

Checked 2026-11-12. Application `package.json` and `package-lock.json` are
unchanged: their overrides and audit do not control npm's bundled dependencies.

## Selected base and OS patch

All Docker targets now inherit the same supported Node 24 LTS image:

```text
node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
linux/amd64: sha256:d8d97e479cdc64f052f81f129362168717c59783ade8dcc1abd22e1cca8dbd7c
linux/arm64: sha256:f44b069ce4b5d00cb4f7dff81821a4a6953e3790420040abf300139b1d317c6c
```

The multi-platform index was verified directly against Docker's registry and
[Docker Hub tag metadata](https://hub.docker.com/v2/repositories/library/node/tags/24.22.3-alpine3.24).
The image was built November 11 from docker-node revision
`1274f3ee37d4d0e59d308ea25b83d9e21e4db862`. The previous floating
`node:24-alpine` reference cannot establish the digest used by a historical build.
Do not substitute today's tag digest for an unknown historical digest.

The downloaded amd64 Alpine layer's `/lib/apk/db/installed` records Alpine
3.24.4, musl 1.2.6-r3, libcrypto3/libssl3 3.5.9-r0 and **zlib 1.3.2-r1**.
[Alpine's security database](https://secdb.alpinelinux.org/v3.24/main.json)
identifies **zlib 1.4-r0** as the fix for **CVE-2026-4738**. Both the
[x86_64](https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/APKINDEX.tar.gz)
and [aarch64](https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/APKINDEX.tar.gz)
stable repository indexes publish that version. The shared base explicitly
installs `zlib=1.4-r0`, so dependencies, builder, migration and runtime all inherit
the fix. No edge repository or blanket distribution upgrade is used.
The base's library is `/usr/lib/libz.so.1` (versioned target `/usr/lib/libz.so.1.3.2`);
its package source is Alpine `main`, source package `zlib`, not npm.
The final-image inventory records `apk info -L zlib` to verify installed paths.

## npm bundle update and remaining findings

The newest Node 24 Alpine base still bundles npm **11.19.1**. The shared base
updates the complete global npm package to **11.21.2**, whose declared engine
range (`^20.17.0 || >=22.9.0`) supports Node 24, and cleans the package cache.
This preserves npm 11 and updates its own bundled tree without changing the
application lockfile. The
[Node v24.22.3 npm source](https://github.com/nodejs/node/tree/v24.22.3/deps/npm)
confirms the old versions identified by PR #43's runtime SBOM and
normalized findings in run `42262951066`. The downloaded amd64 Node layer
(`sha256:86781d25d3989ead8f09c45716da0159c1dd0be2c753a51f15b6c60f4b9a97db`)
was checksum-verified and its package manifests confirm these installed paths
and base versions:

| Package | Base → updated npm version | Installed package manifest under `/usr/local/lib/node_modules/npm/` | Previously reported CVEs |
| --- | --- | --- | --- |
| brace-expansion | 5.0.9 → 5.0.12 | `node_modules/brace-expansion/package.json` | CVE-2026-102276, CVE-2026-102278, CVE-2026-102277 |
| glob | 13.0.6 → 13.0.6 | `node_modules/glob/package.json` | CVE-2026-118773 |
| minimatch | 10.2.5 → 10.2.5 | `node_modules/minimatch/package.json` | CVE-2026-118764 |
| undici | 6.28.0 → 6.29.1 | `node_modules/undici/package.json` | CVE-2026-109383, CVE-2026-109869, CVE-2026-19534, CVE-2026-87018, CVE-2026-109924, CVE-2026-109932, CVE-2026-85024, CVE-2026-18540 |

The published [npm 11.21.2 bundle](https://registry.npmjs.org/npm/-/npm-11.21.2.tgz)
was inspected directly. Registry bulk advisory ranges confirm brace-expansion
5.0.12 and undici 6.29.1 are outside the affected ranges for the listed findings.
This is package metadata evidence, not a passing final-image scan.

**Remaining:** glob 13.0.6 (CVE-2026-118773 / GHSA-3g3m-2fjr-6pw4;
affected `>=9.0.0 <=14.0.1`) and minimatch 10.2.5
(CVE-2026-118764 / GHSA-g3hv-75wg-m249; affected `>=7.0.0 <11.0.1`).
Their package source is npm 11.21.2's published bundle under the paths above,
in both final images. The latest npm 11 patch still includes these versions;
retain them as unresolved pending a patched upstream bundle and a fresh scan.
This is not a claim that individual package patches are unavailable.
Do not replace nested vendored files or add application overrides to disguise
these copies. npm/npx remain required by the migration and Worker commands.
Other application and migration-only findings in that run are outside this
base-image change and remain subject to their existing gates.

## Reproducible verification and gates

```sh
node --test scripts/ci/tests/scan-images.test.mjs
bash -n scripts/ci/scan-images.sh scripts/ci/smoke.sh
docker build --target runner -t mailhub-smoke:runtime .
docker build --target migrate -t mailhub-smoke:migrate .
bash scripts/ci/smoke.sh
# Requires Trivy 0.76.2; returns nonzero for any finding or incomplete scan.
bash scripts/ci/scan-images.sh
```

The reusable `image-security.yml` workflow runs for CI, including PRs, with read
permissions and no registry credentials. It builds both final targets, runs the
existing generated-client/package-boundary, repeatable-migration, Web HTTP and
Worker heartbeat checks, and then scans both final images even if smoke fails.
The existing development publication job now requires this workflow to pass.
No images are published by the security workflow.

Artifacts contain the pinned base reference, final image IDs, Node/npm/Alpine
versions, OS package inventory, zlib paths, every global package manifest path
and version (including the separately installed runtime tsx), scanner version,
and full Trivy JSON with OS and language package inventories. Local output
defaults to `/tmp/mailhub-image-security-evidence`; use `IMAGE_EVIDENCE_DIR` to
choose another location. Both images are scanned even when the first fails.
All severities and unfixed findings are included, with an empty ignore file.
Missing tooling, malformed/missing or stale reports, mismatched image IDs and
scanner errors fail closed.
No exception, severity reduction, secret-policy change or application lockfile
update is included.

Local validation: eight scan orchestration/failure tests, shell syntax and
Actionlint validation of both changed workflows passed. An isolated installation
of the published npm 11.21.2 tarball on local Node 22.23.4 confirmed both npm
and npx report 11.21.2; this does not validate Node 24/Alpine. Registry/source/package
metadata checks establish the base selection and available OS patch, not a
passing final-image scan. Docker/Compose and a Docker socket are unavailable in
this environment: final builds, Prisma generation in Alpine, migration execution,
Web/Worker startup and both final-image vulnerability scans must run in CI.
The remaining glob/minimatch findings are expected to keep the security gate red
until an upstream patched bundle is selected. Do not describe the images as clean or
merge on the strength of mocked scanner tests. Nothing was deployed.

This change has no visual impact; no preview files are needed.
