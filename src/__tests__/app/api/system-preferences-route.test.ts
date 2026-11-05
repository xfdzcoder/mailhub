jest.mock('@/lib/auth/middleware', () => ({
  authenticate: jest.fn(),
  apiResponse: (data: unknown) => Response.json(data),
  apiError: (error: string, status: number) => Response.json({ error }, { status }),
}));
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    organizationMember: { findUnique: jest.fn() },
    systemPreference: { upsert: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));
jest.mock('@/lib/search/meilisearch', () => ({ configureEmailEmbedder: jest.fn() }));

import type { NextRequest } from 'next/server';
import { GET, PUT } from '@/app/api/settings/system-preferences/route';
import { authenticate } from '@/lib/auth/middleware';
import { prisma } from '@/lib/db/prisma';
import { configureEmailEmbedder } from '@/lib/search/meilisearch';

const originalAllowlist = process.env.INSTANCE_ADMIN_USER_IDS;
const preferences = { isAiEnabled: true, semanticSearchEnabled: false };

function request(method: string) {
  return new Request('http://localhost/api/settings/system-preferences', {
    method,
    ...(method === 'PUT' ? { body: JSON.stringify({ isAiEnabled: false }) } : {}),
  }) as NextRequest;
}

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.INSTANCE_ADMIN_USER_IDS;
  (authenticate as jest.Mock).mockResolvedValue({ userId: 'admin-1', organizationId: 'org-1', role: 'admin' });
  (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue({ role: 'admin' });
  (prisma.systemPreference.upsert as jest.Mock).mockResolvedValue(preferences);
  (prisma.systemPreference.findUniqueOrThrow as jest.Mock).mockResolvedValue(preferences);
  (prisma.systemPreference.update as jest.Mock).mockResolvedValue({ ...preferences, isAiEnabled: false });
  (prisma.$transaction as jest.Mock).mockImplementation((callback) => callback(prisma));
});

afterAll(() => {
  if (originalAllowlist === undefined) delete process.env.INSTANCE_ADMIN_USER_IDS;
  else process.env.INSTANCE_ADMIN_USER_IDS = originalAllowlist;
});

for (const [method, handler] of [['GET', GET], ['PUT', PUT]] as const) {
  describe(method, () => {
    function expectNoPreferenceAccess() {
      expect(prisma.systemPreference.upsert).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(configureEmailEmbedder).not.toHaveBeenCalled();
    }

    it.each([undefined, '', ' ,  ', 'admin-10', '*', 'someone-else'])('denies unprovisioned access with allowlist %s', async (value) => {
      if (value !== undefined) process.env.INSTANCE_ADMIN_USER_IDS = value;
      expect((await handler(request(method))).status).toBe(403);
      expectNoPreferenceAccess();
    });

    it.each(['org-1', 'org-2'])('denies non-allowlisted admins in %s', async (organizationId) => {
      process.env.INSTANCE_ADMIN_USER_IDS = 'provisioned-admin';
      (authenticate as jest.Mock).mockResolvedValue({ userId: 'other-admin', organizationId, role: 'admin' });
      expect((await handler(request(method))).status).toBe(403);
      expectNoPreferenceAccess();
    });

    it.each([{ role: 'member' }, null])('denies allowlisted users without current admin membership: %s', async (membership) => {
      process.env.INSTANCE_ADMIN_USER_IDS = 'admin-1';
      (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue(membership);
      expect((await handler(request(method))).status).toBe(403);
      expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
        where: { organizationId_userId: { organizationId: 'org-1', userId: 'admin-1' } },
        select: { role: true },
      });
      expectNoPreferenceAccess();
    });

    it('requires authentication', async () => {
      (authenticate as jest.Mock).mockResolvedValue(Response.json({ error: 'Authentication required' }, { status: 401 }));
      expect((await handler(request(method))).status).toBe(401);
      expectNoPreferenceAccess();
    });

    it('allows an explicitly provisioned current administrator', async () => {
      process.env.INSTANCE_ADMIN_USER_IDS = 'other-id, admin-1 ,';
      const response = await handler(request(method));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(method === 'GET' ? preferences : { ...preferences, isAiEnabled: false });
      if (method === 'PUT') {
        expect(prisma.systemPreference.update).toHaveBeenCalledWith(expect.objectContaining({ data: { isAiEnabled: false } }));
      }
    });
  });
}
