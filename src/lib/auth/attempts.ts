import Redis from 'ioredis';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { NextRequest, NextResponse } from 'next/server';
import { requestPolicy } from './request-policy';
import { verifyRefreshToken, verifyToken } from './jwt';

let client: Redis | undefined;
let connecting: Promise<unknown> | undefined;
async function connection() {
  client ??= new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true, connectTimeout: 1000,
    commandTimeout: 1500, retryStrategy: () => 1000,
  }).on('error', () => {});
  if (client.status === 'wait') connecting = client.connect().finally(() => { connecting = undefined; });
  if (connecting) await connecting;
  return client;
}
// One atomic operation checks every budget before consuming any. Redis time avoids
// application clock skew; expiring leases bound abandoned/crashed requests.
export const ACQUIRE = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
for i=1,#KEYS,2 do
 redis.call('ZREMRANGEBYSCORE', KEYS[i+1], '-inf', now)
 if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[i+1]) or redis.call('ZCARD', KEYS[i+1]) >= tonumber(ARGV[i+2]) then return 0 end
end
for i=1,#KEYS,2 do
 local n = redis.call('INCR', KEYS[i])
 if n == 1 then redis.call('PEXPIRE', KEYS[i], 900000) end
 redis.call('ZADD', KEYS[i+1], now + 120000, ARGV[1])
 redis.call('PEXPIRE', KEYS[i+1], 120000)
end
return 1`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function trustedClient(req: NextRequest): string | null {
  // Only a configured ingress with the shared proof may assert an IP. The
  // ingress must strip and overwrite both proof and client-IP headers. X-Forwarded-For is never consulted.
  const header = process.env.AUTH_TRUSTED_CLIENT_IP_HEADER;
  const secret = process.env.AUTH_TRUSTED_PROXY_SECRET;
  if (!secret || secret.length < 32) return null;
  const proof = req.headers.get('x-mailhub-proxy-token') || '';
  if (!timingSafeEqual(createHash('sha256').update(secret).digest(), createHash('sha256').update(proof).digest())) return null;
  if (!header || ['forwarded', 'x-forwarded-for', 'x-real-ip'].includes(header.toLowerCase())) return null;
  const value = req.headers.get(header);
  return value && isIP(value) ? value : null;
}

export async function withAttempts<R extends Response>(req: NextRequest, scope: string, principal: string, run: () => Promise<R>, tenant?: string): Promise<R | NextResponse> {
  const budgets: [string, number, number][] = [[`${scope}:principal:${principal}`, 20, 4]];
  if (tenant) budgets.push([`${scope}:tenant:${tenant}`, 100, 20]);
  const ip = trustedClient(req);
  budgets.push([`${scope}:client:${ip || 'unattributed'}`, 500, 40]);
  const keys = budgets.flatMap(([key]) => { const hash = digest(key); return [`auth:{attempts}:${hash}:count`, `auth:{attempts}:${hash}:active`]; });
  const lease = randomUUID();
  let redis: Redis;
  try {
    redis = await connection();
    const admitted = await redis.eval(ACQUIRE, keys.length, ...keys, lease, ...budgets.flatMap(([, count, concurrency]) => [count, concurrency]));
    if (admitted !== 1) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': '900', 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Authentication temporarily unavailable' }, { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } });
  }
  try { return await run(); } finally {
    await Promise.all(keys.filter((_, i) => i % 2 === 1).map(key => redis.zrem(key, lease).catch(() => {})));
  }
}

export function protectAuthentication<R extends Response>(scope: string, handler: (req: NextRequest) => Promise<R>) {
  return async (req: NextRequest) => {
    const denied = requestPolicy(req);
    if (denied) return denied;
    if (['login', 'register'].includes(scope) && req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return NextResponse.json({ error: 'Unsupported content type' }, { status: 415 });
    let principal = 'anonymous';
    if (scope === 'login' || scope === 'register') {
      try {
        const body = await req.clone().json();
        principal = typeof body.email === 'string' ? body.email.trim().toLowerCase() : 'invalid';
      } catch { principal = 'invalid'; }
    } else {
      const refresh = req.cookies.get('refresh-token')?.value;
      const access = req.cookies.get('auth-token')?.value || req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
      try {
        const claims = refresh ? await verifyRefreshToken(refresh) : access ? await verifyToken(access) : null;
        principal = claims ? `${claims.organizationId}:${claims.userId}` : 'invalid';
      } catch { principal = 'invalid'; }
    }
    return withAttempts(req, scope, principal, () => handler(req));
  };
}

export function protectSensitive<Args extends unknown[], R extends Response>(scope: string, handler: (req: NextRequest, ...args: Args) => Promise<R>) {
  return async (req: NextRequest, ...args: Args) => {
    const { authenticate } = await import('./middleware');
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    return withAttempts(req, scope, `${auth.organizationId}:${auth.userId}`, () => handler(req, ...args), auth.organizationId);
  };
}
