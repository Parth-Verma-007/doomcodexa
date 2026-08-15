import { Types } from 'mongoose';
import {
  LIMITS,
  isTerminalStatus,
  type LanguageId,
  type RunEvent,
  type RunFile,
  type RunSpec,
} from '@codexa/shared';
import { File, Project, Run, tailOf, type ProjectDoc } from '../db/models/index.js';
import { getProjectTexts } from './documents.js';
import { textOf } from '../realtime/docStore.js';
import { ApiError } from '../http/errors.js';
import { logger } from '../observability/logger.js';

/**
 * Assembling a run: choosing the entrypoint, snapshotting the project's files,
 * recording history, and rate limiting.
 */

export interface PreparedRun {
  spec: RunSpec;
  language: LanguageId;
  entrypointPath: string;
}

export async function prepareRun(
  project: ProjectDoc,
  runId: string,
  fileId: string | undefined,
  stdin: string | undefined,
  interactive: boolean,
): Promise<PreparedRun> {
  const targetId = fileId ?? (project.entrypointFileId ? String(project.entrypointFileId) : null);
  if (!targetId) {
    throw ApiError.badRequest('This project has no entrypoint. Pick a file to run.');
  }

  const entry = await File.findOne({ _id: targetId, projectId: project._id });
  if (!entry || entry.type !== 'file') {
    throw ApiError.badRequest('That file cannot be run.');
  }
  if (!entry.language) {
    throw ApiError.badRequest(`"${entry.name}" is not a runnable source file.`);
  }

  const language = entry.language as LanguageId;
  const files = await snapshotProject(String(project._id));

  if (files.length === 0) {
    throw ApiError.badRequest('There is nothing to run.');
  }

  return {
    language,
    entrypointPath: entry.path,
    spec: {
      runId,
      projectId: String(project._id),
      language,
      entrypoint: entry.path,
      files,
      ...(stdin === undefined ? {} : { stdin }),
      interactive,
    },
  };
}

/**
 * Snapshot every file's current text.
 *
 * Reads through the in-memory doc store first: a user who types and
 * immediately hits Run must execute what is on their screen, not what was last
 * flushed to Mongo up to two seconds ago. Files nobody has open fall back to
 * the persisted `plainText` cache.
 */
async function snapshotProject(projectId: string): Promise<RunFile[]> {
  const files = await File.find({ projectId, type: 'file' }).select('_id path');
  const persisted = await getProjectTexts(projectId);

  const snapshot: RunFile[] = [];
  for (const file of files) {
    const id = String(file._id);
    let content: string;
    try {
      content = await textOf(id, projectId);
    } catch (err) {
      logger.warn({ err, fileId: id }, 'falling back to the persisted text cache');
      content = persisted.get(id) ?? '';
    }
    snapshot.push({ path: file.path, content });
  }
  return snapshot;
}

// ─── Run records ──────────────────────────────────────────────────────────────

export async function createRunRecord(input: {
  runId: string;
  projectId: string;
  userId: string;
  language: LanguageId;
  entrypoint: string;
  stdin?: string;
}): Promise<void> {
  await Run.create({
    _id: new Types.ObjectId(input.runId),
    projectId: input.projectId,
    triggeredBy: input.userId,
    language: input.language,
    entrypoint: input.entrypoint,
    stdin: input.stdin ?? null,
    status: 'queued',
  });
}

/**
 * Fold a run's event stream into its history record. Only terminal events and
 * phase changes touch the database — writing on every output chunk would turn
 * a print loop into a write storm.
 */
export function makeRunRecorder(runId: string) {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let tail = '';

  return {
    observe(event: RunEvent): void {
      switch (event.type) {
        case 'stdout':
          stdoutBytes += event.chunk.length;
          tail = tailOf(tail + event.chunk);
          break;
        case 'stderr':
          stderrBytes += event.chunk.length;
          tail = tailOf(tail + event.chunk);
          break;
        case 'truncated':
          truncated = true;
          break;
        case 'status':
          void Run.updateOne({ _id: runId }, { $set: { status: event.phase } }).catch(() => {});
          break;
        case 'exit':
          if (!isTerminalStatus(event.status)) break;
          void Run.updateOne(
            { _id: runId },
            {
              $set: {
                status: event.status,
                exitCode: event.exitCode,
                compileMs: event.compileMs,
                runMs: event.runMs,
                stdoutBytes,
                stderrBytes,
                truncated,
                outputTail: tail,
                finishedAt: new Date(),
              },
            },
          ).catch((err) => logger.error({ err, runId }, 'failed to record run result'));
          break;
        default:
          break;
      }
    },
  };
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

/**
 * Per-user run limits (§8). In-memory, which is correct for a single-node
 * deployment; a multi-node build would move this to Redis alongside the queue.
 */
const buckets = new Map<string, number[]>();

export function checkRunRateLimit(userId: string): { allowed: boolean; message?: string } {
  const now = Date.now();
  const history = (buckets.get(userId) ?? []).filter((t) => now - t < 3_600_000);

  const lastMinute = history.filter((t) => now - t < 60_000).length;
  if (lastMinute >= LIMITS.RUNS_PER_MINUTE) {
    buckets.set(userId, history);
    return {
      allowed: false,
      message: `You can run code ${LIMITS.RUNS_PER_MINUTE} times a minute. Give it a moment.`,
    };
  }
  if (history.length >= LIMITS.RUNS_PER_HOUR) {
    buckets.set(userId, history);
    return {
      allowed: false,
      message: `You have hit the hourly limit of ${LIMITS.RUNS_PER_HOUR} runs.`,
    };
  }

  history.push(now);
  buckets.set(userId, history);
  return { allowed: true };
}

/** Drop stale buckets so the map does not grow with every user who ever ran code. */
export function startRateLimitSweeper(intervalMs = 600_000): () => void {
  const timer = setInterval(() => {
    const cutoff = Date.now() - 3_600_000;
    for (const [userId, history] of buckets) {
      const fresh = history.filter((t) => t > cutoff);
      if (fresh.length === 0) buckets.delete(userId);
      else buckets.set(userId, fresh);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}

export async function projectExists(projectId: string): Promise<boolean> {
  return (await Project.exists({ _id: projectId })) !== null;
}
