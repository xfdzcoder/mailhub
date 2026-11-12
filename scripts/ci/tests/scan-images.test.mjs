import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise orchestration and failure handling without claiming container evidence.
for (const mode of ['clean', 'finding', 'scanner-error', 'missing-report', 'incomplete-report', 'inventory-error', 'stale-report', 'wrong-image']) {
  test(`final image scans: ${mode}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailhub-scan-test-'));
    try {
      writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash
if [[ $1 == image ]]; then echo '[{"Id":"sha256:fixture"}]'; exit 0; fi
if [[ $SCAN_TEST_MODE == inventory-error ]]; then exit 1; fi
echo 'fixture inventory'
`, { mode: 0o755 });
      writeFileSync(join(dir, 'trivy'), `#!/usr/bin/env bash
if [[ $1 == --version ]]; then echo 'fixture scanner'; exit 0; fi
printf '%s\\n' "$*" >> "$SCAN_TEST_LOG"
while (( $# )); do
  if [[ $1 == --output ]]; then output=$2; shift; fi
  shift
done
if [[ $SCAN_TEST_MODE == scanner-error ]]; then exit 2; fi
if [[ $SCAN_TEST_MODE == missing-report || $SCAN_TEST_MODE == stale-report ]]; then exit 0; fi
if [[ $SCAN_TEST_MODE == incomplete-report ]]; then echo '{}' > "$output"; exit 0; fi
printf '%s' '{"SchemaVersion":2,"Metadata":{"ImageID":"sha256:fixture"},"Results":[{"Class":"os-pkgs","Packages":[{}]},{"Class":"lang-pkgs","Packages":[{}]}]}' > "$output"
if [[ $SCAN_TEST_MODE == wrong-image ]]; then sed -i 's/sha256:fixture/sha256:other/' "$output"; fi
if [[ $SCAN_TEST_MODE == finding ]]; then exit 1; fi
`, { mode: 0o755 });
      const output = join(dir, 'evidence');
      if (mode === 'stale-report') {
        mkdirSync(output);
        for (const target of ['runtime', 'migrate']) {
          writeFileSync(join(output, `${target}-trivy.json`), JSON.stringify({SchemaVersion: 2,
            Metadata: {ImageID: 'sha256:fixture'},
            Results: [{Class: 'os-pkgs', Packages: [{}]}, {Class: 'lang-pkgs', Packages: [{}]}]}));
        }
      }
      const log = join(dir, 'calls');
      const result = spawnSync('bash', ['scripts/ci/scan-images.sh'], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, IMAGE_EVIDENCE_DIR: output,
          SCAN_TEST_MODE: mode, SCAN_TEST_LOG: log }, encoding: 'utf8',
      });
      assert.equal(result.status, mode === 'clean' ? 0 : 1, result.stderr);
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      assert.equal(calls.length, 2, 'scan the migration image even after runtime failure');
      assert.match(calls[0], /mailhub-smoke:runtime$/);
      assert.match(calls[1], /mailhub-smoke:migrate$/);
      for (const call of calls) {
        assert.match(call, /--severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL/);
        assert.match(call, /--ignorefile \/dev\/null/);
        assert.match(call, /--image-src docker/);
        assert.doesNotMatch(call, /--ignore-unfixed|--skip-/);
      }
      assert.ok(existsSync(join(output, 'runtime-image.json')));
      assert.ok(existsSync(join(output, 'migrate-image.json')));
      assert.match(readFileSync(join(output, 'base-image.txt'), 'utf8'), /node:24\..*@sha256:[a-f0-9]{64}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
