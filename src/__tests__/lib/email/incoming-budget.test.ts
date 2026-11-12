import { createServer } from 'node:http';
import { createGzip } from 'node:zlib';
import type { ImapFlow } from 'imapflow';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, rm, truncate, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAP_RESPONSE_LIMITS, readImapIncoming, collectIncoming, incomingJson, IncomingBudgetError, readIncomingFile } from '@/lib/email/incoming-budget';
import { parseBoundedMime } from '@/lib/email/mime-parser';

it('counts bytes and destroys a dishonest streaming source on overflow', async () => {
  const source = Readable.from([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]);
  await expect(collectIncoming(source, 7)).rejects.toBeInstanceOf(IncomingBudgetError);
  expect(source.destroyed).toBe(true);
});

it('reads actual local bytes without stored size metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailhub-incoming-'));
  try {
    const file = join(dir, 'attachment');
    await writeFile(file, 'fixture');
    expect((await readIncomingFile(file)).toString()).toBe('fixture');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('ignores dishonest Content-Length and reads actual response bytes', async () => {
  const response = new Response('{"data":"fixture"}', { headers: { 'Content-Length': '1' } });
  expect(await incomingJson(response)).toEqual({ data: 'fixture' });
});

it('parses MIME in isolation preserving decoded attachments and CID', async () => {
  const raw = 'From: sender@example.com\r\nSubject: fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nhello\r\n--x\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename="a.png"\r\nContent-ID: <image>\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--x--\r\n';
  const parsed = await parseBoundedMime(raw);
  expect(parsed.subject).toBe('fixture');
  expect(parsed.text).toContain('hello');
  expect(parsed.attachments[0].content.toString()).toBe('hello');
  expect(parsed.attachments[0].cid).toBe('image');
});

it('cancels provider streaming overflow before retaining another chunk', async () => {
  let cancelled = false;
  let delivered = 0;
  const chunk = new Uint8Array(64 * 1024);
  const response = new Response(new ReadableStream({
    pull(controller) { delivered += chunk.length; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Length': '1' } });
  await expect(incomingJson(response)).rejects.toBeInstanceOf(IncomingBudgetError);
  expect(cancelled).toBe(true);
  expect(delivered).toBeLessThanOrEqual(48 * 1024 * 1024 + 2 * chunk.length);
});

it('terminates an active MIME parser on cancellation', async () => {
  const controller = new AbortController();
  const parsing = parseBoundedMime('Subject: cancelled\r\n\r\nbody', controller.signal);
  controller.abort();
  await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
});

it('rejects decoded attachment overflow inside the worker', async () => {
  const raw = Buffer.concat([
    Buffer.from('Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n'),
    Buffer.from(Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64')),
  ]);
  await expect(parseBoundedMime(raw)).rejects.toThrow(/budget/i);
});

it('bounds multipart node counts, including empty parts', async () => {
  const raw = 'Content-Type: multipart/mixed; boundary=x\r\n\r\n' +
    '--x\r\nContent-Type: text/plain\r\n\r\nx\r\n'.repeat(257) + '--x--\r\n';
  await expect(parseBoundedMime(raw)).rejects.toThrow(/budget/i);
});

it('preserves CID image rendering under the expansion budget', async () => {
  const raw = 'Content-Type: multipart/related; boundary=x\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<img src="cid:image">\r\n--x\r\nContent-Type: image/png\r\nContent-ID: <image>\r\nContent-Transfer-Encoding: base64\r\n\r\naGk=\r\n--x--\r\n';
  expect((await parseBoundedMime(raw)).html).toContain('data:image/png;base64,aGk=');
});

it('destroys a failed source and cancels once on timeout', async () => {
  jest.useFakeTimers();
  try {
    const source = new Readable({ read() {} });
    const cancel = jest.fn(() => source.destroy());
    const pending = collectIncoming(source, 100, cancel);
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await jest.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(source.destroyed).toBe(true);
  } finally { jest.useRealTimers(); }
});

it('releases malformed JSON response readers', async () => {
  const response = new Response('{broken');
  await expect(incomingJson(response)).rejects.toBeInstanceOf(SyntaxError);
  expect(response.body?.locked).toBe(false);
});

it('rejects oversized historical files without deleting them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailhub-historical-'));
  const file = join(dir, 'large');
  try {
    await writeFile(file, '');
    await truncate(file, 20 * 1024 * 1024 + 1);
    await expect(readIncomingFile(file)).rejects.toBeInstanceOf(IncomingBudgetError);
    expect((await stat(file)).size).toBe(20 * 1024 * 1024 + 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('bounds actual decompressed HTTP bytes from a disposable provider fixture', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Encoding', 'gzip');
    const gzip = createGzip();
    const source = Readable.from((function* () {
      const chunk = Buffer.alloc(64 * 1024, 32);
      for (let i = 0; i < 800; i++) yield chunk;
    })());
    res.on('close', () => { source.destroy(); gzip.destroy(); });
    source.pipe(gzip).pipe(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(10_000) });
    await expect(incomingJson(response)).rejects.toBeInstanceOf(IncomingBudgetError);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 15_000);

it('closes a stalled IMAP setup once and destroys a late download', async () => {
  jest.useFakeTimers();
  try {
    let deliver!: (value: { content: Readable; meta: object }) => void;
    const client = {
      download: jest.fn(() => new Promise(resolve => { deliver = resolve; })),
      close: jest.fn(),
    };
    const pending = readImapIncoming(client as unknown as ImapFlow, '1', undefined, 10);
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await jest.advanceTimersByTimeAsync(30_000);
    await rejected;
    const content = Readable.from(['late']);
    deliver({ content, meta: {} });
    await Promise.resolve();
    expect(content.destroyed).toBe(true);
    expect(client.close).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

it('enforces actual IMAP line bytes in the pinned protocol reader', async () => {
  const { ImapStream } = jest.requireActual('imapflow/lib/handler/imap-stream');
  const stream = new ImapStream(IMAP_RESPONSE_LIMITS);
  const failed = new Promise<Error>(resolve => stream.once('error', resolve));
  stream.end(Buffer.alloc(IMAP_RESPONSE_LIMITS.maxLineLength + 1, 65));
  expect(await failed).toMatchObject({ code: 'LineTooLarge' });
  expect(stream.destroyed).toBe(true);
});

it('releases a stream after a provider or disk read failure', async () => {
  const source = Readable.from((async function* () {
    yield Buffer.from('partial');
    throw Object.assign(new Error('fixture read failed'), { code: 'EIO' });
  })());
  await expect(collectIncoming(source, 1024)).rejects.toMatchObject({ code: 'EIO' });
  expect(source.destroyed).toBe(true);
});


it('handles the IMAP missing-download object without reporting content', async () => {
  const client = { download: jest.fn().mockResolvedValue({}), close: jest.fn() };
  await expect(readImapIncoming(client as unknown as ImapFlow, '1', undefined, 10)).resolves.toBeNull();
});

it('reads complete bounded IMAP content and cleans up the stream', async () => {
  const content = Readable.from([Buffer.from('hello'), Buffer.from('world')]);
  const client = { download: jest.fn().mockResolvedValue({ content, meta: {} }) };
  const result = await readImapIncoming(client as unknown as ImapFlow, '1', undefined, 10);
  expect(result?.content.toString()).toBe('helloworld');
  expect(content.destroyed).toBe(true);
});

it('does not report success for an interrupted IMAP download', async () => {
  const content = Readable.from((async function* () {
    yield Buffer.from('partial');
    throw new Error('temporary disconnect');
  })());
  const client = { download: jest.fn().mockResolvedValue({ content, meta: {} }) };
  await expect(readImapIncoming(client as unknown as ImapFlow, '1', undefined, 100)).rejects.toThrow('temporary disconnect');
  expect(content.destroyed).toBe(true);
});
