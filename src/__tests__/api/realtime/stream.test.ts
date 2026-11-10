jest.mock('@/lib/auth/middleware', () => ({ authenticate: jest.fn() }));
jest.mock('@/lib/realtime/access', () => ({
  ...jest.requireActual('@/lib/realtime/access'),
  loadAccessibleRealtimeAccountIds: jest.fn(),
}));
jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

import { NextRequest, NextResponse } from 'next/server';
import Redis from 'ioredis';
import { authenticate } from '@/lib/auth/middleware';
import { loadAccessibleRealtimeAccountIds } from '@/lib/realtime/access';
import { GET } from '@/app/api/realtime/stream/route';
import { EventEmitter } from 'events';

const auth = { userId: 'user-1', organizationId: 'org-1', role: 'member' };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve!: (value: Set<string>) => void;
  const promise = new Promise<Set<string>>(r => { resolve = r; });
  return { promise, resolve };
};
let subscriber: EventEmitter & { subscribe: jest.Mock; disconnect: jest.Mock };
let abort: AbortController;
const open = async () => {
  abort = new AbortController();
  const response = await GET(new NextRequest('http://localhost/api/realtime/stream', { signal: abort.signal }));
  return response.body!.getReader();
};
const emit = (event: string, accountId: string, channel = 'new_email:org-1') =>
  subscriber.emit('message', channel, JSON.stringify({ event, accountId, subject: 'private' }));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (authenticate as jest.Mock).mockResolvedValue(auth);
  (loadAccessibleRealtimeAccountIds as jest.Mock).mockResolvedValue(new Set(['a', 'b']));
  subscriber = Object.assign(new EventEmitter(), {
    subscribe: jest.fn().mockResolvedValue(undefined), disconnect: jest.fn(),
  });
  (Redis as unknown as jest.Mock).mockImplementation(() => subscriber);
});
afterEach(() => { abort?.abort(); jest.useRealTimers(); });

it.each([false, true])('preserves events across a delayed lookup (heartbeat: %s)', async heartbeat => {
  const reader = await open();
  await reader.read(); // reconnect delay
  const lookup = deferred();
  (loadAccessibleRealtimeAccountIds as jest.Mock).mockImplementationOnce(() => lookup.promise);
  if (heartbeat) jest.advanceTimersByTime(15000);
  else emit('new_email', 'a');
  await flush();
  emit('initial_sync_complete', 'b');
  emit('sync_progress', 'a');
  lookup.resolve(new Set(['a', 'b']));
  await flush();
  const first = (await reader.read()).value;
  expect(first).toBe(heartbeat ? ': heartbeat\n\n' : 'event: new_email\ndata: {"accountId":"a"}\n\n');
  expect((await reader.read()).value).toBe('event: initial_sync_complete\ndata: {"accountId":"b"}\n\n');
  expect((await reader.read()).value).toBe('event: sync_progress\ndata: {"accountId":"a"}\n\n');
  expect(loadAccessibleRealtimeAccountIds).toHaveBeenCalledTimes(3);
  await reader.cancel();
});

it('rechecks queued events after sharing revocation and ignores other organizations', async () => {
  const reader = await open(); await reader.read();
  const lookup = deferred();
  (loadAccessibleRealtimeAccountIds as jest.Mock).mockImplementationOnce(() => lookup.promise)
    .mockResolvedValue(new Set(['a']));
  emit('new_email', 'a'); await flush();
  emit('new_email', 'b'); emit('new_email', 'a', 'new_email:org-2');
  lookup.resolve(new Set(['a'])); await flush();
  expect((await reader.read()).value).toContain('"a"');
  expect(loadAccessibleRealtimeAccountIds).toHaveBeenCalledTimes(2);
  await reader.cancel();
});

it.each(['abort', 'cancel', 'lifetime', 'error', 'end', 'revoked', 'lookup failure'])('cleans up idempotently on %s', async reason => {
  const reader = await open(); await reader.read();
  if (reason === 'abort') abort.abort();
  if (reason === 'cancel') await reader.cancel();
  if (reason === 'lifetime') await jest.advanceTimersByTimeAsync(300000);
  if (reason === 'error' || reason === 'end') subscriber.emit(reason);
  if (reason === 'revoked') {
    (authenticate as jest.Mock).mockResolvedValue(NextResponse.json({}, { status: 401 }));
    await jest.advanceTimersByTimeAsync(15000);
  }
  if (reason === 'lookup failure') {
    (loadAccessibleRealtimeAccountIds as jest.Mock).mockRejectedValue(new Error('db'));
    emit('new_email', 'a'); await flush();
  }
  abort.abort();
  expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  while (!(await reader.read()).done) { /* drain buffered heartbeats */ }
});

it('does not deliver after cancellation during a lookup', async () => {
  const reader = await open(); await reader.read();
  const lookup = deferred();
  (loadAccessibleRealtimeAccountIds as jest.Mock).mockReturnValue(lookup.promise);
  emit('new_email', 'a'); await flush();
  await reader.cancel(); lookup.resolve(new Set(['a'])); await flush();
  expect((await reader.read()).done).toBe(true);
  expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
});

it.each(['constructor', 'subscribe'])('releases connection slots after %s startup failure', async failure => {
  if (failure === 'constructor') (Redis as unknown as jest.Mock).mockImplementation(() => { throw new Error('startup'); });
  else subscriber.subscribe.mockRejectedValue(new Error('subscribe'));
  for (let i = 0; i < 7; i++) {
    const reader = await open(); await flush();
    while (!(await reader.read()).done) { /* drain retry */ }
  }
  expect(jest.getTimerCount()).toBe(0);
});

it('closes on bounded queue overflow during a stalled permission lookup', async () => {
  const reader = await open(); await reader.read();
  const lookup = deferred();
  (loadAccessibleRealtimeAccountIds as jest.Mock).mockReturnValue(lookup.promise);
  emit('new_email', 'a'); await flush();
  for (let i = 0; i < 101; i++) emit('sync_progress', 'b');
  expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  lookup.resolve(new Set(['a', 'b'])); await flush();
  expect((await reader.read()).done).toBe(true);
});

it('isolates users and organizations and releases the five-stream limit', async () => {
  const readers = [];
  for (let i = 0; i < 5; i++) readers.push(await open());
  const request = () => new NextRequest('http://localhost/api/realtime/stream');
  expect((await GET(request())).status).toBe(429);
  (authenticate as jest.Mock).mockResolvedValue({ userId: 'user-2', organizationId: 'org-2', role: 'admin' });
  const other = await GET(request());
  expect(other.status).toBe(200);
  await other.body!.cancel();
  await Promise.all(readers.map(reader => reader.cancel()));
  (authenticate as jest.Mock).mockResolvedValue(auth);
  const reopened = await open();
  expect((await reopened.read()).value).toBe('retry: 5000\n\n');
  await reopened.cancel();
});

it('does not allocate Redis or timers for an already aborted request', async () => {
  abort = new AbortController(); abort.abort();
  const response = await GET(new NextRequest('http://localhost/api/realtime/stream', { signal: abort.signal }));
  expect((await response.body!.getReader().read()).done).toBe(true);
  expect(Redis).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it.each([
  { ...auth, userId: 'user-2' },
  { ...auth, organizationId: 'org-2' },
])('closes when revalidation changes the stream identity: %j', async current => {
  const reader = await open(); await reader.read();
  (authenticate as jest.Mock).mockResolvedValue(current);
  emit('new_email', 'a'); await flush();
  expect((await reader.read()).done).toBe(true);
  expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  expect(loadAccessibleRealtimeAccountIds).not.toHaveBeenCalled();
});

it('bounds output buffering for a client that stops reading', async () => {
  const reader = await open(); await reader.read();
  for (let i = 0; i < 101; i++) {
    emit('new_email', 'a'); await flush();
  }
  expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  await reader.cancel();
});
