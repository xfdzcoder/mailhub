const mockEval = jest.fn();
jest.mock('ioredis', () => class {
  on() { return this; }
  eval(...args: unknown[]) { return mockEval(...args); }
});
import { AsyncLocalStorage } from 'node:async_hooks';
import { attachmentResponse } from '@/lib/workload/attachment-response';
import { AdmissionError, RELEASE, RENEW, RESERVE, budgetKeys } from '@/lib/workload/admission';
import { INCOMING_LIMITS, IncomingBudgetError } from '@/lib/email/incoming-budget';

const owner = { userId: 'requester', organizationId: 'org' };
const retrieved = () => ({ content: Buffer.alloc(130000, 42), filename: 'fixture', contentType: 'application/octet-stream', sizeBytes: 130000 });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
const releases = () => mockEval.mock.calls.filter(([script]) => script === RELEASE);
beforeEach(() => { mockEval.mockReset().mockResolvedValue(1); });

test('retains admission for unconsumed and slow responses, checking originating context on every pull', async () => {
  const response = await attachmentResponse(owner, new AbortController().signal, async () => retrieved(), () => ({}));
  expect(releases()).toHaveLength(0);
  expect(mockEval.mock.calls.find(([script]) => script === RESERVE)?.slice(2, 5)).toEqual(budgetKeys(owner, 'active'));
  const reader = response.body!.getReader();
  const consumer = new AsyncLocalStorage<string>();
  await consumer.run('different consumer', async () => {
    expect((await reader.read()).value).toHaveLength(65536);
    await settle();
    expect(releases()).toHaveLength(0);
    mockEval.mockImplementation(async script => script === RENEW ? 0 : 1);
    await expect(reader.read()).rejects.toBeInstanceOf(AdmissionError);
  });
  await settle();
  expect(releases()).toHaveLength(1);
});

test.each([false, true])('capacity/storage denial prevents retrieval (%s)', async unavailable => {
  mockEval.mockImplementation(async () => { if (unavailable) throw new Error('private backend'); return 0; });
  const read = jest.fn(async () => retrieved());
  await expect(attachmentResponse(owner, new AbortController().signal, read, () => ({}))).rejects.toMatchObject({ unavailable });
  expect(read).not.toHaveBeenCalled();
});

test('completion and repeated cancel release exactly once', async () => {
  const response = await attachmentResponse(owner, new AbortController().signal, async () => retrieved(), () => ({}));
  expect((await response.arrayBuffer()).byteLength).toBe(130000);
  await settle();
  expect(releases()).toHaveLength(1);
  mockEval.mockClear();
  const cancelled = await attachmentResponse(owner, new AbortController().signal, async () => retrieved(), () => ({}));
  await cancelled.body!.cancel();
  await cancelled.body!.cancel();
  await settle();
  expect(releases()).toHaveLength(1);
});

test.each(['request', 'timeout'])('%s terminates an unconsumed response and frees admission', async mode => {
  const request = new AbortController();
  const response = await attachmentResponse(owner, request.signal, async () => retrieved(), () => ({}), mode === 'timeout' ? 15 : 1000);
  if (mode === 'request') request.abort();
  await new Promise(resolve => setTimeout(resolve, 30));
  await expect(response.arrayBuffer()).rejects.toThrow();
  expect(releases()).toHaveLength(1);
});

test('deadline propagates into a pending read and frees admission', async () => {
  let readSignal: AbortSignal | undefined;
  await expect(attachmentResponse(owner, new AbortController().signal, signal => {
    readSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, () => ({}), 15)).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(readSignal?.aborted).toBe(true);
  expect(releases()).toHaveLength(1);
});

test('retrieval failures and actual bytes above cap release admission', async () => {
  await expect(attachmentResponse(owner, new AbortController().signal, async () => { throw new Error('provider failure'); }, () => ({}))).rejects.toThrow('provider failure');
  expect(releases()).toHaveLength(1);
  await expect(attachmentResponse(owner, new AbortController().signal, async () => ({ ...retrieved(), content: Buffer.alloc(INCOMING_LIMITS.attachment + 1) }), () => ({}))).rejects.toBeInstanceOf(IncomingBudgetError);
  expect(releases()).toHaveLength(2);
});
