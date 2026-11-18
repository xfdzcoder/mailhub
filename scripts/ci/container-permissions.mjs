// Runs through the real entrypoint so the creation modes include its umask.
import assert from 'node:assert/strict';
import fs from 'node:fs';

assert.equal(process.getuid(), 10001);
assert.equal(process.getgid(), 10001);
assert.equal(process.umask(), 0o077);
assert.equal(process.env.HOME, '/home/mailhub');
assert.equal(process.env.XDG_CACHE_HOME, '/app/.cache');
assert.equal(process.env.TMPDIR, '/tmp');
for (const directory of ['/app/.storage', '/app/.cache', '/home/mailhub', '/tmp',
  ...(process.env.INVENTORY_TARGET === 'runtime' ? ['/app/.next/cache'] : [])]) {
  const probe = `${directory}/permission-probe`;
  fs.mkdirSync(probe);
  fs.writeFileSync(`${probe}/synthetic.txt`, 'synthetic attachment');
  assert.equal(fs.statSync(probe).mode & 0o777, 0o700);
  assert.equal(fs.statSync(`${probe}/synthetic.txt`).mode & 0o777, 0o600);
  fs.rmSync(probe, { recursive: true });
}
for (const file of ['/app/package.json', '/app/node_modules', '/usr/local/bin/mailhub-entrypoint']) {
  assert.equal(fs.statSync(file).uid, 0);
  assert.throws(() => fs.accessSync(file, fs.constants.W_OK));
}
const fixture = '/app/.storage/legacy/attachment.txt';
if (fs.existsSync(fixture)) {
  assert.equal(fs.statSync(fixture).uid, 10001);
  assert.equal(fs.statSync(fixture).mode & 0o777, 0o600);
  assert.equal(fs.statSync('/app/.storage/legacy').mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(fixture, 'utf8'), 'synthetic existing attachment\n');
  fs.appendFileSync(fixture, 'read and updated by UID 10001\n');
}
console.log('PASS: identity, writable paths, private creation modes and immutable application files');
