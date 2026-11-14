jest.mock('@/lib/db/prisma', () => ({ prisma: {
  $executeRaw: jest.fn().mockResolvedValue(0), $transaction: jest.fn(),
  email: { findUnique: jest.fn().mockResolvedValue({ attachments: [] }) },
} }));
jest.mock('@/lib/imap/email-parser', () => ({
  ...jest.requireActual('@/lib/imap/email-parser'), parseEmail: jest.fn(),
}));
jest.mock('@/lib/imap/threading', () => ({ resolveThreadId: jest.fn() }));
jest.mock('@/lib/email/attachment-storage', () => ({ buildReceivedAttachmentMetadata: jest.fn(() => []) }));
jest.mock('@/lib/queue/client', () => ({ searchQueue: { add: jest.fn() } }));
jest.mock('@/lib/redis', () => ({ redis: { publish: jest.fn() } }));
jest.mock('@/lib/ai/spam-checker', () => ({ checkIsHighRisk: jest.fn() }));
jest.mock('@/lib/rules/engine', () => ({ processRulesForNewEmail: jest.fn() }));
jest.mock('@/lib/retry', () => ({ retryAsync: (operation: () => unknown) => operation() }));
import { Readable } from 'node:stream';
import { IMAPConnectionManager } from '@/lib/imap/connection-manager';
import { parseEmail } from '@/lib/imap/email-parser';
import { IncomingPolicyError } from '@/lib/email/incoming-budget';
import { prisma } from '@/lib/db/prisma';

type Access = { connections: Map<string, unknown>; persistEmail: (...args: unknown[]) => Promise<boolean> };
it('retries IMAP failures and persists successors after rejection and restart using actual mailbox identity', async () => {
  const rejected = new Set<string>();
  const tx = {
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join('?').includes('INSERT INTO incoming_mail_rejections')) rejected.add(`${values[2]}:${values[3]}:${values[4]}`);
      return 0;
    }),
    incomingMailRejection: {
      deleteMany: jest.fn(),
      findFirst: jest.fn(async ({ where }) => rejected.has(`${where.mailbox}:${where.uidValidity}:${where.uid}`) ? { policyVersion: 2 } : null),
    },
    email: { upsert: jest.fn().mockResolvedValue({ id: 'synthetic-email' }) },
    emailBody: { upsert: jest.fn() }, attachment: { deleteMany: jest.fn() },
  };
  (prisma.$transaction as jest.Mock).mockImplementation(operation => operation(tx));
  const original = Buffer.from('synthetic original retained by provider');
  const client = {
    mailbox: { path: 'Actual/Inbox', uidValidity: BigInt(42) },
    download: jest.fn(async () => ({ meta: {}, content: Readable.from([original]) })),
  };
  const connect = () => {
    const manager = new IMAPConnectionManager() as unknown as Access;
    manager.connections.set('synthetic-account', { client });
    return manager;
  };
  const run = (manager: Access, uid: number) => manager.persistEmail('synthetic-account', 'synthetic-org', { uid }, 'INBOX', true);
  (parseEmail as jest.Mock).mockRejectedValueOnce(new IncomingPolicyError('message_size_limit')).mockResolvedValue({ messageId: 'synthetic-ordinary', attachments: [], receivedAt: new Date(0) });
  const first = connect();
  expect(await run(first, 7)).toBe(true);
  expect(rejected.has('Actual/Inbox:42:7')).toBe(true);
  expect(await run(first, 8)).toBe(true);
  const restarted = connect();
  const reads = client.download.mock.calls.length;
  expect(await run(restarted, 7)).toBe(true);
  expect(client.download.mock.calls.length).toBe(reads);
  (parseEmail as jest.Mock).mockRejectedValueOnce(new Error('temporary parser crash'));
  expect(await run(restarted, 9)).toBe(false);
  expect(rejected.has('Actual/Inbox:42:9')).toBe(false);
  expect(await run(restarted, 9)).toBe(true);
  expect(await run(restarted, 10)).toBe(true);
  // Changed UIDVALIDITY is a new source, even with the same mailbox and UID.
  client.mailbox.uidValidity = BigInt(43);
  expect(await run(restarted, 7)).toBe(true);
  expect(client.download.mock.calls.length).toBe(reads + 4);
  expect(original.toString()).toBe('synthetic original retained by provider');
});
