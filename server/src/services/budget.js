// Daily token budget: a global kill-switch on spend.
//
// One document per UTC day in the `usage` collection, updated with atomic
// $inc. The check happens before a paid call and the usage is recorded
// after it, so the cap is "soft": concurrent requests can overshoot it by a
// few calls. That's acceptable for a safety fuse; a hard cap would need a
// reservation step before each call.
import { config } from '../config.js';
import { getDb } from '../db.js';
import { HttpError } from '../errors.js';

const usage = () => getDb().collection('usage');
const today = () => new Date().toISOString().slice(0, 10); // "2026-10-16"

const BUDGETS = {
  chat: () => config.DAILY_CHAT_TOKEN_BUDGET,
  embedding: () => config.DAILY_EMBEDDING_TOKEN_BUDGET,
};

export async function getUsageToday() {
  const doc = await usage().findOne({ _id: today() });
  return {
    day: today(),
    chatTokens: doc?.chatTokens ?? 0,
    embeddingTokens: doc?.embeddingTokens ?? 0,
    chatBudget: config.DAILY_CHAT_TOKEN_BUDGET,
    embeddingBudget: config.DAILY_EMBEDDING_TOKEN_BUDGET,
  };
}

export async function assertBudget(kind) {
  const doc = await usage().findOne({ _id: today() });
  if ((doc?.[`${kind}Tokens`] ?? 0) >= BUDGETS[kind]()) {
    throw new HttpError(503, 'Daily usage limit reached. Please try again tomorrow.', { code: 'budget_exhausted' });
  }
}

export async function recordUsage(kind, tokens) {
  if (!tokens) return;
  await usage().updateOne(
    { _id: today() },
    { $inc: { [`${kind}Tokens`]: tokens }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
}
