jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  }))
);

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  })),
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock('@/lib/redis', () => ({
  redis: { publish: jest.fn() },
}));

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    emailAccount: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('@/lib/imap/connection-manager', () => ({
  imapManager: {
    getStatus: jest.fn(),
    initializeAccount: jest.fn(),
    syncHistoricalEmails: jest.fn(),
    enableReconciliation: jest.fn(),
  },
}));

jest.mock('@/lib/gmail/sync-manager', () => ({
  gmailSyncManager: {
    initializeAccount: jest.fn(),
    syncHistoricalEmails: jest.fn(),
  },
}));

import { Worker } from 'bullmq';
import { prisma } from '@/lib/db/prisma';
import { gmailSyncManager } from '@/lib/gmail/sync-manager';
import { imapManager } from '@/lib/imap/connection-manager';
import { redis } from '@/lib/redis';
import '@/lib/queue/workers/sync';

const syncProcessor = (Worker as unknown as jest.Mock).mock.calls[0][1] as (
  job: { name: string; data: { accountId: string; folder: string } }
) => Promise<void>;

const gmailAccount = {
  id: 'account-1',
  organizationId: 'org-1',
  provider: 'gmail',
  workerPartition: 'default',
  initialSyncCompletedAt: null,
};

describe('initial sync watermark handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue(gmailAccount);
    (prisma.emailAccount.update as jest.Mock).mockResolvedValue(gmailAccount);
    (gmailSyncManager.initializeAccount as jest.Mock).mockResolvedValue(undefined);
  });

  it('rejects an incomplete provider sync without advancing account timestamps', async () => {
    (gmailSyncManager.syncHistoricalEmails as jest.Mock).mockResolvedValue({
      processed: 3,
      failed: 1,
    });

    await expect(
      syncProcessor({
        name: 'initial-sync',
        data: { accountId: 'account-1', folder: 'ALL' },
      })
    ).rejects.toThrow('account-1');

    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
    expect(gmailSyncManager.initializeAccount).toHaveBeenCalledWith(gmailAccount);
  });

  it('starts Gmail polling before historical sync so failed backfills still keep receiving mail', async () => {
    let resolveHistoricalSync: ((result: { processed: number; failed: number }) => void) | undefined;
    const historicalSyncStarted = new Promise<void>((resolve) => {
      (gmailSyncManager.syncHistoricalEmails as jest.Mock).mockImplementation(
        () =>
          new Promise((resolveHistorical) => {
            resolveHistoricalSync = resolveHistorical;
            resolve();
          })
      );
    });

    const job = syncProcessor({
      name: 'initial-sync',
      data: { accountId: 'account-1', folder: 'ALL' },
    });

    await historicalSyncStarted;
    expect(gmailSyncManager.initializeAccount).toHaveBeenCalledWith(gmailAccount);

    resolveHistoricalSync?.({ processed: 3, failed: 0 });
    await job;

    expect(gmailSyncManager.initializeAccount).toHaveBeenCalledWith(gmailAccount);
  });

  it('advances timestamps after a complete provider sync', async () => {
    (gmailSyncManager.syncHistoricalEmails as jest.Mock).mockResolvedValue({
      processed: 3,
      failed: 0,
    });

    await syncProcessor({
      name: 'initial-sync',
      data: { accountId: 'account-1', folder: 'ALL' },
    });

    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: {
        lastSyncedAt: expect.any(Date),
        initialSyncCompletedAt: expect.any(Date),
      },
    });
  });

  it('enables IMAP reconciliation only after its initial-sync watermark update succeeds', async () => {
    const imapAccount = {
      ...gmailAccount,
      provider: 'imap',
      initialSyncCompletedAt: null,
    };
    let resolveUpdate: (() => void) | undefined;
    const updateStarted = new Promise<void>((resolve) => {
      (prisma.emailAccount.update as jest.Mock).mockImplementation(
        () =>
          new Promise<void>((updateResolve) => {
            resolveUpdate = updateResolve;
            resolve();
          })
      );
    });
    (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue(imapAccount);
    (imapManager.getStatus as jest.Mock).mockReturnValue([
      { accountId: 'account-1', isConnected: true },
    ]);
    (imapManager.syncHistoricalEmails as jest.Mock).mockResolvedValue({
      processed: 3,
      failed: 0,
    });

    const job = syncProcessor({
      name: 'initial-sync',
      data: { accountId: 'account-1', folder: 'ALL' },
    });
    await updateStarted;

    expect(imapManager.enableReconciliation).not.toHaveBeenCalled();

    resolveUpdate?.();
    await job;

    expect(imapManager.enableReconciliation).toHaveBeenCalledWith('account-1');
  });
});

it('uses the start cutoff and fences the account revision when historical work finishes later', async () => {
  jest.useFakeTimers();
  const cutoff = new Date('2026-11-14T12:00:00.000Z');
  const revision = new Date('2026-11-14T11:00:00.000Z');
  jest.setSystemTime(cutoff);
  (prisma.emailAccount.update as jest.Mock).mockResolvedValue(gmailAccount);
  (gmailSyncManager.initializeAccount as jest.Mock).mockResolvedValue(undefined);
  (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue({ ...gmailAccount, updatedAt: revision });
  (gmailSyncManager.syncHistoricalEmails as jest.Mock).mockImplementation(async () => {
    jest.setSystemTime(new Date('2026-11-14T12:10:00.000Z'));
    return { processed: 2, failed: 0 };
  });
  try {
    await syncProcessor({ name: 'initial-sync', data: { accountId: 'account-1', folder: 'ALL' } });
    expect(prisma.emailAccount.update).toHaveBeenLastCalledWith({
      where: { id: 'account-1', updatedAt: { gte: revision, lt: new Date(revision.getTime() + 1) } },
      data: { lastSyncedAt: cutoff, initialSyncCompletedAt: expect.any(Date) },
    });
  } finally { jest.useRealTimers(); }
});
