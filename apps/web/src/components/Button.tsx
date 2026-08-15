import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/utils.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** One-pass highlight on hover. Reserve it for the primary action on a view. */
  sheen?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  // A subtle vertical gradient plus an inset top highlight reads as a raised
  // surface without a drop shadow, which would muddy the dark theme.
  primary: cn(
    'text-white shadow-sm',
    'bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-accent)_92%,white)_0%,var(--color-accent)_100%)]',
    'shadow-[inset_0_1px_0_color-mix(in_oklab,white_28%,transparent)]',
    'hover:brightness-110 active:brightness-95',
    'disabled:brightness-75',
  ),
  secondary:
    'bg-surface-2 text-ink border border-border hover:bg-surface-3 hover:border-border-strong',
  ghost: 'text-ink-muted hover:bg-surface-2 hover:text-ink',
  danger: 'bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20',
  glass: 'codexa-glass text-ink hover:brightness-125',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md',
  lg: 'h-11 px-6 text-base gap-2 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', sheen = false, className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'relative inline-flex items-center justify-center font-medium',
        'transition-[filter,background-color,border-color,transform] duration-150',
        'active:translate-y-px',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0',
        VARIANTS[variant],
        SIZES[size],
        sheen && 'codexa-sheen',
        className,
      )}
      {...props}
    />
  );
});
