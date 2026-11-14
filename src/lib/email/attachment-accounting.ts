import { randomUUID } from 'node:crypto';
import { lstat, realpath, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { assertWorkLease, withoutWorkLease } from '@/lib/workload/admission';

type Tx = Prisma.TransactionClient;
export interface StorageOwner { organizationId: string; accountId: string }
export const attachmentRoot = () => path.join(process.cwd(), '.storage', 'attachments');
export function storageKey(storagePath: string): string {
  const key = path.relative(attachmentRoot(), path.resolve(process.cwd(), storagePath));
  if (!key || key.startsWith('..') || path.isAbsolute(key)) throw new Error('Unsafe attachment path');
  return key.split(path.sep).join('/');
}
async function observe(key: string) {
  const root = attachmentRoot();
  try {
    if (await realpath(root) !== root) throw new Error('Symlinked storage root');
    let current = root;
    for (const segment of key.split('/')) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinked attachment');
    }
    const stat = await lstat(current);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsupported attachment or hard-link alias');
    return { state: 'PRESENT', measuredBytes: BigInt(stat.size), observedAt: new Date() };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'ERROR', measuredBytes: null, observedAt: new Date() };
  }
}
async function lock(tx: Tx, owner: StorageOwner, key: string) {
  // Every writer/reconciler uses the same organization -> object lock order.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${owner.organizationId}, 0))::text`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 1))::text`;
}
export async function reserveAttachment(owner: StorageOwner, key: string, operationKey: string, bytes: number) {
  if (storageKey(path.join(attachmentRoot(), key)) !== key || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid attachment reservation');
  await assertWorkLease();
  return prisma.$transaction(async tx => {
    await lock(tx, owner, key);
    let object = await tx.storedAttachmentObject.findUnique({ where: { storageKey: key } });
    if (!object) object = await tx.storedAttachmentObject.create({ data: { id: randomUUID(), storageKey: key, ...owner } });
    if (object.organizationId !== owner.organizationId || object.accountId !== owner.accountId) throw new Error('Attachment ownership conflict');
    const prior = await tx.attachmentStorageReservation.findUnique({ where: { operationKey } });
    if (prior) {
      if (prior.objectId !== object.id || prior.organizationId !== owner.organizationId || prior.accountId !== owner.accountId || prior.reservedBytes !== BigInt(bytes)) throw new Error('Reservation operation conflict');
      return { ...prior, key, revision: object.revision, existing: true };
    }
    if (object.state === 'PRESENT') throw new Error('Existing objects must be reused by reference');
    if (['ERROR', 'ORPHAN'].includes(object.state)) throw new Error('Storage inventory not ready');
    if (await tx.attachmentStorageReservation.count({ where: { objectId: object.id, state: 'RESERVED' } })) throw new Error('Attachment already has a writer');
    // Exclude the identity just inserted from completeness checks.
    await checkCapacity(tx, owner, bytes, object.id);
    const reservation = await tx.attachmentStorageReservation.create({ data: {
      ...owner, operationKey, objectId: object.id, reservedBytes: BigInt(bytes), expiresAt: new Date(Date.now() + 300000),
    } });
    await assertWorkLease();
    return { ...reservation, key, revision: object.revision, existing: false };
  });
}
export type AttachmentReservation = Awaited<ReturnType<typeof reserveAttachment>>;
/** Publish only while the durable writer generation is locked and current. */
export async function publishAttachment(reservation: AttachmentReservation, publish: () => Promise<void>) {
  if (reservation.existing) throw new Error('Replayed reservation cannot start another writer');
  const revision = await prisma.$transaction(async tx => {
    await lock(tx, reservation, reservation.key);
    const live = await tx.attachmentStorageReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    const object = await tx.storedAttachmentObject.findUniqueOrThrow({ where: { id: live.objectId } });
    if (live.state !== 'RESERVED' || live.expiresAt <= new Date() || object.revision !== reservation.revision) throw new Error('Attachment writer fenced');
    await assertWorkLease();
    await publish();
    const observation = await observe(reservation.key);
    if (observation.state !== 'PRESENT') throw new Error('Published object cannot be measured');
    await tx.storedAttachmentObject.update({ where: { id: object.id }, data: { ...observation, revision: { increment: 1 } } });
    await assertWorkLease();
    return object.revision + BigInt(1);
  });
  reservation.revision = revision;
}
export async function commitAttachment(tx: Tx, reservation: AttachmentReservation, attachmentId: string) {
  await lock(tx, reservation, reservation.key);
  await assertWorkLease();
  const live = await tx.attachmentStorageReservation.findUniqueOrThrow({ where: { id: reservation.id } });
  if (live.state === 'COMMITTED') {
    const ref = await tx.storedAttachmentReference.findUnique({ where: { attachmentId } });
    if (ref?.objectId === live.objectId) return;
    throw new Error('Committed reservation reference mismatch');
  }
  if (live.state !== 'RESERVED' || live.expiresAt <= new Date()) throw new Error('Attachment writer fenced');
  const attachment = await tx.attachment.findUniqueOrThrow({ where: { id: attachmentId }, include: { email: { select: { accountId: true } } } });
  if (!attachment.storagePath || storageKey(attachment.storagePath) !== reservation.key || attachment.email.accountId !== reservation.accountId) throw new Error('Attachment reference ownership mismatch');
  const observation = await observe(reservation.key);
  if (observation.state !== 'PRESENT') throw new Error('Attachment cannot be measured');
  const updated = await tx.storedAttachmentObject.updateMany({ where: { id: live.objectId, revision: reservation.revision }, data: { ...observation, revision: { increment: 1 } } });
  if (updated.count !== 1) throw new Error('Attachment observation fenced');
  await tx.storedAttachmentReference.create({ data: { attachmentId, objectId: live.objectId } });
  await tx.attachmentStorageReservation.update({ where: { id: live.id }, data: { state: 'COMMITTED' } });
  await assertWorkLease();
}
/** Cleanup only files still owned exclusively by this stopped staging writer. */
export async function cleanupAttachment(reservation: AttachmentReservation, filename: string) {
  await withoutWorkLease(() => prisma.$transaction(async tx => {
    await lock(tx, reservation, reservation.key);
    const live = await tx.attachmentStorageReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    const object = await tx.storedAttachmentObject.findUniqueOrThrow({ where: { id: reservation.objectId } });
    if (live.state !== 'RESERVED' || object.revision !== reservation.revision) return;
    if (await tx.storedAttachmentReference.count({ where: { objectId: object.id } })) return;
    if (await tx.attachment.count({ where: { storagePath: filename } })) return;
    await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }));
  await releaseAttachment(reservation);
}
/** Only the stopped writer may release. Expiry never implies deletion. */
export async function releaseAttachment(reservation: AttachmentReservation) {
  await withoutWorkLease(() => prisma.$transaction(async tx => {
    await lock(tx, reservation, reservation.key);
    const updated = await tx.attachmentStorageReservation.updateMany({ where: { id: reservation.id, state: 'RESERVED' }, data: { state: 'RELEASED' } });
    if (!updated.count) return;
    const observation = await observe(reservation.key);
    await tx.storedAttachmentObject.updateMany({ where: { id: reservation.objectId, revision: reservation.revision }, data: { ...observation, state: observation.state === 'PRESENT' ? 'ORPHAN' : observation.state, revision: { increment: 1 } } });
  }));
}

/** Inventory disk and legacy rows independently. No deletion or automatic expiry. */
export async function reconcileAttachmentAccounting() {
  const rows = await prisma.attachment.findMany({ where: { storagePath: { not: null } }, include: { email: { include: { account: { select: { id: true, organizationId: true } } } } } });
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = storageKey(row.storagePath!); // Reject unsafe paths for manual review.
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  for (const object of await prisma.storedAttachmentObject.findMany()) if (!groups.has(object.storageKey)) groups.set(object.storageKey, []);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(name);
      else { const key = storageKey(name); if (!groups.has(key)) groups.set(key, []); }
    }
  };
  await walk(attachmentRoot()).catch(error => { if (error.code !== 'ENOENT') throw error; });
  for (const [key, references] of groups) {
    const owners = new Set(references.map(row => `${row.email.account.organizationId}:${row.email.accountId}`));
    if (owners.size > 1) throw new Error(`Cross-owner attachment conflict: ${key}`);
    const account = references[0]?.email.account;
    const known = await prisma.storedAttachmentObject.findUnique({ where: { storageKey: key } });
    const owner = { organizationId: account?.organizationId || known?.organizationId || 'unowned', accountId: account?.id || known?.accountId || 'unowned' };
    await prisma.$transaction(async tx => {
      await lock(tx, owner, key);
      const object = await tx.storedAttachmentObject.upsert({ where: { storageKey: key }, create: { storageKey: key, ...(account ? { organizationId: account.organizationId, accountId: account.id } : {}) }, update: {} });
      if (account && (object.organizationId !== account.organizationId || object.accountId !== account.id)) throw new Error('Stored owner conflict');
      const reservations = await tx.attachmentStorageReservation.findMany({ where: { objectId: object.id, state: 'RESERVED' } });
      if (reservations.some(row => row.expiresAt > new Date())) return;
      // Expired writers are fenced by the revision change below while holding
      // their publication lock. Physical bytes remain until explicitly cleaned.

      const observation = await observe(key);
      const live = await tx.attachment.findMany({ where: { id: { in: references.map(row => row.id) } }, select: { id: true, storagePath: true, email: { select: { accountId: true } } } });
      if (live.length !== references.length || live.some(row => !row.storagePath || storageKey(row.storagePath) !== key || row.email.accountId !== owner.accountId)) throw new Error('Attachment inventory drift; rescan');
      await tx.storedAttachmentReference.deleteMany({ where: { objectId: object.id, attachmentId: { notIn: live.map(row => row.id) } } });
      for (const row of live) await tx.storedAttachmentReference.upsert({ where: { attachmentId: row.id }, create: { attachmentId: row.id, objectId: object.id }, update: { objectId: object.id } });
      for (const reservation of reservations) await tx.attachmentStorageReservation.update({ where: { id: reservation.id }, data: { state: live.length && observation.state === 'PRESENT' ? 'COMMITTED' : 'EXPIRED' } });
      await tx.storedAttachmentObject.updateMany({ where: { id: object.id, revision: object.revision }, data: { ...observation, state: observation.state === 'PRESENT' && !live.length ? 'ORPHAN' : observation.state, revision: { increment: 1 } } });
    });
  }
}

/** Fail closed until a complete inventory exists; sizeBytes is never usage. */
async function checkCapacity(tx: Tx, owner: StorageOwner, additionalBytes: number, newObjectId: string) {
  const account = await tx.emailAccount.findUniqueOrThrow({ where: { id: owner.accountId }, select: { organizationId: true, ownerUserId: true } });
  if (account.organizationId !== owner.organizationId || !account.ownerUserId) throw new Error('Storage ownership unavailable');
  const objects = await tx.storedAttachmentObject.findMany({ include: { reservations: { where: { state: 'RESERVED' } } }, take: 10001 });
  const rows = await tx.attachment.findMany({ where: { storagePath: { not: null } }, select: { id: true, storagePath: true, email: { select: { accountId: true } } }, take: 10001 });
  if (objects.length > 10000 || rows.length > 10000) throw new Error('Storage inventory requires offline review');
  const references = new Set((await tx.storedAttachmentReference.findMany({ select: { attachmentId: true }, take: 10001 })).map(row => row.attachmentId));
  if (rows.some(row => !references.has(row.id))) throw new Error('Storage inventory incomplete');
  const byKey = new Map(objects.map(object => [object.storageKey, object]));
  for (const row of rows) {
    const object = byKey.get(storageKey(row.storagePath!));
    if (!object || object.accountId !== row.email.accountId) throw new Error('Storage reference ownership conflict');
  }
  let entries = 0;
  const inspect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 10000) throw new Error('Storage inventory requires offline review');
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(filename);
      else if (entry.isSymbolicLink() || !byKey.has(storageKey(filename))) throw new Error('Unaccounted attachment file');
    }
  };
  await inspect(attachmentRoot()).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const accounts = await tx.emailAccount.findMany({ where: { organizationId: owner.organizationId }, select: { id: true, ownerUserId: true } });
  const principalAccounts = new Set(accounts.filter(row => row.ownerUserId === account.ownerUserId).map(row => row.id));
  let orgBytes = BigInt(additionalBytes), principalBytes = BigInt(additionalBytes);
  for (const object of objects) {
    if (object.id === newObjectId) continue;
    if (object.organizationId === owner.organizationId && object.state === 'PRESENT') {
      const observation = await observe(object.storageKey);
      if (observation.state !== object.state || observation.measuredBytes !== object.measuredBytes) throw new Error('Storage observation drift; reconcile first');
    }
    if (!object.organizationId || ['ERROR', 'ORPHAN'].includes(object.state) || (object.state === 'UNMEASURED' && !object.reservations.length)) throw new Error('Storage inventory not ready');
    // Measured objects are charged once, excluding their outstanding estimate.
    const bytes = object.state === 'PRESENT' ? object.measuredBytes! : object.reservations.reduce((sum, row) => sum + row.reservedBytes, BigInt(0));
    if (object.organizationId === owner.organizationId) {
      if (!accounts.some(row => row.id === object.accountId && row.ownerUserId)) throw new Error('Storage owner tombstone requires review');
      orgBytes += bytes;
      if (principalAccounts.has(object.accountId!)) principalBytes += bytes;
    }
  }
  const limit = (name: string, fallback: number) => {
    const value = process.env[name];
    if (value === undefined) return BigInt(fallback);
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid ${name}`);
    return BigInt(value);
  };
  if (orgBytes > limit('WORK_ORG_STORAGE_BYTES', 1024 ** 3) || principalBytes > limit('WORK_PRINCIPAL_STORAGE_BYTES', 256 * 1024 ** 2)) throw new Error('Attachment storage budget exhausted');
}

/** Preserve #48's post-commit cleanup, including canonical path aliases. */
export async function cleanupReplacedAttachment(filename: string) {
  const key = storageKey(filename);
  const known = await prisma.storedAttachmentObject.findUnique({ where: { storageKey: key } });
  if (!known?.organizationId || !known.accountId) return; // Inventory legacy files before deleting.
  await prisma.$transaction(async tx => {
    await lock(tx, { organizationId: known.organizationId!, accountId: known.accountId! }, key);
    const rows = await tx.attachment.findMany({ where: { storagePath: { not: null } }, select: { storagePath: true }, take: 10001 });
    if (rows.length > 10000 || rows.some(row => storageKey(row.storagePath!) === key)) return;
    if (await tx.attachmentStorageReservation.count({ where: { objectId: known.id, state: 'RESERVED' } })) return;
    const before = await observe(key);
    if (!['PRESENT', 'MISSING'].includes(before.state)) return;
    await assertWorkLease();
    await unlink(path.join(attachmentRoot(), key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const observation = await observe(key);
    await tx.storedAttachmentReference.deleteMany({ where: { objectId: known.id } });
    await tx.storedAttachmentObject.update({ where: { id: known.id }, data: { ...observation, revision: { increment: 1 } } });
    await assertWorkLease();
  });
}
