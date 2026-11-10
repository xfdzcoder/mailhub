jest.mock('node:https', () => ({ ...jest.requireActual('node:https'), request: jest.fn(jest.requireActual('node:https').request) }));
jest.mock('@/lib/redis', () => ({ redis: { eval: jest.fn().mockResolvedValue(1) } }));

import * as https from 'node:https';
import { createECDH } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { sendPush } from '@/lib/notifications/push';

it('delivers generated encrypted Push requests through pinned TLS and preserves provider expiry status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mailhub-push-tls-'));
  const names = ['PUSH_ORIGIN_POLICY', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let server: ReturnType<typeof https.createServer> | undefined;
  const request = https.request as jest.Mock;
  const received: Buffer[] = [];
  let status = 201;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const cert = readFileSync(join(directory, 'cert.pem'));
    server = https.createServer({ key: readFileSync(join(directory, 'key.pem')), cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        expect(Number(req.headers['content-length'])).toBe(body.length);
        expect(req.headers['content-encoding']).toBe('aes128gcm');
        expect(req.headers.authorization).toMatch(/^vapid /);
        received.push(body);
        res.writeHead(status); res.end();
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.PUSH_ORIGIN_POLICY = JSON.stringify([{ origin, addresses: ['127.0.0.1/32'] }]);
    const vapid = webpush.generateVAPIDKeys();
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:synthetic@example.test';
    request.mockImplementation((url, options, callback) =>
      jest.requireActual('node:https').request(url, { ...options, ca: cert }, callback));
    const device = createECDH('prime256v1'); device.generateKeys();
    const subscription = { endpoint: `${origin}/subscription?token=synthetic`, keys: {
      p256dh: device.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url'),
    } };
    const payload = JSON.stringify({ title: 'Synthetic' });
    await expect(sendPush(subscription, 'synthetic-user', payload)).resolves.toBeUndefined();
    expect(received[0].length).toBeGreaterThan(Buffer.byteLength(payload));
    status = 410;
    await expect(sendPush(subscription, 'synthetic-user', payload)).rejects.toMatchObject({ statusCode: 410 });
    expect(received).toHaveLength(2);
  } finally {
    request.mockImplementation(jest.requireActual('node:https').request);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
