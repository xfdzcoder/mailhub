import { SignJWT, jwtVerify } from 'jose';
import type { JWTPayload } from './types';

function getSecret(refresh = false): Uint8Array {
  const secret = refresh
    ? process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET
    : process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required');
  return new TextEncoder().encode(refresh ? `${secret}_refresh` : secret);
}

export const ACCESS_TOKEN_MAX_AGE = 15 * 60;
export const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60;
export const ABSOLUTE_SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const ACCESS_TOKEN_EXPIRY = '15m';
export const REFRESH_TOKEN_EXPIRY = '7d';
export const TOKEN_ISSUER = 'mailhub';
export const TOKEN_AUDIENCE = 'mailhub:session';
export type SessionClaims = JWTPayload & { sessionId: string; tokenVersion: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sign(payload: SessionClaims, refresh: boolean, expiresAt?: Date) {
  return new SignJWT({ ...payload, type: refresh ? 'refresh' : 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(expiresAt ? Math.floor(expiresAt.getTime() / 1000) : Math.floor(Date.now() / 1000) + (refresh ? REFRESH_TOKEN_MAX_AGE : ACCESS_TOKEN_MAX_AGE))
    .sign(getSecret(refresh));
}

export function createToken(payload: SessionClaims, expiresAt?: Date): Promise<string> {
  return sign(payload, false, expiresAt);
}

export function createRefreshToken(payload: SessionClaims, expiresAt?: Date): Promise<string> {
  return sign(payload, true, expiresAt);
}

async function verify(token: string, refresh: boolean): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, getSecret(refresh), {
    algorithms: ['HS256'], typ: 'JWT', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE,
    requiredClaims: ['sub', 'iat', 'exp', 'userId', 'organizationId', 'role', 'sessionId', 'tokenVersion', 'type'],
    maxTokenAge: refresh ? REFRESH_TOKEN_MAX_AGE : ACCESS_TOKEN_MAX_AGE,
  });
  if (payload.type !== (refresh ? 'refresh' : 'access') ||
      !['userId', 'organizationId', 'sessionId'].every(key => typeof payload[key] === 'string' && uuid.test(payload[key] as string)) ||
      payload.sub !== payload.userId || !['admin', 'member'].includes(payload.role as string) ||
      !Number.isSafeInteger(payload.tokenVersion) || (payload.tokenVersion as number) < 0 ||
      typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
      payload.iat > Math.floor(Date.now() / 1000) || payload.exp <= payload.iat ||
      payload.exp - payload.iat > (refresh ? REFRESH_TOKEN_MAX_AGE : ACCESS_TOKEN_MAX_AGE)) {
    throw new Error('Invalid session claims');
  }
  return {
    userId: payload.userId as string, organizationId: payload.organizationId as string,
    role: payload.role as 'admin' | 'member', sessionId: payload.sessionId as string,
    tokenVersion: payload.tokenVersion as number,
  };
}

export function verifyToken(token: string): Promise<SessionClaims> { return verify(token, false); }
export function verifyRefreshToken(token: string): Promise<SessionClaims> { return verify(token, true); }
