import { createHash, randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config';

/**
 * Minimal "Sign in with Slack" (OpenID Connect) client, restricted to the configured Slack
 * workspace. Hand-rolled (no openid-client dependency) so the flow is small and auditable:
 * authorization redirect -> code exchange -> id_token verification against Slack's published
 * JWKS -> state/nonce/PKCE checks. See docs/SLACK_SETUP.md for the app-config steps this
 * depends on (redirect URI, `openid,email,profile` user scopes).
 */

const AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize';
const TOKEN_URL = 'https://slack.com/api/openid.connect.token';
const JWKS_URL = 'https://slack.com/openid/connect/keys';

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

export function randomToken(): string {
  return randomBytes(32).toString('hex');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(opts: { state: string; nonce: string; redirectUri: string; codeChallenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('client_id', config.slack.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('nonce', opts.nonce);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (config.slack.workspaceId) url.searchParams.set('team', config.slack.workspaceId);
  return url.toString();
}

export interface SlackIdClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  'https://slack.com/team_id'?: string;
  'https://slack.com/user_id'?: string;
}

export async function exchangeCodeForClaims(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  expectedNonce: string
): Promise<SlackIdClaims> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.slack.clientId,
      client_secret: config.slack.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) throw new Error(`Slack OIDC token exchange failed with status ${response.status}`);
  const data = (await response.json()) as { ok?: boolean; id_token?: string; error?: string };
  if (data.ok === false || !data.id_token) throw new Error(`Slack OIDC token exchange error: ${data.error ?? 'unknown'}`);

  const { payload } = await jwtVerify(data.id_token, jwks, { issuer: 'https://slack.com', audience: config.slack.clientId });
  if (payload.nonce !== expectedNonce) throw new Error('OIDC nonce mismatch.');
  if (config.slack.workspaceId && payload['https://slack.com/team_id'] !== config.slack.workspaceId) {
    throw new Error('Slack sign-in was completed in a different workspace.');
  }
  if (payload.email_verified === false) throw new Error('Slack account email is not verified.');
  return payload as unknown as SlackIdClaims;
}
