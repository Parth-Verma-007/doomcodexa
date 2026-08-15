import type { Server } from 'socket.io';
import {
  NS,
  rooms,
  type FileDto,
  type MessageDto,
  type ProjectDto,
  type Role,
} from '@codexa/shared';

/**
 * A one-way bridge from the REST layer to connected sockets.
 *
 * REST mutates the file tree; sockets must hear about it immediately (§7). The
 * alternative — importing the Socket.IO server into every route — creates an
 * import cycle, so the server registers itself here at boot and routes call
 * these helpers.
 *
 * Every function is a no-op before `attachBus` runs, which keeps route unit
 * tests free of socket plumbing.
 */

let io: Server | null = null;

export function attachBus(server: Server): void {
  io = server;
}

export function detachBus(): void {
  io = null;
}

function collab() {
  return io?.of(NS.collab) ?? null;
}

export const bus = {
  fileCreated(projectId: string, file: FileDto): void {
    collab()?.to(rooms.project(projectId)).emit('file:created', { file });
  },

  fileUpdated(projectId: string, file: FileDto, previousPath?: string): void {
    collab()
      ?.to(rooms.project(projectId))
      .emit('file:updated', previousPath ? { file, previousPath } : { file });
  },

  filesDeleted(projectId: string, fileIds: string[]): void {
    collab()?.to(rooms.project(projectId)).emit('file:deleted', { fileIds });
  },

  projectUpdated(projectId: string, project: Omit<ProjectDto, 'myRole' | 'shareToken'>): void {
    collab()?.to(rooms.project(projectId)).emit('project:updated', { project });
  },

  /**
   * Membership changed. Clients re-resolve their own permissions rather than
   * trusting the role they were handed at join time (§10).
   */
  aclChanged(projectId: string, role: Role | null): void {
    collab()?.to(rooms.project(projectId)).emit('acl:changed', { projectId, role });
  },

  chatMessage(projectId: string, message: MessageDto): void {
    collab()?.to(rooms.project(projectId)).emit('chat:message', { message });
  },

  /**
   * Force every socket in a project room to drop it — used when a member is
   * removed or the project is deleted, so a stale socket cannot keep receiving
   * updates it is no longer entitled to.
   */
  async evictFromProject(projectId: string, userId?: string): Promise<void> {
    const namespace = collab();
    if (!namespace) return;
    const sockets = await namespace.in(rooms.project(projectId)).fetchSockets();
    for (const socket of sockets) {
      if (userId && socket.data.userId !== userId) continue;
      socket.emit('acl:changed', { projectId, role: null });
      socket.leave(rooms.project(projectId));
      socket.data.roles?.delete(projectId);
    }
  },
};
