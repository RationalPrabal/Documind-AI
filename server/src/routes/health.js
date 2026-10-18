import { Router } from 'express';
import { getDb } from '../db.js';
import { config } from '../config.js';

export const healthRouter = Router();

// Liveness + dependency check. Returns 503 if MongoDB is unreachable so a
// load balancer (or you, while debugging) can tell the app is not usable.
healthRouter.get('/', async (_req, res) => {
  try {
    await getDb().command({ ping: 1 });
    res.json({
      status: 'ok',
      db: 'connected',
      models: { chat: config.CHAT_MODEL, embedding: config.EMBEDDING_MODEL },
    });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'unreachable' });
  }
});
