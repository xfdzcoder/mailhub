import { readOutgoingJson, validateOutgoingMail, OutgoingInputError } from '@/lib/email/outgoing-budget';
import { NextRequest } from 'next/server';
import { authenticate, apiResponse, apiError } from '@/lib/auth/middleware';
import { sendEmailSchema } from '@/lib/validation';
import { sendEmail } from '@/lib/smtp/sender';
import { logActivity } from '@/lib/activity/log';
import { prisma } from '@/lib/db/prisma';
import { createEmailSnippet } from '@/lib/email/snippet';
import { accountAccessWhere } from '@/lib/accounts/access';

import { stageOutgoingFiles } from '@/lib/email/outgoing-files';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
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
  const parsed = sendEmailSchema.safeParse(body);
  if (!parsed.success) return apiError(parsed.error.issues[0].message, 422);
  try { validateOutgoingMail(parsed.data); }
  catch (error) {
    if (error instanceof OutgoingInputError) return apiError(error.message, error.status);
    throw error;
  }

  let staged: Awaited<ReturnType<typeof stageOutgoingFiles>> | undefined;
  let deliveredMessageId: string | undefined;
  let published = false;
  try {
    staged = await stageOutgoingFiles(parsed.data.attachments || []);
    const { messageId } = await sendEmail(accountId, parsed.data);
    deliveredMessageId = messageId;
    const sentAt = new Date();
    const snippet = createEmailSnippet({
      bodyText: parsed.data.bodyText,
      bodyHtml: parsed.data.bodyHtml,
    });

    const hasAttachments = !!(parsed.data.attachments && parsed.data.attachments.length > 0);

    // Save sent email record
    const email = await prisma.$transaction(async (tx) => {
      const email = await tx.email.create({
        data: {
          accountId,
          messageId,
          threadId: parsed.data.inReplyTo || messageId, // Basic fallback
          folder: 'SENT',
          subject: parsed.data.subject,
          snippet,
          fromAddress: account.emailAddress,
          toAddresses: parsed.data.to.map((address) => ({ address, name: '' })),
          ccAddresses: parsed.data.cc?.map((address) => ({ address, name: '' })) || [],
          bccAddresses: parsed.data.bcc?.map((address) => ({ address, name: '' })) || [],
          inReplyTo: parsed.data.inReplyTo,
          referencesHeader: parsed.data.references,
          isRead: true, // Sent emails are read
          hasAttachments,
          sentAt,
          receivedAt: sentAt,
          body: {
            create: {
              bodyHtml: parsed.data.bodyHtml,
              bodyText: parsed.data.bodyText,
            },
          },
        },
      });

      for (const file of staged!.files) {
        await tx.attachment.create({ data: { ...file, emailId: email.id } });
      }
      return email;
    });
    published = true;

    await logActivity({
      organizationId: auth.organizationId,
      userId: auth.userId,
      accountId,
      emailId: email.id,
      action: 'EMAIL_SENT',
      metadata: { to: parsed.data.to, subject: parsed.data.subject },
    });

    if (parsed.data.draftId) {
      await prisma.email.deleteMany({
        where: { id: parsed.data.draftId, accountId },
      });
      // (Optional: Also delete from IMAP Drafts if possible, but local is the main priority)
    }

    return apiResponse({ success: true, messageId, sentAt });
  } catch (error) {
    if (!published) await staged?.cleanup();
    if (error instanceof OutgoingInputError) return apiError(error.message, error.status);
    if (deliveredMessageId) return apiResponse({ success: true, messageId: deliveredMessageId, warning: 'Message delivered; local persistence failed. Do not resend.' });
    console.error('Send email error:', error);
    return apiError('Failed to send email', 500);
  }
}
