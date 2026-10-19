import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { ACCESS_COOKIE, accessRequired, accessToken, isCorrectCode } from '../middleware/access.js';

export const accessRouter = Router();

// Slow down guessing: 10 attempts per 15 minutes per IP.
const attemptLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' }),
});

accessRouter.post('/', attemptLimiter, (req, res) => {
  if (!accessRequired()) return res.json({ granted: true });
  if (!isCorrectCode(req.body?.code ?? '')) throw new HttpError(401, 'Wrong access code.');

  res.cookie(ACCESS_COOKIE, accessToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ granted: true });
});
