import Redis from 'ioredis';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSUME_TRANSACTION } from '@/lib/oauth/transactions';

// Opt in to a disposable Unix-socket server, never an operator's REDIS_URL.
const integration = process.env.AUTH_TEST_REDIS_SERVER ? describe : describe.skip;
integration('OAuth transaction consumption against isolated Redis', () => {
  let server: ChildProcess;
  let directory: string;
  let a: Redis;
  let b: Redis;
  const key = 'oauth:transaction:synthetic';
  const binding = ['google', 'session-1', 'user-1', 'org-1', 'https://app.example/callback'];
  const transaction = JSON.stringify({ provider: binding[0], sessionId: binding[1], userId: binding[2],
    organizationId: binding[3], redirectUri: binding[4], verifier: 'synthetic-verifier' });
  const consume = (client: Redis, values = binding) => client.eval(CONSUME_TRANSACTION, 1, key, ...values);
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mailhub-oauth-'));
    const socket = join(directory, 'redis.sock');
    server = spawn(process.env.AUTH_TEST_REDIS_SERVER!, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.stdout!.on('data', data => { if (/ready to accept connections/i.test(data.toString())) resolve(); });
      server.once('exit', code => reject(new Error(`Fixture Redis exited: ${code}`)));
    });
    a = new Redis(socket); b = new Redis(socket);
    await Promise.all([a.ping(), b.ping()]);
  }, 15000);
  beforeEach(async () => { await a.set(key, transaction, 'EX', 600); });
  afterAll(async () => {
    await Promise.all([a?.quit(), b?.quit()]);
    server?.kill();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  test.each([0, 1, 2, 3, 4])('a mismatched binding field %i does not consume the legitimate transaction', async index => {
    const wrong = [...binding]; wrong[index] = 'different';
    expect(await consume(b, wrong)).toBeNull();
    expect(await a.get(key)).toBe(transaction);
    expect(await consume(a)).toBe(transaction);
    expect(await consume(b)).toBeNull();
  });
  test('only one concurrent callback across clients can consume state', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => consume(index % 2 ? a : b)));
    expect(results.filter(value => value === transaction)).toHaveLength(1);
    expect(results.filter(value => value === null)).toHaveLength(29);
    expect(await a.exists(key)).toBe(0);
  });
  test('expired transactions cannot be consumed', async () => {
    await a.pexpire(key, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await consume(b)).toBeNull();
  });
});
