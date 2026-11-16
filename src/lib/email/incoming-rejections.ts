import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { IncomingPolicyError } from './incoming-budget';

// Increment whenever any incoming threshold or policy changes.
export const INCOMING_POLICY_VERSION = 2;
export type SourceIdentity = { accountId: string } & (
  { provider: 'gmail'; providerMessageId: string } |
  { provider: 'imap'; mailbox: string; uidValidity: bigint; uid: bigint }
);
export type IncomingOutcome<T> = { kind: 'accepted'; value: T; revision?: Date } | { kind: 'rejected' } | { kind: 'retryable'; error: unknown };

export function imapSource(accountId: string, mailbox: string, uidValidity: bigint, uid: bigint): Extract<SourceIdentity, { provider: 'imap' }> | null {
  if (!mailbox || mailbox.length > 1024 || Buffer.byteLength(mailbox) > 2048 ||
      uidValidity < BigInt(1) || uidValidity > BigInt(4294967295) || uid < BigInt(1) || uid > BigInt(4294967295)) return null;
  return { accountId, provider: 'imap', mailbox: /^inbox$/i.test(mailbox) ? 'INBOX' : mailbox, uidValidity, uid };
}

// Keep provider I/O outside transactions; revalidate the reset revision on write.
let startupCleanup: Promise<void> | undefined;

export async function evaluateIncoming<T>(source: SourceIdentity | null, read: () => Promise<T>): Promise<IncomingOutcome<T>> {
  try { return await evaluateLocked(source, read); }
  catch (error) { return { kind: 'retryable', error }; }
}

async function evaluateLocked<T>(source: SourceIdentity | null, read: () => Promise<T>): Promise<IncomingOutcome<T>> {
  await (startupCleanup ??= cleanupIncomingRejections().catch(error => { startupCleanup = undefined; throw error; }));
  if (!source) return { kind: 'accepted', value: await read() };
  const revision = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${source.accountId}, 50))`;
    const where = source.provider === 'gmail'
      ? { accountId: source.accountId, providerMessageId: source.providerMessageId }
      : { accountId: source.accountId, mailbox: source.mailbox, uidValidity: source.uidValidity, uid: source.uid };
    const now = new Date();
    await tx.incomingMailRejection.deleteMany({ where: { ...where, expiresAt: { lte: now } } });
    const existing = await tx.incomingMailRejection.findFirst({ where: { ...where, expiresAt: { gt: now } } });
    if (existing && existing.policyVersion > INCOMING_POLICY_VERSION) throw new Error('Incoming policy worker is superseded');
    if (existing?.policyVersion === INCOMING_POLICY_VERSION) return null;
    const account = await tx.emailAccount.findUniqueOrThrow({ where: { id: source.accountId }, select: { updatedAt: true } });
    return account.updatedAt;
  });
  if (!revision) return { kind: 'rejected' };
  try {
    const value = await read();
    await prisma.$transaction(async tx => { await validateRevision(tx, source.accountId, revision); });
    return { kind: 'accepted', value, revision };
  } catch (error) {
    if (!(error instanceof IncomingPolicyError)) throw error;
    return prisma.$transaction(async tx => {
      await validateRevision(tx, source.accountId, revision);
      const id = randomUUID();
      if (source.provider === 'gmail') {
        await tx.$executeRaw`INSERT INTO incoming_mail_rejections
          (id, account_id, provider, provider_message_id, reason_code, policy_version)
          VALUES (${id}::uuid, ${source.accountId}::uuid, 'gmail', ${source.providerMessageId}, ${error.reasonCode}, ${INCOMING_POLICY_VERSION})
          ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
          last_rejected_at = GREATEST(incoming_mail_rejections.last_rejected_at, EXCLUDED.last_rejected_at),
          reason_code = EXCLUDED.reason_code, policy_version = EXCLUDED.policy_version
          WHERE incoming_mail_rejections.policy_version <= EXCLUDED.policy_version`;
      } else {
        await tx.$executeRaw`INSERT INTO incoming_mail_rejections
          (id, account_id, provider, mailbox, uid_validity, uid, reason_code, policy_version)
          VALUES (${id}::uuid, ${source.accountId}::uuid, 'imap', ${source.mailbox}, ${source.uidValidity}, ${source.uid}, ${error.reasonCode}, ${INCOMING_POLICY_VERSION})
          ON CONFLICT (account_id, mailbox, uid_validity, uid) DO UPDATE SET
          last_rejected_at = GREATEST(incoming_mail_rejections.last_rejected_at, EXCLUDED.last_rejected_at),
          reason_code = EXCLUDED.reason_code, policy_version = EXCLUDED.policy_version
          WHERE incoming_mail_rejections.policy_version <= EXCLUDED.policy_version`;
      }
      return { kind: 'rejected' as const };
    });
  }
}

export async function validateRevision(tx: Prisma.TransactionClient, accountId: string, revision: Date) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 50))`;
  const account = await tx.emailAccount.findFirst({ where: { id: accountId, updatedAt: syncRevision(revision) }, select: { id: true } });
  if (!account) throw new Error('Incoming sync generation changed');
}

/** Caller must authorize the account before invoking an explicit user resync. */
export async function clearIncomingRejections(accountId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 50))`;
    await tx.incomingMailRejection.deleteMany({ where: { accountId } });
    // Move beyond the previous millisecond even when reset and sync race in
    // the same clock tick; legacy SQL timestamps can retain microseconds.
    await tx.$executeRaw`UPDATE email_accounts SET last_synced_at = NULL,
      initial_sync_completed_at = NULL,
      updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
      WHERE id = ${accountId}::uuid`;
  }, { maxWait: 120_000, timeout: 120_000 });
}

// Indexed batches bound each transaction and avoid retaining expired identities.
export async function cleanupIncomingRejections(): Promise<void> {
  let deleted: number;
  do {
    deleted = await prisma.$executeRaw`DELETE FROM incoming_mail_rejections WHERE id IN
      (SELECT id FROM incoming_mail_rejections WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at LIMIT 1000)`;
  } while (deleted === 1000);
}

/** Prisma Dates retain milliseconds; legacy database timestamps can retain more. */
export function syncRevision(updatedAt: Date) {
  return updatedAt && { gte: updatedAt, lt: new Date(updatedAt.getTime() + 1) };
}
