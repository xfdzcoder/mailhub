import { IncomingBudgetError, IncomingPolicyError, collectIncoming, readImapIncoming } from '@/lib/email/incoming-budget';
import { evaluateIncoming, imapSource, clearIncomingRejections, cleanupIncomingRejections } from '@/lib/email/incoming-rejections';
import { prisma } from '@/lib/db/prisma';
import { Readable } from 'node:stream';

jest.mock('@/lib/db/prisma', () => {
  const tx = { $executeRaw: jest.fn().mockResolvedValue(0), incomingMailRejection: { deleteMany: jest.fn(), findFirst: jest.fn(), upsert: jest.fn() }, emailAccount: { update: jest.fn() } };
  return { prisma: { ...tx, $transaction: jest.fn((fn) => fn(tx)) } };
});
const source = { accountId: 'synthetic-account', provider: 'gmail' as const, providerMessageId: 'synthetic-message' };
const db = prisma.incomingMailRejection;
beforeEach(() => { jest.clearAllMocks(); (db.findFirst as jest.Mock).mockResolvedValue(null); });

it.each([new Error('transport'), new IncomingBudgetError('timeout'), new SyntaxError('parser')])('keeps ambiguous errors retryable: %s', async error => {
  await expect(evaluateIncoming(source, async () => { throw error; })).resolves.toEqual({ kind: 'retryable', error });
  expect((prisma.$executeRaw as jest.Mock).mock.calls.some(call => call[0].join('?').includes('INSERT INTO'))).toBe(false);
});
it('accounts for a deterministic rejection and suppresses a later read', async () => {
  await expect(evaluateIncoming(source, async () => { throw new IncomingPolicyError('message_size_limit'); })).resolves.toEqual({ kind: 'rejected' });
  const writes = (prisma.$executeRaw as jest.Mock).mock.calls.map(call => call[0].join('?'));
  expect(writes.some(sql => sql.includes('ON CONFLICT'))).toBe(true);
  expect(writes.find(sql => sql.includes('ON CONFLICT'))).not.toMatch(/expires_at\s*=/);
  (db.findFirst as jest.Mock).mockResolvedValue({ id: 'persisted', policyVersion: 2 });
  const read = jest.fn();
  await expect(evaluateIncoming(source, read)).resolves.toEqual({ kind: 'rejected' });
  expect(read).not.toHaveBeenCalled();
});
it('does not account for a failed rejection write', async () => {
  (prisma.$executeRaw as jest.Mock).mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('disk')); 
  await expect(evaluateIncoming(source, async () => { throw new IncomingPolicyError('message_size_limit'); })).resolves.toEqual({ kind: 'retryable', error: new Error('disk') });
  await expect(evaluateIncoming(source, async () => 'ordinary')).resolves.toEqual({ kind: 'accepted', value: 'ordinary' });
});
it('removes expired identities before evaluation and scopes a resync', async () => {
  await evaluateIncoming(source, async () => 'ordinary');
  expect(db.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ accountId: source.accountId, expiresAt: { lte: expect.any(Date) } }) });
  await clearIncomingRejections(source.accountId);
  expect(db.deleteMany).toHaveBeenLastCalledWith({ where: { accountId: source.accountId } });
});
it('validates actual mailbox identity and UIDVALIDITY', () => {
  expect(imapSource('a', 'inbox', BigInt(1), BigInt(2))?.provider).toBe('imap');
  expect(imapSource('a', 'INBOX', BigInt(0), BigInt(2))).toBeNull();
  expect(imapSource('a', 'x'.repeat(1025), BigInt(1), BigInt(2))).toBeNull();
  expect(imapSource('a', 'Archive', BigInt(2), BigInt(2))).not.toEqual(imapSource('a', 'Archive', BigInt(1), BigInt(2)));
});
it('cleans expired rows in bounded batches', async () => {
  (prisma.$executeRaw as jest.Mock).mockResolvedValueOnce(1000).mockResolvedValueOnce(1);
  await cleanupIncomingRejections();
  expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
});
it('downloads every synthetic attachment byte, then handles an ordinary message', async () => {
  const original = Buffer.alloc(240_123, 0xa5);
  const download = jest.fn(async (_uid, _part, options) => ({ meta: {}, content: Readable.from([original.subarray(0, 120000), original.subarray(120000, options.maxBytes)]) }));
  const client = { download, close: jest.fn() } as unknown as Parameters<typeof readImapIncoming>[0];
  const result = await readImapIncoming(client, '1', '2', original.length);
  expect(result?.content.equals(original)).toBe(true);
  expect(original.every(byte => byte === 0xa5)).toBe(true);
  await expect(collectIncoming([Buffer.alloc(4)], 3)).rejects.toBeInstanceOf(IncomingPolicyError);
  await expect(collectIncoming([Buffer.from('ok')], 3)).resolves.toEqual(Buffer.from('ok'));
});

it('refuses a superseded worker and reevaluates older policy evidence', async () => {
  (db.findFirst as jest.Mock).mockResolvedValueOnce({ policyVersion: 3 });
  const read = jest.fn(async () => 'ordinary');
  expect((await evaluateIncoming(source, read)).kind).toBe('retryable');
  expect(read).not.toHaveBeenCalled();
  (db.findFirst as jest.Mock).mockResolvedValueOnce({ policyVersion: 1 });
  expect((await evaluateIncoming(source, read)).kind).toBe('accepted');
  expect(read).toHaveBeenCalledTimes(1);
});
