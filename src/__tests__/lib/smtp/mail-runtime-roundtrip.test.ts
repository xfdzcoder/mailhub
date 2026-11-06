import { createTransport } from 'nodemailer';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';

it('round-trips composed UTF-8 mail and binary attachments through the installed runtime packages', async () => {
  const transport = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const content = Buffer.from([0, 1, 127, 128, 255]);
  const result = await transport.sendMail({
    from: { name: 'MailHub Fixture', address: 'sender@example.test' },
    to: { name: 'Recipient', address: 'recipient@example.test' },
    cc: 'copy@example.test',
    bcc: 'hidden@example.test',
    subject: 'Fixture — 邮件',
    text: 'Synthetic plain text',
    html: '<p>Synthetic <strong>HTML</strong></p>',
    attachments: [{ filename: '附件.bin', content, contentType: 'application/octet-stream' }],
  });
  const parsed = await simpleParser(result.message);
  expect(parsed.subject).toBe('Fixture — 邮件');
  expect(parsed.from?.value[0].address).toBe('sender@example.test');
  expect(parsed.text).toContain('Synthetic plain text');
  expect(parsed.html).toContain('<strong>HTML</strong>');
  // Stream transport intentionally preserves Bcc, matching raw Gmail composition.
  const bcc = Array.isArray(parsed.bcc) ? parsed.bcc[0] : parsed.bcc;
  expect(bcc?.value[0].address).toBe('hidden@example.test');
  expect(result.envelope.to).toContain('hidden@example.test');
  expect(parsed.attachments).toHaveLength(1);
  expect(parsed.attachments[0].filename).toBe('附件.bin');
  expect(parsed.attachments[0].content.equals(content)).toBe(true);
});

it('preserves the raw composer API and keeps SMTP Bcc out of message headers', async () => {
  const message = new MailComposer({
    from: 'sender@example.test', to: 'recipient@example.test',
    bcc: 'hidden@example.test', subject: 'SMTP fixture', text: 'Synthetic content',
  }).compile();
  expect(message.getEnvelope().to).toContain('hidden@example.test');
  const parsed = await simpleParser(await message.build());
  expect(parsed.bcc).toBeUndefined();
  message.keepBcc = true;
  const gmailRaw = await simpleParser(await message.build());
  const gmailBcc = Array.isArray(gmailRaw.bcc) ? gmailRaw.bcc[0] : gmailRaw.bcc;
  expect(gmailBcc?.value[0].address).toBe('hidden@example.test');
});
