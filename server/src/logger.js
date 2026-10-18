import pino from 'pino';
import { config } from './config.js';

// Structured JSON logs in production; human-readable logs in development.
// `redact` makes sure secrets never end up in log output.
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.OPENAI_API_KEY'],
  ...(config.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  }),
});
