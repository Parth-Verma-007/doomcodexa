import type { LanguageId } from '@codexa/shared';

/**
 * Per-language facts the executor needs.
 *
 * This file used to hold container recipes — an image name, a shell, and a
 * static script that compiled and ran inside it, plus a random sentinel printed
 * between the two phases so their output could be told apart on a merged PTY
 * stream. All of that existed because the work happened inside a container the
 * server could only talk to through one pipe.
 *
 * Running compilers as child processes makes every one of those problems
 * disappear: compile and run are separate processes with separate pipes, so
 * there is nothing to disambiguate, and each command is an argv array rather
 * than a shell string, so there is nothing to escape. What is left is the two
 * things that are genuinely per-language.
 */

/** Which files in a project are sources for a given language. */
export const SOURCE_EXTENSIONS: Record<LanguageId, string[]> = {
  c: ['.c'],
  cpp: ['.cpp', '.cc', '.cxx'],
  java: ['.java'],
  python: ['.py'],
};

/**
 * Java requires the public class name to equal the file name. Checked here so
 * the user gets a sentence instead of a raw javac diagnostic.
 */
export function validateJavaEntrypoint(
  entrypoint: string,
  source: string,
): { ok: true; className: string } | { ok: false; message: string } {
  const filename = entrypoint.split('/').pop() ?? entrypoint;
  const expected = filename.replace(/\.java$/, '');

  const declared = /(?:^|\n)\s*public\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(
    source,
  );

  if (declared && declared[1] !== expected) {
    return {
      ok: false,
      message: `Java requires the file name to match the public class. Rename "${filename}" to "${declared[1]}.java", or rename the class to "${expected}".`,
    };
  }

  if (!/\bstatic\s+(?:public\s+)?void\s+main\s*\(/.test(source) && !/\bmain\s*\(/.test(source)) {
    return {
      ok: false,
      message: `"${filename}" has no main method, so there is nothing to run.`,
    };
  }

  return { ok: true, className: expected };
}
