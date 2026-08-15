import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { FileDto } from '@codexa/shared';
import { isValidSegment } from '@codexa/shared';
import { useProject } from '../project/ProjectContext.js';
import { useUiStore } from '../../stores/uiStore.js';
import { api, ApiError } from '../../lib/api.js';
import { cn } from '../../lib/utils.js';
import { Dialog } from '../../components/Dialog.js';
import { Button } from '../../components/Button.js';

interface TreeNode extends FileDto {
  children: TreeNode[];
}

/** The API returns a flat list; nesting happens here (§11). */
function buildTree(files: FileDto[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const file of files) nodes.set(file.id, { ...file, children: [] });

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Folders first, then alphabetical — the ordering every file explorer uses.
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    list.forEach((n) => sort(n.children));
  };
  sort(roots);

  return roots;
}

export function FileTree() {
  const { projectId, files, canEdit, project, refreshFiles } = useProject();
  const openTab = useUiStore((s) => s.openTab);
  const activeFileId = useUiStore((s) => s.activeFileId);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<{
    type: 'file' | 'folder';
    parentId: string | null;
  } | null>(null);
  const [renaming, setRenaming] = useState<FileDto | null>(null);
  const [deleting, setDeleting] = useState<FileDto | null>(null);

  const tree = useMemo(() => buildTree(files), [files]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleOpen = (node: TreeNode) => {
    if (node.type === 'folder') {
      toggle(node.id);
      return;
    }
    openTab({ fileId: node.id, name: node.name });
  };

  const setEntrypoint = async (node: TreeNode) => {
    try {
      await api.updateProject(projectId, { entrypointFileId: node.id });
      toast.success(`${node.name} is now the entrypoint.`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not set the entrypoint.');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Files</h2>
        {canEdit ? (
          <div className="flex gap-0.5">
            <button
              type="button"
              onClick={() => setCreating({ type: 'file', parentId: null })}
              title="New file"
              aria-label="New file"
              className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <FilePlus size={14} />
            </button>
            <button
              type="button"
              onClick={() => setCreating({ type: 'folder', parentId: null })}
              title="New folder"
              aria-label="New folder"
              className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <FolderPlus size={14} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1" role="tree" aria-label="Project files">
        {tree.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-ink-faint">
            No files yet.
            {canEdit ? ' Use the + button to create one.' : null}
          </p>
        ) : (
          tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={0}
              expanded={expanded}
              activeFileId={activeFileId}
              entrypointId={project?.entrypointFileId ?? null}
              canEdit={canEdit}
              onOpen={handleOpen}
              onNewChild={(parentId, type) => {
                setExpanded((c) => new Set(c).add(parentId));
                setCreating({ type, parentId });
              }}
              onRename={setRenaming}
              onDelete={setDeleting}
              onSetEntrypoint={setEntrypoint}
            />
          ))
        )}
      </div>

      <NameDialog
        open={creating !== null}
        title={creating?.type === 'folder' ? 'New folder' : 'New file'}
        description={
          creating?.type === 'file'
            ? 'The extension decides the language — main.cpp, Main.java, main.py, main.c.'
            : undefined
        }
        confirmLabel="Create"
        onClose={() => setCreating(null)}
        onSubmit={async (name) => {
          if (!creating) return;
          await api.createFile(projectId, {
            name,
            type: creating.type,
            parentId: creating.parentId,
          });
          // The socket broadcast usually beats us here; refresh anyway so the
          // creator is never left staring at a tree missing their new file.
          await refreshFiles();
        }}
      />

      <NameDialog
        open={renaming !== null}
        title={`Rename ${renaming?.name ?? ''}`}
        confirmLabel="Rename"
        initialValue={renaming?.name ?? ''}
        onClose={() => setRenaming(null)}
        onSubmit={async (name) => {
          if (!renaming) return;
          await api.updateFile(renaming.id, { name });
          await refreshFiles();
        }}
      />

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        description={
          deleting?.type === 'folder'
            ? 'Everything inside this folder will be deleted too. This cannot be undone.'
            : 'This cannot be undone.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleting) return;
                try {
                  await api.deleteFile(deleting.id);
                  await refreshFiles();
                } catch (error) {
                  toast.error(error instanceof ApiError ? error.message : 'Could not delete.');
                } finally {
                  setDeleting(null);
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  activeFileId,
  entrypointId,
  canEdit,
  onOpen,
  onNewChild,
  onRename,
  onDelete,
  onSetEntrypoint,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activeFileId: string | null;
  entrypointId: string | null;
  canEdit: boolean;
  onOpen: (node: TreeNode) => void;
  onNewChild: (parentId: string, type: 'file' | 'folder') => void;
  onRename: (node: FileDto) => void;
  onDelete: (node: FileDto) => void;
  onSetEntrypoint: (node: TreeNode) => void;
}) {
  const isOpen = expanded.has(node.id);
  const isActive = node.id === activeFileId;
  const isEntrypoint = node.id === entrypointId;

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={node.type === 'folder' ? isOpen : undefined}
        aria-selected={isActive}
        tabIndex={0}
        onClick={() => onOpen(node)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(node);
          }
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={cn(
          'group flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-sm transition-colors',
          isActive ? 'bg-accent/15 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
        )}
      >
        {node.type === 'folder' ? (
          <>
            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {isOpen ? (
              <FolderOpen size={14} className="text-accent" />
            ) : (
              <Folder size={14} className="text-accent" />
            )}
          </>
        ) : (
          <>
            <span className="w-[13px]" />
            <FileIcon size={14} className={isEntrypoint ? 'text-success' : 'text-ink-faint'} />
          </>
        )}

        <span className="truncate">{node.name}</span>

        {isEntrypoint ? (
          <span
            className="ml-1 rounded bg-success/15 px-1 text-[10px] font-medium text-success"
            title="The Run button targets this file"
          >
            main
          </span>
        ) : null}

        {canEdit ? (
          <div className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {node.type === 'folder' ? (
              <IconAction
                label={`New file in ${node.name}`}
                onClick={() => onNewChild(node.id, 'file')}
              >
                <FilePlus size={12} />
              </IconAction>
            ) : null}
            {node.type === 'file' && node.language && !isEntrypoint ? (
              <IconAction
                label={`Run ${node.name} by default`}
                onClick={() => onSetEntrypoint(node)}
              >
                <Play size={12} />
              </IconAction>
            ) : null}
            <IconAction label={`Rename ${node.name}`} onClick={() => onRename(node)}>
              <Pencil size={12} />
            </IconAction>
            <IconAction label={`Delete ${node.name}`} onClick={() => onDelete(node)}>
              <Trash2 size={12} />
            </IconAction>
          </div>
        ) : null}
      </div>

      {node.type === 'folder' && isOpen
        ? node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activeFileId={activeFileId}
              entrypointId={entrypointId}
              canEdit={canEdit}
              onOpen={onOpen}
              onNewChild={onNewChild}
              onRename={onRename}
              onDelete={onDelete}
              onSetEntrypoint={onSetEntrypoint}
            />
          ))
        : null}
    </>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
    >
      {children}
    </button>
  );
}

/**
 * Name prompt with client-side validation that mirrors the server's exactly —
 * both call `isValidSegment` from the shared package, so the two can't drift.
 */
function NameDialog({
  open,
  title,
  description,
  confirmLabel,
  initialValue = '',
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  initialValue?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setValue(initialValue);
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    const name = value.trim();
    if (!isValidSegment(name)) {
      setError('That name contains illegal characters or is reserved.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(name);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={title}
      {...(description ? { description } : {})}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || value.trim().length === 0}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        key={open ? 'open' : 'closed'}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
        }}
        placeholder="main.cpp"
        aria-label="Name"
        aria-invalid={error !== null}
        className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-sm outline-none focus:border-accent"
      />
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </Dialog>
  );
}
