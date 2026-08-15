import { Router } from 'express';
import { createFileSchema, objectIdSchema, updateFileSchema } from '@codexa/shared';
import { asyncHandler, ApiError } from '../errors.js';
import { currentProject, currentUser, requireAuth, requireRole } from '../../auth/context.js';
import { File, Project, roleFor, toFileDto } from '../../db/models/index.js';
import { createFile, deleteFile, listFiles, updateFile } from '../../services/files.js';
import { getPlainText } from '../../services/documents.js';
import { bus } from '../../realtime/bus.js';
import { atLeast, type Role } from '@codexa/shared';

/**
 * Two routers: collection routes hang off `/projects/:projectId/files` where
 * `requireRole` can resolve the project from the URL, and item routes hang off
 * `/files/:fileId` where the project has to be looked up via the file.
 */

export const projectFilesRouter: Router = Router({ mergeParams: true });

projectFilesRouter.use(requireAuth);

projectFilesRouter.get(
  '/',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const { project } = currentProject(req);
    res.json({ files: await listFiles(project) });
  }),
);

projectFilesRouter.post(
  '/',
  requireRole('editor'),
  asyncHandler(async (req, res) => {
    const { project } = currentProject(req);
    const input = createFileSchema.parse(req.body);
    const file = await createFile(project, currentUser(req)._id, input);

    const dto = toFileDto(file, project.entrypointFileId ? String(project.entrypointFileId) : null);
    bus.fileCreated(String(project._id), dto);

    res.status(201).json({ file: dto });
  }),
);

// ─── Item routes ──────────────────────────────────────────────────────────────

export const filesRouter: Router = Router();

filesRouter.use(requireAuth);

/**
 * Resolve `:fileId` -> its project, then apply the role check. Written as a
 * middleware factory so every item route states its permission requirement
 * explicitly at the router, the same way the project routes do.
 */
function requireFileRole(required: Role) {
  return asyncHandler(async (req, _res, next) => {
    const fileId = objectIdSchema.parse(req.params.fileId);
    const file = await File.findById(fileId);
    if (!file) throw ApiError.notFound('File not found.');

    const project = await Project.findById(file.projectId);
    if (!project) throw ApiError.notFound('File not found.');

    const role = roleFor(project, currentUser(req)._id);
    // No role at all -> 404, so file ids are not enumerable.
    if (!role) throw ApiError.notFound('File not found.');
    if (!atLeast(role, required)) {
      throw ApiError.forbidden(`This action requires the ${required} role.`);
    }

    req.project = project;
    req.projectRole = role;
    next();
  });
}

filesRouter.get(
  '/:fileId/content',
  requireFileRole('viewer'),
  asyncHandler(async (req, res) => {
    const fileId = objectIdSchema.parse(req.params.fileId);
    // The derived cache, not the CRDT — used only for the initial paint before
    // the socket sync completes, and for viewers who never open a doc room.
    res.json({ content: await getPlainText(fileId) });
  }),
);

filesRouter.patch(
  '/:fileId',
  requireFileRole('editor'),
  asyncHandler(async (req, res) => {
    const { project } = currentProject(req);
    const fileId = objectIdSchema.parse(req.params.fileId);
    const input = updateFileSchema.parse(req.body);

    const { file, previousPath } = await updateFile(project, fileId, input);
    const dto = toFileDto(file, project.entrypointFileId ? String(project.entrypointFileId) : null);
    bus.fileUpdated(String(project._id), dto, previousPath);

    res.json({ file: dto });
  }),
);

filesRouter.delete(
  '/:fileId',
  requireFileRole('editor'),
  asyncHandler(async (req, res) => {
    const { project } = currentProject(req);
    const fileId = objectIdSchema.parse(req.params.fileId);

    const deletedIds = await deleteFile(project, fileId);
    bus.filesDeleted(String(project._id), deletedIds);

    res.json({ deletedIds });
  }),
);
