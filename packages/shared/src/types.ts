import type { LanguageId } from './constants.js';

// ─── Roles ────────────────────────────────────────────────────────────────────

export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Higher wins. Used by `atLeast` so permission checks stay declarative. */
const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function atLeast(role: Role | null | undefined, required: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function canEdit(role: Role | null | undefined): boolean {
  return atLeast(role, 'editor');
}

export function canAdminister(role: Role | null | undefined): boolean {
  return atLeast(role, 'owner');
}

// ─── DTOs (what crosses the wire; never a raw Mongo document) ─────────────────

export interface UserDto {
  id: string;
  username: string;
  avatarUrl: string | null;
  /** Stable presence colour, assigned once at user creation. */
  color: string;
}

export interface MemberDto {
  user: UserDto;
  role: Role;
  addedAt: string;
}

export interface ProjectSettings {
  tabSize: number;
  theme: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  defaultLanguage: LanguageId;
  entrypointFileId: string | null;
  settings: ProjectSettings;
  isPublic: boolean;
  /** Only ever populated for an owner. */
  shareToken: string | null;
  shareRole: Exclude<Role, 'owner'>;
  memberCount: number;
  /** The requesting user's role on this project. */
  myRole: Role;
  createdAt: string;
  updatedAt: string;
}

export type FileType = 'file' | 'folder';

export interface FileDto {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  type: FileType;
  /** Denormalised absolute path, e.g. `/src/main.cpp`. Always leading-slash. */
  path: string;
  language: LanguageId | null;
  size: number;
  isEntrypoint: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Client-side view; the API returns a flat list and the client nests it. */
export interface FileNode extends FileDto {
  children: FileNode[];
}

export interface MessageDto {
  id: string;
  projectId: string;
  author: UserDto;
  body: string;
  createdAt: string;
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export const RUN_STATUSES = [
  'queued',
  'compiling',
  'running',
  'success',
  'error',
  'timeout',
  'killed',
  'oom',
  'failed',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** A run has finished when it reaches one of these. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'success',
  'error',
  'timeout',
  'killed',
  'oom',
  'failed',
];

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface RunDto {
  id: string;
  projectId: string;
  triggeredBy: UserDto | null;
  language: LanguageId;
  entrypoint: string;
  status: RunStatus;
  exitCode: number | null;
  compileMs: number | null;
  runMs: number | null;
  outputTail: string;
  truncated: boolean;
  createdAt: string;
  finishedAt: string | null;
}

/** One file handed to the executor. Paths are already sanitised. */
export interface RunFile {
  path: string;
  content: string;
}

export interface RunSpec {
  runId: string;
  projectId: string;
  language: LanguageId;
  /** Relative path of the file to compile/run, e.g. `src/main.cpp`. */
  entrypoint: string;
  files: RunFile[];
  /** Pre-supplied stdin for non-interactive runs. */
  stdin?: string;
  interactive: boolean;
}

/** What the ExecutionEngine yields. Mapped 1:1 onto socket events. */
export type RunEvent =
  | { type: 'queued'; position: number }
  | { type: 'status'; phase: 'compiling' | 'running'; at: number }
  | { type: 'stdout'; chunk: string }
  | { type: 'stderr'; chunk: string }
  | { type: 'truncated'; limitBytes: number }
  | {
      type: 'exit';
      status: RunStatus;
      exitCode: number | null;
      compileMs: number | null;
      runMs: number | null;
      /** Human-readable explanation for non-success terminal states. */
      reason?: string;
    };

// ─── Presence ─────────────────────────────────────────────────────────────────

/** The shape stored in Yjs awareness. Ephemeral — never persisted. */
export interface AwarenessState {
  user: UserDto;
  role: Role;
  activeFileId: string | null;
  cursor: { anchor: number; head: number } | null;
  /** Broadcast for follow mode (§7). */
  scrollTop?: number;
}

export interface PresencePeer {
  socketId: string;
  user: UserDto;
  role: Role;
  activeFileId: string | null;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'validation_failed',
  'rate_limited',
  'payload_too_large',
  'internal',
  'unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/** Acknowledgement envelope used by socket events that need a reply. */
export type Ack<T = void> =
  { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } };
