import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/auth/middleware';
import { prisma } from '@/lib/db/prisma';
import { z } from 'zod';
import { approvePushDestination, consumePushBudget, PUSH_DEVICE_LIMIT, PushBudgetError, PushValidationError } from '@/lib/notifications/push';
import { OriginPolicyError } from '@/lib/network/origin-policy';

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().max(2048),
    keys: z.object({
      p256dh: z.string().max(87),
      auth: z.string().max(22),
    }),
  }),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    if (auth instanceof NextResponse) return auth;
    const { organizationId, userId } = auth;

    const body = await req.json();
    const parsed = subscribeSchema.parse(body);
    const { endpoint, keys } = parsed.subscription;

    await consumePushBudget(userId, 'register');
    await approvePushDestination(parsed.subscription);
    const result = await prisma.$transaction(async (tx) => {
      // Serialize device quota checks across processes for the same owner.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      const existing = await tx.pushSubscription.findUnique({ where: { endpoint } });
      if (existing) {
        if (existing.userId !== userId || existing.organizationId !== organizationId) return 409;
        await tx.pushSubscription.update({ where: { id: existing.id }, data: { p256dh: keys.p256dh, auth: keys.auth } });
      } else {
        const count = await tx.pushSubscription.count({ where: { userId } });
        if (count >= PUSH_DEVICE_LIMIT) return 429;
        await tx.pushSubscription.create({ data: { endpoint, p256dh: keys.p256dh, auth: keys.auth, organizationId, userId } });
      }
      return 200;
    });
    if (result !== 200) return NextResponse.json({ error: result === 409 ? 'Push destination already registered' : 'Push device quota exceeded' }, { status: result });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error instanceof PushBudgetError) return NextResponse.json({ error: error.message }, { status: 429 });
    if (error instanceof PushValidationError || error instanceof OriginPolicyError) return NextResponse.json({ error: 'Push destination is invalid or unapproved' }, { status: 400 });
    if (error?.code === 'P2002') return NextResponse.json({ error: 'Push destination already registered' }, { status: 409 });
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten().fieldErrors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// Release is authorized by the prior owner's current session, never endpoint possession.
export async function DELETE(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    if (auth instanceof NextResponse) return auth;
    const { endpoint } = z.object({ endpoint: z.string().min(1).max(2048) }).parse(await req.json());
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: auth.userId, organizationId: auth.organizationId } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Unable to release push subscription' }, { status: 400 });
  }
}
