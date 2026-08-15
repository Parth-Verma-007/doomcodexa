import * as Y from 'yjs';
import { LRUCache } from 'lru-cache';
import { LIMITS } from '@codexa/shared';
import { Y_TEXT_KEY, loadState, persistState } from '../services/documents.js';
import { logger } from '../observability/logger.js';
import { ydocCacheSize, ydocPersists } from '../observability/metrics.js';

/**
 * Server-side authoritative Y.Doc cache (§7).
 *
 * The server holds a real Y.Doc per open file rather than blindly relaying
 * updates. That buys three things a dumb relay cannot give you:
 *
 *   1. A client joining an empty room gets correct state (nobody else is
 *      around to answer its sync request).
 *   2. There is a single snapshot to persist, so `plainText` is always the
 *      merge of everyone's edits rather than whichever client wrote last.
 *   3. Oversized updates can be rejected before they reach other clients.
 *
 * Cost is memory proportional to open files, bounded by the LRU.
 */

interface Entry {
  doc: Y.Doc;
  fileId: string;
  projectId: string;
  dirty: boolean;
  /** Sockets currently subscribed. Zero triggers the eviction countdown. */
  subscribers: number;
  debounceTimer: NodeJS.Timeout | null;
  /** Guarantees a write every MAX_INTERVAL even under continuous typing. */
  maxIntervalTimer: NodeJS.Timeout | null;
  evictTimer: NodeJS.Timeout | null;
}

export class DocumentTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentTooLargeError';
  }
}

const entries = new LRUCache<string, Entry>({
  max: LIMITS.YDOC_CACHE_SIZE,
  // Evicting a dirty doc without flushing would silently lose edits.
  dispose: (entry, key) => {
    if (entry.dirty) {
      void flush(entry, 'lru-evict').catch((err) =>
        logger.error({ err, fileId: key }, 'failed to flush an LRU-evicted document'),
      );
    }
    clearTimers(entry);
    entry.doc.destroy();
    ydocCacheSize.set(entries.size);
  },
});

/** In-flight loads, so two simultaneous joins don't both hit Mongo. */
const loading = new Map<string, Promise<Entry>>();

async function acquire(fileId: string, projectId: string): Promise<Entry> {
  const cached = entries.get(fileId);
  if (cached) return cached;

  const inFlight = loading.get(fileId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const state = await loadState(fileId, projectId);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);

    const entry: Entry = {
      doc,
      fileId,
      projectId,
      dirty: false,
      subscribers: 0,
      debounceTimer: null,
      maxIntervalTimer: null,
      evictTimer: null,
    };
    entries.set(fileId, entry);
    ydocCacheSize.set(entries.size);
    return entry;
  })();

  loading.set(fileId, promise);
  try {
    return await promise;
  } finally {
    loading.delete(fileId);
  }
}

/** A client opened the file. Returns the doc's current state vector. */
export async function subscribe(fileId: string, projectId: string): Promise<Uint8Array> {
  const entry = await acquire(fileId, projectId);
  entry.subscribers += 1;
  if (entry.evictTimer) {
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  }
  return Y.encodeStateVector(entry.doc);
}

/**
 * A client closed the file or disconnected. When the last one leaves we flush
 * immediately and start a grace period before dropping the doc from memory —
 * a quick reload should not pay for a reload from Mongo.
 */
export async function unsubscribe(fileId: string): Promise<void> {
  const entry = entries.get(fileId);
  if (!entry) return;

  entry.subscribers = Math.max(0, entry.subscribers - 1);
  if (entry.subscribers > 0) return;

  await flush(entry, 'last-leave');

  entry.evictTimer = setTimeout(() => {
    const current = entries.get(fileId);
    if (current && current.subscribers === 0) entries.delete(fileId);
  }, LIMITS.YDOC_EVICT_GRACE_MS);
  entry.evictTimer.unref?.();
}

/**
 * Apply a client update.
 *
 * Rejects oversized payloads before applying: one 5MB paste otherwise wedges
 * the room for everyone (§7). The check is on the encoded update rather than
 * the resulting text because that is what actually crosses the wire.
 */
export async function applyUpdate(
  fileId: string,
  projectId: string,
  update: Uint8Array,
): Promise<void> {
  if (update.byteLength > LIMITS.MAX_YJS_UPDATE_BYTES) {
    throw new DocumentTooLargeError(
      `Update of ${update.byteLength} bytes exceeds the ${LIMITS.MAX_YJS_UPDATE_BYTES} byte limit.`,
    );
  }

  const entry = await acquire(fileId, projectId);
  Y.applyUpdate(entry.doc, update);

  const length = entry.doc.getText(Y_TEXT_KEY).length;
  if (length > LIMITS.MAX_DOC_BYTES) {
    throw new DocumentTooLargeError(
      `Document would exceed the ${LIMITS.MAX_DOC_BYTES} byte limit.`,
    );
  }

  markDirty(entry);
}

/** Answer a client's sync step 1: the diff it is missing. */
export async function diffSince(
  fileId: string,
  projectId: string,
  stateVector: Uint8Array,
): Promise<Uint8Array> {
  const entry = await acquire(fileId, projectId);
  return Y.encodeStateAsUpdate(entry.doc, stateVector);
}

export async function stateVectorOf(fileId: string, projectId: string): Promise<Uint8Array> {
  const entry = await acquire(fileId, projectId);
  return Y.encodeStateVector(entry.doc);
}

export async function textOf(fileId: string, projectId: string): Promise<string> {
  const entry = await acquire(fileId, projectId);
  return entry.doc.getText(Y_TEXT_KEY).toString();
}

function markDirty(entry: Entry): void {
  entry.dirty = true;

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(() => {
    void flush(entry, 'debounce');
  }, LIMITS.YDOC_PERSIST_DEBOUNCE_MS);
  entry.debounceTimer.unref?.();

  // Continuous typing keeps resetting the debounce, so a separate ceiling
  // guarantees a write at least this often.
  if (!entry.maxIntervalTimer) {
    entry.maxIntervalTimer = setTimeout(() => {
      void flush(entry, 'max-interval');
    }, LIMITS.YDOC_PERSIST_MAX_INTERVAL_MS);
    entry.maxIntervalTimer.unref?.();
  }
}

async function flush(entry: Entry, trigger: string): Promise<void> {
  clearTimers(entry);
  if (!entry.dirty) return;
  entry.dirty = false;

  try {
    const state = Y.encodeStateAsUpdate(entry.doc);
    const text = entry.doc.getText(Y_TEXT_KEY).toString();
    await persistState(entry.fileId, state, text);
    ydocPersists.inc({ trigger });
  } catch (err) {
    // Put it back in the dirty set so the next edit or the shutdown flush
    // retries, rather than losing the snapshot entirely.
    entry.dirty = true;
    logger.error({ err, fileId: entry.fileId, trigger }, 'failed to persist a document snapshot');
  }
}

function clearTimers(entry: Entry): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  if (entry.maxIntervalTimer) clearTimeout(entry.maxIntervalTimer);
  entry.debounceTimer = null;
  entry.maxIntervalTimer = null;
}

/** Drop a document from memory without persisting — used when its file is deleted. */
export function forget(fileId: string): void {
  const entry = entries.peek(fileId);
  if (!entry) return;
  entry.dirty = false;
  entries.delete(fileId);
}

export function forgetAll(fileIds: string[]): void {
  for (const id of fileIds) forget(id);
}

/** Flush every dirty document. Called on shutdown so no edits are lost. */
export async function flushAll(): Promise<void> {
  const pending = [...entries.values()].filter((e) => e.dirty);
  await Promise.allSettled(pending.map((e) => flush(e, 'shutdown')));
  logger.info({ count: pending.length }, 'flushed dirty documents');
}

export function cacheStats() {
  return {
    size: entries.size,
    subscribed: [...entries.values()].filter((e) => e.subscribers > 0).length,
  };
}

/** Test-only: drop everything without persisting. */
export function resetForTests(): void {
  for (const entry of entries.values()) entry.dirty = false;
  entries.clear();
  loading.clear();
}
