import { protectAuthentication } from '@/lib/auth/attempts';
import { NextRequest, NextResponse } from 'next/server';
import { revokeSession } from '@/lib/auth/sessions';
import { clearSessionCookies } from '@/lib/auth/cookies';

async function handlePOST(req: NextRequest) {
  const access = req.cookies.get('auth-token')?.value || req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  await revokeSession(access, req.cookies.get('refresh-token')?.value);
  return clearSessionCookies(NextResponse.json({ success: true }));
}

export const POST = protectAuthentication('logout', handlePOST);
