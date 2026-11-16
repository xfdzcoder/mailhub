// Synthetic fixtures only: explicit loopback server; unique disposable database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
    // Prisma's historical writers store timestamps at JavaScript millisecond precision.
    await client.query("INSERT INTO experiment_settings(id,organization_id,ai_api_key,ai_base_url,updated_at) VALUES($1,$2,'synthetic-key','https://example.invalid/secret',date_trunc('milliseconds',now()))", [randomUUID(), org]);
    await client.query(`INSERT INTO notification_webhooks(id,organization_id,name,type,config,updated_at)
      SELECT gen_random_uuid(),$1,'Synthetic','GENERIC','{"url":"https://example.invalid/token","unknown":[1,null]}'::jsonb,now() FROM generate_series(1,1002)`, [org]);
    // Invoke the real route handlers with real auth, Prisma and PostgreSQL.
    // Only synthetic data is used; no database or authentication mocks.
    const routeCheck = resolve('node_modules', '.credential-routes-' + name + '.ts');
    await writeFile(routeCheck, `
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../src/lib/db/prisma';
import { createSession } from '../src/lib/auth/sessions';
import { GET, PUT } from '../src/app/api/experiments/settings/route';
import { GET as hooksGet, POST } from '../src/app/api/experiments/webhooks/route';
import { readAiCredentials, readWebhookCredentials } from '../src/lib/integrations/credentials';
async function main() {
  const org = ${JSON.stringify(org)};
  const user = await prisma.user.create({ data: { email: 'fixture@example.invalid', name: 'Synthetic', passwordHash: 'synthetic' } });
  await prisma.organizationMember.create({ data: { organizationId: org, userId: user.id, role: 'admin' } });
  const { token } = await createSession({ userId: user.id, organizationId: org, role: 'admin' }, 'synthetic');
  const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/experiments/settings', {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const get = await GET(req('GET'));
  assert.equal(get.status, 200);
  assert.equal((await get.json()).hasApiKey, true);
  const old = await prisma.experimentSetting.findUniqueOrThrow({ where: { organizationId: org } });
  assert.equal(readAiCredentials(old).aiApiKey, 'synthetic-key');
  const legacyHook = await prisma.notificationWebhook.findFirstOrThrow({ where: { organizationId: org } });
  assert.equal((readWebhookCredentials(legacyHook) as { url: string }).url, 'https://example.invalid/token');
  assert.equal((await hooksGet(req('GET'))).status, 200);
  // A non-secret edit upgrades legacy credentials and clears their old columns.
  assert.equal((await PUT(req('PUT', { aiModelName: 'synthetic-model' }))).status, 200);
  let row = await prisma.experimentSetting.findUniqueOrThrow({ where: { organizationId: org } });
  assert.equal(row.aiApiKey, null); assert.equal(row.aiBaseUrl, null);
  assert.equal(readAiCredentials(row).aiApiKey, 'synthetic-key');
  assert.equal((await PUT(req('PUT', { aiApiKey: 'new-synthetic-key' }))).status, 200);
  assert.equal((await PUT(req('PUT', { isAiEnabled: false }))).status, 200);
  row = await prisma.experimentSetting.findUniqueOrThrow({ where: { organizationId: org } });
  assert.deepEqual(readAiCredentials(row), { aiApiKey: 'new-synthetic-key', aiBaseUrl: 'https://example.invalid/secret' });
  assert.equal(row.aiApiKey, null); assert.equal(row.aiBaseUrl, null);
  const config = { url: 'https://example.invalid/new-token', unknown: [1, null] };
  const response = await POST(req('POST', { name: 'Encrypted-only', type: 'GENERIC', config }));
  assert.equal(response.status, 201);
  const publicHook = await response.json();
  const hook = await prisma.notificationWebhook.findUniqueOrThrow({ where: { id: publicHook.id } });
  assert.deepEqual(hook.config, {}); assert.deepEqual(readWebhookCredentials(hook), config);
  const settings = await (await GET(req('GET'))).json();
  assert.equal(settings.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify([settings, publicHook, await (await hooksGet(req('GET'))).json()]), /new-synthetic-key|example.invalid|credentialsEncrypted/);
  // Missing keys fail closed, leaving the last valid ciphertext intact.
  const saved = process.env.INTEGRATION_CREDENTIAL_KEYS;
  process.env.INTEGRATION_CREDENTIAL_KEYS = '{}';
  assert.equal((await PUT(req('PUT', { aiApiKey: 'must-not-persist' }))).status, 500);
  process.env.INTEGRATION_CREDENTIAL_KEYS = saved;
  assert.equal((await prisma.experimentSetting.findUniqueOrThrow({ where: { id: row.id } })).credentialsEncrypted, row.credentialsEncrypted);
  const freshOrg = await prisma.organization.create({ data: { name: 'Synthetic fresh', slug: randomUUID() } });
  await prisma.organizationMember.create({ data: { organizationId: freshOrg.id, userId: user.id, role: 'admin' } });
  const freshSession = await createSession({ userId: user.id, organizationId: freshOrg.id, role: 'admin' }, 'synthetic');
  const freshReq = (method: string, body?: unknown) => {
    const request = req(method, body);
    request.headers.set('authorization', 'Bearer ' + freshSession.token);
    return request;
  };
  assert.equal((await GET(freshReq('GET'))).status, 200);
  let fresh = await prisma.experimentSetting.findUniqueOrThrow({ where: { organizationId: freshOrg.id } });
  assert.ok(fresh.credentialsEncrypted);
  assert.deepEqual(readAiCredentials(fresh), { aiApiKey: null, aiBaseUrl: null });
  // Exercise PUT creation separately from GET's lazy default creation.
  await prisma.experimentSetting.delete({ where: { id: fresh.id } });
  assert.equal((await PUT(freshReq('PUT', { aiApiKey: 'fresh-synthetic', aiBaseUrl: '' }))).status, 200);
  fresh = await prisma.experimentSetting.findUniqueOrThrow({ where: { organizationId: freshOrg.id } });
  assert.equal(fresh.aiApiKey, null); assert.equal(fresh.aiBaseUrl, null);
  assert.deepEqual(readAiCredentials(fresh), { aiApiKey: 'fresh-synthetic', aiBaseUrl: '' });
  assert.equal((await PUT(freshReq('PUT', { aiApiKey: null }))).status, 200);
  fresh = await prisma.experimentSetting.findUniqueOrThrow({ where: { id: fresh.id } });
  assert.deepEqual(readAiCredentials(fresh), { aiApiKey: null, aiBaseUrl: '' });
  await prisma.organization.delete({ where: { id: freshOrg.id } });
  console.log('Actual authenticated settings paths: legacy reads, encrypted-only writes, partial edits and fail-closed writes passed');
}
main().then(async () => { await prisma.$disconnect(); process.exit(0); }, async error => { console.error(error); await prisma.$disconnect(); process.exit(1); });
`);
    try { run([resolve('node_modules/tsx/dist/cli.mjs'), routeCheck], 0, { JWT_SECRET: 'synthetic-disposable-test-secret' }); }
    finally { await rm(routeCheck, { force: true }); }
    backfill();
    let state = JSON.parse(await readFile(env.INTEGRATION_BACKFILL_CHECKPOINT, 'utf8'));
    assert.equal(state.processed, 1000); assert.equal(state.table, 1);
    const first = await client.query('SELECT id, credentials_encrypted FROM notification_webhooks WHERE credentials_encrypted IS NOT NULL LIMIT 1');
    // Resume an interrupted bounded invocation, without overwriting prior ciphertext.
    backfill();
    state = JSON.parse(await readFile(env.INTEGRATION_BACKFILL_CHECKPOINT, 'utf8'));
    assert.equal(state.processed, 1004); assert.equal(state.conflicts, 0); assert.equal(state.table, 2);
    assert.equal((await client.query('SELECT credentials_encrypted FROM notification_webhooks WHERE id=$1', [first.rows[0].id])).rows[0].credentials_encrypted, first.rows[0].credentials_encrypted);
    await assert.rejects(client.query("UPDATE notification_webhooks SET config='{}' WHERE id=$1", [first.rows[0].id]), /Coordinated/);
    await assert.rejects(client.query("UPDATE experiment_settings SET ai_api_key='stale' WHERE organization_id=$1", [org]), /Coordinated/);
    run([resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/backfill-integration-credentials.ts'], 1, { INTEGRATION_CREDENTIAL_ACTIVE_KEY: 'changed' });
    const protectedSnapshot = async () => (await client.query(`SELECT id, credentials_encrypted FROM experiment_settings UNION ALL SELECT id, credentials_encrypted FROM notification_webhooks ORDER BY id`)).rows;
    const beforeReconciliation = await protectedSnapshot();
    // Full reconciliation authenticates every populated row and preserves ciphertext.
    await rm(env.INTEGRATION_BACKFILL_CHECKPOINT); backfill(); backfill();
    state = JSON.parse(await readFile(env.INTEGRATION_BACKFILL_CHECKPOINT, 'utf8'));
    assert.equal(state.conflicts, 0); assert.equal(state.table, 2);
    assert.deepEqual(await protectedSnapshot(), beforeReconciliation);
    await client.query("UPDATE notification_webhooks SET credentials_encrypted='corrupt' WHERE config='{}'::jsonb");
    await rm(env.INTEGRATION_BACKFILL_CHECKPOINT);
    run([resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/backfill-integration-credentials.ts'], 1);
    console.log('Synthetic backfill/resume/reconciliation, legacy-writer guards and corruption rejection passed');
  } finally { await client.end(); }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
  await rm(temporary, { recursive: true, force: true });
}
