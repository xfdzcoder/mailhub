jest.mock('@/lib/db/prisma', () => ({ prisma: {
  experimentSetting: { findUnique: jest.fn() },
  organizationMember: { findUnique: jest.fn() },
} }));
jest.mock('@/lib/settings/system-preferences', () => ({ getSystemPreferences: jest.fn().mockResolvedValue({ isAiEnabled: true }) }));
jest.mock('@/lib/network/origin-policy', () => ({
  ...jest.requireActual('@/lib/network/origin-policy'), modelPostJson: jest.fn(),
}));
import { prisma } from '@/lib/db/prisma';
import { callLlmApi } from '@/lib/ai/llm-client';
import { modelPostJson } from '@/lib/network/origin-policy';

const env = { ...process.env };
const args = { organizationId: 'org', systemInstruction: 'system', userPrompt: 'prompt' };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.AI_API_KEY = 'shared-test-key';
  delete process.env.AI_PROVIDER;
  delete process.env.AI_BASE_URL;
  delete process.env.AI_SHARED_CREDENTIAL_ORIGIN;
  (prisma.experimentSetting.findUnique as jest.Mock).mockResolvedValue(null);
  (modelPostJson as jest.Mock).mockResolvedValue({ choices: [{ message: { content: 'ok' } }], content: [{ type: 'text', text: 'ok' }] });
});
afterEach(() => { process.env = { ...env }; });
function headers() { return (modelPostJson as jest.Mock).mock.calls[0][1]; }

it('sends shared credentials only to the approved provider origin', async () => {
  await callLlmApi(args);
  expect(headers().Authorization).toBe('Bearer shared-test-key');
});
it.each(['https://custom.example/v1', 'https://api.openai.com/v1'])('does not inherit shared credentials at tenant endpoint %s', async baseUrl => {
  await callLlmApi({ ...args, baseUrl });
  expect(headers().Authorization).toBeUndefined();
});
it('supports a tenant key at a tenant endpoint', async () => {
  await callLlmApi({ ...args, baseUrl: 'http://model:11434/v1', apiKey: 'tenant-test-key' });
  expect(headers().Authorization).toBe('Bearer tenant-test-key');
});
it('respects an explicit no-key selection', async () => {
  await callLlmApi({ ...args, baseUrl: 'http://model:11434/v1', apiKey: null });
  expect(headers().Authorization).toBeUndefined();
});
it('does not send OpenAI shared credentials to Anthropic', async () => {
  await callLlmApi({ ...args, provider: 'claude' });
  expect(headers()['x-api-key']).toBeUndefined();
});
it('requires separate credential-origin approval for deployment custom endpoints', async () => {
  process.env.AI_BASE_URL = 'https://custom.example/v1';
  await callLlmApi(args);
  expect(headers().Authorization).toBeUndefined();
  process.env.AI_SHARED_CREDENTIAL_ORIGIN = 'https://custom.example';
  await callLlmApi(args);
  expect((modelPostJson as jest.Mock).mock.calls[1][1].Authorization).toBe('Bearer shared-test-key');
});
it('does not inherit shared credentials from stored tenant configuration', async () => {
  (prisma.experimentSetting.findUnique as jest.Mock).mockResolvedValue({ aiBaseUrl: 'http://model:11434/v1', aiProvider: 'ollama' });
  await callLlmApi(args);
  expect(headers().Authorization).toBeUndefined();
});
