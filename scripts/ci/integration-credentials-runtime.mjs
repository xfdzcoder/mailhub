// Synthetic fixtures only: explicit loopback server; unique disposable database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
const server = new URL(process.env.CREDENTIAL_STORAGE_TEST_SERVER_URL || 'invalid:');
assert(['localhost', '127.0.0.1', '[::1]'].includes(server.hostname));
const admin = new pg.Client({ connectionString: server.href });
const name = 'runtime_credentials_' + randomUUID().replaceAll('-', '');
const temporary = await mkdtemp(join(tmpdir(), 'mailhub-runtime-'));
const url = new URL(server); url.pathname = '/' + name;
const env = { ...process.env, DATABASE_URL: url.href, INTEGRATION_BACKFILL_DATABASE_URL: url.href,
  INTEGRATION_BACKFILL_CHECKPOINT: join(temporary, 'checkpoint.json'), INTEGRATION_BACKFILL_COORDINATED: 'yes',
  INTEGRATION_CREDENTIAL_KEYS: JSON.stringify({ test: Buffer.alloc(32, 9).toString('base64') }), INTEGRATION_CREDENTIAL_ACTIVE_KEY: 'test' };
function run(args, expected = 0, overrides = {}) {
  const result = spawnSync(process.execPath, args, { env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(result.status, expected, result.stdout + result.stderr);
}
const backfill = () => run([resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/backfill-integration-credentials.ts']);
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  run([resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy']);
  const client = new pg.Client({ connectionString: url.href }); await client.connect();
  try {
    const org = randomUUID();
    await client.query("INSERT INTO organizations(id,name,slug,updated_at) VALUES($1::uuid,'Synthetic',$1::text,now())", [org]);
    await client.query("INSERT INTO experiment_settings(id,organization_id,ai_api_key,ai_base_url,updated_at) VALUES($1,$2,'synthetic-key','https://example.invalid/secret',now())", [randomUUID(), org]);
    await client.query(`INSERT INTO notification_webhooks(id,organization_id,name,type,config,updated_at)
      SELECT gen_random_uuid(),$1,'Synthetic','GENERIC','{"url":"https://example.invalid/token","unknown":[1,null]}'::jsonb,now() FROM generate_series(1,1002)`, [org]);
    backfill();
    let state = JSON.parse(await readFile(env.INTEGRATION_BACKFILL_CHECKPOINT, 'utf8'));
    assert.equal(state.processed, 1000); assert.equal(state.table, 1);
    const first = await client.query('SELECT id, credentials_encrypted FROM notification_webhooks WHERE credentials_encrypted IS NOT NULL LIMIT 1');
    // Resume an interrupted bounded invocation, without overwriting prior ciphertext.
    backfill();
    state = JSON.parse(await readFile(env.INTEGRATION_BACKFILL_CHECKPOINT, 'utf8'));
    assert.equal(state.processed, 1003); assert.equal(state.conflicts, 0); assert.equal(state.table, 2);
    assert.equal((await client.query('SELECT credentials_encrypted FROM notification_webhooks WHERE id=$1', [first.rows[0].id])).rows[0].credentials_encrypted, first.rows[0].credentials_encrypted);
    await assert.rejects(client.query("UPDATE notification_webhooks SET config='{}' WHERE id=$1", [first.rows[0].id]), /Coordinated/);
    await assert.rejects(client.query("UPDATE experiment_settings SET ai_api_key='stale' WHERE organization_id=$1", [org]), /Coordinated/);
    run([resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/backfill-integration-credentials.ts'], 1, { INTEGRATION_CREDENTIAL_ACTIVE_KEY: 'changed' });
    // Full reconciliation authenticates every populated row and preserves ciphertext.
    await rm(env.INTEGRATION_BACKFILL_CHECKPOINT); backfill(); backfill();
    state = JSON.parse(await readFile(env.INTEGRATION_BACKFILL_CHECKPOINT, 'utf8'));
    assert.equal(state.conflicts, 0); assert.equal(state.table, 2);
    await client.query("UPDATE notification_webhooks SET credentials_encrypted='corrupt' WHERE id=$1", [first.rows[0].id]);
    await rm(env.INTEGRATION_BACKFILL_CHECKPOINT);
    run([resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/backfill-integration-credentials.ts'], 1);
    console.log('Synthetic backfill/resume/reconciliation, legacy-writer guards and corruption rejection passed');
  } finally { await client.end(); }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
  await rm(temporary, { recursive: true, force: true });
}
