import { useUiStore } from '../stores/uiStore.js';
import { cn } from '../lib/utils.js';
import ToggleButton from './ToggleButton.js';

/**
 * Theme switch for the page headers.
 *
 * The pill is a boolean control and the theme is a two-value string, so this
 * adapts between them: knob left is dark, knob right is light — the same
 * direction the eye reads the change.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  const isLight = theme === 'light';

  return (
    <div className={cn('flex items-center', className)}>
      <ToggleButton
        toggle={isLight}
        // The pill types its setter as a `useState` setter, so it may hand back
        // either a value or an updater. Resolve both rather than assume.
        setToggle={(next) => {
          const wantsLight = typeof next === 'function' ? next(isLight) : next;
          setTheme(wantsLight ? 'light' : 'dark');
        }}
        label={`Switch to ${isLight ? 'dark' : 'light'} theme`}
      />
    </div>
  );
}
