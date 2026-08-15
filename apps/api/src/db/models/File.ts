import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { LANGUAGE_IDS, type FileDto } from '@codexa/shared';

/**
 * The virtual project filesystem.
 *
 * Flat collection with a `parentId` pointer rather than nested subdocuments
 * (§6): nesting would hit Mongo's 16MB document cap on a large project and
 * makes single-file updates rewrite the whole tree.
 *
 * `path` is denormalised for fast lookup and for materialising a workspace
 * before a run. It is maintained transactionally with `parentId` — see
 * `services/files.ts`.
 */

const fileSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'File', default: null },
    name: { type: String, required: true, maxlength: 128 },
    type: { type: String, enum: ['file', 'folder'], required: true },
    path: { type: String, required: true },
    language: { type: String, enum: [...LANGUAGE_IDS, null], default: null },
    size: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

fileSchema.index({ projectId: 1, parentId: 1 });
// Two files cannot share a path within a project. This is the real guard
// against duplicate names — the application-level check is just for a nicer
// error message and races past it land here.
fileSchema.index({ projectId: 1, path: 1 }, { unique: true });

export type FileAttrs = InferSchemaType<typeof fileSchema>;
export type FileDoc = HydratedDocument<FileAttrs>;

export const File = model('File', fileSchema);

export function toFileDto(file: FileDoc, entrypointFileId: string | null): FileDto {
  return {
    id: String(file._id),
    projectId: String(file.projectId),
    parentId: file.parentId ? String(file.parentId) : null,
    name: file.name,
    type: file.type as FileDto['type'],
    path: file.path,
    language: (file.language ?? null) as FileDto['language'],
    size: file.size,
    isEntrypoint: entrypointFileId !== null && String(file._id) === entrypointFileId,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}
