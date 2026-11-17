import { spawn, type ChildProcess } from 'node:child_process';
import Redis from 'ioredis';
import { withWork, assertWorkLease, admissionRedis, budgetKeys, AdmissionError } from '@/lib/workload/admission';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Socket } from 'node:net';
import { prisma } from '@/lib/db/prisma';
import { stageOutgoingFiles } from '@/lib/email/outgoing-files';
import { attachmentRoot, reserveAttachment, publishAttachment, releaseAttachment, reconcileAttachmentAccounting } from '@/lib/email/attachment-accounting';
import { claimSend, reconcileSendOperations, sendOperationLimits } from '@/lib/workload/send-once';
import { sendEmail } from '@/lib/smtp/sender';
import { getDecryptedAccount } from '@/lib/accounts/service';

jest.mock('@/lib/accounts/service', () => ({ getDecryptedAccount: jest.fn() }));
jest.mock('@/lib/gmail/api', () => ({ getValidAccessToken: jest.fn(), sendMessageRaw: jest.fn() }));
jest.mock('@/lib/network/outbound-host', () => ({ resolveSafeOutboundHost: jest.fn(async () => ({ address: '127.0.0.1', family: 4 })) }));

const integration = process.env.WORKLOAD_TEST_DATABASE_URL ? describe : describe.skip;
integration('durable accounting and send replay on disposable PostgreSQL and SMTP', () => {
  let directory: string;
  let redisDirectory: string;
  let redisServer: ChildProcess | undefined;
  let redis: Redis | undefined;
  const priorRedisUrl = process.env.REDIS_URL;
  let cwd: jest.SpyInstance;
  let owner: { organizationId: string; accountId: string };
  let userId: string;
  const attachment = { filename: 'synthetic.bin', contentType: 'application/octet-stream', content: 'YWJj' };
  beforeAll(async () => {
    const url = new URL(process.env.WORKLOAD_TEST_DATABASE_URL!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_test') || process.env.DATABASE_URL !== url.toString()) throw new Error('Use an explicitly isolated loopback *_test database');
    if (process.env.WORKLOAD_TEST_REDIS_SERVER) {
      redisDirectory = await mkdtemp(path.join(tmpdir(), 'mailhub-accounting-redis-'));
      const socket = path.join(redisDirectory, 'redis.sock');
      redisServer = spawn(process.env.WORKLOAD_TEST_REDIS_SERVER, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no']);
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Redis startup timed out')), 10000);
        redisServer!.once('error', reject);
        redisServer!.stdout!.on('data', data => { if (/ready to accept connections/i.test(String(data))) { clearTimeout(deadline); resolve(); } });
      });
      process.env.REDIS_URL = socket;
      redis = new Redis(socket);
      await redis.ping();
    }
  });
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mailhub-accounting-'));
    cwd = jest.spyOn(process, 'cwd').mockReturnValue(directory);
    const org = await prisma.organization.create({ data: { name: 'Synthetic', slug: randomUUID() } });
    const user = await prisma.user.create({ data: { name: 'Synthetic', email: `${randomUUID()}@example.test`, passwordHash: 'fixture' } });
    userId = user.id;
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId } });
    const account = await prisma.emailAccount.create({ data: { organizationId: org.id, ownerUserId: userId, provider: 'imap', emailAddress: 'sender@example.test', label: 'Synthetic' } });
    owner = { organizationId: org.id, accountId: account.id };
    await mkdir(attachmentRoot(), { recursive: true });
  });
  afterEach(async () => {
    delete process.env.WORK_PRINCIPAL_STORAGE_BYTES;
    // This suite is explicitly gated to an otherwise empty disposable *_test DB.
    await prisma.storedAttachmentReference.deleteMany();
    await prisma.attachmentStorageReservation.deleteMany();
    await prisma.storedAttachmentObject.deleteMany();
    await prisma.sendOperation.deleteMany();
    await prisma.emailAccount.deleteMany({ where: { organizationId: owner.organizationId } });
    await prisma.organization.delete({ where: { id: owner.organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    cwd.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await prisma.$disconnect();
    if (redis) { (await admissionRedis()).disconnect(); await redis.quit(); }
    redisServer?.kill();
    if (redisDirectory) await rm(redisDirectory, { recursive: true, force: true });
    if (priorRedisUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = priorRedisUrl;
  });

  const publish = async (staged: Awaited<ReturnType<typeof stageOutgoingFiles>>) => {
    const email = await prisma.$transaction(async tx => {
      const email = await tx.email.create({ data: { accountId: owner.accountId, messageId: randomUUID(), folder: 'SENT' } });
      for (const file of staged.files) await tx.attachment.create({ data: { ...file, emailId: email.id } });
      await staged.commit(tx);
      await staged.commit(tx); // committed retry is idempotent
      return email;
    });
    staged.published();
    return email;
  };
  test('measures committed objects once across shared aliases, survives cleanup and enforces real byte budgets', async () => {
    const staged = await stageOutgoingFiles([attachment], undefined, owner);
    const email = await publish(staged);
    await staged.cleanup();
    expect(await readFile(staged.files[0].storagePath)).toEqual(Buffer.from('abc'));
    await prisma.attachment.create({ data: { emailId: email.id, storagePath: path.relative(process.cwd(), staged.files[0].storagePath), sizeBytes: 999999 } });
    await reconcileAttachmentAccounting();
    expect(await prisma.storedAttachmentObject.count()).toBe(1);
    expect(await prisma.storedAttachmentReference.count()).toBe(2);
    const object = await prisma.storedAttachmentObject.findFirstOrThrow();
    expect(object.measuredBytes).toBe(BigInt(3));
    process.env.WORK_PRINCIPAL_STORAGE_BYTES = '5';
    await expect(stageOutgoingFiles([attachment], undefined, owner)).rejects.toThrow('budget exhausted');
    expect(await prisma.attachmentStorageReservation.count({ where: { state: 'COMMITTED' } })).toBe(1);
  });
  test('release is idempotent, and transaction rollback removes staging without losing accounting evidence', async () => {
    const staged = await stageOutgoingFiles([attachment], undefined, owner);
    await expect(prisma.$transaction(async tx => {
      await tx.email.create({ data: { accountId: owner.accountId, messageId: randomUUID(), folder: 'SENT' } });
      throw new Error('controlled rollback');
    })).rejects.toThrow('controlled rollback');
    await staged.cleanup(); await staged.cleanup();
    expect(await prisma.attachmentStorageReservation.findFirstOrThrow()).toMatchObject({ state: 'RELEASED' });
    expect(await prisma.storedAttachmentObject.findFirstOrThrow()).toMatchObject({ state: 'MISSING', measuredBytes: null });
    expect(await prisma.email.count()).toBe(0);
  });
  test('expired reservation fences a later publish; crash bytes stay ORPHAN and are never deleted by expiry', async () => {
    const reservation = await reserveAttachment(owner, 'crashed', 'synthetic-crash', 3);
    const repeated = await reserveAttachment(owner, 'crashed', 'synthetic-crash', 3);
    expect(repeated.id).toBe(reservation.id);
    await expect(reserveAttachment(owner, 'crashed', 'competing-writer', 3)).rejects.toThrow('already has a writer');
    await expect(publishAttachment(repeated, async () => {})).rejects.toThrow('Replayed');
    await writeFile(path.join(attachmentRoot(), 'crashed'), 'abc');
    await prisma.attachmentStorageReservation.update({ where: { id: reservation.id }, data: { expiresAt: new Date(0) } });
    await reconcileAttachmentAccounting();
    const effect = jest.fn();
    await expect(publishAttachment(reservation, effect)).rejects.toThrow('fenced');
    expect(effect).not.toHaveBeenCalled();
    await releaseAttachment(reservation); await releaseAttachment(reservation);
    expect(await prisma.attachmentStorageReservation.findFirstOrThrow()).toMatchObject({ state: 'EXPIRED' });
    expect(await prisma.storedAttachmentObject.findFirstOrThrow()).toMatchObject({ state: 'ORPHAN', measuredBytes: BigInt(3) });
    expect(await readFile(path.join(attachmentRoot(), 'crashed'), 'utf8')).toBe('abc');
  });
  test('reconciles an expired reservation against real committed legacy rows, ignoring inaccurate sizes and remote-only metadata', async () => {
    const reservation = await reserveAttachment(owner, 'legacy', 'legacy-operation', 100);
    await writeFile(path.join(attachmentRoot(), 'legacy'), 'abc');
    const email = await prisma.email.create({ data: { accountId: owner.accountId, messageId: randomUUID(), folder: 'SENT' } });
    await prisma.attachment.createMany({ data: [
      { emailId: email.id, storagePath: path.join(attachmentRoot(), 'legacy'), sizeBytes: 10000 },
      { emailId: email.id, storagePath: null, sizeBytes: 10000 },
    ] });
    await prisma.attachmentStorageReservation.update({ where: { id: reservation.id }, data: { expiresAt: new Date(0) } });
    await reconcileAttachmentAccounting();
    expect(await prisma.attachmentStorageReservation.findFirstOrThrow()).toMatchObject({ state: 'COMMITTED' });
    expect(await prisma.storedAttachmentObject.findFirstOrThrow()).toMatchObject({ state: 'PRESENT', measuredBytes: BigInt(3) });
    expect(await prisma.storedAttachmentReference.count()).toBe(1);
  });
  test('unowned inventory and symlinks block readiness', async () => {
    await writeFile(path.join(attachmentRoot(), 'unowned'), 'abc');
    await expect(stageOutgoingFiles([attachment], undefined, owner)).rejects.toThrow('Unaccounted');
    await reconcileAttachmentAccounting();
    expect(await prisma.storedAttachmentObject.findFirstOrThrow()).toMatchObject({ state: 'ORPHAN', organizationId: null });
    await symlink(path.join(attachmentRoot(), 'unowned'), path.join(attachmentRoot(), 'alias'));
    await reconcileAttachmentAccounting();
    expect(await prisma.storedAttachmentObject.findUniqueOrThrow({ where: { storageKey: 'alias' } })).toMatchObject({ state: 'ERROR' });
    await expect(stageOutgoingFiles([attachment], undefined, owner)).rejects.toThrow(/not ready|Unaccounted/);
  });
  test('synthetic concurrent reservations serialize capacity decisions', async () => {
    process.env.WORK_PRINCIPAL_STORAGE_BYTES = '6';
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => reserveAttachment(owner, `object-${i}`, `operation-${i}`, 3)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    expect(await prisma.attachmentStorageReservation.count()).toBe(2);
  });

  (process.env.WORKLOAD_TEST_REDIS_SERVER ? test : test.skip)('lost Redis lease prevents actual PostgreSQL writes and SMTP delivery', async () => {
    const principal = { organizationId: owner.organizationId, userId };
    await expect(withWork(principal, async () => {
      await prisma.email.findMany();
      await redis!.del(...budgetKeys(principal, 'active'));
      await expect(prisma.email.create({ data: { accountId: owner.accountId, messageId: randomUUID(), folder: 'SENT' } })).rejects.toBeInstanceOf(AdmissionError);
      // A recovered Redis connection cannot revive the lost invocation.
      await claimSend(principal, owner.accountId, 'fenced-send', { subject: 'synthetic' });
    })).rejects.toBeInstanceOf(AdmissionError);
    expect(await prisma.email.count()).toBe(0);
    expect(await prisma.sendOperation.count()).toBe(0);
    expect(await redis!.zcard(budgetKeys(principal, 'queued')[0])).toBe(0);
  });

  test('preparation recovery fences stale callbacks, races and expired live holders', async () => {
    const principal = { organizationId: owner.organizationId, userId };
    const input = { subject: 'Synthetic recovery' };
    const stale = await claimSend(principal, owner.accountId, 'abandoned', input);
    await expect(claimSend(principal, owner.accountId, 'abandoned', input)).rejects.toThrow('already attempted');
    await prisma.sendOperation.updateMany({ data: { preparationExpiresAt: new Date(0) } });
    await expect(stale.beforeDelivery()).rejects.toThrow('fenced');
    await expect(claimSend(principal, owner.accountId, 'abandoned', { subject: 'different' })).rejects.toThrow('different content');
    const raced = await Promise.allSettled(Array.from({ length: 20 }, () => claimSend(principal, owner.accountId, 'abandoned', input)));
    const winners = raced.filter(result => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const current = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimSend>>>).value;
    await stale.failedBeforeDelivery();
    await stale.delivered('stale-message');
    await expect(stale.beforeDelivery()).rejects.toThrow('fenced');
    await current.beforeDelivery();
    await current.failedBeforeDelivery(new Error('uncertain'));
    await reconcileSendOperations();
    expect(await prisma.sendOperation.findFirstOrThrow()).toMatchObject({ state: 'DELIVERING', messageId: null });
    await expect(claimSend(principal, owner.accountId, 'abandoned', input)).rejects.toThrow('already attempted');
  });

  test('retention caps all states and never evicts uncertainty within its replay window', async () => {
    const principal = { organizationId: owner.organizationId, userId };
    const input = { subject: 'Synthetic retention' };
    const oldCap = sendOperationLimits.retainedPerOrganization;
    sendOperationLimits.retainedPerOrganization = 4;
    try {
      for (const state of ['PREPARING', 'RETRYABLE', 'DELIVERING', 'DELIVERED']) {
        await claimSend(principal, owner.accountId, state, input);
        await prisma.sendOperation.updateMany({ where: { operationKey: state }, data: { state } });
      }
      await expect(claimSend(principal, owner.accountId, 'over-cap', input)).rejects.toThrow('Too many retained');
      await prisma.sendOperation.updateMany({ data: { preparationExpiresAt: new Date(0) } });
      await reconcileSendOperations();
      expect(await prisma.sendOperation.count()).toBe(4);
      await expect(claimSend(principal, owner.accountId, 'DELIVERING', input)).rejects.toThrow('already attempted');
      await prisma.sendOperation.updateMany({ data: { expiresAt: new Date(0) } });
      expect(await reconcileSendOperations()).toMatchObject({ removed: 4 });
      expect(await reconcileSendOperations()).toEqual({ removed: 0, recovered: 0 });
      await claimSend(principal, owner.accountId, 'over-cap', input);
    } finally { sendOperationLimits.retainedPerOrganization = oldCap; }
  });

  test('maintenance processes finite batches and preserves a live preparation even with old retention', async () => {
    await prisma.sendOperation.createMany({ data: Array.from({ length: 501 }, (_, i) => ({
      ...owner, userId, id: randomUUID(), operationKey: `expired-${i}`, payloadHash: 'fixture', generation: randomUUID(),
      state: 'DELIVERED', expiresAt: new Date(0), preparationExpiresAt: new Date(0),
    })) });
    expect(await reconcileSendOperations()).toEqual({ removed: 500, recovered: 0 });
    expect(await prisma.sendOperation.count()).toBe(1);
    const principal = { organizationId: owner.organizationId, userId };
    await claimSend(principal, owner.accountId, 'live-preparation', {});
    await prisma.sendOperation.updateMany({ where: { operationKey: 'live-preparation' }, data: { expiresAt: new Date(0) } });
    // claimSend removes the remaining expired row, preserving the live holder.
    expect(await prisma.sendOperation.count()).toBe(1);
    expect(await reconcileSendOperations()).toEqual({ removed: 0, recovered: 0 });
    expect(await prisma.sendOperation.findFirstOrThrow()).toMatchObject({ state: 'PREPARING', operationKey: 'live-preparation' });
    await prisma.sendOperation.updateMany({ data: { preparationExpiresAt: new Date(0) } });
    expect(await reconcileSendOperations()).toEqual({ removed: 1, recovered: 0 });
  });

  test('explicit operation replay permits independent identical sends and definite pre-delivery retries, blocks ambiguous SMTP outcomes', async () => {
    const sockets = new Set<Socket>();
    let deliveries = 0;
    let ambiguous = false;
    let rejectAuth = false;
    let holdEhlo: (() => void) | undefined;
    const sink = createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      socket.write('220 synthetic SMTP\r\n');
      let pending = '', data = false;
      socket.on('data', chunk => {
        pending += chunk.toString();
        if (pending.length > 65536) return socket.destroy();
        let end;
        while ((end = pending.indexOf('\r\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 2);
          if (data) {
            if (line === '.') { data = false; deliveries++; if (ambiguous) socket.destroy(); else socket.write('250 queued\r\n'); }
          } else if (line.startsWith('EHLO')) { if (holdEhlo) holdEhlo(); else socket.write('250-localhost\r\n250 AUTH PLAIN\r\n'); }
          else if (line.startsWith('AUTH')) socket.write(rejectAuth ? '535 authentication rejected\r\n' : '235 ok\r\n');
          else if (line.startsWith('RCPT TO:') && line.includes('rejected@example.test')) socket.write('550 rejected recipient\r\n');
          else if (line === 'DATA') { data = true; socket.write('354 continue\r\n'); }
          else if (line === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
    const address = sink.address();
    if (!address || typeof address === 'string') throw new Error('Missing sink port');
    const account = { id: owner.accountId, provider: 'imap', label: 'Synthetic', emailAddress: 'sender@example.test', smtpHost: 'synthetic.invalid', smtpPort: address.port, smtpSecure: false, decryptedPassword: 'fixture' };
    const principal = { organizationId: owner.organizationId, userId };
    const input = { to: ['recipient@example.test'], subject: 'Identical synthetic content', bodyText: 'Hello' };
    try {
      (getDecryptedAccount as jest.Mock).mockRejectedValueOnce(new Error('definite credential failure'));
      const failed = await claimSend(principal, owner.accountId, 'retryable', input);
      await expect(sendEmail(owner.accountId, input, failed.beforeDelivery)).rejects.toThrow('credential');
      await failed.failedBeforeDelivery();
      (getDecryptedAccount as jest.Mock).mockResolvedValue(account);
      const correctedInput = { ...input, subject: 'Corrected after failure' };
      for (const key of ['retryable', 'independent']) {
        const operation = await claimSend(principal, owner.accountId, key, correctedInput);
        const result = await sendEmail(owner.accountId, correctedInput, operation.beforeDelivery);
        await operation.delivered(result.messageId);
      }
      rejectAuth = true;
      const authFailure = await claimSend(principal, owner.accountId, 'smtp-auth-retry', input);
      try { await sendEmail(owner.accountId, input, authFailure.beforeDelivery); throw new Error('Expected auth failure'); }
      catch (error) { expect(error).toMatchObject({ code: 'EAUTH' }); await authFailure.failedBeforeDelivery(error); }
      rejectAuth = false;
      const authRetry = await claimSend(principal, owner.accountId, 'smtp-auth-retry', input);
      const authResult = await sendEmail(owner.accountId, input, authRetry.beforeDelivery);
      await authRetry.delivered(authResult.messageId);
      const partialInput = { ...input, to: ['recipient@example.test', 'rejected@example.test'] };
      const partial = await claimSend(principal, owner.accountId, 'partial', partialInput);
      const partialResult = await sendEmail(owner.accountId, partialInput, partial.beforeDelivery);
      await partial.delivered(partialResult.messageId);
      await expect(claimSend(principal, owner.accountId, 'partial', partialInput)).rejects.toThrow('already attempted');
      expect(deliveries).toBe(4);
      await expect(claimSend(principal, owner.accountId, 'retryable', correctedInput)).rejects.toThrow('already attempted');
      await expect(claimSend(principal, owner.accountId, 'retryable', { ...input, subject: 'changed' })).rejects.toThrow('different content');
      if (redis) {
        let reachedEhlo!: () => void;
        const waiting = new Promise<void>(resolve => { reachedEhlo = resolve; });
        holdEhlo = reachedEhlo;
        await expect(withWork(principal, async () => {
          const fenced = await claimSend(principal, owner.accountId, 'lost-smtp-lease', input);
          const delivery = sendEmail(owner.accountId, input, fenced.beforeDelivery);
          void delivery.catch(() => {});
          await waiting;
          await redis!.del(...budgetKeys(principal, 'active'));
          await expect(assertWorkLease()).rejects.toBeInstanceOf(AdmissionError);
          await expect(delivery).rejects.toThrow();
        })).rejects.toBeInstanceOf(AdmissionError);
        holdEhlo = undefined;
        expect(deliveries).toBe(4);
        await expect(claimSend(principal, owner.accountId, 'lost-smtp-lease', input)).rejects.toThrow('already attempted');
      }
      ambiguous = true;
      const operation = await claimSend(principal, owner.accountId, 'uncertain', input);
      await expect(sendEmail(owner.accountId, input, operation.beforeDelivery)).rejects.toThrow();
      await operation.failedBeforeDelivery();
      expect(deliveries).toBe(5);
      await expect(claimSend(principal, owner.accountId, 'uncertain', input)).rejects.toThrow('already attempted');
      const raced = await Promise.allSettled(Array.from({ length: 20 }, () => claimSend(principal, owner.accountId, 'same-operation', input)));
      expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => sink.close(() => resolve()));
    }
  }, 15000);
});
