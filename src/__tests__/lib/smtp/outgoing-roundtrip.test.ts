import { createServer, Socket } from 'net';
import { simpleParser } from 'mailparser';
import { sendEmail } from '@/lib/smtp/sender';
import { getDecryptedAccount } from '@/lib/accounts/service';

jest.mock('@/lib/accounts/service', () => ({ getDecryptedAccount: jest.fn() }));
jest.mock('@/lib/gmail/api', () => ({ getValidAccessToken: jest.fn(), sendMessageRaw: jest.fn() }));
// Only this disposable test sink may resolve to loopback; production policy is unchanged.
jest.mock('@/lib/network/outbound-host', () => ({
  resolveSafeOutboundHost: jest.fn(async () => ({ address: '127.0.0.1', family: 4 })),
}));

test('actual sender delivers one synthetic MIME message to a disposable loopback SMTP sink', async () => {
  const sockets = new Set<Socket>();
  let mime = '';
  let deliveries = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    socket.write('220 localhost synthetic SMTP\r\n');
    let pending = '';
    let inData = false;
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      // The fixture and every command are bounded; this sink is never public.
      if (pending.length > 65536) return socket.destroy();
      let end: number;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            deliveries++;
            socket.write('250 queued synthetic-message\r\n');
          } else {
            mime += line.replace(/^\.\./, '.') + '\r\n';
            if (mime.length > 65536) return socket.destroy();
          }
        } else if (/^EHLO /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 authenticated\r\n');
        else if (/^(MAIL FROM:|RCPT TO:)/i.test(line)) socket.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 send data\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing synthetic SMTP port');
    (getDecryptedAccount as jest.Mock).mockResolvedValue({
      id: 'synthetic', provider: 'imap', label: 'Synthetic café', emailAddress: 'sender@example.test',
      smtpHost: 'synthetic.invalid', smtpPort: address.port, smtpSecure: false,
      username: 'synthetic', decryptedPassword: 'disposable-fixture',
    });
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    const result = await sendEmail('synthetic', {
      to: ['recipient@example.test'], bcc: ['hidden@example.test'], subject: 'Synthetic café', bodyText: 'Hello café',
      attachments: [{ filename: 'binary.dat', contentType: 'application/octet-stream', content: bytes.toString('base64'), sizeBytes: 0 }],
    });
    expect(result.messageId).toBeTruthy();
    expect(deliveries).toBe(1);
    const parsed = await simpleParser(mime);
    expect(parsed.subject).toBe('Synthetic café');
    expect(parsed.text?.trim()).toBe('Hello café');
    expect(parsed.attachments[0].content).toEqual(bytes);
    expect(parsed.bcc).toBeUndefined(); // SMTP Bcc stays in the envelope, absent from delivered MIME.
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10000);
