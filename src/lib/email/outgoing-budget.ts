/** Outgoing-only budgets. Incoming MIME/retrieval deliberately use separate policy. */
export class OutgoingInputError extends Error {
  constructor(message: string, public readonly status = 413) { super(message); }
}
const defaults = {
  requestBytes: 24 * 1024 * 1024,
  attachmentBytes: 8 * 1024 * 1024,
  totalAttachmentBytes: 16 * 1024 * 1024,
  attachments: 32,
  recipients: 100,
  bodyBytes: 1024 * 1024,
  headerBytes: 8192,
  argumentBytes: 256,
  rawBytes: 26 * 1024 * 1024,
};
export function outgoingLimits() {
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const name = `OUTGOING_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
    const value = process.env[name];
    if (value === undefined) continue;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > defaults[key]) {
      throw new Error(`${name} must be a positive integer no greater than ${defaults[key]}`);
    }
    limits[key] = Number(value);
  }
  return limits;
}
export function checkBytes(value: string | undefined | null, cap: number, label: string) {
  if (value != null && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > cap)) {
    throw new OutgoingInputError(`${label} exceeds outgoing limit`);
  }
}
export function decodedLength(content: string): number {
  // Validate alphabet, padding and unused pad bits without allocating a decoded copy.
  if (typeof content !== 'string' || content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(content)) {
    throw new OutgoingInputError('Invalid canonical base64 attachment', 422);
  }
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  const end = content.length - padding;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (content.slice(0, end).includes('=') || (padding && end < 2) ||
      (padding === 2 && (alphabet.indexOf(content[end - 1]) & 15) !== 0) ||
      (padding === 1 && (alphabet.indexOf(content[end - 1]) & 3) !== 0)) {
    throw new OutgoingInputError('Invalid canonical base64 attachment', 422);
  }
  return content.length / 4 * 3 - padding;
}
interface OutgoingMail {
  to?: string[] | string; cc?: string[] | string; bcc?: string[] | string;
  subject?: string | null; bodyHtml?: string | null; bodyText?: string | null;
  inReplyTo?: string; references?: string; draftId?: string;
  attachments?: { filename: string; contentType: string; content: string; id?: string }[];
}
export function validateOutgoingMail(input: OutgoingMail) {
  const l = outgoingLimits();
  let recipients = 0;
  for (const field of [input.to, input.cc, input.bcc]) {
    if (typeof field === 'string') checkBytes(field, l.headerBytes, 'Recipient header');
    if (Array.isArray(field) && field.length > l.recipients - recipients) throw new OutgoingInputError('Too many recipients');
    const addresses = typeof field === 'string' ? field.split(/[,;]/).filter(v => v.trim()) : field || [];
    recipients += addresses.length;
    if (recipients > l.recipients) throw new OutgoingInputError('Too many recipients');
    for (const address of addresses) checkBytes(address, l.headerBytes, 'Recipient');
  }
  for (const field of [input.subject, input.inReplyTo, input.references]) checkBytes(field, l.headerBytes, 'Header');
  for (const field of [input.bodyHtml, input.bodyText]) checkBytes(field, l.bodyBytes, 'Body');
  checkBytes(input.draftId, l.argumentBytes, 'Draft ID');
  if ((input.attachments?.length || 0) > l.attachments) throw new OutgoingInputError('Too many attachments');
  let total = 0;
  for (const att of input.attachments || []) {
    checkBytes(att.filename, l.headerBytes, 'Filename');
    checkBytes(att.contentType, l.headerBytes, 'Content type');
    checkBytes(att.id, l.argumentBytes, 'Attachment ID');
    // Reject huge encoded strings before scanning them.
    if (att.content.length > Math.ceil(l.attachmentBytes / 3) * 4) throw new OutgoingInputError('Attachment exceeds outgoing limit');
    const size = decodedLength(att.content);
    total += size;
    if (size > l.attachmentBytes || total > l.totalAttachmentBytes) throw new OutgoingInputError('Attachments exceed outgoing limit');
  }
}
export async function readOutgoingJson(req: Request): Promise<unknown> {
  const cap = outgoingLimits().requestBytes;
  const reader = req.body?.getReader();
  if (!reader) throw new OutgoingInputError('Missing JSON body', 400);
  let buffer = Buffer.alloc(Math.min(cap, 64 * 1024));
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  req.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (req.signal?.aborted) throw new OutgoingInputError('Request aborted', 400);
    while (true) {
      const { value, done } = await reader.read();
      if (req.signal?.aborted) throw new OutgoingInputError('Request aborted', 400);
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new OutgoingInputError('Outgoing request exceeds byte limit');
      if (total > buffer.length) {
        const grown = Buffer.alloc(Math.min(cap, Math.max(total, buffer.length * 2)));
        buffer.copy(grown, 0, 0, total - value.byteLength);
        buffer = grown;
      }
      buffer.set(value, total - value.byteLength);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total))); }
    catch { throw new OutgoingInputError('Invalid JSON body', 400); }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof OutgoingInputError) throw error;
    throw new OutgoingInputError('Unable to read request body', 400);
  } finally {
    buffer = Buffer.alloc(0);
    req.signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
export function validateRawOutgoing(raw: Buffer) {
  if (raw.length > outgoingLimits().rawBytes) throw new OutgoingInputError('Raw message exceeds outgoing limit');
}
