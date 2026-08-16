import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import Editor, { type OnMount } from '@monaco-editor/react';
import { Eye, WifiOff } from 'lucide-react';
import type { AwarenessState } from '@codexa/shared';
import { useProject } from '../project/ProjectContext.js';
import { useUiStore, useEditorTheme } from '../../stores/uiStore.js';
import { collabSocket } from '../../lib/socket.js';
import { DocumentProvider, setLocalAwareness } from '../../lib/yjsProvider.js';
import { getModel, type monaco } from '../../lib/monaco.js';
import { syncRemoteCursorStyles } from './remoteCursors.js';
import { Spinner } from '../../components/Spinner.js';

/**
 * The editor.
 *
 * The single most important rule here (§12): Monaco is bound to the Y.Text via
 * `MonacoBinding` and the document's content is never passed through React
 * state. Calling `setValue()` on a bound model — or rendering it as a
 * controlled `value` prop — fights the CRDT and makes cursors jump.
 */
export function EditorPane({ fileId }: { fileId: string }) {
  const { projectId, files, awareness, canEdit, announceActiveFile } = useProject();
  const editorTheme = useEditorTheme();
  const fontSize = useUiStore((s) => s.fontSize);
  const tabSize = useUiStore((s) => s.tabSize);
  const wordWrap = useUiStore((s) => s.wordWrap);
  const minimap = useUiStore((s) => s.minimap);
  const following = useUiStore((s) => s.followingPeerId);

  const [status, setStatus] = useState<'connecting' | 'synced' | 'disconnected'>('connecting');
  /**
   * The editor is state, not a ref, and that is load-bearing.
   *
   * Monaco arrives in a lazily-loaded chunk of several megabytes, so `onMount`
   * fires long after this component first renders. Held in a ref it did not
   * re-render, so every effect below ran once against a null editor, bailed,
   * and was never asked again — no CRDT provider, no `doc:open`, an empty
   * document and no presence for anyone else. On a local dev server Monaco won
   * that race and it all looked fine; over a real network it lost.
   */
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const providerRef = useRef<DocumentProvider | null>(null);
  const docRef = useRef<Y.Doc | null>(null);

  const file = useMemo(() => files.find((f) => f.id === fileId), [files, fileId]);

  const handleMount: OnMount = (instance) => setEditor(instance);

  // ─── Bind this file to a CRDT document ──────────────────────────────────────
  useEffect(() => {
    if (!editor || !awareness || !file) return;

    const doc = new Y.Doc();
    docRef.current = doc;

    const model = getModel(fileId, file.name);
    editor.setModel(model);

    const provider = new DocumentProvider({
      socket: collabSocket(),
      doc,
      fileId,
      awareness,
      projectId,
      onStatus: setStatus,
      onError: () => {
        /* surfaced by the read-only banner, not as a toast per keystroke */
      },
    });
    providerRef.current = provider;

    // The Y.Text key must match the server's (`monaco`), or the editor binds to
    // an empty document with no error at all.
    const binding = new MonacoBinding(doc.getText('monaco'), model, new Set([editor]), awareness);
    bindingRef.current = binding;

    announceActiveFile(fileId);

    return () => {
      binding.destroy();
      provider.destroy();
      doc.destroy();
      bindingRef.current = null;
      providerRef.current = null;
      docRef.current = null;
    };
    // `editor` and `file?.id` are here so this re-runs when Monaco finishes
    // loading and when the file list arrives — either can land after the first
    // render, and without them the effect bails once and is never retried.
    // `file.name` is still excluded: a rename must not tear down the doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, fileId, file?.id, awareness, projectId]);

  // ─── Remote cursor colours and labels ───────────────────────────────────────
  useEffect(() => {
    if (!awareness) return;
    const update = () => syncRemoteCursorStyles(awareness);
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [awareness]);

  // ─── Publish our own viewport for follow mode ───────────────────────────────
  useEffect(() => {
    if (!editor || !awareness) return;

    const publish = () => {
      setLocalAwareness(awareness, {
        activeFileId: fileId,
        scrollTop: editor.getScrollTop(),
      });
    };

    const disposable = editor.onDidScrollChange(publish);
    publish();
    return () => disposable.dispose();
  }, [editor, awareness, fileId]);

  // ─── Follow mode: track the followed peer's viewport ────────────────────────
  useEffect(() => {
    if (!editor || !awareness || !following) return;

    const apply = () => {
      for (const [, raw] of awareness.getStates()) {
        const state = raw as Partial<AwarenessState>;
        if (state.user?.id !== following) continue;
        if (state.scrollTop !== undefined) editor.setScrollTop(state.scrollTop);
      }
    };

    awareness.on('change', apply);
    apply();
    return () => awareness.off('change', apply);
  }, [editor, awareness, following]);

  // Any local keystroke breaks follow — you cannot be dragged around while typing.
  useEffect(() => {
    if (!editor || !following) return;
    const disposable = editor.onDidChangeModelContent(() =>
      useUiStore.getState().setFollowing(null),
    );
    return () => disposable.dispose();
  }, [editor, following]);

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-muted">
        This file no longer exists.
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {!canEdit ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-xs text-ink-muted">
          <Eye size={13} />
          Read-only — you have viewer access to this project.
        </div>
      ) : null}

      {status === 'disconnected' ? (
        <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <WifiOff size={13} />
          Disconnected. Your edits are saved locally and will merge when you reconnect.
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <Editor
          // A stable key per file: remounting on every render would recreate
          // the editor and lose the binding.
          path={file.path}
          theme={editorTheme}
          onMount={handleMount}
          loading={<Spinner label="Loading editor" className="p-6" />}
          options={{
            fontSize,
            tabSize,
            fontFamily: 'var(--font-mono)',
            fontLigatures: true,
            wordWrap: wordWrap ? 'on' : 'off',
            minimap: { enabled: minimap },
            readOnly: !canEdit,
            // A viewer should still be able to select and copy.
            domReadOnly: false,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
            guides: { indentation: true, bracketPairs: false },
            padding: { top: 12, bottom: 12 },
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            stickyScroll: { enabled: false },
          }}
        />

        {status === 'connecting' ? (
          <div className="pointer-events-none absolute right-3 top-3 rounded bg-surface-2/90 px-2 py-1 text-xs text-ink-muted">
            Syncing…
          </div>
        ) : null}
      </div>
    </div>
  );
}
