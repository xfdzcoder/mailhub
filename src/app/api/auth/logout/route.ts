import { NextRequest, NextResponse } from 'next/server';
import { revokeSession } from '@/lib/auth/sessions';
import { clearSessionCookies } from '@/lib/auth/cookies';

export async function POST(req: NextRequest) {
  const access = req.cookies.get('auth-token')?.value || req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  await revokeSession(access, req.cookies.get('refresh-token')?.value);
  return clearSessionCookies(NextResponse.json({ success: true }));
}
