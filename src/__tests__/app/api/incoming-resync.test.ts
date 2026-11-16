jest.mock('@/lib/db/prisma', () => ({ prisma: { emailAccount: { findFirst: jest.fn() } } }));
jest.mock('@/lib/auth/middleware', () => ({
  requireAdmin: jest.fn(() => null),
  authenticate: jest.fn().mockResolvedValue({ userId: 'synthetic-user', organizationId: 'synthetic-org', role: 'admin' }),
  apiResponse: (body: unknown) => Response.json(body),
  apiError: (error: string, status: number) => Response.json({ error }, { status }),
}));
jest.mock('@/lib/accounts/access', () => ({ accountAccessWhere: (_auth: unknown, id: string) => ({ id, organizationId: 'synthetic-org' }) }));
jest.mock('@/lib/email/incoming-rejections', () => ({ clearIncomingRejections: jest.fn() }));
jest.mock('@/lib/queue/client', () => ({ getSyncQueue: jest.fn() }));
import { requireAdmin } from '@/lib/auth/middleware';
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
it('enqueues a deduplicated authorized resync with a worker reset', async () => {
  (prisma.emailAccount.findFirst as jest.Mock).mockResolvedValue({ id: 'synthetic-account', workerPartition: 'synthetic-partition' });
  const add = jest.fn();
  (getSyncQueue as jest.Mock).mockReturnValue({ add });
  await POST(new NextRequest('http://localhost'), { params: Promise.resolve({ id: 'synthetic-account' }) });
  expect(clearIncomingRejections).not.toHaveBeenCalled();
  expect(getSyncQueue).toHaveBeenCalledWith('synthetic-partition');
  expect(add).toHaveBeenCalledWith('initial-sync', expect.objectContaining({ accountId: 'synthetic-account', resetIncoming: true }), expect.objectContaining({ jobId: 'resync-synthetic-account' }));
});

it('does not reset suppression if enqueue fails', async () => {
  (prisma.emailAccount.findFirst as jest.Mock).mockResolvedValue({ workerPartition: 'synthetic-partition' });
  (getSyncQueue as jest.Mock).mockReturnValue({ add: jest.fn().mockRejectedValue(new Error('queue unavailable')) });
  await expect(POST(new NextRequest('http://localhost'), { params: Promise.resolve({ id: 'synthetic-account' }) })).rejects.toThrow('queue unavailable');
  expect(clearIncomingRejections).not.toHaveBeenCalled();
});

it('denies non-admin callers before looking up the account', async () => {
  (requireAdmin as jest.Mock).mockReturnValueOnce(Response.json({ error: 'Forbidden' }, { status: 403 }));
  expect((await POST(new NextRequest('http://localhost'), { params: Promise.resolve({ id: 'synthetic-account' }) })).status).toBe(403);
  expect(prisma.emailAccount.findFirst).not.toHaveBeenCalled();
  expect(getSyncQueue).not.toHaveBeenCalled();
});
