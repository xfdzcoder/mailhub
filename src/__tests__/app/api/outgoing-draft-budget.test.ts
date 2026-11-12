jest.mock('@/lib/auth/middleware', () => ({
  authenticate: jest.fn(async () => ({ organizationId: 'org', userId: 'user', role: 'admin' })),
  apiResponse: (data: unknown) => Response.json(data),
  apiError: (error: string, status: number) => Response.json({ error }, { status }),
}));
jest.mock('@/lib/db/prisma', () => ({ prisma: {
  emailAccount: { findFirst: jest.fn(async () => ({ id: 'account', emailAddress: 'sender@example.test' })) },
  email: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  attachment: { findMany: jest.fn(), deleteMany: jest.fn(), create: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
} }));
jest.mock('uuid', () => ({ v4: () => 'synthetic-message' }));
jest.mock('fs/promises', () => ({ mkdir: jest.fn(), writeFile: jest.fn(), unlink: jest.fn() }));
import { PUT } from '@/app/api/accounts/[id]/drafts/route';
import { prisma } from '@/lib/db/prisma';
import { writeFile, unlink } from 'fs/promises';
import { NextRequest } from 'next/server';
import path from 'path';
const request = (body: unknown) => new Request('http://localhost/api/accounts/account/drafts', { method: 'PUT', body: JSON.stringify(body) }) as NextRequest;
const params = { params: Promise.resolve({ id: 'account' }) };
const att = { filename: 'x', contentType: 'text/plain', content: 'YWJj', sizeBytes: 999999999, id: '../../unsafe' };
beforeEach(() => {
  jest.clearAllMocks();
  (prisma.$transaction as jest.Mock).mockImplementation(async callback => callback(prisma));
  (prisma.email.findFirst as jest.Mock).mockResolvedValue({ id: 'draft' });
  (prisma.email.create as jest.Mock).mockResolvedValue({ id: 'draft' });
  (prisma.attachment.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.attachment.count as jest.Mock).mockResolvedValue(0);
  (writeFile as jest.Mock).mockResolvedValue(undefined);
  (unlink as jest.Mock).mockResolvedValue(undefined);
});
test('validates the entire collection before staging or database mutation', async () => {
  const response = await PUT(request({ attachments: [att, { ...att, content: 'Zh==' }] }), params);
  expect(response.status).toBe(422);
  expect(writeFile).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
test('publishes actual sizes and server-generated file IDs', async () => {
  const response = await PUT(request({ attachments: [att] }), params);
  expect(response.status).toBe(200);
  const file = (prisma.attachment.create as jest.Mock).mock.calls[0][0].data;
  expect(file.sizeBytes).toBe(3);
  expect(file.id).not.toBe(att.id);
  expect(path.dirname(file.storagePath)).toBe(path.join(process.cwd(), '.storage', 'attachments'));
});
test('cleans staged files on transaction failure', async () => {
  (prisma.$transaction as jest.Mock).mockRejectedValueOnce(new Error('database write failed'));
  const response = await PUT(request({ attachments: [att] }), params);
  expect(response.status).toBe(500);
  expect(unlink).toHaveBeenCalledWith((writeFile as jest.Mock).mock.calls[0][0]);
});
test('omitted attachments preserve existing attachments, explicit empty list clears them', async () => {
  await PUT(request({ draftId: 'draft', subject: 'edit' }), params);
  expect(prisma.attachment.deleteMany).not.toHaveBeenCalled();
  expect((prisma.email.update as jest.Mock).mock.calls[0][0].data).not.toHaveProperty('hasAttachments');
  await PUT(request({ draftId: 'draft', attachments: [] }), params);
  expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({ where: { emailId: 'draft' } });
  expect((prisma.email.update as jest.Mock).mock.calls[1][0].data.hasAttachments).toBe(false);
});
test('replaced files are removed only after commit and only if unreferenced', async () => {
  const storagePath = path.join(process.cwd(), '.storage', 'attachments', 'old');
  (prisma.attachment.findMany as jest.Mock).mockResolvedValue([{ storagePath }]);
  await PUT(request({ draftId: 'draft', attachments: [] }), params);
  expect(unlink).toHaveBeenCalledWith(storagePath);
  (unlink as jest.Mock).mockClear();
  (prisma.attachment.count as jest.Mock).mockResolvedValue(1);
  await PUT(request({ draftId: 'draft', attachments: [] }), params);
  expect(unlink).not.toHaveBeenCalled();
});
