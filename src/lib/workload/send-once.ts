import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { assertWorkLease, withoutWorkLease, type WorkOwner } from './admission';

export class SendReplayError extends Error {}
const bounded = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
};
export const sendOperationLimits = {
  preparationMs: bounded('WORK_SEND_PREPARATION_MS', 600000, 1000, 3600000),
  replayMs: bounded('WORK_SEND_REPLAY_MS', 7 * 86400000, 3600000, 30 * 86400000),
  retainedPerOrganization: bounded('WORK_SEND_RETAINED_PER_ORG', 1000, 1, 100000),
};

/** Bounded, restart-safe maintenance, independent of tenant traffic. */
export async function reconcileSendOperations() {
  // Lock a finite batch so concurrent sweepers neither block nor erase live claims.
  return prisma.$transaction(async tx => {
    const removed = await tx.$executeRaw`
      DELETE FROM send_operations WHERE id IN (
        SELECT id FROM send_operations
        WHERE expires_at <= CURRENT_TIMESTAMP
          AND (state <> 'PREPARING' OR preparation_expires_at <= CURRENT_TIMESTAMP)
        ORDER BY expires_at, id LIMIT 500 FOR UPDATE SKIP LOCKED
      )`;
    const recovered = await tx.$executeRaw`
      UPDATE send_operations SET state = 'RETRYABLE', generation = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT id FROM send_operations WHERE state = 'PREPARING' AND preparation_expires_at <= CURRENT_TIMESTAMP
        ORDER BY preparation_expires_at, id LIMIT 500 FOR UPDATE SKIP LOCKED
      )`;
    return { removed, recovered };
  });
}

/** Content binds an operation, but never identifies independent sends. */
export async function claimSend(owner: WorkOwner, accountId: string, operationKey: string, input: unknown) {
  if (!operationKey || operationKey.length > 256) throw new SendReplayError('An explicit send operation identity is required');
  const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const generation = randomUUID();
  await assertWorkLease();
  const operation = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${owner.organizationId}, 2))::text`;
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    // Capacity includes every retained state. Never evict an unexpired marker to admit work.
    await tx.$executeRaw`DELETE FROM send_operations WHERE id IN (
      SELECT id FROM send_operations WHERE organization_id = ${owner.organizationId}::uuid
        AND expires_at <= ${now} AND (state <> 'PREPARING' OR preparation_expires_at <= ${now})
      ORDER BY expires_at, id LIMIT 500 FOR UPDATE SKIP LOCKED
    )`;
    const where = { organizationId_userId_accountId_operationKey: { ...owner, accountId, operationKey } };
    const prior = await tx.sendOperation.findUnique({ where });
    const preparationExpiresAt = new Date(now.getTime() + sendOperationLimits.preparationMs);
    const expiresAt = new Date(now.getTime() + sendOperationLimits.replayMs);
    if (prior) {
      if (prior.payloadHash !== payloadHash && prior.state !== 'RETRYABLE') throw new SendReplayError('Send operation identity was reused with different content');
      if (prior.state !== 'RETRYABLE' && !(prior.state === 'PREPARING' && prior.preparationExpiresAt <= now)) throw new SendReplayError('Send already attempted or in progress. Check delivery status before starting another send.');
      // A known pre-delivery failure permits edits under the same draft operation.
      // The generation check prevents a stale retry from replacing a newer claim.
      const updated = await tx.sendOperation.updateMany({ where: { id: prior.id, generation: prior.generation, state: prior.state }, data: { state: 'PREPARING', generation, payloadHash, preparationExpiresAt, expiresAt } });
      if (updated.count !== 1) throw new SendReplayError('Send operation fenced');
      return prior;
    }
    if (await tx.sendOperation.count({ where: { organizationId: owner.organizationId } }) >= sendOperationLimits.retainedPerOrganization) throw new SendReplayError('Too many retained sends; retry after the replay window');
    return tx.sendOperation.create({ data: { ...owner, accountId, operationKey, payloadHash, generation, state: 'PREPARING', preparationExpiresAt, expiresAt } });
  });
  let started = false;
  return {
    /** Persist uncertainty BEFORE the network delivery call. Never roll it back on an exception. */
    async beforeDelivery() {
      await assertWorkLease();
      const updated = await prisma.$executeRaw`
        UPDATE send_operations SET state = 'DELIVERING', updated_at = clock_timestamp(),
          expires_at = clock_timestamp() + ${sendOperationLimits.replayMs} * interval '1 millisecond'
        WHERE id = ${operation.id}::uuid AND generation = ${generation}::uuid
          AND state = 'PREPARING' AND preparation_expires_at > clock_timestamp()`;
      if (updated !== 1) throw new SendReplayError('Send operation fenced');
      started = true;
      await assertWorkLease();
    },
    async delivered(messageId: string) {
      await withoutWorkLease(() => prisma.sendOperation.updateMany({ where: { id: operation.id, generation, state: 'DELIVERING' }, data: { state: 'DELIVERED', messageId } }));
    },
    async failedBeforeDelivery(error?: unknown) {
      const smtp = error as { command?: string; code?: string } | undefined;
      const definite = smtp && ((smtp.command === 'CONN' && ['ESOCKET', 'EDNS', 'ECONNECTION', 'ETIMEDOUT'].includes(smtp.code || '')) || (smtp.code === 'EAUTH' && smtp.command?.startsWith('AUTH')));
      // A stale callback must never clear another generation or downgrade uncertainty.
      if (!started || definite) await withoutWorkLease(() => prisma.sendOperation.updateMany({ where: { id: operation.id, generation, state: started ? 'DELIVERING' : 'PREPARING' }, data: { state: 'RETRYABLE' } }));
    },
  };
}
