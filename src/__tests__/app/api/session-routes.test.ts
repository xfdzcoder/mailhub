// Endpoint fixtures isolate Redis; distributed policy is exercised separately.
jest.mock('ioredis', () => class {
  on() { return this; }
  async eval() { return 1; }
  async zrem() { return 1; }
});
jest.mock('@/lib/auth/sessions', () => ({
  createSession: jest.fn(), rotateSession: jest.fn(), revokeSession: jest.fn(),
  authorizeSession: jest.fn(), changeUserPassword: jest.fn(),
  SessionError: class extends Error {
    constructor(public code = 'AUTH_REQUIRED') { super(code); }
  },
}));
jest.mock('@/lib/db/prisma', () => ({ prisma: { user: { findUnique: jest.fn() } } }));
jest.mock('bcryptjs', () => ({ compare: jest.fn(), hash: jest.fn().mockResolvedValue('new-synthetic-hash') }));
import { NextRequest } from 'next/server';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as refresh } from '@/app/api/auth/refresh/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { PUT as password } from '@/app/api/auth/password/route';
import { authenticate, requireAdmin } from '@/lib/auth/middleware';
import { createToken } from '@/lib/auth/jwt';
import { createSession, rotateSession, revokeSession, authorizeSession, changeUserPassword, SessionError } from '@/lib/auth/sessions';
import { prisma } from '@/lib/db/prisma';
import { compare, hash } from 'bcryptjs';

const identity = { userId: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002', role: 'admin' as const, sessionId: '00000000-0000-4000-8000-000000000003', tokenVersion: 0 };
const pair = { token: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: new Date(Date.now() + 604800000), accessExpiresAt: new Date(Date.now() + 900000) };
const request = (path: string, cookie = '', body?: object) => new NextRequest(`http://localhost/api/auth/${path}`, {
  method: 'POST', headers: { cookie, 'Content-Type': 'application/json', origin: 'http://localhost' }, body: body ? JSON.stringify(body) : undefined,
});
beforeEach(() => {
  jest.resetAllMocks();
  process.env.AUTH_TRUSTED_ORIGINS = 'http://localhost';
  process.env.JWT_SECRET = 'synthetic-session-route-secret-for-tests';
  (createSession as jest.Mock).mockResolvedValue(pair);
  (rotateSession as jest.Mock).mockResolvedValue(pair);
  (authorizeSession as jest.Mock).mockResolvedValue(identity);
  (hash as jest.Mock).mockResolvedValue('new-synthetic-hash');
  (compare as jest.Mock).mockResolvedValue(true);
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', email: 'fixture@example.test', name: 'Fixture', passwordHash: 'synthetic-hash', disabledAt: null,
    memberships: [{ organizationId: '00000000-0000-4000-8000-000000000002', role: 'admin', organization: { id: '00000000-0000-4000-8000-000000000002', name: 'Fixture', slug: 'fixture' } }] });
});
const validLogin = { email: 'fixture@example.test', password: 'synthetic-password' };

it('password login returns session cookies only after successful server session creation', async () => {
  const res = await login(request('login', '', validLogin));
  expect(res.status).toBe(200);
  expect(createSession).toHaveBeenCalledWith({ userId: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002', role: 'admin' }, 'synthetic-hash');
  for (const name of ['auth-token', 'refresh-token']) {
    expect(res.cookies.get(name)).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  }
  expect(res.cookies.get('auth-token')!.expires).toEqual(pair.accessExpiresAt);
  expect(res.cookies.get('refresh-token')!.expires).toEqual(pair.expiresAt);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
});
it('rejects wrong passwords and disabled users without creating sessions', async () => {
  (compare as jest.Mock).mockResolvedValue(false);
  expect((await login(request('login', '', validLogin))).status).toBe(401);
  (compare as jest.Mock).mockResolvedValue(true);
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ disabledAt: new Date() });
  expect((await login(request('login', '', validLogin))).status).toBe(401);
  expect(createSession).not.toHaveBeenCalled();
});
it('never sends credentials when the session transaction fails', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  (createSession as jest.Mock).mockRejectedValue(new Error('synthetic database failure'));
  const res = await login(request('login', '', validLogin));
  expect(res.status).toBe(500);
  expect(res.headers.has('Set-Cookie')).toBe(false);
  log.mockRestore();
});
it('requires access credentials for APIs; refresh alone cannot authenticate', async () => {
  const res = await authenticate(request('me', 'refresh-token=synthetic-refresh'));
  expect(res).toBeInstanceOf(Response);
  expect(await (res as Response).json()).toMatchObject({ code: 'AUTH_EXPIRED' });
  expect(authorizeSession).not.toHaveBeenCalled();
});
it('checks the live session and role after verifying the access token', async () => {
  (authorizeSession as jest.Mock).mockResolvedValue({ ...identity, role: 'member' });
  const auth = await authenticate(request('me', `auth-token=${await createToken(identity)}`));
  expect(authorizeSession).toHaveBeenCalledWith(identity);
  expect(requireAdmin(auth as typeof identity)?.status).toBe(403);
});
it('returns a definitive authentication-required response for revoked sessions', async () => {
  (authorizeSession as jest.Mock).mockRejectedValue(new SessionError());
  const res = await authenticate(request('me', `auth-token=${await createToken(identity)}`));
  expect(await (res as Response).json()).toMatchObject({ code: 'AUTH_REQUIRED' });
});
it.each(['REFRESH_CONFLICT', 'AUTH_REQUIRED'])('does not overwrite shared cookies on refresh rejection: %s', async code => {
  (rotateSession as jest.Mock).mockRejectedValue(new SessionError(code as 'AUTH_REQUIRED'));
  const res = await refresh(request('refresh', 'refresh-token=synthetic-refresh'));
  expect(res.status).toBe(code === 'REFRESH_CONFLICT' ? 409 : 401);
  expect(res.headers.has('Set-Cookie')).toBe(false);
  expect(await res.json()).toMatchObject({ code });
});
it('uses 503 for refresh transaction failures, keeping client recovery possible', async () => {
  (rotateSession as jest.Mock).mockRejectedValue(new Error('synthetic database failure'));
  const res = await refresh(request('refresh', 'refresh-token=synthetic-refresh'));
  expect(res.status).toBe(503);
  expect(res.headers.has('Set-Cookie')).toBe(false);
});
it('rotates both cookies together and requires a refresh cookie', async () => {
  expect((await refresh(request('refresh'))).status).toBe(401);
  const res = await refresh(request('refresh', 'refresh-token=synthetic-refresh'));
  expect(res.status).toBe(200);
  expect(res.cookies.get('auth-token')!.value).toBe(pair.token);
  expect(res.cookies.get('refresh-token')!.value).toBe(pair.refreshToken);
});
it('revokes the session before clearing both cookies on logout', async () => {
  const res = await logout(request('logout', 'auth-token=synthetic-access; refresh-token=synthetic-refresh'));
  expect(revokeSession).toHaveBeenCalledWith('synthetic-access', 'synthetic-refresh');
  expect(res.cookies.get('auth-token')!.maxAge).toBe(0);
  expect(res.cookies.get('refresh-token')!.maxAge).toBe(0);
});
it('changes password through the revocation transaction and clears cookies', async () => {
  const res = await password(request('password', `auth-token=${await createToken(identity)}`, { currentPassword: 'synthetic-password', newPassword: 'another-synthetic-password' }));
  expect(res.status).toBe(200);
  expect(changeUserPassword).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'synthetic-hash', expect.any(String));
  expect(res.cookies.get('refresh-token')!.maxAge).toBe(0);
});

it('revokes bearer-authenticated sessions on logout too', async () => {
  const req = new NextRequest('http://localhost/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer synthetic-access' } });
  expect((await logout(req)).status).toBe(200);
  expect(revokeSession).toHaveBeenCalledWith('synthetic-access', undefined);
});

it('uses identical external login errors for absent, disabled, wrong-password and membershipless accounts', async () => {
  const cases = [null, { disabledAt: new Date(), passwordHash: 'synthetic-hash' }, { disabledAt: null, passwordHash: 'synthetic-hash', memberships: [] }];
  for (const user of cases) {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
    const response = await login(request('login', '', validLogin));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid email or password' });
  }
  expect(compare).toHaveBeenCalledTimes(3);
  expect(createSession).not.toHaveBeenCalled();
});

it.each([refresh, logout])('rejects cross-origin cookie writes and missing Origin before session work', async handler => {
  for (const origin of [undefined, 'http://untrusted.localhost', 'null']) {
    const req = new NextRequest('http://localhost/api/auth/refresh', {
      method: 'POST', headers: { cookie: 'refresh-token=synthetic-refresh', ...(origin ? { origin, 'sec-fetch-site': 'same-site' } : {}) },
    });
    expect((await handler(req)).status).toBe(403);
  }
  expect(rotateSession).not.toHaveBeenCalled();
  expect(revokeSession).not.toHaveBeenCalled();
});
