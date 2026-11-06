jest.mock('@/lib/auth/middleware', () => ({
  authenticate: jest.fn().mockResolvedValue({ userId: 'admin', organizationId: 'org-a', role: 'admin' }),
  requireAdmin: jest.fn().mockReturnValue(null),
  apiResponse: (data: unknown) => Response.json(data),
  apiError: (error: string, status: number) => Response.json({ error }, { status }),
}));
jest.mock('@/lib/db/prisma', () => ({ prisma: {
  $transaction: jest.fn(), $queryRaw: jest.fn(),
  organizationMember: { delete: jest.fn(), update: jest.fn() },
  authSession: { updateMany: jest.fn() },
} }));
import { NextRequest } from 'next/server';
import { DELETE, PUT } from '@/app/api/org/members/[userId]/route';
import { prisma } from '@/lib/db/prisma';
const db = prisma as unknown as { $transaction: jest.Mock; $queryRaw: jest.Mock; organizationMember: { delete: jest.Mock; update: jest.Mock }; authSession: { updateMany: jest.Mock } };
const params = { params: Promise.resolve({ userId: 'member' }) };
let rows: { userId: string; organizationId: string; revokedAt: Date | null }[];
beforeEach(() => {
  jest.clearAllMocks();
  rows = [
    { userId: 'member', organizationId: 'org-a', revokedAt: null },
    { userId: 'other-user', organizationId: 'org-a', revokedAt: null },
    { userId: 'member', organizationId: 'org-b', revokedAt: null },
  ];
  db.$transaction.mockImplementation(async callback => callback(prisma));
  db.organizationMember.delete.mockResolvedValue({});
  db.organizationMember.update.mockResolvedValue({});
  db.authSession.updateMany.mockImplementation(async ({ where, data }) => {
    for (const row of rows) {
      if (row.userId === where.userId && row.organizationId === where.organizationId && row.revokedAt === null) Object.assign(row, data);
    }
  });
});
it('removes membership and revokes only that user and organization inside one transaction', async () => {
  const res = await DELETE(new NextRequest('http://localhost/api/org/members/member', { method: 'DELETE' }), params);
  expect(res.status).toBe(200);
  expect(db.$transaction).toHaveBeenCalledTimes(1);
  expect(db.$queryRaw).toHaveBeenCalledWith(expect.any(Array), 'member');
  expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.organizationMember.delete.mock.invocationCallOrder[0]);
  expect(db.organizationMember.delete).toHaveBeenCalledWith({ where: { organizationId_userId: { organizationId: 'org-a', userId: 'member' } } });
  expect(rows[0].revokedAt).toBeInstanceOf(Date);
  expect(rows[1].revokedAt).toBeNull();
  expect(rows[2].revokedAt).toBeNull();
});
it('does not report removal as successful when its revocation transaction fails', async () => {
  db.authSession.updateMany.mockRejectedValueOnce(new Error('synthetic failure'));
  expect((await DELETE(new NextRequest('http://localhost/api/org/members/member', { method: 'DELETE' }), params)).status).toBe(500);
});
it('preserves sessions when demoting a member; authorization resolves the current role', async () => {
  const res = await PUT(new NextRequest('http://localhost/api/org/members/member', { method: 'PUT', body: JSON.stringify({ role: 'member' }) }), params);
  expect(res.status).toBe(200);
  expect(db.organizationMember.update).toHaveBeenCalledWith({ where: { organizationId_userId: { organizationId: 'org-a', userId: 'member' } }, data: { role: 'member' } });
  expect(db.authSession.updateMany).not.toHaveBeenCalled();
});
