import { config } from './config.js';
import { logger } from './logger.js';
import { connectDb, closeDb } from './db.js';
import { createApp } from './app.js';

await connectDb();

const server = createApp().listen(config.PORT, () => {
  logger.info(`API listening on http://localhost:${config.PORT}`);
});

// Graceful shutdown: stop accepting connections, let in-flight requests
// finish, then close the DB pool. Prevents half-written ingestion jobs on
// deploys and Ctrl+C.
async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Last-resort safety nets. A rejected promise nobody awaited is a bug: log
// it loudly. An uncaught exception leaves the process in an unknown state,
// so log and exit; a process manager (pm2, Docker, Render) restarts it.
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception; exiting');
  process.exit(1);
});
