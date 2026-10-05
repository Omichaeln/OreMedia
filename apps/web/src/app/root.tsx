import { Outlet, Link, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { TooltipProvider } from '../components/tooltip';
import { ToastProvider } from '../components/toast';
import { useTheme } from '../lib/theme';
import { TRPCProvider, keyPrefixFor, tenantFromPath, useTRPCClient } from '../lib/trpc';
import { AccountMenu } from '../features/session/account-menu';
import { ProductMark } from '../features/shell/brand-sidebar';

export interface RootContext {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

/**
 * Application chrome shared by every route: skip link, theme, providers. Routes render their own headers. The tRPC
 * proxy below keys every query by the company in the URL, so a company switch never shows the previous company's
 * cached rows (lib/trpc keyPrefixFor).
 */
export function RootLayout() {
  const { theme, toggle } = useTheme();
  const { pathname } = useLocation();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  return (
    <TRPCProvider
      trpcClient={trpcClient}
      queryClient={queryClient}
      keyPrefix={keyPrefixFor(tenantFromPath(pathname))}
    >
      <TooltipProvider>
        <ToastProvider>
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <div className="flex h-full min-h-0 flex-col">
            <Outlet context={{ theme, toggleTheme: toggle } satisfies RootContext} />
          </div>
        </ToastProvider>
      </TooltipProvider>
    </TRPCProvider>
  );
}

/** The 56 px top bar of the portfolio-level screens (brand screens render their own shell, spec 11.1). */
export function TopBar({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <Link to="/portfolio" className="rounded-md hover:opacity-60">
          <ProductMark />
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span className="truncate text-sm text-muted-foreground">{title}</span>
      </div>
      <div className="flex items-center gap-2">
        {children}
        <AccountMenu role={null} />
      </div>
    </header>
  );
}
