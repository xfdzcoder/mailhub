import { ECDH } from 'node:crypto';
import webpush from 'web-push';
import { modelUrl, postWithPolicy, resolveOriginTarget } from '@/lib/network/origin-policy';
import { redis } from '@/lib/redis';

export const PUSH_DEVICE_LIMIT = 10;
export class PushValidationError extends Error {}
export class PushBudgetError extends Error {}
export interface PushDestination {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function validatePushDestination(subscription: PushDestination) {
  try {
    if (subscription.endpoint.length > 2048) throw new Error();
    const url = modelUrl(subscription.endpoint, true);
    if (url.protocol !== 'https:' || url.href !== subscription.endpoint) throw new Error();
    for (const [name, length] of [['p256dh', 65], ['auth', 16]] as const) {
      const value = subscription.keys[name];
      if (value.length !== Math.ceil(length * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.length !== length || bytes.toString('base64url') !== value) throw new Error();
      if (name === 'p256dh' && (bytes[0] !== 4 || ECDH.convertKey(bytes, 'prime256v1').length !== 65)) throw new Error();
    }
    return url;
  } catch { throw new PushValidationError('Invalid push destination or keys'); }
}

export async function approvePushDestination(subscription: PushDestination) {
  const url = validatePushDestination(subscription);
  // Bound registration DNS as well as dispatch DNS.
  const signal = AbortSignal.timeout(5000);
  await Promise.race([
    resolveOriginTarget('push', url),
    new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new PushValidationError('Push approval deadline exceeded')), { once: true })),
  ]);
}

/** Atomic, shared fixed-window budget; unavailable Redis denies delivery/registration. */
export async function consumePushBudget(userId: string, action: 'register' | 'send') {
  const limit = action === 'register' ? 20 : 60;
  const signal = AbortSignal.timeout(2000);
  const count = await Promise.race([
    redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", 1, `push:${action}:${userId}`),
    new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new PushBudgetError('Push budget unavailable')), { once: true })),
  ]);
  if (!Number.isSafeInteger(Number(count)) || Number(count) < 1) throw new PushBudgetError('Push budget unavailable');
  if (Number(count) > limit) throw new PushBudgetError('Push rate limit exceeded');
}

export async function sendPush(subscription: PushDestination, userId: string, payload: string) {
  validatePushDestination(subscription);
  await consumePushBudget(userId, 'send');
  const details = webpush.generateRequestDetails(subscription, payload, {
    vapidDetails: {
      subject: process.env.VAPID_SUBJECT || 'mailto:support@mailhub.local',
      publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
      privateKey: process.env.VAPID_PRIVATE_KEY!,
    },
  });
  const result = await postWithPolicy('push', subscription.endpoint, details.headers as Record<string, string>, details.body || '',
    { connectMs: 5000, totalMs: 10000, responseBytes: 4096 });
  if (result.status < 200 || result.status >= 300) throw Object.assign(new Error('Push provider rejected delivery'), { statusCode: result.status });
}

/** Diagnostics deliberately exclude endpoints, keys, response bodies and network addresses. */
export function reportPushFailure(error: unknown) {
  console.warn('Push delivery rejected', { code: error instanceof PushValidationError ? 'INVALID_DESTINATION' : error instanceof PushBudgetError ? 'BUDGET' : 'POLICY_OR_DELIVERY' });
}
