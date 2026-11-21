import { assertWorkLease, workSignal } from '@/lib/workload/admission';

// Token responses are small; cap actual decoded response bytes, regardless of headers.
export const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
export const TOKEN_REFRESH_TIMEOUT_MS = 30_000;

export async function assertTokenWork(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  workSignal()?.throwIfAborted();
  await assertWorkLease();
  signal?.throwIfAborted();
  workSignal()?.throwIfAborted();
}

export async function exchangeOAuthToken(
  endpoint: string,
  params: Record<string, string>,
  requestSignal?: AbortSignal,
) {
  const leaseSignal = workSignal();
  const signal = AbortSignal.any([
    AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
    ...(requestSignal ? [requestSignal] : []),
    ...(leaseSignal ? [leaseSignal] : []),
  ]);
  const assertActive = () => assertTokenWork(signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const abort = () => { void reader?.cancel().catch(() => {}); };
  try {
    await assertActive();
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal,
    });
    signal.throwIfAborted();
    reader = response.body?.getReader();
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > TOKEN_RESPONSE_MAX_BYTES) throw new Error();
        chunks.push(value);
      }
    }
    await assertActive();
    if (!response.ok) throw new Error();
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data.access_token !== 'string' || !data.access_token ||
        typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0 || !Number.isFinite(new Date(Date.now() + data.expires_in * 1000).getTime()) ||
        (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token))) {
      throw new Error();
    }
    return { data: data as { access_token: string; expires_in: number; refresh_token?: string }, assertActive };
  } catch {
    // Never expose provider bodies, fetch errors (which can include URLs), or abort reasons.
    throw new Error('OAuth token refresh failed or was cancelled');
  } finally {
    signal.removeEventListener('abort', abort);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else {
      void response?.body?.cancel().catch(() => {});
    }
  }
}
