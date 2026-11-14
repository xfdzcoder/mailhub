import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { assertWorkLease, withoutWorkLease, type WorkOwner } from './admission';

export class SendReplayError extends Error {}
/** Content binds an operation, but never identifies independent sends. */
export async function claimSend(owner: WorkOwner, accountId: string, operationKey: string, input: unknown) {
  if (!operationKey || operationKey.length > 256) throw new SendReplayError('An explicit send operation identity is required');
  const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const generation = randomUUID();
  await assertWorkLease();
  const operation = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${owner.organizationId}, 2))::text`;
    const where = { organizationId_userId_accountId_operationKey: { ...owner, accountId, operationKey } };
    const prior = await tx.sendOperation.findUnique({ where });
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new SendReplayError('Send operation identity was reused with different content');
      if (prior.state !== 'RETRYABLE') throw new SendReplayError('Send already attempted or in progress. Check delivery status before starting another send.');
      return tx.sendOperation.update({ where: { id: prior.id }, data: { state: 'PREPARING', generation } });
    }
    if (await tx.sendOperation.count({ where: { organizationId: owner.organizationId, state: { in: ['PREPARING', 'DELIVERING'] } } }) >= 1000) throw new SendReplayError('Too many unresolved sends');
    return tx.sendOperation.create({ data: { ...owner, accountId, operationKey, payloadHash, generation, state: 'PREPARING' } });
  });
  let started = false;
  return {
    /** Persist uncertainty BEFORE the network delivery call. Never roll it back on an exception. */
    async beforeDelivery() {
      await assertWorkLease();
      const updated = await prisma.sendOperation.updateMany({ where: { id: operation.id, generation, state: 'PREPARING' }, data: { state: 'DELIVERING' } });
      if (updated.count !== 1) throw new SendReplayError('Send operation fenced');
      await assertWorkLease();
      started = true;
    },
    async delivered(messageId: string) {
      await withoutWorkLease(() => prisma.sendOperation.updateMany({ where: { id: operation.id, generation, state: 'DELIVERING' }, data: { state: 'DELIVERED', messageId } }));
    },
    async failedBeforeDelivery(error?: unknown) {
      const smtp = error as { command?: string; code?: string } | undefined;
      const definite = smtp && ((smtp.command === 'CONN' && ['ESOCKET', 'EDNS', 'ECONNECTION', 'ETIMEDOUT'].includes(smtp.code || '')) || (smtp.code === 'EAUTH' && smtp.command?.startsWith('AUTH')));
      if (!started || definite) await withoutWorkLease(() => prisma.sendOperation.updateMany({ where: { id: operation.id, generation, state: { in: ['PREPARING', 'DELIVERING'] } }, data: { state: 'RETRYABLE' } }));
    },
  };
}
