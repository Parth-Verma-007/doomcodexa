import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { LANGUAGES, type CreateProjectInput, type MemberDto, type Role } from '@codexa/shared';
import {
  File,
  Project,
  User,
  toUserDto,
  type ProjectDoc,
  type UserDoc,
} from '../db/models/index.js';
import { ApiError } from '../http/errors.js';
import { createFile } from './files.js';
import { deleteDocuments } from './documents.js';

export async function createProject(user: UserDoc, input: CreateProjectInput): Promise<ProjectDoc> {
  const spec = LANGUAGES[input.language];

  const project = await Project.create({
    name: input.name,
    description: input.description ?? null,
    ownerId: user._id,
    defaultLanguage: input.language,
    members: [{ userId: user._id, role: 'owner', addedAt: new Date() }],
    settings: { tabSize: 4, theme: 'codexa-dark' },
  });

  if (input.useTemplate) {
    // Seeds the starter program and, via createFile, sets it as the entrypoint.
    await createFile(project, user._id, {
      parentId: null,
      name: spec.defaultEntrypoint,
      type: 'file',
      content: spec.template,
    });
  }

  return project;
}

export async function listProjectsFor(userId: Types.ObjectId) {
  return Project.find({
    $or: [{ ownerId: userId }, { 'members.userId': userId }],
  })
    .sort({ updatedAt: -1 })
    .limit(100);
}

export async function deleteProject(project: ProjectDoc): Promise<void> {
  const files = await File.find({ projectId: project._id }).select('_id');
  await deleteDocuments(files.map((f) => String(f._id)));
  await File.deleteMany({ projectId: project._id });
  await Project.deleteOne({ _id: project._id });
}

export async function listMembers(project: ProjectDoc): Promise<MemberDto[]> {
  const ids = project.members.map((m) => m.userId);
  const users = await User.find({ _id: { $in: ids } });
  const byId = new Map(users.map((u) => [String(u._id), u]));

  return project.members
    .map((m) => {
      const user = byId.get(String(m.userId));
      if (!user) return null;
      return {
        user: toUserDto(user),
        role: m.role as Role,
        addedAt: m.addedAt.toISOString(),
      };
    })
    .filter((m): m is MemberDto => m !== null)
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

/**
 * 32 bytes of URL-safe randomness (§10). Rotating simply overwrites it, which
 * instantly invalidates every previously shared link.
 */
export function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function redeemShareToken(
  token: string,
  user: UserDoc,
): Promise<{ project: ProjectDoc; role: Role }> {
  const project = await Project.findOne({ shareToken: token });
  if (!project) throw ApiError.notFound('That share link is no longer valid.');

  const existing = existingRole(project, user._id);
  if (existing) return { project, role: existing };

  // A share token can never confer ownership.
  const role = (project.shareRole ?? 'editor') as Exclude<Role, 'owner'>;
  project.members.push({ userId: user._id, role, addedAt: new Date() });
  await project.save();

  return { project, role };
}

function existingRole(project: ProjectDoc, userId: Types.ObjectId): Role | null {
  if (String(project.ownerId) === String(userId)) return 'owner';
  const member = project.members.find((m) => String(m.userId) === String(userId));
  return member ? (member.role as Role) : null;
}

export async function setMemberRole(
  project: ProjectDoc,
  targetUserId: string,
  role: Exclude<Role, 'owner'>,
): Promise<void> {
  if (String(project.ownerId) === targetUserId) {
    throw ApiError.badRequest("The owner's role cannot be changed.");
  }
  const member = project.members.find((m) => String(m.userId) === targetUserId);
  if (!member) throw ApiError.notFound('That user is not a member.');

  member.role = role;
  await project.save();
}

export async function removeMember(project: ProjectDoc, targetUserId: string): Promise<void> {
  if (String(project.ownerId) === targetUserId) {
    throw ApiError.badRequest('The owner cannot be removed. Delete the project instead.');
  }
  // `$pull` rather than reassigning the array: Mongoose's DocumentArray is not
  // a plain array, and replacing it wholesale loses its subdocument tracking.
  await Project.updateOne(
    { _id: project._id },
    { $pull: { members: { userId: new Types.ObjectId(targetUserId) } } },
  );
  project.members.pull({ userId: new Types.ObjectId(targetUserId) });
}
