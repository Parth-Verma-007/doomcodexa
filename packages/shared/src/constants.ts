/**
 * Language registry and hard limits.
 *
 * Everything here is shared by the client and the server so that a limit shown
 * in the UI is provably the same number the server enforces.
 */

export const LANGUAGE_IDS = ['c', 'cpp', 'java', 'python'] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

export interface LanguageSpec {
  id: LanguageId;
  label: string;
  /** Monaco's built-in language id. */
  monacoId: string;
  /** Primary source extension, including the dot. */
  extension: string;
  /** Every extension that maps to this language. */
  extensions: string[];
  /** Filename created for a new project of this language. */
  defaultEntrypoint: string;
  /** True when the runner must compile before it can run. */
  compiled: boolean;
  /**
   * Java only: the public class name must equal the filename. Validated on both
   * sides so the user gets a real message instead of a raw javac error.
   */
  filenameMustMatchClass: boolean;
  /** Comment prefix, used by the "insert header" template helper. */
  lineComment: string;
  template: string;
}

export const LANGUAGES: Record<LanguageId, LanguageSpec> = {
  c: {
    id: 'c',
    label: 'C',
    monacoId: 'c',
    extension: '.c',
    extensions: ['.c', '.h'],
    defaultEntrypoint: 'main.c',
    compiled: true,
    filenameMustMatchClass: false,
    lineComment: '//',
    template: `#include <stdio.h>

int main(void) {
    int a, b;
    printf("Enter two numbers: ");
    if (scanf("%d %d", &a, &b) != 2) {
        printf("Invalid input\\n");
        return 1;
    }
    printf("Sum = %d\\n", a + b);
    return 0;
}
`,
  },
  cpp: {
    id: 'cpp',
    label: 'C++',
    monacoId: 'cpp',
    extension: '.cpp',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h'],
    defaultEntrypoint: 'main.cpp',
    compiled: true,
    filenameMustMatchClass: false,
    lineComment: '//',
    template: `#include <iostream>

int main() {
    int a, b;
    std::cout << "Enter two numbers: ";
    if (!(std::cin >> a >> b)) {
        std::cout << "Invalid input\\n";
        return 1;
    }
    std::cout << "Sum = " << a + b << '\\n';
    return 0;
}
`,
  },
  java: {
    id: 'java',
    label: 'Java',
    monacoId: 'java',
    extension: '.java',
    extensions: ['.java'],
    defaultEntrypoint: 'Main.java',
    compiled: true,
    filenameMustMatchClass: true,
    lineComment: '//',
    template: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        System.out.print("Enter two numbers: ");
        int a = sc.nextInt();
        int b = sc.nextInt();
        System.out.println("Sum = " + (a + b));
    }
}
`,
  },
  python: {
    id: 'python',
    label: 'Python',
    monacoId: 'python',
    extension: '.py',
    extensions: ['.py'],
    defaultEntrypoint: 'main.py',
    compiled: false,
    filenameMustMatchClass: false,
    lineComment: '#',
    template: `def main() -> None:
    a, b = map(int, input("Enter two numbers: ").split())
    print(f"Sum = {a + b}")


if __name__ == "__main__":
    main()
`,
  },
};

export const LANGUAGE_LIST: LanguageSpec[] = LANGUAGE_IDS.map((id) => LANGUAGES[id]);

/** Extension (with dot, lowercase) -> language id. First registration wins. */
const EXTENSION_INDEX: Record<string, LanguageId> = (() => {
  const index: Record<string, LanguageId> = {};
  for (const spec of LANGUAGE_LIST) {
    for (const ext of spec.extensions) {
      if (!(ext in index)) index[ext] = spec.id;
    }
  }
  // Ambiguous headers: bias toward C++ since it is the more common project type.
  index['.h'] = 'cpp';
  return index;
})();

/** Monaco language id for any filename, including ones we don't execute. */
const MONACO_EXTRA: Record<string, string> = {
  '.md': 'markdown',
  '.json': 'json',
  '.txt': 'plaintext',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'shell',
  '.html': 'html',
  '.css': 'css',
  '.js': 'javascript',
  '.ts': 'typescript',
};

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? '' : filename.slice(dot).toLowerCase();
}

/** The executable language of a file, or null for files we can't run. */
export function languageOf(filename: string): LanguageId | null {
  return EXTENSION_INDEX[extensionOf(filename)] ?? null;
}

/** The Monaco grammar to highlight a file with. Always returns something. */
export function monacoLanguageOf(filename: string): string {
  const ext = extensionOf(filename);
  const lang = EXTENSION_INDEX[ext];
  if (lang) return LANGUAGES[lang].monacoId;
  return MONACO_EXTRA[ext] ?? 'plaintext';
}

export function isLanguageId(value: unknown): value is LanguageId {
  return typeof value === 'string' && (LANGUAGE_IDS as readonly string[]).includes(value);
}

// ─── Limits ───────────────────────────────────────────────────────────────────
// Mirrored by the server; the UI reads these to render accurate errors.

export const LIMITS = {
  /** Largest single Yjs update we will accept. Blocks giant-paste wedging (§7). */
  MAX_YJS_UPDATE_BYTES: 1024 * 1024,
  /** Largest document text we allow. */
  MAX_DOC_BYTES: 2 * 1024 * 1024,
  /** Server-side Y.Doc LRU capacity. */
  YDOC_CACHE_SIZE: 200,
  /** Debounce before writing a CRDT snapshot to Mongo. */
  YDOC_PERSIST_DEBOUNCE_MS: 2_000,
  /** Hard flush interval regardless of activity. */
  YDOC_PERSIST_MAX_INTERVAL_MS: 30_000,
  /** Grace period before an idle doc is evicted from the cache. */
  YDOC_EVICT_GRACE_MS: 60_000,

  /** Terminal output is flushed to clients on this interval (§8). */
  RUN_OUTPUT_FLUSH_MS: 30,
  /** Total stdout+stderr per run before we truncate and kill. */
  RUN_MAX_OUTPUT_BYTES: 1024 * 1024,
  /** Kept on the run record for history. */
  RUN_OUTPUT_TAIL_BYTES: 8 * 1024,

  MAX_FILENAME_LENGTH: 128,
  MAX_PATH_DEPTH: 12,
  MAX_FILES_PER_PROJECT: 200,
  MAX_PROJECT_NAME_LENGTH: 80,
  MAX_CHAT_MESSAGE_LENGTH: 2_000,

  /** WebRTC mesh cap (§9). Past this you need an SFU. */
  MAX_RTC_PEERS: 4,

  RUNS_PER_MINUTE: 20,
  RUNS_PER_HOUR: 300,
} as const;

/** Filenames that must never appear in a workspace. */
export const RESERVED_FILENAMES = new Set([
  '.',
  '..',
  '.git',
  'node_modules',
  'CON',
  'PRN',
  'AUX',
  'NUL',
]);
