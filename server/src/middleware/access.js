// Optional access code for public deployments.
//
// When ACCESS_CODE is set, document and question routes require a cookie that
// proves the visitor entered the code. The cookie holds an HMAC of the code
// (keyed by SESSION_SECRET), never the code itself, so:
//   - it can't be forged without knowing both secrets;
//   - changing ACCESS_CODE instantly invalidates every existing cookie.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

export const ACCESS_COOKIE = 'documind_access';

export const accessRequired = () => config.ACCESS_CODE.length > 0;

export const accessToken = () =>
  createHmac('sha256', config.SESSION_SECRET).update(`access:${config.ACCESS_CODE}`).digest('hex');

export const hasAccess = (req) => !accessRequired() || req.cookies?.[ACCESS_COOKIE] === accessToken();

// Constant-time comparison: how long the check takes reveals nothing about
// how many characters were right. Hashing first makes the lengths equal.
export function isCorrectCode(candidate) {
  const sha = (v) => createHash('sha256').update(String(v)).digest();
  return accessRequired() && timingSafeEqual(sha(candidate), sha(config.ACCESS_CODE));
}

export function requireAccess(req, _res, next) {
  if (hasAccess(req)) return next();
  throw new HttpError(401, 'Enter the access code to use this demo.');
}
