import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import {
  authenticate,
  requireAdmin,
  apiResponse,
  apiError,
} from '@/lib/auth/middleware';
import { summaryQueue } from '@/lib/queue/client';
import { createHash } from 'node:crypto';
import { AdmissionError, reserve } from '@/lib/workload/admission';
import { accountAccessWhere } from '@/lib/accounts/access';

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  try {
    const body = await req.json();
    const { labelId, timeRangeHours = 24, limit = 25, webhookIds = [] } = body;

    if (!labelId) {
      return apiError('labelId is required', 400);
    }

    const label = await prisma.label.findFirst({
      where: {
        id: labelId,
        organizationId: auth.organizationId,
        accountLabels: {
          some: {
            account: accountAccessWhere(auth),
          },
        },
      },
    });

    if (!label) {
      return apiError('Label not found', 404);
    }

    const parsedLimit = Math.min(100, Math.max(1, Number(limit) || 25));
    const parsedTimeRangeHours = Math.min(720, Math.max(1, Number(timeRangeHours) || 24));
    const uniqueWebhookIds = Array.isArray(webhookIds)
      ? Array.from(new Set(webhookIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0))).sort().slice(0, 20)
      : [];
    // Coalesce identical interactive triggers in a five-minute scheduling window.
    const key = createHash('sha256').update(JSON.stringify([auth.userId, auth.organizationId, label.id, parsedLimit, parsedTimeRangeHours, uniqueWebhookIds, Math.floor(Date.now() / 300000)])).digest('hex');
    const runId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
    await reserve(auth, 'queued', `bull:email-summary:${runId}`);
    const existing = await prisma.emailSummaryRun.findUnique({ where: { id: runId } });
    if (existing) return apiResponse({ summaryRunId: existing.id, status: existing.status, labelName: existing.labelName }, 200);
    const summaryRun = await prisma.emailSummaryRun.create({
      data: {
        id: runId,
        organizationId: auth.organizationId,
        userId: auth.userId,
        labelId: label.id,
        labelName: label.name,
        status: 'QUEUED',
      },
    });

    // Initialize real-time agent tracker in Redis
    const { initAgentRun } = await import('@/lib/ai/agent-tracker');
    await initAgentRun(summaryRun.id, label.name, {
      timeRangeHours: isNaN(parsedTimeRangeHours) ? 0 : parsedTimeRangeHours,
      limit: isNaN(parsedLimit) ? 0 : parsedLimit,
    });

    const payload = {
      summaryRunId: summaryRun.id,
      organizationId: auth.organizationId,
      userId: auth.userId,
      labelId: label.id,
      webhookIds: uniqueWebhookIds,
      timeRangeHours: isNaN(parsedTimeRangeHours) ? 0 : parsedTimeRangeHours,
      limit: isNaN(parsedLimit) ? 0 : parsedLimit,
    };

    try {
      await summaryQueue.add('generate-summary', payload, { jobId: summaryRun.id });
    } catch (error) {
      await prisma.emailSummaryRun.update({ where: { id: summaryRun.id }, data: { status: 'FAILED', errorMessage: 'Admission or enqueue failed' } });
      throw error;
    }

    return apiResponse(
      {
        summaryRunId: summaryRun.id,
        status: 'QUEUED',
        labelName: label.name,
      },
      201
    );
  } catch (err: any) {
    return apiError(err.message || 'Failed to trigger summary job', err instanceof AdmissionError ? (err.unavailable ? 503 : 429) : 503);
  }
}
