jest.mock('node:https', () => ({ ...jest.requireActual('node:https'), request: jest.fn(jest.requireActual('node:https').request) }));
jest.mock('node:dns/promises', () => ({ ...jest.requireActual('node:dns/promises'), lookup: jest.fn(jest.requireActual('node:dns/promises').lookup) }));
import { createServer, type Server, type RequestListener } from 'node:http';
import * as https from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dns from 'node:dns/promises';
import { modelPostJson, modelUrl, resolveModelTarget } from '@/lib/network/origin-policy';

const previous = process.env.MODEL_ORIGIN_POLICY;
afterEach(() => {
  if (previous === undefined) delete process.env.MODEL_ORIGIN_POLICY;
  else process.env.MODEL_ORIGIN_POLICY = previous;
});

it.each(['http://user:pass@localhost', 'http://@localhost', 'http://%6cocalhost', 'http://localhost:', 'http://127.1', 'http://0x7f000001', 'http://2130706433', 'http://localhost./', 'http://localhost/#x', 'http://localhost/?x=y', 'http:\\localhost', 'http:///localhost'])('rejects ambiguous target %s', value => {
  expect(() => modelUrl(value)).toThrow();
});

it('canonicalizes scheme, hostname and default ports', () => {
  expect(modelUrl('HTTPS://API.OPENAI.COM:443/v1').origin).toBe('https://api.openai.com');
});

it('requires origin approval independently from address approval', async () => {
  process.env.MODEL_ORIGIN_POLICY = JSON.stringify([{ origin: 'http://model:11434' }]);
  const dns = jest.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  await expect(resolveModelTarget(modelUrl('http://model:11434'), dns)).rejects.toThrow();
  await expect(resolveModelTarget(modelUrl('http://other:11434'), dns)).rejects.toThrow();
});

it.each([
  ['http://model:11434', ['192.0.2.0/24'], [{ address: '192.0.2.10', family: 4 }]],
  ['http://local:11434', ['127.0.0.1/32', '::1/128'], [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]],
  ['http://private:11434', ['10.0.0.0/24'], [{ address: '10.0.0.5', family: 4 }]],
  ['https://public.example', undefined, [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700::1111', family: 6 }]],
])('approves exact origins and all address answers: %s', async (origin, addresses, answers) => {
  process.env.MODEL_ORIGIN_POLICY = JSON.stringify([{ origin, addresses }]);
  const dns = jest.fn().mockResolvedValue(answers);
  await expect(resolveModelTarget(modelUrl(origin), dns)).resolves.toEqual(answers[0]);
  dns.mockResolvedValue([...answers, { address: '169.254.1.1', family: 4 }]);
  await expect(resolveModelTarget(modelUrl(origin), dns)).rejects.toThrow();
});

it('revalidates changed DNS, including mixed public/private results', async () => {
  delete process.env.MODEL_ORIGIN_POLICY;
  const dns = jest.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]);
  await expect(resolveModelTarget(modelUrl('https://api.openai.com'), dns)).resolves.toBeDefined();
  await expect(resolveModelTarget(modelUrl('https://api.openai.com'), dns)).rejects.toThrow();
});

async function sink(handler: RequestListener, host = '127.0.0.1') {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, host, resolve));
  const address = server.address() as { port: number };
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  process.env.MODEL_ORIGIN_POLICY = JSON.stringify([{ origin, addresses: [host] }]);
  return { server, origin };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

it.each(['127.0.0.1', '::1'])('posts to an explicitly approved local sink %s', async host => {
  const { server, origin } = await sink((req, res) => {
    expect(req.headers.authorization).toBe('Bearer tenant-test');
    res.end('{"ok":true}');
  }, host);
  try { await expect(modelPostJson(origin, { Authorization: 'Bearer tenant-test' }, '{}')).resolves.toEqual({ ok: true }); }
  finally { await close(server); }
});

it('pins a hostname connection to the validated DNS result', async () => {
  const { server, origin } = await sink((_req, res) => res.end('{}'));
  const named = origin.replace('127.0.0.1', 'model.invalid');
  process.env.MODEL_ORIGIN_POLICY = JSON.stringify([{ origin: named, addresses: ['127.0.0.1'] }]);
  const spy = dns.lookup as jest.Mock;
  spy.mockClear();
  spy.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  try {
    await expect(modelPostJson(named, {}, '{}')).resolves.toEqual({});
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockClear(); await close(server); }
});

it.each(['redirect', 'large', 'slow'])('rejects %s responses', async mode => {
  let count = 0;
  const { server, origin } = await sink((_req, res) => {
    count++;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/next' }); res.end(); }
    else if (mode === 'large') res.end('x'.repeat(1024));
    // slow intentionally never responds; no external destination is contacted.
  });
  try {
    await expect(modelPostJson(origin, {}, '{}', { totalMs: 100, connectMs: 50, responseBytes: 64 })).rejects.toThrow();
    expect(count).toBe(1);
  } finally { await close(server); }
});


it('preserves certificate hostname verification with a trusted test certificate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-tls-'));
  let server: ReturnType<typeof https.createServer> | undefined;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=wrong.invalid',
      '-addext', 'subjectAltName=DNS:wrong.invalid'], { stdio: 'ignore' });
    const cert = readFileSync(join(dir, 'cert.pem'));
    server = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (_req, res) => res.end('{}'));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.MODEL_ORIGIN_POLICY = JSON.stringify([{ origin, addresses: ['127.0.0.1'] }]);
    (https.request as jest.Mock).mockImplementationOnce((url, options, callback) =>
      jest.requireActual('node:https').request(url, { ...options, ca: cert }, callback));
    await expect(modelPostJson(origin, {}, '{}')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  } finally {
    if (server) await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

it('enforces a connection deadline while TLS is stalled', async () => {
  const sockets = new Set<import('node:net').Socket>();
  const server = createTcpServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.MODEL_ORIGIN_POLICY = JSON.stringify([{ origin, addresses: ['127.0.0.1'] }]);
  try {
    await expect(modelPostJson(origin, {}, '{}', { connectMs: 50, totalMs: 1000, responseBytes: 1024 })).rejects.toThrow('connection deadline');
  } finally {
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('bounds DNS resolution with the total deadline', async () => {
  process.env.MODEL_ORIGIN_POLICY = JSON.stringify([{ origin: 'http://model.invalid' }]);
  (dns.lookup as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));
  await expect(modelPostJson('http://model.invalid', {}, '{}', { connectMs: 20, totalMs: 50, responseBytes: 1024 })).rejects.toThrow('deadline');
});

it.each(['not-json', '{}', '[{"origin":"http://model","addresses":[]}]', '[{"origin":"http://model/path"}]'])('rejects malformed deployment policy', async policy => {
  process.env.MODEL_ORIGIN_POLICY = policy;
  await expect(resolveModelTarget(modelUrl('http://model'), jest.fn())).rejects.toThrow('MODEL_ORIGIN_POLICY');
});

it('never consumes notification approval for a model request', async () => {
  process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin: 'http://unapproved' }]);
  try {
    await expect(resolveModelTarget(modelUrl('http://unapproved'), jest.fn())).rejects.toThrow();
  } finally { delete process.env.NOTIFICATION_ORIGIN_POLICY; }
});

it.each(['ok', 'redirect', 'large', 'slow'])('bounds push transport against controlled HTTPS sink: %s', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'push-tls-'));
  let server: ReturnType<typeof https.createServer> | undefined;
  let count = 0;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const cert = readFileSync(join(dir, 'cert.pem'));
    server = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (_req, res) => {
      count++;
      if (mode === 'ok') { res.writeHead(201); res.end(); }
      if (mode === 'redirect') { res.writeHead(307, { Location: '/next' }); res.end(); }
      if (mode === 'large') res.end('x'.repeat(1024));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.PUSH_ORIGIN_POLICY = JSON.stringify([{ origin, addresses: ['127.0.0.1/32'] }]);
    (https.request as jest.Mock).mockImplementationOnce((url, options, callback) =>
      jest.requireActual('node:https').request(url, { ...options, ca: cert }, callback));
    const { postWithPolicy } = await import('@/lib/network/origin-policy');
    const result = postWithPolicy('push', origin, {}, Buffer.from('synthetic'), { totalMs: 200, connectMs: 100, responseBytes: 64 });
    if (mode === 'ok') await expect(result).resolves.toEqual({ status: 201, body: '' });
    else await expect(result).rejects.toThrow();
    expect(count).toBe(1);
  } finally {
    delete process.env.PUSH_ORIGIN_POLICY;
    if (server) await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
