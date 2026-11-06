import { NextRequest } from 'next/server';
import { requestPolicy } from '@/lib/auth/request-policy';
import { trustedClient } from '@/lib/auth/attempts';
import { registerSchema, loginSchema, changePasswordSchema, createUserSchema } from '@/lib/validation';

const req = (headers: Record<string, string> = {}, body: string | null = '{}') => new NextRequest('https://app.example/api/auth/login', { method: 'POST', headers, body });
afterEach(() => { delete process.env.AUTH_TRUSTED_ORIGINS; delete process.env.AUTH_TRUSTED_CLIENT_IP_HEADER; delete process.env.AUTH_TRUSTED_PROXY_SECRET; });
beforeEach(() => { process.env.AUTH_TRUSTED_ORIGINS = 'https://app.example'; });
test('requires exact trusted Origin, including for same-site subdomains', () => {
  for (const origin of ['https://evil.example', 'null', 'https://app.example.evil']) {
    expect(requestPolicy(req({ origin, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }))?.status).toBe(403);
  }
  expect(requestPolicy(req({ origin: 'https://app.example', 'content-type': 'application/json' }))).toBeNull();
});
test('missing origin requires non-browser bearer without cookies', () => {
  expect(requestPolicy(req())?.status).toBe(403);
  expect(requestPolicy(req({ authorization: 'Bearer synthetic', 'content-type': 'application/json' }))).toBeNull();
  expect(requestPolicy(req({ authorization: 'Bearer synthetic', cookie: 'auth-token=synthetic' }))?.status).toBe(403);
});
test('rejects simple content types and permits empty refresh writes', () => {
  expect(requestPolicy(req({ origin: 'https://app.example', 'content-type': 'text/plain' }))?.status).toBe(415);
  expect(requestPolicy(req({ origin: 'https://app.example' }, null))).toBeNull();
});
test('forwarded IPs cannot select client identity by default', () => {
  expect(trustedClient(req({ 'x-forwarded-for': '192.0.2.1' }))).toBeNull();
  process.env.AUTH_TRUSTED_CLIENT_IP_HEADER = 'x-ingress-client';
  expect(trustedClient(req({ 'x-ingress-client': '192.0.2.1' }))).toBeNull();
  process.env.AUTH_TRUSTED_PROXY_SECRET = 'synthetic-ingress-secret-for-tests-only';
  expect(trustedClient(req({ 'x-ingress-client': '192.0.2.1', 'x-mailhub-proxy-token': 'wrong-proof' }))).toBeNull();
  expect(trustedClient(req({ 'x-ingress-client': '192.0.2.1', 'x-mailhub-proxy-token': process.env.AUTH_TRUSTED_PROXY_SECRET }))).toBe('192.0.2.1');
  expect(trustedClient(req({ 'x-ingress-client': '192.0.2.1, 192.0.2.2', 'x-mailhub-proxy-token': process.env.AUTH_TRUSTED_PROXY_SECRET }))).toBeNull();
});
test('new passwords count UTF-8 bytes while legacy login remains unchanged', () => {
  const fields = { email: 'synthetic@example.test', name: 'Synthetic', organizationName: 'Synthetic' };
  expect(registerSchema.safeParse({ ...fields, password: 'é'.repeat(36) }).success).toBe(true);
  expect(registerSchema.safeParse({ ...fields, password: 'é'.repeat(37) }).success).toBe(false);
  expect(changePasswordSchema.safeParse({ currentPassword: 'é'.repeat(50), newPassword: 'é'.repeat(37) }).success).toBe(false);
  expect(createUserSchema.safeParse({ ...fields, password: 'é'.repeat(37) }).success).toBe(false);
  expect(loginSchema.safeParse({ email: fields.email, password: 'é'.repeat(2049) }).success).toBe(false);
  expect(loginSchema.parse({ email: fields.email, password: 'é'.repeat(50) }).password).toBe('é'.repeat(50));
});

test.each(['POST', 'PUT', 'PATCH', 'DELETE'])('guards cookie-authenticated %s mutations', method => {
  const request = new NextRequest('https://app.example/api/settings', { method, headers: { cookie: 'auth-token=synthetic', origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  expect(requestPolicy(request)?.status).toBe(403);
});
test('preserves provider callback GET requests without Origin', () => {
  expect(requestPolicy(new NextRequest('https://app.example/api/accounts/oauth/google/callback?code=synthetic'))).toBeNull();
});
