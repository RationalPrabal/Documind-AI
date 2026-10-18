// Maps every kind of failure to an HTTP status and a client-safe message.
// Details (stack traces, upstream error bodies) are logged, never returned.
import multer from 'multer';
import { APIError, APIConnectionTimeoutError, APIUserAbortError, RateLimitError } from 'openai';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { logger } from '../logger.js';

export function toClientError(err) {
  if (err instanceof HttpError) return { status: err.status, message: err.message };

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return { status: 413, message: `File too large. The limit is ${config.MAX_UPLOAD_MB} MB.` };
    return { status: 400, message: 'Invalid upload. Send exactly one PDF in the "file" field.' };
  }

  // OpenAI SDK errors (already retried by the SDK before reaching here).
  if (err instanceof APIUserAbortError) return { status: 499, message: 'Request cancelled.' };
  // OpenAI uses 429 for two very different things. "insufficient_quota" means
  // the account is out of credits: retrying won't help, an operator must act.
  if (err instanceof RateLimitError && err.type === 'insufficient_quota') {
    return { status: 503, message: 'The AI service is currently unavailable. Please try again later.' };
  }
  if (err instanceof RateLimitError) return { status: 429, message: 'The AI service is busy. Please try again in a moment.' };
  if (err instanceof APIConnectionTimeoutError) return { status: 504, message: 'The AI service timed out. Please try again.' };
  if (err instanceof APIError) return { status: 502, message: 'The AI service returned an error. Please try again.' };

  // body-parser / http-errors mark client errors that are safe to show.
  if (err.expose && err.status < 500) return { status: err.status, message: err.message };

  return { status: 500, message: 'Internal server error.' };
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const { status, message } = toClientError(err);

  // For upstream errors, keep OpenAI's code/type: it's what you need to debug.
  const upstream = err instanceof APIError ? { upstreamStatus: err.status, code: err.code, type: err.type } : {};

  const log = req.log ?? logger; // never let the error handler itself throw
  if (status >= 500) log.error({ err, ...upstream }, 'Request failed');
  else log.warn({ status, err: { name: err.name, message: err.message }, ...upstream }, 'Request rejected');

  if (res.headersSent) return res.end(); // e.g. mid-stream; nothing more to send
  res.status(status).json({ error: message });
}
