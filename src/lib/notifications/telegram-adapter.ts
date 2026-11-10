import { notificationPost, OutboundStatusError, OriginPolicyError } from '../network/origin-policy';
import { TelegramConfig, WebhookDispatchResult } from './types';

export async function sendTelegramNotification(
  config: TelegramConfig,
  labelName: string,
  summaryText: string
): Promise<WebhookDispatchResult> {
  const deliveredAt = new Date().toISOString();
  
  if (!config.botToken || !config.chatId) {
    return {
      success: false,
      type: 'TELEGRAM',
      error: 'Missing Telegram botToken or chatId',
      deliveredAt,
    };
  }

  const message = `📧 *MailHub AI Summary: ${labelName}*\n\n${summaryText}`;

  try {
    const url = `https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/sendMessage`;
    const res = await notificationPost(url, { 'Content-Type': 'application/json' }, JSON.stringify({
      chat_id: config.chatId,
      text: message,
      parse_mode: 'Markdown',
    }));

    return {
      success: true,
      type: 'TELEGRAM',
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
      type: 'TELEGRAM',
      statusCode: err instanceof OutboundStatusError ? err.statusCode : undefined,
      error: errorMsg,
      deliveredAt,
    };
  }
}
