jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    emailAccount: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('@/lib/crypto', () => ({
  decrypt: jest.fn(() => 'secret'),
  encrypt: jest.fn(),
}));

jest.mock('@/lib/network/outbound-host', () => ({
  resolveSafeOutboundHost: jest.fn(),
}));

jest.mock('imapflow', () => ({ ImapFlow: jest.fn() }));
jest.mock('@/lib/redis', () => ({ redis: { publish: jest.fn() } }));
jest.mock('@/lib/queue/client', () => ({ searchQueue: { add: jest.fn() } }));
jest.mock('@/lib/ai/spam-checker', () => ({ checkIsHighRisk: jest.fn() }));
jest.mock('@/lib/rules/engine', () => ({ processRulesForNewEmail: jest.fn() }));

import { imapManager, withImapConnection } from '@/lib/imap/connection-manager';
import { prisma } from '@/lib/db/prisma';
import { resolveSafeOutboundHost } from '@/lib/network/outbound-host';
import { ImapFlow } from 'imapflow';

const unsafeAccount = {
  id: 'account-1',
  organizationId: 'org-1',
  emailAddress: 'user@example.com',
  provider: 'imap',
  imapHost: 'imap.internal',
  imapPort: 993,
  imapSecure: true,
  username: 'user@example.com',
  passwordEncrypted: 'encrypted',
  oauthAccessToken: null,
  oauthRefreshToken: null,
  oauthTokenExpiry: null,
  oauthProvider: null,
};

describe('IMAP worker connection SSRF guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (resolveSafeOutboundHost as jest.Mock).mockRejectedValue(
      new Error('imap.internal resolves to a non-public address')
    );
  });

  it('blocks short-lived provider connections before constructing ImapFlow', async () => {
    (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue(unsafeAccount);

    await expect(
      withImapConnection('account-1', async () => 'never')
    ).resolves.toBeNull();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('blocks pooled worker initialization before constructing ImapFlow', async () => {
    await expect(
      imapManager.initializeAccount(
        unsafeAccount as unknown as Parameters<typeof imapManager.initializeAccount>[0]
      )
    ).rejects.toThrow(
      'resolves to a non-public address'
    );
    expect(ImapFlow).not.toHaveBeenCalled();
  });
});


describe('bounded attachment IMAP connection cancellation', () => {
  it.each(['connect', 'operation', 'logout'])('closes a connection cancelled during %s', async phase => {
    (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue(unsafeAccount);
    (resolveSafeOutboundHost as jest.Mock).mockResolvedValue({ address: '203.0.113.1' });
    const request = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let stop!: (error: unknown) => void;
    const pending = () => { entered(); return new Promise<never>((_, reject) => { stop = reject; }); };
    const client = {
      connect: jest.fn(phase === 'connect' ? pending : async () => {}),
      logout: jest.fn(phase === 'logout' ? pending : async () => {}),
      close: jest.fn(() => stop(request.signal.reason)),
    };
    (ImapFlow as unknown as jest.Mock).mockImplementation(() => client);
    const operation = jest.fn(phase === 'operation' ? pending : async () => 'fixture');
    const running = withImapConnection('account-1', operation, { signal: request.signal, propagateErrors: true });
    await started;
    request.abort(new Error('synthetic disconnect'));
    if (phase === 'logout') await expect(running).resolves.toBe('fixture');
    else await expect(running).rejects.toThrow('synthetic disconnect');
    expect(client.close).toHaveBeenCalled();
    if (phase === 'connect') expect(operation).not.toHaveBeenCalled();
  });
});

describe('OAuth refresh cancellation before provider setup', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  it.each(['headers', 'body'])('prevents writes and IMAP setup during refresh %s', async phase => {
    jest.clearAllMocks();
    const request = new AbortController();
    (prisma.emailAccount.findUnique as jest.Mock).mockResolvedValue({
      ...unsafeAccount, oauthProvider: 'google', oauthAccessToken: 'synthetic',
      oauthRefreshToken: 'synthetic', oauthTokenExpiry: new Date(0),
    });
    global.fetch = jest.fn(async (_url, options) => {
      if (phase === 'headers') return new Promise<Response>((_, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('synthetic')));
        request.abort();
      });
      return new Response(new ReadableStream({ start() { setImmediate(() => request.abort()); } }));
    });
    await expect(withImapConnection('account-1', async () => 'never', { signal: request.signal }))
      .rejects.toThrow('OAuth token refresh failed');
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });
});


it('stops pooled Google setup on refresh failure without using the old token', async () => {
  jest.clearAllMocks();
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => new Response('synthetic-provider-secret', { status: 400 }));
  try {
    await expect(imapManager.initializeAccount({
      ...unsafeAccount, oauthProvider: 'google', oauthAccessToken: 'synthetic',
      oauthRefreshToken: 'synthetic', oauthTokenExpiry: new Date(0),
    } as unknown as Parameters<typeof imapManager.initializeAccount>[0])).rejects.toThrow(/^OAuth token refresh failed or was cancelled$/);
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  } finally { global.fetch = originalFetch; }
});
