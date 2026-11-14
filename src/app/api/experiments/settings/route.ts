import { randomUUID } from 'node:crypto';
import { protectCredentials, readAiCredentials, publicAiSettings } from '@/lib/integrations/credentials';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import {
  authenticate,
  requireAdmin,
  apiResponse,
  apiError,
} from '@/lib/auth/middleware';
import { getSystemPreferences } from '@/lib/settings/system-preferences';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  let settings = await prisma.experimentSetting.findUnique({
    where: { organizationId: auth.organizationId },
  });

  if (!settings) {
    settings = await prisma.experimentSetting.create({
      data: {
        organizationId: auth.organizationId,
        isAiEnabled: true,
        aiProvider: 'openai',
        aiModelName: 'gpt-4o-mini',
      },
    });
  }

  const systemPreferences = await getSystemPreferences();
  return apiResponse({
    ...publicAiSettings(settings),
    systemAiEnabled: systemPreferences.isAiEnabled,
  });
}

export async function PUT(req: NextRequest) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return apiError('A settings object is required', 400);
    }
    const input = body as Record<string, unknown>;
    const existing = await prisma.experimentSetting.findUnique({
      where: { organizationId: auth.organizationId },
    });
    const dataToUpdate: {
      isAiEnabled?: boolean;
      aiProvider?: string;
      aiApiKey?: string | null;
      aiBaseUrl?: string | null;
      aiModelName?: string;
      aiCustomPrompt?: string | null;
    } = {};

    if ('isAiEnabled' in input) {
      if (typeof input.isAiEnabled !== 'boolean') return apiError('isAiEnabled must be a boolean', 400);
      dataToUpdate.isAiEnabled = input.isAiEnabled;
    }
    if ('aiProvider' in input) {
      if (typeof input.aiProvider !== 'string') return apiError('aiProvider must be a string', 400);
      dataToUpdate.aiProvider = input.aiProvider;
    }
    if ('aiModelName' in input) {
      if (typeof input.aiModelName !== 'string') return apiError('aiModelName must be a string', 400);
      dataToUpdate.aiModelName = input.aiModelName;
    }
    if ('aiBaseUrl' in input) {
      if (input.aiBaseUrl !== null && typeof input.aiBaseUrl !== 'string') return apiError('aiBaseUrl must be a string or null', 400);
      dataToUpdate.aiBaseUrl = input.aiBaseUrl as string | null;
    }
    if ('aiCustomPrompt' in input) {
      if (input.aiCustomPrompt !== null && typeof input.aiCustomPrompt !== 'string') return apiError('aiCustomPrompt must be a string or null', 400);
      dataToUpdate.aiCustomPrompt = input.aiCustomPrompt as string | null;
    }
    if ('aiApiKey' in input) {
      if (input.aiApiKey !== null && typeof input.aiApiKey !== 'string') return apiError('aiApiKey must be a string or null', 400);
      dataToUpdate.aiApiKey = input.aiApiKey === null ? null : (input.aiApiKey as string).trim();
    }

    const id = existing?.id || randomUUID();
    const previous = existing ? readAiCredentials(existing) : { aiApiKey: null, aiBaseUrl: null };
    const payload = {
      aiApiKey: dataToUpdate.aiApiKey !== undefined ? dataToUpdate.aiApiKey : previous.aiApiKey,
      aiBaseUrl: dataToUpdate.aiBaseUrl !== undefined ? dataToUpdate.aiBaseUrl : previous.aiBaseUrl,
    };
    const protectedData = protectCredentials('experiment_settings', { id, organizationId: auth.organizationId }, payload);
    const data = { ...dataToUpdate, ...payload, ...protectedData };
    // Optimistic concurrency prevents a partial form update overwriting another secret edit.
    if (existing) {
      const result = await prisma.experimentSetting.updateMany({
        where: { id, updatedAt: existing.updatedAt, credentialsEncrypted: existing.credentialsEncrypted }, data,
      });
      if (result.count !== 1) return apiError('Settings changed; reload and retry', 409);
    } else {
      await prisma.experimentSetting.create({ data: { id, organizationId: auth.organizationId, ...data } });
    }
    const settings = await prisma.experimentSetting.findUniqueOrThrow({ where: { id } });

    const systemPreferences = await getSystemPreferences();
    return apiResponse({
      ...publicAiSettings(settings),
      systemAiEnabled: systemPreferences.isAiEnabled,
    });
  } catch {
    return apiError('Failed to update experiment settings', 500);
  }
}
