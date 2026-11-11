import { Worker } from 'node:worker_threads';
import type { ParsedMail } from 'mailparser';
import { IncomingBudgetError, INCOMING_LIMITS } from './incoming-budget';

// Keep third-party MIME decoding and HTML conversion outside the application heap.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { MailParser } = require(workerData.module);
const { Transform, compose } = require('node:stream');
const limits = workerData.limits;
const parser = new MailParser({ maxHtmlLengthToParse: limits.decoded, maxInlinedImagesSize: limits.decoded });
let total = 0;
let count = 0;
const attachments = [];
let text = {};
let headers;
let headerLines;
const pending = [];
function charge(size) {
  total += size;
  if (total > limits.decoded) throw new Error('Decoded MIME budget exceeded');
}
// Pinned mailparser adapter: gate transfer and charset decoder output before
// its text accumulator sees bytes. Tests must cover this hook on upgrades.
function gate(stream, perPart = limits.decoded) {
  let size = 0;
  return compose(stream, new Transform({ transform(chunk, encoding, done) {
    try {
      size += Buffer.byteLength(chunk);
      if (size > perPart) throw new Error('MIME part byte budget exceeded');
      charge(Buffer.byteLength(chunk));
      done(null, chunk);
    } catch (error) { done(error); }
  } }));
}
const createNode = parser.createNode.bind(parser);
parser.createNode = node => {
  if (++count > limits.parts) throw new Error('MIME part budget exceeded');
  const result = createNode(node);
  if (result.decoder) result.decoder = gate(result.decoder, result.isAttachment ? limits.attachment : limits.decoded);
  return result;
};
const decodeStream = parser.decoder.decodeStream.bind(parser.decoder);
parser.decoder.decodeStream = charset => gate(decodeStream(charset));
parser.on('headers', value => { headers = value; });
parser.on('headerLines', value => { headerLines = value; });
parser.on('data', part => {
  if (part.type === 'text') {
    try {
      for (const field of ['html', 'text', 'textAsHtml']) if (typeof part[field] === 'string') charge(Buffer.byteLength(part[field]));
      text = part;
    } catch (error) { parser.destroy(error); }
    return;
  }
  const task = (async () => {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of part.content) {
        size += chunk.length;
        if (size > limits.attachment) throw new Error('Attachment budget exceeded');
        chunks.push(chunk);
      }
      const { content, release, ...metadata } = part;
      attachments.push({ ...metadata, content: Buffer.concat(chunks, size), size });
    } finally { part.content.destroy(); part.release(); }
  })();
  pending.push(task);
  task.catch(error => parser.destroy(error));
});
parser.on('error', error => { parentPort.postMessage({ error: error.message }); });
parser.on('end', async () => {
  try {
    await Promise.all(pending);
    // Preserve simpleParser's CID image behavior, measuring repeated expansion
    // before constructing data URLs or the replacement HTML string.
    if (text.html) {
      const urls = new Map();
      text.html = text.html.replace(/\\bcid:([^'"\\s]{1,256})/g, (match, cid) => {
        const attachment = attachments.find(item => item.cid === cid && /^image\\/[\\w]+$/i.test(item.contentType));
        if (!attachment) return match;
        const prefix = 'data:' + attachment.contentType + ';base64,';
        charge(prefix.length + 4 * Math.ceil(attachment.content.length / 3));
        if (!urls.has(cid)) urls.set(cid, prefix + attachment.content.toString('base64'));
        return urls.get(cid);
      });
    }
    const result = { ...text, headers, headerLines, attachments };
    for (const key of ['subject','date','message-id','in-reply-to','references','from','to','cc','bcc','reply-to']) {
      const field = { 'message-id':'messageId', 'in-reply-to':'inReplyTo', 'reply-to':'replyTo' }[key] || key;
      result[field] = headers.get(key);
    }
    parentPort.postMessage({ result });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
});
parser.end(Buffer.from(workerData.raw));
`;

export async function parseBoundedMime(raw: Buffer | string, signal?: AbortSignal): Promise<ParsedMail> {
  signal?.throwIfAborted();
  if (Buffer.byteLength(raw) > INCOMING_LIMITS.raw) throw new IncomingBudgetError();
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { raw, limits: INCOMING_LIMITS, module: require.resolve('mailparser') },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const parsed = await new Promise<ParsedMail>((resolve, reject) => {
      onAbort = () => reject(signal?.reason ?? new IncomingBudgetError('MIME parse cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timer = setTimeout(() => reject(new IncomingBudgetError('MIME parse timed out')), INCOMING_LIMITS.timeoutMs);
      worker.once('message', ({ result, error }) => error ? reject(new IncomingBudgetError(error)) : resolve(result));
      worker.once('error', error => reject(new IncomingBudgetError(error.message)));
      worker.once('exit', code => reject(new IncomingBudgetError(`MIME worker exited (${code})`)));
    });
    for (const attachment of parsed.attachments) attachment.content = Buffer.from(attachment.content);
    return parsed;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    await worker.terminate();
  }
}
