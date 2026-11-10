import { sendPush, reportPushFailure } from './push';
import { prisma } from '@/lib/db/prisma';

export interface AccountPushNotification {
  organizationId: string;
  accountId: string;
  title: string;
  body: string;
  url: string;
}

export async function sendAccountPushNotification(
  notification: AccountPushNotification
): Promise<void> {
  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      organizationId: notification.organizationId,
      userId: { not: null },
      user: {
        memberships: {
          some: {
            organizationId: notification.organizationId,
            OR: [
              { role: 'admin' },
              { ownedEmailAccounts: { some: { id: notification.accountId } } },
              { emailAccountAccess: { some: { accountId: notification.accountId } } },
            ],
          },
        },
      },
    },
  });

  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url,
  });

  await Promise.all(
    subscriptions.map((subscription) =>
      sendPush(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          subscription.userId!,
          payload
        )
        .catch(async (error: { statusCode?: number }) => {
          if (error.statusCode === 404 || error.statusCode === 410) {
            await prisma.pushSubscription.delete({
              where: { id: subscription.id },
            });
            return;
          }

          reportPushFailure(error);
        })
    )
  );
}
