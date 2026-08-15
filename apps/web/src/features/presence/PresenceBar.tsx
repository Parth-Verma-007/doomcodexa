import { useEffect, useState } from 'react';
import { Crosshair } from 'lucide-react';
import type { AwarenessState, UserDto } from '@codexa/shared';
import { useProject } from '../project/ProjectContext.js';
import { useUiStore } from '../../stores/uiStore.js';
import { Avatar } from '../../components/Avatar.js';
import { cn } from '../../lib/utils.js';

/**
 * The avatar stack.
 *
 * Reads from awareness rather than the socket peer list so the "looking at"
 * label is live: awareness carries each peer's active file, which is also what
 * powers follow mode.
 */
export function PresenceBar() {
  const { awareness, files } = useProject();
  const following = useUiStore((s) => s.followingPeerId);
  const setFollowing = useUiStore((s) => s.setFollowing);
  const openTab = useUiStore((s) => s.openTab);

  const [others, setOthers] = useState<Array<{ user: UserDto; activeFileId: string | null }>>([]);

  useEffect(() => {
    if (!awareness) return;

    const read = () => {
      const seen = new Map<string, { user: UserDto; activeFileId: string | null }>();
      for (const [clientId, raw] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const state = raw as Partial<AwarenessState>;
        if (!state.user) continue;
        // One entry per person, not per tab: someone with two tabs open is
        // still one collaborator.
        seen.set(state.user.id, { user: state.user, activeFileId: state.activeFileId ?? null });
      }
      setOthers([...seen.values()]);
    };

    read();
    awareness.on('change', read);
    return () => awareness.off('change', read);
  }, [awareness]);

  if (others.length === 0) {
    return <span className="text-xs text-ink-faint">Only you are here</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex -space-x-2">
        {others.slice(0, 5).map(({ user, activeFileId }) => {
          const file = files.find((f) => f.id === activeFileId);
          const isFollowed = following === user.id;

          return (
            <button
              key={user.id}
              type="button"
              onClick={() => {
                if (isFollowed) {
                  setFollowing(null);
                  return;
                }
                // Following someone means going where they are, so open their
                // file first — otherwise the viewport tracks an invisible tab.
                if (file) openTab({ fileId: file.id, name: file.name });
                setFollowing(user.id);
              }}
              title={
                isFollowed
                  ? `Stop following ${user.username}`
                  : `${user.username}${file ? ` · ${file.name}` : ''} — click to follow`
              }
              className={cn(
                'relative rounded-full transition-transform hover:z-10 hover:scale-110',
                isFollowed && 'z-10 scale-110',
              )}
            >
              <Avatar user={user} size={26} ring />
              {isFollowed ? (
                <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-accent p-0.5 text-white">
                  <Crosshair size={8} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {others.length > 5 ? (
        <span className="text-xs text-ink-faint">+{others.length - 5}</span>
      ) : null}

      {following ? (
        <button
          type="button"
          onClick={() => setFollowing(null)}
          className="ml-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/25"
        >
          following · stop
        </button>
      ) : null}
    </div>
  );
}
