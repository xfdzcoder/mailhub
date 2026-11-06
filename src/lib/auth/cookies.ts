import type { NextResponse } from 'next/server';

const options = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
export function setSessionCookies(response: NextResponse, pair: { token: string; refreshToken: string; expiresAt: Date; accessExpiresAt: Date }) {
  response.headers.set('Cache-Control', 'no-store');
  response.cookies.set('auth-token', pair.token, { ...options, expires: pair.accessExpiresAt });
  response.cookies.set('refresh-token', pair.refreshToken, { ...options, expires: pair.expiresAt });
  return response;
}
export function clearSessionCookies(response: NextResponse) {
  response.headers.set('Cache-Control', 'no-store');
  for (const name of ['auth-token', 'refresh-token']) response.cookies.set(name, '', { ...options, maxAge: 0 });
  return response;
}
