// Endpoint fixtures isolate Redis; distributed policy is exercised separately.
jest.mock('ioredis', () => class {
  on() { return this; }
  async eval() { return 1; }
  async zrem() { return 1; }
});
jest.mock('@/lib/db/prisma', () => ({ prisma: { user: { findUnique: jest.fn() }, $transaction: jest.fn() } }));
jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('synthetic-password-hash') }));
jest.mock('@/lib/auth/sessions', () => ({
  createSession: jest.fn().mockResolvedValue({ token: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: new Date(), accessExpiresAt: new Date() }),
  SessionError: class extends Error {},
}));
jest.mock('@/lib/auth/cookies', () => ({ setSessionCookies: (response: Response) => response }));
jest.mock('@/lib/auth/middleware', () => ({
  apiError: (message: string, status: number) => Response.json({ error: message }, { status }),
  apiResponse: (data: unknown, status: number) => Object.assign(Response.json(data, { status }), { cookies: { set: jest.fn() } }),
}));
jest.mock('@/lib/identifiers', () => ({ createOrganizationSlug: () => 'fixture-org' }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/register/route';
import { prisma } from '@/lib/db/prisma';
import { hash } from 'bcryptjs';
import { createSession } from '@/lib/auth/sessions';
const previousMode = process.env.REGISTRATION_MODE;
const input = { email: 'fixture@example.test', name: 'Fixture', password: 'test-password-only', organizationName: 'Fixture Org' };
function request(body: unknown = input) {
  return new NextRequest('http://localhost/api/auth/register', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => { jest.clearAllMocks(); process.env.AUTH_TRUSTED_ORIGINS = 'http://localhost'; delete process.env.REGISTRATION_MODE; });
afterAll(() => {
  if (previousMode === undefined) delete process.env.REGISTRATION_MODE;
  else process.env.REGISTRATION_MODE = previousMode;
});
it.each([undefined, '', 'closed', 'invite', 'OPEN', 'unexpected'])('fails closed for mode %s before parsing, hashing or database work', async mode => {
  if (mode !== undefined) process.env.REGISTRATION_MODE = mode;
  const req = request();
  const parse = jest.spyOn(req, 'json');
  expect((await POST(req)).status).toBe(403);
  expect(parse).not.toHaveBeenCalled();
  expect(hash).not.toHaveBeenCalled();
  expect(prisma.user.findUnique).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it('preserves input validation when explicitly open', async () => {
  process.env.REGISTRATION_MODE = 'open';
  expect((await POST(request({}))).status).toBe(422);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it('returns the same acceptance for an already claimed address', async () => {
  process.env.REGISTRATION_MODE = 'open';
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'existing' });
  expect((await POST(request())).status).toBe(201);
  expect(hash).toHaveBeenCalled();
});
it('creates an organization and its administrator only when open', async () => {
  process.env.REGISTRATION_MODE = 'open';
  (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
  const membership = jest.fn();
  (prisma.$transaction as jest.Mock).mockImplementation(async callback => callback({
    user: { create: jest.fn().mockResolvedValue({ id: 'user-1', passwordHash: 'synthetic-password-hash' }) },
    organization: { create: jest.fn().mockResolvedValue({ id: 'org-1' }) },
    organizationMember: { create: membership },
  }));
  const response = await POST(request());
  expect(response.status).toBe(201);
  expect(membership).toHaveBeenCalledWith({ data: { organizationId: 'org-1', userId: 'user-1', role: 'admin' } });
  expect(createSession).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({ success: true });
});
it('does not expose an address claimed concurrently', async () => {
  process.env.REGISTRATION_MODE = 'open';
  (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
  (prisma.$transaction as jest.Mock).mockRejectedValue({ code: 'P2002' });
  const response = await POST(request());
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ success: true });
  expect(response.headers.has('set-cookie')).toBe(false);
});
