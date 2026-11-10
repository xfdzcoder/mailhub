import { protectSensitive } from '@/lib/auth/attempts';
import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/auth/middleware';
import { sendPush, reportPushFailure } from '@/lib/notifications/push';
import { prisma } from '@/lib/db/prisma';

async function handlePOST(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    if (auth instanceof NextResponse) return auth;
    const { organizationId, userId } = auth;

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { organizationId, userId },
    });

    if (subscriptions.length === 0) {
      return NextResponse.json({ error: 'No active push subscriptions found' }, { status: 404 });
    }

    const pushPayload = JSON.stringify({
      title: 'MailHub Test Notification',
      body: 'If you see this, background notifications are working correctly!',
      url: '/inbox',
    });

    const results = await Promise.allSettled(
      subscriptions.map((sub: any) => 
        sendPush({
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          }
        }, userId, pushPayload).catch(async (err: any) => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            console.log('Push subscription expired or removed, deleting from DB');
            await prisma.pushSubscription.delete({ where: { id: sub.id } });
          } else {
            reportPushFailure(err);
          }
          throw err;
        })
      )
    );

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    
    return NextResponse.json({ 
      success: true, 
      message: `Sent to ${successCount} out of ${subscriptions.length} devices` 
    });
  } catch (error: any) {
    reportPushFailure(error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export const POST = protectSensitive('test', handlePOST);
