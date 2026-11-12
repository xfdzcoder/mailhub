import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validateExceptions } from './security.mjs';
const report = () => ({ SchemaVersion: 2, Results: [{ Target: 'package-lock.json', Packages: ['fixture', 'next', '@prisma/client', 'prisma'].map(Name => ({ Name, Version: '1' })), Vulnerabilities: [{ VulnerabilityID: 'TEST-1', PkgName: 'fixture', InstalledVersion: '1', Severity: 'LOW' }] }] });
const exception = () => ({ scope: 'source', id: 'TEST-1', package: 'fixture', version: '1', owner: 'security-team', reason: 'Synthetic test', expires: '2099-01-01' });
test('all severities block unless exact scope/package/version exception matches', () => {
  assert.equal(evaluate(report(), 'source', []).findings[0].accepted, false);
  assert.equal(evaluate(report(), 'source', [exception()]).findings[0].accepted, true);
  assert.equal(evaluate(report(), 'source', [{ ...exception(), version: '2' }]).findings[0].accepted, false);
  assert.equal(evaluate(report(), 'source', [{ ...exception(), scope: 'migrate' }]).findings[0].accepted, false);
});
test('missing and incomplete evidence fails closed', () => {
  for (const r of [{}, { SchemaVersion: 2, Results: [] }, { ...report(), SchemaVersion: 1 }]) assert.throws(() => evaluate(r, 'source', []));
  assert.throws(() => evaluate(report(), 'runtime', []));
});
test('expiry, ownership, reason and duplicate validation', () => {
  validateExceptions({ exceptions: [exception()] });
  for (const e of [{ ...exception(), expires: '2000-01-01' }, { ...exception(), expires: '2099-02-30' }, { ...exception(), owner: '' }, { ...exception(), reason: '' }]) assert.throws(() => validateExceptions({ exceptions: [e] }));
  assert.throws(() => validateExceptions({ exceptions: [exception(), exception()] }));
});

test('image inventory requires OS, identity, application and global worker packages', () => {
  const r = report();
  r.Metadata = { ImageID: 'sha256:synthetic' };
  r.Results.push({ Target: 'alpine', Class: 'os-pkgs', Packages: [{ Name: 'musl', Version: '1' }] });
  assert.equal(evaluate(r, 'migrate', []).scope, 'migrate');
  r.Results[0].Packages = ['next', '@prisma/client', 'pg', 'tsx'].map(Name => ({ Name, Version: '1' }));
  assert.equal(evaluate(r, 'runtime', []).scope, 'runtime');
  r.Results[0].Packages.push({ Name: 'prisma', Version: '1' });
  assert.throws(() => evaluate(r, 'runtime', []));
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
test('CLI fails on missing/truncated reports and secrets; artifacts never include secret matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailhub-policy-'));
  try {
    fs.mkdirSync(path.join(dir, '.github/security'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github/security/exceptions.json'), '{"exceptions":[]}');
    const input = path.join(dir, 'report.json');
    const output = path.join(dir, 'inventory.json');
    const run = () => spawnSync(process.execPath, [new URL('./security.mjs', import.meta.url).pathname, 'source', input, output], { cwd: dir });
    assert.notEqual(run().status, 0);
    fs.writeFileSync(input, '{');
    assert.notEqual(run().status, 0);
    const clean = report();
    delete clean.Results[0].Vulnerabilities;
    fs.writeFileSync(input, JSON.stringify(clean));
    assert.notEqual(run().status, 0); // Missing secret evidence.
    fs.writeFileSync(path.join(dir, 'source-secrets.json'), JSON.stringify({ SchemaVersion: 2, Results: [] }));
    assert.equal(run().status, 0);
    fs.writeFileSync(path.join(dir, 'source-secrets.json'), JSON.stringify({ SchemaVersion: 2, Results: [{ Secrets: [{ Match: 'SYNTHETIC_PRIVATE_MATCH' }] }] }));
    assert.notEqual(run().status, 0);
    assert.equal(JSON.parse(fs.readFileSync(output)).secretFindings, 1);
    assert.equal(fs.readFileSync(output, 'utf8').includes('SYNTHETIC_PRIVATE_MATCH'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanner command failure propagates without clean evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailhub-scanner-'));
  try {
    fs.writeFileSync(path.join(dir, 'trivy'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    const scan = spawnSync('bash', [new URL('./scan.sh', import.meta.url).pathname, 'source'], {
      cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(scan.status, 42);
    assert.equal(fs.existsSync(path.join(dir, 'security-evidence/source.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
