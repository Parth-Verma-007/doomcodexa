import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * A signed-in session.
 *
 * Opaque random tokens in a collection rather than a JWT, for two reasons.
 * Revocation is real — signing out, or removing an account, takes effect on the
 * next request instead of whenever the token happens to expire. And the app
 * already does a database read per request to load the user, so a self-contained
 * token would not have saved a round trip anyway.
 *
 * Only the SHA-256 of the token is stored. A leaked backup or a stray log line
 * then yields nothing usable, exactly as with the password hashes beside them.
 */

const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: Date.now },
    userAgent: { type: String, default: null },
  },
  { timestamps: true },
);

// Mongo deletes expired sessions itself, so an abandoned session cannot sit in
// the collection indefinitely waiting to be replayed.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionAttrs = InferSchemaType<typeof sessionSchema>;
export type SessionDoc = HydratedDocument<SessionAttrs>;

export const Session = model('Session', sessionSchema);
