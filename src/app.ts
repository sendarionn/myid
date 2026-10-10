import path from 'node:path';
import express from 'express';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { errorHandler } from './http.ts';
import { authRouter } from './routes/auth.ts';
import { projectsRouter } from './routes/projects.ts';
import { csrfProtection, securityHeaders } from './security.ts';
import { sessionMiddleware } from './session.ts';

const ROOT = path.join(import.meta.dirname, '..');

export function createApp(config: Config, db: Db): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(securityHeaders(config));

  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));
  app.use(
    '/vendor/simplewebauthn',
    express.static(path.join(ROOT, 'node_modules', '@simplewebauthn', 'browser', 'esm')),
  );

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', express.json({ limit: '64kb', strict: true }));
  app.use('/api', sessionMiddleware(config, db));
  app.use('/api', csrfProtection(config));
  app.use('/api', authRouter(config, db));
  app.use('/api', projectsRouter(config, db));
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler);
  return app;
}
