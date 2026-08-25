import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { resolveWebActor, AuthorizationError, requirePeopleAdmin, requirePrimaryApprover } from '../domain/authz';
import { currentSessionEmail, verifyCsrf } from './session';
import type { Actor } from '../types';

export interface AuthedRequest extends Request {
  actor?: Actor;
}

/** Attaches req.actor when a valid session maps to an active employee; does not itself deny. */
export async function attachActor(req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> {
  if (config.web.authDisabledInsecure) {
    // Dev-only escape hatch; never reachable in production (config.ts fails closed otherwise).
    const devEmail = req.header('x-dev-actor-email');
    req.actor = (await resolveWebActor(devEmail ?? config.people.primaryApproverEmail)) ?? undefined;
    next();
    return;
  }
  const email = await currentSessionEmail(req);
  req.actor = (await resolveWebActor(email)) ?? undefined;
  next();
}

export function requireConsoleSession(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.actor) {
    res.status(401).json({ error: 'not_authenticated' });
    return;
  }
  next();
}

export function requirePeopleAdminMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  try {
    requirePeopleAdmin(req.actor ?? null);
    next();
  } catch (error) {
    respondAuthzError(error, res);
  }
}

export function requirePrimaryApproverMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  try {
    requirePrimaryApprover(req.actor ?? null);
    next();
  } catch (error) {
    respondAuthzError(error, res);
  }
}

/** CSRF check for all mutating console API requests (double-submit cookie/header). */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  if (!verifyCsrf(req)) {
    res.status(403).json({ error: 'csrf_check_failed' });
    return;
  }
  next();
}

function respondAuthzError(error: unknown, res: Response): void {
  if (error instanceof AuthorizationError) {
    res.status(403).json({ error: error.code, message: error.message });
    return;
  }
  res.status(403).json({ error: 'forbidden' });
}
