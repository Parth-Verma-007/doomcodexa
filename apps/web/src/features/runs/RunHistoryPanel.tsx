import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Clock, Skull } from 'lucide-react';
import type { RunDto, RunStatus } from '@codexa/shared';
import { api } from '../../lib/api.js';
import { useProject } from '../project/ProjectContext.js';
import { useRunStore } from '../../stores/runStore.js';
import { Avatar } from '../../components/Avatar.js';
import { Spinner } from '../../components/Spinner.js';
import { formatDuration, formatRelativeTime } from '../../lib/utils.js';

export function RunHistoryPanel() {
  const { projectId } = useProject();
  const current = useRunStore((s) => s.current);

  const { data, isLoading } = useQuery({
    queryKey: ['runs', projectId, current?.phase],
    queryFn: () => api.listRuns(projectId, 25),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Run history
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <Spinner label="Loading" className="p-3" />
        ) : !data || data.runs.length === 0 ? (
          <p className="p-4 text-center text-sm text-ink-faint">Nothing has been run yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RunRow({ run }: { run: RunDto }) {
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <StatusIcon status={run.status} />
        <span className="truncate font-mono text-xs">{run.entrypoint.replace(/^\//, '')}</span>
        <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
          {formatDuration(run.runMs)}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-1.5 pl-6 text-[11px] text-ink-faint">
        {run.triggeredBy ? <Avatar user={run.triggeredBy} size={14} /> : null}
        <span className="truncate">{run.triggeredBy?.username ?? 'someone'}</span>
        <span>·</span>
        <time dateTime={run.createdAt}>{formatRelativeTime(run.createdAt)}</time>
        {run.exitCode !== null && run.exitCode !== 0 ? (
          <>
            <span>·</span>
            <span className="text-danger">exit {run.exitCode}</span>
          </>
        ) : null}
      </div>
    </li>
  );
}

function StatusIcon({ status }: { status: RunStatus }) {
  const size = 13;
  if (status === 'success') return <CheckCircle2 size={size} className="shrink-0 text-success" />;
  if (status === 'timeout') return <Clock size={size} className="shrink-0 text-warning" />;
  if (status === 'oom') return <Skull size={size} className="shrink-0 text-warning" />;
  if (status === 'queued' || status === 'compiling' || status === 'running') {
    return <Clock size={size} className="shrink-0 animate-pulse text-accent" />;
  }
  return <CircleAlert size={size} className="shrink-0 text-danger" />;
}
