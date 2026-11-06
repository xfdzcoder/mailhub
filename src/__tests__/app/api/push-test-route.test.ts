jest.mock('@/lib/auth/middleware', () => ({ authenticate: jest.fn() }));
jest.mock('@/lib/db/prisma', () => ({ prisma: { pushSubscription: { findMany: jest.fn().mockResolvedValue([]) } } }));
jest.mock('@/lib/notifications/push', () => ({ sendPush: jest.fn(), reportPushFailure: jest.fn() }));
import { NextResponse, type NextRequest } from 'next/server';
import { POST } from '@/app/api/notifications/test/route';
import { authenticate } from '@/lib/auth/middleware';
import { prisma } from '@/lib/db/prisma';
it('targets only devices owned by the current caller in their organization', async () => {
  (authenticate as jest.Mock).mockResolvedValue({ userId: 'caller', organizationId: 'org' });
  await POST({} as NextRequest);
  expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({ where: { userId: 'caller', organizationId: 'org' } });
});
it('requires a currently authorized session', async () => {
  (authenticate as jest.Mock).mockResolvedValue(NextResponse.json({}, { status: 401 }));
  expect((await POST({} as NextRequest)).status).toBe(401);
});
