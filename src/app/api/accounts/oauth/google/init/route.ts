import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/auth/middleware';
import { normalizeEmailAddress, isValidEmail } from '@/lib/email/addresses';
import { createOAuthTransaction } from '@/lib/oauth/transactions';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const emailAddress = url.searchParams.get('emailAddress');
  const label = url.searchParams.get('label');

  if (!emailAddress || !label) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const normalizedEmailAddress = normalizeEmailAddress(emailAddress);

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'Google Client ID not configured on server' }, { status: 500 });
  }

  if (!isValidEmail(normalizedEmailAddress) || label.length > 200) {
    return NextResponse.json({ error: 'Invalid mailbox or label' }, { status: 400 });
  }
  let transaction;
  try {
    transaction = await createOAuthTransaction('google', auth, normalizedEmailAddress, label);
  } catch {
    return NextResponse.json({ error: 'OAuth authorization unavailable; restart authorization' }, { status: 503 });
  }
  const { state, challenge, redirectUri } = transaction;

  const oauthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  oauthUrl.searchParams.set('client_id', clientId);
  oauthUrl.searchParams.set('redirect_uri', redirectUri);
  oauthUrl.searchParams.set('response_type', 'code');
  oauthUrl.searchParams.set('scope', [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://mail.google.com/' // Full access needed for IMAP syncing
  ].join(' '));
  oauthUrl.searchParams.set('access_type', 'offline');
  oauthUrl.searchParams.set('prompt', 'consent'); // Force consent to get refresh token
  oauthUrl.searchParams.set('state', state);
  oauthUrl.searchParams.set('code_challenge', challenge);
  oauthUrl.searchParams.set('code_challenge_method', 'S256');
  
  // Optionally use login_hint if we know the user's email
  oauthUrl.searchParams.set('login_hint', normalizedEmailAddress);

  return NextResponse.redirect(oauthUrl.toString());
}
