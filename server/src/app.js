// Builds the Express app without starting it, so tests can import it
// and send requests without opening a real port.
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

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind a reverse proxy, trust ONE hop of X-Forwarded-For so req.ip (and
  // therefore rate limiting) sees the real client. Never trust it blindly.
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
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
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser(config.SESSION_SECRET));

  app.use('/api/health', healthRouter);
  app.use('/api', apiLimiter);
  app.use('/api/meta', metaRouter);
  app.use('/api/documents/:id/ask', owner, askRouter);
  app.use('/api/documents', owner, documentsRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}
