import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { Prisma } from '@prisma/client';
import {
  authenticate,
  requireAdmin,
  apiResponse,
  apiError,
} from '@/lib/auth/middleware';
import { updateMemberRoleSchema } from '@/lib/validation';

interface RouteParams {
  params: Promise<{ userId: string }>;
}

export async function PUT(req: NextRequest, { params }: RouteParams) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  const { userId } = await params;

  const body = await req.json();
  const parsed = updateMemberRoleSchema.safeParse(body);
  if (!parsed.success) return apiError(parsed.error.issues[0].message, 422);

  // Prevent self-demotion
  if (userId === auth.userId && parsed.data.role !== 'admin') {
    return apiError('Cannot change your own role', 400);
  }

  try {
    await prisma.organizationMember.update({
      where: {
        organizationId_userId: {
          organizationId: auth.organizationId,
          userId,
        },
      },
      data: { role: parsed.data.role },
    });
    return apiResponse({ success: true });
  } catch {
    return apiError('Member not found', 404);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const adminCheck = requireAdmin(auth);
  if (adminCheck) return adminCheck;

  const { userId } = await params;

  // Prevent self-removal
  if (userId === auth.userId) {
    return apiError('Cannot remove yourself from the organization', 400);
  }

  try {
    await prisma.$transaction(async tx => {
      // Serialize with login/refresh so removal cannot miss a new session.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      await tx.organizationMember.delete({
        where: { organizationId_userId: { organizationId: auth.organizationId, userId } },
      });
      await tx.authSession.updateMany({
        where: { organizationId: auth.organizationId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    return apiResponse({ success: true });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return apiError('Member not found', 404);
    }
    return apiError('Failed to remove member', 500);
  }
}
