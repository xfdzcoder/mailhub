import { notificationPost, OutboundStatusError, OriginPolicyError } from '../network/origin-policy';
import { WeComConfig, WebhookDispatchResult } from './types';

export async function sendWeComNotification(
  config: WeComConfig,
  labelName: string,
  summaryText: string
): Promise<WebhookDispatchResult> {
  const deliveredAt = new Date().toISOString();
  
  if (!config.webhookUrl) {
    return {
      success: false,
      type: 'WECOM',
      error: 'Missing WeCom webhookUrl',
      deliveredAt,
    };
  }

  const markdownContent = `### 📧 MailHub AI Summary: ${labelName}\n\n${summaryText}`;

  try {
    const res = await notificationPost(config.webhookUrl, { 'Content-Type': 'application/json' }, JSON.stringify({
      msgtype: 'markdown',
      markdown: {
        content: markdownContent,
      },
    }));

    return {
      success: true,
      type: 'WECOM',
      statusCode: res.statusCode,
      deliveredAt,
    };
  } catch (err: unknown) {
    // Never persist remote bodies, URLs, path/query tokens or raw socket errors.
    const errorMsg = err instanceof OriginPolicyError
      ? 'Notification destination is not approved; ask the operator to configure NOTIFICATION_ORIGIN_POLICY'
      : 'Notification delivery failed';
    return {
      success: false,
      type: 'WECOM',
      statusCode: err instanceof OutboundStatusError ? err.statusCode : undefined,
      error: errorMsg,
      deliveredAt,
    };
  }
}
