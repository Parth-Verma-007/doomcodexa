import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  Cpu,
  FileCode2,
  FolderGit2,
  MessageSquare,
  Users,
} from 'lucide-react';
import type { AdminOverview } from '@codexa/shared';
import { api, ApiError } from '../lib/api.js';
import { Spinner } from '../components/Spinner.js';
import { Avatar } from '../components/Avatar.js';
import { GridMesh } from '../components/decor/GridMesh.js';
import { formatRelativeTime, cn } from '../lib/utils.js';

/**
 * The admin panel.
 *
 * Two things are deliberate. It is **read only** — every destructive action an
 * admin might want already exists as an owner-scoped route that checks its own
 * permissions, and adding admin overrides would mean a second authorisation
 * path around the same objects. And it does not guard itself: the server
 * answers `/api/admin/*` with 404 for anyone not in `ADMIN_EMAILS`, so a
 * non-admin who navigates here directly sees the same "not found" they would
 * get from any wrong URL. The client never decides who is an admin.
 */
export function AdminPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.adminOverview(),
    // The point of this page is what is happening now.
    refetchInterval: 10_000,
  });

  return (
    <div className="relative h-full overflow-y-auto bg-surface-0">
      <div className="pointer-events-none fixed inset-0">
        <GridMesh size={34} fade="top" className="opacity-20" />
      </div>

      <div className="relative mx-auto max-w-5xl px-6 py-8">
        <Link
          to="/dashboard"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
        >
          <ArrowLeft size={14} />
          Back to projects
        </Link>

        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="mb-6 text-sm text-ink-muted">
          Instance-wide activity. Read only — nothing here changes anything.
        </p>

        {isLoading ? (
          <Spinner label="Loading" />
        ) : error ? (
          <p className="rounded-md border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            {error instanceof ApiError && error.status === 404
              ? 'This page is not available for your account.'
              : 'Could not load the overview.'}
          </p>
        ) : data ? (
          <Overview data={data} />
        ) : null}
      </div>
    </div>
  );
}

function Overview({ data }: { data: AdminOverview }) {
  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={<Users size={15} />} label="Users" value={data.totals.users} />
        <Stat icon={<FolderGit2 size={15} />} label="Projects" value={data.totals.projects} />
        <Stat icon={<FileCode2 size={15} />} label="Files" value={data.totals.files} />
        <Stat
          icon={<Activity size={15} />}
          label="Runs"
          value={data.totals.runs}
          hint={`${data.totals.runsToday} in the last 24h`}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Panel title="Execution">
          <Row label="Engine">
            <span className={data.execution.available ? 'text-success' : 'text-warning'}>
              {data.execution.available ? 'available' : 'unavailable'}
            </span>
          </Row>
          {data.execution.unavailableReason ? (
            <p className="mt-1 text-xs text-ink-faint">{data.execution.unavailableReason}</p>
          ) : null}
          <Row label="Running now">{data.execution.active}</Row>
          <Row label="Queued">{data.execution.queued}</Row>
        </Panel>

        <Panel title="Process">
          <Row label="Uptime">{formatUptime(data.process.uptimeSeconds)}</Row>
          <Row label="Node">{data.process.nodeVersion}</Row>
          <Row label="Memory">{(data.process.rssBytes / 1024 / 1024).toFixed(0)} MB</Row>
          <Row label="Environment">{data.process.env}</Row>
        </Panel>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Panel title="Runs by language">
          <Bars
            rows={data.runsByLanguage.map((r) => ({ label: r.language, count: r.count }))}
            empty="Nothing has been run yet."
          />
        </Panel>
        <Panel title="Runs by outcome">
          <Bars
            rows={data.runsByStatus.map((r) => ({ label: r.status, count: r.count }))}
            empty="Nothing has been run yet."
            tone
          />
        </Panel>
      </section>

      <Panel title="Recent runs">
        {data.recentRuns.length === 0 ? (
          <p className="text-sm text-ink-faint">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {data.recentRuns.map((run) => (
              <li key={run.id} className="flex items-center gap-3 py-2 text-sm">
                <span
                  className={cn(
                    'w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] uppercase tracking-wide',
                    run.status === 'success'
                      ? 'bg-success/15 text-success'
                      : run.status === 'killed'
                        ? 'bg-surface-3 text-ink-muted'
                        : 'bg-danger/15 text-danger',
                  )}
                >
                  {run.status}
                </span>
                <span className="w-14 shrink-0 font-mono text-xs text-ink-muted">
                  {run.language}
                </span>
                <span className="truncate font-mono text-xs text-ink-faint">{run.entrypoint}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-ink-faint">
                  {run.runMs !== null ? <span>{run.runMs} ms</span> : null}
                  {run.by ? (
                    <span className="flex items-center gap-1.5">
                      <Avatar user={run.by} size={18} />
                      {run.by.username}
                    </span>
                  ) : null}
                  <span>{formatRelativeTime(run.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Newest users">
        <ul className="divide-y divide-border/60">
          {data.newestUsers.map((user) => (
            <li key={user.id} className="flex items-center gap-2.5 py-2 text-sm">
              <Avatar user={user} size={22} />
              <span className="truncate">{user.username}</span>
              <span className="truncate text-xs text-ink-faint">{user.email}</span>
              <span className="ml-auto shrink-0 text-xs text-ink-faint">
                {formatRelativeTime(user.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <MessageSquare size={12} />
        {data.messages} chat messages stored
        <Cpu size={12} className="ml-3" />
        refreshes every 10s
      </p>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <span className="mb-1 flex items-center gap-1.5 text-xs text-ink-muted">
        {icon}
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</span>
      {hint ? <span className="mt-0.5 block text-xs text-ink-faint">{hint}</span> : null}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

/** Proportional bars, scaled to the largest row so the shape is readable. */
function Bars({
  rows,
  empty,
  tone = false,
}: {
  rows: { label: string; count: number }[];
  empty: string;
  tone?: boolean;
}) {
  if (rows.length === 0) return <p className="text-sm text-ink-faint">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.count));

  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.label} className="flex items-center gap-2 text-sm">
          <span className="w-16 shrink-0 truncate text-xs text-ink-muted">{row.label}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
            <span
              className={cn(
                'block h-full rounded-full',
                tone && row.label !== 'success' ? 'bg-danger/70' : 'bg-accent',
              )}
              style={{ width: `${Math.max(2, (row.count / max) * 100)}%` }}
            />
          </span>
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-ink-faint">
            {row.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

export default AdminPage;
