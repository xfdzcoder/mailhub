import { createTransport } from 'nodemailer';
import { simpleParser } from 'mailparser';
import { decodedLength, outgoingLimits, readOutgoingJson, validateOutgoingMail, validateRawOutgoing } from '@/lib/email/outgoing-budget';
import { readOutgoingFile, stageOutgoingFiles } from '@/lib/email/outgoing-files';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const attachment = (content: string) => ({ filename: 'test.txt', contentType: 'text/plain', content });
const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });

describe('outgoing budgets', () => {
  test.each(['0', '-1', 'Infinity', 'NaN', '1.5', '', '99999999999999999999'])('rejects invalid configuration %s', value => {
    process.env.OUTGOING_ATTACHMENT_BYTES = value;
    expect(() => outgoingLimits()).toThrow();
  });
  test.each(['Zg', 'Zg===', 'Z g==', 'Zh==', 'Zm9=', '====', 'a===', 'SGVsbG8_', '=AAA'])('rejects noncanonical base64 %s', value => {
    expect(() => decodedLength(value)).toThrow('canonical');
  });
  test('exact decoded, count, aggregate and UTF-8 boundaries; ignores claimed size', () => {
    process.env.OUTGOING_ATTACHMENT_BYTES = '3';
    process.env.OUTGOING_TOTAL_ATTACHMENT_BYTES = '6';
    process.env.OUTGOING_ATTACHMENTS = '2';
    process.env.OUTGOING_BODY_BYTES = '4';
    const a = { ...attachment('YWJj'), sizeBytes: 0 };
    expect(() => validateOutgoingMail({ attachments: [a, a], bodyText: 'éé' })).not.toThrow();
    expect(() => validateOutgoingMail({ attachments: [attachment('YWJjZA==')] })).toThrow();
    expect(() => validateOutgoingMail({ attachments: [a, a, a] })).toThrow();
    expect(() => validateOutgoingMail({ bodyText: 'ééa' })).toThrow();
    process.env.OUTGOING_ATTACHMENTS = '3';
    expect(() => validateOutgoingMail({ attachments: [a, a, a] })).toThrow();
  });
  test('header, draft argument and raw message boundaries use bytes', () => {
    process.env.OUTGOING_HEADER_BYTES = '4';
    process.env.OUTGOING_ARGUMENT_BYTES = '4';
    process.env.OUTGOING_RAW_BYTES = '4';
    expect(() => validateOutgoingMail({ subject: 'éé', draftId: 'éé' })).not.toThrow();
    expect(() => validateOutgoingMail({ subject: 'ééa' })).toThrow();
    expect(() => validateOutgoingMail({ draftId: 'ééa' })).toThrow();
    expect(() => validateRawOutgoing(Buffer.alloc(4))).not.toThrow();
    expect(() => validateRawOutgoing(Buffer.alloc(5))).toThrow();
  });
  test('many small attachments and combined recipients are bounded', () => {
    expect(() => validateOutgoingMail({ attachments: Array.from({ length: 33 }, () => attachment('')) })).toThrow();
    expect(() => validateOutgoingMail({ to: Array(50).fill('a@b.c'), cc: Array(50).fill('b@b.c') })).not.toThrow();
    expect(() => validateOutgoingMail({ to: Array(50).fill('a@b.c'), bcc: Array(51).fill('b@b.c') })).toThrow();
  });
  test.each([undefined, '1', '999999', '1, 2'])('counts chunked bytes despite length %s and cancels overflow', async length => {
    process.env.OUTGOING_REQUEST_BYTES = '8';
    let cancelled = false;
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('12345')); }, cancel() { cancelled = true; } });
    const req = new Request('http://localhost', { method: 'POST', body: stream, duplex: 'half', headers: length ? { 'Content-Length': length } : {} } as RequestInit);
    await expect(readOutgoingJson(req)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });
  test('accepts exact request boundary and handles malformed JSON and abort', async () => {
    process.env.OUTGOING_REQUEST_BYTES = '7';
    await expect(readOutgoingJson(new Request('http://localhost', { method: 'POST', body: '{"a":1}' }))).resolves.toEqual({ a: 1 });
    await expect(readOutgoingJson(new Request('http://localhost', { method: 'POST', body: '{' }))).rejects.toMatchObject({ status: 400 });
    const controller = new AbortController();
    const req = new Request('http://localhost', { method: 'POST', body: new ReadableStream({}), signal: controller.signal, duplex: 'half' } as RequestInit);
    const pending = readOutgoingJson(req);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 400 });
  });
  test('invalid UTF-8 and stream errors return bounded errors and cancel input', async () => {
    await expect(readOutgoingJson(new Request('http://localhost', { method: 'POST', body: new Uint8Array([34, 255, 34]) }))).rejects.toMatchObject({ status: 400 });
    const req = new Request('http://localhost', { method: 'POST', body: new ReadableStream({ start(controller) { controller.error(new Error('private producer details')); } }), duplex: 'half' } as RequestInit);
    await expect(readOutgoingJson(req)).rejects.toMatchObject({ status: 400, message: 'Unable to read request body' });
  });
  test('bounded stored file reads use actual bytes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mailhub-outgoing-'));
    try {
      const file = path.join(dir, 'attachment');
      await writeFile(file, 'abc');
      await expect(readOutgoingFile(file, 3)).resolves.toEqual(Buffer.from('abc'));
      await expect(readOutgoingFile(file, 2)).rejects.toMatchObject({ status: 413 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test('stages and cleans synthetic files; cleans earlier files after write failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mailhub-stage-'));
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const staged = await stageOutgoingFiles([attachment('YWJj')]);
      expect(await readFile(staged.files[0].storagePath)).toEqual(Buffer.from('abc'));
      expect(staged.files[0].sizeBytes).toBe(3);
      await staged.cleanup();
      expect(await readdir(path.join(dir, '.storage', 'attachments'))).toEqual([]);
      await rm(path.join(dir, '.storage', 'attachments'), { recursive: true });
      await writeFile(path.join(dir, '.storage', 'attachments'), 'blocks directory');
      await expect(stageOutgoingFiles([attachment('YWJj')])).rejects.toThrow();
    } finally { cwd.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });
});

test('normal synthetic MIME round trip preserves UTF-8, Bcc and binary attachments without a service', async () => {
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  const input = { to: ['recipient@example.test'], bcc: ['hidden@example.test'], subject: 'Synthetic café', bodyText: 'Hello café', attachments: [attachment(bytes.toString('base64'))] };
  validateOutgoingMail(input);
  const transport = createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const options = { ...input, from: 'sender@example.test', text: input.bodyText, keepBcc: true, attachments: input.attachments.map(a => ({ ...a, content: Buffer.from(a.content, 'base64') })) };
  const result = await transport.sendMail(options);
  const parsed = await simpleParser(result.message);
  expect(parsed.subject).toBe(input.subject);
  expect(parsed.text?.trim()).toBe(input.bodyText);
  expect(parsed.attachments[0].content).toEqual(bytes);
  expect(parsed.bcc).toBeDefined();
});
