// Explicit opt-in to a local disposable server; never reads DATABASE_URL.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createCipheriv } from 'node:crypto';
const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), Buffer.alloc(12, 3));
const encrypted = Buffer.concat([cipher.update('synthetic-mail-password', 'utf8'), cipher.final()]);
const legacyCiphertext = `${Buffer.alloc(12, 3).toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { pathToFileURL } from 'node:url';

const server = new URL(process.env.CREDENTIAL_STORAGE_TEST_SERVER_URL ?? 'invalid:');
assert(['localhost', '127.0.0.1', '[::1]'].includes(server.hostname), 'Explicit local test server required');
const migration = '20261112120000_prepare_protected_integration_credentials';
const root = process.cwd();
const cli = resolve('node_modules/prisma/build/index.js');
const temporary = await mkdtemp(join(root, 'node_modules', '.credential-validation-'));
const admin = new pg.Client({ connectionString: server.href });
const databases = [];
function deploy(url, config) {
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy', '--config', config], {
    cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
try {
  await admin.connect();
  await cp('prisma', join(temporary, 'prisma'), { recursive: true });
  await rm(join(temporary, 'prisma/migrations', migration), { recursive: true });
  const config = join(temporary, 'prisma.config.ts');
  await writeFile(config, `import { defineConfig } from 'prisma/config';
export default defineConfig({schema: ${JSON.stringify(join(temporary, 'prisma/schema.prisma'))},
 migrations: {path: ${JSON.stringify(join(temporary, 'prisma/migrations'))}},
 datasource: {url: process.env.DATABASE_URL}});`);
  // Generate the pre-change client to exercise actual legacy Prisma reads/writes.
  const legacySchema = join(temporary, 'prisma/schema.prisma');
  const legacyOutput = join(temporary, 'legacy-client');
  await writeFile(legacySchema, (await readFile(legacySchema, 'utf8'))
    .replace(/^.*credentials(?:Encrypted|FormatVersion|KeyVersion).*\n/gm, '')
    .replace('provider = "prisma-client-js"', `provider = "prisma-client-js"\n  output = ${JSON.stringify(legacyOutput)}`));
  const generation = spawnSync(process.execPath, [cli, 'generate', '--config', config], { encoding: 'utf8' });
  assert.equal(generation.status, 0, generation.stdout + generation.stderr);
  const { PrismaClient } = await import(pathToFileURL(join(legacyOutput, 'index.js')).href);
  for (const mode of ['fresh', 'upgrade']) {
    const name = `credential_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const url = new URL(server); url.pathname = `/${name}`;
    if (mode === 'upgrade') deploy(url.href, config);
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    try {
      const org = randomUUID(), setting = randomUUID(), user = randomUUID();
      const configs = [
        { botToken: 'synthetic-bot-token', chatId: 'synthetic-chat' },
        { webhookUrl: 'https://example.invalid/hook?key=synthetic' },
        { url: 'https://synthetic:password@example.invalid/token?key=synthetic#secret', headers: { Authorization: 'Bearer synthetic', Cookie: 'synthetic=1', 'X-Custom': 'synthetic' }, secret: 'synthetic-signing-secret', futureField: 'preserve' },
      ];
      async function seed() {
        await client.query(`INSERT INTO organizations(id,name,slug,updated_at) VALUES($1::uuid,'Synthetic',$1::text,now())`, [org]);
        await client.query(`INSERT INTO experiment_settings(id,organization_id,ai_api_key,ai_base_url,updated_at) VALUES($1,$2,'synthetic-ai-key','https://example.invalid/private?key=synthetic',now())`, [setting, org]);
        await client.query(`INSERT INTO users(id,email,name,password_hash,updated_at) VALUES($1,'fixture@example.invalid','Synthetic','synthetic-hash',now())`, [user]);
        await client.query(`INSERT INTO organization_members(organization_id,user_id) VALUES($1,$2)`, [org, user]);
        await client.query(`INSERT INTO email_accounts(id,organization_id,owner_user_id,label,email_address,provider,password_encrypted,oauth_access_token,oauth_refresh_token,updated_at) VALUES($1,$2,$3,'Synthetic','mail@example.invalid','imap',$4,$4,$4,now())`, [randomUUID(), org, user, legacyCiphertext]);
        for (const [i, type] of ['TELEGRAM', 'WECOM', 'GENERIC'].entries()) {
          await client.query(`INSERT INTO notification_webhooks(id,organization_id,name,type,config,updated_at) VALUES($1,$2,$3,$3,$4,now())`, [randomUUID(), org, type, configs[i]]);
        }
      }
      async function snapshot() {
        return (await client.query(`SELECT id, organization_id, ai_api_key, ai_base_url, updated_at FROM experiment_settings ORDER BY id`)).rows
          .concat((await client.query(`SELECT id, organization_id, config, updated_at FROM notification_webhooks ORDER BY id`)).rows)
          .concat((await client.query(`SELECT * FROM email_accounts ORDER BY id`)).rows);
      }
      let before;
      if (mode === 'upgrade') { await seed(); before = await snapshot(); }
      deploy(url.href, resolve('prisma.config.ts'));
      if (mode === 'fresh') { await seed(); before = await snapshot(); }
      assert.deepEqual(await snapshot(), before, 'Legacy data preserved');
      for (const table of ['experiment_settings', 'notification_webhooks']) {
        assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE credentials_encrypted IS NOT NULL OR credentials_format_version IS NOT NULL OR credentials_key_version IS NOT NULL`)).rows[0].n, 0);
        // Existing SQL writers can still update their original columns.
        const field = table === 'experiment_settings' ? 'ai_api_key' : 'config';
        await client.query(`UPDATE ${table} SET ${field}=${field}, updated_at=now()`);
        await assert.rejects(client.query(`UPDATE ${table} SET credentials_format_version=1`), { code: '23514' });
        await client.query(`UPDATE ${table} SET credentials_encrypted='synthetic-ciphertext', credentials_format_version=1, credentials_key_version='synthetic-key-v1'`);
        await assert.rejects(client.query(`UPDATE ${table} SET credentials_key_version=NULL`), { code: '23514' });
        await assert.rejects(client.query(`UPDATE ${table} SET credentials_format_version=0`), { code: '23514' });
        await assert.rejects(client.query(`UPDATE ${table} SET credentials_encrypted=''`), { code: '23514' });
      }
      const legacy = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
      try {
        assert.equal((await legacy.experimentSetting.findUniqueOrThrow({ where: { id: setting } })).aiApiKey, 'synthetic-ai-key');
        await legacy.experimentSetting.update({ where: { id: setting }, data: { aiApiKey: 'synthetic-ai-key' } });
        const hooks = await legacy.notificationWebhook.findMany({ where: { organizationId: org } });
        assert.equal(hooks.length, 3);
        for (const hook of hooks) await legacy.notificationWebhook.update({ where: { id: hook.id }, data: { config: hook.config } });
        assert.equal((await legacy.emailAccount.findFirstOrThrow()).passwordEncrypted, legacyCiphertext);
      } finally { await legacy.$disconnect(); }
      const populated = await snapshot();
      deploy(url.href, resolve('prisma.config.ts'));
      assert.deepEqual(await snapshot(), populated, 'Idempotent deploy preserves legacy data');
      for (const table of ['experiment_settings', 'notification_webhooks']) {
        assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE credentials_encrypted='synthetic-ciphertext' AND credentials_format_version=1 AND credentials_key_version='synthetic-key-v1'`)).rows[0].n, table === 'experiment_settings' ? 1 : 3);
      }
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [migration])).rows[0].n, 1);
      console.log(`PASS: ${mode}, legacy reads/writes, optional tuples, constraints, idempotent deploy`);
    } finally { await client.end(); }
  }
} finally {
  for (const name of databases) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  await rm(temporary, { recursive: true, force: true });
}
