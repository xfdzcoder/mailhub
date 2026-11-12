jest.mock('@/lib/redis', () => ({ redis: { eval: jest.fn() } }));
jest.mock('@/lib/network/origin-policy', () => ({ ...jest.requireActual('@/lib/network/origin-policy'), postWithPolicy: jest.fn() }));
import { createECDH } from 'node:crypto';
import { validatePushDestination, consumePushBudget, sendPush, reportPushFailure } from '@/lib/notifications/push';
import { redis } from '@/lib/redis';
import { resolveOriginTarget, postWithPolicy } from '@/lib/network/origin-policy';
const ec = createECDH('prime256v1');
ec.generateKeys();
const subscription = { endpoint: 'https://fcm.googleapis.com/sub', keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
it('accepts valid P-256 and auth keys', () => expect(validatePushDestination(subscription).protocol).toBe('https:'));
it.each(['http://fcm.googleapis.com/sub', 'https://user:pass@fcm.googleapis.com/sub', 'https://fcm.googleapis.com/sub#x', 'https://fcm.googleapis.com./sub'])('rejects invalid URL %s', endpoint => expect(() => validatePushDestination({ ...subscription, endpoint })).toThrow());
it.each(['key', '====', Buffer.alloc(65).toString('base64url')])('rejects malformed curve keys', p256dh => expect(() => validatePushDestination({ ...subscription, keys: { ...subscription.keys, p256dh } })).toThrow());
it('rejects wrong auth length', () => expect(() => validatePushDestination({ ...subscription, keys: { ...subscription.keys, auth: 'YQ' } })).toThrow());
it('denies unknown origins and ports', async () => {
  await expect(resolveOriginTarget('push', new URL('https://unknown.example'))).rejects.toThrow();
  await expect(resolveOriginTarget('push', new URL('https://fcm.googleapis.com:8443'))).rejects.toThrow();
});
it('supports exact approved self-hosted origins through the shared policy', async () => {
  process.env.PUSH_ORIGIN_POLICY = JSON.stringify([{ origin: 'https://push.example:8443', addresses: ['127.0.0.1/32'] }]);
  try {
    await expect(resolveOriginTarget('push', new URL('https://push.example:8443/sub'), async () => [{ address: '127.0.0.1', family: 4 }])).resolves.toEqual({ address: '127.0.0.1', family: 4 });
  } finally { delete process.env.PUSH_ORIGIN_POLICY; }
});
it('enforces shared per-user budgets', async () => {
  (redis.eval as jest.Mock).mockResolvedValue(61);
  await expect(consumePushBudget('synthetic-user', 'send')).rejects.toThrow('rate limit');
});
it('rejects invalid legacy destinations before transport', async () => {
  await expect(sendPush({ ...subscription, keys: { p256dh: 'bad', auth: 'bad' } }, 'user', '{}')).rejects.toThrow();
  expect(postWithPolicy).not.toHaveBeenCalled();
});
it('redacts failure diagnostics', () => {
  const log = jest.spyOn(console, 'warn').mockImplementation();
  reportPushFailure(new Error('secret endpoint and key'));
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  log.mockRestore();
});
