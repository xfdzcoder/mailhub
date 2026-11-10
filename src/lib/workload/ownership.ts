import { prisma } from '@/lib/db/prisma';
import type { WorkOwner } from './admission';

/** Trusted periodic/backlog path: identifiers locate DB records, never establish ownership. */
export async function accountWorkOwner(accountId: string): Promise<WorkOwner> {
  const account = await prisma.emailAccount.findUnique({
    where: { id: accountId }, select: { ownerUserId: true, organizationId: true, isActive: true },
  });
  if (!account?.isActive) throw new Error('Work account unavailable');
  return { userId: account.ownerUserId, organizationId: account.organizationId };
}
export async function jobWorkOwner(queue: string, data: Record<string, unknown>): Promise<WorkOwner> {
  if (queue.startsWith('imap-sync') || queue === 'email-send') return accountWorkOwner(String(data.accountId));
  if (queue === 'search-index') {
    const email = await prisma.email.findUnique({ where: { id: String(data.emailId) }, select: { accountId: true } });
    if (!email) throw new Error('Work email unavailable');
    return accountWorkOwner(email.accountId);
  }
  if (queue === 'email-summary') {
    const run = await prisma.emailSummaryRun.findUnique({ where: { id: String(data.summaryRunId) } });
    if (!run) throw new Error('Summary run unavailable');
    const member = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: run.organizationId, userId: run.userId } },
      include: { user: { select: { disabledAt: true } } },
    });
    if (!member || member.user.disabledAt) throw new Error('Summary principal unavailable');
    return { userId: run.userId, organizationId: run.organizationId };
  }
  throw new Error('Unknown admitted queue');
}
