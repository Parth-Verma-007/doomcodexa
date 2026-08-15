import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * The CRDT state for one file — the source of truth for its content (§6).
 *
 * `plainText` is a derived cache written on the same debounce as `state`, used
 * only for (a) materialising a workspace before a run and (b) search. If the
 * two ever disagree, `state` wins.
 */

const ydocSchema = new Schema(
  {
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    /** Y.encodeStateAsUpdate(doc) */
    state: { type: Buffer, required: true },
    plainText: { type: String, default: '' },
    /** Monotonic counter, bumped on every persist. Useful for debugging drift. */
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type YDocAttrs = InferSchemaType<typeof ydocSchema>;
export type YDocDoc = HydratedDocument<YDocAttrs>;

export const YDocState = model('YDocState', ydocSchema);
