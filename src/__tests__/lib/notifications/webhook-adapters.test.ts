jest.mock('../../../lib/network/origin-policy', () => ({ ...jest.requireActual('../../../lib/network/origin-policy'), notificationPost: jest.fn() }));
import { notificationPost } from '../../../lib/network/origin-policy';
import {
  sendTelegramNotification,
  sendWeComNotification,
  sendGenericWebhookNotification,
  dispatchWebhookNotification,
} from '../../../lib/notifications';

describe('Webhook Notification Adapters', () => {
  beforeEach(() => {
    (notificationPost as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  test('sendTelegramNotification formats payload and dispatches successfully', async () => {
    (notificationPost as jest.Mock).mockResolvedValueOnce({
      ok: true,
      statusCode: 200,
      json: async () => ({ ok: true }),
    });

    const result = await sendTelegramNotification(
      { botToken: 'test-token', chatId: '123456' },
      'Invoices',
      'Summary of 5 invoices'
    );

    expect(result.success).toBe(true);
    expect(result.type).toBe('TELEGRAM');
    expect(notificationPost).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        'Content-Type': 'application/json',
      }),
      expect.any(String)
    );
  });

  test('sendWeComNotification formats markdown payload and dispatches successfully', async () => {
    (notificationPost as jest.Mock).mockResolvedValueOnce({
      ok: true,
      statusCode: 200,
    });

    const result = await sendWeComNotification(
      { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=123' },
      'Support',
      'Summary of support tickets'
    );

    expect(result.success).toBe(true);
    expect(result.type).toBe('WECOM');
    expect(notificationPost).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=123',
      { 'Content-Type': 'application/json' },
      expect.stringContaining('### 📧 MailHub AI Summary: Support')
    );
  });

  test('sendGenericWebhookNotification posts standard JSON payload', async () => {
    (notificationPost as jest.Mock).mockResolvedValueOnce({
      ok: true,
      statusCode: 200,
    });

    const result = await sendGenericWebhookNotification(
      { url: 'https://example.com/webhook', secret: 'my-secret' },
      'Urgent',
      'Summary text',
      3
    );

    expect(result.success).toBe(true);
    expect(result.type).toBe('GENERIC');
    expect(notificationPost).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Webhook-Secret': 'my-secret',
      }),
      expect.any(String)
    );
  });

  test('dispatchWebhookNotification dispatches via generic interface', async () => {
    (notificationPost as jest.Mock).mockResolvedValueOnce({
      ok: true,
      statusCode: 200,
    });

    const result = await dispatchWebhookNotification({
      type: 'TELEGRAM',
      config: { botToken: 'token', chatId: '999' },
      labelName: 'Updates',
      summaryText: 'Some summary',
      emailCount: 2,
    });

    expect(result.success).toBe(true);
  });
});

it('redacts and bounds raw transport diagnostics', async () => {
  (notificationPost as jest.Mock).mockRejectedValueOnce(new Error('https://example.invalid/botsecret?key=secret ' + 'x'.repeat(10000)));
  const result = await sendTelegramNotification({ botToken: 'synthetic', chatId: 'synthetic' }, 'Synthetic', 'Summary');
  expect(result).toMatchObject({ success: false, error: 'Notification delivery failed' });
});

it('encodes Telegram path credentials instead of allowing route injection', async () => {
  (notificationPost as jest.Mock).mockResolvedValueOnce({ statusCode: 200 });
  await sendTelegramNotification({ botToken: 'synthetic/token?key=secret', chatId: 'synthetic' }, 'Synthetic', 'Summary');
  expect(notificationPost).toHaveBeenLastCalledWith(
    'https://api.telegram.org/botsynthetic%2Ftoken%3Fkey%3Dsecret/sendMessage', expect.any(Object), expect.any(String));
});
