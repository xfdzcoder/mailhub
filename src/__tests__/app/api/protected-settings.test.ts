jest.mock('@/lib/auth/middleware', () => ({ authenticate: jest.fn(async () => ({ organizationId: 'org', role: 'admin' })), requireAdmin: jest.fn(() => null), apiResponse: (data: unknown, status = 200) => Response.json(data, { status }), apiError: (error: string, status: number) => Response.json({ error }, { status }) }));
jest.mock('@/lib/db/prisma', () => ({ prisma: { experimentSetting: { findUnique: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() }, notificationWebhook: { findMany: jest.fn(), create: jest.fn() } } }));
jest.mock('@/lib/settings/system-preferences', () => ({ getSystemPreferences: async () => ({ isAiEnabled: true }) }));
import { prisma } from '@/lib/db/prisma';
import { GET, PUT } from '@/app/api/experiments/settings/route';
import { GET as hooksGet, POST } from '@/app/api/experiments/webhooks/route';
import { readAiCredentials, readWebhookCredentials } from '@/lib/integrations/credentials';
import type { NextRequest } from 'next/server';
const row = { id: 'row', organizationId: 'org', aiApiKey: 'synthetic-secret', aiBaseUrl: 'https://example.test/secret', updatedAt: new Date(), credentialsEncrypted: null };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.INTEGRATION_CREDENTIAL_KEYS = JSON.stringify({ test: Buffer.alloc(32, 1).toString('base64') });
  process.env.INTEGRATION_CREDENTIAL_ACTIVE_KEY = 'test';
  (prisma.experimentSetting.findUnique as jest.Mock).mockResolvedValue(row);
});
const req = (body: unknown) => new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body) }) as NextRequest;
test('AI settings response hides legacy secrets and storage fields', async () => {
  const response = await (await GET(req({}))).json();
  expect(response.hasApiKey).toBe(true);
  expect(JSON.stringify(response)).not.toMatch(/synthetic-secret|example.test|credentialsEncrypted/);
});
test('ordinary settings edits preserve and encrypt both secrets atomically', async () => {
  (prisma.experimentSetting.updateMany as jest.Mock).mockImplementation(async ({ data }) => {
    (prisma.experimentSetting.findUniqueOrThrow as jest.Mock).mockResolvedValue({ ...row, ...data }); return { count: 1 };
  });
  expect((await PUT(req({ aiModelName: 'test-model' }))).status).toBe(200);
  const data = (prisma.experimentSetting.updateMany as jest.Mock).mock.calls[0][0].data;
  expect(data.aiApiKey).toBeNull();
  expect(data.aiBaseUrl).toBeNull();
  expect(readAiCredentials({ ...row, ...data })).toEqual({ aiApiKey: row.aiApiKey, aiBaseUrl: row.aiBaseUrl });
});
test('concurrent change returns conflict and invalid protected data never falls back', async () => {
  (prisma.experimentSetting.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
  expect((await PUT(req({ isAiEnabled: false }))).status).toBe(409);
  (prisma.experimentSetting.findUnique as jest.Mock).mockResolvedValue({ ...row, credentialsEncrypted: 'corrupt', credentialsFormatVersion: 1, credentialsKeyVersion: 'test' });
  expect((await PUT(req({ aiApiKey: 'replacement' }))).status).toBe(500);
});
test('webhook create encrypts unknown properties and responses are write-only', async () => {
  const config = { url: 'https://example.test/secret', future: 'synthetic-secret' };
  (prisma.notificationWebhook.create as jest.Mock).mockImplementation(async ({ data }) => data);
  const response = await POST(req({ name: 'Test', type: 'GENERIC', config }));
  expect(response.status).toBe(201);
  expect(JSON.stringify(await response.json())).not.toMatch(/synthetic-secret|example.test|credentialsEncrypted/);
  const data = (prisma.notificationWebhook.create as jest.Mock).mock.calls[0][0].data;
  expect(data.config).toEqual({});
  expect(readWebhookCredentials(data)).toEqual(config);
  (prisma.notificationWebhook.findMany as jest.Mock).mockResolvedValue([data]);
  expect(JSON.stringify(await (await hooksGet(req({}))).json())).not.toMatch(/synthetic-secret|example.test|credentialsEncrypted/);
});
