import type { UserDto } from '@codexa/shared';
import { cn, initialsOf, readableTextOn } from '../lib/utils.js';

/**
 * Presence avatar. Falls back to initials on the user's assigned colour, which
 * is the same colour their cursor uses — so matching a cursor to a person in
 * the avatar stack requires no reading.
 */
export function Avatar({
  user,
  size = 28,
  ring,
  className,
  title,
}: {
  user: UserDto;
  size?: number;
  ring?: boolean;
  className?: string;
  title?: string;
}) {
  const dimension = { width: size, height: size };

  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden rounded-full',
        ring && 'ring-2 ring-offset-2 ring-offset-surface-1',
        className,
      )}
      style={{ ...dimension, ...(ring ? { boxShadow: `0 0 0 2px ${user.color}` } : {}) }}
      title={title ?? user.username}
    >
      {user.avatarUrl ? (
        <img
          src={user.avatarUrl}
          alt={user.username}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          aria-hidden
          className="flex size-full items-center justify-center font-semibold"
          style={{
            background: user.color,
            color: readableTextOn(user.color),
            fontSize: Math.round(size * 0.4),
          }}
        >
          {initialsOf(user.username)}
        </span>
      )}
      <span className="sr-only">{user.username}</span>
    </div>
  );
}
