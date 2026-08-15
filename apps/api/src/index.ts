import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './observability/logger.js';
import { connectToDatabase, disconnectFromDatabase, ensureIndexes } from './db/connect.js';
import { createRealtimeServer, closeRealtimeServer } from './realtime/index.js';
import { flushAll } from './realtime/docStore.js';
import { initialiseExecution, shutdownExecution } from './execution/index.js';
import { startRateLimitSweeper } from './services/runs.js';

async function main(): Promise<void> {
  await connectToDatabase();
  if (config.isProduction) await ensureIndexes();

  const app = createApp();
  const httpServer = createServer(app);
  const io = createRealtimeServer(httpServer);

  // Execution starting up degraded is not fatal: the rest of the IDE works and
  // the Run button explains why it is unavailable.
  const engine = await initialiseExecution();
  if (!engine.isAvailable()) {
    logger.warn({ reason: engine.unavailableReason() }, 'execution is unavailable');
  }

  const stopSweeper = startRateLimitSweeper();

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, resolve);
  });
  logger.info({ port: config.port, env: config.env }, 'codexa api listening');

  installShutdown(async () => {
    stopSweeper();
    // Stop accepting work first, then flush, so nothing is written after the
    // snapshot we are about to take.
    await closeRealtimeServer(io);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await shutdownExecution();
    // Any document edited in the last two seconds is still only in memory.
    await flushAll();
    await disconnectFromDatabase();
  });
}

/**
 * Graceful shutdown. The flush in the callback is the important part: without
 * it, a deploy silently discards up to two seconds of everyone's edits.
 */
function installShutdown(teardown: () => Promise<void>): void {
  let shuttingDown = false;

  const handler = (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second signal received, exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 15_000);
    timeout.unref?.();

    teardown()
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((err) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    handler('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
