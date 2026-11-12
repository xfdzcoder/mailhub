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
import { notificationPost, modelUrl, resolveOriginTarget } from '@/lib/network/origin-policy';

const resolveNotificationTarget = (url: URL, dns?: import('@/lib/network/outbound-host').OutboundHostLookup) => resolveOriginTarget('notification', url, dns);

const previous = process.env.NOTIFICATION_ORIGIN_POLICY;
afterEach(() => {
  if (previous === undefined) delete process.env.NOTIFICATION_ORIGIN_POLICY;
  else process.env.NOTIFICATION_ORIGIN_POLICY = previous;
});

it.each(['http://user:pass@localhost', 'http://@localhost', 'http://%6cocalhost', 'http://localhost:', 'http://127.1', 'http://0x7f000001', 'http://2130706433', 'http://localhost./', 'http://localhost/#x', 'http:\\\\localhost', 'http:///localhost'])('rejects ambiguous notification target %s', async value => {
  await expect(notificationPost(value, {}, '{}')).rejects.toThrow();
});

it('requires origin approval independently from address approval', async () => {
  process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin: 'http://model:11434' }]);
  const dns = jest.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  await expect(resolveNotificationTarget(modelUrl('http://model:11434'), dns)).rejects.toThrow();
  await expect(resolveNotificationTarget(modelUrl('http://other:11434'), dns)).rejects.toThrow();
});

it.each([
  ['http://model:11434', ['192.0.2.0/24'], [{ address: '192.0.2.10', family: 4 }]],
  ['http://local:11434', ['127.0.0.1/32', '::1/128'], [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]],
  ['http://private:11434', ['10.0.0.0/24'], [{ address: '10.0.0.5', family: 4 }]],
  ['https://public.example', undefined, [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700::1111', family: 6 }]],
])('approves exact origins and all address answers: %s', async (origin, addresses, answers) => {
  process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin, addresses }]);
  const dns = jest.fn().mockResolvedValue(answers);
  await expect(resolveNotificationTarget(modelUrl(origin), dns)).resolves.toEqual(answers[0]);
  dns.mockResolvedValue([...answers, { address: '169.254.1.1', family: 4 }]);
  await expect(resolveNotificationTarget(modelUrl(origin), dns)).rejects.toThrow();
});

it('revalidates changed DNS, including mixed public/private results', async () => {
  process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin: 'https://api.openai.com' }]);
  const dns = jest.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]);
  await expect(resolveNotificationTarget(modelUrl('https://api.openai.com'), dns)).resolves.toBeDefined();
  await expect(resolveNotificationTarget(modelUrl('https://api.openai.com'), dns)).rejects.toThrow();
});

async function sink(handler: RequestListener, host = '127.0.0.1') {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, host, resolve));
  const address = server.address() as { port: number };
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin, addresses: [host] }]);
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
  try { await expect(notificationPost(origin, { Authorization: 'Bearer tenant-test' }, '{}')).resolves.toEqual({ statusCode: 200 }); }
  finally { await close(server); }
});

it('pins a hostname connection to the validated DNS result', async () => {
  const { server, origin } = await sink((_req, res) => res.end('{}'));
  const named = origin.replace('127.0.0.1', 'model.invalid');
  process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin: named, addresses: ['127.0.0.1'] }]);
  const spy = dns.lookup as jest.Mock;
  spy.mockClear();
  spy.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  try {
    await expect(notificationPost(named, {}, '{}')).resolves.toEqual({ statusCode: 200 });
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
    await expect(notificationPost(origin, {}, '{}', { totalMs: 100, connectMs: 50, responseBytes: 64 })).rejects.toThrow();
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
    process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin, addresses: ['127.0.0.1'] }]);
    (https.request as jest.Mock).mockImplementationOnce((url, options, callback) =>
      jest.requireActual('node:https').request(url, { ...options, ca: cert }, callback));
    await expect(notificationPost(origin, {}, '{}')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    // Even a trusted, correctly named TLS connection must reach the approved IP.
    const named = origin.replace('127.0.0.1', 'wrong.invalid');
    process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin: named, addresses: ['127.0.0.2'] }]);
    (dns.lookup as jest.Mock).mockResolvedValueOnce([{ address: '127.0.0.2', family: 4 }]);
    (https.request as jest.Mock).mockImplementationOnce((url, options, callback) =>
      jest.requireActual('node:https').request(url, {
        ...options, ca: cert,
        lookup: (_host: string, _options: unknown, done: (error: null, address: string, family: number) => void) => done(null, '127.0.0.1', 4),
      }, callback));
    await expect(notificationPost(named, {}, '{}')).rejects.toMatchObject({ name: 'OriginPolicyError' });

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
  process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin, addresses: ['127.0.0.1'] }]);
  try {
    await expect(notificationPost(origin, {}, '{}', { connectMs: 50, totalMs: 1000, responseBytes: 1024 })).rejects.toThrow('connection deadline');
  } finally {
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('bounds DNS resolution with the total deadline', async () => {
  process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([{ origin: 'http://model.invalid' }]);
  (dns.lookup as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));
  await expect(notificationPost('http://model.invalid', {}, '{}', { connectMs: 20, totalMs: 50, responseBytes: 1024 })).rejects.toThrow('deadline');
});

it.each(['not-json', '{}', '[{"origin":"http://model","addresses":[]}]', '[{"origin":"http://model/path"}]'])('rejects malformed deployment policy', async policy => {
  process.env.NOTIFICATION_ORIGIN_POLICY = policy;
  await expect(resolveNotificationTarget(modelUrl('http://model'), jest.fn())).rejects.toThrow('NOTIFICATION_ORIGIN_POLICY');
});

it('never consumes model approval for notifications', async () => {
  const previousModel = process.env.MODEL_ORIGIN_POLICY;
  process.env.MODEL_ORIGIN_POLICY = JSON.stringify([{ origin: 'http://unapproved' }]);
  delete process.env.NOTIFICATION_ORIGIN_POLICY;
  try {
    await expect(resolveNotificationTarget(modelUrl('http://unapproved'), jest.fn())).rejects.toThrow();
  } finally {
    if (previousModel === undefined) delete process.env.MODEL_ORIGIN_POLICY;
    else process.env.MODEL_ORIGIN_POLICY = previousModel;
  }
});

it.each(['Host', 'hOsT', 'Connection', 'Content-Length', 'Transfer-Encoding', 'Proxy-Authorization', 'Forwarded', 'X-Forwarded-Host', 'X-Original-URL', 'X-Real-IP', 'X-HTTP-Method-Override'])('rejects routing header %s before delivery', async name => {
  await expect(notificationPost('https://example.invalid', { [name]: 'synthetic' }, '{}')).rejects.toThrow('header');
});

it('delivers Generic and WeCom payloads to an approved sink without exposing credentials in failures', async () => {
  const { sendGenericWebhookNotification } = await import('@/lib/notifications/generic-adapter');
  const { sendWeComNotification } = await import('@/lib/notifications/wecom-adapter');
  const received: Array<{ url?: string; secret?: string; body: string }> = [];
  const { server, origin } = await sink((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, secret: req.headers['x-webhook-secret'] as string, body });
      res.end('accepted'); // Successful notification responses need not be JSON.
    });
  });
  try {
    await expect(sendGenericWebhookNotification({ url: `${origin}/hook/path-token?key=query-token`, secret: 'header-token' }, 'Synthetic', 'Summary', 2))
      .resolves.toMatchObject({ success: true, statusCode: 200 });
    await expect(sendWeComNotification({ webhookUrl: `${origin}/send?key=synthetic` }, 'Synthetic', 'Summary'))
      .resolves.toMatchObject({ success: true });
    expect(received[0]).toMatchObject({ url: '/hook/path-token?key=query-token', secret: 'header-token' });
    expect(JSON.parse(received[0].body)).toMatchObject({ event: 'email.summary', emailCount: 2 });
    expect(JSON.parse(received[1].body)).toMatchObject({ msgtype: 'markdown' });
    delete process.env.NOTIFICATION_ORIGIN_POLICY;
    const denied = await sendWeComNotification({ webhookUrl: `${origin}/private-token?key=secret` }, 'Synthetic', 'Summary');
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('NOTIFICATION_ORIGIN_POLICY');
    expect(JSON.stringify(denied)).not.toMatch(/private-token|key=secret|127\.0\.0\.1/);
    expect(received).toHaveLength(2);
  } finally { await close(server); }
});

it('never follows an approved cross-origin redirect or forwards credentials', async () => {
  let arrivals = 0;
  const destination = await sink((_req, res) => { arrivals++; res.end('ok'); });
  const source = await sink((_req, res) => {
    res.writeHead(307, { Location: `${destination.origin}/next` });
    res.end('secret echoed by sink');
  });
  process.env.NOTIFICATION_ORIGIN_POLICY = JSON.stringify([source, destination].map(({ origin }) => ({ origin, addresses: ['127.0.0.1'] })));
  try {
    await expect(notificationPost(`${source.origin}/token?key=synthetic`, { Authorization: 'Bearer synthetic', 'X-Webhook-Secret': 'synthetic' }, '{}'))
      .rejects.toMatchObject({ statusCode: 307 });
    expect(arrivals).toBe(0);
  } finally { await close(source.server); await close(destination.server); }
});
