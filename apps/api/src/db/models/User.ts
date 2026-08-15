import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import type { UserDto } from '@codexa/shared';

/**
 * A mirror of the Clerk user, kept in sync by the `user.*` webhook (§10).
 * Clerk is the source of truth for identity; this collection exists so that
 * every other document can hold a stable ObjectId reference.
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
    clerkId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true },
    username: { type: String, required: true },
    avatarUrl: { type: String, default: null },
    color: { type: String, required: true },
    preferences: { type: preferencesSchema, default: () => ({}) },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;

export const User = model('User', userSchema);

/**
 * Deterministic colour assignment: the same Clerk id always gets the same
 * colour, so a user's cursor colour is stable across projects and re-signups.
 */
export function colorForClerkId(clerkId: string): string {
  let hash = 0;
  for (let i = 0; i < clerkId.length; i += 1) {
    hash = (hash * 31 + clerkId.charCodeAt(i)) >>> 0;
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
