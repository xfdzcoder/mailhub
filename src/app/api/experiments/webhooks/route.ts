import { randomUUID } from 'node:crypto';
import { protectCredentials, publicWebhook } from '@/lib/integrations/credentials';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import {
  authenticate,
  requireAdmin,
  apiResponse,
  apiError,
} from '@/lib/auth/middleware';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  const webhooks = await prisma.notificationWebhook.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
  });

  return apiResponse(webhooks.map(publicWebhook));
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  try {
    const body = await req.json();
    const { name, type, config } = body;

    if (!name || !type || !config) {
      return apiError('Name, type, and config are required.', 400);
    }

    if (!['TELEGRAM', 'WECOM', 'GENERIC'].includes(type)) {
      return apiError('Invalid webhook type. Supported: TELEGRAM, WECOM, GENERIC', 400);
    }

    const id = randomUUID();
    const webhook = await prisma.notificationWebhook.create({
      data: {
        id,
        ...protectCredentials('notification_webhooks', { id, organizationId: auth.organizationId }, { config }),
        organizationId: auth.organizationId,
        name: name.trim(),
        type,
        config,
        isActive: true,
      },
    });

    return apiResponse(publicWebhook(webhook), 201);
  } catch {
    return apiError('Failed to create notification webhook', 500);
  }
}
