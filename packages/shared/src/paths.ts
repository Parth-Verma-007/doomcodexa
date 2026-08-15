import { LIMITS, RESERVED_FILENAMES } from './constants.js';

/**
 * Path handling for the virtual project filesystem.
 *
 * These functions are the boundary between user-supplied names and (a) Mongo
 * unique indexes and (b) real directories on the host that get bind-mounted
 * into a runner. A traversal bug here writes to the host, so every function is
 * total: it either returns a safe value or throws `PathError`.
 */

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/** Windows reserved device names are rejected regardless of host OS. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Path separators and characters that are illegal on NTFS. Control characters
 * are checked separately by code point so the regex stays readable.
 */
const ILLEGAL_CHARS = /[/\\:*?"<>|]/;

function hasControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a single path segment (a file or folder name).
 * Throws rather than sanitising: silently rewriting a user's filename is worse
 * than telling them why it was rejected.
 */
export function assertValidSegment(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new PathError('Name cannot be empty.');
  }
  if (name.length > LIMITS.MAX_FILENAME_LENGTH) {
    throw new PathError(`Name cannot exceed ${LIMITS.MAX_FILENAME_LENGTH} characters.`);
  }
  if (name !== name.trim()) {
    throw new PathError('Name cannot start or end with whitespace.');
  }
  if (name === '.' || name === '..') {
    throw new PathError('Name cannot be "." or "..".');
  }
  if (hasControlChar(name)) {
    throw new PathError('Name contains a control character.');
  }
  if (ILLEGAL_CHARS.test(name)) {
    throw new PathError('Name contains an illegal character.');
  }
  if (WINDOWS_DEVICE.test(name)) {
    throw new PathError(`"${name}" is a reserved device name.`);
  }
  if (RESERVED_FILENAMES.has(name)) {
    throw new PathError(`"${name}" is reserved.`);
  }
  // A trailing dot is legal on POSIX but silently stripped by Windows, which
  // would desynchronise the DB path from the on-disk path during a run.
  if (name.endsWith('.')) {
    throw new PathError('Name cannot end with a dot.');
  }
}

export function isValidSegment(name: string): boolean {
  try {
    assertValidSegment(name);
    return true;
  } catch {
    return false;
  }
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** Validate a full stored path, segment by segment. */
export function assertValidPath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new PathError('Path must be absolute.');
  }
  if (path === '/') return;
  if (path.includes('//')) {
    throw new PathError('Path contains an empty segment.');
  }
  if (path.endsWith('/')) {
    throw new PathError('Path cannot end with a slash.');
  }
  const segments = path.slice(1).split('/');
  if (segments.length > LIMITS.MAX_PATH_DEPTH) {
    throw new PathError(`Path cannot be deeper than ${LIMITS.MAX_PATH_DEPTH} levels.`);
  }
  for (const segment of segments) assertValidSegment(segment);
}

export function isValidPath(path: string): boolean {
  try {
    assertValidPath(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the canonical stored path for a child of `parentPath`.
 * Always leading-slash, never trailing-slash: `/`, `/src`, `/src/main.cpp`.
 */
export function joinPath(parentPath: string, name: string): string {
  assertValidSegment(name);
  const base = parentPath === '/' || parentPath === '' ? '' : stripTrailingSlash(parentPath);
  const joined = `${base}/${name}`;
  assertValidPath(joined);
  return joined;
}

export function parentPathOf(path: string): string {
  assertValidPath(path);
  if (path === '/') throw new PathError('Root has no parent.');
  const slash = path.lastIndexOf('/');
  return slash === 0 ? '/' : path.slice(0, slash);
}

export function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** True when `path` is `ancestor` itself or lives underneath it. */
export function isUnder(path: string, ancestor: string): boolean {
  if (ancestor === '/') return true;
  const base = stripTrailingSlash(ancestor);
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Rewrite a descendant path when its ancestor moves or is renamed.
 * `rebase('/src/util/a.c', '/src', '/lib')` -> `/lib/util/a.c`
 */
export function rebase(path: string, fromAncestor: string, toAncestor: string): string {
  if (!isUnder(path, fromAncestor)) {
    throw new PathError(`"${path}" is not under "${fromAncestor}".`);
  }
  const from = stripTrailingSlash(fromAncestor);
  const to = stripTrailingSlash(toAncestor);
  const suffix = path.slice(from.length);
  const next = (to === '/' ? '' : to) + suffix || '/';
  assertValidPath(next);
  return next;
}

/**
 * Convert a stored path (`/src/main.cpp`) into the relative path used inside a
 * runner workspace (`src/main.cpp`).
 *
 * This is the last line of defence before a real `fs.writeFile`: it re-validates
 * rather than trusting that the DB only ever contained safe paths.
 */
export function toWorkspaceRelative(path: string): string {
  assertValidPath(path);
  if (path === '/') throw new PathError('Cannot materialise the root as a file.');
  const relative = path.slice(1);
  const segments = relative.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) {
    throw new PathError('Refusing to materialise a traversing path.');
  }
  return relative;
}
