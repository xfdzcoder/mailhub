import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { authenticate, requireAdmin, apiResponse, apiError } from '@/lib/auth/middleware';
import { accountAccessWhere } from '@/lib/accounts/access';
import { getSyncQueue } from '@/lib/queue/client';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;
  const { id } = await params;
  const account = await prisma.emailAccount.findFirst({ where: accountAccessWhere(auth, id) });
  if (!account) return apiError('Account not found', 404);
  // A resync must survive an already-active initial-sync job with its stable ID.
  await getSyncQueue(account.workerPartition).add('initial-sync', {
    accountId: id, folder: 'ALL', resetIncoming: true, workerPartition: account.workerPartition || 'default',
  }, { jobId: `resync-${id}`, removeOnComplete: true, removeOnFail: true });
  return apiResponse({ success: true });
}
