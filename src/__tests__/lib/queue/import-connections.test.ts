import { spawnSync } from 'node:child_process';

test('importing Redis and queue producers, then closing unused queues, never opens a socket', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', `
    const assert = require('node:assert/strict');
    require('node:net').Socket.prototype.connect = function () {
      throw new Error('Module evaluation attempted a network connection');
    };
    const { redis } = require('./src/lib/redis.ts');
    const { closeQueues } = require('./src/lib/queue/client.ts');
    (async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(redis.status, 'wait');
      await closeQueues();
      redis.disconnect();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', REDIS_URL: 'redis://127.0.0.1:9' },
    encoding: 'utf8',
    timeout: 8000,
  });
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({
    status: 0, error: undefined, stderr: '',
  });
}, 10000);
