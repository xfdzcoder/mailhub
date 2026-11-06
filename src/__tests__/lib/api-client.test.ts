import { refreshTokenClient, setupGlobalFetchInterceptor, resetFetchInterceptor } from '@/lib/api-client';

const response = (status: number, code?: string) => Response.json({ code }, { status });
let fetchMock: jest.Mock;
beforeEach(() => {
  resetFetchInterceptor();
  fetchMock = jest.fn();
  Object.assign(global, { window: { location: { origin: 'http://localhost', href: '', pathname: '/inbox', search: '' }, fetch: fetchMock } });
  global.fetch = fetchMock;
});
afterEach(() => { resetFetchInterceptor(); jest.restoreAllMocks(); });

it('shares one refresh operation among concurrent requests', async () => {
  fetchMock.mockResolvedValue(response(200));
  expect(await Promise.all([refreshTokenClient(), refreshTokenClient(), refreshTokenClient()])).toEqual([true, true, true]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('serializes refresh across tabs using Web Locks when available', async () => {
  const request = jest.fn(async (_name, callback) => callback());
  const original = Object.getOwnPropertyDescriptor(global, 'navigator');
  Object.defineProperty(global, 'navigator', { configurable: true, value: { locks: { request } } });
  try {
    fetchMock.mockResolvedValue(response(200));
    expect(await refreshTokenClient()).toBe(true);
    expect(request).toHaveBeenCalledWith('mailhub-session-refresh', expect.any(Function));
  } finally {
    if (original) Object.defineProperty(global, 'navigator', original);
    else Reflect.deleteProperty(global, 'navigator');
  }
});
it('refreshes only after an explicit expired response and retries only once', async () => {
  fetchMock.mockResolvedValueOnce(response(401, 'AUTH_EXPIRED')).mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(401, 'AUTH_EXPIRED'));
  setupGlobalFetchInterceptor();
  expect((await window.fetch('/api/emails')).status).toBe(401);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
it('also refreshes the current-user endpoint', async () => {
  fetchMock.mockResolvedValueOnce(response(401, 'AUTH_EXPIRED')).mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(200));
  setupGlobalFetchInterceptor();
  expect((await window.fetch('/api/auth/me')).status).toBe(200);
});
it.each([undefined, 'UNRELATED'])('does not refresh an ambiguous 401 (%s)', async code => {
  fetchMock.mockResolvedValue(response(401, code));
  setupGlobalFetchInterceptor();
  await window.fetch('/api/emails');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('redirects revoked sessions without trying refresh', async () => {
  fetchMock.mockResolvedValue(response(401, 'AUTH_REQUIRED'));
  setupGlobalFetchInterceptor();
  await window.fetch('/api/emails');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(window.location.href).toContain('/login?callbackUrl=');
});
it('retries one multi-tab conflict using shared cookies', async () => {
  fetchMock.mockResolvedValueOnce(response(409, 'REFRESH_CONFLICT')).mockResolvedValueOnce(response(200));
  expect(await refreshTokenClient()).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('stops after a second conflict without forcing login', async () => {
  fetchMock.mockResolvedValueOnce(response(401, 'AUTH_EXPIRED')).mockResolvedValue(response(409, 'REFRESH_CONFLICT'));
  setupGlobalFetchInterceptor();
  expect((await window.fetch('/api/emails')).status).toBe(401);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(window.location.href).toBe('');
});
it.each([503, 500])('leaves transient refresh failure %s recoverable', async status => {
  fetchMock.mockResolvedValueOnce(response(401, 'AUTH_EXPIRED')).mockResolvedValueOnce(response(status));
  setupGlobalFetchInterceptor();
  await window.fetch('/api/emails');
  expect(window.location.href).toBe('');
});
it('redirects after definitive refresh rejection', async () => {
  fetchMock.mockResolvedValueOnce(response(401, 'AUTH_EXPIRED')).mockResolvedValueOnce(response(401, 'AUTH_REQUIRED'));
  setupGlobalFetchInterceptor();
  await window.fetch('/api/emails');
  expect(window.location.href).toContain('/login?callbackUrl=');
});
it('retains a Request body for its one retry', async () => {
  const bodies: string[] = [];
  fetchMock.mockImplementation(async input => {
    if (input === '/api/auth/refresh') return response(200);
    bodies.push(await input.text());
    return bodies.length === 1 ? response(401, 'AUTH_EXPIRED') : response(200);
  });
  setupGlobalFetchInterceptor();
  await window.fetch(new Request('http://localhost/api/emails', { method: 'POST', body: 'synthetic-body' }));
  expect(bodies).toEqual(['synthetic-body', 'synthetic-body']);
});
