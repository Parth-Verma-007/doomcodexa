import { type Types } from 'mongoose';
import {
  LIMITS,
  type CreateFileInput,
  type FileDto,
  type UpdateFileInput,
  isUnder,
  joinPath,
  languageOf,
  rebase,
} from '@codexa/shared';
import { File, Project, toFileDto, type FileDoc, type ProjectDoc } from '../db/models/index.js';
import { ApiError } from '../http/errors.js';
import { createDocument, deleteDocuments } from './documents.js';

/**
 * File-tree operations.
 *
 * The invariant this module exists to protect: `path` is always exactly the
 * concatenation of the node's ancestors' names. Every mutation that can break
 * that (create, rename, move, delete) lives here, and each one rewrites the
 * affected subtree in a single bulk write.
 */

export async function listFiles(project: ProjectDoc): Promise<FileDto[]> {
  const files = await File.find({ projectId: project._id }).sort({ path: 1 });
  const entrypoint = project.entrypointFileId ? String(project.entrypointFileId) : null;
  return files.map((f) => toFileDto(f, entrypoint));
}

async function resolveParent(
  projectId: Types.ObjectId,
  parentId: string | null,
): Promise<FileDoc | null> {
  if (!parentId) return null;
  const parent = await File.findOne({ _id: parentId, projectId });
  if (!parent) throw ApiError.notFound('Parent folder not found.');
  if (parent.type !== 'folder') throw ApiError.badRequest('Parent must be a folder.');
  return parent;
}

export async function createFile(
  project: ProjectDoc,
  userId: Types.ObjectId,
  input: CreateFileInput,
): Promise<FileDoc> {
  const count = await File.countDocuments({ projectId: project._id });
  if (count >= LIMITS.MAX_FILES_PER_PROJECT) {
    throw ApiError.badRequest(
      `A project cannot hold more than ${LIMITS.MAX_FILES_PER_PROJECT} files.`,
    );
  }

  const parent = await resolveParent(project._id, input.parentId);
  // `joinPath` validates the segment and the resulting depth, and throws
  // PathError -> 400 if the name is illegal.
  const path = joinPath(parent?.path ?? '/', input.name);

  const content = input.content ?? '';
  const file = new File({
    projectId: project._id,
    parentId: parent?._id ?? null,
    name: input.name,
    type: input.type,
    path,
    language: input.type === 'file' ? languageOf(input.name) : null,
    size: content.length,
    createdBy: userId,
  });

  try {
    await file.save();
  } catch (err) {
    // The unique {projectId, path} index is the real guard against duplicates.
    if (isDuplicateKey(err)) {
      throw ApiError.conflict(`"${input.name}" already exists here.`);
    }
    throw err;
  }

  if (input.type === 'file') {
    await createDocument(String(file._id), String(project._id), content);
    // The first runnable file a project gets becomes its entrypoint, so a new
    // project's Run button works without the user configuring anything.
    if (!project.entrypointFileId && file.language === project.defaultLanguage) {
      project.entrypointFileId = file._id;
      await project.save();
    }
  }

  return file;
}

/**
 * Rename and/or move a node, rewriting every descendant's path.
 *
 * Two failure modes this guards against:
 *   1. Moving a folder into its own descendant, which orphans the subtree.
 *   2. A rename that collides with an existing sibling.
 */
export async function updateFile(
  project: ProjectDoc,
  fileId: string,
  input: UpdateFileInput,
): Promise<{ file: FileDoc; previousPath: string }> {
  const file = await File.findOne({ _id: fileId, projectId: project._id });
  if (!file) throw ApiError.notFound('File not found.');

  const previousPath = file.path;
  const nextName = input.name ?? file.name;

  const parentChanged = input.parentId !== undefined;
  const parent = parentChanged
    ? await resolveParent(project._id, input.parentId ?? null)
    : await resolveParent(project._id, file.parentId ? String(file.parentId) : null);

  if (parent && file.type === 'folder' && isUnder(parent.path, file.path)) {
    throw ApiError.badRequest('A folder cannot be moved inside itself.');
  }

  const nextPath = joinPath(parent?.path ?? '/', nextName);
  if (nextPath === previousPath) return { file, previousPath };

  const collision = await File.exists({ projectId: project._id, path: nextPath });
  if (collision) throw ApiError.conflict(`"${nextName}" already exists there.`);

  file.name = nextName;
  file.parentId = parent?._id ?? null;
  file.path = nextPath;
  if (file.type === 'file') file.language = languageOf(nextName);

  // Rewrite descendants before saving the node itself: if the bulk write fails,
  // the tree is still consistent under the old path.
  if (file.type === 'folder') {
    const descendants = await File.find({
      projectId: project._id,
      path: { $regex: `^${escapeRegex(previousPath)}/` },
    }).select('_id path');

    if (descendants.length > 0) {
      await File.bulkWrite(
        descendants.map((d) => ({
          updateOne: {
            filter: { _id: d._id },
            update: { $set: { path: rebase(d.path, previousPath, nextPath) } },
          },
        })),
      );
    }
  }

  try {
    await file.save();
  } catch (err) {
    if (isDuplicateKey(err)) throw ApiError.conflict(`"${nextName}" already exists there.`);
    throw err;
  }

  return { file, previousPath };
}

/** Delete a node and everything under it. Returns every deleted id. */
export async function deleteFile(project: ProjectDoc, fileId: string): Promise<string[]> {
  const file = await File.findOne({ _id: fileId, projectId: project._id });
  if (!file) throw ApiError.notFound('File not found.');

  const doomed =
    file.type === 'folder'
      ? await File.find({
          projectId: project._id,
          $or: [{ _id: file._id }, { path: { $regex: `^${escapeRegex(file.path)}/` } }],
        }).select('_id')
      : [file];

  const ids = doomed.map((d) => String(d._id));

  await File.deleteMany({ _id: { $in: ids } });
  await deleteDocuments(ids);

  // Deleting the entrypoint leaves the project without a Run target; clear it
  // rather than leaving a dangling reference the Run button would 404 on.
  if (project.entrypointFileId && ids.includes(String(project.entrypointFileId))) {
    await Project.updateOne({ _id: project._id }, { $set: { entrypointFileId: null } });
    project.entrypointFileId = null;
  }

  return ids;
}

/** A user-supplied path segment must never be interpreted as a regex. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
