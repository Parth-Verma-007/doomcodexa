// `monaco-editor/esm/vs/editor/editor.api` is the editor without any language
// grammars. The bare `monaco-editor` entry pulls in all ~80 of them plus the
// TypeScript, JSON, CSS and HTML language services — several megabytes for
// languages this IDE does not run. We add back only what we highlight.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
// `cpp.contribution` registers both the `c` and `cpp` grammars — there is no
// separate `c/` module.
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { LANGUAGES, monacoLanguageOf } from '@codexa/shared';

/**
 * Monaco bootstrap.
 *
 * Two things here are load-bearing:
 *
 *   1. Workers are provided explicitly. `@monaco-editor/react` defaults to
 *      loading Monaco and its workers from a CDN, which breaks under any real
 *      CSP and adds a network dependency to opening a file. We bundle instead.
 *
 *   2. We ship only the base editor worker. C, C++, Java and Python have no
 *      Monaco language service (that would be an LSP — a v2 item), so the
 *      JSON/TS/CSS workers would be dead weight.
 */

let configured = false;

export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };

  /*
   * Two themes, matching the two CSS token blocks in index.css, and using the
   * same Primer values so the editor and the chrome around it agree.
   *
   * Monarch grammars emit a coarser token set than TextMate scopes, so the
   * mapping is approximate by necessity: `type` covers what GitHub styles as
   * `entity.name.type`, `predefined` the built-ins it treats as constants.
   */
  monaco.editor.defineTheme('codexa-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8b949e', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ff7b72' },
      { token: 'string', foreground: 'a5d6ff' },
      { token: 'number', foreground: '79c0ff' },
      { token: 'type', foreground: 'ffa657' },
      { token: 'predefined', foreground: '79c0ff' },
      { token: 'annotation', foreground: 'd2a8ff' },
      { token: 'operator', foreground: 'ff7b72' },
      { token: 'delimiter', foreground: 'c9d1d9' },
    ],
    colors: {
      'editor.background': '#0d1117',
      'editor.foreground': '#e6edf3',
      'editorLineNumber.foreground': '#6e7681',
      'editorLineNumber.activeForeground': '#e6edf3',
      // Primer uses a translucent accent so the text underneath stays legible.
      'editor.selectionBackground': '#3392ff44',
      'editor.lineHighlightBackground': '#161b22',
      'editorCursor.foreground': '#2f81f7',
      'editorIndentGuide.background1': '#21262d',
      'editorWidget.background': '#161b22',
      'editorWidget.border': '#30363d',
      'editorSuggestWidget.background': '#161b22',
      'editorSuggestWidget.selectedBackground': '#21262d',
    },
  });

  monaco.editor.defineTheme('codexa-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6e7781', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'cf222e' },
      { token: 'string', foreground: '0a3069' },
      { token: 'number', foreground: '0550ae' },
      { token: 'type', foreground: '953800' },
      { token: 'predefined', foreground: '0550ae' },
      { token: 'annotation', foreground: '8250df' },
      { token: 'operator', foreground: 'cf222e' },
      { token: 'delimiter', foreground: '24292f' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1f2328',
      'editorLineNumber.foreground': '#8c959f',
      'editorLineNumber.activeForeground': '#1f2328',
      'editor.selectionBackground': '#0969da26',
      'editor.lineHighlightBackground': '#f6f8fa',
      'editorCursor.foreground': '#0969da',
      'editorIndentGuide.background1': '#d1d9e0',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#d0d7de',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.selectedBackground': '#eaeef2',
    },
  });

  registerBasicCompletions();

  loader.config({ monaco });
}

/**
 * Keyword and stdlib completion.
 *
 * Not an LSP — there is no type information here, and it will happily suggest
 * something that does not compile. It is a cheap way to make the editor feel
 * alive; real completion arrives with language servers in v2 (§18).
 */
function registerBasicCompletions(): void {
  const COMPLETIONS: Record<string, string[]> = {
    c: [
      'int',
      'char',
      'float',
      'double',
      'void',
      'long',
      'short',
      'unsigned',
      'const',
      'static',
      'struct',
      'typedef',
      'enum',
      'union',
      'sizeof',
      'return',
      'if',
      'else',
      'for',
      'while',
      'do',
      'switch',
      'case',
      'break',
      'continue',
      'printf',
      'scanf',
      'malloc',
      'free',
      'strlen',
      'strcpy',
      'strcmp',
      'memset',
      'fopen',
      'fclose',
      'fgets',
      'NULL',
      'stdio.h',
      'stdlib.h',
      'string.h',
      'math.h',
    ],
    cpp: [
      'int',
      'auto',
      'bool',
      'char',
      'double',
      'float',
      'void',
      'const',
      'constexpr',
      'class',
      'struct',
      'public',
      'private',
      'protected',
      'virtual',
      'override',
      'template',
      'typename',
      'namespace',
      'using',
      'return',
      'if',
      'else',
      'for',
      'while',
      'switch',
      'case',
      'try',
      'catch',
      'throw',
      'nullptr',
      'std::vector',
      'std::string',
      'std::map',
      'std::set',
      'std::cout',
      'std::cin',
      'std::endl',
      'std::sort',
      'std::pair',
      'std::unique_ptr',
      'iostream',
      'vector',
      'string',
      'algorithm',
      'map',
    ],
    java: [
      'public',
      'private',
      'protected',
      'static',
      'final',
      'abstract',
      'class',
      'interface',
      'extends',
      'implements',
      'void',
      'int',
      'long',
      'double',
      'boolean',
      'String',
      'new',
      'return',
      'if',
      'else',
      'for',
      'while',
      'switch',
      'case',
      'try',
      'catch',
      'finally',
      'throw',
      'throws',
      'null',
      'true',
      'false',
      'System.out.println',
      'System.out.print',
      'Scanner',
      'ArrayList',
      'HashMap',
      'Arrays',
      'Math',
      'Integer',
      'Double',
    ],
    python: [
      'def',
      'class',
      'return',
      'if',
      'elif',
      'else',
      'for',
      'while',
      'break',
      'continue',
      'import',
      'from',
      'as',
      'try',
      'except',
      'finally',
      'raise',
      'with',
      'lambda',
      'yield',
      'None',
      'True',
      'False',
      'and',
      'or',
      'not',
      'in',
      'is',
      'print',
      'input',
      'len',
      'range',
      'enumerate',
      'zip',
      'map',
      'filter',
      'sorted',
      'sum',
      'min',
      'max',
      'abs',
      'int',
      'str',
      'float',
      'list',
      'dict',
      'set',
      'tuple',
      'open',
    ],
  };

  for (const spec of Object.values(LANGUAGES)) {
    const words = COMPLETIONS[spec.id] ?? [];
    monaco.languages.registerCompletionItemProvider(spec.monacoId, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: words.map((label) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: label,
            range,
          })),
        };
      },
    });
  }
}

/** Model registry — one model per file, kept alive while its tab is open. */
const models = new Map<string, monaco.editor.ITextModel>();

/**
 * Get or create the model for a file.
 *
 * Models are NOT disposed on tab switch: a model owns its undo stack, and
 * disposing it means Ctrl+Z stops working the moment someone switches away and
 * back. They are only disposed when the tab is closed or the file is deleted.
 */
export function getModel(fileId: string, filename: string): monaco.editor.ITextModel {
  const existing = models.get(fileId);
  if (existing && !existing.isDisposed()) return existing;

  const uri = monaco.Uri.parse(`codexa://file/${fileId}/${filename}`);
  const model =
    monaco.editor.getModel(uri) ?? monaco.editor.createModel('', monacoLanguageOf(filename), uri);

  models.set(fileId, model);
  return model;
}

export function retitleModel(fileId: string, filename: string): void {
  const model = models.get(fileId);
  if (!model || model.isDisposed()) return;
  monaco.editor.setModelLanguage(model, monacoLanguageOf(filename));
}

export function disposeModel(fileId: string): void {
  const model = models.get(fileId);
  models.delete(fileId);
  if (model && !model.isDisposed()) model.dispose();
}

export function disposeAllModels(): void {
  for (const id of [...models.keys()]) disposeModel(id);
}

export { monaco };
