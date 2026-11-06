import { SignJWT, decodeJwt } from 'jose';
import { createToken, createRefreshToken, verifyToken, verifyRefreshToken, TOKEN_ISSUER, TOKEN_AUDIENCE } from '@/lib/auth/jwt';

const claims = { userId: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002', role: 'admin' as const, sessionId: '00000000-0000-4000-8000-000000000003', tokenVersion: 0 };
const secret = 'synthetic-secret-for-isolated-session-tests';
beforeEach(() => { process.env.JWT_SECRET = secret; });
afterEach(() => jest.useRealTimers());

it('issues a 15-minute access token regardless of the legacy lifetime override', async () => {
  process.env.JWT_EXPIRES_IN = '7d';
  const token = await createToken(claims);
  expect(await verifyToken(token)).toEqual(claims);
  const decoded = decodeJwt(token);
  expect(decoded.exp! - decoded.iat!).toBe(900);
  delete process.env.JWT_EXPIRES_IN;
});
it('issues refresh tokens with a separate type and key', async () => {
  const token = await createRefreshToken(claims);
  expect(await verifyRefreshToken(token)).toEqual(claims);
  await expect(verifyToken(token)).rejects.toThrow();
  await expect(verifyRefreshToken(await createToken(claims))).rejects.toThrow();
});
it('rejects expired, malformed and tampered credentials', async () => {
  const token = await createToken(claims);
  jest.useFakeTimers().setSystemTime(Date.now() + 901000);
  await expect(verifyToken(token)).rejects.toThrow();
  await expect(verifyToken('invalid')).rejects.toThrow();
  await expect(verifyToken(token.slice(0, -8) + 'tampered')).rejects.toThrow();
});

async function signed(overrides: Record<string, unknown> = {}, algorithm = 'HS256') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, type: 'access', sub: claims.userId, iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE, iat: now, exp: now + 900, ...overrides })
    .setProtectedHeader({ alg: algorithm, typ: 'JWT' }).sign(new TextEncoder().encode(secret));
}
it.each([
  { type: 'refresh' }, { type: undefined }, { sessionId: undefined }, { sessionId: '' }, { sessionId: 'not-a-uuid' },
  { tokenVersion: -1 }, { tokenVersion: '0' }, { userId: undefined }, { organizationId: 123 },
  { role: 'owner' }, { sub: 'another-user' }, { iss: 'other' }, { aud: 'other' },
  { exp: undefined }, { iat: undefined }, { iat: Math.floor(Date.now() / 1000) + 90 },
  { exp: Math.floor(Date.now() / 1000) + 901 },
])('rejects signed tokens with invalid or legacy claims: %j', async overrides => {
  await expect(verifyToken(await signed(overrides))).rejects.toThrow();
});
it('rejects a signed but unapproved algorithm', async () => {
  await expect(verifyToken(await signed({}, 'HS384'))).rejects.toThrow();
});
