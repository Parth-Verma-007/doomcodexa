import { useState } from 'react';
import { Check, Copy, Link2, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { MemberDto, ProjectDto } from '@codexa/shared';
import { api, ApiError } from '../../lib/api.js';
import { Dialog } from '../../components/Dialog.js';
import { Button } from '../../components/Button.js';
import { Avatar } from '../../components/Avatar.js';
import { cn } from '../../lib/utils.js';

export function ShareDialog({
  open,
  onClose,
  project,
  onProjectChange,
  members,
}: {
  open: boolean;
  onClose: () => void;
  project: ProjectDto;
  onProjectChange: (project: ProjectDto) => void;
  /**
   * Passed in rather than read from `ProjectContext`. The dashboard has no such
   * context — it only has the list response — and reading it here meant sharing
   * was reachable from exactly one place in the app.
   */
  members?: MemberDto[];
}) {
  const people = members ?? [];
  const [role, setRole] = useState<'editor' | 'viewer'>(project.shareRole);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const isOwner = project.myRole === 'owner';
  const shareUrl = project.shareToken
    ? `${window.location.origin}/join?t=${project.shareToken}`
    : null;

  const mint = async () => {
    setBusy(true);
    try {
      const { project: updated } = await api.createShareLink(project.id, role);
      onProjectChange(updated);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create a link.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      const { project: updated } = await api.revokeShareLink(project.id);
      onProjectChange(updated);
      toast.success('Link revoked. Anyone holding it can no longer join.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not revoke the link.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy. Select the link and copy it manually.');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share this project"
      description={
        isOwner
          ? 'Anyone with the link can join at the role you pick.'
          : 'Only the owner can change sharing.'
      }
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {isOwner ? (
        <>
          <fieldset className="mb-4">
            <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
              People who join can
            </legend>
            <div className="flex gap-2">
              {(['editor', 'viewer'] as const).map((option) => (
                <label
                  key={option}
                  className={cn(
                    'flex flex-1 cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 transition-colors',
                    role === option
                      ? 'border-accent bg-accent/10'
                      : 'border-border hover:border-border-strong',
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="radio"
                      name="share-role"
                      checked={role === option}
                      onChange={() => setRole(option)}
                      className="accent-[var(--color-accent)]"
                    />
                    {option === 'editor' ? 'Edit' : 'View only'}
                  </span>
                  <span className="pl-6 text-xs text-ink-faint">
                    {option === 'editor'
                      ? 'Write code, create files, run'
                      : 'Read and run, but not edit'}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {shareUrl ? (
            <div className="mb-4">
              <div className="flex gap-2">
                <input
                  readOnly
                  value={shareUrl}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Share link"
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-xs text-ink-muted outline-none"
                />
                <Button onClick={() => void copy()} variant={copied ? 'primary' : 'secondary'}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>

              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => void mint()} disabled={busy}>
                  <RefreshCw size={12} /> Rotate link
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void revoke()} disabled={busy}>
                  <Trash2 size={12} /> Revoke
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] text-ink-faint">
                Rotating replaces the link immediately — anyone holding the old one loses access.
              </p>
            </div>
          ) : (
            <Button variant="primary" onClick={() => void mint()} disabled={busy} className="mb-4">
              <Link2 size={14} />
              Create a share link
            </Button>
          )}
        </>
      ) : null}

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
          People with access ({people.length})
        </h3>
        <ul className="space-y-1.5">
          {people.map((member) => (
            <li key={member.user.id} className="flex items-center gap-2.5">
              <Avatar user={member.user} size={24} />
              <span className="truncate text-sm">{member.user.username}</span>
              <span className="ml-auto rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                {member.role}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
