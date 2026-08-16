import { afterAll, afterEach, beforeAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

/**
 * A real MongoDB for every suite.
 *
 * Mocking Mongoose would test the mock: the unique `{projectId, path}` index is
 * load-bearing for duplicate detection, and TTL/sparse index behaviour has no
 * meaningful stub. `mongodb-memory-server` runs an actual mongod, so the tests
 * exercise the same query and index semantics as production.
 */

let mongod: MongoMemoryServer | undefined;

// Set before any module reads config: a passing test run should be quiet, so
// that anything printed is a real signal.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.EXEC_DISABLED = '1';

beforeAll(async () => {
  // Load `db/connect` for its global `mongoose.set` calls before anything
  // queries. Skipping it is how `sanitizeFilter: true` came to be on in
  // production and off under test — which let every `$in` / `$regex` / `$lt`
  // filter in the codebase pass its tests and then throw a cast error against a
  // real server. Dynamic, not top-level, so the env above is set first.
  await import('../db/connect.js');

  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri(), { dbName: 'codexa_test' });
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
