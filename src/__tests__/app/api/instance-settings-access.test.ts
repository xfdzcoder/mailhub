jest.mock('@/lib/auth/middleware', () => ({
  authenticate: jest.fn(),
  apiResponse: (data: unknown) => Response.json(data),
  apiError: (message: string, status: number) => Response.json({ error: message }, { status }),
}));
jest.mock('@/lib/db/prisma', () => ({ prisma: {
  organizationMember: { findUnique: jest.fn() },
  $transaction: jest.fn(),
} }));
jest.mock('@/lib/settings/system-preferences', () => ({
  getSystemPreferences: jest.fn(),
  SYSTEM_PREFERENCE_ID: 'global',
  systemPreferenceSelect: { isAiEnabled: true, semanticSearchEnabled: true },
}));
jest.mock('@/lib/search/meilisearch', () => ({ configureEmailEmbedder: jest.fn() }));

import type { NextRequest } from 'next/server';
import { GET, PUT } from '@/app/api/settings/system-preferences/route';
import { authenticate } from '@/lib/auth/middleware';
import { prisma } from '@/lib/db/prisma';
import { getSystemPreferences } from '@/lib/settings/system-preferences';

const operatorId = '11111111-1111-4111-8111-111111111111';
const tenantAdminId = '22222222-2222-4222-8222-222222222222';
const priorConfig = process.env.INSTANCE_ADMIN_USER_IDS;
function request() {
  return new Request('http://localhost/api/settings/system-preferences', {
    method: 'PUT', body: JSON.stringify({ isAiEnabled: false }),
  }) as NextRequest;
}
function auth(userId = operatorId, organizationId = 'org-a') {
  (authenticate as jest.Mock).mockResolvedValue({ userId, organizationId, role: 'admin' });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.INSTANCE_ADMIN_USER_IDS;
  auth();
  (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue({ role: 'admin' });
  (getSystemPreferences as jest.Mock).mockResolvedValue({ isAiEnabled: true, semanticSearchEnabled: false });
});
afterAll(() => {
  if (priorConfig === undefined) delete process.env.INSTANCE_ADMIN_USER_IDS;
  else process.env.INSTANCE_ADMIN_USER_IDS = priorConfig;
});

it.each(['GET', 'PUT'] as const)('denies %s when no instance administrators are provisioned', async method => {
  const response = await (method === 'GET' ? GET : PUT)(request());
  expect(response.status).toBe(403);
  expect(getSystemPreferences).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it.each(['org-a', 'org-b'])('does not grant instance access to an unlisted administrator in %s', async org => {
  process.env.INSTANCE_ADMIN_USER_IDS = operatorId;
  auth(tenantAdminId, org);
  expect((await GET(request())).status).toBe(403);
  expect((await PUT(request())).status).toBe(403);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it('requires current membership even when the JWT role and allowlist permit the caller', async () => {
  process.env.INSTANCE_ADMIN_USER_IDS = operatorId;
  (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue(null);
  expect((await GET(request())).status).toBe(403);
  (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue({ role: 'member' });
  expect((await PUT(request())).status).toBe(403);
});
it('matches entire configured IDs, never substrings or wildcards', async () => {
  for (const config of ['*', operatorId.slice(0, -1), `${operatorId}-extra`]) {
    process.env.INSTANCE_ADMIN_USER_IDS = config;
    expect((await GET(request())).status).toBe(403);
  }
});
it('allows a provisioned current administrator to read preferences', async () => {
  process.env.INSTANCE_ADMIN_USER_IDS = ` ${tenantAdminId}, ${operatorId} `;
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ isAiEnabled: true, semanticSearchEnabled: false });
  expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
    where: { organizationId_userId: { organizationId: 'org-a', userId: operatorId } },
    select: { role: true },
  });
});
it('allows a provisioned current administrator to update the existing singleton', async () => {
  process.env.INSTANCE_ADMIN_USER_IDS = operatorId;
  const update = jest.fn().mockResolvedValue({ isAiEnabled: false, semanticSearchEnabled: false });
  (prisma.$transaction as jest.Mock).mockImplementation(async callback => callback({
    $queryRaw: jest.fn(),
    systemPreference: { upsert: jest.fn(), findUniqueOrThrow: jest.fn().mockResolvedValue({
      isAiEnabled: true, semanticSearchEnabled: false,
    }), update },
  }));
  expect((await PUT(request())).status).toBe(200);
  expect(update).toHaveBeenCalledWith({ where: { id: 'global' }, data: { isAiEnabled: false },
    select: { isAiEnabled: true, semanticSearchEnabled: true } });
});
it('preserves authentication errors before instance authorization', async () => {
  (authenticate as jest.Mock).mockResolvedValue(Response.json({ error: 'Authentication required' }, { status: 401 }));
  expect((await GET(request())).status).toBe(401);
  expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
});
