import { NextRequest, NextResponse } from 'next/server';
import { requestPolicy } from './request-policy';
import { verifyToken } from './jwt';
import { authorizeSession, SessionError } from './sessions';
import type { SessionClaims } from './jwt';
import type { JWTPayload } from './types';

export async function authenticate(
  req: NextRequest
): Promise<SessionClaims | NextResponse> {
  const denied = requestPolicy(req);
  if (denied) return denied;
  const token = req.cookies.get('auth-token')?.value ||
    req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (token) {
    let claims;
    try { claims = await verifyToken(token); } catch {
      return NextResponse.json({ error: 'Access credential expired or invalid', code: 'AUTH_EXPIRED' }, { status: 401 });
    }
    try { return await authorizeSession(claims); } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      return NextResponse.json({ error: 'Session is no longer active', code: 'AUTH_REQUIRED' }, { status: 401 });
    }
  }
  return NextResponse.json({ error: 'Access credential required', code: 'AUTH_EXPIRED' }, { status: 401 });
}

export function requireAdmin(auth: JWTPayload): NextResponse | null {
  if (auth.role !== 'admin') {
    return NextResponse.json(
      { error: 'Admin access required' },
      { status: 403 }
    );
  }
  return null;
}

export function apiResponse<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function apiError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
