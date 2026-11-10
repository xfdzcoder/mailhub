import { notificationPost, OutboundStatusError, OriginPolicyError } from '../network/origin-policy';
import { GenericWebhookConfig, WebhookDispatchResult } from './types';

export async function sendGenericWebhookNotification(
  config: GenericWebhookConfig,
  labelName: string,
  summaryText: string,
  emailCount: number
): Promise<WebhookDispatchResult> {
  const deliveredAt = new Date().toISOString();

  if (!config.url) {
    return {
      success: false,
      type: 'GENERIC',
      error: 'Missing Generic Webhook URL',
      deliveredAt,
    };
  }

  const payload = {
    event: 'email.summary',
    label: labelName,
    emailCount,
    summary: summaryText,
    timestamp: deliveredAt,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.headers || {}),
  };

  if (config.secret) {
    headers['X-Webhook-Secret'] = config.secret;
  }

  try {
    const res = await notificationPost(config.url, headers, JSON.stringify(payload));

    return {
      success: true,
      type: 'GENERIC',
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
      type: 'GENERIC',
      statusCode: err instanceof OutboundStatusError ? err.statusCode : undefined,
      error: errorMsg,
      deliveredAt,
    };
  }
}
