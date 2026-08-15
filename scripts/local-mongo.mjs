/**
 * Development MongoDB, without Docker.
 *
 * `infra/docker-compose.dev.yml` is the normal path. On a machine with no
 * Docker daemon this starts the same MongoDB 7 server directly, reusing the
 * binary `mongodb-memory-server` already downloads for the test suite, and
 * keeps its data in `.local-mongo-data/` so projects survive a restart.
 *
 *   node scripts/local-mongo.mjs        →  mongodb://127.0.0.1:27017
 *
 * Development only. Production uses the compose stack (docs/RUNBOOK.md).
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, '.local-mongo-data');
const port = Number(process.env.MONGO_PORT ?? 27017);

await mkdir(dbPath, { recursive: true });

console.log('Starting MongoDB (first run downloads ~590MB)…');

const server = await MongoMemoryServer.create({
  binary: { version: '7.0.14' },
  instance: {
    port,
    dbPath,
    // Without this the data directory is wiped on shutdown, and every restart
    // would lose your projects — which is the whole point of not using the
    // ephemeral in-memory mode here.
    storageEngine: 'wiredTiger',
  },
});

console.log(`\n  MongoDB ready at ${server.getUri()}`);
console.log(`  Data: ${dbPath}`);
console.log('\n  Leave this running. Ctrl+C to stop.\n');

const shutdown = async (signal) => {
  console.log(`\n${signal} — stopping MongoDB…`);
  await server.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
