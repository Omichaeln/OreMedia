import { useCallback, useEffect, useSyncExternalStore } from 'react';

/** The theme a surface renders in; `system` (Settings → Appearance "Match system") resolves to one of these. */
export type Theme = 'light' | 'dark';
export type ThemeChoice = Theme | 'system';
const KEY = 'oremedia.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const readChoice = (): ThemeChoice => {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // storage blocked: fall through to the system preference
  }
  return 'system';
};

const systemTheme = (): Theme =>
  typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
export const resolveTheme = (choice: ThemeChoice): Theme => (choice === 'system' ? systemTheme() : choice);

/*
 * One store for every `useTheme()` caller (the account menu, the studio bars, Settings → Appearance), so a choice
 * made on one surface shows on the others at once. The choice is a per-device convenience kept in localStorage; the
 * resolved theme is the `data-theme` attribute the token sets in packages/ui/tokens.css key on.
 */
let choice: ThemeChoice = readChoice();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const onSystemChange = () => {
  if (choice === 'system') emit();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1 && typeof matchMedia === 'function')
    matchMedia(DARK_QUERY).addEventListener('change', onSystemChange);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof matchMedia === 'function')
      matchMedia(DARK_QUERY).removeEventListener('change', onSystemChange);
  };
};
const getChoice = () => choice;
/** Resolved on every read so a system change (subscribed above) re-renders with the new value. */
const getResolved = () => resolveTheme(choice);

function setChoice(next: ThemeChoice) {
  choice = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // storage blocked: the attribute still applies for this page
  }
  emit();
}

/**
 * Light and dark sets both come from packages/ui/tokens.css; the choice is a per-device convenience. `theme` is the
 * one in force (light or dark), `choice` what the person picked (light, dark or system), `toggle` flips the one in
 * force, as the account menu and the studio bars do.
 */
export function useTheme(): {
  theme: Theme;
  choice: ThemeChoice;
  setTheme: (choice: ThemeChoice) => void;
  toggle: () => void;
} {
  const current = useSyncExternalStore(subscribe, getChoice, getChoice);
  const theme = useSyncExternalStore(subscribe, getResolved, getResolved);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  const toggle = useCallback(() => setChoice(resolveTheme(choice) === 'dark' ? 'light' : 'dark'), []);
  return { theme, choice: current, setTheme: setChoice, toggle };
}
