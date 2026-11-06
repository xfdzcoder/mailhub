import { protectAuthentication } from '@/lib/auth/attempts';
import { NextRequest } from 'next/server';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { createSession, SessionError } from '@/lib/auth/sessions';
import { setSessionCookies } from '@/lib/auth/cookies';
import { loginSchema } from '@/lib/validation';
import { apiError, apiResponse } from '@/lib/auth/middleware';

async function handlePOST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return apiError('Invalid email or password', 401);
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

    const valid = await compare(password, user?.passwordHash || '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW');
    if (!user || user.disabledAt || !valid) {
      return apiError('Invalid email or password', 401);
    }

    const membership = user.memberships[0];
    if (!membership) {
      return apiError('Invalid email or password', 401);
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

export const POST = protectAuthentication('login', handlePOST);
