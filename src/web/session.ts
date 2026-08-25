import type { Request, Response } from 'express';
import { parse, serialize } from 'cookie';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { createWebSession, deleteWebSession, getWebSession } from '../db/webSessions';

const SESSION_COOKIE = 'pr_session';
const CSRF_COOKIE = 'pr_csrf';

function sign(value: string): string {
  return createHmac('sha256', config.web.sessionSecret).update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function cookieOpts() {
  return {
    httpOnly: true,
    secure: config.web.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
  };
}

export async function establishSession(res: Response, employeeEmail: string): Promise<void> {
  const session = await createWebSession(employeeEmail);
  const signature = sign(session.id);
  res.setHeader('Set-Cookie', [
    serialize(SESSION_COOKIE, `${session.id}.${signature}`, { ...cookieOpts(), maxAge: 60 * 60 * 12 }),
    serialize(CSRF_COOKIE, randomBytes(24).toString('hex'), { ...cookieOpts(), httpOnly: false, maxAge: 60 * 60 * 12 }),
  ]);
}

export async function clearSession(req: Request, res: Response): Promise<void> {
  const sessionId = readSessionId(req);
  if (sessionId) await deleteWebSession(sessionId);
  res.setHeader('Set-Cookie', [
    serialize(SESSION_COOKIE, '', { ...cookieOpts(), maxAge: 0 }),
    serialize(CSRF_COOKIE, '', { ...cookieOpts(), httpOnly: false, maxAge: 0 }),
  ]);
}

function readSessionId(req: Request): string | null {
  const cookies = parse(req.headers.cookie ?? '');
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const [id, signature] = raw.split('.');
  if (!id || !signature || !safeEqual(sign(id), signature)) return null;
  return id;
}

/** Returns the authenticated email for the current request, or null if no valid session. */
export async function currentSessionEmail(req: Request): Promise<string | null> {
  const id = readSessionId(req);
  if (!id) return null;
  const session = await getWebSession(id);
  return session?.employee_email ?? null;
}

export function readCsrfCookie(req: Request): string | null {
  const cookies = parse(req.headers.cookie ?? '');
  return cookies[CSRF_COOKIE] ?? null;
}

/** Double-submit CSRF check: the header must match the (unguessable, JS-readable) cookie. */
export function verifyCsrf(req: Request): boolean {
  const header = req.headers['x-csrf-token'];
  const cookie = readCsrfCookie(req);
  if (!cookie || typeof header !== 'string') return false;
  return safeEqual(cookie, header);
}
