import { randomUUID } from 'node:crypto';

jest.mock('@/lib/db/prisma', () => ({ prisma: {
  $transaction: jest.fn(), $queryRaw: jest.fn(),
  user: { findUnique: jest.fn(), update: jest.fn() },
  organizationMember: { findUnique: jest.fn() },
  authSession: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
} }));
import { prisma } from '@/lib/db/prisma';
import { createSession, rotateSession, authorizeSession, refreshDigest, revokeSession, changeUserPassword, disableUser } from '@/lib/auth/sessions';
import { verifyToken, verifyRefreshToken, ABSOLUTE_SESSION_MAX_AGE } from '@/lib/auth/jwt';

const db = prisma as unknown as {
  $transaction: jest.Mock; $queryRaw: jest.Mock;
  user: { findUnique: jest.Mock; update: jest.Mock };
  organizationMember: { findUnique: jest.Mock };
  authSession: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
};
const identity = { userId: randomUUID(), organizationId: randomUUID(), role: 'admin' as const };
let user: { id: string; passwordHash: string; disabledAt: Date | null };
type Row = { id: string; familyId: string; userId: string; organizationId: string; refreshTokenHash: string; tokenVersion: number; expiresAt: Date; absoluteExpiresAt: Date; revokedAt: Date | null; rotatedAt: Date | null };
let row: Row | undefined;
let member: { role: string } | null;
let failUpdate: boolean;
let queue: Promise<unknown>;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = 'synthetic-session-secret-for-isolated-fixtures';
  user = { id: identity.userId, passwordHash: 'synthetic-hash', disabledAt: null };
  row = undefined; member = { role: 'admin' }; failUpdate = false; queue = Promise.resolve();
  // Synthetic transaction harness: serial execution and rollback, no network/DB.
  db.$transaction.mockImplementation(callback => {
    const operation = queue.then(async () => {
      const previousRow = row ? { ...row } : undefined;
      const previousUser = { ...user };
      try { return await callback(prisma); } catch (error) { row = previousRow; user = previousUser; throw error; }
    });
    queue = operation.catch(() => undefined);
    return operation;
  });
  db.$queryRaw.mockResolvedValue([]);
  db.user.findUnique.mockImplementation(async () => user);
  db.user.update.mockImplementation(async ({ data }) => Object.assign(user, data));
  db.organizationMember.findUnique.mockImplementation(async () => member);
  db.authSession.create.mockImplementation(async ({ data }) => { row = { tokenVersion: 0, revokedAt: null, rotatedAt: null, ...data }; return row; });
  db.authSession.findUnique.mockImplementation(async () => row ? { ...row, user: { ...user } } : null);
  db.authSession.update.mockImplementation(async ({ data }) => {
    if (failUpdate) throw new Error('synthetic transaction failure');
    Object.assign(row!, { ...data, tokenVersion: row!.tokenVersion + 1 }); return row;
  });
  db.authSession.updateMany.mockImplementation(async ({ data }) => { Object.assign(row!, data); return { count: 1 }; });
});
afterEach(() => jest.useRealTimers());
const login = () => createSession(identity, 'synthetic-hash');

it('creates a server session storing only a digest and bounded lifetimes', async () => {
  const pair = await login();
  const claims = await verifyToken(pair.token);
  expect(claims.sessionId).toBe(row!.id);
  expect(row!.refreshTokenHash).toBe(refreshDigest(pair.refreshToken));
  expect(JSON.stringify(row)).not.toContain(pair.refreshToken);
  expect(row!.familyId).toBe(row!.id);
  expect(row!.absoluteExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(ABSOLUTE_SESSION_MAX_AGE * 1000);
  expect(pair.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86400000);
  expect(await authorizeSession(claims)).toEqual(claims);
});
it('prevents login after a concurrent password change or disabling', async () => {
  user.passwordHash = 'changed';
  await expect(login()).rejects.toThrow('AUTH_REQUIRED');
  user.passwordHash = 'synthetic-hash'; user.disabledAt = new Date();
  await expect(login()).rejects.toThrow('AUTH_REQUIRED');
  expect(db.authSession.create).not.toHaveBeenCalled();
});
it('uses current membership roles and rejects removal without changing other sessions', async () => {
  const claims = await verifyToken((await login()).token);
  member = { role: 'member' };
  expect((await authorizeSession(claims)).role).toBe('member');
  member = null;
  await expect(authorizeSession(claims)).rejects.toThrow('AUTH_REQUIRED');
  expect(db.authSession.updateMany).not.toHaveBeenCalled();
});
it.each(['expiresAt', 'absoluteExpiresAt', 'revokedAt', 'disabledAt'])('rejects inactive session: %s', async field => {
  const pair = await login(); const claims = await verifyToken(pair.token);
  if (field === 'disabledAt') user.disabledAt = new Date();
  else Object.assign(row!, { [field]: new Date(Date.now() - 1000) });
  await expect(authorizeSession(claims)).rejects.toThrow('AUTH_REQUIRED');
  await expect(rotateSession(pair.refreshToken)).rejects.toThrow('AUTH_REQUIRED');
});
it('binds access to the user and organization in the server row', async () => {
  const claims = await verifyToken((await login()).token);
  await expect(authorizeSession({ ...claims, userId: randomUUID() })).rejects.toThrow();
  await expect(authorizeSession({ ...claims, organizationId: randomUUID() })).rejects.toThrow();
});
it('rotates to a unique credential even within the same second; old access stays bounded', async () => {
  const first = await login(); const second = await rotateSession(first.refreshToken);
  expect(second.refreshToken).not.toBe(first.refreshToken);
  expect((await verifyRefreshToken(second.refreshToken)).tokenVersion).toBe(1);
  expect(row!.refreshTokenHash).toBe(refreshDigest(second.refreshToken));
  expect(await authorizeSession(await verifyToken(first.token))).toBeDefined();
});
it('permits exactly one concurrent refresh and returns a recoverable conflict for the loser', async () => {
  const first = await login();
  const results = await Promise.allSettled([rotateSession(first.refreshToken), rotateSession(first.refreshToken)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'REFRESH_CONFLICT' } });
  expect(row!.tokenVersion).toBe(1);
  expect(row!.revokedAt).toBeNull();
  const locks = db.$queryRaw.mock.calls.map(([sql, id]) => ({ sql: sql.join('?'), id }));
  expect(locks).toEqual([
    { sql: 'SELECT id FROM users WHERE id = ?::uuid FOR UPDATE', id: identity.userId },
    { sql: 'SELECT id FROM users WHERE id = ?::uuid FOR UPDATE', id: identity.userId },
    { sql: 'SELECT id FROM auth_sessions WHERE id = ?::uuid FOR UPDATE', id: row!.id },
    { sql: 'SELECT id FROM users WHERE id = ?::uuid FOR UPDATE', id: identity.userId },
    { sql: 'SELECT id FROM auth_sessions WHERE id = ?::uuid FOR UPDATE', id: row!.id },
  ]);
});
it('revokes the family on replay outside the conflict window and commits that revocation', async () => {
  const first = await login(); const second = await rotateSession(first.refreshToken);
  jest.useFakeTimers().setSystemTime(Date.now() + 6000);
  await expect(rotateSession(first.refreshToken)).rejects.toThrow('AUTH_REQUIRED');
  expect(db.authSession.updateMany).toHaveBeenCalledWith({ where: { familyId: row!.familyId, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  expect(row!.revokedAt).toBeInstanceOf(Date);
  await expect(rotateSession(second.refreshToken)).rejects.toThrow('AUTH_REQUIRED');
});
it('bounds rolling refresh and access expiry by the original absolute deadline', async () => {
  const first = await login();
  row!.absoluteExpiresAt = new Date(Date.now() + 60000);
  const second = await rotateSession(first.refreshToken);
  expect(second.expiresAt).toEqual(row!.absoluteExpiresAt);
  expect(second.accessExpiresAt).toEqual(row!.absoluteExpiresAt);
});
it('preserves the usable credential if rotation cannot commit', async () => {
  const first = await login(); const digest = row!.refreshTokenHash;
  failUpdate = true;
  await expect(rotateSession(first.refreshToken)).rejects.toThrow('synthetic transaction failure');
  expect(row!.refreshTokenHash).toBe(digest);
  expect(row!.tokenVersion).toBe(0);
  failUpdate = false;
  await expect(rotateSession(first.refreshToken)).resolves.toBeDefined();
});
it('logout revokes only the current session and rejects its access and refresh credentials', async () => {
  const pair = await login();
  await revokeSession(pair.token, pair.refreshToken);
  expect(db.authSession.updateMany.mock.calls[0][0].where).toEqual({ id: row!.id, userId: identity.userId, organizationId: identity.organizationId, revokedAt: null });
  await expect(authorizeSession(await verifyToken(pair.token))).rejects.toThrow();
  await expect(rotateSession(pair.refreshToken)).rejects.toThrow();
});
it('password changes and disabling revoke all sessions for only the relevant user', async () => {
  await login();
  await changeUserPassword(user.id, user.passwordHash, 'new-synthetic-hash');
  expect(user.passwordHash).toBe('new-synthetic-hash');
  expect(db.authSession.updateMany.mock.calls[0][0].where).toEqual({ userId: user.id, revokedAt: null });
  await disableUser(user.id);
  expect(user.disabledAt).toBeInstanceOf(Date);
  expect(db.authSession.updateMany.mock.calls[1][0].where).toEqual({ userId: user.id, revokedAt: null });
});
it('rolls back a password change if session revocation fails', async () => {
  await login();
  db.authSession.updateMany.mockRejectedValueOnce(new Error('synthetic revocation failure'));
  await expect(changeUserPassword(user.id, user.passwordHash, 'new')).rejects.toThrow();
  expect(user.passwordHash).toBe('synthetic-hash');
  expect(row!.revokedAt).toBeNull();
});
