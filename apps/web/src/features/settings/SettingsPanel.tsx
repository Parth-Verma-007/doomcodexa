import { useUiStore, type ThemeName } from '../../stores/uiStore.js';
import { cn } from '../../lib/utils.js';

export function SettingsPanel() {
  const store = useUiStore();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Settings</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        <Field label="Appearance">
          <div className="flex gap-1">
            {(['light', 'dark'] as ThemeName[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => store.setTheme(option)}
                className={cn(
                  'flex-1 rounded-md border px-2 py-1.5 text-xs capitalize transition-colors',
                  store.theme === option
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
                )}
              >
                {option}
              </button>
            ))}
          </div>
        </Field>

        <Field label={`Font size — ${store.fontSize}px`}>
          <input
            type="range"
            min={10}
            max={24}
            step={1}
            value={store.fontSize}
            onChange={(event) => store.setFontSize(Number(event.target.value))}
            aria-label="Editor font size"
            className="w-full accent-[var(--color-accent)]"
          />
        </Field>

        <Field label="Tab size">
          <div className="flex gap-1">
            {[2, 4, 8].map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => store.setTabSize(size)}
                className={cn(
                  'flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors',
                  store.tabSize === size
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
                )}
              >
                {size}
              </button>
            ))}
          </div>
        </Field>

        <Toggle label="Word wrap" checked={store.wordWrap} onChange={store.toggleWordWrap} />
        <Toggle label="Minimap" checked={store.minimap} onChange={store.toggleMinimap} />

        <p className="border-t border-border pt-4 text-[11px] leading-relaxed text-ink-faint">
          These settings are yours alone — they are stored in this browser and do not change what
          anyone else sees.
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between text-sm">
      <span className="text-ink-muted">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="accent-[var(--color-accent)]"
      />
    </label>
  );
}
