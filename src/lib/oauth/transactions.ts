import { createHash, randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import type { SessionClaims } from '@/lib/auth/jwt';

// Separate from BullMQ's indefinitely retrying connection: authorization must fail closed.
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 3000, connectTimeout: 3000,
  retryStrategy: (attempt) => Math.min(attempt * 100, 3000),
});
redis.on('error', () => { /* Callers return a fixed error without logging credentials. */ });

export type OAuthProvider = 'google' | 'microsoft';
type Binding = Pick<SessionClaims, 'sessionId' | 'userId' | 'organizationId'>;
export type OAuthTransaction = Binding & {
  provider: OAuthProvider;
  emailAddress: string;
  label: string;
  redirectUri: string;
  verifier: string;
};
export class OAuthStateError extends Error {}

export function trustedOrigin() {
  // Never derive an OAuth callback or a redirect destination from request headers/URL.
  const url = new URL(process.env.NEXT_PUBLIC_APP_URL || '');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid OAuth application origin');
  }
  return url.origin;
}

export function callbackUri(provider: OAuthProvider) {
  return `${trustedOrigin()}/api/accounts/oauth/${provider}/callback`;
}

export async function createOAuthTransaction(provider: OAuthProvider, auth: Binding, emailAddress: string, label: string) {
  if (!auth.sessionId || !auth.userId || !auth.organizationId) throw new OAuthStateError();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const transaction: OAuthTransaction = { provider, sessionId: auth.sessionId, userId: auth.userId,
    organizationId: auth.organizationId, emailAddress, label, redirectUri: callbackUri(provider), verifier };
  const result = await redis.set(`oauth:transaction:${state}`, JSON.stringify(transaction), 'EX', 600, 'NX');
  if (result !== 'OK') throw new OAuthStateError();
  return { state, challenge: createHash('sha256').update(verifier).digest('base64url'), redirectUri: transaction.redirectUri };
}

// Validate the binding and consume in one Redis operation. A mismatched caller cannot
// burn another session's transaction. All matched callbacks (including rejection) consume it.
export const CONSUME_TRANSACTION = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local t = cjson.decode(raw)
if t.provider ~= ARGV[1] or t.sessionId ~= ARGV[2] or t.userId ~= ARGV[3] or t.organizationId ~= ARGV[4] or t.redirectUri ~= ARGV[5] then return nil end
redis.call('DEL', KEYS[1])
return raw
`;

export async function consumeOAuthTransaction(state: string | null, provider: OAuthProvider, auth: Binding, redirectUri: string) {
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !auth.sessionId) throw new OAuthStateError();
  const raw = await redis.eval(CONSUME_TRANSACTION, 1, `oauth:transaction:${state}`,
    provider, auth.sessionId, auth.userId, auth.organizationId, redirectUri);
  if (typeof raw !== 'string') throw new OAuthStateError();
  return JSON.parse(raw) as OAuthTransaction;
}
