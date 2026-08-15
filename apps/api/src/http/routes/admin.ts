import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../../config.js';
import { asyncHandler, ApiError } from '../errors.js';
import { currentUser, requireAuth } from '../../auth/context.js';
import { File, Message, Project, Run, User, toUserDto } from '../../db/models/index.js';
import { getExecutionEngine } from '../../execution/index.js';

/**
 * The admin panel's data.
 *
 * Read-only by design. Every destructive operation an admin might want —
 * deleting a project, removing a member — already exists as an owner-scoped
 * route with its own checks. Adding admin overrides would mean a second
 * authorisation path around the same objects, which is how the two paths drift
 * and one of them ends up wrong.
 */
export const adminRouter: Router = Router();

adminRouter.use(requireAuth);

/**
 * 404, not 403.
 *
 * The same convention the project routes use: a non-admin gets the response
 * they would get if the route did not exist, so its existence is not
 * discoverable by probing.
 */
function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const user = currentUser(req);
  const email = (user.email ?? '').toLowerCase();
  if (!email || !config.adminEmails.has(email)) {
    next(ApiError.notFound('Not found.'));
    return;
  }
  next();
}

adminRouter.use(requireAdmin);

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [users, projects, files, runs, runsToday, recentRuns, byLanguage, byStatus, newestUsers] =
      await Promise.all([
        User.estimatedDocumentCount(),
        Project.estimatedDocumentCount(),
        File.estimatedDocumentCount(),
        Run.estimatedDocumentCount(),
        Run.countDocuments({ createdAt: { $gte: since } }).setOptions({ sanitizeFilter: false }),
        Run.find().sort({ createdAt: -1 }).limit(10),
        Run.aggregate<{ _id: string; count: number }>([
          { $group: { _id: '$language', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        Run.aggregate<{ _id: string; count: number }>([
          { $group: { _id: '$status', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        User.find().sort({ createdAt: -1 }).limit(8),
      ]);

    // One lookup for the run authors rather than one per row.
    const authorIds = [...new Set(recentRuns.map((r) => String(r.triggeredBy)))];
    const authors = await User.find({ _id: { $in: authorIds } });
    const authorById = new Map(authors.map((u) => [String(u._id), toUserDto(u)]));

    const engine = getExecutionEngine();
    const stats = engine.stats();

    res.json({
      totals: { users, projects, files, runs, runsToday },
      execution: {
        available: engine.isAvailable(),
        unavailableReason: engine.unavailableReason(),
        active: stats.active,
        queued: stats.queued,
      },
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        rssBytes: process.memoryUsage().rss,
        env: config.env,
      },
      runsByLanguage: byLanguage.map((r) => ({ language: r._id, count: r.count })),
      runsByStatus: byStatus.map((r) => ({ status: r._id, count: r.count })),
      recentRuns: recentRuns.map((r) => ({
        id: String(r._id),
        language: r.language,
        status: r.status,
        entrypoint: r.entrypoint,
        runMs: r.runMs ?? null,
        by: authorById.get(String(r.triggeredBy)) ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      newestUsers: newestUsers.map((u) => ({
        ...toUserDto(u),
        email: u.email,
        createdAt: u.createdAt.toISOString(),
      })),
      messages: await Message.estimatedDocumentCount(),
    });
  }),
);
