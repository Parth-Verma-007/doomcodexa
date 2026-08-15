import { Router } from 'express';
import {
  createProjectSchema,
  joinProjectSchema,
  objectIdSchema,
  paginationSchema,
  shareSettingsSchema,
  updateMemberSchema,
  updateProjectSchema,
} from '@codexa/shared';
import { asyncHandler, ApiError } from '../errors.js';
import { currentProject, currentUser, requireAuth, requireRole } from '../../auth/context.js';
import {
  File,
  Message,
  Run,
  toMessageDto,
  toProjectDto,
  toRunDto,
  toUserDto,
  User,
  roleFor,
} from '../../db/models/index.js';
import {
  createProject,
  deleteProject,
  generateShareToken,
  listMembers,
  listProjectsFor,
  redeemShareToken,
  removeMember,
  setMemberRole,
} from '../../services/projects.js';
import { bus } from '../../realtime/bus.js';

export const projectsRouter: Router = Router();

projectsRouter.use(requireAuth);

// ─── Collection ───────────────────────────────────────────────────────────────

projectsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const projects = await listProjectsFor(user._id);
    res.json({
      projects: projects.map((p) => toProjectDto(p, roleFor(p, user._id) ?? 'viewer')),
    });
  }),
);

projectsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const input = createProjectSchema.parse(req.body);
    const project = await createProject(user, input);
    res.status(201).json({ project: toProjectDto(project, 'owner') });
  }),
);

/**
 * Redeem a share link. Deliberately not under `/:projectId` — the caller has no
 * role yet, so `requireRole` would 404 them before they could join (§10).
 */
projectsRouter.post(
  '/join',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { token } = joinProjectSchema.parse(req.body);
    const { project, role } = await redeemShareToken(token, user);
    bus.aclChanged(String(project._id), role);
    res.json({ project: toProjectDto(project, role) });
  }),
);

// ─── Single project ───────────────────────────────────────────────────────────

projectsRouter.get(
  '/:projectId',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const { project, role } = currentProject(req);
    const [files, members] = await Promise.all([
      File.find({ projectId: project._id }).sort({ path: 1 }),
      listMembers(project),
    ]);
    const entrypoint = project.entrypointFileId ? String(project.entrypointFileId) : null;
    res.json({
      project: toProjectDto(project, role),
      files: files.map((f) => ({
        id: String(f._id),
        projectId: String(f.projectId),
        parentId: f.parentId ? String(f.parentId) : null,
        name: f.name,
        type: f.type,
        path: f.path,
        language: f.language ?? null,
        size: f.size,
        isEntrypoint: entrypoint === String(f._id),
        createdAt: f.createdAt.toISOString(),
        updatedAt: f.updatedAt.toISOString(),
      })),
      members,
    });
  }),
);

projectsRouter.patch(
  '/:projectId',
  requireRole('editor'),
  asyncHandler(async (req, res) => {
    const { project, role } = currentProject(req);
    const input = updateProjectSchema.parse(req.body);

    // Only an owner may change visibility — an editor flipping a project public
    // would be a privilege escalation.
    if (input.isPublic !== undefined && role !== 'owner') {
      throw ApiError.forbidden('Only the owner can change visibility.');
    }

    if (input.entrypointFileId) {
      const exists = await File.exists({ _id: input.entrypointFileId, projectId: project._id });
      if (!exists) throw ApiError.badRequest('That file is not in this project.');
    }

    if (input.name !== undefined) project.name = input.name;
    if (input.description !== undefined) project.description = input.description;
    if (input.defaultLanguage !== undefined) project.defaultLanguage = input.defaultLanguage;
    if (input.entrypointFileId !== undefined) {
      project.entrypointFileId = input.entrypointFileId
        ? (input.entrypointFileId as unknown as typeof project.entrypointFileId)
        : null;
    }
    if (input.isPublic !== undefined) project.isPublic = input.isPublic;
    if (input.settings) {
      if (input.settings.tabSize !== undefined) project.settings.tabSize = input.settings.tabSize;
      if (input.settings.theme !== undefined) project.settings.theme = input.settings.theme;
    }

    await project.save();

    const dto = toProjectDto(project, role);
    const { myRole: _myRole, shareToken: _shareToken, ...broadcastable } = dto;
    bus.projectUpdated(String(project._id), broadcastable);

    res.json({ project: dto });
  }),
);

projectsRouter.delete(
  '/:projectId',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const { project } = currentProject(req);
    const projectId = String(project._id);
    await deleteProject(project);
    await bus.evictFromProject(projectId);
    res.status(204).end();
  }),
);

// ─── Sharing ──────────────────────────────────────────────────────────────────

projectsRouter.post(
  '/:projectId/share',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const { project, role } = currentProject(req);
    const { role: shareRole } = shareSettingsSchema.parse(req.body ?? {});
    // Overwriting the token is what "rotate" means — old links die immediately.
    project.shareToken = generateShareToken();
    project.shareRole = shareRole;
    await project.save();
    res.json({ project: toProjectDto(project, role) });
  }),
);

projectsRouter.delete(
  '/:projectId/share',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const { project, role } = currentProject(req);
    project.shareToken = null;
    await project.save();
    res.json({ project: toProjectDto(project, role) });
  }),
);

// ─── Members ──────────────────────────────────────────────────────────────────

projectsRouter.get(
  '/:projectId/members',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const { project } = currentProject(req);
    res.json({ members: await listMembers(project) });
  }),
);

projectsRouter.patch(
  '/:projectId/members/:userId',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const { project } = currentProject(req);
    const userId = objectIdSchema.parse(req.params.userId);
    const { role } = updateMemberSchema.parse(req.body);
    await setMemberRole(project, userId, role);
    bus.aclChanged(String(project._id), role);
    res.json({ members: await listMembers(project) });
  }),
);

projectsRouter.delete(
  '/:projectId/members/:userId',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const { project, role } = currentProject(req);
    const targetId = objectIdSchema.parse(req.params.userId);
    const me = String(currentUser(req)._id);

    // Anyone may remove themselves (leave); removing someone else needs owner.
    if (targetId !== me && role !== 'owner') {
      throw ApiError.forbidden('Only the owner can remove another member.');
    }

    await removeMember(project, targetId);
    await bus.evictFromProject(String(project._id), targetId);
    res.status(204).end();
  }),
);

// ─── Run history and chat ─────────────────────────────────────────────────────

projectsRouter.get(
  '/:projectId/runs',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const { project } = currentProject(req);
    const { limit } = paginationSchema.parse(req.query);

    const runs = await Run.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(limit);
    const users = await User.find({ _id: { $in: runs.map((r) => r.triggeredBy) } });
    const byId = new Map(users.map((u) => [String(u._id), toUserDto(u)]));

    res.json({ runs: runs.map((r) => toRunDto(r, byId.get(String(r.triggeredBy)) ?? null)) });
  }),
);

projectsRouter.get(
  '/:projectId/messages',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const { project } = currentProject(req);
    const { limit, before } = paginationSchema.parse(req.query);

    const filter: Record<string, unknown> = { projectId: project._id };
    if (before) filter.createdAt = { $lt: new Date(before) };

    // `before` is a Zod-validated date string; the `$lt` wrapper is ours.
    const messages = await Message.find(filter).sort({ createdAt: -1 }).limit(limit);
    const users = await User.find({ _id: { $in: messages.map((m) => m.authorId) } });
    const byId = new Map(users.map((u) => [String(u._id), toUserDto(u)]));

    res.json({
      // Reverse so the client receives them oldest-first for rendering.
      messages: messages
        .reverse()
        .map((m) => {
          const author = byId.get(String(m.authorId));
          return author ? toMessageDto(m, author) : null;
        })
        .filter(Boolean),
    });
  }),
);
