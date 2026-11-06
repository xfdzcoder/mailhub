#!/usr/bin/env bash
set -euo pipefail
scope=${1:?source, runtime or migrate required}
mkdir -p security-evidence
raw=$(mktemp -d)
trap 'rm -rf "$raw"' EXIT
printf '{}\n' > "$raw/secret-config.yaml"
# Ignore files and secret rules from the checkout cannot suppress scanner findings.
common=(--config /dev/null --format json --exit-code 0 --ignorefile /dev/null --list-all-pkgs)
# Prove the secret engine detects a synthetic ephemeral key before accepting an
# empty report. Neither the key nor its scanner match is published.
mkdir "$raw/canary"
node --input-type=module -e '
  import { generateKeyPairSync } from "node:crypto";
  import fs from "node:fs";
  fs.writeFileSync(process.argv[1], generateKeyPairSync("rsa", {modulusLength: 1024}).privateKey.export({type: "pkcs1", format: "pem"}));
' "$raw/canary/key.pem"
trivy fs --config /dev/null --secret-config "$raw/secret-config.yaml" --format json --exit-code 0 --scanners secret --ignorefile /dev/null --output "$raw/canary.json" "$raw/canary"
node --input-type=module -e '
  import fs from "node:fs";
  const r = JSON.parse(fs.readFileSync(process.argv[1]));
  if (r.SchemaVersion !== 2 || !r.Results?.some(r => r.Secrets?.length)) process.exit(1);
' "$raw/canary.json"
if [[ $scope == source ]]; then
  # Scan a lockfile-only directory to avoid generated packages and local ignore rules.
  mkdir "$raw/lock"
  cp package.json package-lock.json "$raw/lock/"
  (cd "$raw/lock"; trivy fs "${common[@]}" --include-dev-deps --scanners vuln --output "$raw/report.json" .)
  node --input-type=module -e '
    import fs from "node:fs";
    const lock = JSON.parse(fs.readFileSync("package-lock.json"));
    if (lock.lockfileVersion !== 3 || !lock.packages || Object.keys(lock.packages).length < 2) process.exit(1);
    fs.writeFileSync("security-evidence/source-lock.json", JSON.stringify(Object.entries(lock.packages).filter(([p]) => p).map(([path, p]) => ({path, version: p.version, scope: p.dev ? "builder-migration" : "production-declared", optional: !!p.optional})), null, 2));
  '
  # Scan repository content, including hidden files; exclude generated dependency/build trees.
  trivy fs --config /dev/null --secret-config "$raw/secret-config.yaml" --format json --exit-code 0 --ignorefile /dev/null --scanners secret \
    --skip-dirs .git,node_modules,.next,security-evidence --output "$raw/source-secrets.json" .
else
  [[ $scope == runtime || $scope == migrate ]]
  trivy image "${common[@]}" --scanners vuln --image-src docker --output "$raw/report.json" "mailhub-smoke:$scope"
  trivy image --config /dev/null --secret-config "$raw/secret-config.yaml" --format json --exit-code 0 --ignorefile /dev/null --scanners secret \
    --image-src docker --output "$raw/$scope-secrets.json" "mailhub-smoke:$scope"
fi
if [[ $scope == runtime ]]; then
  trivy convert --format cyclonedx --output security-evidence/runtime.cdx.json "$raw/report.json"
  node --input-type=module -e '
    import fs from "node:fs";
    const b = JSON.parse(fs.readFileSync("security-evidence/runtime.cdx.json"));
    if (b.bomFormat !== "CycloneDX" || !b.components?.length) process.exit(1);
  '
fi
node scripts/ci/security.mjs "$scope" "$raw/report.json" "security-evidence/$scope.json"
