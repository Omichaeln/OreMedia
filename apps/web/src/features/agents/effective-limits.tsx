import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { Badge, Skeleton, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { formatDuration, formatMicros, formatTokens } from './run-helpers';
import { useEffectiveLimits } from './use-agent-runs';

export interface EffectiveLimitsProps {
  brandId: string;
  servicePrincipalId: string | null;
  taskKind: string;
  requestedAutonomy: AutonomyMode;
}

const mode = (m: string) => m.replace(/_/g, ' ');

/**
 * RA-07: what the server will hold a run to, shown before it starts: the autonomy actually granted (and which
 * ceiling capped it), the budget that will be reserved, the brand's and company's remaining spend, the actions
 * the principal is not granted (so those tools are denied), and anything that would refuse the start right now.
 * The server decides at start; this only reads the same sources.
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
  return (
    <section
      aria-label="Effective limits"
      data-testid="effective-limits"
      data-can-start={l.canStart}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <h3 className="text-sm font-semibold">What this run is held to</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Autonomy</dt>
        <dd data-testid="effective-autonomy">
          <Badge glyph={false}>{mode(l.autonomy.effective)}</Badge>
          {capped ? (
            <span className="ml-2">
              Requested {mode(l.autonomy.requested)}; capped by {capped} at {mode(l.autonomy.effective)}.
            </span>
          ) : (
            <span className="ml-2">
              {l.principal.name}’s ceiling is {mode(l.principal.maxAutonomy)}.
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Budget reserved</dt>
        <dd data-testid="effective-budget">
          {l.budget ? (
            <>
              {formatMicros(l.reservedMicros)} · up to {l.budget.maxSteps} steps,{' '}
              {formatTokens(l.budget.maxTokens)} tokens, {formatDuration(l.budget.deadlineSeconds * 1000)}
            </>
          ) : (
            'Nothing can be reserved'
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
