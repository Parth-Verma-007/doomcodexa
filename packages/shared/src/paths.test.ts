import { describe, expect, it } from 'vitest';
import {
  PathError,
  assertValidPath,
  assertValidSegment,
  basename,
  isUnder,
  isValidSegment,
  joinPath,
  parentPathOf,
  rebase,
  toWorkspaceRelative,
} from './paths.js';

/** Built with char codes so no literal control byte ever lands in this source file. */
const ch = (code: number) => String.fromCharCode(code);
const NUL = ch(0);
const TAB = ch(9);
const LF = ch(10);
const DEL = ch(127);

describe('assertValidSegment', () => {
  it('accepts ordinary source filenames', () => {
    for (const name of [
      'main.cpp',
      'Main.java',
      'main.c',
      'utils.h',
      'my_file-2.py',
      'README.md',
      'a',
      '.gitignore',
      'test.spec.ts',
      'my file.cpp',
    ]) {
      expect(() => assertValidSegment(name), name).not.toThrow();
    }
  });

  it('rejects traversal and separators', () => {
    for (const name of ['.', '..', '../etc', 'a/b', 'a\\b', '/etc/passwd']) {
      expect(() => assertValidSegment(name), name).toThrow(PathError);
    }
  });

  it('rejects NTFS-illegal characters', () => {
    for (const name of ['a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(() => assertValidSegment(name), name).toThrow(PathError);
    }
  });

  it('rejects control characters, including a NUL byte smuggled into a name', () => {
    for (const name of [
      `main${NUL}.cpp`,
      `main${LF}.cpp`,
      `main${TAB}.cpp`,
      `main${DEL}.cpp`,
      `${NUL}main.cpp`,
    ]) {
      expect(() => assertValidSegment(name)).toThrow(PathError);
    }
  });

  it('rejects Windows device names in any case, with or without extension', () => {
    for (const name of ['CON', 'con', 'NUL', 'com1', 'LPT9', 'aux.txt']) {
      expect(() => assertValidSegment(name), name).toThrow(PathError);
    }
  });

  it('rejects reserved project names and surrounding whitespace', () => {
    expect(() => assertValidSegment('.git')).toThrow(PathError);
    expect(() => assertValidSegment('node_modules')).toThrow(PathError);
    expect(() => assertValidSegment(' main.cpp')).toThrow(PathError);
    expect(() => assertValidSegment('main.cpp ')).toThrow(PathError);
  });

  it('rejects a trailing dot, which Windows would silently strip', () => {
    expect(() => assertValidSegment('main.')).toThrow(PathError);
  });

  it('rejects empty and over-long names', () => {
    expect(() => assertValidSegment('')).toThrow(PathError);
    expect(() => assertValidSegment('x'.repeat(129))).toThrow(PathError);
    expect(isValidSegment('x'.repeat(128))).toBe(true);
  });
});

describe('joinPath', () => {
  it('builds canonical absolute paths', () => {
    expect(joinPath('/', 'main.cpp')).toBe('/main.cpp');
    expect(joinPath('/src', 'main.cpp')).toBe('/src/main.cpp');
    expect(joinPath('/src/util', 'a.h')).toBe('/src/util/a.h');
  });

  it('never produces a double slash', () => {
    expect(joinPath('/src/', 'a.c')).toBe('/src/a.c');
  });

  it('refuses to join a traversing segment', () => {
    expect(() => joinPath('/src', '..')).toThrow(PathError);
  });

  it('enforces the depth limit', () => {
    let path = '/';
    for (let i = 0; i < 12; i += 1) path = joinPath(path, `d${i}`);
    expect(() => joinPath(path, 'toodeep.c')).toThrow(PathError);
  });
});

describe('assertValidPath', () => {
  it('accepts the root and well-formed paths', () => {
    expect(() => assertValidPath('/')).not.toThrow();
    expect(() => assertValidPath('/src/main.cpp')).not.toThrow();
  });

  it('rejects relative, doubled, and trailing-slash paths', () => {
    for (const p of ['src/main.cpp', '//src', '/src//main.c', '/src/', '/../etc/passwd']) {
      expect(() => assertValidPath(p), p).toThrow(PathError);
    }
  });
});

describe('parentPathOf / basename', () => {
  it('walks up one level', () => {
    expect(parentPathOf('/src/main.cpp')).toBe('/src');
    expect(parentPathOf('/main.cpp')).toBe('/');
  });

  it('has no parent for the root', () => {
    expect(() => parentPathOf('/')).toThrow(PathError);
  });

  it('extracts the last segment', () => {
    expect(basename('/src/main.cpp')).toBe('main.cpp');
    expect(basename('/main.cpp')).toBe('main.cpp');
  });
});

describe('isUnder', () => {
  it('matches the ancestor itself and its descendants', () => {
    expect(isUnder('/src', '/src')).toBe(true);
    expect(isUnder('/src/a.c', '/src')).toBe(true);
    expect(isUnder('/src/deep/a.c', '/src')).toBe(true);
  });

  it('does not treat a name-prefix sibling as a descendant', () => {
    // The classic bug: startsWith('/src') would wrongly match '/srcbackup'.
    expect(isUnder('/srcbackup/a.c', '/src')).toBe(false);
    expect(isUnder('/other', '/src')).toBe(false);
  });

  it('treats everything as under the root', () => {
    expect(isUnder('/anything/at/all', '/')).toBe(true);
  });
});

describe('rebase', () => {
  it('rewrites descendants when a folder is renamed or moved', () => {
    expect(rebase('/src/util/a.c', '/src', '/lib')).toBe('/lib/util/a.c');
    expect(rebase('/src', '/src', '/lib')).toBe('/lib');
    expect(rebase('/src/a.c', '/src', '/pkg/src')).toBe('/pkg/src/a.c');
  });

  it('handles moving a folder to the root without doubling the slash', () => {
    expect(rebase('/deep/src/a.c', '/deep/src', '/src')).toBe('/src/a.c');
    expect(rebase('/src/a.c', '/src', '/')).toBe('/a.c');
  });

  it('refuses to rebase a non-descendant', () => {
    expect(() => rebase('/other/a.c', '/src', '/lib')).toThrow(PathError);
  });
});

describe('toWorkspaceRelative', () => {
  it('strips exactly one leading slash', () => {
    expect(toWorkspaceRelative('/main.cpp')).toBe('main.cpp');
    expect(toWorkspaceRelative('/src/main.cpp')).toBe('src/main.cpp');
  });

  it('refuses the root', () => {
    expect(() => toWorkspaceRelative('/')).toThrow(PathError);
  });

  it('refuses any path that could escape the workspace directory', () => {
    for (const p of ['/../etc/passwd', '/src/../../etc/passwd', '/src/./a.c', '//etc']) {
      expect(() => toWorkspaceRelative(p), p).toThrow(PathError);
    }
  });
});
