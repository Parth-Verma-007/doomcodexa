import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import type { UserDto } from '@codexa/shared';

/**
 * An account.
 *
 * This used to be a mirror of a Clerk user, kept in sync by a webhook. Codexa
 * now owns identity outright: `email` and `username` are the natural keys and
 * `passwordHash` is the credential. Nothing else in the app changed, because
 * every other document already referenced users by ObjectId.
 */

/** Presence colours. Chosen for contrast against both editor themes. */
export const PRESENCE_COLORS = [
  '#e8590c',
  '#2f9e44',
  '#1971c2',
  '#9c36b5',
  '#c2255c',
  '#0c8599',
  '#e67700',
  '#5f3dc4',
] as const;

const preferencesSchema = new Schema(
  {
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    fontSize: { type: Number, default: 14, min: 10, max: 28 },
    tabSize: { type: Number, default: 4, min: 2, max: 8 },
    wordWrap: { type: Boolean, default: false },
    minimap: { type: Boolean, default: false },
    vimMode: { type: Boolean, default: false },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    /**
     * Stored as typed for display, matched case-insensitively at sign-in and
     * against the unique index via a collation — so "Parth" and "parth" cannot
     * both be registered.
     */
    username: { type: String, required: true, trim: true },
    /**
     * `select: false`: a hash is not something any route should hand out by
     * accident, and every read that needs it asks for it explicitly.
     */
    passwordHash: { type: String, required: true, select: false },
    avatarUrl: { type: String, default: null },
    color: { type: String, required: true },
    preferences: { type: preferencesSchema, default: () => ({}) },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

/**
 * Case-insensitive uniqueness for both natural keys.
 *
 * Declared here rather than as `unique: true` on the fields, because that would
 * additionally create a plain index in which "Parth" and "parth" are distinct
 * values — two indexes disagreeing about what uniqueness means. `strength: 2`
 * compares letters but not case, which is what people expect of a login field.
 * Queries must pass the same collation to use these indexes.
 */
export const CI = { locale: 'en', strength: 2 } as const;

userSchema.index({ email: 1 }, { unique: true, collation: CI });
userSchema.index({ username: 1 }, { unique: true, collation: CI });

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;

export const User = model('User', userSchema);

/**
 * Deterministic colour assignment: the same email always gets the same colour,
 * so a user's cursor colour is stable across projects and re-registrations.
 */
export function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length] as string;
}

export function toUserDto(user: UserDoc | (UserAttrs & { _id: unknown })): UserDto {
  return {
    id: String((user as { _id: unknown })._id),
    username: user.username,
    avatarUrl: user.avatarUrl ?? null,
    color: user.color,
  };
}
