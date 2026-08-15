import fs from 'node:fs/promises';
import path from 'node:path';
import { toWorkspaceRelative, type RunFile } from '@codexa/shared';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { SOURCE_EXTENSIONS } from './languages.js';
import type { LanguageId } from '@codexa/shared';

/**
 * Materialising a project onto disk so a compiler can be pointed at it (§8).
 *
 * Every path is re-validated here even though it was validated on the way into
 * the database. This is the last step before a real `fs.writeFile`, and a
 * traversal that gets past it writes to the host filesystem — so it does not
 * trust its inputs.
 */

const MANIFEST_NAME = '.codexa-sources';

export interface Workspace {
  dir: string;
  /** Entrypoint relative to the workspace root, e.g. `src/main.cpp`. */
  entrypoint: string;
  cleanup(): Promise<void>;
}

export async function materialise(
  runId: string,
  language: LanguageId,
  entrypointPath: string,
  files: RunFile[],
): Promise<Workspace> {
  const root = path.resolve(config.exec.workspaceRoot);
  const dir = path.join(root, runId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const sourceExtensions = SOURCE_EXTENSIONS[language];
  const sources: string[] = [];

  try {
    for (const file of files) {
      // Throws PathError on anything that could escape.
      const relative = toWorkspaceRelative(file.path);
      const target = path.join(dir, relative);

      // Belt and braces: even if `toWorkspaceRelative` were wrong, refuse to
      // write outside the workspace directory.
      const resolved = path.resolve(target);
      if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
        throw new Error(`Refusing to write outside the workspace: ${file.path}`);
      }

      await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
      // 0o600, not 0o400. On Windows a read-only file cannot be deleted, so the
      // stricter mode leaks a workspace directory per run — and the read-only
      // bit buys nothing here anyway, since the process that would overwrite it
      // runs as the same user that owns it. Isolation comes from the 0o700
      // parent directory.
      await fs.writeFile(resolved, file.content, { encoding: 'utf8', mode: 0o600 });

      const ext = path.extname(relative).toLowerCase();
      if (sourceExtensions.includes(ext)) {
        // Always forward slashes, even on Windows: this string goes into the
        // manifest and is compared against other normalised paths.
        sources.push(relative.split(path.sep).join('/'));
      }
    }

    // Compile the entrypoint first so its diagnostics appear before any others.
    const entrypointRelative = toWorkspaceRelative(entrypointPath);
    const normalisedEntry = entrypointRelative.split(path.sep).join('/');
    sources.sort((a, b) => (a === normalisedEntry ? -1 : b === normalisedEntry ? 1 : 0));

    await fs.writeFile(path.join(dir, MANIFEST_NAME), `${sources.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    return {
      dir,
      entrypoint: normalisedEntry,
      cleanup: () => remove(dir),
    };
  } catch (err) {
    await remove(dir);
    throw err;
  }
}

async function remove(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    logger.warn({ err, dir }, 'failed to remove a run workspace');
  }
}

/**
 * Sweep abandoned workspaces.
 *
 * `cleanup()` runs in a `finally`, but a hard crash between materialising and
 * running would leak a directory. On a small VPS a slow disk leak is one of the
 * most likely ways this service dies (§17), so a janitor backs the finally up.
 */
export function startWorkspaceJanitor(maxAgeMs = 5 * 60_000, intervalMs = 60_000): () => void {
  const root = path.resolve(config.exec.workspaceRoot);

  const sweep = async () => {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const now = Date.now();
      let removed = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const stat = await fs.stat(dir).catch(() => null);
        if (!stat) continue;
        if (now - stat.mtimeMs < maxAgeMs) continue;
        await remove(dir);
        removed += 1;
      }

      if (removed > 0) logger.info({ removed }, 'janitor removed abandoned workspaces');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // The root not existing yet is normal before the first run.
      if (code !== 'ENOENT') logger.warn({ err }, 'workspace janitor sweep failed');
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

export async function ensureWorkspaceRoot(): Promise<void> {
  await fs.mkdir(path.resolve(config.exec.workspaceRoot), { recursive: true, mode: 0o700 });
}
