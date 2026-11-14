import Redis from 'ioredis';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { RESERVE, RELEASE, RENEW, budgetKeys, admissionRedis, reserve, withWork, assertWorkLease, withoutWorkLease, AdmissionError } from '@/lib/workload/admission';
import { AdmittedQueue } from '@/lib/workload/queue';
import { processAdmitted } from '@/lib/workload/processor';

// Only ownership is a synthetic DB fixture. Redis, Bull producers, workers,
// contention, commands, delays, expiry and failures are all real.
jest.mock('@/lib/db/prisma', () => ({ prisma: {
  email: { findUnique: async ({ where }: { where: { id: string } }) => ({ accountId: where.id.startsWith('b') ? 'b' : 'a' }) },
  emailAccount: { findUnique: async ({ where }: { where: { id: string } }) => ({ ownerUserId: where.id, organizationId: where.id, isActive: true }) },
} }));

const integration = process.env.WORKLOAD_TEST_REDIS_SERVER ? describe : describe.skip;
integration('distributed workload admission with disposable Redis', () => {
  let server: ChildProcess;
  let directory: string;
  let a: Redis;
  let b: Redis;
  let oldUrl: string | undefined;
  let socket: string;
  const ownerA = { userId: 'a', organizationId: 'a' };
  const ownerB = { userId: 'b', organizationId: 'b' };
  const keysA = budgetKeys(ownerA, 'active');
  const keysB = budgetKeys(ownerB, 'active');
  const admit = (client: Redis, keys: string[], id: string, units = 1, ttl = 1000) => client.eval(RESERVE, 3, ...keys, id, ttl, units, 2, 2, 4);
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mailhub-work-'));
    socket = join(directory, 'redis.sock');
    server = spawn(process.env.WORKLOAD_TEST_REDIS_SERVER!, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Redis fixture startup timed out')), 10000);
      server.once('error', reject);
      server.stdout!.on('data', data => { if (/ready to accept connections/i.test(String(data))) { clearTimeout(deadline); resolve(); } });
      server.once('exit', code => reject(new Error(`Fixture Redis exited: ${code}`)));
    });
    oldUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = socket;
    a = new Redis(socket); b = new Redis(socket);
    await Promise.all([a.ping(), b.ping()]);
  }, 15000);
  beforeEach(async () => { await a.flushdb(); }); // only this private socket instance
  afterAll(async () => {
    server?.kill('SIGCONT');
    (await admissionRedis()).disconnect();
    await Promise.all([a?.quit(), b?.quit()]);
    server?.kill();
    if (oldUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = oldUrl;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('atomic contention across independent clients, staged units and tenant isolation', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => admit(i % 2 ? a : b, keysA, `a${i}`)));
    expect(results.filter(value => value === 1)).toHaveLength(2);
    expect(await admit(b, keysB, 'b1', 2)).toBe(1);
    expect(await a.zcard(keysA[2])).toBe(4);
    expect(await admit(a, keysB, 'b2')).toBe(0);
    expect(await a.zcard(keysB[0])).toBe(2); // denied operation consumed nothing
  });
  test('idempotent release, renewal and abandoned lease recovery', async () => {
    expect(await admit(a, keysA, 'one', 1, 50)).toBe(1);
    expect(await admit(b, keysA, 'one', 1, 50)).toBe(2);
    expect(await b.eval(RENEW, 3, ...keysA, 'one', 1, 1000)).toBe(1);
    await a.eval(RELEASE, 3, ...keysA, 'one', 1);
    await b.eval(RELEASE, 3, ...keysA, 'one', 1);
    expect(await admit(a, keysA, 'crashed', 2, 20)).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(await admit(b, keysA, 'recovered', 2)).toBe(1);
    expect(await b.eval(RENEW, 3, ...keysA, 'crashed', 2, 1000)).toBe(0);
  });
  test('queued leases retain offline jobs but reconcile cancelled and terminal jobs', async () => {
    const keys = budgetKeys(ownerA, 'queued');
    const id = 'bull:fixture:old';
    await a.hset(id, 'data', '{}');
    expect(await admit(a, keys, id, 1, 20)).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await admit(b, keys, 'second', 1, 20)).toBe(1);
    expect(await admit(a, keys, 'third')).toBe(0);
    await a.del(id); // cancellation: no queue reset/drain
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await admit(b, keys, 'after-cancel')).toBe(1);
    await a.hset(id, 'finishedOn', '1');
    expect(await admit(a, keys, id, 1, 20)).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await admit(b, keys, 'after-terminal')).toBe(1);
  });
  test('exception releases direct work and Redis interruption fails closed then recovers', async () => {
    await expect(withWork(ownerA, async () => { throw new Error('cancelled'); })).rejects.toThrow('cancelled');
    expect(await a.zcard(keysA[2])).toBe(0);
    server.kill('SIGSTOP');
    try { await expect(reserve(ownerB, 'active')).rejects.toBeInstanceOf(AdmissionError); }
    finally { server.kill('SIGCONT'); }
    await a.ping();
    const lease = await reserve(ownerB, 'active');
    await lease.release();
  }, 10000);
  test('lease loss permanently halts later side effects and releases idempotently', async () => {
    let effects = 0;
    await expect(withWork(ownerA, async () => {
      await assertWorkLease();
      effects++;
      await a.del(...keysA); // simulate lost ownership between effects
      await expect(assertWorkLease()).rejects.toBeInstanceOf(AdmissionError);
      // Even if Redis is healthy again, this invocation cannot recover ownership.
      await assertWorkLease();
      effects++;
    })).rejects.toBeInstanceOf(AdmissionError);
    expect(effects).toBe(1);
    expect(await a.zcard(budgetKeys(ownerA, 'queued')[0])).toBe(0);
    expect(await a.zcard(keysA[2])).toBe(0);
    await expect(withWork(ownerB, async () => {
      const keys = budgetKeys(ownerB, 'active');
      const [member] = await a.zrange(keys[0], 0, 0);
      for (const key of keys) await a.zadd(key, 0, member); // expired, still physically present
      await assertWorkLease();
      effects++;
    })).rejects.toBeInstanceOf(AdmissionError);
    expect(effects).toBe(1);
  });
  test('trusted periodic work gets fresh admission after the scheduling scope closes', async () => {
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const later = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    let effects = 0;
    await withWork(ownerA, async () => {
      withoutWorkLease(() => setTimeout(() => {
        void withWork(ownerA, async () => { await assertWorkLease(); effects++; }).then(complete, fail);
      }, 10));
    });
    await later;
    expect(effects).toBe(1);
  });
  test('legacy retry options cannot amplify failed work beyond three attempts', async () => {
    const connectionA = new Redis(socket, { maxRetriesPerRequest: null });
    const connectionB = new Redis(socket, { maxRetriesPerRequest: null });
    const queue = new Queue('search-index', { connection: connectionA });
    let calls = 0;
    const worker = new Worker('search-index', job => processAdmitted(job, async () => {
      calls++;
      throw new Error('controlled failure');
    }), { connection: connectionB });
    try {
      await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
      const job = await queue.add('legacy', { emailId: 'a-failure', userId: 'b', organizationId: 'b' }, {
        attempts: 20, backoff: { type: 'fixed', delay: 1 }, removeOnFail: { count: 5 },
      });
      const end = Date.now() + 5000;
      while (await job.getState() !== 'failed') {
        if (Date.now() > end) throw new Error('failure fixture deadline');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(calls).toBe(3);
      expect(await a.zcard(budgetKeys(ownerA, 'queued')[0])).toBe(0);
      expect(await a.zcard(keysA[2])).toBe(0);
      expect(await queue.getFailedCount()).toBe(1);
    } finally {
      await Promise.all([worker.close(), queue.close()]);
      connectionA.disconnect(); connectionB.disconnect();
    }
  }, 10000);
  test('independent Bull workers preserve capacity for another tenant, deduplicate and release', async () => {
    const connectionA = new Redis(socket, { maxRetriesPerRequest: null });
    const connectionB = new Redis(socket, { maxRetriesPerRequest: null });
    const q1 = new AdmittedQueue('search-index', { connection: connectionA });
    const q2 = new AdmittedQueue('search-index', { connection: connectionB });
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const seen: string[] = [];
    const handler = (job: Parameters<typeof processAdmitted>[0]) => processAdmitted(job, async () => {
      seen.push(job.data.emailId);
      if (job.data.emailId.startsWith('a')) await blocked;
    });
    const w1 = new Worker('search-index', handler, { connection: connectionA, concurrency: 2 });
    const w2 = new Worker('search-index', handler, { connection: connectionB, concurrency: 2 });
    const waitUntil = async (predicate: () => boolean) => {
      const end = Date.now() + 10000;
      while (!predicate()) {
        if (Date.now() > end) throw new Error('fixture worker deadline');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    try {
      await Promise.all([w1.waitUntilReady(), w2.waitUntilReady(), q1.waitUntilReady(), q2.waitUntilReady()]);
      await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? q1 : q2).add('index', { emailId: `a-${i}` })));
      await waitUntil(() => seen.length >= 1);
      await Promise.all([q1.add('index', { emailId: 'b-1' }), q2.add('index', { emailId: 'b-1' })]);
      await waitUntil(() => seen.includes('b-1'));
      expect(seen.filter(id => id.startsWith('a'))).toHaveLength(1);
      expect(seen.filter(id => id === 'b-1')).toHaveLength(1);
      unblock();
      // Remaining delayed jobs are deliberately cancelled individually in the fixture.
      await new Promise(resolve => setTimeout(resolve, 100));
      for (const job of await q1.getJobs(['delayed', 'waiting'])) await job.remove();
      const before = await a.zcard(budgetKeys(ownerB, 'queued')[0]);
      expect(before).toBe(0);
      // Queue startup/enqueue failure cannot execute work outside admission.
      const fault = jest.spyOn(Queue.prototype, 'add').mockRejectedValueOnce(new Error('fixture enqueue failure'));
      await expect(q2.add('index', { emailId: 'b-enqueue-error' })).rejects.toThrow('fixture enqueue failure');
      fault.mockRestore();
      expect(await a.zcard(budgetKeys(ownerB, 'queued')[0])).toBe(1);
    } finally {
      unblock();
      await Promise.all([w1.close(), w2.close(), q1.close(), q2.close()]);
      connectionA.disconnect(); connectionB.disconnect();
    }
  }, 20000);
});
