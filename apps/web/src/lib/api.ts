import type {
  AdminOverview,
  CreateFileInput,
  CreateProjectInput,
  ErrorCode,
  FileDto,
  MemberDto,
  MessageDto,
  ProjectDto,
  RunDto,
  UpdateFileInput,
  UpdateProjectInput,
  UserDto,
} from '@codexa/shared';
import { env } from './env.js';

/**
 * REST client.
 *
 * The Clerk token getter is registered by a component at mount rather than
 * imported, because `useAuth()` is only available inside the provider tree and
 * this module is also used by non-React code (the socket manager).
 */

type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter = async () => null;

export function registerTokenGetter(getter: TokenGetter): void {
  getToken = getter;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * `body` is omitted from RequestInit before being re-added as `unknown`:
 * intersecting with the built-in `BodyInit` narrows to their intersection,
 * which rejects every plain object we want to send.
 */
async function call<T>(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  // With Clerk bypassed, REST has no token to derive an identity from — the
  // API reads this header instead. It is only honoured while the API's own
  // bypass is on, which it refuses to be in production. Without it, REST would
  // act as the default dev user while sockets acted as `env.devUser`, and the
  // two would disagree about who you are.
  if (env.devBypass) headers.set('x-codexa-test-user', env.devUser);

  let response: Response;
  try {
    response = await fetch(`${env.apiUrl}${path}`, {
      ...init,
      headers,
      credentials: 'include',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    // A network failure is not a server error; say something the user can act on.
    throw new ApiError(0, 'unavailable', 'Could not reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? safeParse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: ErrorCode; message?: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'internal',
      error?.message ?? `Request failed with ${response.status}.`,
      error?.details,
    );
  }

  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface ProjectDetail {
  project: ProjectDto;
  files: FileDto[];
  members: MemberDto[];
}

export const api = {
  me: () =>
    call<{
      user: UserDto;
      email: string;
      isAdmin: boolean;
      preferences: Record<string, unknown>;
    }>('/api/me'),

  adminOverview: () => call<AdminOverview>('/api/admin/overview'),

  updatePreferences: (preferences: Record<string, unknown>) =>
    call<{ preferences: Record<string, unknown> }>('/api/me', {
      method: 'PATCH',
      body: { preferences },
    }),

  listProjects: () => call<{ projects: ProjectDto[] }>('/api/projects'),

  createProject: (input: CreateProjectInput) =>
    call<{ project: ProjectDto }>('/api/projects', { method: 'POST', body: input }),

  getProject: (projectId: string) => call<ProjectDetail>(`/api/projects/${projectId}`),

  updateProject: (projectId: string, input: UpdateProjectInput) =>
    call<{ project: ProjectDto }>(`/api/projects/${projectId}`, { method: 'PATCH', body: input }),

  deleteProject: (projectId: string) =>
    call<void>(`/api/projects/${projectId}`, { method: 'DELETE' }),

  createShareLink: (projectId: string, role: 'editor' | 'viewer') =>
    call<{ project: ProjectDto }>(`/api/projects/${projectId}/share`, {
      method: 'POST',
      body: { role },
    }),

  revokeShareLink: (projectId: string) =>
    call<{ project: ProjectDto }>(`/api/projects/${projectId}/share`, { method: 'DELETE' }),

  joinProject: (token: string) =>
    call<{ project: ProjectDto }>('/api/projects/join', { method: 'POST', body: { token } }),

  listMembers: (projectId: string) =>
    call<{ members: MemberDto[] }>(`/api/projects/${projectId}/members`),

  setMemberRole: (projectId: string, userId: string, role: 'editor' | 'viewer') =>
    call<{ members: MemberDto[] }>(`/api/projects/${projectId}/members/${userId}`, {
      method: 'PATCH',
      body: { role },
    }),

  removeMember: (projectId: string, userId: string) =>
    call<void>(`/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),

  listFiles: (projectId: string) => call<{ files: FileDto[] }>(`/api/projects/${projectId}/files`),

  createFile: (projectId: string, input: CreateFileInput) =>
    call<{ file: FileDto }>(`/api/projects/${projectId}/files`, { method: 'POST', body: input }),

  updateFile: (fileId: string, input: UpdateFileInput) =>
    call<{ file: FileDto }>(`/api/files/${fileId}`, { method: 'PATCH', body: input }),

  deleteFile: (fileId: string) =>
    call<{ deletedIds: string[] }>(`/api/files/${fileId}`, { method: 'DELETE' }),

  fileContent: (fileId: string) => call<{ content: string }>(`/api/files/${fileId}/content`),

  listRuns: (projectId: string, limit = 25) =>
    call<{ runs: RunDto[] }>(`/api/projects/${projectId}/runs?limit=${limit}`),

  listMessages: (projectId: string, limit = 50) =>
    call<{ messages: MessageDto[] }>(`/api/projects/${projectId}/messages?limit=${limit}`),
};
