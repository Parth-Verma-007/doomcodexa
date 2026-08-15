import { X, Play } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore.js';
import { useProject } from '../project/ProjectContext.js';
import { disposeModel } from '../../lib/monaco.js';
import { cn } from '../../lib/utils.js';

export function EditorTabs() {
  const openTabs = useUiStore((s) => s.openTabs);
  const activeFileId = useUiStore((s) => s.activeFileId);
  const setActiveFile = useUiStore((s) => s.setActiveFile);
  const closeTab = useUiStore((s) => s.closeTab);
  const { files, project } = useProject();

  if (openTabs.length === 0) return null;

  const handleClose = (fileId: string) => {
    closeTab(fileId);
    // Closing a tab is the point at which the model's undo history is no
    // longer wanted, so this is where it gets disposed (§12).
    disposeModel(fileId);
  };

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface-1"
    >
      {openTabs.map((tab) => {
        const isActive = tab.fileId === activeFileId;
        const file = files.find((f) => f.id === tab.fileId);
        const isEntrypoint = project?.entrypointFileId === tab.fileId;

        return (
          <div
            key={tab.fileId}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => setActiveFile(tab.fileId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setActiveFile(tab.fileId);
              }
            }}
            // Middle-click to close, as in every other editor.
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                handleClose(tab.fileId);
              }
            }}
            className={cn(
              'group flex cursor-pointer items-center gap-2 border-r border-border px-3 py-2 text-sm whitespace-nowrap transition-colors',
              isActive
                ? 'bg-surface-0 text-ink'
                : 'bg-surface-1 text-ink-muted hover:bg-surface-2 hover:text-ink',
            )}
            title={file?.path ?? tab.name}
          >
            {isEntrypoint ? (
              <Play size={11} className="shrink-0 text-success" aria-label="Entrypoint" />
            ) : null}
            <span>{tab.name}</span>
            <button
              type="button"
              aria-label={`Close ${tab.name}`}
              onClick={(event) => {
                event.stopPropagation();
                handleClose(tab.fileId);
              }}
              className="rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-3 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
