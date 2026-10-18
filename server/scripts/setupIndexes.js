// Creates the regular indexes and the Atlas Vector Search index.
// Safe to run repeatedly: existing indexes are left alone, and a vector
// index whose definition no longer matches the config is updated in place.
//
//   npm run setup:indexes
import { config } from '../src/config.js';
import { connectDb, closeDb, documents, chunks } from '../src/db.js';
import { logger } from '../src/logger.js';

// `ownerId` and `documentId` are declared as filter fields so $vectorSearch
// can pre-filter by them. That is what scopes every search to one user's
// one document *before* similarity ranking, not after.
const vectorIndexDefinition = {
  fields: [
    {
      type: 'vector',
      path: 'embedding',
      numDimensions: config.EMBEDDING_DIMENSIONS,
      similarity: 'cosine',
    },
    { type: 'filter', path: 'ownerId' },
    { type: 'filter', path: 'documentId' },
  ],
};

async function ensureRegularIndexes() {
  // Dedup: the same user uploading the same bytes maps to one document.
  await documents().createIndex({ ownerId: 1, contentHash: 1 }, { unique: true, name: 'owner_contentHash' });
  // "List my documents, newest first".
  await documents().createIndex({ ownerId: 1, createdAt: -1 }, { name: 'owner_createdAt' });
  // Fetch / delete all chunks of a document in order.
  await chunks().createIndex({ documentId: 1, chunkIndex: 1 }, { unique: true, name: 'document_chunkIndex' });
  logger.info('Regular indexes ready');
}

async function ensureVectorIndex() {
  const name = config.VECTOR_INDEX_NAME;
  const [existing] = await chunks().listSearchIndexes(name).toArray();

  if (!existing) {
    await chunks().createSearchIndex({ name, type: 'vectorSearch', definition: vectorIndexDefinition });
    logger.info({ name }, 'Vector search index created');
  } else {
    const currentDims = existing.latestDefinition?.fields?.find((f) => f.type === 'vector')?.numDimensions;
    if (currentDims !== config.EMBEDDING_DIMENSIONS) {
      logger.warn(
        { name, currentDims, wantedDims: config.EMBEDDING_DIMENSIONS },
        'Vector index dimensions differ from config; updating. Re-ingest documents afterwards.',
      );
      await chunks().updateSearchIndex(name, vectorIndexDefinition);
    } else {
      logger.info({ name, status: existing.status }, 'Vector search index already exists');
    }
  }

  // Atlas builds search indexes asynchronously. Wait until it is queryable
  // so the next step (ingestion) does not race against the build.
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const [index] = await chunks().listSearchIndexes(name).toArray();
    if (index?.queryable && index.status === 'READY') {
      logger.info({ name }, 'Vector search index is READY');
      return;
    }
    logger.info({ status: index?.status }, 'Waiting for vector index to become queryable...');
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Timed out waiting for the vector index. Check its status in the Atlas UI.');
}

try {
  await connectDb();
  await ensureRegularIndexes(); // also creates the `chunks` collection if missing
  await ensureVectorIndex();
} catch (err) {
  logger.error({ err }, 'Index setup failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
