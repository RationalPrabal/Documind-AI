// The only module that talks to OpenAI. Keeping it in one place means the
// API key, timeouts, retries and model names are configured exactly once.
import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../config.js';
import { ROUTER_INSTRUCTIONS, ROUTER_SCHEMA, buildRouterInput } from './prompt.js';

// The SDK retries 408/409/429/5xx and connection errors with exponential
// backoff (honouring Retry-After), up to `maxRetries` times.
export const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
  timeout: config.OPENAI_TIMEOUT_MS,
  maxRetries: config.OPENAI_MAX_RETRIES,
});

// ~100 chunks × ~250 tokens ≈ 25k tokens per request: far below the API's
// per-request limits, and small enough that one retry is cheap.
const EMBEDDING_BATCH_SIZE = 100;

// Embeds many texts with as few requests as possible. Returns vectors in
// the same order as `texts`, plus total tokens used (for cost logging).
export async function embedTexts(texts, { signal } = {}) {
  const vectors = [];
  let tokens = 0;

  // Sequential on purpose: predictable under rate limits, easy to reason about.
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const res = await openai.embeddings.create(
      {
        model: config.EMBEDDING_MODEL,
        input: batch,
        // Only the text-embedding-3 family accepts `dimensions`.
        ...(config.EMBEDDING_MODEL.startsWith('text-embedding-3') && { dimensions: config.EMBEDDING_DIMENSIONS }),
      },
      { signal },
    );
    // The API returns an `index` per item; sort rather than assume order.
    res.data.sort((a, b) => a.index - b.index).forEach((d) => vectors.push(d.embedding));
    tokens += res.usage.prompt_tokens;
  }

  if (vectors.length !== texts.length) throw new Error('Embedding count mismatch');
  return { vectors, tokens };
}

// Classifies a follow-up message and rewrites it as a standalone search
// query, using STRUCTURED OUTPUTS: the API constrains the model to emit JSON
// matching our schema, so no fragile text parsing. We still validate it.
const RouteResult = z.object({ type: z.enum(['document', 'conversation']), query: z.string().max(1000) });

export async function routeQuestion({ question, history, signal }) {
  const res = await openai.responses.create(
    {
      model: config.CHAT_MODEL,
      instructions: ROUTER_INSTRUCTIONS,
      input: buildRouterInput(question, history),
      max_output_tokens: 200,
      store: false,
      text: { format: { type: 'json_schema', name: 'route', strict: true, schema: ROUTER_SCHEMA } },
      ...(config.REASONING_EFFORT && { reasoning: { effort: config.REASONING_EFFORT } }),
    },
    { signal },
  );
  const route = RouteResult.parse(JSON.parse(res.output_text));
  return { ...route, tokens: (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0) };
}

// Streams an answer from the Responses API, calling onDelta(text) for each
// fragment as it arrives. Resolves with the full text and token usage.
export async function streamAnswer({ instructions, input, signal, onDelta }) {
  const stream = await openai.responses.create(
    {
      model: config.CHAT_MODEL,
      instructions,
      input,
      max_output_tokens: config.MAX_OUTPUT_TOKENS, // hard cap on cost per answer
      store: false, // don't keep document excerpts on OpenAI's side
      stream: true,
      ...(config.REASONING_EFFORT && { reasoning: { effort: config.REASONING_EFFORT } }),
    },
    { signal },
  );

  let text = '';
  let final;
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      text += event.delta;
      onDelta(event.delta);
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      final = event.response;
    } else if (event.type === 'response.failed') {
      throw new Error(`Generation failed: ${event.response.error?.message ?? 'unknown error'}`);
    } else if (event.type === 'error') {
      throw new Error(`Generation stream error: ${event.message}`);
    }
  }

  return {
    text,
    // "incomplete" + max_output_tokens means the answer was cut off by our cap.
    truncated: final?.status === 'incomplete' && final.incomplete_details?.reason === 'max_output_tokens',
    usage: { inputTokens: final?.usage?.input_tokens ?? 0, outputTokens: final?.usage?.output_tokens ?? 0 },
  };
}
