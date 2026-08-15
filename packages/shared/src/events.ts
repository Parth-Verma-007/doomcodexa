import type { LanguageId } from './constants.js';
import type {
  Ack,
  ErrorCode,
  FileDto,
  MessageDto,
  PresencePeer,
  ProjectDto,
  Role,
  RunDto,
  RunStatus,
  UserDto,
} from './types.js';

/**
 * Socket.IO contracts.
 *
 * Three namespaces multiplex over one physical connection: clean separation of
 * auth middleware and event tables without extra sockets (§11).
 *
 * Binary fields are `Uint8Array`. Socket.IO extracts them as binary attachments
 * automatically — never base64-encode a Yjs update.
 */

export const NS = {
  collab: '/collab',
  run: '/run',
  rtc: '/rtc',
} as const;

export type Namespace = (typeof NS)[keyof typeof NS];

/** Socket.IO room names. Centralised so client and server cannot drift. */
export const rooms = {
  project: (projectId: string) => `project:${projectId}`,
  file: (projectId: string, fileId: string) => `project:${projectId}:file:${fileId}`,
  run: (runId: string) => `run:${runId}`,
} as const;

// ─── /collab ──────────────────────────────────────────────────────────────────

export interface CollabJoinResult {
  project: ProjectDto;
  role: Role;
  peers: PresencePeer[];
}

export interface CollabClientToServer {
  'room:join': (payload: { projectId: string }, ack: (res: Ack<CollabJoinResult>) => void) => void;
  'room:leave': (payload: { projectId: string }) => void;

  /** Subscribe to a file's CRDT room. The server replies with `sync:step1`. */
  'doc:open': (payload: { fileId: string }, ack: (res: Ack<{ fileId: string }>) => void) => void;
  'doc:close': (payload: { fileId: string }) => void;

  'sync:step1': (payload: { fileId: string; stateVector: Uint8Array }) => void;
  'sync:step2': (payload: { fileId: string; update: Uint8Array }) => void;
  'sync:update': (payload: { fileId: string; update: Uint8Array }) => void;

  'awareness:update': (payload: { projectId: string; update: Uint8Array }) => void;

  'chat:send': (
    payload: { projectId: string; body: string },
    ack: (res: Ack<MessageDto>) => void,
  ) => void;
}

export interface CollabServerToClient {
  'sync:step1': (payload: { fileId: string; stateVector: Uint8Array }) => void;
  'sync:step2': (payload: { fileId: string; update: Uint8Array }) => void;
  'sync:update': (payload: { fileId: string; update: Uint8Array }) => void;

  'awareness:update': (payload: { update: Uint8Array }) => void;

  'peer:joined': (payload: { peer: PresencePeer }) => void;
  'peer:left': (payload: { socketId: string; userId: string }) => void;

  'file:created': (payload: { file: FileDto }) => void;
  'file:updated': (payload: { file: FileDto; previousPath?: string }) => void;
  'file:deleted': (payload: { fileIds: string[] }) => void;

  'project:updated': (payload: { project: Omit<ProjectDto, 'myRole' | 'shareToken'> }) => void;
  /** Membership changed — the client must re-resolve its own permissions (§10). */
  'acl:changed': (payload: { projectId: string; role: Role | null }) => void;

  'chat:message': (payload: { message: MessageDto }) => void;

  /** Non-fatal server-side rejection (rate limit, oversized update, bad role). */
  'codexa:error': (payload: { code: ErrorCode; message: string; context?: string }) => void;
}

// ─── /run ─────────────────────────────────────────────────────────────────────

export interface RunStartPayload {
  projectId: string;
  /** Defaults to the project's entrypoint when omitted. */
  fileId?: string;
  stdin?: string;
  interactive: boolean;
}

export interface RunClientToServer {
  'run:subscribe': (payload: { projectId: string }, ack: (res: Ack<RunDto[]>) => void) => void;
  'run:start': (payload: RunStartPayload, ack: (res: Ack<{ runId: string }>) => void) => void;
  'run:stdin': (payload: { runId: string; data: string }) => void;
  'run:kill': (payload: { runId: string }) => void;
}

export interface RunServerToClient {
  /** Broadcast to the whole project room so everyone sees the same terminal. */
  'run:started': (payload: {
    runId: string;
    by: UserDto;
    language: LanguageId;
    entrypoint: string;
    interactive: boolean;
  }) => void;
  'run:queued': (payload: { runId: string; position: number }) => void;
  'run:status': (payload: { runId: string; phase: 'compiling' | 'running' }) => void;
  'run:stdout': (payload: { runId: string; chunk: string }) => void;
  'run:stderr': (payload: { runId: string; chunk: string }) => void;
  'run:truncated': (payload: { runId: string; limitBytes: number }) => void;
  'run:exit': (payload: {
    runId: string;
    status: RunStatus;
    exitCode: number | null;
    compileMs: number | null;
    runMs: number | null;
    reason?: string;
  }) => void;
  'codexa:error': (payload: { code: ErrorCode; message: string; context?: string }) => void;
}

// ─── /rtc ─────────────────────────────────────────────────────────────────────

export interface RtcPeer {
  peerId: string;
  user: UserDto;
  media: RtcMediaState;
}

export interface RtcMediaState {
  audio: boolean;
  video: boolean;
  screen: boolean;
}

export interface RtcClientToServer {
  'rtc:join': (
    payload: { projectId: string; media: RtcMediaState },
    ack: (res: Ack<{ peerId: string; peers: RtcPeer[] }>) => void,
  ) => void;
  'rtc:leave': (payload: { projectId: string }) => void;
  'rtc:offer': (payload: { to: string; sdp: string }) => void;
  'rtc:answer': (payload: { to: string; sdp: string }) => void;
  'rtc:ice': (payload: { to: string; candidate: unknown }) => void;
  'rtc:media-state': (payload: { projectId: string; media: RtcMediaState }) => void;
}

export interface RtcServerToClient {
  'rtc:peer-joined': (payload: { peer: RtcPeer }) => void;
  'rtc:peer-left': (payload: { peerId: string }) => void;
  'rtc:offer': (payload: { from: string; sdp: string }) => void;
  'rtc:answer': (payload: { from: string; sdp: string }) => void;
  'rtc:ice': (payload: { from: string; candidate: unknown }) => void;
  'rtc:media-state': (payload: { peerId: string; media: RtcMediaState }) => void;
  'codexa:error': (payload: { code: ErrorCode; message: string; context?: string }) => void;
}

/**
 * Data attached to every authenticated socket by the auth middleware.
 * Declared here so both sides agree on what a socket "knows".
 */
export interface SocketAuthData {
  userId: string;
  user: UserDto;
  /** projectId -> resolved role, cached at join and invalidated by `acl:changed`. */
  roles: Map<string, Role>;
}
