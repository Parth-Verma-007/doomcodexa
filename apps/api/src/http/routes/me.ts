import { Router } from 'express';
import { updateMeSchema } from '@codexa/shared';
import { asyncHandler } from '../errors.js';
import { currentUser, requireAuth } from '../../auth/context.js';
import { toUserDto } from '../../db/models/index.js';

export const meRouter: Router = Router();

meRouter.use(requireAuth);

meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({
      user: toUserDto(user),
      email: user.email,
      preferences: user.preferences,
    });
  }),
);

meRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { preferences } = updateMeSchema.parse(req.body);

    // Assign field by field: a wholesale replace would wipe any preference the
    // client's build doesn't know about yet.
    for (const [key, value] of Object.entries(preferences)) {
      if (value !== undefined) {
        (user.preferences as unknown as Record<string, unknown>)[key] = value;
      }
    }
    await user.save();

    res.json({ preferences: user.preferences });
  }),
);
