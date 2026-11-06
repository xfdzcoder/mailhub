jest.mock('@/lib/auth/middleware', () => ({ authenticate: jest.fn() }));
jest.mock('@/lib/notifications/push', () => ({ approvePushDestination: jest.fn(), consumePushBudget: jest.fn(), PUSH_DEVICE_LIMIT: 10, PushBudgetError: class extends Error {}, PushValidationError: class extends Error {} }));
jest.mock('@/lib/db/prisma', () => ({ prisma: { $transaction: jest.fn(), pushSubscription: { deleteMany: jest.fn() } } }));
import { NextResponse, type NextRequest } from 'next/server';
import { POST, DELETE } from '@/app/api/notifications/subscribe/route';
import { authenticate } from '@/lib/auth/middleware';
import { prisma } from '@/lib/db/prisma';

const tx = { $executeRaw: jest.fn(), pushSubscription: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), create: jest.fn() } };
const request = () => new Request('https://app.example/api/notifications/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/sub', keys: { p256dh: 'key', auth: 'auth' } } }) }) as NextRequest;
beforeEach(() => {
  jest.clearAllMocks();
  (authenticate as jest.Mock).mockResolvedValue({ userId: 'user', organizationId: 'org' });
  (prisma.$transaction as jest.Mock).mockImplementation(fn => fn(tx));
  tx.pushSubscription.findUnique.mockResolvedValue(null);
  tx.pushSubscription.count.mockResolvedValue(0);
});
it('binds new devices to the current session owner', async () => {
  expect((await POST(request())).status).toBe(200);
  expect(tx.pushSubscription.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user', organizationId: 'org' }) });
});
it.each([{ userId: 'other', organizationId: 'org' }, { userId: 'user', organizationId: 'other' }, { userId: null, organizationId: 'org' }])('rejects ownership collision %j', async owner => {
  tx.pushSubscription.findUnique.mockResolvedValue({ id: 'sub', ...owner });
  expect((await POST(request())).status).toBe(409);
  expect(tx.pushSubscription.update).not.toHaveBeenCalled();
});
it('updates keys without changing ownership', async () => {
  tx.pushSubscription.findUnique.mockResolvedValue({ id: 'sub', userId: 'user', organizationId: 'org' });
  expect((await POST(request())).status).toBe(200);
  expect(tx.pushSubscription.update).toHaveBeenCalledWith({ where: { id: 'sub' }, data: { p256dh: 'key', auth: 'auth' } });
});
it('enforces device quota', async () => {
  tx.pushSubscription.count.mockResolvedValue(10);
  expect((await POST(request())).status).toBe(429);
});
it('stops when session authorization rejects the caller', async () => {
  (authenticate as jest.Mock).mockResolvedValue(NextResponse.json({}, { status: 401 }));
  expect((await POST(request())).status).toBe(401);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('releases devices only with prior owner session authorization', async () => {
  const req = new Request('https://app.example/api/notifications/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/sub' }) }) as NextRequest;
  expect((await DELETE(req)).status).toBe(200);
  expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { endpoint: 'https://fcm.googleapis.com/sub', userId: 'user', organizationId: 'org' } });
});
