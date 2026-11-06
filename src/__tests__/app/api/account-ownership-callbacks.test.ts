jest.mock('ioredis', () => {
  const entries = new Map<string, { raw: string; expires: number }>();
  return { __esModule: true, default: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    set: jest.fn(async (key: string, raw: string, _ex: string, ttl: number) => {
      entries.set(key, { raw, expires: Date.now() + ttl * 1000 });
      return 'OK';
    }),
    eval: jest.fn(async (_script: string, _count: number, key: string, ...args: string[]) => {
      const entry = entries.get(key);
      if (!entry || entry.expires <= Date.now()) return null;
      const t = JSON.parse(entry.raw);
      if ([t.provider, t.sessionId, t.userId, t.organizationId, t.redirectUri].some((value, i) => value !== args[i])) return null;
      entries.delete(key);
      return entry.raw;
    }),
  })) };
});
jest.mock('@/lib/db/prisma', () => ({ prisma: { emailAccount: {
  findFirst: jest.fn(), update: jest.fn(), count: jest.fn(),
} } }));
jest.mock('@/lib/crypto', () => ({ encrypt: jest.fn((value: string) => `encrypted:${value}`) }));
jest.mock('@/lib/auth/sessions', () => ({
  verifySessionToken: jest.fn(), authorizeSession: jest.fn(),
  SessionError: class SessionError extends Error {},
}));
jest.mock('@/lib/queue/client', () => ({ enqueueInitialSync: jest.fn() }));
jest.mock('@/lib/accounts/service', () => ({ createOwnedAccount: jest.fn() }));
jest.mock('@/lib/auth/middleware', () => ({ authenticate: jest.fn() }));

import { NextRequest } from 'next/server';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { GET as googleCallback } from '@/app/api/accounts/oauth/google/callback/route';
import { GET as microsoftCallback } from '@/app/api/accounts/oauth/microsoft/callback/route';
import { GET as googleInit } from '@/app/api/accounts/oauth/google/init/route';
import { GET as microsoftInit } from '@/app/api/accounts/oauth/microsoft/init/route';
import { prisma } from '@/lib/db/prisma';
import { encrypt } from '@/lib/crypto';
import { verifySessionToken, authorizeSession, SessionError } from '@/lib/auth/sessions';
import { authenticate } from '@/lib/auth/middleware';
import { enqueueInitialSync } from '@/lib/queue/client';
import { createOwnedAccount } from '@/lib/accounts/service';
import { createOAuthTransaction, CONSUME_TRANSACTION, trustedOrigin } from '@/lib/oauth/transactions';

const store = (Redis as unknown as jest.Mock).mock.results[0].value;
const auth = { userId: 'user-1', organizationId: 'org-1', sessionId: 'session-1', tokenVersion: 0, role: 'member' as const };
const fetchMock = jest.fn();
global.fetch = fetchMock;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

for (const provider of ['google', 'microsoft'] as const) {
  const callback = provider === 'google' ? googleCallback : microsoftCallback;
  const init = provider === 'google' ? googleInit : microsoftInit;
  const callbackUrl = `http://localhost/api/accounts/oauth/${provider}/callback`;
  const identity = provider === 'google' ? { email: 'Inbox@Example.com', verified_email: true } : { mail: 'Inbox@Example.com' };
  async function transaction() { return createOAuthTransaction(provider, auth, 'inbox@example.com', 'Test Inbox'); }
  function request(state?: string, params = 'code=test-code', origin = 'http://localhost') {
    return new NextRequest(`${origin}/api/accounts/oauth/${provider}/callback?${params}${state ? `&state=${state}` : ''}`, {
      headers: { cookie: 'auth-token=synthetic-session-token' },
    });
  }
  function noMutation() {
    expect(encrypt).not.toHaveBeenCalled();
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
    expect(createOwnedAccount).not.toHaveBeenCalled();
    expect(enqueueInitialSync).not.toHaveBeenCalled();
  }
  describe(`${provider} session-bound OAuth`, () => {
    beforeEach(() => {
      jest.clearAllMocks();
      process.env.NEXT_PUBLIC_APP_URL = 'http://localhost';
      process.env.GOOGLE_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID = 'synthetic-client';
      process.env.GOOGLE_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET = 'synthetic-secret';
      (verifySessionToken as jest.Mock).mockReset().mockResolvedValue(auth);
      (authorizeSession as jest.Mock).mockReset().mockResolvedValue(auth);
      (authenticate as jest.Mock).mockResolvedValue(auth);
      (prisma.emailAccount.findFirst as jest.Mock).mockReset().mockResolvedValue(null);
      (prisma.emailAccount.count as jest.Mock).mockResolvedValue(0);
      (prisma.emailAccount.update as jest.Mock).mockResolvedValue({ id: 'existing' });
      (createOwnedAccount as jest.Mock).mockResolvedValue({ id: 'created' });
      fetchMock.mockReset().mockImplementation(async (url: string) => url.includes('/token')
        ? json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })
        : json(identity));
    });
    it('stores opaque 256-bit state for 600 seconds and exposes only S256 challenge', async () => {
      const result = await init(new NextRequest(`http://localhost/api/accounts/oauth/${provider}/init?emailAddress=Inbox%40Example.com&label=Test`));
      const url = new URL(result.headers.get('location')!);
      const [key, raw, ex, ttl, nx] = store.set.mock.calls.at(-1);
      const saved = JSON.parse(raw);
      expect(url.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
      expect(key).toBe(`oauth:transaction:${url.searchParams.get('state')}`);
      expect([ex, ttl, nx]).toEqual(['EX', 600, 'NX']);
      expect(saved).toMatchObject({ sessionId: auth.sessionId, userId: auth.userId, organizationId: auth.organizationId, provider, emailAddress: 'inbox@example.com' });
      expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(saved.verifier).digest('base64url'));
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.toString()).not.toContain(saved.verifier);
      expect(url.toString()).not.toContain('synthetic-secret');
    });
    it('consumes once, sends verifier in POST body, and creates a session-user-owned account', async () => {
      const t = await transaction();
      const response = await callback(request(t.state));
      expect(response.headers.get('location')).toContain('success=true');
      const [, options] = fetchMock.mock.calls[0];
      expect(options.body.get('code_verifier')).toMatch(/^[\w-]{43}$/);
      expect(options.body.get('redirect_uri')).toBe(callbackUrl);
      expect(createOwnedAccount).toHaveBeenCalledWith('org-1', 'user-1', expect.objectContaining({ emailAddress: 'inbox@example.com' }));
      expect(store.eval).toHaveBeenCalledWith(CONSUME_TRANSACTION, 1, `oauth:transaction:${t.state}`, provider, 'session-1', 'user-1', 'org-1', callbackUrl);
      expect((await callback(request(t.state))).headers.get('location')).toContain('invalid_state');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('accepts only one concurrent callback', async () => {
      const t = await transaction();
      const results = await Promise.all([callback(request(t.state)), callback(request(t.state))]);
      expect(results.filter(r => r.headers.get('location')?.includes('success=true'))).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it.each([undefined, 'forged', 'a'.repeat(43)])('rejects missing/forged state %s', async state => {
      expect((await callback(request(state))).headers.get('location')).toContain('invalid_state');
      expect(fetchMock).not.toHaveBeenCalled(); noMutation();
    });
    it('rejects expired state', async () => {
      const t = await transaction();
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 601000);
      try { expect((await callback(request(t.state))).headers.get('location')).toContain('invalid_state'); }
      finally { clock.mockRestore(); }
      expect(fetchMock).not.toHaveBeenCalled(); noMutation();
    });
    it.each(['sessionId', 'userId', 'organizationId'])('rejects wrong %s without consuming the legitimate transaction', async field => {
      const t = await transaction();
      (verifySessionToken as jest.Mock).mockResolvedValueOnce({ ...auth, [field]: 'other' });
      expect((await callback(request(t.state))).headers.get('location')).toContain('invalid_state');
      expect(fetchMock).not.toHaveBeenCalled(); noMutation();
      expect((await callback(request(t.state))).headers.get('location')).toContain('success=true');
    });
    it('rejects the wrong provider', async () => {
      const t = await createOAuthTransaction(provider === 'google' ? 'microsoft' : 'google', auth, 'inbox@example.com', 'Test');
      expect((await callback(request(t.state))).headers.get('location')).toContain('invalid_state');
      expect(fetchMock).not.toHaveBeenCalled(); noMutation();
    });
    it('consumes provider rejection and requires a restart', async () => {
      const t = await transaction();
      expect((await callback(request(t.state, 'error=access_denied'))).headers.get('location')).toContain('oauth_rejected');
      expect((await callback(request(t.state))).headers.get('location')).toContain('invalid_state');
      expect(fetchMock).not.toHaveBeenCalled(); noMutation();
    });
    it('consumes a callback missing its code', async () => {
      const t = await transaction();
      expect((await callback(request(t.state, ''))).headers.get('location')).toContain('missing_oauth_params');
      expect((await callback(request(t.state))).headers.get('location')).toContain('invalid_state'); noMutation();
    });
    it('rejects an untrusted callback origin without consuming state', async () => {
      const t = await transaction();
      const response = await callback(request(t.state, 'code=test', 'https://attacker.example'));
      expect(response.headers.get('location')).toBe('http://localhost/settings/accounts?error=invalid_callback_origin');
      expect(fetchMock).not.toHaveBeenCalled(); noMutation();
    });
    it.each(['before', 'after'])('rejects revoked sessions %s provider exchange', async when => {
      const t = await transaction();
      const verifier = when === 'before' ? verifySessionToken : authorizeSession;
      (verifier as jest.Mock).mockRejectedValueOnce(new SessionError());
      expect((await callback(request(t.state))).headers.get('location')).toContain('auth_required'); noMutation();
    });
    it.each([{}, provider === 'google' ? { email: 'other@example.com' } : { mail: 'other@example.com' }])('rejects missing or mismatched provider identity %j', async profile => {
      const t = await transaction();
      fetchMock.mockResolvedValueOnce(json({ access_token: 'synthetic', expires_in: 3600 })).mockResolvedValueOnce(json(profile));
      expect((await callback(request(t.state))).headers.get('location')).toMatch(/provider_identity_(unconfirmed|mismatch)/); noMutation();
    });
    it.each(['http', 'network', 'json'])('consumes state on token endpoint %s error without exposing provider details', async kind => {
      const t = await transaction();
      if (kind === 'http') fetchMock.mockResolvedValueOnce(json({ error_description: 'private-provider-evidence' }, 400));
      if (kind === 'network') fetchMock.mockRejectedValueOnce(new Error('private-provider-evidence'));
      if (kind === 'json') fetchMock.mockResolvedValueOnce(new Response('invalid json'));
      const response = await callback(request(t.state));
      expect(response.headers.get('location')).not.toContain('private-provider-evidence');
      expect((await callback(request(t.state))).headers.get('location')).toContain('invalid_state'); noMutation();
    });
    it('uses current membership after an admin is demoted during provider calls', async () => {
      const t = await transaction();
      (verifySessionToken as jest.Mock).mockResolvedValue({ ...auth, role: 'admin' });
      (authorizeSession as jest.Mock).mockResolvedValue({ ...auth, role: 'member' });
      (prisma.emailAccount.findFirst as jest.Mock).mockResolvedValue({ id: 'existing', emailAddress: 'inbox@example.com', ownerUserId: 'another-user' });
      expect((await callback(request(t.state))).headers.get('location')).toContain('unauthorized_reauthorization'); noMutation();
    });
    it('requires the browser session cookie at callback', async () => {
      const t = await transaction();
      const req = new NextRequest(`${callbackUrl}?code=test&state=${t.state}`);
      expect((await callback(req)).headers.get('location')).toContain('auth_required');
      expect(fetchMock).not.toHaveBeenCalled(); noMutation();
    });
    it('does not use the request origin when application origin is missing', async () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      expect((await callback(request('a'.repeat(43)))).status).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled(); noMutation();
    });
    if (provider === 'microsoft') it('accepts the matching normalized Graph userPrincipalName when mail is absent', async () => {
      const t = await transaction();
      fetchMock.mockResolvedValueOnce(json({ access_token: 'synthetic', expires_in: 3600 }))
        .mockResolvedValueOnce(json({ mail: null, userPrincipalName: 'Inbox@Example.COM' }));
      expect((await callback(request(t.state))).headers.get('location')).toContain('success=true');
      expect(createOwnedAccount).toHaveBeenCalledWith('org-1', 'user-1', expect.objectContaining({ emailAddress: 'inbox@example.com' }));
    });
    if (provider === 'google') it('requires a verified Google mailbox', async () => {
      const t = await transaction();
      fetchMock.mockResolvedValueOnce(json({ access_token: 'synthetic', expires_in: 3600 }))
        .mockResolvedValueOnce(json({ email: 'inbox@example.com', verified_email: false }));
      expect((await callback(request(t.state))).headers.get('location')).toContain('provider_identity_unconfirmed'); noMutation();
    });
    it('fails closed on Redis read failure', async () => {
      const t = await transaction();
      store.eval.mockRejectedValueOnce(new Error('Redis unavailable'));
      expect((await callback(request(t.state))).headers.get('location')).toContain('internal_error');
      expect(fetchMock).not.toHaveBeenCalled(); noMutation();
    });
    it('returns 503 on Redis write failure without redirecting to provider', async () => {
      store.set.mockRejectedValueOnce(new Error('Redis unavailable'));
      const response = await init(new NextRequest(`http://localhost/api/accounts/oauth/${provider}/init?emailAddress=inbox%40example.com&label=Test`));
      expect(response.status).toBe(503); expect(response.headers.get('location')).toBeNull();
    });
    it('preserves an existing refresh token when the provider omits a replacement', async () => {
      const t = await transaction();
      (prisma.emailAccount.findFirst as jest.Mock).mockResolvedValue({ id: 'existing', emailAddress: 'Inbox@Example.com', ownerUserId: 'user-1', oauthRefreshToken: 'encrypted:old' });
      fetchMock.mockResolvedValueOnce(json({ access_token: 'new', expires_in: 3600 }));
      expect((await callback(request(t.state))).headers.get('location')).toContain('success=true');
      expect(prisma.emailAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ oauthRefreshToken: 'encrypted:old' }) }));
      expect(createOwnedAccount).not.toHaveBeenCalled();
    });
    it.each(['member', 'admin'])('enforces current %s ownership permissions', async role => {
      const t = await transaction();
      (verifySessionToken as jest.Mock).mockResolvedValue({ ...auth, role });
      (authorizeSession as jest.Mock).mockResolvedValue({ ...auth, role });
      (prisma.emailAccount.findFirst as jest.Mock).mockResolvedValue({ id: 'existing', emailAddress: 'inbox@example.com', ownerUserId: 'another-user' });
      const result = await callback(request(t.state));
      expect(result.headers.get('location')).toContain(role === 'admin' ? 'success=true' : 'unauthorized_reauthorization');
      if (role === 'member') noMutation();
    });
  });
}

it.each(['', 'https://example.com/path', 'https://user:password@example.com', 'http://example.com', 'https://example.com?query=1'])('rejects invalid configured callback origin %s', value => {
  process.env.NEXT_PUBLIC_APP_URL = value;
  expect(() => trustedOrigin()).toThrow();
});
