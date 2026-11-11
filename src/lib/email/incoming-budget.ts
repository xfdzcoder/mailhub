import { createReadStream } from 'node:fs';

export const INCOMING_LIMITS = {
  raw: 32 * 1024 * 1024,
  attachment: 20 * 1024 * 1024,
  decoded: 48 * 1024 * 1024,
  response: 48 * 1024 * 1024,
  parts: 256,
  timeoutMs: 30_000,
} as const;

// ImapFlow enforces these on actual protocol bytes, including COMPRESS output.
export const IMAP_RESPONSE_LIMITS = {
  maxLineLength: 1024 * 1024,
  maxLiteralSize: INCOMING_LIMITS.raw + 1,
  maxResponseSize: INCOMING_LIMITS.response,
};

export class IncomingBudgetError extends Error {
  constructor(message = 'Incoming content exceeds the bounded read policy') {
    super(message);
    this.name = 'IncomingBudgetError';
  }
}

/** Count actual bytes before retaining chunks; destroy even on timeout or iterator failure. */
export async function collectIncoming(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  limit: number,
  cancel: () => void = () => (source as { destroy?: () => void }).destroy?.(),
  signal?: AbortSignal
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    cancel();
  };
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    for await (const chunk of source) {
      if (closed) throw new IncomingBudgetError('Incoming read cancelled');
      size += chunk.byteLength;
      if (size > limit) throw new IncomingBudgetError();
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        onAbort = () => { close(); reject(signal?.reason ?? new IncomingBudgetError('Incoming read cancelled')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        timer = setTimeout(() => { close(); reject(new IncomingBudgetError('Incoming read timed out')); }, INCOMING_LIMITS.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    close();
    chunks.length = 0;
  }
}

export function readIncomingFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  return collectIncoming(createReadStream(path), INCOMING_LIMITS.attachment, undefined, signal);
}

export async function incomingJson(response: Response): Promise<ReturnType<typeof JSON.parse>> {
  if (!response.body) throw new IncomingBudgetError('Provider response has no readable body');
  const reader = response.body.getReader();
  async function* chunks() {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
  try {
    const data = await collectIncoming(chunks(), INCOMING_LIMITS.response, () => { void reader.cancel().catch(() => {}); });
    return JSON.parse(data.toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

/** IMAP download setup also performs network I/O, before exposing its stream. */
export async function readImapIncoming(
  client: import('imapflow').ImapFlow,
  uid: string,
  part: string | undefined,
  limit: number,
  signal?: AbortSignal
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let cancelled = false;
  try {
    signal?.throwIfAborted();
    const opening = client.download(uid, part, { uid: true, maxBytes: limit + 1 }).then(download => {
      if (cancelled) download?.content.destroy();
      return download;
    });
    const download = await Promise.race([
      opening,
      new Promise<never>((_, reject) => {
        const stop = (error: unknown) => {
          if (cancelled) return;
          cancelled = true;
          client.close();
          reject(error);
        };
        timer = setTimeout(() => stop(new IncomingBudgetError('IMAP download setup timed out')), INCOMING_LIMITS.timeoutMs);
        onAbort = () => stop(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (!download) return null;
    const content = await collectIncoming(download.content, limit, undefined, signal);
    return { meta: download.meta, content };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
