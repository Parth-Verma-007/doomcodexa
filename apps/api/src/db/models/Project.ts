import { Schema, type Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { LANGUAGE_IDS, ROLES, type ProjectDto, type Role, type UserDto } from '@codexa/shared';

const memberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, required: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const settingsSchema = new Schema(
  {
    tabSize: { type: Number, default: 4, min: 2, max: 8 },
    theme: { type: String, default: 'codexa-dark' },
  },
  { _id: false },
);

const projectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: null, maxlength: 500 },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    defaultLanguage: { type: String, enum: LANGUAGE_IDS, required: true },
    /** Which file the Run button targets. Null until the first file exists. */
    entrypointFileId: { type: Schema.Types.ObjectId, ref: 'File', default: null },
    members: { type: [memberSchema], default: [] },
    /** 32 bytes of URL-safe randomness, or null when sharing is off (§10). */
    shareToken: { type: String, default: null },
    shareRole: { type: String, enum: ['editor', 'viewer'], default: 'editor' },
    isPublic: { type: Boolean, default: false },
    settings: { type: settingsSchema, default: () => ({}) },
  },
  { timestamps: true },
);

projectSchema.index({ ownerId: 1, updatedAt: -1 });
projectSchema.index({ 'members.userId': 1, updatedAt: -1 });
// A partial index, NOT a sparse one. `sparse` only excludes documents where the
// field is *absent*, and `shareToken` defaults to an explicit `null` — so a
// sparse unique index lets exactly one project exist without a share link and
// rejects every one after it with a duplicate-key error.
projectSchema.index(
  { shareToken: 1 },
  { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } },
);

export type ProjectAttrs = InferSchemaType<typeof projectSchema>;
export type ProjectDoc = HydratedDocument<ProjectAttrs>;

export const Project = model('Project', projectSchema);

/** The requesting user's role, or null if they have none. */
export function roleFor(project: ProjectDoc, userId: Types.ObjectId | string): Role | null {
  const id = String(userId);
  if (String(project.ownerId) === id) return 'owner';
  const member = project.members.find((m) => String(m.userId) === id);
  if (member) return member.role as Role;
  // A public project is readable by any signed-in user.
  return project.isPublic ? 'viewer' : null;
}

/**
 * The membership list with each user appearing once, earliest entry winning.
 *
 * The write path adds members atomically so it cannot record anyone twice, but
 * documents written before that guard existed can still hold a repeat, and a
 * person shown twice — or counted twice — is worse than one shown late. Every
 * read that surfaces members to a client goes through here.
 */
export function distinctMembers(project: ProjectDoc): ProjectDoc['members'] {
  const seen = new Set<string>();
  return project.members.filter((m) => {
    const id = String(m.userId);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }) as ProjectDoc['members'];
}

export function toProjectDto(
  project: ProjectDoc,
  myRole: Role,
  /** Member faces for a card. Omitted where the caller has no cheap way to load them. */
  members: UserDto[] = [],
): ProjectDto {
  return {
    id: String(project._id),
    name: project.name,
    description: project.description ?? null,
    ownerId: String(project.ownerId),
    defaultLanguage: project.defaultLanguage as ProjectDto['defaultLanguage'],
    entrypointFileId: project.entrypointFileId ? String(project.entrypointFileId) : null,
    settings: {
      tabSize: project.settings?.tabSize ?? 4,
      theme: project.settings?.theme ?? 'codexa-dark',
    },
    isPublic: project.isPublic,
    // The share token is a bearer credential: only ever expose it to an owner.
    shareToken: myRole === 'owner' ? (project.shareToken ?? null) : null,
    shareRole: (project.shareRole ?? 'editor') as ProjectDto['shareRole'],
    memberCount: distinctMembers(project).length,
    members,
    myRole,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
