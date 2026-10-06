import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { Badge, Skeleton, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { formatDuration, formatMicros, formatTokens, humanise } from './run-helpers';
import { useEffectiveLimits } from './use-agent-runs';

export interface EffectiveLimitsProps {
  brandId: string;
  servicePrincipalId: string | null;
  taskKind: string;
  requestedAutonomy: AutonomyMode;
}

/**
 * RA-07: what the server will hold a run to, shown before it starts: the budget as the interface's three figures
 * (max tool calls, max cost, max variants; set by the principal's budget, so read-only here), the autonomy actually
 * granted (and which ceiling capped it), the brand's and company's remaining spend, the actions the principal is
 * not granted (so those tools are denied), and anything that would refuse the start right now. The server decides
 * at start; this only reads the same sources.
 */
export function EffectiveLimits({
  brandId,
  servicePrincipalId,
  taskKind,
  requestedAutonomy,
}: EffectiveLimitsProps) {
  const limits = useEffectiveLimits(brandId, servicePrincipalId, taskKind, requestedAutonomy);
  if (!servicePrincipalId) return null;
  if (limits.isPending) return <Skeleton label="Loading the run limits" lines={2} />;
  if (limits.isError) {
    const ui = toUiError(limits.error);
    return ui.kind === 'validation' ? (
      <StatusBanner tone="warning" title="Limits not available" description={ui.message} />
    ) : (
      <RequestError error={limits.error} onRetry={() => void limits.refetch()} title="Limits not available" />
    );
  }
  const l = limits.data;
  const capped =
    l.autonomy.effective !== l.autonomy.requested
      ? l.autonomy.effective === l.autonomy.principalMax
        ? 'the principal’s ceiling'
        : l.autonomy.effective === l.autonomy.tenantPolicyMax
          ? 'company policy'
          : 'the plan'
      : null;
  const figures: Array<[string, string]> = [
    ['Max tool calls', l.budget ? String(l.budget.maxSteps) : '—'],
    ['Max cost', l.budget ? formatMicros(l.budget.maxCostMicros) : '—'],
    ['Max variants', l.budget ? String(l.budget.maxVariants) : '—'],
  ];
  return (
    <section
      aria-label="Effective limits"
      data-testid="effective-limits"
      data-can-start={l.canStart}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5" data-testid="effective-budget">
        <div className="grid grid-cols-3 gap-2.5">
          {figures.map(([label, value]) => (
            <div key={label} className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">{label}</span>
              <span className="flex h-[34px] items-center truncate rounded-lg border border-border bg-muted px-2.5 text-sm tabular-nums">
                {value}
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {l.budget
            ? `Set by ${l.principal.name}’s budget: ${formatMicros(l.reservedMicros)} reserved at start, up to ${l.budget.maxSteps} steps, ${formatTokens(l.budget.maxTokens)} tokens, ${formatDuration(l.budget.deadlineSeconds * 1000)}.`
            : 'Nothing can be reserved: no budget applies to this run.'}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Granted mode</dt>
        <dd data-testid="effective-autonomy">
          <Badge glyph={false}>{humanise(l.autonomy.effective)}</Badge>
          {capped ? (
            <span className="ml-2">
              Requested {humanise(l.autonomy.requested)}; capped by {capped} at{' '}
              {humanise(l.autonomy.effective)}.
            </span>
          ) : (
            <span className="ml-2">
              {l.principal.name}’s ceiling is {humanise(l.principal.maxAutonomy)}.
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Remaining</dt>
        <dd>
          {formatMicros(l.spend.day.remainingMicros)} of {formatMicros(l.spend.day.limitMicros)} today for the
          brand; {formatMicros(l.spend.month.remainingMicros)} of {formatMicros(l.spend.month.limitMicros)}{' '}
          this month for the company.
        </dd>
        <dt className="text-muted-foreground">Skill</dt>
        <dd>
          {l.skills.length
            ? l.skills.map((s) => `${s.title} v${s.versionNumber}`).join(', ')
            : 'No published skill serves this task kind here.'}
        </dd>
        <dt className="text-muted-foreground">Denied actions</dt>
        <dd data-testid="denied-actions">
          {l.deniedActions.length === 0 ? (
            'None: the principal is granted every action the skill’s tools need.'
          ) : (
            <span className="flex flex-wrap gap-1">
              {l.deniedActions.map((a) => (
                <Badge key={a} tone="critical">
                  {a}
                </Badge>
              ))}
              <span>
                : tools needing these are refused during the run (
                {l.tools
                  .filter((t) => !t.allowed && t.action !== null)
                  .map((t) => t.name)
                  .join(', ')}
                ).
              </span>
            </span>
          )}
        </dd>
      </dl>
      {l.tools.some((t) => t.action === null) && (
        <p className="text-xs text-muted-foreground">
          Not in the tool registry, so never called:{' '}
          {l.tools
            .filter((t) => t.action === null)
            .map((t) => t.name)
            .join(', ')}
          .
        </p>
      )}
      {l.blockers.map((b) => (
        <StatusBanner
          key={b.code}
          tone="critical"
          title="Cannot start right now"
          description={b.message}
          data-testid="start-blocker"
        />
      ))}
    </section>
  );
}
