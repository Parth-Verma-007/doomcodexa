import { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useAuthActions, useAuthState } from '../lib/auth.js';
import { Avatar } from './Avatar.js';

/**
 * The signed-in user, and the one action they need from anywhere.
 *
 * Replaces Clerk's `<UserButton>`. Deliberately small: profile editing lives on
 * its own surface, and a menu that only ever holds one item should look like
 * one item.
 */
export function UserMenu() {
  const { user, email } = useAuthState();
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-border bg-surface-1 py-1 pl-1 pr-3 text-sm transition-colors hover:border-border-strong"
      >
        <Avatar user={user} size={22} />
        <span className="max-w-28 truncate">{user.username}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border border-border bg-surface-1 shadow-[var(--shadow-card)]"
        >
          <div className="border-b border-border px-3 py-2.5">
            <p className="truncate text-sm font-medium">{user.username}</p>
            <p className="truncate text-xs text-ink-faint">{email}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
