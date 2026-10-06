import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Skeleton, StatusBanner, cn } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import { useBudgets, type BudgetsDto } from './use-settings';

/** USD micros as money, to the cent (the ledger is in micros; a person reads dollars). */
export const usd = (micros: number): string =>
  (micros / 1_000_000).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const KIND_TEXT: Record<string, string> = {
  model_tokens: 'Model tokens',
  tool_call: 'Tool calls',
  image_generation: 'Image generation',
  render_minutes: 'Render minutes',
  storage_bytes: 'Storage',
  video_generation: 'Video generation',
  audio_generation: 'Audio generation',
};

/** A spend row as the interface draws it: what it is, a thin bar, the figure; the bar turns as the limit nears. */
function Meter({ label, used, limit, hint }: { label: string; used: number; limit: number; hint: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-border py-3.5 sm:grid-cols-[minmax(0,1fr)_200px_110px]">
      <div className="min-w-0">
        <p className="text-base">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <p className="text-right text-xs tabular-nums sm:order-2">
        {usd(used)} of {usd(limit)} <span className="text-muted-foreground">({pct}%)</span>
      </p>
      <div
        className="col-span-full h-1 overflow-hidden rounded-sm bg-border sm:order-1 sm:col-span-1"
        aria-hidden
      >
        <div
          className={cn(
            'om-grow h-full',
            pct >= 90 ? 'bg-status-critical-dot' : pct >= 70 ? 'bg-status-warning-dot' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function LimitForm({
  brandId,
  period,
  current,
}: {
  brandId: string;
  period: 'day' | 'month';
  current: number;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [dollars, setDollars] = useState((current / 1_000_000).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const set = useMutation(
    trpc.agents.budgets.setLimit.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.agents.budgets.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(dollars);
    if (!Number.isFinite(n) || n < 0) {
      setError('Enter an amount in USD.');
      return;
    }
    setError(null);
    set.mutate({ brandId, period, limitMicros: Math.round(n * 1_000_000) });
  };
  const ui = set.isError ? toUiError(set.error) : null;
  const id = `budget-limit-${period}`;
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" noValidate>
      <Field
        label={period === 'day' ? 'Brand limit per day (USD)' : 'Company limit per month (USD)'}
        htmlFor={id}
        error={error ?? undefined}
        className="w-56"
      >
        <Input
          id={id}
          type="number"
          min={0}
          step="0.01"
          value={dollars}
          onChange={(e) => setDollars(e.target.value)}
        />
      </Field>
      <Button type="submit" size="sm" disabled={set.isPending}>
        {set.isPending ? 'Saving…' : 'Set limit'}
      </Button>
      {ui && (
        <StatusBanner
          tone="critical"
          title={ui.kind === 'forbidden' ? 'Permission denied' : 'The limit was not set'}
          description={`${ui.message}${ui.kind === 'forbidden' ? ' Setting limits needs billing.manage.' : ''}`}
        />
      )}
    </form>
  );
}

function Ledger({ data }: { data: BudgetsDto }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="mb-1 text-xs font-semibold">This month by kind</h3>
        {data.ledger.length === 0 ? (
          <p className="text-xs text-muted-foreground">No charges recorded this month.</p>
        ) : (
          <table className="w-full text-xs" data-testid="budget-ledger">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 font-medium">Kind</th>
                <th className="py-1 font-medium">Quantity</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.ledger.map((row) => (
                <tr key={`${row.kind}:${row.unit}`} className="border-t border-border">
                  <td className="py-1">{KIND_TEXT[row.kind] ?? row.kind}</td>
                  <td className="py-1 tabular-nums">
                    {row.quantity.toLocaleString()} {row.unit} · {row.entries} entr
                    {row.entries === 1 ? 'y' : 'ies'}
                  </td>
                  <td className="py-1 text-right tabular-nums">{usd(row.costMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-xs font-semibold">Recent reservations</h3>
        {data.reservations.length === 0 ? (
          <p className="text-xs text-muted-foreground">No run has reserved spend this month.</p>
        ) : (
          <ul
            className="flex flex-col gap-1 text-xs"
            aria-label="Reservations"
            data-testid="budget-reservations"
          >
            {data.reservations.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  <code>{r.runId}</code> · {r.state}
                </span>
                <span className="tabular-nums">
                  {usd(r.consumedMicros)} used of {usd(r.reservedMicros)} reserved
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * UX-16, spec 12.6: what reserveSpend reasons with, read: the company's month (the stored limit against the plan's
 * entitlement, the effective minimum, committed and remaining) and this brand's day, the ledger by kind and the
 * recent reservations; owners and admins set the two limits. Numbers are micros on the wire, dollars here.
 */
export function BudgetsSettings({ enabled }: { enabled: boolean }) {
  const { brandId } = useBrandContext();
  const budgets = useBudgets(brandId, enabled);
  return (
    <Section id="budgets-heading" title="Budgets" testId="budgets">
      <p className="text-xs text-muted-foreground">
        Every run reserves an estimate against the company's month and the brand's day before it starts (spec
        12.6); a run that would exceed either is refused. The month limit in force is the lower of the stored
        limit and the plan's entitlement.
      </p>
      {budgets.isPending && <Skeleton label="Loading budgets" lines={3} />}
      {budgets.isError && (
        <RequestError
          error={budgets.error}
          onRetry={() => void budgets.refetch()}
          title={toUiError(budgets.error).kind === 'forbidden' ? 'Permission denied' : undefined}
        />
      )}
      {budgets.data && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col">
            <Meter
              label={`Company · all brands · ${budgets.data.month.periodKey}`}
              used={budgets.data.month.committedMicros}
              limit={budgets.data.month.limitMicros}
              hint={`Entitlement ${usd(budgets.data.month.entitlementMicros)}${budgets.data.month.storedLimitMicros !== null ? `, stored limit ${usd(budgets.data.month.storedLimitMicros)}` : ', no stored limit'}; ${usd(budgets.data.month.remainingMicros)} remains.`}
            />
            <Meter
              label={`Agent spend · this brand · ${budgets.data.day.dayKey}`}
              used={budgets.data.day.committedMicros}
              limit={budgets.data.day.limitMicros}
              hint={`${budgets.data.day.storedLimitMicros === null ? 'Default limit' : 'Stored limit'}; ${usd(budgets.data.day.remainingMicros)} remains today.`}
            />
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <LimitForm
              brandId={brandId}
              period="month"
              current={budgets.data.month.storedLimitMicros ?? budgets.data.month.entitlementMicros}
            />
            <LimitForm brandId={brandId} period="day" current={budgets.data.day.limitMicros} />
          </div>
          <Ledger data={budgets.data} />
        </div>
      )}
    </Section>
  );
}
