import type { Request, Response } from 'express';
import { parse, serialize } from 'cookie';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

const COOKIE = 'pr_oidc';

export interface OAuthState {
  state: string;
  nonce: string;
  verifier: string;
}

function sign(value: string): string {
  return createHmac('sha256', config.web.sessionSecret).update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Short-lived, signed cookie holding the OIDC state/nonce/PKCE verifier between the
 * authorize redirect and the callback — avoids a server-side store for a ~60s window. */
export function stashOAuthState(res: Response, value: OAuthState): void {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = sign(payload);
  res.setHeader(
    'Set-Cookie',
    serialize(COOKIE, `${payload}.${signature}`, {
      httpOnly: true,
      secure: config.web.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 300,
    })
  );
}

export function readAndClearOAuthState(req: Request, res: Response): OAuthState | null {
  const cookies = parse(req.headers.cookie ?? '');
  const raw = cookies[COOKIE];
  res.setHeader('Set-Cookie', serialize(COOKIE, '', { path: '/', maxAge: 0 }));
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as OAuthState;
  } catch {
    return null;
  }
}
