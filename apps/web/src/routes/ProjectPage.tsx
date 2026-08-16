import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu.js';
import { useQuery } from '@tanstack/react-query';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  Files,
  History,
  MessageSquare,
  Moon,
  Phone,
  Play,
  Settings,
  Share2,
  Sun,
  TerminalSquare,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ProjectDto } from '@codexa/shared';
import { api, ApiError } from '../lib/api.js';
import { runSocket, emitWithAck } from '../lib/socket.js';
import { ProjectProvider, useProject } from '../features/project/ProjectContext.js';
import { FileTree } from '../features/filetree/FileTree.js';
import { EditorPane } from '../features/editor/EditorPane.js';
import { EditorTabs } from '../features/editor/EditorTabs.js';
import { TerminalPane } from '../features/terminal/TerminalPane.js';
import { ChatPanel } from '../features/chat/ChatPanel.js';
import { CallPanel } from '../features/rtc/CallPanel.js';
import { PresenceBar } from '../features/presence/PresenceBar.js';
import { ShareDialog } from '../features/share/ShareDialog.js';
import { SettingsPanel } from '../features/settings/SettingsPanel.js';
import { RunHistoryPanel } from '../features/runs/RunHistoryPanel.js';
import { useUiStore } from '../stores/uiStore.js';
import { useRunStore, isRunActive } from '../stores/runStore.js';
import { Spinner } from '../components/Spinner.js';
import { Button } from '../components/Button.js';
import { Logo } from '../components/Logo.js';
import { GridMesh } from '../components/decor/GridMesh.js';
import { FramedPanel } from '../components/decor/FramedPanel.js';
import { cn } from '../lib/utils.js';
import { configureMonaco } from '../lib/monaco.js';

// Runs once when this lazily-loaded chunk is first evaluated, which is exactly
// when Monaco is first needed. Registering themes and workers must happen
// before any <Editor> mounts.
configureMonaco();

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId as string),
    enabled: Boolean(projectId),
  });

  if (!projectId) return null;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Opening project" />
      </div>
    );
  }

  if (error || !data) {
    const message =
      error instanceof ApiError && error.status === 404
        ? 'This project does not exist, or you do not have access to it.'
        : 'Could not open this project.';
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-lg font-semibold">Nothing here</h1>
        <p className="max-w-md text-sm text-ink-muted">{message}</p>
        <Link to="/dashboard">
          <Button variant="primary">Back to your projects</Button>
        </Link>
      </div>
    );
  }

  return (
    <ProjectProvider projectId={projectId} initial={data}>
      <Ide />
    </ProjectProvider>
  );
}

function Ide() {
  const { project, projectId, files, error, connection } = useProject();
  const sidebarPanel = useUiStore((s) => s.sidebarPanel);
  const rightPanel = useUiStore((s) => s.rightPanel);
  const terminalVisible = useUiStore((s) => s.terminalVisible);
  const activeFileId = useUiStore((s) => s.activeFileId);
  const openTabs = useUiStore((s) => s.openTabs);
  const openTab = useUiStore((s) => s.openTab);
  const announceActiveFile = useProject().announceActiveFile;

  // Open the entrypoint on arrival so the editor is never an empty grey pane.
  useEffect(() => {
    if (openTabs.length > 0 || files.length === 0) return;
    const entry =
      files.find((f) => f.id === project?.entrypointFileId) ?? files.find((f) => f.type === 'file');
    if (entry) openTab({ fileId: entry.id, name: entry.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, project?.entrypointFileId]);

  useEffect(() => {
    announceActiveFile(activeFileId);
  }, [activeFileId, announceActiveFile]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-lg font-semibold">Access ended</h1>
        <p className="max-w-md text-sm text-ink-muted">{error}</p>
        <Link to="/dashboard">
          <Button variant="primary">Back to your projects</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar />

      {connection !== 'connected' ? (
        <div className="flex items-center gap-2 bg-warning/10 px-3 py-1 text-xs text-warning">
          <WifiOff size={12} />
          {connection === 'reconnecting'
            ? 'Reconnecting… your edits are kept locally and will merge automatically.'
            : 'Offline.'}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <ActivityBar />

        <PanelGroup direction="horizontal" className="min-h-0 flex-1" autoSaveId="codexa-columns">
          {sidebarPanel ? (
            <>
              <Panel defaultSize={18} minSize={12} maxSize={35} className="bg-surface-1">
                {sidebarPanel === 'files' ? <FileTree /> : null}
                {sidebarPanel === 'runs' ? <RunHistoryPanel /> : null}
                {sidebarPanel === 'settings' ? <SettingsPanel /> : null}
              </Panel>
              <ResizeHandle />
            </>
          ) : null}

          <Panel minSize={30}>
            <PanelGroup direction="vertical" autoSaveId="codexa-rows">
              <Panel minSize={20}>
                <div className="flex h-full min-h-0 flex-col bg-surface-0">
                  <EditorTabs />
                  <div className="min-h-0 flex-1">
                    {activeFileId ? (
                      <EditorPane key={activeFileId} fileId={activeFileId} />
                    ) : (
                      <EmptyEditor />
                    )}
                  </div>
                </div>
              </Panel>

              {terminalVisible ? (
                <>
                  <ResizeHandle horizontal />
                  <Panel defaultSize={30} minSize={10} maxSize={70}>
                    <TerminalPane />
                  </Panel>
                </>
              ) : null}
            </PanelGroup>
          </Panel>

          {rightPanel ? (
            <>
              <ResizeHandle />
              <Panel defaultSize={20} minSize={14} maxSize={35} className="bg-surface-1">
                {rightPanel === 'chat' ? <ChatPanel /> : <CallPanel projectId={projectId} />}
              </Panel>
            </>
          ) : null}
        </PanelGroup>
      </div>
    </div>
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

function Toolbar() {
  const { project, projectId, files, canEdit, members } = useProject();
  const activeFileId = useUiStore((s) => s.activeFileId);
  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const current = useRunStore((s) => s.current);
  const starting = useRunStore((s) => s.starting);

  const [sharing, setSharing] = useState(false);
  const [localProject, setLocalProject] = useState<ProjectDto | null>(project);

  useEffect(() => setLocalProject(project), [project]);

  const running = isRunActive(current);
  const activeFile = files.find((f) => f.id === activeFileId);
  // Run the file you are looking at when it is runnable, otherwise the
  // project's entrypoint — which is what a Run button should obviously do.
  const target = activeFile?.language
    ? activeFile
    : files.find((f) => f.id === project?.entrypointFileId);

  useEffect(() => {
    const socket = runSocket();
    void emitWithAck(socket, 'run:subscribe', { projectId }).catch(() => {});
  }, [projectId]);

  const startRun = async () => {
    if (running || starting) return;
    useRunStore.getState().setStarting(true);

    try {
      const response = await emitWithAck<{
        ok: boolean;
        data?: { runId: string };
        error?: { message: string };
      }>(runSocket(), 'run:start', {
        projectId,
        ...(target ? { fileId: target.id } : {}),
        interactive: true,
      });

      if (!response.ok) {
        toast.error(response.error?.message ?? 'Could not start the run.');
        useRunStore.getState().setStarting(false);
        return;
      }

      // `run:started` is broadcast to everyone, so it cannot know who pressed
      // the button. Only the initiator's ack does — which is what makes stdin
      // and Stop available to them and nobody else.
      const runId = response.data?.runId;
      const store = useRunStore.getState();
      if (runId && store.current?.runId === runId) {
        store.begin({ ...store.current, mine: true });
      }
      store.setStarting(false);
    } catch {
      toast.error('The server did not respond.');
      useRunStore.getState().setStarting(false);
    }
  };

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3 py-2">
      <Link to="/dashboard" className="flex items-center gap-1.5 text-sm font-semibold">
        <Logo size={16} />
        <span className="hidden sm:inline">Codexa</span>
      </Link>

      <span className="mx-1 h-4 w-px bg-border" />

      <span className="max-w-[16rem] truncate text-sm text-ink-muted" title={project?.name}>
        {project?.name}
      </span>

      <Button
        variant="primary"
        size="sm"
        onClick={() => void startRun()}
        disabled={running || starting || !target}
        title={target ? `Run ${target.name}` : 'Nothing runnable in this project'}
        className="ml-2"
      >
        <Play size={13} />
        {running ? 'Running…' : 'Run'}
      </Button>

      {target ? (
        <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">{target.name}</span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <PresenceBar />

        {/* The Settings panel carries the same control, but switching theme
            mid-session should not mean opening a panel and losing the sidebar
            you had there. The icon shows what you get, not where you are. */}
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
          aria-label={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
          className="rounded p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>

        <button
          type="button"
          onClick={toggleTerminal}
          title="Toggle the terminal"
          aria-label="Toggle the terminal"
          className="rounded p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <TerminalSquare size={15} />
        </button>

        {localProject ? (
          <Button
            size="sm"
            onClick={() => setSharing(true)}
            disabled={!canEdit && localProject.myRole !== 'owner'}
          >
            <Share2 size={13} />
            Share
          </Button>
        ) : null}

        <UserMenu />
      </div>

      {localProject ? (
        <ShareDialog
          open={sharing}
          onClose={() => setSharing(false)}
          project={localProject}
          onProjectChange={setLocalProject}
          members={members}
        />
      ) : null}
    </header>
  );
}

// ─── Activity bar ─────────────────────────────────────────────────────────────

function ActivityBar() {
  const sidebarPanel = useUiStore((s) => s.sidebarPanel);
  const rightPanel = useUiStore((s) => s.rightPanel);
  const setSidebarPanel = useUiStore((s) => s.setSidebarPanel);
  const setRightPanel = useUiStore((s) => s.setRightPanel);

  return (
    <nav
      aria-label="Panels"
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-1 py-2"
    >
      <ActivityButton
        label="Files"
        active={sidebarPanel === 'files'}
        onClick={() => setSidebarPanel('files')}
      >
        <Files size={17} />
      </ActivityButton>
      <ActivityButton
        label="Run history"
        active={sidebarPanel === 'runs'}
        onClick={() => setSidebarPanel('runs')}
      >
        <History size={17} />
      </ActivityButton>

      <span className="my-1 h-px w-5 bg-border" />

      <ActivityButton
        label="Chat"
        active={rightPanel === 'chat'}
        onClick={() => setRightPanel('chat')}
      >
        <MessageSquare size={17} />
      </ActivityButton>
      <ActivityButton
        label="Voice"
        active={rightPanel === 'call'}
        onClick={() => setRightPanel('call')}
      >
        <Phone size={17} />
      </ActivityButton>

      <ActivityButton
        label="Settings"
        active={sidebarPanel === 'settings'}
        onClick={() => setSidebarPanel('settings')}
        className="mt-auto"
      >
        <Settings size={17} />
      </ActivityButton>
    </nav>
  );
}

function ActivityButton({
  label,
  active,
  onClick,
  className,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'relative rounded-md p-2 transition-colors',
        active ? 'text-accent' : 'text-ink-faint hover:bg-surface-2 hover:text-ink',
        className,
      )}
    >
      {active ? (
        <span className="absolute inset-y-1 -left-1 w-0.5 rounded-full bg-accent" aria-hidden />
      ) : null}
      {children}
    </button>
  );
}

function ResizeHandle({ horizontal }: { horizontal?: boolean }) {
  return (
    <PanelResizeHandle
      className={cn(
        'group relative bg-border transition-colors data-[resize-handle-active]:bg-accent hover:bg-border-strong',
        horizontal ? 'h-px' : 'w-px',
      )}
    >
      {/* A 1px handle is impossible to grab; this widens the hit area only. */}
      <span
        aria-hidden
        className={cn('absolute', horizontal ? '-top-1.5 h-3 w-full' : '-left-1.5 h-full w-3')}
      />
    </PanelResizeHandle>
  );
}

function EmptyEditor() {
  return (
    <div className="relative flex h-full items-center justify-center p-6">
      <GridMesh size={28} className="opacity-40" />
      <FramedPanel className="relative px-10 py-8 text-center">
        <span className="mb-3 inline-flex rounded-lg bg-accent/12 p-2.5 text-accent">
          <Files size={20} />
        </span>
        <p className="text-sm font-medium">Pick a file to start editing</p>
        <p className="mt-1 text-xs text-ink-faint">
          Anything you type syncs to everyone here instantly.
        </p>
      </FramedPanel>
    </div>
  );
}
