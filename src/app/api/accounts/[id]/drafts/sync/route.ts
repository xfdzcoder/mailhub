import { readOutgoingJson, validateOutgoingMail, OutgoingInputError, checkBytes, outgoingLimits, validateRawOutgoing } from '@/lib/email/outgoing-budget';
import { NextRequest } from 'next/server';
import { authenticate, apiResponse, apiError } from '@/lib/auth/middleware';
import { prisma } from '@/lib/db/prisma';
import { z } from 'zod';
import { ImapFlow } from 'imapflow';
import { decrypt } from '@/lib/crypto';
import { getValidAccessToken, syncDraftRaw } from '@/lib/gmail/api';
import { accountAccessWhere } from '@/lib/accounts/access';
import { resolveSafeOutboundHost } from '@/lib/network/outbound-host';

import { readOutgoingFile } from '@/lib/email/outgoing-files';

const syncDraftSchema = z.object({
  draftId: z.string(),
});

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
  });

  if (!account) return apiError('Account not found', 404);

  let body: unknown;
  try { body = await readOutgoingJson(req); }
  catch (error) {
    if (error instanceof OutgoingInputError) return apiError(error.message, error.status);
    throw error;
  }
  const parsed = syncDraftSchema.safeParse(body);
  if (!parsed.success) return apiError(parsed.error.issues[0].message, 422);
  try { checkBytes(parsed.data.draftId, outgoingLimits().argumentBytes, 'Draft ID'); }
  catch (error) {
    if (error instanceof OutgoingInputError) return apiError(error.message, error.status);
    throw error;
  }

  const { draftId } = parsed.data;

  const draft = await prisma.email.findFirst({
    where: { id: draftId, accountId },
    include: { body: true, attachments: { take: outgoingLimits().attachments + 1 } },
  });

  if (!draft || !draft.isDraft) {
    return apiError('Draft not found', 404);
  }

  try {
    let warning: string | undefined;
    const MailComposer = require('nodemailer/lib/mail-composer');
    const joinAddresses = (json: unknown): string | undefined => {
      if (!Array.isArray(json)) return undefined;
      const addrs = json
        .map((a) => (a as { address?: string })?.address)
        .filter((a): a is string => !!a);
      return addrs.length ? addrs.join(', ') : undefined;
    };

    const to = joinAddresses(draft.toAddresses);
    const cc = joinAddresses(draft.ccAddresses);
    const bcc = joinAddresses(draft.bccAddresses);
    validateOutgoingMail({ to, cc, bcc, subject: draft.subject, bodyHtml: draft.body?.bodyHtml, bodyText: draft.body?.bodyText });
    const limits = outgoingLimits();
    if (draft.attachments.length > limits.attachments) throw new OutgoingInputError('Too many attachments');
    let total = 0;
    const validAttachments = [];
    for (const att of draft.attachments) {
      checkBytes(att.filename, limits.headerBytes, 'Filename');
      checkBytes(att.contentType, limits.headerBytes, 'Content type');
      if (!att.storagePath) continue;
      const content = await readOutgoingFile(att.storagePath, limits.totalAttachmentBytes - total);
      total += content.length;
      validAttachments.push({ filename: att.filename || 'attachment', contentType: att.contentType || 'application/octet-stream', content });
    }

    const composer = new MailComposer({
      from: `"${account.label}" <${account.emailAddress}>`,
      to: joinAddresses(draft.toAddresses),
      cc: joinAddresses(draft.ccAddresses),
      bcc: joinAddresses(draft.bccAddresses),
      subject: draft.subject,
      html: draft.body?.bodyHtml,
      text: draft.body?.bodyText,
      attachments: validAttachments.length > 0 ? validAttachments : undefined,
      keepBcc: true,
    });
    const rawBuffer = await composer.compile().build();
    validateRawOutgoing(rawBuffer);

    if (account.provider === 'gmail') {
      const accessToken = await getValidAccessToken(account.id);
      try {
        await syncDraftRaw(accessToken, rawBuffer);
      } catch (e: any) {
        console.error('Failed to sync draft to Gmail:', e.message);
        warning = 'Failed to sync draft to Gmail';
      }
    } else {
      if (account.imapHost && account.passwordEncrypted) {
        const destination = await resolveSafeOutboundHost(account.imapHost);
        const client = new ImapFlow({
          host: destination.address,
          port: account.imapPort || 993,
          secure: account.imapSecure ?? true,
          ...(destination.servername ? { servername: destination.servername } : {}),
          auth: {
            user: account.username || account.emailAddress,
            pass: decrypt(account.passwordEncrypted),
          },
          logger: false,
        });

        try {
          await client.connect();
          await client.append('Drafts', rawBuffer, ['\\Draft']);
          await client.logout();
        } finally {
          client.close();
        }
      }
    }

    return apiResponse({ success: true, ...(warning ? { warning } : {}) });
  } catch (error) {
    if (error instanceof OutgoingInputError) return apiError(error.message, error.status);
    console.error('IMAP sync draft error:', error);
    // Don't fail the API call if IMAP sync fails, as local save succeeded
    return apiResponse({ success: true, warning: 'Failed to sync to IMAP' });
  }
}
