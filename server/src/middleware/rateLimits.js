// Per-IP rate limits. Keyed by IP rather than ownerId on purpose: an owner
// id is free to mint (just drop the cookie), an IP is not.
//
// The default store is in memory, which is right for one server process.
// With several instances you'd plug in a shared store (e.g. Redis) so the
// limits apply across all of them.
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

const limiter = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8', // RateLimit + RateLimit-Policy headers
    legacyHeaders: false,
    handler: (req, res) => {
      req.log.warn({ ip: req.ip, url: req.originalUrl }, 'Rate limit exceeded');
      res.status(429).json({ error: message });
    },
  });

// Broad safety net for every API call.
export const apiLimiter = limiter(15 * 60_000, 600, 'Too many requests. Please slow down.');

// The expensive endpoints get tighter, separate budgets.
export const uploadLimiter = limiter(
  60 * 60_000,
  config.UPLOADS_PER_HOUR,
  `Upload limit reached (${config.UPLOADS_PER_HOUR} per hour). Please try again later.`,
);
export const askLimiter = limiter(
  10 * 60_000,
  config.QUESTIONS_PER_10_MIN,
  `Question limit reached (${config.QUESTIONS_PER_10_MIN} per 10 minutes). Please wait a few minutes.`,
);
