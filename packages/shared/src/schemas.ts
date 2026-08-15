import { z } from 'zod';
import { LANGUAGE_IDS, LIMITS } from './constants.js';
import { isValidSegment } from './paths.js';
import { ROLES } from './types.js';

/**
 * Request validation, shared by the Express routes and the client forms so a
 * rejected payload looks identical on both sides (§11).
 */

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex id.');

export const languageSchema = z.enum(LANGUAGE_IDS);
export const roleSchema = z.enum(ROLES);
export const assignableRoleSchema = z.enum(['editor', 'viewer']);

/** A single file or folder name. Delegates to the same validator the DB uses. */
export const segmentSchema = z
  .string()
  .min(1)
  .max(LIMITS.MAX_FILENAME_LENGTH)
  .refine(isValidSegment, {
    message: 'Name contains illegal characters or is reserved.',
  });

// ─── Projects ─────────────────────────────────────────────────────────────────

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.MAX_PROJECT_NAME_LENGTH),
  description: z.string().trim().max(500).optional(),
  language: languageSchema,
  /** Seed the project with the language's starter file. */
  useTemplate: z.boolean().default(true),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.MAX_PROJECT_NAME_LENGTH).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    defaultLanguage: languageSchema.optional(),
    entrypointFileId: objectIdSchema.nullable().optional(),
    isPublic: z.boolean().optional(),
    settings: z
      .object({
        tabSize: z.number().int().min(2).max(8).optional(),
        theme: z.string().max(40).optional(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const shareSettingsSchema = z.object({
  role: assignableRoleSchema.default('editor'),
});

export const joinProjectSchema = z.object({
  token: z.string().min(20).max(200),
});

export const updateMemberSchema = z.object({
  role: assignableRoleSchema,
});

// ─── Files ────────────────────────────────────────────────────────────────────

export const createFileSchema = z.object({
  parentId: objectIdSchema.nullable().default(null),
  name: segmentSchema,
  type: z.enum(['file', 'folder']),
  /** Optional seed content for a new file. */
  content: z.string().max(LIMITS.MAX_DOC_BYTES).optional(),
});
export type CreateFileInput = z.infer<typeof createFileSchema>;

export const updateFileSchema = z
  .object({
    name: segmentSchema.optional(),
    /** `null` moves the node to the project root. `undefined` leaves it put. */
    parentId: objectIdSchema.nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.parentId !== undefined, {
    message: 'Provide a new name or a new parent.',
  });
export type UpdateFileInput = z.infer<typeof updateFileSchema>;

// ─── Chat ─────────────────────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(LIMITS.MAX_CHAT_MESSAGE_LENGTH),
});

// ─── Runs ─────────────────────────────────────────────────────────────────────

export const startRunSchema = z.object({
  projectId: objectIdSchema,
  fileId: objectIdSchema.optional(),
  stdin: z
    .string()
    .max(64 * 1024)
    .optional(),
  interactive: z.boolean().default(true),
});
export type StartRunInput = z.infer<typeof startRunSchema>;

// ─── User preferences ─────────────────────────────────────────────────────────

export const updateMeSchema = z.object({
  preferences: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).optional(),
      fontSize: z.number().int().min(10).max(28).optional(),
      tabSize: z.number().int().min(2).max(8).optional(),
      wordWrap: z.boolean().optional(),
      minimap: z.boolean().optional(),
      vimMode: z.boolean().optional(),
    })
    .partial(),
});
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

// ─── Query params ─────────────────────────────────────────────────────────────

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().datetime().optional(),
});
