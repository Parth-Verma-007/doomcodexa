import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

/**
 * A dashed technical frame with a small cross at each corner — the "blueprint"
 * treatment. Reads as precise rather than decorative, which suits a developer
 * tool, and is drawn entirely with borders and pseudo-elements.
 *
 * Use for empty states, drop targets and feature callouts.
 */
export function FramedPanel({
  children,
  className,
  dashed = true,
  corners = true,
}: {
  children: ReactNode;
  className?: string;
  dashed?: boolean;
  corners?: boolean;
}) {
  return (
    <div
      className={cn(
        'relative rounded-lg border border-border',
        dashed && 'border-dashed',
        corners && 'codexa-corners',
        className,
      )}
    >
      {children}
    </div>
  );
}
