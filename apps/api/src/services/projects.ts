import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import {
  LANGUAGES,
  type CreateProjectInput,
  type MemberDto,
  type Role,
  type UserDto,
} from '@codexa/shared';
import {
  File,
  Project,
  User,
  distinctMembers,
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

/** How many faces a project card shows before collapsing into "+N". */
const MEMBER_PREVIEW = 4;

/**
 * Member faces for a whole list of projects, in one round trip.
 *
 * The obvious implementation — `listMembers(project)` per card — is a query per
 * project, so a dashboard with twenty projects costs twenty round trips to show
 * a row of avatars. This collects every member id across every project, fetches
 * those users once, and hands back a lookup keyed by project id.
 */
export async function memberPreviewsFor(projects: ProjectDoc[]): Promise<Map<string, UserDto[]>> {
  const previewIds = new Map<string, string[]>();
  const wanted = new Set<string>();

  for (const project of projects) {
    // Distinct first, then capped: slicing the raw array would spend one of the
    // four faces on a repeat, and the client keys avatars by user id.
    const ids = distinctMembers(project)
      .slice(0, MEMBER_PREVIEW)
      .map((m) => String(m.userId));
    previewIds.set(String(project._id), ids);
    for (const id of ids) wanted.add(id);
  }
  if (wanted.size === 0) return new Map();

  const users = await User.find({ _id: { $in: [...wanted] } });
  const byId = new Map(users.map((u) => [String(u._id), toUserDto(u)]));

  const previews = new Map<string, UserDto[]>();
  for (const [projectId, ids] of previewIds) {
    previews.set(
      projectId,
      ids.map((id) => byId.get(id)).filter((u): u is UserDto => u !== undefined),
    );
  }
  return previews;
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

  return distinctMembers(project)
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

  // Atomic, because two redemptions of the same link routinely arrive at once:
  // a double-clicked link, two tabs, a retry — and in development React's
  // StrictMode fires the join effect twice by design. Read-modify-write
  // (`members.push` then `save`) lets both requests read a membership list
  // without the user in it and both append, which records the same person
  // twice. The `$ne` guard makes the push conditional inside the write itself,
  // so the second one matches nothing and changes nothing.
  const updated = await Project.findOneAndUpdate(
    { _id: project._id, 'members.userId': { $ne: user._id } },
    { $push: { members: { userId: user._id, role, addedAt: new Date() } } },
    { new: true },
  );
  if (updated) return { project: updated, role };

  // The guard rejected the write, so someone else added them first. Their role
  // is whatever that winning write chose, which need not be the one we picked.
  const fresh = await Project.findById(project._id);
  if (!fresh) throw ApiError.notFound('That share link is no longer valid.');
  return { project: fresh, role: existingRole(fresh, user._id) ?? role };
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
