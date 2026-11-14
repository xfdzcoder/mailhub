import { assertWorkLease } from '@/lib/workload/admission';
import { reserveAttachment, releaseAttachment, cleanupAttachment, publishAttachment, commitAttachment, storageKey, type StorageOwner, type AttachmentReservation } from './attachment-accounting';
import type { Prisma } from '@prisma/client';
import { mkdir, writeFile, unlink, open, link, lstat, realpath } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import { outgoingLimits, OutgoingInputError, validateOutgoingMail } from './outgoing-budget';

/** Stage new, server-named files; callers publish metadata transactionally. */
export async function stageOutgoingFiles(
  attachments: { filename: string; contentType: string; content: string }[],
  signal: AbortSignal | undefined,
  owner: StorageOwner,
) {
  const checkAborted = () => {
    if (signal?.aborted) throw new OutgoingInputError('Request aborted', 400);
  };
  checkAborted();
  validateOutgoingMail({ attachments });
  const reservations = new Map<string, AttachmentReservation>();
  let committed = false;
  const files: { id: string; filename: string; contentType: string; sizeBytes: number; storagePath: string }[] = [];
  const cleanup = async () => {
    if (committed) return;
    for (const file of files) {
      const reservation = reservations.get(file.id);
      if (reservation) await cleanupAttachment(reservation, file.storagePath);
      else await unlink(file.storagePath).catch(() => undefined);
    }
    for (const reservation of reservations.values()) await releaseAttachment(reservation);
  };
  try {
    if (attachments.length) {
      const storage = path.join(process.cwd(), '.storage');
      const parent = await lstat(storage).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (parent?.isSymbolicLink()) throw new Error('Symlinked attachment storage');
      const root = path.join(storage, 'attachments');
      await mkdir(root, { recursive: true });
      if (await realpath(root) !== root) throw new Error('Symlinked attachment storage');
    }
    for (const att of attachments) {
      checkAborted();
      await assertWorkLease();
      const id = randomUUID();
      const storagePath = path.join(process.cwd(), '.storage', 'attachments', id);
      const buffer = Buffer.from(att.content, 'base64');
      reservations.set(id, await reserveAttachment(owner, storageKey(storagePath), `outgoing:${id}`, buffer.length));
      files.push({ id, storagePath, filename: att.filename, contentType: att.contentType, sizeBytes: buffer.length });
      try {
        const temporary = `${storagePath}.tmp-${randomUUID()}`;
        try {
          await writeFile(temporary, buffer, { flag: 'wx' });
          await assertWorkLease();
          // link publishes exclusively without overwriting another object.
          const publish = async () => { await link(temporary, storagePath); await unlink(temporary); };
          const reservation = reservations.get(id);
          if (!reservation) throw new Error('Missing attachment reservation');
          await publishAttachment(reservation, publish);
        } finally { await unlink(temporary).catch(() => undefined); }
      } catch (error) {
        // A colliding pre-existing path belongs to somebody else.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') files.pop();
        throw error;
      }
    }
    checkAborted();
    return { files, cleanup,
      async commit(tx: Prisma.TransactionClient) {
        for (const file of files) {
          const reservation = reservations.get(file.id);
          if (reservation) await commitAttachment(tx, reservation, file.id);
        }
        await assertWorkLease();
      },
      published() { committed = true; },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Read at most cap+1 bytes, including files that grow after stat. */
export async function readOutgoingFile(storagePath: string, remaining: number): Promise<Buffer> {
  const cap = Math.min(outgoingLimits().attachmentBytes, remaining);
  const file = await open(storagePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > cap) throw new OutgoingInputError('Stored attachment exceeds outgoing limit');
    const buffer = Buffer.alloc(Math.min(stat.size, cap) + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) return buffer.subarray(0, used);
      used += bytesRead;
    }
    throw new OutgoingInputError('Stored attachment changed or exceeds outgoing limit');
  } finally { await file.close(); }
}
