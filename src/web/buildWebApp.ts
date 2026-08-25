import express, { type Application } from 'express';
import path from 'path';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { attachActor } from './authMiddleware';
import authRoutes from './authRoutes';
import consoleApi from '../api/console';
import { buildAutomationRouter } from '../api/automation';
import healthRouter from './health';

const WEB_DIST = path.join(__dirname, '..', '..', 'web', 'dist');

/**
 * Builds the console/health/API surface. In HTTP Slack mode this is mounted onto the same
 * Express app the Slack ExpressReceiver already listens on; in Socket Mode it is its own
 * standalone server (Slack has no inbound HTTP surface in that mode). Either way this is the
 * only place the web console, its API, health checks, and the optional automation API exist.
 */
export function mountWebApp(app: Application): void {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  app.use(healthRouter);

  app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

  app.use(attachActor);
  app.use(authRoutes);
  app.use('/api/console', consoleApi);
  app.use('/automation', buildAutomationRouter());

  app.use('/console', express.static(WEB_DIST));
  // Express 5 / path-to-regexp 8 requires named wildcards (`*splat`) instead of a bare `*`.
  app.get('/console/*splat', (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
  app.get('/', (_req, res) => res.redirect('/console/'));
}
