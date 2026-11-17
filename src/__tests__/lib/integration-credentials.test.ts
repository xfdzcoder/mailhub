import { protectCredentials, readAiCredentials, readWebhookCredentials, publicAiSettings, publicWebhook } from '@/lib/integrations/credentials';
const identity = { id: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002' };
const legacy = { ...identity, aiApiKey: 'synthetic-secret', aiBaseUrl: 'https://example.test/path?token=secret' };
const original = { ...process.env };
afterAll(() => { process.env = original; });
beforeEach(() => {
  process.env.INTEGRATION_CREDENTIAL_KEYS = JSON.stringify({ old: Buffer.alloc(32, 1).toString('base64'), current: Buffer.alloc(32, 2).toString('base64') });
  process.env.INTEGRATION_CREDENTIAL_ACTIVE_KEY = 'old';
});
test('legacy and absent values remain deliberate; public settings are write-only', () => {
  expect(readAiCredentials(legacy).aiApiKey).toBe(legacy.aiApiKey);
  expect(publicAiSettings(legacy)).toEqual({ ...identity, hasApiKey: true, hasBaseUrl: true, aiApiKeyMasked: '' });
  const empty = { aiApiKey: null, aiBaseUrl: '' };
  expect(readAiCredentials({ ...legacy, ...protectCredentials('experiment_settings', identity, empty) })).toEqual(empty);
});
test('fresh nonces and retained keys support active key changes', () => {
  const first = protectCredentials('experiment_settings', identity, legacy);
  expect(protectCredentials('experiment_settings', identity, legacy).credentialsEncrypted).not.toBe(first.credentialsEncrypted);
  process.env.INTEGRATION_CREDENTIAL_ACTIVE_KEY = 'current';
  expect(readAiCredentials({ ...legacy, ...first }).aiApiKey).toBe(legacy.aiApiKey);
  expect(protectCredentials('experiment_settings', identity, legacy).credentialsKeyVersion).toBe('current');
});
test('rejects tampering, substitution, unknown formats, missing keys and partial tuples without fallback', () => {
  const row = { ...legacy, ...protectCredentials('experiment_settings', identity, legacy) };
  for (const change of [
    { id: identity.organizationId }, { organizationId: identity.id },
    { credentialsKeyVersion: 'current' }, { credentialsKeyVersion: 'missing' },
    { credentialsFormatVersion: 2 }, { credentialsEncrypted: 'broken' },
    { credentialsEncrypted: null }, { credentialsFormatVersion: null },
  ]) expect(() => readAiCredentials({ ...row, ...change })).toThrow('Integration credentials are unavailable');
  expect(() => readWebhookCredentials({ ...row, config: {} })).toThrow();
});
test('whole webhook JSON including unknown fields survives and stays out of responses', () => {
  const config = { url: 'https://user:pass@example.test/path?key=secret#token', headers: { Cookie: 'secret' }, future: [1, null] };
  const row = { ...identity, config, ...protectCredentials('notification_webhooks', identity, { config }) };
  expect(readWebhookCredentials(row)).toEqual(config);
  expect(publicWebhook(row)).toEqual({ ...identity, hasConfig: true });
});
