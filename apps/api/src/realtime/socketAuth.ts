import type { Namespace, Socket } from 'socket.io';
import { atLeast, type Role, type UserDto } from '@codexa/shared';
import { TokenError, verifySessionToken } from '../auth/clerk.js';
import { resolveUser } from '../auth/users.js';
import { Project, roleFor, toUserDto } from '../db/models/index.js';
import { logger } from '../observability/logger.js';

/**
 * Socket authentication and per-event authorisation.
 *
 * Two things here matter more than they look:
 *
 *   1. Clerk session tokens are short-lived (~60s). When one expires we send a
 *      distinguishable reason so the client refreshes and reconnects instead of
 *      bouncing the user to a sign-in page (§10).
 *
 *   2. Roles are checked on EVERY mutating event, not just at join. A socket
 *      that joined as a viewer can still emit `sync:update`; the check has to
 *      be at the event, or read-only is decorative (§10).
 */

declare module 'socket.io' {
  interface SocketData {
    userId: string;
    user: UserDto;
    /** projectId -> role, resolved at join and invalidated by `acl:changed`. */
    roles: Map<string, Role>;
  }
}

export function installAuth(namespace: Namespace): void {
  namespace.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;

    void (async () => {
      try {
        const { clerkId } = await verifySessionToken(token);
        const user = await resolveUser(clerkId);

        socket.data.userId = String(user._id);
        socket.data.user = toUserDto(user);
        socket.data.roles = new Map();

        next();
      } catch (err) {
        if (err instanceof TokenError) {
          // The `data` field survives to the client as `err.data`, which is how
          // it tells "refresh my token" apart from "you are signed out".
          const failure = Object.assign(new Error(err.message), {
            data: { reason: err.reason },
          });
          next(failure);
          return;
        }
        logger.error({ err }, 'socket authentication failed unexpectedly');
        next(new Error('Authentication failed.'));
      }
    })();
  });
}

/**
 * Resolve and cache the caller's role on a project.
 *
 * Cached on `socket.data` so a keystroke does not cost a database read; the
 * cache is dropped when membership changes (see `bus.aclChanged`).
 */
export async function resolveRole(socket: Socket, projectId: string): Promise<Role | null> {
  const cached = socket.data.roles.get(projectId);
  if (cached) return cached;

  const project = await Project.findById(projectId).select('ownerId members isPublic');
  if (!project) return null;

  const role = roleFor(project as never, socket.data.userId);
  if (role) socket.data.roles.set(projectId, role);
  return role;
}

export function invalidateRole(socket: Socket, projectId: string): void {
  socket.data.roles.delete(projectId);
}

/**
 * Assert a role, emitting a structured error to the caller when it fails.
 * Returns false when the caller should be ignored — call sites read as
 * `if (!(await ensureRole(...))) return;`.
 */
export async function ensureRole(
  socket: Socket,
  projectId: string,
  required: Role,
  context: string,
): Promise<boolean> {
  const role = await resolveRole(socket, projectId);

  if (!role) {
    socket.emit('codexa:error', {
      code: 'not_found',
      message: 'Project not found.',
      context,
    });
    return false;
  }

  if (!atLeast(role, required)) {
    socket.emit('codexa:error', {
      code: 'forbidden',
      message:
        required === 'editor'
          ? 'You have read-only access to this project.'
          : `This action requires the ${required} role.`,
      context,
    });
    return false;
  }

  return true;
}
