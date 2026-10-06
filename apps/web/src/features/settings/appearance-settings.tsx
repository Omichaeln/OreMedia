import { cn } from '@oremedia/ui';
import { GroupHeader } from '../../components/section';
import { useTheme, type Theme, type ThemeChoice } from '../../lib/theme';
import { AccountPassword } from '../session/account-password';

/** The three choices as the interface offers them, each with the surfaces its preview shows. */
const OPTIONS: ReadonlyArray<{ key: ThemeChoice; label: string; note: string; panes: readonly Theme[] }> = [
  { key: 'light', label: 'Light', note: 'Warm off-white surfaces, near-black text.', panes: ['light'] },
  { key: 'dark', label: 'Dark', note: 'Low-glare surfaces for long editing sessions.', panes: ['dark'] },
  {
    key: 'system',
    label: 'Match system',
    note: 'Follows your device setting and switches automatically.',
    panes: ['light', 'dark'],
  },
];

/**
 * A miniature of the application in one theme: the pane pins its own `data-theme`, so the tokens resolve to that
 * theme's set whatever the page is in (packages/ui/tokens.css keys the light set on `[data-theme='light']` too).
 */
function Pane({ theme }: { theme: Theme }) {
  return (
    <span data-theme={theme} className="grid grid-cols-[28%_1fr] gap-1.5 bg-background p-2">
      <span className="rounded-[3px] bg-secondary" />
      <span className="flex flex-col gap-[5px]">
        <span className="h-[7px] w-[70%] rounded-sm bg-foreground" />
        <span className="h-[5px] w-[90%] rounded-sm bg-border-strong" />
        <span className="h-[5px] w-[60%] rounded-sm bg-border-strong" />
        <span className="mt-auto h-3 w-[44%] rounded-[3px] bg-foreground" />
      </span>
    </span>
  );
}

/**
 * Settings → Appearance: the theme (a per-device convenience, lib/theme.ts) as the interface's three preview cards,
 * then the signed-in person's own account (their password and sign-in methods) as a second group.
 */
export function AppearanceSettings() {
  const { choice, setTheme } = useTheme();
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="theme-heading" className="flex flex-col gap-5" data-testid="theme">
        <GroupHeader
          id="theme-heading"
          title="Theme"
          description="Applies to every surface you use, on this device. Brand artwork and the Studio canvas always show their true colours."
        />
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3"
        >
          {OPTIONS.map((o) => {
            const on = choice === o.key;
            return (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setTheme(o.key)}
                className={cn(
                  'flex flex-col gap-2.5 rounded-xl border bg-card p-3 text-left transition-colors',
                  'hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  on ? 'border-foreground ring-1 ring-foreground' : 'border-border',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid h-24 overflow-hidden rounded-lg border border-border',
                    o.panes.length === 2 ? 'grid-cols-2' : 'grid-cols-1',
                  )}
                >
                  {o.panes.map((p) => (
                    <Pane key={p} theme={p} />
                  ))}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                      on ? 'border-foreground' : 'border-border-strong',
                    )}
                  >
                    <span className={cn('h-1.5 w-1.5 rounded-full', on && 'bg-foreground')} />
                  </span>
                  <span className="text-base font-bold">{o.label}</span>
                </span>
                <span className="text-xs leading-[1.45] text-muted-foreground">{o.note}</span>
              </button>
            );
          })}
        </div>
      </section>
      <div className="flex flex-col gap-5 border-t border-border pt-6">
        <GroupHeader
          id="account-heading"
          title="Account"
          description="How you sign in. Your password is yours alone and is never shown to anyone."
        />
        <AccountPassword />
      </div>
    </div>
  );
}
