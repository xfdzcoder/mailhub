jest.mock('@/lib/auth/middleware', () => ({ authenticate: jest.fn() }));
jest.mock('@/lib/oauth/transactions', () => ({ createOAuthTransaction: jest.fn() }));
// Endpoint fixtures isolate Redis; distributed policy is exercised separately.
jest.mock('ioredis', () => class {
  on() { return this; }
  async eval() { return 1; }
  async zrem() { return 1; }
});

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/accounts/oauth/google/init/route';
import { authenticate } from '@/lib/auth/middleware';
import { createOAuthTransaction } from '@/lib/oauth/transactions';

it('normalizes the requested mailbox before creating server-side state and login hint', async () => {
  process.env.GOOGLE_CLIENT_ID = 'synthetic-client';
  const auth = { sessionId: 'session-1', userId: 'user-1', organizationId: 'org-1', role: 'member' };
  (authenticate as jest.Mock).mockResolvedValue(auth);
  (createOAuthTransaction as jest.Mock).mockResolvedValue({ state: 'opaque', challenge: 'challenge', redirectUri: 'https://app.example/api/accounts/oauth/google/callback' });
  const response = await GET(new NextRequest('https://app.example/api/accounts/oauth/google/init?emailAddress=Owner%40Example.com&label=Owner%20Inbox'));
  const url = new URL(response.headers.get('location')!);
  expect(createOAuthTransaction).toHaveBeenCalledWith('google', auth, 'owner@example.com', 'Owner Inbox');
  expect(url.searchParams.get('login_hint')).toBe('owner@example.com');
  expect(url.searchParams.get('state')).toBe('opaque');
});
