const evaluate = jest.fn();
const release = jest.fn();
jest.mock('ioredis', () => class {
  on() { return this; }
  eval(...args: unknown[]) { return evaluate(...args); }
  zrem(...args: unknown[]) { return release(...args); }
});
import { NextRequest } from 'next/server';
import { withAttempts } from '@/lib/auth/attempts';

beforeEach(() => { evaluate.mockReset().mockResolvedValue(1); release.mockReset().mockResolvedValue(1); });
const request = () => new NextRequest('https://app.example/api/auth/login');
test('fails closed without executing protected work when Redis is unavailable', async () => {
  evaluate.mockRejectedValue(new Error('synthetic outage'));
  const work = jest.fn();
  const response = await withAttempts(request(), 'login', 'synthetic@example.test', work);
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBe('5');
  expect(work).not.toHaveBeenCalled();
});
test('returns bounded retry response without executing denied work', async () => {
  evaluate.mockResolvedValue(0);
  const work = jest.fn();
  const response = await withAttempts(request(), 'login', 'synthetic@example.test', work);
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('900');
  expect(work).not.toHaveBeenCalled();
});
test('hashes sensitive keys, includes tenant budget, and releases even on handler failure', async () => {
  await expect(withAttempts(request(), 'test', 'synthetic-principal', async () => { throw new Error('handler failed'); }, 'synthetic-tenant')).rejects.toThrow('handler failed');
  expect(release).toHaveBeenCalledTimes(3);
  const [, count, ...args] = evaluate.mock.calls[0];
  expect(count).toBe(6);
  expect(args.slice(0, count).join()).not.toContain('synthetic');
});
test('release failure does not replace a successful response', async () => {
  release.mockRejectedValue(new Error('synthetic outage'));
  expect((await withAttempts(request(), 'login', 'synthetic', async () => new Response('ok'))).status).toBe(200);
});
