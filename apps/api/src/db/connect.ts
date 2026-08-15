import mongoose from 'mongoose';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

/**
 * Mongo connection lifecycle.
 */

mongoose.set('strictQuery', true);

/**
 * Pass this to `setOptions` on any query whose filter is built from data we did
 * not construct — see the note below on why it is per-query and not global.
 *
 * `sanitizeFilter` wraps every nested object holding a `$`-prefixed key in
 * `$eq`, which is what defuses a request body of `{ "name": { "$ne": null } }`
 * used as a filter. It cannot distinguish that from a filter we wrote
 * ourselves, so `{ _id: { $in: ids } }` becomes `{ _id: { $eq: { $in: ids } } }`
 * and the query throws a cast error.
 *
 * It used to be set globally via `mongoose.set`, which broke every `$in`,
 * `$regex` and `$lt` in this codebase — nine queries, including the project
 * detail route. There is no way to exempt them: `Query._castConditions` reads
 * `model.base.options.sanitizeFilter` *before* the per-query option and only
 * consults the query's own value when the global is unset, so a global `true`
 * cannot be overridden. Hence: off by default, opted into where it earns its
 * keep.
 *
 * Today nothing needs it. Every route parses its input with Zod, so the values
 * that reach a filter are already scalars — that is the actual defence, and it
 * runs before the query is built. This exists so the next route that wants to
 * filter on something unparsed has the right tool at hand.
 */
export const UNTRUSTED_FILTER = { sanitizeFilter: true } as const;

let connecting: Promise<typeof mongoose> | null = null;

export async function connectToDatabase(uri: string = config.mongoUri): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  if (connecting) {
    await connecting;
    return;
  }

  connecting = mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    minPoolSize: 2,
    retryWrites: true,
    autoIndex: !config.isProduction,
  });

  mongoose.connection.on('error', (err) => logger.error({ err }, 'mongo connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongo reconnected'));

  try {
    await connecting;
    logger.info({ db: mongoose.connection.name }, 'mongo connected');
  } finally {
    connecting = null;
  }
}

/**
 * In production `autoIndex` is off (index builds on a hot collection can stall
 * writes), so indexes are created explicitly at boot instead.
 */
export async function ensureIndexes(): Promise<void> {
  const models = Object.values(mongoose.models);
  // `syncIndexes`, not `createIndexes`: the latter only adds, so an index whose
  // *definition* changed keeps its old form forever. That is how a stale
  // `sparse` unique index on shareToken would survive the fix that replaced it
  // with a partial one, and keep rejecting every un-shared project.
  await Promise.all(models.map((model) => model.syncIndexes()));
  logger.info({ count: models.length }, 'indexes synced');
}

export async function disconnectFromDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  logger.info('mongo disconnected');
}

export { mongoose };
