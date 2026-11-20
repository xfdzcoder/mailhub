import { AsyncLocalStorage } from 'node:async_hooks';
import { INCOMING_LIMITS, IncomingBudgetError } from '@/lib/email/incoming-budget';
import type { RetrievedAttachment } from '@/lib/email/attachment-retrieval';
import { assertWorkLease, withWork, workSignal, type WorkOwner } from './admission';

/** Retrieval and the response share one admission scope. No eager Redis access. */
export function attachmentResponse(
  owner: WorkOwner,
  requestSignal: AbortSignal,
  retrieve: (signal: AbortSignal) => Promise<RetrievedAttachment>,
  headers: (attachment: RetrievedAttachment) => HeadersInit,
  timeoutMs: number = INCOMING_LIMITS.timeoutMs,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    void withWork(owner, async () => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new DOMException('Attachment download timed out', 'TimeoutError')), timeoutMs);
      timer.unref();
      const signal = AbortSignal.any([requestSignal, workSignal()!, deadline.signal]);
      const inContext = AsyncLocalStorage.snapshot();
      let content: Buffer | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let finished = false;
      let complete!: () => void;
      const completion = new Promise<void>(done => { complete = done; });
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        content = undefined;
        signal.removeEventListener('abort', abort);
        if (error) controller?.error(error);
        complete();
      };
      const abort = () => finish(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        let retrieved: RetrievedAttachment | undefined = await Promise.race([
          retrieve(signal),
          new Promise<never>((_, fail) => {
            completion.then(() => { if (signal.aborted) fail(signal.reason); });
          }),
        ]);
        signal.throwIfAborted();
        await assertWorkLease();
        signal.throwIfAborted();
        if (retrieved.content.length > INCOMING_LIMITS.attachment) throw new IncomingBudgetError();
        content = retrieved.content;
        const responseHeaders = headers(retrieved);
        retrieved = undefined;
        // Drop the retrieval result from the long-lived scope; finish clears the
        // only retained buffer, including when a response is never consumed.
        let offset = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          pull: () => inContext(async () => {
            try {
              signal.throwIfAborted();
              await assertWorkLease();
              signal.throwIfAborted();
              if (finished) return;
              if (offset === content!.length) {
                controller!.close();
                finish();
                return;
              }
              const end = Math.min(offset + 64 * 1024, content!.length);
              // Copy only a demanded chunk, rather than exposing a view that
              // retains the entire attachment in the consumer.
              controller!.enqueue(Uint8Array.from(content!.subarray(offset, end)));
              offset = end;
            } catch (error) { finish(error); }
          }),
          cancel() { finish(); },
        }, { highWaterMark: 0 });
        resolve(new Response(stream, { headers: responseHeaders }));
        await completion;
      } finally {
        finish();
      }
    }, 0, true).catch(reject);
  });
}
