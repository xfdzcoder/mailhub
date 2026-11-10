import { readOutgoingJson, validateOutgoingMail, OutgoingInputError } from '@/lib/email/outgoing-budget';
import { NextRequest } from 'next/server';
import { authenticate, apiResponse, apiError } from '@/lib/auth/middleware';
import { prisma } from '@/lib/db/prisma';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { parseAddresses } from '@/lib/email/addresses';
import { accountAccessWhere } from '@/lib/accounts/access';

import { stageOutgoingFiles } from '@/lib/email/outgoing-files';
import { unlink } from 'fs/promises';
import path from 'path';

const saveDraftSchema = z.object({
  draftId: z.string().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
  attachments: z
    .array(
      z.object({
        id: z.string().optional(),
        filename: z.string(),
        contentType: z.string(),
        content: z.string(),
        sizeBytes: z.number().optional(),
      })
    )
    .optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PUT(req: NextRequest, { params }: RouteParams) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { id: accountId } = await params;

  // Verify account access
  const account = await prisma.emailAccount.findFirst({
    where: accountAccessWhere(auth, accountId),
    select: { id: true, emailAddress: true },
  });

  if (!account) return apiError('Account not found', 404);

  let body: unknown;
  try { body = await readOutgoingJson(req); }
  catch (error) {
    if (error instanceof OutgoingInputError) return apiError(error.message, error.status);
    throw error;
  }
  const parsed = saveDraftSchema.safeParse(body);
  if (!parsed.success) return apiError(parsed.error.issues[0].message, 422);
  try { validateOutgoingMail(parsed.data); }
  catch (error) {
    if (error instanceof OutgoingInputError) return apiError(error.message, error.status);
    throw error;
  }

  const data = parsed.data;

  let staged: Awaited<ReturnType<typeof stageOutgoingFiles>> | undefined;
  try {
    staged = await stageOutgoingFiles(data.attachments || []);
    const replacedPaths: string[] = [];
    const draftId = await prisma.$transaction(async (tx) => {
      let emailId = data.draftId;
      const toAddresses = parseAddresses(data.to || '').map((address) => ({ address, name: '' }));
      const ccAddresses = parseAddresses(data.cc || '').map((address) => ({ address, name: '' }));
      const bccAddresses = parseAddresses(data.bcc || '').map((address) => ({ address, name: '' }));
      const hasAttachments = !!(data.attachments && data.attachments.length > 0);

      if (emailId) {
        const existingDraft = await tx.email.findFirst({
          where: {
            id: emailId,
            isDraft: true,
            account: accountAccessWhere(auth),
          },
          select: { id: true },
        });

        if (!existingDraft) throw new OutgoingInputError('Draft not found', 404);

        // Updating accountId moves the local draft when the user changes From.
        await tx.email.update({
          where: { id: emailId },
          data: {
            accountId,
            fromAddress: account.emailAddress,
            subject: data.subject || '',
            toAddresses,
            ccAddresses,
            bccAddresses,
            ...(data.attachments !== undefined ? { hasAttachments } : {}),
            body: {
              upsert: {
                create: {
                  bodyHtml: data.bodyHtml || '',
                  bodyText: data.bodyText || '',
                },
                update: {
                  bodyHtml: data.bodyHtml || '',
                  bodyText: data.bodyText || '',
                },
              },
            },
          },
        });
      } else {
        // Create new draft
        const newDraft = await tx.email.create({
          data: {
            accountId,
            messageId: `<${uuidv4()}@draft.local>`,
            // Folder values are normalized across IMAP, Gmail, and list queries.
            folder: 'DRAFTS',
            subject: data.subject || '',
            fromAddress: account.emailAddress,
            toAddresses,
            ccAddresses,
            bccAddresses,
            isRead: true,
            isDraft: true,
            hasAttachments,
            body: {
              create: {
                bodyHtml: data.bodyHtml || '',
                bodyText: data.bodyText || '',
              },
            },
          },
        });
        emailId = newDraft.id;
      }

      // Omitted attachments preserve existing files; an explicit empty array removes them.
      if (data.attachments !== undefined) {
        const previous = await tx.attachment.findMany({ where: { emailId }, select: { storagePath: true } });
        for (const att of previous) if (att.storagePath) replacedPaths.push(att.storagePath);
        await tx.attachment.deleteMany({ where: { emailId } });
        for (const file of staged!.files) {
          await tx.attachment.create({ data: { ...file, emailId: emailId! } });
        }
      }
      return emailId;
    });

    // Only remove superseded local files after commit, and never remove shared files.
    for (const storagePath of new Set(replacedPaths)) {
      try {
        const storageDir = path.join(process.cwd(), '.storage', 'attachments');
        if (path.dirname(path.resolve(storagePath)) !== storageDir) continue;
        if (await prisma.attachment.count({ where: { storagePath } }) === 0) await unlink(storagePath);
      } catch (error) { console.error('Failed to clean replaced draft attachment:', error); }
    }
    return apiResponse({ success: true, draftId, accountId });
  } catch (error) {
    await staged?.cleanup();
    if (error instanceof OutgoingInputError) return apiError(error.message, error.status);
    console.error('Save draft error:', error);
    return apiError('Failed to save draft', 500);
  }
}
