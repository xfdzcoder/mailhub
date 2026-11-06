import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import type { Prisma } from '@prisma/client';
import type { JWTPayload } from './types';
import { ABSOLUTE_SESSION_MAX_AGE, ACCESS_TOKEN_MAX_AGE, REFRESH_TOKEN_MAX_AGE, createToken, createRefreshToken, verifyToken, verifyRefreshToken, type SessionClaims } from './jwt';

export class SessionError extends Error {
  constructor(public code: 'AUTH_REQUIRED' | 'REFRESH_CONFLICT' = 'AUTH_REQUIRED') { super(code); }
}
export const refreshDigest = (token: string) => createHash('sha256').update(token).digest('hex');
const boundedExpiry = (seconds: number, absolute: Date) => new Date(Math.min(Date.now() + seconds * 1000, absolute.getTime()));

// All credential mutations lock the user first, then the session. This serializes
// login/refresh with password changes and disabling without cross-session deadlocks.
export async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.disabledAt) throw new SessionError();
  return user;
}

async function membership(tx: Prisma.TransactionClient, userId: string, organizationId: string) {
  const member = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
  if (!member || (member.role !== 'admin' && member.role !== 'member')) throw new SessionError();
  return member;
}

async function credentials(claims: SessionClaims, absolute: Date) {
  const expiresAt = boundedExpiry(REFRESH_TOKEN_MAX_AGE, absolute);
  const accessExpiresAt = boundedExpiry(ACCESS_TOKEN_MAX_AGE, absolute);
  const token = await createToken(claims, accessExpiresAt);
  const refreshToken = await createRefreshToken(claims, expiresAt);
  return { token, refreshToken, expiresAt, accessExpiresAt };
}

// expectedPasswordHash closes the compare-password / create-session race.
export async function createSession(payload: JWTPayload, expectedPasswordHash: string) {
  return prisma.$transaction(async tx => {
    const user = await lockUser(tx, payload.userId);
    if (user.passwordHash !== expectedPasswordHash) throw new SessionError();
    const member = await membership(tx, payload.userId, payload.organizationId);
    const id = randomUUID();
    const absoluteExpiresAt = new Date(Date.now() + ABSOLUTE_SESSION_MAX_AGE * 1000);
    const pair = await credentials({ ...payload, role: member.role as 'admin' | 'member', sessionId: id, tokenVersion: 0 }, absoluteExpiresAt);
    await tx.authSession.create({ data: {
      id, userId: payload.userId, organizationId: payload.organizationId, familyId: id,
      refreshTokenHash: refreshDigest(pair.refreshToken), expiresAt: pair.expiresAt, absoluteExpiresAt,
    } });
    return pair;
  });
}

export async function authorizeSession(claims: SessionClaims, refreshToken?: string): Promise<SessionClaims> {
  const session = await prisma.authSession.findUnique({ where: { id: claims.sessionId }, include: { user: { select: { disabledAt: true } } } });
  const now = Date.now();
  if (!session || session.userId !== claims.userId || session.organizationId !== claims.organizationId ||
      (refreshToken !== undefined && (session.refreshTokenHash !== refreshDigest(refreshToken) || session.tokenVersion !== claims.tokenVersion)) ||
      session.revokedAt || session.user.disabledAt || session.expiresAt.getTime() <= now || session.absoluteExpiresAt.getTime() <= now) {
    throw new SessionError();
  }
  const member = await membership(prisma, claims.userId, claims.organizationId);
  return { ...claims, role: member.role as 'admin' | 'member' };
}

export async function verifySessionToken(token: string) {
  return authorizeSession(await verifyToken(token));
}

export async function rotateSession(token: string) {
  let claims: SessionClaims;
  try { claims = await verifyRefreshToken(token); } catch { throw new SessionError(); }
  const result = await prisma.$transaction(async tx => {
    await lockUser(tx, claims.userId);
    await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${claims.sessionId}::uuid FOR UPDATE`;
    const session = await tx.authSession.findUnique({ where: { id: claims.sessionId } });
    const now = new Date();
    if (!session || session.userId !== claims.userId || session.organizationId !== claims.organizationId ||
        session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now) throw new SessionError();
    const member = await membership(tx, claims.userId, claims.organizationId);
    if (session.tokenVersion !== claims.tokenVersion || session.refreshTokenHash !== refreshDigest(token)) {
      // A bounded conflict response permits another tab to use the winning cookie.
      // Never accept the old token or send credentials/cookie deletions on conflict.
      if (claims.tokenVersion === session.tokenVersion - 1 && session.rotatedAt && now.getTime() - session.rotatedAt.getTime() < 5000) {
        return { code: 'REFRESH_CONFLICT' as const };
      }
      // Return instead of throwing so family revocation commits.
      await tx.authSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: now } });
      return { code: 'AUTH_REQUIRED' as const };
    }
    const pair = await credentials({ ...claims, role: member.role as 'admin' | 'member', tokenVersion: session.tokenVersion + 1 }, session.absoluteExpiresAt);
    await tx.authSession.update({ where: { id: session.id }, data: {
      refreshTokenHash: refreshDigest(pair.refreshToken), tokenVersion: { increment: 1 }, rotatedAt: now, expiresAt: pair.expiresAt,
    } });
    return pair;
  });
  if ('code' in result) throw new SessionError(result.code);
  return result;
}

export async function revokeSession(access?: string, refresh?: string) {
  let claims: SessionClaims | undefined;
  if (refresh) { try { claims = await verifyRefreshToken(refresh); } catch { /* Try access. */ } }
  if (!claims && access) { try { claims = await verifyToken(access); } catch { /* Invalid cookies still get cleared. */ } }
  if (claims) await prisma.authSession.updateMany({
    where: { id: claims.sessionId, userId: claims.userId, organizationId: claims.organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function changeUserPassword(userId: string, expectedHash: string, passwordHash: string) {
  await prisma.$transaction(async tx => {
    const user = await lockUser(tx, userId);
    if (user.passwordHash !== expectedHash) throw new SessionError();
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
}

// Administrative service: disabling a user is global, unlike removing one org membership.
export async function disableUser(userId: string) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    const now = new Date();
    await tx.user.update({ where: { id: userId }, data: { disabledAt: now } });
    await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  });
}
