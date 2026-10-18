// Orchestrates: hash → dedup → extract → chunk → embed → store.
//
// Ordering is deliberate:
//   1. Dedup check first: identical re-uploads cost nothing.
//   2. Extract + chunk before touching the DB: a bad PDF never leaves a record.
//   3. Embed (the only paid step) only after the document row is "claimed",
//      so two simultaneous uploads of the same file can't both pay.
import { createHash } from 'node:crypto';
import { APIUserAbortError } from 'openai';
import { config } from '../config.js';
import { documents, chunks } from '../db.js';
import { HttpError } from '../errors.js';
import { extractPages } from './pdf.js';
import { chunkPages } from './chunker.js';
import { embedTexts } from './openai.js';
import { assertBudget, recordUsage } from './budget.js';

// A "processing" row older than this is assumed to be from a crashed server.
const STALE_PROCESSING_MS = 10 * 60_000;

// Everything that, if changed, makes stored vectors incompatible or different.
const pipelineSettings = () => ({
  embeddingModel: config.EMBEDDING_MODEL,
  embeddingDimensions: config.EMBEDDING_DIMENSIONS,
  chunkSize: config.CHUNK_SIZE,
  chunkOverlap: config.CHUNK_OVERLAP,
});

const samePipeline = (doc, settings) => Object.entries(settings).every(([key, value]) => doc[key] === value);

export async function ingestPdf({ ownerId, filename, buffer, signal, log }) {
  const contentHash = createHash('sha256').update(buffer).digest('hex');
  const settings = pipelineSettings();

  // 1. Dedup.
  const existing = await documents().findOne({ ownerId, contentHash });
  if (existing) {
    if (existing.status === 'ready' && samePipeline(existing, settings)) {
      log.info({ documentId: existing._id }, 'Duplicate upload; reusing existing embeddings');
      return { document: existing, deduplicated: true };
    }
    const isStale = Date.now() - existing.updatedAt.getTime() > STALE_PROCESSING_MS;
    if (existing.status === 'processing' && !isStale) {
      throw new HttpError(409, 'This document is already being processed.');
    }
  }

  // 2. Extract + chunk (CPU only, free).
  let t = performance.now();
  const pages = await extractPages(buffer, { maxPages: config.MAX_PDF_PAGES });
  const pieces = chunkPages(pages, { chunkSize: config.CHUNK_SIZE, chunkOverlap: config.CHUNK_OVERLAP });
  const extractMs = Math.round(performance.now() - t);

  // Refuse before creating any record if today's embedding budget is spent.
  await assertBudget('embedding');

  // 3. Claim the document row.
  const now = new Date();
  const fields = { filename, sizeBytes: buffer.length, pageCount: pages.length, status: 'processing', ...settings, updatedAt: now };
  let documentId;

  if (existing) {
    // Re-ingest (previous attempt failed, went stale, or settings changed).
    // Matching on the old `updatedAt` makes this a compare-and-swap: if two
    // requests race, only one wins the update.
    const claimed = await documents().findOneAndUpdate(
      { _id: existing._id, updatedAt: existing.updatedAt },
      { $set: fields, $unset: { error: '' } },
    );
    if (!claimed) throw new HttpError(409, 'This document is already being processed.');
    documentId = existing._id;
    await chunks().deleteMany({ documentId });
  } else {
    try {
      ({ insertedId: documentId } = await documents().insertOne({ ownerId, contentHash, ...fields, createdAt: now }));
    } catch (err) {
      if (err.code === 11000) throw new HttpError(409, 'This document is already being processed.');
      throw err;
    }
  }

  // 4. Embed + store.
  try {
    t = performance.now();
    const { vectors, tokens } = await embedTexts(
      pieces.map((c) => c.text),
      { signal },
    );
    const embedMs = Math.round(performance.now() - t);
    await recordUsage('embedding', tokens);

    await chunks().insertMany(
      pieces.map((c, i) => ({ documentId, ownerId, ...c, embedding: vectors[i], createdAt: now })),
    );

    t = performance.now();
    const indexed = await waitUntilSearchable({ ownerId, documentId, lastChunk: pieces.at(-1), vector: vectors.at(-1) });
    const indexWaitMs = Math.round(performance.now() - t);
    if (!indexed) log.warn({ documentId, indexWaitMs }, 'Vector index still syncing; document will be searchable shortly');

    const document = await documents().findOneAndUpdate(
      { _id: documentId },
      { $set: { status: 'ready', chunkCount: pieces.length, embeddingTokens: tokens, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    log.info(
      { documentId, pages: pages.length, chunks: pieces.length, embeddingTokens: tokens, extractMs, embedMs, indexWaitMs },
      'Document ingested',
    );
    return { document, deduplicated: false };
  } catch (err) {
    // Never leave half-written chunks behind.
    await chunks().deleteMany({ documentId });

    if (err instanceof APIUserAbortError) {
      // The client cancelled the upload: remove the record entirely.
      await documents().deleteOne({ _id: documentId });
      log.info({ documentId }, 'Ingestion cancelled by client');
    } else {
      await documents().updateOne(
        { _id: documentId },
        { $set: { status: 'failed', error: 'Processing failed. Please try uploading again.', updatedAt: new Date() } },
      );
    }
    throw err;
  }
}

// Atlas Vector Search indexes are *eventually consistent*: a separate search
// process (mongot) syncs from the database a few seconds after a write. If we
// marked the document "ready" straight away, a question asked immediately
// would find nothing. So we search for the LAST chunk we inserted using its
// own vector (an exact match scores ~1.0) and wait until it shows up.
const INDEX_WAIT_MS = 30_000;

async function waitUntilSearchable({ ownerId, documentId, lastChunk, vector }) {
  const deadline = Date.now() + INDEX_WAIT_MS;
  while (Date.now() < deadline) {
    const [hit] = await chunks()
      .aggregate([
        {
          $vectorSearch: {
            index: config.VECTOR_INDEX_NAME,
            path: 'embedding',
            queryVector: vector,
            numCandidates: 20,
            limit: 1,
            filter: { ownerId, documentId },
          },
        },
        { $project: { chunkIndex: 1 } },
      ])
      .toArray();
    if (hit?.chunkIndex === lastChunk.chunkIndex) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false; // don't fail the upload; it will become searchable shortly
}
