import { NextRequest, NextResponse } from 'next/server';

/** Exact deployment origins, never Host or forwarded-host derived. */
export function requestPolicy(req: NextRequest): NextResponse | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
  const cookies = req.cookies.has('auth-token') || req.cookies.has('refresh-token');
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  const bearer = /^Bearer .+$/i.test(req.headers.get('authorization') || '');
  const origins = (process.env.AUTH_TRUSTED_ORIGINS || process.env.NEXT_PUBLIC_APP_URL || '').split(',').map(v => v.trim()).filter(Boolean);
  // Non-browser clients must explicitly use bearer auth without ambient cookies.
  if (origin ? !origins.includes(origin) || origin === 'null' : cookies || !bearer || site !== null) {
    return NextResponse.json({ error: 'Untrusted request origin' }, { status: 403 });
  }
  if (site === 'cross-site' || site === 'same-site') {
    // same-site is not same-origin: sibling subdomains are not trusted implicitly.
    if (!origin || !origins.includes(origin)) return NextResponse.json({ error: 'Untrusted request origin' }, { status: 403 });
  }
  const type = req.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    // Empty action requests (including refresh/logout and DELETE) have no representation to validate.
    if (req.body !== null) return NextResponse.json({ error: 'Unsupported content type' }, { status: 415 });
  }
  return null;
}
