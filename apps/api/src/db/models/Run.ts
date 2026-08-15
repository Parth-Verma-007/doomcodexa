import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { LANGUAGE_IDS, LIMITS, RUN_STATUSES, type RunDto, type UserDto } from '@codexa/shared';

/**
 * Run history. Output is stored as a bounded tail only (§6) — an unbounded
 * `stdout` field is how a print-loop turns into a multi-gigabyte collection.
 */

const runSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    triggeredBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    language: { type: String, enum: LANGUAGE_IDS, required: true },
    entrypoint: { type: String, required: true },
    stdin: { type: String, default: null, maxlength: 64 * 1024 },
    status: { type: String, enum: RUN_STATUSES, default: 'queued' },
    exitCode: { type: Number, default: null },
    compileMs: { type: Number, default: null },
    runMs: { type: Number, default: null },
    stdoutBytes: { type: Number, default: 0 },
    stderrBytes: { type: Number, default: 0 },
    outputTail: { type: String, default: '' },
    truncated: { type: Boolean, default: false },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

runSchema.index({ projectId: 1, createdAt: -1 });
runSchema.index({ triggeredBy: 1, createdAt: -1 });
// Run history is a convenience, not a record of account. 30 days is plenty and
// keeps the collection from growing without bound.
runSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export type RunAttrs = InferSchemaType<typeof runSchema>;
export type RunDoc = HydratedDocument<RunAttrs>;

export const Run = model('Run', runSchema);

/** Keep only the last N bytes of combined output for the history record. */
export function tailOf(output: string): string {
  const limit = LIMITS.RUN_OUTPUT_TAIL_BYTES;
  return output.length <= limit ? output : output.slice(output.length - limit);
}

export function toRunDto(run: RunDoc, triggeredBy: UserDto | null): RunDto {
  return {
    id: String(run._id),
    projectId: String(run.projectId),
    triggeredBy,
    language: run.language as RunDto['language'],
    entrypoint: run.entrypoint,
    status: run.status as RunDto['status'],
    exitCode: run.exitCode ?? null,
    compileMs: run.compileMs ?? null,
    runMs: run.runMs ?? null,
    outputTail: run.outputTail ?? '',
    truncated: run.truncated ?? false,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}
