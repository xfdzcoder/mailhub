jest.mock('@/lib/workload/admission', () => ({ withWork: async (_owner: unknown, run: () => Promise<unknown>) => run() }));
jest.mock('@/lib/workload/ownership', () => ({ accountWorkOwner: async () => ({ userId: 'user-1', organizationId: 'org-1' }) }));
jest.mock('@/lib/notifications/push', () => ({ sendPush: jest.fn(), reportPushFailure: jest.fn() }));
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    pushSubscription: {
      findMany: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

import { sendAccountPushNotification } from '@/lib/notifications/account-push';
import { prisma } from '@/lib/db/prisma';

describe('account-scoped web push delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.pushSubscription.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('selects only admin or account-accessible user subscriptions', async () => {
    await sendAccountPushNotification({
      organizationId: 'org-1',
      accountId: 'account-1',
      title: 'New email from sender@example.com',
      body: 'Subject',
      url: '/inbox',
    });

    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({
      take: 100,
      where: {
        organizationId: 'org-1',
        userId: { not: null },
        user: {
          memberships: {
            some: {
              organizationId: 'org-1',
              OR: [
                { role: 'admin' },
                { ownedEmailAccounts: { some: { id: 'account-1' } } },
                { emailAccountAccess: { some: { accountId: 'account-1' } } },
              ],
            },
          },
        },
      },
    });
  });
});
