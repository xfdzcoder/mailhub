jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    $executeRaw: jest.fn().mockResolvedValue(0),
    email: { findFirst: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('@/lib/gmail/api', () => ({
  getValidAccessToken: jest.fn(),
  fetchMessagesList: jest.fn(),
  fetchMessageFull: jest.fn(),
  fetchMessageRaw: jest.fn(),
  extractGmailAttachmentParts: jest.fn(() => []),
}));

jest.mock('@/lib/imap/email-parser', () => ({ parseEmail: jest.fn() }));
jest.mock('@/lib/imap/threading', () => ({ resolveThreadId: jest.fn() }));
jest.mock('@/lib/email/attachment-storage', () => ({
  buildReceivedAttachmentMetadata: jest.fn(() => []),
}));
jest.mock('@/lib/queue/client', () => ({ searchQueue: { add: jest.fn() } }));
jest.mock('@/lib/redis', () => ({ redis: { publish: jest.fn() } }));
jest.mock('@/lib/ai/spam-checker', () => ({ checkIsHighRisk: jest.fn() }));
jest.mock('@/lib/rules/engine', () => ({ processRulesForNewEmail: jest.fn() }));
jest.mock('@/lib/retry', () => ({ retryAsync: (operation: () => unknown) => operation() }));
jest.mock('@/lib/runtime-config', () => ({
  runtimeConfig: { emailPersistConcurrency: 1, gmailPollIntervalMs: 60_000 },
}));

import { prisma } from '@/lib/db/prisma';
import { fetchMessageFull, fetchMessageRaw } from '@/lib/gmail/api';
import { parseEmail } from '@/lib/imap/email-parser';
import { resolveThreadId } from '@/lib/imap/threading';
import { searchQueue } from '@/lib/queue/client';
import { GmailSyncManager } from '@/lib/gmail/sync-manager';

describe('Gmail indexing retry', () => {
  it('re-attempts indexing when a retry upserts an email persisted before a queue failure', async () => {
    const newlyPersistedEmail = {
      id: 'email-1',
      createdAt: new Date(),
    };
    const previouslyPersistedEmail = {
      id: 'email-1',
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    };
    const transactionClient = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      emailAccount: { findUniqueOrThrow: jest.fn().mockResolvedValue({ updatedAt: new Date('2026-01-01') }), findFirst: jest.fn().mockResolvedValue({ id: 'synthetic-account' }) },
      incomingMailRejection: { deleteMany: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
      email: {
        upsert: jest
          .fn()
          .mockResolvedValueOnce(newlyPersistedEmail)
          .mockResolvedValueOnce(previouslyPersistedEmail),
      },
      emailBody: { upsert: jest.fn() },
      attachment: { update: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
    };
    (prisma.email.findUnique as jest.Mock).mockResolvedValue({ attachments: [] });
    (prisma.$transaction as jest.Mock).mockImplementation((operation) => operation(transactionClient));
    (fetchMessageFull as jest.Mock).mockResolvedValue({ payload: {} });
    (fetchMessageRaw as jest.Mock).mockResolvedValue(Buffer.from('raw'));
    (parseEmail as jest.Mock).mockResolvedValue({
      messageId: '<message-1@example.test>',
      inReplyTo: null,
      referencesHeader: null,
      attachments: [],
      subject: 'Subject',
      snippet: 'Snippet',
      fromAddress: 'sender@example.test',
      fromName: 'Sender',
      toAddresses: [],
      ccAddresses: [],
      bccAddresses: [],
      replyTo: null,
      hasAttachments: false,
      receivedAt: new Date('2026-08-26T00:00:00.000Z'),
      sentAt: new Date('2026-08-26T00:00:00.000Z'),
      rawHeaders: {},
      bodyHtml: null,
      bodyText: 'Body',
    });
    (resolveThreadId as jest.Mock).mockResolvedValue(null);
    (searchQueue.add as jest.Mock).mockRejectedValueOnce(new Error('search queue unavailable'));

    const manager = new GmailSyncManager();

    await expect(
    (manager as unknown as { fetchAndPersist: (accessToken: string, accountId: string, organizationId: string, messageId: string, folder: string, skipNotifications: boolean) => Promise<boolean> }).fetchAndPersist('access-token', 'account-1', 'org-1', 'message-1', 'INBOX', true)
    ).resolves.toBe(false);
    await expect(
    (manager as unknown as { fetchAndPersist: (accessToken: string, accountId: string, organizationId: string, messageId: string, folder: string, skipNotifications: boolean) => Promise<boolean> }).fetchAndPersist('access-token', 'account-1', 'org-1', 'message-1', 'INBOX', true)
    ).resolves.toBe(true);

    expect(searchQueue.add).toHaveBeenCalledTimes(2);
    expect(searchQueue.add).toHaveBeenLastCalledWith('index-email', { emailId: 'email-1' });
  });
});

it('continues ordinary Gmail messages after rejection, a manager restart, and a transient parse error', async () => {
  const { IncomingPolicyError } = await import('@/lib/email/incoming-budget');
  const rejected = new Set<string>();
  const tx = {
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join('?').includes('INSERT INTO incoming_mail_rejections')) rejected.add(String(values[2]));
      return 0;
    }),
    emailAccount: { findUniqueOrThrow: jest.fn().mockResolvedValue({ updatedAt: new Date('2026-01-01') }), findFirst: jest.fn().mockResolvedValue({ id: 'synthetic-account' }) },
    incomingMailRejection: {
      deleteMany: jest.fn(),
      findFirst: jest.fn(async ({ where }) => rejected.has(where.providerMessageId) ? { policyVersion: 2 } : null),
    },
    email: { upsert: jest.fn().mockResolvedValue({ id: 'synthetic-email', createdAt: new Date(0) }) },
    emailBody: { upsert: jest.fn() },
    attachment: { deleteMany: jest.fn() },
  };
  (prisma.$transaction as jest.Mock).mockImplementation(operation => operation(tx));
  (prisma.email.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.email.findUnique as jest.Mock).mockResolvedValue({ attachments: [] });
  (fetchMessageFull as jest.Mock).mockResolvedValue({ payload: {} });
  (fetchMessageRaw as jest.Mock).mockResolvedValue(Buffer.from('synthetic'));
  (searchQueue.add as jest.Mock).mockResolvedValue(undefined);
  const ordinary = { messageId: 'synthetic-ordinary', attachments: [], receivedAt: new Date(0) };
  (parseEmail as jest.Mock).mockRejectedValueOnce(new IncomingPolicyError('message_size_limit')).mockResolvedValue(ordinary);
  const run = (manager: GmailSyncManager, id: string) =>
    (manager as unknown as { fetchAndPersist: (...args: unknown[]) => Promise<boolean> })
      .fetchAndPersist('synthetic-token', 'synthetic-account', 'synthetic-org', id, 'INBOX', true);
  const first = new GmailSyncManager();
  expect(await run(first, 'synthetic-large')).toBe(true);
  expect(await run(first, 'synthetic-ordinary-1')).toBe(true);
  const restarted = new GmailSyncManager();
  const readsBefore = (fetchMessageRaw as jest.Mock).mock.calls.length;
  expect(await run(restarted, 'synthetic-large')).toBe(true);
  expect((fetchMessageRaw as jest.Mock).mock.calls.length).toBe(readsBefore);
  (parseEmail as jest.Mock).mockRejectedValueOnce(new Error('temporary parser crash'));
  expect(await run(restarted, 'synthetic-transient')).toBe(false);
  expect(rejected.has('synthetic-transient')).toBe(false);
  expect(await run(restarted, 'synthetic-transient')).toBe(true);
  expect(await run(restarted, 'synthetic-ordinary-2')).toBe(true);
});
