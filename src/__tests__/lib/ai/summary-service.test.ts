jest.mock('@/lib/network/origin-policy', () => ({ ...jest.requireActual('@/lib/network/origin-policy'), modelPostJson: jest.fn() }));
import { modelPostJson } from '@/lib/network/origin-policy';
jest.mock('@/lib/db/prisma', () => ({ prisma: { systemPreference: { upsert: jest.fn().mockResolvedValue({ isAiEnabled: true }) }, experimentSetting: { findUnique: jest.fn().mockResolvedValue(null) } } }));
import { generateEmailBatchSummary } from '../../../lib/ai/summary-service';

describe('AI LLM Email Summarization Service', () => {
  beforeEach(() => {
    (modelPostJson as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns fallback string when email list is empty', async () => {
    const summary = await generateEmailBatchSummary({
      organizationId: 'test-organization-id',
      provider: 'openai',
      labelName: 'Invoices',
      emails: [],
    });

    expect(summary).toContain('No emails found under label **Invoices** to summarize.');
    expect(modelPostJson).not.toHaveBeenCalled();
  });

  test('calls OpenAI endpoint and returns generated summary text', async () => {
    (modelPostJson as jest.Mock).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '- Invoice #1024 paid\n- Renewal due next week',
            },
          },
        ],
    });

    const summary = await generateEmailBatchSummary({
      organizationId: 'test-organization-id',
      provider: 'openai',
      apiKey: 'sk-test-key',
      modelName: 'gpt-4o-mini',
      labelName: 'Finance',
      emails: [
        {
          id: '1',
          subject: 'Invoice Paid',
          fromName: 'Stripe',
          fromAddress: 'receipts@stripe.com',
          snippet: 'Payment of $49 succeeded',
          receivedAt: new Date('2026-08-04T12:00:00Z'),
        },
      ],
    });

    expect(summary).toBe('- Invoice #1024 paid\n- Renewal due next week');
    expect(modelPostJson).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ Authorization: 'Bearer sk-test-key' }),
      expect.any(String)
    );
  });

  test('calls Claude endpoint with x-api-key header', async () => {
    (modelPostJson as jest.Mock).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Claude summary of emails' }],
    });

    const summary = await generateEmailBatchSummary({
      organizationId: 'test-organization-id',
      provider: 'claude',
      apiKey: 'claude-key',
      modelName: 'claude-3-5-sonnet-20241022',
      labelName: 'Support',
      emails: [
        {
          id: '2',
          subject: 'Ticket #404',
          snippet: 'Password reset request',
        },
      ],
    });

    expect(summary).toBe('Claude summary of emails');
    expect(modelPostJson).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ 'x-api-key': 'claude-key' }),
      expect.any(String)
    );
  });

  test('includes cleaned bodyText in single pass prompt when bodyText is provided', async () => {
    (modelPostJson as jest.Mock).mockResolvedValueOnce({
        choices: [{ message: { content: 'Summary of body text email' } }],
    });

    const summary = await generateEmailBatchSummary({
      organizationId: 'test-organization-id',
      provider: 'openai',
      apiKey: 'sk-test-key',
      labelName: 'Support',
      emails: [
        {
          id: '10',
          subject: 'Full Body Email',
          bodyText: '<p>Hello <b>World</b>!</p><script>alert("xss")</script> This is full body content.',
        },
      ],
    });

    expect(summary).toBe('Summary of body text email');
    const fetchBody = JSON.parse((modelPostJson as jest.Mock).mock.calls[0][2]);
    const userMessageContent = fetchBody.messages.find((m: { role: string }) => m.role === 'user').content;
    expect(userMessageContent).toContain('This is full body content.');
    expect(userMessageContent).not.toContain('<script>');
  });

  test('triggers Map-Reduce chunked summarization for email batches exceeding threshold', async () => {
    (modelPostJson as jest.Mock)
      .mockResolvedValueOnce({
        choices: [{ message: { content: '- Chunk 1 summary' } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '- Chunk 2 summary' } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Final reduced executive summary' } }],
      });

    const dummyEmails = Array.from({ length: 25 }, (_, i) => ({
      id: `email-${i}`,
      subject: `Subject ${i}`,
      snippet: `Snippet ${i}`,
      bodyText: `Full body content for email ${i}`,
    }));

    const summary = await generateEmailBatchSummary({
      organizationId: 'test-organization-id',
      provider: 'openai',
      apiKey: 'sk-test-key',
      labelName: 'Support',
      emails: dummyEmails,
      chunkSize: 15,
    });

    expect(summary).toBe('Final reduced executive summary');
    expect(modelPostJson).toHaveBeenCalledTimes(3);
  });
});

