import { useBudgets } from '../settings/use-settings';

/** Whole dollars when the amount is whole ("$41 / $120"), cents otherwise; never raw micros (spec 6.1). */
const usd = (micros: number) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(micros / 1_000_000);

/** Owners and admins hold billing.manage; the read is not asked for anyone else (the server re-checks). */
const BUDGET_ROLES = new Set(['owner', 'admin']);

/**
 * The month's agent spend against its limit (agents.budgets.read, UX-16): a figure and a bar in the navigation's
 * foot, for the people who may read it. Nothing shows while the read is pending or refused, so the bar never
 * suggests a position it does not have.
 */
export function AgentSpend({ brandId, role }: { brandId: string; role: string | null }) {
  const allowed = role !== null && BUDGET_ROLES.has(role);
  const budgets = useBudgets(brandId, allowed);
  if (!allowed || !budgets.data) return null;
  const { committedMicros, limitMicros, periodKey } = budgets.data.month;
  const share = limitMicros > 0 ? Math.min(1, committedMicros / limitMicros) : 0;
  const month = new Date(`${periodKey.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    timeZone: 'UTC',
  });
  return (
    <div className="flex flex-col gap-1.5 px-2" data-testid="agent-spend">
      <span className="flex justify-between text-xs text-muted-foreground">
        <span>Agent spend · {month}</span>
        <span className="tabular-nums">
          {usd(committedMicros)} / {usd(limitMicros)}
          <span className="sr-only"> this month</span>
        </span>
      </span>
      <span
        role="meter"
        aria-label="Agent spend this month"
        aria-valuemin={0}
        aria-valuemax={limitMicros}
        aria-valuenow={Math.min(committedMicros, limitMicros)}
        className="block h-[3px] overflow-hidden rounded-sm bg-border"
      >
        <span className="om-grow block h-full bg-primary" style={{ width: `${share * 100}%` }} />
      </span>
    </div>
  );
}
