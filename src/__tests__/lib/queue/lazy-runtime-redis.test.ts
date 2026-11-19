import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Opt in to a disposable Unix-socket Redis; never connect to an operator's server.
const integration = process.env.QUEUE_TEST_REDIS_SERVER ? describe : describe.skip;
integration('lazy producer connections against real Redis', () => {
  let server: ChildProcess;
  let directory: string;
  let socket: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mailhub-queue-'));
    socket = join(directory, 'redis.sock');
    server = spawn(process.env.QUEUE_TEST_REDIS_SERVER!, [
      '--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.stdout!.on('data', data => {
        if (/ready to accept connections/i.test(data.toString())) resolve();
      });
      server.once('exit', code => reject(new Error(`Fixture Redis exited: ${code}`)));
    });
  }, 15000);
  afterAll(async () => {
    server?.kill();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('first command, pub/sub, queues and shutdown work without an explicit connect', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', `
      const assert = require('node:assert/strict');
      const Redis = require('ioredis');
      const { redis } = require('./src/lib/redis.ts');
      const queues = require('./src/lib/queue/client.ts');
      const { AdmissionError } = require('./src/lib/workload/admission.ts');
      (async () => {
        assert.equal(redis.status, 'wait');
        await redis.set('fixture', 'synthetic');
        assert.equal(await redis.get('fixture'), 'synthetic');
        const subscriber = new Redis(process.env.REDIS_URL);
        await subscriber.subscribe('fixture-events');
        const received = new Promise(resolve => subscriber.once('message', (...args) => resolve(args)));
        await redis.publish('fixture-events', 'synthetic');
        assert.deepEqual(await received, ['fixture-events', 'synthetic']);
        await queues.workerHealthQueue.add('probe', { synthetic: true }, { jobId: 'probe' });
        const job = await queues.workerHealthQueue.getJob('probe');
        assert.deepEqual(job.data, { synthetic: true });
        const partition = queues.getSyncQueue('fixture');
        assert.equal(partition, queues.getSyncQueue('fixture'));
        assert.equal(partition.name, 'imap-sync-fixture');
        await partition.getJobCounts();
        await assert.rejects(queues.searchQueue.addBulk(Array.from({ length: 33 }, () => ({
          name: 'oversized', data: {},
        }))), AdmissionError);
        await subscriber.quit();
        await queues.closeQueues();
        await redis.quit();
      })().catch(error => { console.error(error); process.exit(1); });
    `], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', REDIS_URL: socket },
      encoding: 'utf8', timeout: 10000,
    });
    expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({
      status: 0, error: undefined, stderr: '',
    });
  }, 15000);
});
