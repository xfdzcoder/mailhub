/** Explicit operator invocation only. Never runs on startup. */
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { protectCredentials, readAiCredentials, readWebhookCredentials } from '../src/lib/integrations/credentials';

type Checkpoint = { database: string; key: string; format: number; registryFingerprint: string; table: number; last: string; upper: string; processed: number; conflicts: number };
const tables = ['experiment_settings', 'notification_webhooks'] as const;
async function main() {
  const url = process.env.INTEGRATION_BACKFILL_DATABASE_URL;
  const path = process.env.INTEGRATION_BACKFILL_CHECKPOINT;
  const key = process.env.INTEGRATION_CREDENTIAL_ACTIVE_KEY;
  if (!url || !path || !key || process.env.INTEGRATION_BACKFILL_COORDINATED !== 'yes') throw new Error('Explicit database, checkpoint, key and coordinated-writer acknowledgement required');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS db, (SELECT oid FROM pg_database WHERE datname=current_database()) AS oid');
    const database = JSON.stringify([new URL(url).host, identity.rows[0]]);
    const migration = await client.query("SELECT 1 FROM _prisma_migrations WHERE migration_name='20261115000000_guard_protected_credentials' AND finished_at IS NOT NULL AND rolled_back_at IS NULL");
    if (!migration.rowCount) throw new Error('Coordinated writer migration required');
    const synthetic = { id: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002', aiApiKey: null, aiBaseUrl: '' };
    readAiCredentials({ ...synthetic, ...protectCredentials('experiment_settings', synthetic, synthetic) });
    const registry = JSON.parse(process.env.INTEGRATION_CREDENTIAL_KEYS || '{}');
    const registryFingerprint = createHash('sha256').update(JSON.stringify(Object.entries(registry).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
    let state: Checkpoint = { database, key, format: 1, registryFingerprint, table: 0, last: '', upper: '', processed: 0, conflicts: 0 };
    try { state = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (state.database !== database || state.key !== key || state.format !== 1 || state.registryFingerprint !== registryFingerprint) throw new Error('Checkpoint identity or key changed');
    const save = async () => { await writeFile(path + '.tmp', JSON.stringify(state), { mode: 0o600 }); await rename(path + '.tmp', path); };
    const started = Date.now();
    let count = 0;
    while (state.table < tables.length && count < 1000 && Date.now() - started < 30000) {
      const table = tables[state.table];
      if (!state.upper) {
        state.upper = (await client.query(`SELECT max(id::text) AS id FROM ${table}`)).rows[0].id || '';
        await save();
      }
      const rows = state.upper ? (await client.query(`SELECT to_jsonb(target) AS snapshot FROM ${table} AS target WHERE id::text > $1 AND id::text <= $2 ORDER BY id::text LIMIT $3`, [state.last, state.upper, Math.min(100, 1000 - count)])).rows : [];
      if (!rows.length) { state.table++; state.last = ''; state.upper = ''; await save(); continue; }
      for (const entry of rows) {
        const source = entry.snapshot;
        const row = { id: source.id, organizationId: source.organization_id, aiApiKey: source.ai_api_key, aiBaseUrl: source.ai_base_url, config: source.config,
          credentialsEncrypted: source.credentials_encrypted, credentialsFormatVersion: source.credentials_format_version, credentialsKeyVersion: source.credentials_key_version };
        const payload = table === 'experiment_settings' ? { aiApiKey: row.aiApiKey, aiBaseUrl: row.aiBaseUrl } : { config: row.config };
        if ([row.credentialsEncrypted, row.credentialsFormatVersion, row.credentialsKeyVersion].some(v => v != null)) {
          const recovered = table === 'experiment_settings' ? readAiCredentials(row) : { config: readWebhookCredentials(row) };
          if (!isDeepStrictEqual(recovered, payload)) throw new Error('Protected credential reconciliation failed');
        } else {
          const encrypted = protectCredentials(table, row, payload);
          // JSONB snapshot equality includes timestamp, source, tenant, type and tuple.
          const result = await client.query(`UPDATE ${table} AS target SET credentials_encrypted=$1, credentials_format_version=$2, credentials_key_version=$3 WHERE id=$4 AND to_jsonb(target)=$5::jsonb`, [encrypted.credentialsEncrypted, encrypted.credentialsFormatVersion, encrypted.credentialsKeyVersion, row.id, JSON.stringify(source)]);
          if (!result.rowCount) state.conflicts++;
        }
        state.last = row.id; state.processed++; count++;
        await save(); // Each UPDATE commits before its checkpoint; replay authenticates populated rows.
      }
    }
    console.log(JSON.stringify({ ...state, database: undefined, complete: state.table === tables.length }));
  } finally { await client.end(); }
}
main().catch(() => { console.error('Credential backfill stopped; inspect configuration and reconcile before retrying'); process.exitCode = 1; });
