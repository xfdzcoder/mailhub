jest.mock('@/lib/db/prisma', () => ({ prisma: {
  emailAccount: { findUnique: jest.fn() },
  email: { findUnique: jest.fn() },
  emailSummaryRun: { findUnique: jest.fn() },
  organizationMember: { findUnique: jest.fn() },
} }));
import { prisma } from '@/lib/db/prisma';
import { accountWorkOwner, jobWorkOwner } from '@/lib/workload/ownership';

describe('trusted work ownership resolution', () => {
  beforeEach(() => { jest.resetAllMocks(); });
  test('periodic and old sync jobs charge persisted account ownership, ignoring supplied tenant IDs', async () => {
    (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue({ ownerUserId: 'real-user', organizationId: 'real-org', isActive: true });
    expect(await jobWorkOwner('imap-sync-default', { accountId: 'account', userId: 'victim', organizationId: 'victim' })).toEqual({ userId: 'real-user', organizationId: 'real-org' });
    expect(await accountWorkOwner('account')).toEqual({ userId: 'real-user', organizationId: 'real-org' });
  });
  test('search follows email relationships and missing accounts fail closed', async () => {
    (prisma.email.findUnique as jest.Mock).mockResolvedValue({ accountId: 'real-account' });
    (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue({ ownerUserId: 'u2', organizationId: 'o2', isActive: true });
    expect(await jobWorkOwner('search-index', { emailId: 'email', accountId: 'spoof' })).toEqual({ userId: 'u2', organizationId: 'o2' });
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'real-account' } }));
    (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(accountWorkOwner('missing')).rejects.toThrow();
  });
  test('summary uses persisted run owner and requires current membership', async () => {
    (prisma.emailSummaryRun.findUnique as jest.Mock).mockResolvedValue({ userId: 'real-user', organizationId: 'real-org' });
    (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue({ user: { disabledAt: null } });
    expect(await jobWorkOwner('email-summary', { summaryRunId: 'run', userId: 'spoof', organizationId: 'spoof' })).toEqual({ userId: 'real-user', organizationId: 'real-org' });
    (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(jobWorkOwner('email-summary', { summaryRunId: 'run' })).rejects.toThrow('principal unavailable');
    (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue({ user: { disabledAt: new Date() } });
    await expect(jobWorkOwner('email-summary', { summaryRunId: 'run' })).rejects.toThrow('principal unavailable');
  });
});
