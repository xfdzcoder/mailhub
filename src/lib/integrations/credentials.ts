import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

type Identity = { id: string; organizationId: string };
type Tuple = { credentialsEncrypted?: string | null; credentialsFormatVersion?: number | null; credentialsKeyVersion?: string | null };
type Table = 'experiment_settings' | 'notification_webhooks';
export class IntegrationCredentialError extends Error {
  constructor() { super('Integration credentials are unavailable'); }
}
function key(version: string): Buffer {
  const registry = JSON.parse(process.env.INTEGRATION_CREDENTIAL_KEYS || '{}');
  const encoded = registry[version];
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new IntegrationCredentialError();
  const value = Buffer.from(encoded, 'base64');
  if (value.length !== 32) throw new IntegrationCredentialError();
  return value;
}
function aad(table: Table, row: Identity, version: string) {
  return Buffer.from(JSON.stringify(['mailhub.integration', 1, table, row.organizationId.toLowerCase(), row.id.toLowerCase(), version]));
}
export function protectCredentials(table: Table, row: Identity, payload: unknown) {
  try {
    const version = process.env.INTEGRATION_CREDENTIAL_ACTIVE_KEY;
    if (!version || version.length > 100) throw new IntegrationCredentialError();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(version), nonce);
    cipher.setAAD(aad(table, row, version));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return { credentialsEncrypted: [nonce, cipher.getAuthTag(), ciphertext].map(v => v.toString('base64')).join(':'), credentialsFormatVersion: 1, credentialsKeyVersion: version };
  } catch { throw new IntegrationCredentialError(); }
}
function recover(table: Table, row: Identity & Tuple): unknown | undefined {
  const tuple = [row.credentialsEncrypted, row.credentialsFormatVersion, row.credentialsKeyVersion];
  if (tuple.every(v => v == null)) return undefined;
  try {
    if (row.credentialsFormatVersion !== 1 || !row.credentialsKeyVersion || !row.credentialsEncrypted) throw new Error();
    const parts = row.credentialsEncrypted.split(':');
    if (parts.length !== 3 || parts.some(v => !v || Buffer.from(v, 'base64').toString('base64') !== v)) throw new Error();
    const [nonce, tag, ciphertext] = parts.map(v => Buffer.from(v, 'base64'));
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key(row.credentialsKeyVersion), nonce);
    cipher.setAAD(aad(table, row, row.credentialsKeyVersion));
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8'));
  } catch { throw new IntegrationCredentialError(); }
}
export function readAiCredentials(row: Identity & Tuple & { aiApiKey: string | null; aiBaseUrl: string | null }) {
  const value = recover('experiment_settings', row);
  if (value === undefined) return { aiApiKey: row.aiApiKey, aiBaseUrl: row.aiBaseUrl };
  const payload = value as { aiApiKey: string | null; aiBaseUrl: string | null };
  if (!payload || ![payload.aiApiKey, payload.aiBaseUrl].every(v => v === null || typeof v === 'string')) throw new IntegrationCredentialError();
  return payload;
}
export function readWebhookCredentials(row: Identity & Tuple & { config: unknown }): unknown {
  const value = recover('notification_webhooks', row);
  if (value === undefined) return row.config;
  if (!value || typeof value !== 'object' || !('config' in value)) throw new IntegrationCredentialError();
  return value.config;
}
export function publicAiSettings(row: Parameters<typeof readAiCredentials>[0]) {
  const { aiApiKey, aiBaseUrl } = readAiCredentials(row);
  const { aiApiKey: _key, aiBaseUrl: _url, credentialsEncrypted: _encrypted, credentialsKeyVersion: _version, credentialsFormatVersion: _format, ...settings } = row;
  return { ...settings, aiApiKeyMasked: '', hasApiKey: Boolean(aiApiKey), hasBaseUrl: Boolean(aiBaseUrl) };
}
export function publicWebhook(row: Identity & Tuple & { config: unknown }) {
  const { config: _config, credentialsEncrypted: _encrypted, credentialsKeyVersion: _version, credentialsFormatVersion: _format, ...webhook } = row;
  return { ...webhook, hasConfig: true };
}
