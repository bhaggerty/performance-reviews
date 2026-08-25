import { Router } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { buildAuthorizeUrl, exchangeCodeForClaims, pkcePair, randomToken } from './slackOidc';
import { stashOAuthState, readAndClearOAuthState } from './oauthState';
import { establishSession, clearSession } from './session';
import { resolveWebActor } from '../domain/authz';
import { logAudit } from '../db/audit';
import type { AuthedRequest } from './authMiddleware';

const router = Router();

function redirectUri(req: { protocol: string; get: (name: string) => string | undefined }): string {
  const base = config.app.url || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/auth/slack/callback`;
}

router.get('/auth/slack/login', (req, res) => {
  if (!config.web.authConfigured) {
    res.status(503).send('Web console authentication is not configured.');
    return;
  }
  const state = randomToken();
  const nonce = randomToken();
  const { verifier, challenge } = pkcePair();
  stashOAuthState(res, { state, nonce, verifier });
  res.redirect(buildAuthorizeUrl({ state, nonce, redirectUri: redirectUri(req), codeChallenge: challenge }));
});

router.get('/auth/slack/callback', async (req, res) => {
  try {
    const stashed = readAndClearOAuthState(req, res);
    const { code, state } = req.query as { code?: string; state?: string };
    if (!stashed || !code || !state || state !== stashed.state) {
      res.status(400).send('Invalid or expired sign-in attempt. Please try again.');
      return;
    }
    const claims = await exchangeCodeForClaims(code, redirectUri(req), stashed.verifier, stashed.nonce);
    if (!claims.email) {
      res.status(403).send('Your Slack account has no verified email address.');
      return;
    }
    const actor = await resolveWebActor(claims.email);
    if (!actor || !actor.roles.isPeopleAdmin) {
      res.status(403).send('This Slack account is not authorized for the People console.');
      return;
    }
    await establishSession(res, actor.employee.email);
    await logAudit({ entity_type: 'web_session', entity_id: actor.employee.id, action: 'login', actor_id: actor.employee.id });
    res.redirect('/console/');
  } catch (error) {
    logger.error('Slack OIDC callback failed', { error: error instanceof Error ? error.message : 'unknown' });
    res.status(401).send('Sign-in failed. Please try again.');
  }
});

router.post('/auth/logout', async (req: AuthedRequest, res) => {
  if (req.actor) {
    await logAudit({ entity_type: 'web_session', entity_id: req.actor.employee.id, action: 'logout', actor_id: req.actor.employee.id });
  }
  await clearSession(req, res);
  res.json({ ok: true });
});

router.get('/api/console/me', (req: AuthedRequest, res) => {
  if (!req.actor) {
    res.status(401).json({ error: 'not_authenticated' });
    return;
  }
  res.json({
    employee: { id: req.actor.employee.id, name: req.actor.employee.name, email: req.actor.employee.email },
    roles: req.actor.roles,
  });
});

export default router;
