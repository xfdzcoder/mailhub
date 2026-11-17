jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    emailAccount: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('@/lib/crypto', () => ({
  decrypt: jest.fn(),
  encrypt: jest.fn(),
}));

import { fetchGmailAttachment, decodeGmailBase64 } from '@/lib/gmail/api';

describe('fetchGmailAttachment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('decodes Gmail attachment data from base64url to a Buffer', async () => {
    const mockFetch = global.fetch as jest.Mock;
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: 'Pz8_Rg' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(
      fetchGmailAttachment('token', 'message-1', 'attachment-1')
    ).resolves.toEqual(Buffer.from('??\x3fF'));
  });

  it('throws GmailApiError with the HTTP status for non-2xx responses', async () => {
    const mockFetch = global.fetch as jest.Mock;
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'nope' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(
      fetchGmailAttachment('token', 'message-1', 'attachment-1')
    ).rejects.toMatchObject({
      name: 'GmailApiError',
      status: 404,
    });
  });
});

it('downloads a complete synthetic multi-chunk attachment without trusting its declared size', async () => {
  const original = Buffer.alloc(230_123);
  for (let i = 0; i < original.length; i++) original[i] = i % 251;
  const json = Buffer.from(JSON.stringify({ size: 1, data: original.toString('base64url') }));
  let offset = 0;
  const provider = new Response(new ReadableStream({
    pull(controller) {
      if (offset === json.length) { controller.close(); return; }
      const next = Math.min(offset + 8191, json.length);
      controller.enqueue(json.subarray(offset, next));
      offset = next;
    },
  }), { headers: { 'Content-Type': 'application/json' } });
  const fetch = jest.spyOn(global, 'fetch').mockClear().mockResolvedValueOnce(provider);
  try {
    const downloaded = await fetchGmailAttachment('synthetic-token', 'synthetic-message', 'synthetic-part');
    expect(downloaded.equals(original)).toBe(true);
    expect(downloaded.length).toBe(230_123);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { fetch.mockRestore(); }
});

it.each(['abc=def', '====', 'a', 'ab='])('keeps malformed provider encoding retryable: %s', data => {
  const { IncomingPolicyError } = jest.requireActual('@/lib/email/incoming-budget');
  try { decodeGmailBase64(data); throw new Error('expected invalid encoding'); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(IncomingPolicyError);
    expect((error as Error).message).toBe('Malformed provider encoding');
  }
});
