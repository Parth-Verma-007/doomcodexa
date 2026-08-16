import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { adminRouter } from './admin.js';
import { authRouter } from './auth.js';
import { meRouter } from './me.js';
import { projectsRouter } from './projects.js';
import { filesRouter, projectFilesRouter } from './files.js';
import { config } from '../../config.js';

export const apiRouter: Router = Router();

// A blunt ceiling on the API as a whole. Execution has its own, much tighter,
// per-user limit (§8) — this one only exists to stop a single client hammering
// the box.
apiRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: config.isProduction ? 300 : 10_000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many requests. Slow down.' } },
  }),
);

// The only routes that do not require a session — and the only ones that mint one.
apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
// Read-only, and 404s for anyone not in ADMIN_EMAILS.
apiRouter.use('/admin', adminRouter);
apiRouter.use('/projects/:projectId/files', projectFilesRouter);
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/files', filesRouter);
