import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';

export interface WorkOwner { userId: string; organizationId: string }
export class AdmissionError extends Error {
  constructor(public readonly unavailable = false) {
    super(unavailable ? 'Work admission temporarily unavailable' : 'Work budget exhausted; retry later');
  }
}
const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
export const admissionLimits = {
  queued: [positive('WORK_PRINCIPAL_QUEUED', 32), positive('WORK_ORG_QUEUED', 128), positive('WORK_GLOBAL_QUEUED', 4096)],
  active: [positive('WORK_PRINCIPAL_ACTIVE', 2), positive('WORK_ORG_ACTIVE', 4), positive('WORK_GLOBAL_ACTIVE', 16)],
  // Uniform reservation units make checking every budget constant time.
  unitBytes: positive('WORK_RESERVATION_BYTES', 1024 * 1024),
  stagedUnits: [positive('WORK_PRINCIPAL_STAGED_UNITS', 32), positive('WORK_ORG_STAGED_UNITS', 128), positive('WORK_GLOBAL_STAGED_UNITS', 4096)],
  queuedMs: positive('WORK_QUEUE_LEASE_MS', 24 * 60 * 60 * 1000),
  activeMs: positive('WORK_ACTIVE_LEASE_MS', 120000),
};
// A single organization must leave capacity for others even under misconfiguration.
for (const limits of [admissionLimits.queued, admissionLimits.active, admissionLimits.stagedUnits]) {
  limits[2] = Math.max(2, limits[2]);
  limits[1] = Math.min(limits[1], Math.floor(limits[2] / 2));
  limits[0] = Math.min(limits[0], limits[1]);
}
let client: Redis | undefined;
let connecting: Promise<unknown> | undefined;
export async function admissionRedis(): Promise<Redis> {
  client ??= new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
    connectTimeout: 1000, commandTimeout: 1500, retryStrategy: () => 1000,
  }).on('error', () => {});
  if (client.status === 'wait') connecting = client.connect().finally(() => { connecting = undefined; });
  if (connecting) await connecting;
  return client;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function budgetKeys(owner: WorkOwner, stage: 'queued' | 'active') {
  return [`p:${owner.userId}`, `o:${owner.organizationId}`, 'global'].map(scope => `work:{admission}:${stage}:${hash(scope)}`);
}
// Each member represents one fixed-size reservation unit. All three scopes are
// checked before any mutation. Cardinalities are capped; stale cleanup is bounded
// by configured capacity. All keys share a Redis Cluster hash slot.
export const RESERVE = `
local t = redis.call('TIME')
local now = t[1]*1000 + math.floor(t[2]/1000)
local units = tonumber(ARGV[3])
for i=1,#KEYS do
 local stale = redis.call('ZRANGEBYSCORE', KEYS[i], '-inf', now, 'LIMIT', 0, 256)
 for _,member in ipairs(stale) do
  local jobkey = string.match(member, '^(bull:.*):%d+$')
  if jobkey and redis.call('EXISTS', jobkey) == 1 and not redis.call('HGET', jobkey, 'finishedOn') then
   redis.call('ZADD', KEYS[i], now+tonumber(ARGV[2]), member)
  else
   redis.call('ZREM', KEYS[i], member)
  end
 end
end
if redis.call('ZSCORE', KEYS[1], ARGV[1] .. ':1') then return 2 end
for i=1,#KEYS do
 if redis.call('ZCARD', KEYS[i]) + units > tonumber(ARGV[3+i]) then return 0 end
end
for i=1,#KEYS do
 for u=1,units do redis.call('ZADD', KEYS[i], now+tonumber(ARGV[2]), ARGV[1] .. ':' .. u) end
 if string.find(KEYS[i], ':active:') then redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[2])*2) end
end
return 1`;
export const RELEASE = `
for i=1,#KEYS do
 for u=1,tonumber(ARGV[2]) do redis.call('ZREM', KEYS[i], ARGV[1] .. ':' .. u) end
end
return 1`;
export const RENEW = `
local t = redis.call('TIME')
local now = t[1]*1000 + math.floor(t[2]/1000)
for i=1,#KEYS do
 local score = redis.call('ZSCORE', KEYS[i], ARGV[1] .. ':1')
 if not score or tonumber(score) <= now then return 0 end
end
for i=1,#KEYS do
 for u=1,tonumber(ARGV[2]) do redis.call('ZADD', KEYS[i], 'XX', now+tonumber(ARGV[3]), ARGV[1] .. ':' .. u) end
 redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[3])*2)
end
return 1`;
export async function reserve(owner: WorkOwner, stage: 'queued' | 'active', id: string = randomUUID(), bytes = 0, lane?: string) {
  const units = stage === 'queued' ? Math.max(1, Math.ceil(bytes / admissionLimits.unitBytes)) : 1;
  const limits = stage === 'queued' ? admissionLimits.queued.map((v, i) => Math.min(v, admissionLimits.stagedUnits[i])) : [...admissionLimits.active];
  if (units > 128 || units > Math.min(...limits)) throw new AdmissionError();
  const keys = budgetKeys(owner, stage);
  if (stage === 'active' && lane) {
    keys.push(`work:{admission}:active:lane:${hash(`${lane}:${owner.organizationId}`)}`);
    limits.push(1);
  }
  const ttl = stage === 'queued' ? admissionLimits.queuedMs : admissionLimits.activeMs;
  let redis: Redis;
  let result: unknown;
  try {
    redis = await admissionRedis();
    result = await redis.eval(RESERVE, keys.length, ...keys, id, ttl, units, ...limits);
  } catch { throw new AdmissionError(true); }
  if (!result) throw new AdmissionError();
  return {
    id, existing: result === 2,
    async release() { await redis.eval(RELEASE, keys.length, ...keys, id, units); },
    async renew() {
      if (await redis.eval(RENEW, keys.length, ...keys, id, units, ttl) !== 1) throw new AdmissionError(true);
    },
  };
}

export async function withWork<T>(owner: WorkOwner, run: () => Promise<T>, bytes = 0, activeOnly = false, lane?: string): Promise<T> {
  const queued = activeOnly ? undefined : await reserve(owner, 'queued', randomUUID(), bytes);
  let active: Awaited<ReturnType<typeof reserve>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let lost = false;
  try {
    active = await reserve(owner, 'active', randomUUID(), 0, lane);
    timer = setInterval(() => {
      void active!.renew().catch(() => { lost = true; });
    }, Math.max(100, Math.floor(admissionLimits.activeMs / 3)));
    timer.unref();
    const result = await run();
    if (lost) throw new AdmissionError(true);
    return result;
  } finally {
    if (timer) clearInterval(timer);
    // Failure to release is conservative: leases recover through expiry.
    await active?.release().catch(() => {});
    await queued?.release().catch(() => {});
  }
}
