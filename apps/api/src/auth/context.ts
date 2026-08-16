import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { atLeast, type Role } from '@codexa/shared';
import { ApiError } from '../http/errors.js';
import { resolveSession } from './sessions.js';
import { Project, roleFor, type ProjectDoc, type UserDoc } from '../db/models/index.js';
import { objectIdSchema } from '@codexa/shared';

/**
 * Request context: who is calling, and what may they do here.
 *
 * `requireRole` is deliberately a route-level middleware rather than a check
 * inside each handler, so that adding a route without an authorisation
 * decision is visibly wrong at the router.
 */

declare module 'express-serve-static-core' {
  interface Request {
    /** Present after `requireAuth`. */
    currentUser?: UserDoc;
    /** Present after `requireRole`. */
    project?: ProjectDoc;
    projectRole?: Role;
  }
}

/**
 * The session token on a request.
 *
 * `Authorization: Bearer <token>` only — no cookie. The client is a separate
 * origin from the API and talks to it with `fetch` and a WebSocket, so an
 * explicit header is both simpler and immune to CSRF: a browser will not attach
 * it to a cross-site request the way it would a cookie.
 */
export function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (!header) return undefined;

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  resolveSession(bearerToken(req))
    .then((user) => {
      if (!user) return next(ApiError.unauthorized());
      req.currentUser = user;
      next();
    })
    .catch(next);
};

export function currentUser(req: Request): UserDoc {
  if (!req.currentUser) {
    // A programming error, not a client error: requireAuth was not mounted.
    throw new Error('currentUser() called on a route without requireAuth');
  }
  return req.currentUser;
}

/**
 * Load the project named by `:projectId` and assert the caller holds at least
 * `required`. A user with no role at all gets 404 rather than 403 so that
 * project ids are not enumerable.
 */
export function requireRole(required: Role, param = 'projectId'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[param];
    const parsed = objectIdSchema.safeParse(raw);
    if (!parsed.success) return next(ApiError.notFound('Project not found.'));

    Project.findById(parsed.data)
      .then((project) => {
        if (!project) throw ApiError.notFound('Project not found.');

        const role = roleFor(project, currentUser(req)._id);
        if (!role) throw ApiError.notFound('Project not found.');
        if (!atLeast(role, required)) {
          throw ApiError.forbidden(`This action requires the ${required} role.`);
        }

        req.project = project;
        req.projectRole = role;
        next();
      })
      .catch(next);
  };
}

export function currentProject(req: Request): { project: ProjectDoc; role: Role } {
  if (!req.project || !req.projectRole) {
    throw new Error('currentProject() called on a route without requireRole');
  }
  return { project: req.project, role: req.projectRole };
}
