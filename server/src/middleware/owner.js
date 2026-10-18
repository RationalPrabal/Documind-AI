// Gives every browser a stable, unforgeable identity without a login screen.
//
// The id is a random UUID stored in a *signed* cookie: the server appends an
// HMAC (keyed by SESSION_SECRET), so a client that edits the value fails
// verification and simply gets a new, empty identity. Every database query
// is then scoped by `req.ownerId`.
//
// To add real auth later, set req.ownerId from the verified JWT/session user
// instead. Nothing else in the app has to change.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const COOKIE_NAME = 'documind_owner';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function owner(req, res, next) {
  let id = req.signedCookies?.[COOKIE_NAME]; // `false` if the signature is invalid

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    id = randomUUID();
    res.cookie(COOKIE_NAME, id, {
      signed: true,
      httpOnly: true, // not readable from JavaScript → not stealable via XSS
      sameSite: 'lax', // not sent on cross-site POSTs → basic CSRF protection
      secure: config.NODE_ENV === 'production',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }

  req.ownerId = id;
  next();
}
