# Release inventory gates

Every PR runs Node 24 validation, source scanning and local builds of the separate
`runner` and `migrate` targets. Only a successful `dev` run in xfdzcoder/mailhub
can transfer the tested runtime image to a publication job. That job alone has
package write permission and registry credentials. No scanner publishes images.

The source lock inventory includes development packages with their lockfile `dev`
classification. `production-declared` means declared production dependency, not
proof of presence in a shipped image. Builder and migration tooling share the
source tree; actual runtime and migration inventories come from their respective
built images, including OS packages and global worker tooling. The runtime
CycloneDX SBOM is generated from the same image scan report. Smoke checks continue
to verify that Prisma CLI tooling is absent from runtime and present in migrate.

Trivy 0.69.3 is downloaded from its versioned upstream release and verified against
a SHA-256 digest pinned in the installer. This verifies download integrity, not an
independent upstream signature. Scanner version changes require review. Database
updates are required; download, scanner, parsing, empty inventory, missing image
identity and SBOM failures block the job. Vulnerabilities of **every severity**,
including unfixed vulnerabilities, block unless explicitly accepted. Secrets block
without exceptions. No ignore file or severity threshold suppresses findings.
Source secrets cover the current checkout, not historical commits.

Artifacts retained for seven days contain source lock entries, sanitized dependency
findings and image package inventories, and the runtime SBOM. Secret match content
and raw scanner reports are temporary and never uploaded. A failed run can have
partial artifacts; partial artifacts are not successful evidence. Consult the job
conclusion as well as the inventories. Registry publication additionally requires
all validation and smoke jobs to succeed.

## Reviewer decisions

`.github/security/exceptions.json` deliberately starts empty. No risk has been
accepted by this implementation. Any current findings require remediation or a
human-reviewed exception. The typography parent constraint remains tracked in #32;
this change neither overrides it nor accepts any associated advisory.

Each exception must specify exact `scope` (`source`, `runtime`, or `migrate`),
`id` (scanner vulnerability ID), `package`, `version`, `owner`, `reason`, and
`expires` (UTC date, exclusive: invalid from midnight on that date). Wildcards are
not supported. Expired, malformed and duplicate exceptions fail validation,
including exceptions for packages no longer present. Source acceptance does not
accept the same finding in a shipped image. Owners should use public team handles
and public tracking references; never put private evidence in this file.

Run `node --test scripts/ci/security.test.mjs` for synthetic policy tests.
Run `bash scripts/ci/scan.sh source` with Trivy installed, and scan `runtime` and
`migrate` after building local `mailhub-smoke` tags. These commands never push.
Full scan and smoke evidence requires Docker, scanner databases and reachable
package registries; unavailable infrastructure must be reported as unavailable.

## Implementation validation

On Node 24.22.2: lint passed with existing warnings, all 105 Jest suites / 625
tests passed, TypeScript passed, and the production build passed. Actionlint and
shell syntax checks passed. Synthetic policy tests cover missing/truncated evidence,
secret redaction, image package coverage, migration isolation and exception expiry.
The real source scan correctly blocked on 17 unaccepted dependency findings and
reported zero secret findings after the positive canary check. No exceptions were
added. Docker was unavailable in the implementation environment, so actual image
inventories, runtime SBOM contents and integration smoke evidence remain pending CI.
No images, tags or releases were published during validation.
