import Redis from 'ioredis';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACQUIRE } from '@/lib/auth/attempts';

// Opt in to an isolated real Redis executable; never use an operator's REDIS_URL.
const integration = process.env.AUTH_TEST_REDIS_SERVER ? describe : describe.skip;
integration('atomic budgets against isolated Redis', () => {
  let server: ChildProcess;
  let directory: string;
  let a: Redis;
  let b: Redis;
  const keys = ['auth:{fixture}:p:count', 'auth:{fixture}:p:active', 'auth:{fixture}:ip:count', 'auth:{fixture}:ip:active'];
  const admit = (client: Redis, lease: string, count = 20, concurrent = 4) => client.eval(ACQUIRE, 4, ...keys, lease, count, concurrent, 500, 40);
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mailhub-auth-'));
    const socket = join(directory, 'redis.sock');
    server = spawn(process.env.AUTH_TEST_REDIS_SERVER!, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.stdout!.on('data', data => { if (data.toString().includes('ready to accept connections') || data.toString().includes('Ready to accept connections')) resolve(); });
      server.once('exit', code => reject(new Error(`Fixture Redis exited: ${code}`)));
    });
    a = new Redis(socket); b = new Redis(socket);
    await Promise.all([a.ping(), b.ping()]);
  }, 15000);
  beforeEach(async () => { await a.flushdb(); });
  afterAll(async () => {
    await Promise.all([a?.quit(), b?.quit()]);
    server?.kill();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  test('exact threshold with distributed contenders and no partial consumption on denial', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => admit(i % 2 ? a : b, `lease-${i}`, 20, 100)));
    expect(results.filter(v => v === 1)).toHaveLength(20);
    expect(await a.get(keys[0])).toBe('20');
    expect(await a.get(keys[2])).toBe('20');
    expect(await a.pttl(keys[0])).toBeGreaterThan(890000);
    expect(await admit(b, 'denied', 20, 100)).toBe(0);
  });
  test('concurrency leases are atomic and release permits admission', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => admit(i % 2 ? a : b, `lease-${i}`)));
    expect(results.filter(v => v === 1)).toHaveLength(4);
    const [lease] = await a.zrange(keys[1], 0, 0);
    await a.zrem(keys[1], lease); await a.zrem(keys[3], lease);
    expect(await admit(b, 'replacement')).toBe(1);
  });
  test('expiry restores attempts and stale leases are removed using Redis time', async () => {
    expect(await admit(a, 'first', 1)).toBe(1);
    await a.pexpire(keys[0], 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    await a.zadd(keys[1], 0, 'first');
    expect(await admit(b, 'after-expiry', 1)).toBe(1);
    expect(await a.zscore(keys[1], 'first')).toBeNull();
  });
  test('separate principals behind NAT retain independent small budgets', async () => {
    expect(await admit(a, 'one', 1)).toBe(1);
    const other = ['auth:{fixture}:other:count', 'auth:{fixture}:other:active', ...keys.slice(2)];
    expect(await b.eval(ACQUIRE, 4, ...other, 'two', 1, 4, 500, 40)).toBe(1);
  });
});
