#!/usr/bin/env bash
# Scan actual final images, including npm's independent global dependency tree.
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v docker >/dev/null
command -v trivy >/dev/null
command -v node >/dev/null
output=${IMAGE_EVIDENCE_DIR:-/tmp/mailhub-image-security-evidence}
mkdir -p "$output"
base=$(sed -n 's/^FROM \([^ ]*\) AS base$/\1/p' Dockerfile)
[[ $base == node:24.*@sha256:* ]]
printf '%s\n' "$base" > "$output/base-image.txt"
trivy --version > "$output/scanner-version.txt"
status=0
for target in runtime migrate; do
  image=${RUNTIME_IMAGE:-mailhub-smoke:runtime}
  if [[ $target == migrate ]]; then image=${MIGRATION_IMAGE:-mailhub-smoke:migrate}; fi
  # Preserve image IDs alongside the base reference and scanner package paths.
  if ! docker image inspect "$image" > "$output/$target-image.json"; then status=1; continue; fi
  if ! docker run --rm --entrypoint sh "$image" -ec '
    node --version
    npm --version
    cat /etc/alpine-release
    apk info -vv
    apk info -L zlib
    node -e '\''
      const fs = require("node:fs");
      function walk(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          const path = dir + "/" + entry.name;
          if (entry.isDirectory()) walk(path);
          else if (entry.name === "package.json") {
            const p = JSON.parse(fs.readFileSync(path, "utf8"));
            if (p.name && p.version) console.log(JSON.stringify({path, name:p.name, version:p.version}));
          }
        }
      }
      walk("/usr/local/lib/node_modules");
    '\''
  ' > "$output/$target-base-packages.txt"; then status=1; fi
  # Empty ignore file prevents ambient/local exceptions from hiding findings.
  # Include unfixed findings and every severity; scanner/network errors also fail.
  rm -f "$output/$target-trivy.json"
  if ! trivy image --image-src docker --scanners vuln --pkg-types os,library --list-all-pkgs \
    --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --ignorefile /dev/null \
    --format json --output "$output/$target-trivy.json" --exit-code 1 \
    "$image"; then status=1; fi
  if ! node -e '
    const fs = require("node:fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const image = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))[0];
    if (report.SchemaVersion !== 2 || !image?.Id || report.Metadata?.ImageID !== image.Id ||
        !["os-pkgs", "lang-pkgs"].every(kind => report.Results?.some(
          r => r.Class === kind && r.Packages?.length > 0))) {
      throw new Error("Incomplete image scan: OS and language package evidence required");
    }
  ' "$output/$target-trivy.json" "$output/$target-image.json"; then status=1; fi
done
exit "$status"
