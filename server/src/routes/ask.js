// POST /api/documents/:id/ask
//   { "question": "...", "history": [{ "role": "user" | "assistant", "text": "..." }, ...] }
//
// Responds with Server-Sent Events (SSE), in this order:
//   event: sources  → { sources, mode, searchQuery } (sent before any tokens)
//   event: token    → { text } fragments of the answer, many times
//   event: done     → { answered, mode, citations, truncated, usage }
//   event: error    → { message } if generation fails mid-stream
//
// Conversation memory: the BROWSER keeps the chat and sends recent turns.
// They are used for this request only and never stored. With history:
//   1. route + rewrite: "and for AWS?" → { type: document, query: "AWS experience required" }
//   2a. "document"     → retrieve with the rewritten query, answer from excerpts
//   2b. "conversation" → ("what did I ask?", "thanks") answer from the history only
//
// Everything that can fail cheaply (validation, ownership, routing,
// retrieval) runs BEFORE the stream opens, so those failures are normal
// JSON + status codes.
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { documents } from '../db.js';
import { HttpError } from '../errors.js';
import { parseDocumentId } from '../ids.js';
import { toClientError } from '../middleware/errors.js';
import { retrieveChunks } from '../services/retrieve.js';
import {
  SYSTEM_INSTRUCTIONS,
  CONVERSATION_INSTRUCTIONS,
  NOT_FOUND,
  buildInput,
  buildConversationInput,
  extractCitations,
  isNotFound,
  trimHistory,
} from '../services/prompt.js';
import { routeQuestion, streamAnswer } from '../services/openai.js';
import { assertBudget, recordUsage } from '../services/budget.js';
import { askLimiter } from '../middleware/rateLimits.js';

export const askRouter = Router({ mergeParams: true });

// History comes from the client, so it is untrusted: strict shape, hard
// size limits (reject abuse), then trimmed to the configured window.
const HistoryMessage = z.object({
  role: z.enum(['user', 'assistant'], { error: 'history role must be "user" or "assistant"' }),
  text: z.string().max(8000, 'history message too long'),
});

const AskBody = z.object({
  question: z
    .string({ error: 'question must be a string' })
    .trim()
    .min(1, 'question is required')
    .max(config.MAX_QUESTION_CHARS, `question must be at most ${config.MAX_QUESTION_CHARS} characters`),
  history: z.array(HistoryMessage).max(50, 'history has too many messages').default([]),
});

askRouter.post('/', askLimiter, async (req, res) => {
  const started = performance.now();
  const documentId = parseDocumentId(req.params.id);

  const parsed = AskBody.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
  const { question } = parsed.data;
  const history = trimHistory(parsed.data.history, {
    maxMessages: config.HISTORY_MAX_MESSAGES,
    maxChars: config.HISTORY_MAX_CHARS,
  });

  const doc = await documents().findOne({ _id: documentId, ownerId: req.ownerId });
  if (!doc) throw new HttpError(404, 'Document not found.');
  if (doc.status !== 'ready') throw new HttpError(409, `Document is ${doc.status}, not ready for questions.`);
  if (doc.embeddingModel !== config.EMBEDDING_MODEL || doc.embeddingDimensions !== config.EMBEDDING_DIMENSIONS) {
    throw new HttpError(409, 'This document was processed with an older embedding model. Please upload it again.');
  }

  await assertBudget('embedding');
  await assertBudget('chat');

  // Client closes the tab / clicks Stop → abort OpenAI calls → stop paying.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  const { signal } = controller;

  // 1. Route + rewrite, only when there is history to resolve against.
  let mode = 'document';
  let searchQuery = question;
  let routeMs;
  if (history.length > 0) {
    const t = performance.now();
    try {
      const route = await routeQuestion({ question, history, signal });
      await recordUsage('chat', route.tokens);
      mode = route.type;
      if (route.query.trim()) searchQuery = route.query.trim();
    } catch (err) {
      if (signal.aborted) throw err;
      // Degrade gracefully: answering with the raw question beats failing.
      req.log.warn({ err: { name: err.name, message: err.message } }, 'Question rewrite failed; using the original question');
    }
    routeMs = Math.round(performance.now() - t);
  }

  // 2a. Document mode: retrieve with the standalone query.
  let chunks = [];
  let stats;
  if (mode === 'document') {
    ({ chunks, stats } = await retrieveChunks({ ownerId: req.ownerId, documentId, question: searchQuery, signal }));
    await recordUsage('embedding', stats.embeddingTokens);
  }
  const retrieveMs = Math.round(performance.now() - started);

  // ---- From here on we are streaming ----
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx-style proxies not to buffer
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('sources', {
    mode,
    // Shown in the UI so you can see what was actually searched for.
    searchQuery: mode === 'document' && searchQuery !== question ? searchQuery : null,
    sources: chunks.map((c, i) => ({
      id: i + 1,
      chunkIndex: c.chunkIndex,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      score: Number(c.score.toFixed(3)),
      text: c.text,
    })),
  });

  const logBase = { documentId, mode, historyMessages: history.length, routeMs, retrieval: stats, retrieveMs };

  // Nothing relevant enough: refuse WITHOUT calling the LLM (zero cost).
  if (mode === 'document' && chunks.length === 0) {
    send('token', { text: NOT_FOUND });
    send('done', { answered: false, mode, reason: 'no_relevant_context', citations: [], truncated: false });
    req.log.info(logBase, 'Question answered: no relevant context');
    return res.end();
  }

  let firstTokenMs;
  try {
    const result = await streamAnswer({
      ...(mode === 'document'
        ? { instructions: SYSTEM_INSTRUCTIONS, input: buildInput(question, chunks, history) }
        : { instructions: CONVERSATION_INSTRUCTIONS, input: buildConversationInput(question, history) }),
      signal,
      onDelta: (text) => {
        firstTokenMs ??= Math.round(performance.now() - started);
        send('token', { text });
      },
    });

    await recordUsage('chat', result.usage.inputTokens + result.usage.outputTokens);
    const answered = mode === 'conversation' || !isNotFound(result.text);
    send('done', {
      answered,
      mode,
      reason: answered ? undefined : 'model_found_no_answer',
      citations: answered && mode === 'document' ? extractCitations(result.text, chunks.length) : [],
      truncated: result.truncated,
      usage: result.usage,
    });
    req.log.info(
      {
        ...logBase,
        usage: result.usage,
        answered,
        truncated: result.truncated,
        firstTokenMs,
        totalMs: Math.round(performance.now() - started),
      },
      'Question answered',
    );
  } catch (err) {
    if (signal.aborted) {
      req.log.info({ documentId }, 'Answer cancelled by client');
    } else {
      req.log.error({ err }, 'Answer generation failed mid-stream');
      send('error', { message: toClientError(err).message });
    }
  }
  res.end();
});
