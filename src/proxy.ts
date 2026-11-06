import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyRefreshToken } from '@/lib/auth/jwt';
import { verifySessionToken, authorizeSession } from '@/lib/auth/sessions';

// Protected routes (dashboard)
const protectedPaths = ['/inbox', '/labels', '/settings'];
// Auth routes
const authPaths = ['/login', '/register'];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // Check if path is protected or auth
  const isProtectedPath = protectedPaths.some(p => pathname.startsWith(p)) || pathname === '/';
  const isAuthPath = authPaths.some(p => pathname.startsWith(p));
  
  if (!isProtectedPath && !isAuthPath) {
    return NextResponse.next();
  }

  const token = request.cookies.get('auth-token')?.value;
  const refreshToken = request.cookies.get('refresh-token')?.value;

  // Try to verify access token first
  let isValid = false;
  if (token) {
    try {
      await verifySessionToken(token);
      isValid = true;
    } catch {
      isValid = false;
    }
  }

  // If access token expired, check refresh token
  if (!isValid && refreshToken) {
    try {
      // Page navigation may load the shell; APIs still require an access token
      // and the client must rotate explicitly before retrying an expired request.
      await authorizeSession(await verifyRefreshToken(refreshToken), refreshToken);
      isValid = true;
    } catch {
      isValid = false;
    }
  }

  // Handle protected paths
  if (isProtectedPath) {
    if (!isValid) {
      const url = new URL('/login', request.url);
      if (pathname !== '/') {
        url.searchParams.set('callbackUrl', encodeURI(pathname));
      }
      return NextResponse.redirect(url);
    } else if (pathname === '/') {
       return NextResponse.redirect(new URL('/inbox', request.url));
    }
  }

  // Handle auth paths (if already logged in, redirect to inbox)
  if (isAuthPath) {
    if (isValid) {
      return NextResponse.redirect(new URL('/inbox', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
