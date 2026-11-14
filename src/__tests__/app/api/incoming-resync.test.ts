jest.mock('@/lib/db/prisma', () => ({ prisma: { emailAccount: { findFirst: jest.fn() } } }));
jest.mock('@/lib/auth/middleware', () => ({
  authenticate: jest.fn().mockResolvedValue({ userId: 'synthetic-user', organizationId: 'synthetic-org', role: 'admin' }),
  apiResponse: (body: unknown) => Response.json(body),
  apiError: (error: string, status: number) => Response.json({ error }, { status }),
}));
jest.mock('@/lib/accounts/access', () => ({ accountAccessWhere: (_auth: unknown, id: string) => ({ id, organizationId: 'synthetic-org' }) }));
jest.mock('@/lib/email/incoming-rejections', () => ({ clearIncomingRejections: jest.fn() }));
jest.mock('@/lib/queue/client', () => ({ getSyncQueue: jest.fn() }));
import { POST } from '@/app/api/accounts/[id]/sync/route';
import { prisma } from '@/lib/db/prisma';
import { clearIncomingRejections } from '@/lib/email/incoming-rejections';
import { getSyncQueue } from '@/lib/queue/client';
import { NextRequest } from 'next/server';

beforeEach(() => jest.clearAllMocks());
it('denies inaccessible accounts before clearing or enqueueing', async () => {
  (prisma.emailAccount.findFirst as jest.Mock).mockResolvedValue(null);
  expect((await POST(new NextRequest('http://localhost'), { params: Promise.resolve({ id: 'other-account' }) })).status).toBe(404);
  expect(clearIncomingRejections).not.toHaveBeenCalled();
  expect(getSyncQueue).not.toHaveBeenCalled();
});
it('clears authorized suppression before enqueueing a distinct resync', async () => {
  (prisma.emailAccount.findFirst as jest.Mock).mockResolvedValue({ id: 'synthetic-account', workerPartition: 'synthetic-partition' });
  const add = jest.fn();
  (getSyncQueue as jest.Mock).mockReturnValue({ add });
  await POST(new NextRequest('http://localhost'), { params: Promise.resolve({ id: 'synthetic-account' }) });
  expect(clearIncomingRejections).toHaveBeenCalledWith('synthetic-account');
  expect(getSyncQueue).toHaveBeenCalledWith('synthetic-partition');
  expect(add).toHaveBeenCalledWith('initial-sync', expect.objectContaining({ accountId: 'synthetic-account' }), expect.objectContaining({ jobId: expect.stringMatching(/^resync-synthetic-account-/) }));
});
