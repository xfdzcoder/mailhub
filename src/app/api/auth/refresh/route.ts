import { NextRequest, NextResponse } from 'next/server';
import { rotateSession, SessionError } from '@/lib/auth/sessions';
import { setSessionCookies } from '@/lib/auth/cookies';

export async function POST(req: NextRequest) {
  const token = req.cookies.get('refresh-token')?.value;
  if (!token) return NextResponse.json({ error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    const pair = await rotateSession(token);
    return setSessionCookies(NextResponse.json({ success: true }), pair);
  } catch (error) {
    if (error instanceof SessionError) {
      const conflict = error.code === 'REFRESH_CONFLICT';
      return NextResponse.json({ error: conflict ? 'Refresh already completed in another tab; retry with current cookies' : 'Login required', code: error.code }, {
        status: conflict ? 409 : 401, headers: { 'Cache-Control': 'no-store' },
      });
    }
    return NextResponse.json({ error: 'Refresh temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
