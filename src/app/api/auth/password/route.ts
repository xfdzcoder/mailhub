import { protectSensitive } from '@/lib/auth/attempts';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { authenticate, apiResponse, apiError } from '@/lib/auth/middleware';
import { changePasswordSchema } from '@/lib/validation';
import { compare, hash } from 'bcryptjs';
import { changeUserPassword } from '@/lib/auth/sessions';
import { clearSessionCookies } from '@/lib/auth/cookies';

async function handlePUT(req: NextRequest) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  try {
    const body = await req.json();
    const parsed = changePasswordSchema.safeParse(body);

    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { currentPassword, newPassword } = parsed.data;

    // Fetch user with their current password hash
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
    });

    if (!user) {
      return apiError('Invalid email or password', 401);
    }

    // Verify current password
    const isPasswordValid = await compare(currentPassword, user.passwordHash);
    if (!isPasswordValid) {
      return apiError('Invalid email or password', 401);
    }

    // Hash and save new password
    const newPasswordHash = await hash(newPassword, 12);
    
    await changeUserPassword(user.id, user.passwordHash, newPasswordHash);
    return clearSessionCookies(apiResponse({ success: true }));
  } catch (error) {
    console.error('Password change error:', error);
    return apiError('Failed to change password', 500);
  }
}

export const PUT = protectSensitive('password', handlePUT);
