import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { logger } from '../observability/logger.js';

/**
 * Per-project awareness state — cursors, selections, who is looking at what.
 *
 * Awareness is ephemeral and never persisted (§7). The server keeps an instance
 * per project for two reasons a pure relay cannot cover:
 *
 *   1. A newcomer needs everyone's current cursor immediately, not after the
 *      next keystroke from each peer.
 *   2. When a socket drops, its cursor must disappear now. Relying on the
 *      client-side 30s awareness timeout leaves ghost cursors on screen.
 */

interface ProjectAwareness {
  /** Awareness needs a doc only for its clientID; it is otherwise unused. */
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** socketId -> the Yjs client ids that socket has published. */
  clientsBySocket: Map<string, Set<number>>;
}

const byProject = new Map<string, ProjectAwareness>();

function acquire(projectId: string): ProjectAwareness {
  const existing = byProject.get(projectId);
  if (existing) return existing;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  // The server itself is not a peer; drop the local state it creates.
  awareness.setLocalState(null);

  const entry: ProjectAwareness = { doc, awareness, clientsBySocket: new Map() };
  byProject.set(projectId, entry);
  return entry;
}

/**
 * Apply an awareness update from a socket and return the update to relay.
 * Returns null if the payload was unusable, so a malformed frame from one
 * client cannot break the room.
 */
export function applyAwarenessUpdate(
  projectId: string,
  socketId: string,
  update: Uint8Array,
): Uint8Array | null {
  const entry = acquire(projectId);

  const touched = new Set<number>();
  const record = ({ added, updated }: { added: number[]; updated: number[] }, origin: unknown) => {
    if (origin !== socketId) return;
    for (const id of [...added, ...updated]) touched.add(id);
  };

  entry.awareness.on('update', record);
  try {
    awarenessProtocol.applyAwarenessUpdate(entry.awareness, update, socketId);
  } catch (err) {
    logger.warn({ err, projectId, socketId }, 'discarded a malformed awareness update');
    return null;
  } finally {
    entry.awareness.off('update', record);
  }

  if (touched.size > 0) {
    const owned = entry.clientsBySocket.get(socketId) ?? new Set<number>();
    for (const id of touched) owned.add(id);
    entry.clientsBySocket.set(socketId, owned);
  }

  return update;
}

/** The full current awareness state, for a client that has just joined. */
export function snapshotFor(projectId: string): Uint8Array | null {
  const entry = byProject.get(projectId);
  if (!entry) return null;

  const clients = [...entry.awareness.getStates().keys()];
  if (clients.length === 0) return null;

  return awarenessProtocol.encodeAwarenessUpdate(entry.awareness, clients);
}

/**
 * Remove everything a socket published and return the removal update to
 * broadcast, so its cursor vanishes for everyone immediately.
 */
export function removeSocket(projectId: string, socketId: string): Uint8Array | null {
  const entry = byProject.get(projectId);
  if (!entry) return null;

  const owned = entry.clientsBySocket.get(socketId);
  entry.clientsBySocket.delete(socketId);
  if (!owned || owned.size === 0) {
    disposeIfEmpty(projectId, entry);
    return null;
  }

  const clients = [...owned];
  awarenessProtocol.removeAwarenessStates(entry.awareness, clients, 'server-disconnect');
  const update = awarenessProtocol.encodeAwarenessUpdate(entry.awareness, clients);

  disposeIfEmpty(projectId, entry);
  return update;
}

function disposeIfEmpty(projectId: string, entry: ProjectAwareness): void {
  if (entry.clientsBySocket.size > 0) return;
  entry.awareness.destroy();
  entry.doc.destroy();
  byProject.delete(projectId);
}

export function activeProjectCount(): number {
  return byProject.size;
}

/** Test-only. */
export function resetForTests(): void {
  for (const [id, entry] of byProject) {
    entry.awareness.destroy();
    entry.doc.destroy();
    byProject.delete(id);
  }
}
