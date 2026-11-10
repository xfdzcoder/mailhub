import { createHash } from 'node:crypto';
import { admissionRedis, AdmissionError, type WorkOwner } from './admission';

// SMTP cannot provide exactly-once delivery. Preserve an uncertainty marker
// before contacting it; exceptions (including partial RCPT acceptance) never
// clear the marker. A caller must investigate rather than blindly retry.
export const CLAIM_SEND = `
local t = redis.call('TIME')
local now = tonumber(t[1])
for i=1,#KEYS do
 local stale = redis.call('ZRANGEBYSCORE', KEYS[i], '-inf', now, 'LIMIT', 0, 256)
 for _,member in ipairs(stale) do redis.call('ZREM', KEYS[i], member) end
end
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 2 end
for i=1,#KEYS do
 if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i+1]) then return 0 end
end
for i=1,#KEYS do
 redis.call('ZADD', KEYS[i], now+86400*7, ARGV[1])
 redis.call('EXPIRE', KEYS[i], 86400*8)
end
return 1`;
export async function claimSend(owner: WorkOwner, accountId: string, input: unknown): Promise<boolean> {
  const hash = createHash('sha256').update(JSON.stringify([owner.userId, owner.organizationId, accountId, input])).digest('hex');
  const scope = createHash('sha256').update(`${owner.organizationId}:${owner.userId}`).digest('hex');
  try {
    const redis = await admissionRedis();
    const org = createHash('sha256').update(owner.organizationId).digest('hex');
    const result = await redis.eval(CLAIM_SEND, 3, `work:{admission}:send:${scope}`, `work:{admission}:send:org:${org}`, 'work:{admission}:send:global', hash, 1000, 10000, 100000);
    if (result === 0) throw new AdmissionError();
    return result === 1;
  } catch (error) {
    if (error instanceof AdmissionError) throw error;
    throw new AdmissionError(true);
  }
}
