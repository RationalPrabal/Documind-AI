import { Router } from 'express';
import { config } from '../config.js';
import { getUsageToday } from '../services/budget.js';

export const metaRouter = Router();

// What the UI needs to validate input before sending it (the server still
// re-validates everything) and to show today's spend.
metaRouter.get('/', async (_req, res) => {
  res.json({
    limits: {
      maxUploadMb: config.MAX_UPLOAD_MB,
      maxPdfPages: config.MAX_PDF_PAGES,
      maxQuestionChars: config.MAX_QUESTION_CHARS,
      historyMessages: config.HISTORY_MAX_MESSAGES,
    },
    models: { chat: config.CHAT_MODEL, embedding: config.EMBEDDING_MODEL },
    usageToday: await getUsageToday(),
  });
});
