// One MongoClient per process. The driver manages a connection pool
// internally, so we connect once at startup and reuse it everywhere.
import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { logger } from './logger.js';

const client = new MongoClient(config.MONGODB_URI, {
  appName: 'documind',
  serverSelectionTimeoutMS: 10_000,
});

let db;

export async function connectDb() {
  if (db) return db;
  await client.connect();
  db = client.db(config.MONGODB_DB);
  await db.command({ ping: 1 });
  logger.info({ db: config.MONGODB_DB }, 'Connected to MongoDB');
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db;
}

// Typed accessors so collection names live in one place.
export const documents = () => getDb().collection('documents');
export const chunks = () => getDb().collection('chunks');

export async function closeDb() {
  await client.close();
  db = undefined;
}
