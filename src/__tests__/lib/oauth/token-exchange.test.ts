jest.mock('@/lib/workload/admission', () => ({ assertWorkLease: jest.fn(), workSignal: jest.fn() }));
import { assertWorkLease, workSignal } from '@/lib/workload/admission';
import { exchangeOAuthToken, TOKEN_RESPONSE_MAX_BYTES } from '@/lib/oauth/token-exchange';

const good = JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-rotation', expires_in: 3600 });
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); jest.clearAllMocks(); });

it.each(['headers', 'body'])('cancels while waiting for %s', async phase => {
  const request = new AbortController();
  const cancel = jest.fn();
  global.fetch = jest.fn(async (_url, options) => {
    if (phase === 'headers') return new Promise<Response>((_, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('secret-provider-body')));
      request.abort();
    });
    const response = new Response(new ReadableStream({ start() { setImmediate(() => request.abort()); }, cancel }));
    return response;
  });
  await expect(exchangeOAuthToken('https://fixture.invalid', {}, request.signal)).rejects.toThrow('OAuth token refresh failed or was cancelled');
  if (phase === 'body') expect(cancel).toHaveBeenCalled();
});

it.each([200, 400])('caps actual bytes with misleading headers on status %s', async status => {
  const cancel = jest.fn();
  global.fetch = jest.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(TOKEN_RESPONSE_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel,
  }), { status, headers: { 'Content-Length': '1' } }));
  await expect(exchangeOAuthToken('https://fixture.invalid', {})).rejects.toThrow('OAuth token refresh failed');
  expect(cancel).toHaveBeenCalled();
});

it.each(['secret-provider-body', '{}', '{"access_token":"secret","expires_in":-1}'])('rejects malformed responses generically', async body => {
  global.fetch = jest.fn(async () => new Response(body));
  await expect(exchangeOAuthToken('https://fixture.invalid', {})).rejects.toThrow(/^OAuth token refresh failed or was cancelled$/);
});

it('checks lease before fetch and again before persistence', async () => {
  global.fetch = jest.fn(async () => new Response(good));
  const result = await exchangeOAuthToken('https://fixture.invalid', { scope: 'synthetic-scope' });
  expect(result.data.refresh_token).toBe('synthetic-rotation');
  (assertWorkLease as jest.Mock).mockRejectedValueOnce(new Error('lease lost'));
  await expect(result.assertActive()).rejects.toThrow('lease lost');
  (assertWorkLease as jest.Mock).mockRejectedValueOnce(new Error('lease lost'));
  await expect(exchangeOAuthToken('https://fixture.invalid', {})).rejects.toThrow('OAuth token refresh failed');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it('uses one deadline for headers and body without a work context', async () => {
  const deadline = new AbortController();
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  global.fetch = jest.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(good)); setImmediate(() => deadline.abort()); },
  })));
  await expect(exchangeOAuthToken('https://fixture.invalid', {})).rejects.toThrow('OAuth token refresh failed');
  expect(timeout).toHaveBeenCalledTimes(1);
  expect(timeout).toHaveBeenCalledWith(30_000);
});

it.each(['headers', 'body'])('composes work cancellation during %s', async phase => {
  const lease = new AbortController();
  (workSignal as jest.Mock).mockReturnValueOnce(lease.signal);
  global.fetch = jest.fn(async () => {
    if (phase === 'headers') { lease.abort(); return new Response(good); }
    return new Response(new ReadableStream({ start() { setImmediate(() => lease.abort()); } }));
  });
  await expect(exchangeOAuthToken('https://fixture.invalid', {})).rejects.toThrow('OAuth token refresh failed');
});

it('bounds a chunked error body from a local HTTP fixture', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_request, response) => {
    response.writeHead(400);
    response.write(Buffer.alloc(TOKEN_RESPONSE_MAX_BYTES));
    response.end(Buffer.alloc(1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as import('node:net').AddressInfo;
    await expect(exchangeOAuthToken(`http://127.0.0.1:${address.port}`, {}))
      .rejects.toThrow(/^OAuth token refresh failed or was cancelled$/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
