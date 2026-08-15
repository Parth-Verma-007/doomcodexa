import * as Y from 'yjs';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';
import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import type { Socket } from 'socket.io-client';
import type { AwarenessState } from '@codexa/shared';

/**
 * Yjs provider over Socket.IO.
 *
 * Yjs ships providers for raw WebSocket and WebRTC but not Socket.IO, so this
 * is written by hand against `y-protocols`. It is about 150 lines, it removes a
 * dependency on a lightly-maintained package, and it is the part of the project
 * most worth being able to explain.
 *
 * The protocol, per file room:
 *
 *   client -> sync:step1 (my state vector)      "here is what I have"
 *   server -> sync:step2 (the diff I am missing) "here is what you are missing"
 *   server -> sync:step1 (its state vector)      "now, what have you got?"
 *   client -> sync:step2 (the diff it is missing)
 *   both   -> sync:update (incremental, relayed)
 *
 * On reconnect the client simply re-runs step 1. Yjs computes the diff in both
 * directions and merges, which is why edits made while disconnected survive —
 * that behaviour is free with a CRDT and would be a project on its own with OT.
 */

export type ProviderStatus = 'connecting' | 'synced' | 'disconnected';

export interface DocumentProviderOptions {
  socket: Socket;
  doc: Y.Doc;
  fileId: string;
  awareness: Awareness;
  projectId: string;
  onStatus?: (status: ProviderStatus) => void;
  onError?: (message: string) => void;
}

export class DocumentProvider {
  private readonly socket: Socket;
  private readonly doc: Y.Doc;
  private readonly fileId: string;
  private readonly awareness: Awareness;
  private readonly projectId: string;
  private readonly onStatus: (status: ProviderStatus) => void;
  private readonly onError: (message: string) => void;

  private destroyed = false;
  private opened = false;
  private status: ProviderStatus = 'connecting';

  constructor(options: DocumentProviderOptions) {
    this.socket = options.socket;
    this.doc = options.doc;
    this.fileId = options.fileId;
    this.awareness = options.awareness;
    this.projectId = options.projectId;
    this.onStatus = options.onStatus ?? (() => {});
    this.onError = options.onError ?? (() => {});

    this.doc.on('update', this.handleLocalUpdate);
    this.awareness.on('update', this.handleAwarenessChange);

    this.socket.on('sync:step1', this.handleRemoteStep1);
    this.socket.on('sync:step2', this.handleRemoteStep2);
    this.socket.on('sync:update', this.handleRemoteUpdate);
    this.socket.on('awareness:update', this.handleRemoteAwareness);
    this.socket.on('codexa:error', this.handleServerError);
    this.socket.on('connect', this.handleConnect);
    this.socket.on('disconnect', this.handleDisconnect);

    if (this.socket.connected) this.open();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  private handleConnect = (): void => {
    // Re-open on every connect, not just the first: after a reconnect the
    // server has no memory of this socket's subscriptions.
    this.opened = false;
    this.open();
  };

  private handleDisconnect = (): void => {
    this.setStatus('disconnected');
  };

  private open(): void {
    if (this.destroyed || this.opened) return;
    this.opened = true;
    this.setStatus('connecting');

    this.socket.emit('doc:open', { fileId: this.fileId }, (response: { ok: boolean }) => {
      if (this.destroyed) return;
      if (!response?.ok) {
        this.opened = false;
        this.onError('Could not open this file.');
        this.setStatus('disconnected');
        return;
      }
      // Start the handshake from our side too, so neither peer waits on the
      // other and a reconnect converges in one round trip.
      this.socket.emit('sync:step1', {
        fileId: this.fileId,
        stateVector: Y.encodeStateVector(this.doc),
      });
      this.publishAwareness();
    });
  }

  // ─── Outbound ───────────────────────────────────────────────────────────────

  /**
   * `origin === this` marks updates we applied from the network. Re-sending
   * those would produce an echo storm between two peers.
   */
  private handleLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (this.destroyed || origin === this) return;
    this.socket.emit('sync:update', { fileId: this.fileId, update });
  };

  private handleAwarenessChange = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (this.destroyed || origin === 'remote') return;
    const changed = [...added, ...updated, ...removed];
    if (changed.length === 0) return;
    this.socket.emit('awareness:update', {
      projectId: this.projectId,
      update: encodeAwarenessUpdate(this.awareness, changed),
    });
  };

  private publishAwareness(): void {
    const state = this.awareness.getLocalState();
    if (!state) return;
    this.socket.emit('awareness:update', {
      projectId: this.projectId,
      // `awareness.clientID`, NOT `doc.clientID`. Awareness is project-wide and
      // built on the session doc, while `this.doc` is one document per file —
      // two different ids. Encoding with the file doc's id looks up a `meta`
      // entry that does not exist and throws inside `encodeAwarenessUpdate`,
      // which killed the whole `doc:open` ack handler and meant a peer never
      // announced itself until they happened to move the cursor.
      update: encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
    });
  }

  // ─── Inbound ────────────────────────────────────────────────────────────────

  private handleRemoteStep1 = (payload: { fileId: string; stateVector: ArrayBuffer }): void => {
    if (payload.fileId !== this.fileId || this.destroyed) return;
    const update = Y.encodeStateAsUpdate(this.doc, toBytes(payload.stateVector));
    this.socket.emit('sync:step2', { fileId: this.fileId, update });
  };

  private handleRemoteStep2 = (payload: { fileId: string; update: ArrayBuffer }): void => {
    if (payload.fileId !== this.fileId || this.destroyed) return;
    Y.applyUpdate(this.doc, toBytes(payload.update), this);
    this.setStatus('synced');
  };

  private handleRemoteUpdate = (payload: { fileId: string; update: ArrayBuffer }): void => {
    if (payload.fileId !== this.fileId || this.destroyed) return;
    Y.applyUpdate(this.doc, toBytes(payload.update), this);
  };

  private handleRemoteAwareness = (payload: { update: ArrayBuffer }): void => {
    if (this.destroyed) return;
    applyAwarenessUpdate(this.awareness, toBytes(payload.update), 'remote');
  };

  private handleServerError = (payload: { code: string; message: string }): void => {
    // Read-only rejections are expected for viewers and are surfaced by the UI
    // as a banner rather than a toast per keystroke.
    this.onError(payload.message);
  };

  private setStatus(next: ProviderStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.onStatus(next);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.socket.emit('doc:close', { fileId: this.fileId });

    this.doc.off('update', this.handleLocalUpdate);
    this.awareness.off('update', this.handleAwarenessChange);

    this.socket.off('sync:step1', this.handleRemoteStep1);
    this.socket.off('sync:step2', this.handleRemoteStep2);
    this.socket.off('sync:update', this.handleRemoteUpdate);
    this.socket.off('awareness:update', this.handleRemoteAwareness);
    this.socket.off('codexa:error', this.handleServerError);
    this.socket.off('connect', this.handleConnect);
    this.socket.off('disconnect', this.handleDisconnect);
  }
}

/**
 * Socket.IO hands binary back as ArrayBuffer (browser) or Buffer (Node).
 * A Buffer that is a view onto a larger pool decodes as garbage if passed to
 * Yjs directly, so always construct a correctly-bounded view.
 */
function toBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

/**
 * One awareness instance per project, shared by every open document.
 *
 * Awareness is project-scoped rather than file-scoped so that "who is in this
 * project, and which file are they looking at" is answerable without opening
 * every file — which is what powers the avatar stack and follow mode.
 */
export function createProjectAwareness(doc: Y.Doc): Awareness {
  const awareness = new Awareness(doc);

  // Publish a removal on unload so peers drop the cursor immediately rather
  // than waiting out the 30 second timeout.
  const cleanup = () => removeAwarenessStates(awareness, [doc.clientID], 'unload');
  window.addEventListener('beforeunload', cleanup);
  awareness.on('destroy', () => window.removeEventListener('beforeunload', cleanup));

  return awareness;
}

export function setLocalAwareness(awareness: Awareness, state: Partial<AwarenessState>): void {
  const current = (awareness.getLocalState() ?? {}) as Partial<AwarenessState>;
  awareness.setLocalState({ ...current, ...state });
}

/**
 * Announce our current awareness state to the project room, unprompted.
 *
 * Awareness updates are otherwise only sent when something changes, and the
 * server drops any that arrive before `room:join` has completed for that
 * socket. So a state set during the join — our identity landing from
 * `/api/me`, say — can be emitted, dropped, and never mentioned again: text
 * syncs perfectly while the avatar stack insists you are alone.
 *
 * Calling this once the room is joined closes that window, whichever order the
 * two finish in. It is idempotent; a redundant call costs one small frame.
 */
export function publishLocalAwareness(
  socket: Socket,
  projectId: string,
  awareness: Awareness | null,
): void {
  if (!awareness || !awareness.getLocalState()) return;
  socket.emit('awareness:update', {
    projectId,
    update: encodeAwarenessUpdate(awareness, [awareness.clientID]),
  });
}
