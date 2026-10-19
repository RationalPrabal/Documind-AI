// Builds the Express app without starting it, so tests can import it
// and send requests without opening a real port.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { owner } from './middleware/owner.js';
import { errorHandler } from './middleware/errors.js';
import { healthRouter } from './routes/health.js';
import { documentsRouter } from './routes/documents.js';
import { askRouter } from './routes/ask.js';
import { metaRouter } from './routes/meta.js';
import { apiLimiter } from './middleware/rateLimits.js';
import { requireAccess } from './middleware/access.js';
import { accessRouter } from './routes/access.js';

// The React production build (client/dist). In production Express serves it,
// so the UI and the API share one origin: no CORS, and cookies just work.
// In development Vite serves the UI instead and this folder may not exist.
const CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind reverse proxies (Render, nginx), trust exactly that many hops of
  // X-Forwarded-For so req.ip is the real client. Never "true": that lets
  // any client spoof its IP and dodge rate limits.
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);
  // Logging first: every later middleware (including body parsing, whose
  // errors reach the error handler) can rely on req.log existing.
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      // Log what is useful for debugging, not every header.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      // Client IP as Express sees it (respects TRUST_PROXY). Useful to verify
      // the proxy setting after deploying: it should be YOUR public IP.
      customProps: (req) => ({ ip: req.ip }),
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser(config.SESSION_SECRET));

  app.use('/api/health', healthRouter);
  app.use('/api', apiLimiter);
  app.use('/api/meta', metaRouter);
  app.use('/api/access', accessRouter);
  app.use('/api/documents/:id/ask', requireAccess, owner, askRouter);
  app.use('/api/documents', requireAccess, owner, documentsRouter);

  if (config.NODE_ENV === 'production' && existsSync(`${CLIENT_DIST}/index.html`)) {
    app.use(
      express.static(CLIENT_DIST, {
        // Vite puts a content hash in every asset filename, so they can be
        // cached "forever"; index.html is not hashed, so always revalidate it.
        setHeaders: (res, path) =>
          res.setHeader('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
      }),
    );
  }

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}
