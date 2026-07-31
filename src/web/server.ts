import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { bootState, describeDbError } from '../bootState.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { requireAdmin } from './auth.js';
import { legalRouter } from './legal.js';
import { apiRouter } from './routes/api.js';
import { oauthRouter } from './routes/oauth.js';
import { webhooksRouter } from './routes/webhooks.js';

const log = createLogger('web');

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway terminates TLS in front of us

  // Mounted before the JSON parser: the WebSub handler needs the raw body to
  // verify its HMAC signature.
  app.use('/webhooks', webhooksRouter);

  // Reports 200 even while the database is still failing, so the deploy goes
  // live and the admin UI can show the actual reason. `db` carries the real
  // state for anyone checking properly.
  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      db: bootState.dbReady ? 'ready' : 'error',
      dbError: describeDbError(),
      dbAttempts: bootState.dbAttempts,
    });
  });

  // Public on purpose: platform reviewers must be able to open these without
  // credentials, so they are mounted ahead of the admin auth middleware.
  app.use(legalRouter);

  app.use(express.json({ limit: '6mb' }));
  app.use('/oauth', oauthRouter);
  app.use('/api', requireAdmin, apiRouter);

  const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
  app.use('/admin', requireAdmin, express.static(publicDir, { index: 'index.html' }));

  app.get('/', (_req, res) => res.redirect('/admin/'));

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));

  return app;
}

export function startServer() {
  const app = createServer();
  const server = app.listen(config.PORT, () => {
    log.info(`listening on :${config.PORT} (public: ${config.PUBLIC_URL})`);
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    // Without this the raw 'error' event takes the process down with a stack
    // trace instead of something an operator can act on.
    if (e.code === 'EADDRINUSE') log.error(`ポート ${config.PORT} は既に使用されています`);
    else log.error(`サーバーエラー: ${e.message}`);
    process.exit(1);
  });
  return server;
}
