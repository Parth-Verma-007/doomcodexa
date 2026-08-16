import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, FolderPlus, Link2, Plus, Share2, ShieldCheck, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGE_LIST, type LanguageId, type ProjectDto } from '@codexa/shared';
import { api, ApiError } from '../lib/api.js';
import { Button } from '../components/Button.js';
import { Dialog } from '../components/Dialog.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import { Spinner } from '../components/Spinner.js';
import { Avatar } from '../components/Avatar.js';
import { ShareDialog } from '../features/share/ShareDialog.js';
import { GridMesh } from '../components/decor/GridMesh.js';
import { FramedPanel } from '../components/decor/FramedPanel.js';
import { formatRelativeTime, cn } from '../lib/utils.js';

export function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  /** The project whose share dialog is open, if any. */
  const [sharing, setSharing] = useState<ProjectDto | null>(null);

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: Infinity });

  const { data, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });

  const remove = useMutation({
    mutationFn: (projectId: string) => api.deleteProject(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project deleted.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the project.'),
  });

  return (
    <div className="relative h-full overflow-y-auto bg-surface-0">
      {/* A faint mesh behind the whole page stops the grid of cards reading as
          a flat sheet, without competing with them for attention. */}
      <div className="pointer-events-none fixed inset-0">
        {/* Deliberately fainter than the landing page's. Here it sits behind
            real content rather than a hero, so it should register as texture
            and never compete with a card. */}
        <GridMesh size={34} fade="top" className="opacity-20" />
      </div>

      <div className="relative">
        <header className="sticky top-0 z-20 border-b border-border/70 bg-surface-0/80 backdrop-blur-md">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <Link to="/" className="flex items-center gap-2 font-semibold">
              <Code2 size={18} className="text-accent" />
              Codexa
            </Link>
            <div className="flex items-center gap-3">
              {/* Shown only to admins, but the link is not the security boundary
                  — the API 404s `/api/admin/*` for everyone else regardless. */}
              {me?.isAdmin ? (
                <Link
                  to="/admin"
                  className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <ShieldCheck size={15} />
                  Admin
                </Link>
              ) : null}
              <ThemeToggle />
              <Button variant="primary" sheen onClick={() => setCreating(true)}>
                <Plus size={15} />
                New project
              </Button>
              <UserMenu />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-8">
          <h1 className="mb-6 text-2xl font-semibold tracking-tight">Your projects</h1>

          {isLoading ? (
            <Spinner label="Loading projects" />
          ) : error ? (
            <p className="rounded-md border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              {error instanceof ApiError ? error.message : 'Could not load your projects.'}
            </p>
          ) : data && data.projects.length > 0 ? (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.projects.map((project) => (
                <li key={project.id}>
                  <ProjectCard
                    project={project}
                    onShare={() => setSharing(project)}
                    onDelete={() => {
                      if (
                        window.confirm(
                          `Delete "${project.name}" and everything in it? This cannot be undone.`,
                        )
                      ) {
                        remove.mutate(project.id);
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <FramedPanel className="p-12 text-center">
              <span className="mb-3 inline-flex rounded-lg bg-accent/12 p-2.5 text-accent">
                <FolderPlus size={20} />
              </span>
              <p className="mb-1 font-medium">No projects yet</p>
              <p className="mx-auto mb-5 max-w-sm text-sm text-ink-muted">
                Create one and share the link — whoever opens it can code with you straight away.
              </p>
              <Button variant="primary" sheen onClick={() => setCreating(true)}>
                <Plus size={15} />
                New project
              </Button>
            </FramedPanel>
          )}
        </main>
      </div>

      <CreateProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(projectId) => navigate(`/p/${projectId}`)}
      />

      {sharing ? <ShareFromDashboard project={sharing} onClose={() => setSharing(null)} /> : null}
    </div>
  );
}

/**
 * The share dialog, opened from a card rather than from inside a project.
 *
 * Roles are fetched here rather than shipped with the project list: the list
 * carries only faces, and a role per member is detail nobody needs until the
 * dialog is actually open. Mounting this component *is* the trigger, so the
 * request happens on open and not on page load.
 */
function ShareFromDashboard({ project, onClose }: { project: ProjectDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState(project);

  const { data } = useQuery({
    queryKey: ['members', project.id],
    queryFn: () => api.listMembers(project.id),
  });

  return (
    <ShareDialog
      open
      onClose={onClose}
      project={current}
      members={data?.members ?? []}
      onProjectChange={(updated) => {
        setCurrent(updated);
        // The card shows whether a link is live, so the list has to hear about it.
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
      }}
    />
  );
}

/**
 * One project on the dashboard.
 *
 * The card carries the three things you actually want at a glance — who is on
 * it, what language it is, when it last moved — and the two actions you want
 * without opening it: share and delete. Sharing used to live only inside an
 * open project, which meant inviting someone cost a full page load and a Monaco
 * boot first.
 *
 * The whole card is a link, and the action buttons sit *outside* that link
 * rather than inside it. Nesting a button in an anchor is invalid HTML and
 * leaves the click target ambiguous; keeping them siblings in a positioned
 * container gives each one an unambiguous hit area.
 */
function ProjectCard({
  project,
  onShare,
  onDelete,
}: {
  project: ProjectDto;
  onShare: () => void;
  onDelete: () => void;
}) {
  const isOwner = project.myRole === 'owner';
  const extra = project.memberCount - project.members.length;

  return (
    <div className="group relative h-full overflow-hidden rounded-xl border border-border bg-surface-1 transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--shadow-card)]">
      {/* Accent hairline that wipes in on hover — a cheap way to make a dense
          grid feel responsive to the pointer. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-[linear-gradient(90deg,transparent,var(--color-accent),transparent)] transition-transform duration-300 group-hover:scale-x-100"
      />

      <Link to={`/p/${project.id}`} className="block p-4 pb-2">
        <div className="mb-2 flex items-start justify-between gap-2">
          <h2 className="truncate font-medium">{project.name}</h2>
          <span className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-muted">
            {project.defaultLanguage}
          </span>
        </div>

        {project.description ? (
          <p className="mb-3 line-clamp-2 text-sm text-ink-muted">{project.description}</p>
        ) : null}

        <div className="flex items-center gap-2 text-xs text-ink-faint">
          <span>{formatRelativeTime(project.updatedAt)}</span>
          <span aria-hidden>·</span>
          <span className="capitalize">{project.myRole}</span>
          {project.shareToken ? (
            <>
              <span aria-hidden>·</span>
              <span className="flex items-center gap-1 text-accent" title="A share link is active">
                <Link2 size={11} />
                shared
              </span>
            </>
          ) : null}
        </div>
      </Link>

      {/* ─── Faces and actions ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-1">
        <div className="flex items-center">
          {project.members.length > 0 ? (
            <div className="flex -space-x-1.5">
              {project.members.map((member) => (
                <span key={member.id} title={member.username}>
                  <Avatar user={member} size={22} ring />
                </span>
              ))}
            </div>
          ) : (
            <span className="flex items-center gap-1 text-xs text-ink-faint">
              <Users size={11} />
              {project.memberCount}
            </span>
          )}
          {extra > 0 ? <span className="ml-1.5 text-xs text-ink-faint">+{extra}</span> : null}
        </div>

        <div className="flex items-center gap-1">
          {isOwner ? (
            <button
              type="button"
              onClick={onShare}
              aria-label={`Share ${project.name}`}
              title="Share this project"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-2 hover:text-accent"
            >
              <Share2 size={13} />
              Share
            </button>
          ) : null}

          {isOwner ? (
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete ${project.name}`}
              title={`Delete ${project.name}`}
              className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-danger/15 hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CreateProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<LanguageId>('cpp');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setBusy(true);
    try {
      const { project } = await api.createProject({
        name: trimmed,
        language,
        useTemplate: true,
      });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      setName('');
      onClose();
      onCreated(project.id);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the project.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description="It starts with a working program you can run straight away."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <label
        htmlFor="new-project-name"
        className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-muted"
      >
        Name
      </label>
      <input
        id="new-project-name"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
        }}
        placeholder="Binary search practice"
        className="mb-4 w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm outline-none focus:border-accent"
      />

      <fieldset>
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
          Language
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {LANGUAGE_LIST.map((spec) => (
            <label
              key={spec.id}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                language === spec.id
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-border-strong',
              )}
            >
              <input
                type="radio"
                name="language"
                checked={language === spec.id}
                onChange={() => setLanguage(spec.id)}
                className="accent-[var(--color-accent)]"
              />
              <span>{spec.label}</span>
              <span className="ml-auto font-mono text-[11px] text-ink-faint">
                {spec.defaultEntrypoint}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}
