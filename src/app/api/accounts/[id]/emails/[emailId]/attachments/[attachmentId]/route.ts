import { attachmentResponse } from '@/lib/workload/attachment-response';
import { AdmissionError } from '@/lib/workload/admission';
import { IncomingBudgetError } from '@/lib/email/incoming-budget';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { authenticate, apiError } from '@/lib/auth/middleware';
import { accountAccessWhere } from '@/lib/accounts/access';
import {
  AttachmentNotFoundError,
  AttachmentProviderError,
  getReceivedAttachment,
  readStoredAttachment,
} from '@/lib/email/attachment-retrieval';

interface RouteParams {
  params: Promise<{ id: string; emailId: string; attachmentId: string }>;
}

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: RouteParams) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { id: accountId, emailId, attachmentId } = await params;

  const where: Record<string, unknown> = { id: emailId };

  // Check account access
  if (accountId !== 'all' && accountId !== 'new-emails') {
    const account = await prisma.emailAccount.findFirst({
      where: accountAccessWhere(auth, accountId),
      select: { id: true },
    });
    if (!account) return apiError('Account not found', 404);
    where.accountId = accountId;
  } else {
    where.account = accountAccessWhere(auth);
  }

  // Ensure email exists and user has access
  const email = await prisma.email.findFirst({
    where,
    select: { id: true },
  });

  if (!email) return apiError('Email not found', 404);

  // Fetch the attachment record
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
  });

  if (!attachment || attachment.emailId !== email.id) {
    return apiError('Attachment not found', 404);
  }

  try {
    return await attachmentResponse(
      { userId: auth.userId, organizationId: auth.organizationId },
      req.signal,
      signal => attachment.storagePath
        ? readStoredAttachment(attachment, signal)
        : getReceivedAttachment(email.id, attachment.id, signal),
      retrieved => ({
        'Content-Type': retrieved.contentType || attachment.contentType || 'application/octet-stream',
        'Content-Disposition': buildContentDisposition(retrieved.filename || attachment.filename || 'download'),
        'Content-Length': retrieved.content.length.toString(),
      }),
    );
  } catch (error) {
    if (error instanceof AdmissionError) {
      return apiError(error.unavailable ? 'Attachment download temporarily unavailable' : 'Attachment download capacity exceeded; retry later', error.unavailable ? 503 : 429);
    }
    if (req.signal.aborted) return apiError('Attachment download cancelled', 408);
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return apiError('Attachment download timed out', 504);
    }
    console.error(error);

    if (error instanceof IncomingBudgetError) {
      return apiError('Attachment exceeds the bounded download policy (20 MiB). Use your mail provider to export larger historical attachments.', 413);
    }

    if (error instanceof AttachmentNotFoundError) {
      return apiError('Attachment not found', 404);
    }

    if (error instanceof AttachmentProviderError) {
      return apiError('Failed to retrieve attachment', 502);
    }

    return apiError('Failed to download attachment', 500);
  }
}

function buildContentDisposition(filename: string): string {
  const normalized = filename.replace(/[\r\n]+/g, '').trim() || 'download';
  const asciiFallback =
    normalized.replace(/[^\x20-\x7E]+/g, '_').replace(/["\\]/g, '_') ||
    'download';

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(
    normalized
  )}`;
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
