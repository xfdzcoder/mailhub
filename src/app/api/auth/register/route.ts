import { protectAuthentication } from '@/lib/auth/attempts';
import { NextRequest } from 'next/server';
import { hash } from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { registerSchema } from '@/lib/validation';
import { apiError, apiResponse } from '@/lib/auth/middleware';
import { createOrganizationSlug } from '@/lib/identifiers';

async function handlePOST(req: NextRequest) {
  if (process.env.REGISTRATION_MODE !== 'open') {
    return apiError('Self-registration is closed. Contact your instance administrator.', 403);
  }

  try {
    const body = await req.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { email, name, password, organizationName } = parsed.data;

    // Perform the same expensive work for claimed and available addresses.
    const passwordHash = await hash(password, 12);
    // Registration never confirms whether an address already exists.
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return apiResponse({ success: true }, 201);
    }

    // Create user, org, and membership in a transaction
    const slug = createOrganizationSlug(organizationName);

    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name, passwordHash },
      });

      const org = await tx.organization.create({
        data: { name: organizationName, slug },
      });

      await tx.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          role: 'admin',
        },
      });

      return { user, org };
    });

    return apiResponse({ success: true }, 201);
  } catch (error) {
    // Concurrent claims must have the same response as the existing-user path.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return apiResponse({ success: true }, 201);
    console.error('Registration error:', error);
    return apiError('Internal server error', 500);
  }
}

export const POST = protectAuthentication('register', handlePOST);
