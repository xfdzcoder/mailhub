import { mkdir, writeFile, unlink, open } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import { outgoingLimits, OutgoingInputError, validateOutgoingMail } from './outgoing-budget';

/** Stage new, server-named files; callers publish metadata transactionally. */
export async function stageOutgoingFiles(attachments: { filename: string; contentType: string; content: string }[]) {
  validateOutgoingMail({ attachments });
  const files: { id: string; filename: string; contentType: string; sizeBytes: number; storagePath: string }[] = [];
  const cleanup = async () => {
    await Promise.all(files.map(file => unlink(file.storagePath).catch(() => undefined)));
  };
  try {
    if (attachments.length) await mkdir(path.join(process.cwd(), '.storage', 'attachments'), { recursive: true });
    for (const att of attachments) {
      const id = randomUUID();
      const storagePath = path.join(process.cwd(), '.storage', 'attachments', id);
      const buffer = Buffer.from(att.content, 'base64');
      files.push({ id, storagePath, filename: att.filename, contentType: att.contentType, sizeBytes: buffer.length });
      try {
        await writeFile(storagePath, buffer, { flag: 'wx' });
      } catch (error) {
        // A colliding pre-existing path belongs to somebody else.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') files.pop();
        throw error;
      }
    }
    return { files, cleanup };
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
