import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { authenticate, apiResponse, apiError } from '@/lib/auth/middleware';
import { accountAccessWhere } from '@/lib/accounts/access';
import { clearIncomingRejections } from '@/lib/email/incoming-rejections';
import { getSyncQueue } from '@/lib/queue/client';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const account = await prisma.emailAccount.findFirst({ where: accountAccessWhere(auth, id) });
  if (!account) return apiError('Account not found', 404);
  await clearIncomingRejections(id);
  // A resync must survive an already-active initial-sync job with its stable ID.
  await getSyncQueue(account.workerPartition).add('initial-sync', {
    accountId: id, folder: 'ALL', workerPartition: account.workerPartition || 'default',
  }, { jobId: `resync-${id}-${randomUUID()}`, removeOnComplete: true, removeOnFail: true });
  return apiResponse({ success: true });
}
