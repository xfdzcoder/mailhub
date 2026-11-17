import { prisma } from '@/lib/db/prisma';
import { readWebhookCredentials } from '@/lib/integrations/credentials';
import { protectSensitive } from '@/lib/auth/attempts';
import { NextRequest } from 'next/server';
import {
  authenticate,
  requireAdmin,
  apiResponse,
  apiError,
} from '@/lib/auth/middleware';
import { dispatchWebhookNotification } from '@/lib/notifications';

async function handlePOST(req: NextRequest) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  try {
    const body = await req.json();
    let { type, config } = body;
    if (body.id !== undefined) {
      if (typeof body.id !== 'string') return apiError('Invalid webhook ID', 400);
      const webhook = await prisma.notificationWebhook.findFirst({ where: { id: body.id, organizationId: auth.organizationId } });
      if (!webhook) return apiError('Webhook channel not found', 404);
      type = webhook.type;
      config = readWebhookCredentials(webhook);
    }

    if (!['TELEGRAM', 'WECOM', 'GENERIC'].includes(type) || !config || typeof config !== 'object' || Array.isArray(config)) {
      return apiError('Type and config are required for test dispatch', 400);
    }

    const testSummaryText = `🎉 *MailHub Notification Webhook Test*\n\nThis is a test notification payload sent from MailHub Experimental Features. Your ${type} webhook integration is working successfully!`;

    const result = await dispatchWebhookNotification({
      type,
      config,
      labelName: 'Test Channel',
      summaryText: testSummaryText,
      emailCount: 1,
    });

    if (!result.success) {
      return apiError(result.error || 'Failed to dispatch test notification', 400);
    }

    return apiResponse({ message: 'Test message sent successfully!', result });
  } catch {
    return apiError('Failed to send test webhook notification', 500);
  }
}

export const POST = protectSensitive('test', handlePOST);
