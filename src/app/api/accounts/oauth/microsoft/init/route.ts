import { NextRequest, NextResponse } from 'next/server';
import { normalizeEmailAddress, isValidEmail } from '@/lib/email/addresses';
import { authenticate } from '@/lib/auth/middleware';
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

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'Microsoft Client ID not configured on server' }, { status: 500 });
  }

  if (!isValidEmail(normalizedEmailAddress) || label.length > 200) {
    return NextResponse.json({ error: 'Invalid mailbox or label' }, { status: 400 });
  }
  let transaction;
  try {
    transaction = await createOAuthTransaction('microsoft', auth, normalizedEmailAddress, label);
  } catch {
    return NextResponse.json({ error: 'OAuth authorization unavailable; restart authorization' }, { status: 503 });
  }
  const { state, challenge, redirectUri } = transaction;

  const oauthUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  oauthUrl.searchParams.set('client_id', clientId);
  oauthUrl.searchParams.set('redirect_uri', redirectUri);
  oauthUrl.searchParams.set('response_type', 'code');
  oauthUrl.searchParams.set('scope', [
    'openid',
    'profile',
    'email',
    'offline_access',
    'https://graph.microsoft.com/IMAP.AccessAsUser.All',
    'https://graph.microsoft.com/SMTP.Send',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/User.Read',
  ].join(' '));
  oauthUrl.searchParams.set('response_mode', 'query');
  oauthUrl.searchParams.set('prompt', 'consent'); // Force consent to get refresh token
  oauthUrl.searchParams.set('state', state);
  oauthUrl.searchParams.set('code_challenge', challenge);
  oauthUrl.searchParams.set('code_challenge_method', 'S256');
  
  // Optionally use login_hint if we know the user's email
  oauthUrl.searchParams.set('login_hint', normalizedEmailAddress);

  return NextResponse.redirect(oauthUrl.toString());
}
