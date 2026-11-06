import { NextRequest } from 'next/server';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { createSession, SessionError } from '@/lib/auth/sessions';
import { setSessionCookies } from '@/lib/auth/cookies';
import { loginSchema } from '@/lib/validation';
import { apiError, apiResponse } from '@/lib/auth/middleware';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          include: { organization: true },
          take: 1, // Default to first org
        },
      },
    });

    if (!user || user.disabledAt || !(await compare(password, user.passwordHash))) {
      return apiError('Invalid email or password', 401);
    }

    const membership = user.memberships[0];
    if (!membership) {
      return apiError('No organization found for this user', 403);
    }

    const payload = {
      userId: user.id,
      organizationId: membership.organizationId,
      role: membership.role as 'admin' | 'member',
    };

    const pair = await createSession(payload, user.passwordHash);

    const response = apiResponse({
      user: { id: user.id, email: user.email, name: user.name },
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
      },
      role: membership.role,
    });

    return setSessionCookies(response, pair);
  } catch (error) {
    if (error instanceof SessionError) return apiError('Please log in again', 401);
    console.error('Login error:', error);
    return apiError('Internal server error', 500);
  }
}
