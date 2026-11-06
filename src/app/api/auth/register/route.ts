import { NextRequest } from 'next/server';
import { hash } from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { createSession, SessionError } from '@/lib/auth/sessions';
import { setSessionCookies } from '@/lib/auth/cookies';
import { registerSchema } from '@/lib/validation';
import { apiError, apiResponse } from '@/lib/auth/middleware';
import { createOrganizationSlug } from '@/lib/identifiers';

export async function POST(req: NextRequest) {
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

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return apiError('Email already registered', 409);
    }

    // Create user, org, and membership in a transaction
    const passwordHash = await hash(password, 12);
    const slug = createOrganizationSlug(organizationName);

    const result = await prisma.$transaction(async (tx) => {
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

    const payload = {
      userId: result.user.id,
      organizationId: result.org.id,
      role: 'admin' as const,
    };

    const pair = await createSession(payload, result.user.passwordHash);

    const response = apiResponse(
      {
        user: { id: result.user.id, email, name },
        organization: { id: result.org.id, name: organizationName, slug },
      },
      201
    );

    return setSessionCookies(response, pair);
  } catch (error) {
    if (error instanceof SessionError) return apiError('Please log in again', 401);
    console.error('Registration error:', error);
    return apiError('Internal server error', 500);
  }
}
