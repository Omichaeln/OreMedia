import { useState } from 'react';
import { cn } from '@oremedia/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/dropdown-menu';
import { hasCredential, signOut } from '../../lib/session';
import { useTheme } from '../../lib/theme';
import { useSessionUser } from './use-session-user';

/** Membership roles as the interface names them. */
export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Company admin',
  brand_manager: 'Brand manager',
  publisher: 'Publisher',
  reviewer: 'Reviewer',
  analyst: 'Analyst',
  agency_operator: 'Agency operator',
};

export const roleLabel = (role: string | null): string | null =>
  role === null ? null : (ROLE_LABEL[role] ?? role.replace(/_/g, ' '));

export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

/**
 * The signed-in person in the navigation's foot: initials, name and role (D-03). The row opens the account menu:
 * the theme (a per-device convenience) and Sign out.
 */
export function AccountMenu({ role, compact = false }: { role: string | null; compact?: boolean }) {
  const signedIn = hasCredential();
  const user = useSessionUser(signedIn);
  const { theme, toggle } = useTheme();
  const [busy, setBusy] = useState(false);
  if (!signedIn) return null;
  const name = user.data?.name ?? '';
  const label = roleLabel(role);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account and session"
        className={cn(
          'flex items-center gap-2.5 rounded-md p-2 text-left hover:bg-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          compact && 'p-1',
        )}
      >
        <span
          aria-hidden="true"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-border text-xs font-medium text-foreground"
        >
          {initialsOf(name)}
        </span>
        {!compact && (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-medium text-foreground" title={user.data?.email}>
              <span className="sr-only">Signed in as </span>
              {name}
            </span>
            {label && <span className="truncate text-xs text-muted-foreground">{label}</span>}
          </span>
        )}
        {compact && <span className="sr-only">{name}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {user.data && (
          <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground" title={user.data.email}>
            {user.data.email}
          </p>
        )}
        <DropdownMenuItem onSelect={toggle} aria-pressed={theme === 'dark'}>
          {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => {
            setBusy(true);
            void signOut();
          }}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
