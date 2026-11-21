const mockAdmissionEval = jest.fn();
jest.mock('ioredis', () => class { on() { return this; } eval(...args: unknown[]) { return mockAdmissionEval(...args); } });
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

jest.mock('@/lib/db/prisma', () => ({ prisma: { email: { findFirst: jest.fn() }, emailAccount: { findFirst: jest.fn() }, attachment: { findUnique: jest.fn() } } }));
jest.mock('@/lib/auth/middleware', () => ({ authenticate: jest.fn(async () => ({ userId: 'requester', organizationId: 'organization', role: 'member' })), apiError: (error: string, status: number) => Response.json({ error }, { status }) }));
jest.mock('@/lib/imap/connection-manager', () => ({ withImapConnection: jest.fn(), resolveMailboxPathOn: jest.fn() }));
jest.mock('@/lib/gmail/api', () => ({
  ...jest.requireActual('@/lib/gmail/api'),
  getValidAccessToken: jest.fn(), fetchGmailAttachment: jest.fn(),
}));
import { prisma } from '@/lib/db/prisma';
import { authenticate } from '@/lib/auth/middleware';
import { withImapConnection, resolveMailboxPathOn } from '@/lib/imap/connection-manager';
import { fetchGmailAttachment, getValidAccessToken, GmailApiError } from '@/lib/gmail/api';
import { getReceivedAttachment, AttachmentNotFoundError, AttachmentProviderError } from '@/lib/email/attachment-retrieval';
import { IncomingBudgetError, INCOMING_LIMITS } from '@/lib/email/incoming-budget';

let directory: string;
let storagePath: string;
const attachment = () => ({ id: 'att', emailId: 'email', filename: 'fixture.bin', contentType: 'application/test', sizeBytes: 7 as number | null, storagePath, imapPart: null as string | null, gmailAttachmentId: 'gmail-att' as string | null, ordinal: null as number | null });
let row: ReturnType<typeof attachment>;
const download = jest.fn();
const release = jest.fn();
beforeEach(async () => {
  jest.resetAllMocks();
  mockAdmissionEval.mockResolvedValue(1);
  (authenticate as jest.Mock).mockResolvedValue({ userId: 'requester', organizationId: 'organization', role: 'member' });
  directory = await mkdtemp(join(tmpdir(), 'mailhub-fallback-'));
  storagePath = join(directory, 'attachment');
  row = attachment();
  (prisma.email.findFirst as jest.Mock).mockImplementation(async () => ({ id: 'email', accountId: 'account', uid: BigInt(42), folder: 'INBOX', providerMessageId: 'message', attachments: [row] }));
  (getValidAccessToken as jest.Mock).mockResolvedValue('synthetic-token');
  (fetchGmailAttachment as jest.Mock).mockResolvedValue(Buffer.from('provider'));
  (resolveMailboxPathOn as jest.Mock).mockResolvedValue('INBOX');
  (withImapConnection as jest.Mock).mockImplementation(async (_id, run) => run({ download, getMailboxLock: async () => ({ release }) }));
  download.mockImplementation(async () => ({ content: Readable.from([Buffer.from('imap')]), meta: { filename: 'provider.bin' } }));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it.each(['missing', 'empty'])('falls back once from a %s local file and preserves metadata', async kind => {
  if (kind === 'empty') await writeFile(storagePath, '');
  await expect(getReceivedAttachment('email', 'att')).resolves.toMatchObject({ content: Buffer.from('provider'), filename: 'fixture.bin', contentType: 'application/test', sizeBytes: 8 });
  expect(fetchGmailAttachment).toHaveBeenCalledTimes(1);
});
it.each([0, null])('preserves local empty content with size %s', async size => {
  row.sizeBytes = size;
  await writeFile(storagePath, '');
  await expect(getReceivedAttachment('email', 'att')).resolves.toMatchObject({ sizeBytes: 0 });
  expect(getValidAccessToken).not.toHaveBeenCalled();
});
it('preserves healthy content despite a metadata mismatch', async () => {
  await writeFile(storagePath, 'healthy fixture');
  await expect(getReceivedAttachment('email', 'att')).resolves.toMatchObject({ content: Buffer.from('healthy fixture') });
  expect(getValidAccessToken).not.toHaveBeenCalled();
});
it.each(['missing', 'empty'])('returns not found for %s local-only content', async kind => {
  row.gmailAttachmentId = null;
  if (kind === 'empty') await writeFile(storagePath, '');
  await expect(getReceivedAttachment('email', 'att')).rejects.toBeInstanceOf(AttachmentNotFoundError);
  expect(getValidAccessToken).not.toHaveBeenCalled();
});
it('does not recover a non-ENOENT filesystem failure', async () => {
  row.storagePath = join(storagePath, 'child');
  await writeFile(storagePath, 'file');
  await expect(getReceivedAttachment('email', 'att')).rejects.toMatchObject({ code: 'ENOTDIR' });
  expect(getValidAccessToken).not.toHaveBeenCalled();
});
it('rejects actual local overflow without provider work', async () => {
  await writeFile(storagePath, Buffer.alloc(INCOMING_LIMITS.attachment + 1));
  await expect(getReceivedAttachment('email', 'att')).rejects.toBeInstanceOf(IncomingBudgetError);
  expect(getValidAccessToken).not.toHaveBeenCalled();
});
it('does not begin content work when cancelled', async () => {
  const signal = AbortSignal.abort(new Error('cancelled'));
  await expect(getReceivedAttachment('email', 'att', signal)).rejects.toThrow('cancelled');
  expect(prisma.email.findFirst).not.toHaveBeenCalled();
  expect(getValidAccessToken).not.toHaveBeenCalled();
});
it.each(['empty', 'missing', 'failure', 'oversize'])('rejects a Gmail %s fallback without retry', async kind => {
  if (kind === 'empty') (fetchGmailAttachment as jest.Mock).mockResolvedValue(Buffer.alloc(0));
  if (kind === 'missing') (fetchGmailAttachment as jest.Mock).mockRejectedValue(new GmailApiError('missing', 404));
  if (kind === 'failure') (fetchGmailAttachment as jest.Mock).mockRejectedValue(new Error('provider failed'));
  if (kind === 'oversize') (fetchGmailAttachment as jest.Mock).mockResolvedValue(Buffer.alloc(INCOMING_LIMITS.attachment + 1));
  await expect(getReceivedAttachment('email', 'att')).rejects.toBeInstanceOf(kind === 'failure' ? AttachmentProviderError : kind === 'oversize' ? IncomingBudgetError : AttachmentNotFoundError);
  expect(fetchGmailAttachment).toHaveBeenCalledTimes(1);
});
it.each(['healthy', 'empty', 'missing', 'failure'])('uses only IMAP for a %s fallback', async kind => {
  row.imapPart = '2';
  await writeFile(storagePath, '');
  if (kind === 'empty') download.mockResolvedValue({ content: Readable.from([]) });
  if (kind === 'missing') download.mockResolvedValue(null);
  if (kind === 'failure') download.mockRejectedValue(new Error('provider failed'));
  const result = getReceivedAttachment('email', 'att');
  if (kind === 'healthy') await expect(result).resolves.toMatchObject({ content: Buffer.from('imap'), filename: 'fixture.bin' });
  else await expect(result).rejects.toBeInstanceOf(kind === 'failure' ? AttachmentProviderError : AttachmentNotFoundError);
  expect(download).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(getValidAccessToken).not.toHaveBeenCalled();
});
it('preserves cancellation during provider fallback', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled during fallback', 'AbortError');
  (fetchGmailAttachment as jest.Mock).mockImplementation(async () => { controller.abort(reason); throw reason; });
  await expect(getReceivedAttachment('email', 'att', controller.signal)).rejects.toBe(reason);
  expect(fetchGmailAttachment).toHaveBeenCalledTimes(1);
});
it('preserves cancellation between the local read and fallback', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled', 'AbortError');
  const budget = await import('@/lib/email/incoming-budget');
  const read = jest.spyOn(budget, 'readIncomingFile').mockImplementationOnce(async () => {
    controller.abort(reason);
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  try {
    await expect(getReceivedAttachment('email', 'att', controller.signal)).rejects.toBe(reason);
    expect(getValidAccessToken).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
});
it.each(['imap', 'gmail'])('preserves %s admission failures during fallback', async provider => {
  const { AdmissionError } = await import('@/lib/workload/admission');
  const failure = new AdmissionError(true);
  if (provider === 'imap') {
    row.imapPart = '2';
    (withImapConnection as jest.Mock).mockRejectedValue(failure);
  } else (fetchGmailAttachment as jest.Mock).mockRejectedValue(failure);
  await expect(getReceivedAttachment('email', 'att')).rejects.toBe(failure);
});

it('keeps fallback in one requester admission scope and passes its signal', async () => {
  const { attachmentResponse } = await import('@/lib/workload/attachment-response');
  const { RESERVE, budgetKeys } = await import('@/lib/workload/admission');
  const owner = { userId: 'requester', organizationId: 'organization' };
  const response = await attachmentResponse(owner, new AbortController().signal,
    signal => getReceivedAttachment('email', 'att', signal), () => ({}));
  expect(await response.text()).toBe('provider');
  const reservations = mockAdmissionEval.mock.calls.filter(([script]) => script === RESERVE);
  expect(reservations).toHaveLength(1);
  expect(reservations[0].slice(2, 5)).toEqual(budgetKeys(owner, 'active'));
  expect(fetchGmailAttachment).toHaveBeenCalledWith('synthetic-token', 'message', 'gmail-att', expect.any(AbortSignal));
});
it('uses the original fixed response deadline during fallback', async () => {
  const { attachmentResponse } = await import('@/lib/workload/attachment-response');
  let fallbackSignal: AbortSignal | undefined;
  (fetchGmailAttachment as jest.Mock).mockImplementation(async (_token, _message, _attachment, signal) => {
    fallbackSignal = signal;
    return new Promise(() => {});
  });
  await expect(attachmentResponse({ userId: 'requester', organizationId: 'organization' }, new AbortController().signal,
    signal => getReceivedAttachment('email', 'att', signal), () => ({}), 25)).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(fallbackSignal?.aborted).toBe(true);
  expect(fetchGmailAttachment).toHaveBeenCalledTimes(1);
});

it.each(['all', 'new-emails', 'shared-account'])('recovers a stale path through the authorized %s route', async id => {
  const { GET } = await import('@/app/api/accounts/[id]/emails/[emailId]/attachments/[attachmentId]/route');
  (prisma.emailAccount.findFirst as jest.Mock).mockResolvedValue({ id: 'shared-account' });
  (prisma.attachment.findUnique as jest.Mock).mockResolvedValue(row);
  const response = await GET(new Request('http://localhost/fixture') as import('next/server').NextRequest, {
    params: Promise.resolve({ id, emailId: 'email', attachmentId: 'att' }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('provider');
  expect(fetchGmailAttachment).toHaveBeenCalledTimes(1);
});
it('does not contact Gmail for an attachment id without a message reference', async () => {
  (prisma.email.findFirst as jest.Mock).mockResolvedValue({ id: 'email', accountId: 'account', providerMessageId: null, uid: null, folder: 'INBOX', attachments: [row] });
  await expect(getReceivedAttachment('email', 'att')).rejects.toBeInstanceOf(AttachmentNotFoundError);
  expect(getValidAccessToken).not.toHaveBeenCalled();
});
it('does not contact IMAP for a part without a UID', async () => {
  row.imapPart = '2';
  (prisma.email.findFirst as jest.Mock).mockResolvedValue({ id: 'email', accountId: 'account', providerMessageId: null, uid: null, folder: 'INBOX', attachments: [row] });
  await expect(getReceivedAttachment('email', 'att')).rejects.toBeInstanceOf(AttachmentNotFoundError);
  expect(withImapConnection).not.toHaveBeenCalled();
});
