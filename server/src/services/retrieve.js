// Question → the few chunks most likely to contain the answer.
import { config } from '../config.js';
import { chunks } from '../db.js';
import { embedTexts } from './openai.js';

export async function retrieveChunks({ ownerId, documentId, question, signal }) {
  // Same model + dimensions as ingestion, otherwise the vectors aren't comparable.
  const { vectors: [queryVector], tokens } = await embedTexts([question], { signal });

  const hits = await chunks()
    .aggregate([
      {
        $vectorSearch: {
          index: config.VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector,
          // HNSW explores `numCandidates` neighbours, returns the best `limit`.
          numCandidates: config.RETRIEVAL_NUM_CANDIDATES,
          limit: config.RETRIEVAL_TOP_K,
          // Pre-filter: only this owner's chunks of this document are even
          // considered. Access control and relevance in one step.
          filter: { ownerId, documentId },
        },
      },
      {
        $project: {
          chunkIndex: 1,
          pageStart: 1,
          pageEnd: 1,
          text: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ])
    .toArray();

  // Score gate: drop weak matches. If nothing survives, the caller answers
  // "not found" without paying for an LLM call.
  const relevant = hits.filter((h) => h.score >= config.RETRIEVAL_MIN_SCORE);

  // Context budget: cap prompt size (= cost + latency) regardless of TOP_K.
  const selected = [];
  let usedChars = 0;
  for (const hit of relevant) {
    if (usedChars + hit.text.length > config.MAX_CONTEXT_CHARS) break;
    selected.push(hit);
    usedChars += hit.text.length;
  }

  return {
    chunks: selected,
    stats: {
      candidates: hits.length,
      kept: selected.length,
      topScore: hits[0]?.score ?? null,
      contextChars: usedChars,
      embeddingTokens: tokens,
    },
  };
}
