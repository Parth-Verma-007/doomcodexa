import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils.js';

/**
 * A modal built on <dialog>, which gives focus trapping, Escape handling and
 * inert background content from the platform rather than from a hook.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Fires for Escape as well as an explicit close(), so both paths tell React.
    const handleClose = () => onClose();

    // Backdrop dismissal. Attached natively rather than as an onClick prop:
    // a click handler on the <dialog> element itself is a non-interactive
    // element handler as far as JSX a11y linting is concerned, and Escape
    // already provides the keyboard equivalent for free.
    const handleClick = (event: MouseEvent) => {
      if (event.target === node) onClose();
    };

    node.addEventListener('close', handleClose);
    node.addEventListener('click', handleClick);
    return () => {
      node.removeEventListener('close', handleClose);
      node.removeEventListener('click', handleClick);
    };
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      className={cn(
        'w-[min(32rem,calc(100vw-2rem))] rounded-xl p-0 text-ink',
        'codexa-glass',
        'backdrop:bg-black/55 backdrop:backdrop-blur-sm',
        // A dialog is the one place a real shadow earns its keep — it lifts the
        // pane clearly off the blurred page behind it.
        'shadow-[0_24px_64px_rgb(0_0_0/0.45)]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 id="dialog-title" className="text-base font-semibold">
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {children ? <div className="px-5 py-4">{children}</div> : null}
      {footer ? (
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
      ) : null}
    </dialog>
  );
}
