jest.mock('@/lib/db/prisma', () => ({ prisma: { emailAccount: { findUnique: jest.fn(), update: jest.fn() } } }));
jest.mock('@/lib/crypto', () => ({ decrypt: (value: string) => value.slice(4), encrypt: (value: string) => `enc:${value}` }));
jest.mock('@/lib/workload/admission', () => ({ assertWorkLease: jest.fn(), workSignal: jest.fn() }));
import { getValidOAuthAccessToken } from '@/lib/accounts/tokens';
import { prisma } from '@/lib/db/prisma';
import { assertWorkLease } from '@/lib/workload/admission';
const originalFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue({
    id: 'synthetic', oauthProvider: 'microsoft', oauthAccessToken: 'enc:old',
    oauthRefreshToken: 'enc:refresh', oauthTokenExpiry: new Date(0),
  });
});
afterEach(() => { global.fetch = originalFetch; });
it.each(['https://outlook.office.com/IMAP.AccessAsUser.All offline_access', 'https://graph.microsoft.com/.default offline_access'])('preserves rotation, encryption, expiry and scope %s', async scope => {
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 })));
  const before = Date.now();
  await expect(getValidOAuthAccessToken('synthetic', scope)).resolves.toBe('new');
  const options = (global.fetch as jest.Mock).mock.calls[0][1];
  expect(options.body.get('scope')).toBe(scope);
  expect(options.body.get('refresh_token')).toBe('refresh');
  const data = (prisma.emailAccount.update as jest.Mock).mock.calls[0][0].data;
  expect(data.oauthAccessToken).toBe('enc:new');
  expect(data.oauthRefreshToken).toBe('enc:rotated');
  expect(data.oauthTokenExpiry.getTime()).toBeGreaterThanOrEqual(before + 3600000);
});
it('prevents persistence when the lease is lost after the response', async () => {
  global.fetch = jest.fn(async () => {
    (assertWorkLease as jest.Mock).mockRejectedValueOnce(new Error('lease lost'));
    return new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }));
  });
  await expect(getValidOAuthAccessToken('synthetic')).rejects.toThrow('OAuth token refresh failed');
  expect(prisma.emailAccount.update).not.toHaveBeenCalled();
});
it('does not expose error response secrets', async () => {
  global.fetch = jest.fn(async () => new Response('synthetic-secret-provider-body', { status: 400 }));
  await expect(getValidOAuthAccessToken('synthetic')).rejects.toThrow(/^OAuth token refresh failed or was cancelled$/);
  expect(prisma.emailAccount.update).not.toHaveBeenCalled();
});
it('refreshes Google without a Microsoft scope and preserves an unrotated refresh token', async () => {
  (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue({
    id: 'synthetic', oauthProvider: 'google', oauthAccessToken: 'enc:old',
    oauthRefreshToken: 'enc:refresh', oauthTokenExpiry: new Date(0),
  });
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 })));
  await expect(getValidOAuthAccessToken('synthetic', 'microsoft-only')).resolves.toBe('new');
  expect((global.fetch as jest.Mock).mock.calls[0][1].body.has('scope')).toBe(false);
  expect((prisma.emailAccount.update as jest.Mock).mock.calls[0][0].data).not.toHaveProperty('oauthRefreshToken');
});
