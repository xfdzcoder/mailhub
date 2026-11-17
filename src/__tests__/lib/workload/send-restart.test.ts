import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const integration = process.env.WORKLOAD_TEST_DATABASE_URL && process.env.WORKLOAD_TEST_REDIS_SERVER && process.env.WORKLOAD_TEST_PG_CTL && process.env.WORKLOAD_TEST_PG_DATA ? describe : describe.skip;
integration('send recovery across disposable PostgreSQL, Redis and process restarts', () => {
  test('recovers preparation and retains delivery uncertainty after all services restart', async () => {
    const url = new URL(process.env.WORKLOAD_TEST_DATABASE_URL!);
    const data = process.env.WORKLOAD_TEST_PG_DATA!;
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test') || process.env.DATABASE_URL !== url.toString() || !data.startsWith('/tmp/mailhub-')) throw new Error('Disposable loopback *_test database and /tmp/mailhub-* cluster required');
    const organizationId = randomUUID(), userId = randomUUID(), accountId = randomUUID();
    const directory = await mkdtemp(path.join(tmpdir(), 'mailhub-send-restart-'));
    const socket = path.join(directory, 'redis.sock');
    let server: ChildProcess | undefined;
    const child = (mode: string, key = 'restart-preparation') => execFileSync(process.execPath,
      ['--import', 'tsx', 'scripts/ci/send-operation-process.ts', mode, organizationId, userId, accountId, key],
      { cwd: path.resolve(__dirname, '../../../..'), env: { ...process.env, REDIS_URL: socket }, timeout: 20000, encoding: 'utf8', stdio: 'pipe' });
    const startRedis = async () => {
      server = spawn(process.env.WORKLOAD_TEST_REDIS_SERVER!, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no']);
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Redis startup timed out')), 10000);
        server!.once('error', error => { clearTimeout(deadline); reject(error); });
        server!.stdout!.on('data', chunk => { if (/ready to accept connections/i.test(String(chunk))) { clearTimeout(deadline); resolve(); } });
      });
    };
    const stopRedis = async () => {
      if (!server || server.exitCode !== null) return;
      const stopped = new Promise(resolve => server!.once('exit', resolve));
      server.kill(); await stopped;
    };
    try {
      await startRedis();
      child('prepare'); child('delivery', 'restart-uncertain');
      child('expire-preparation');
      await stopRedis();
      // No application DB pools survive: every fixture invocation is a new process.
      execFileSync(process.env.WORKLOAD_TEST_PG_CTL!, ['-D', data, '-l', path.join(data, 'restart.log'), '-m', 'fast', '-w', 'restart'], { timeout: 20000, stdio: 'pipe' });
      await startRedis();
      child('maintenance'); child('prepare');
      expect(() => child('prepare', 'restart-uncertain')).toThrow(/already attempted/);
      expect(JSON.parse(child('inspect'))).toEqual(expect.arrayContaining([
        { operationKey: 'restart-preparation', state: 'PREPARING' },
        { operationKey: 'restart-uncertain', state: 'DELIVERING' },
      ]));
    } finally {
      child('cleanup');
      await stopRedis();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
