import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RecommendationAction } from '@oremedia/contracts/intelligence';
import { Button, Field, Input, Skeleton, StatusBanner, Textarea, cn } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { denialOf, toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { EffectiveLimits } from '../agents/effective-limits';
import { useAgentPrincipals } from '../agents/use-agent-runs';
import { brandPath } from '../brand/brand-context';
import { DesignFields } from '../experiments/design-fields';
import { EMPTY_DESIGN, parseDesign, type DesignForm } from '../experiments/experiment-helpers';
import { localInputToIso, isoToLocalInput } from '../publishing/publication-state';
import {
  ACTION_LABEL,
  benefitText,
  confidenceText,
  defaultReviewAfter,
  DISMISS_REASONS,
  effortText,
  rankText,
} from './intelligence-helpers';
import type { AcceptResultDto, RecommendationDto } from './use-intelligence';

export interface RecommendationCardProps {
  companyId: string;
  brandId: string;
  recommendation: RecommendationDto;
  /** Rank position in the list (1-based) when the list is ranked; null when unranked. */
  position: number | null;
  /** The statements of the insights the recommendation cites, where the workspace has them. */
  evidence?: string[];
  /** Called once the person decided (accepted or dismissed), so the list can keep the card and its outcome. */
  onDecided?: (recommendation: RecommendationDto) => void;
  /**
   * `card` (the intelligence workspace) or `row` (Performance's next content cycle, the interface's ruled row with
   * Keep and Drop). Both decide through the same accept and dismiss: Keep is the proposed action, Drop is dismiss.
   */
  layout?: 'card' | 'row';
}

/** Spec 16.4: the downstream object gets a back-reference; the screen links to where it lives. */
export function downstreamHref(companyId: string, brandId: string, res: AcceptResultDto): string | null {
  const id = res.downstreamId;
  switch (res.downstreamType) {
    case 'brief':
      return id ? brandPath(companyId, brandId, `campaigns?brief=${encodeURIComponent(id)}`) : null;
    case 'experiment':
      return id ? brandPath(companyId, brandId, `experiments?experiment=${encodeURIComponent(id)}`) : null;
    case 'agent_run':
      return id ? brandPath(companyId, brandId, `agents?run=${encodeURIComponent(id)}`) : null;
    case 'playbook_entry':
      return brandPath(companyId, brandId, 'intelligence?view=playbook');
    case 'canvas':
      // Nothing is created server-side for open_canvas: the studio opens from the brand home.
      return brandPath(companyId, brandId, 'home');
    default:
      return null;
  }
}

/**
 * One recommendation with exactly the actions the server offers (spec 16.4): its proposed action and dismiss
 * (reason required). Accepting creates the downstream object and the card links to it.
 */
export function RecommendationCard({
  companyId,
  brandId,
  recommendation: r,
  position,
  evidence = [],
  onDecided,
  layout = 'card',
}: RecommendationCardProps) {
  const row = layout === 'row';
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const acceptIntent = useIntentKey();
  const dismissIntent = useIntentKey();
  const [open, setOpen] = useState<RecommendationAction | 'dismiss' | null>(null);
  const [audience, setAudience] = useState('');
  const [message, setMessage] = useState('');
  const principals = useAgentPrincipals(brandId);
  const [principalId, setPrincipalId] = useState('');
  // The recommendation's own title is the hypothesis a test starts from; the person edits it like every field.
  const [design, setDesign] = useState<DesignForm>({
    ...EMPTY_DESIGN,
    hypothesis: r.learning?.hypothesis ?? r.title,
  });
  const [designIssues, setDesignIssues] = useState<Array<{ path: string; issue: string }>>([]);
  const [practice, setPractice] = useState(r.title);
  const [reviewAfter, setReviewAfter] = useState(() => isoToLocalInput(defaultReviewAfter()));
  const [reason, setReason] = useState('');
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
  };
  const accept = useMutation(
    trpc.intelligence.recommendations.accept.mutationOptions({
      ...mutationIntent(acceptIntent.key),
      onSuccess: () => {
        acceptIntent.renew();
        setOpen(null);
        onDecided?.(r);
        invalidate();
      },
    }),
  );
  const dismiss = useMutation(
    trpc.intelligence.recommendations.dismiss.mutationOptions({
      ...mutationIntent(dismissIntent.key),
      onSuccess: () => {
        dismissIntent.renew();
        setOpen(null);
        onDecided?.(r);
        invalidate();
      },
    }),
  );
  const submitAccept = (e: FormEvent) => {
    e.preventDefault();
    if (open === null || open === 'dismiss') return;
    const base = { recommendationId: r.id, expectedVersion: r.version, action: open };
    switch (open) {
      case 'create_brief':
        accept.mutate({ ...base, brief: { audience: audience.trim(), message: message.trim() } });
        return;
      case 'generate_variants':
        if (!principal) return;
        accept.mutate({ ...base, servicePrincipalId: principal.id });
        return;
      case 'prepare_test': {
        const parsed = parseDesign(design);
        if (!parsed.ok) {
          setDesignIssues(parsed.issues);
          return;
        }
        setDesignIssues([]);
        accept.mutate({ ...base, experimentDesign: parsed.design });
        return;
      }
      case 'propose_playbook_update': {
        const iso = localInputToIso(reviewAfter);
        if (!iso) return;
        accept.mutate({ ...base, playbook: { practice: practice.trim(), reviewAfter: iso } });
        return;
      }
      default:
        accept.mutate(base);
    }
  };
  const dismissWith = (text: string) => {
    if (text.trim())
      dismiss.mutate({ recommendationId: r.id, expectedVersion: r.version, reason: text.trim() });
  };
  const submitDismiss = (e: FormEvent) => {
    e.preventDefault();
    dismissWith(reason);
  };
  const acceptUi = accept.isError ? toUiError(accept.error) : null;
  const acceptDenial = acceptUi ? denialOf(acceptUi) : null;
  const fieldIssue = (path: string) => acceptUi?.details.find((d) => d.path === path)?.issue;
  const designIssue = (path: string) =>
    designIssues.find((i) => i.path === path)?.issue ?? fieldIssue(`experimentDesign.${path}`);
  const principal = principals.items.find((p) => p.id === principalId) ?? null;
  const principalsForbidden = principals.isError && toUiError(principals.error).kind === 'forbidden';
  const formId = `rec-${r.id}`;
  const href = accept.data ? downstreamHref(companyId, brandId, accept.data) : null;

  return (
    <li
      id={formId}
      className={cn(
        'target:ring-2 target:ring-ring',
        row
          ? 'grid grid-cols-[72px_minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-t border-border py-3'
          : 'flex flex-col gap-2.5 rounded-xl border border-border bg-card px-5 py-[18px]',
      )}
      data-testid="recommendation"
      data-recommendation-state={accept.data?.state ?? dismiss.data?.state ?? r.state}
    >
      {row ? (
        <>
          <span className="flex flex-col gap-0.5 text-xs">
            <span>{ACTION_LABEL[r.proposedAction]}</span>
            <span className="text-muted-foreground">{effortText(r.effort)} effort</span>
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-pretty text-sm font-medium">
              {position !== null && <span className="tabular-nums">#{position} </span>}
              {r.title}
            </span>
            <span className="text-pretty text-xs text-muted-foreground">{r.rationale}</span>
            <span className="text-2xs text-muted-foreground">
              expected {benefitText(r.expectedBenefit)} · {confidenceText(r.uncertainty)} confidence ·{' '}
              {r.insightIds.length} {r.insightIds.length === 1 ? 'piece of evidence' : 'pieces of evidence'}
              {r.learning && ` · hypothesis: ${r.learning.hypothesis}`}
            </span>
          </span>
          <span className="flex flex-col items-end gap-1">
            {accept.data && (
              <span className="text-xs text-status-good" data-testid="recommendation-accepted">
                Kept
                {href && (
                  <>
                    {' · '}
                    <Link to={href} className="underline underline-offset-2">
                      Open {accept.data.downstreamType.replace(/_/g, ' ')}
                    </Link>
                  </>
                )}
              </span>
            )}
            {dismiss.data && <span className="text-xs text-muted-foreground">Dropped</span>}
            {!accept.data && !dismiss.data && r.actions.length > 0 && (
              <span
                className="flex flex-col items-end gap-1"
                role="group"
                aria-label={`Actions for ${r.title}`}
              >
                {r.actions.includes(r.proposedAction) && (
                  <Button
                    size="sm"
                    aria-expanded={open === r.proposedAction}
                    aria-controls={`${formId}-form`}
                    onClick={() => setOpen(open === r.proposedAction ? null : r.proposedAction)}
                  >
                    Keep
                  </Button>
                )}
                {r.actions.includes('dismiss') && (
                  <button
                    type="button"
                    aria-expanded={open === 'dismiss'}
                    aria-controls={`${formId}-form`}
                    onClick={() => setOpen(open === 'dismiss' ? null : 'dismiss')}
                    className="min-h-6 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Drop
                  </button>
                )}
              </span>
            )}
          </span>
        </>
      ) : (
        <>
          <h3 className="text-pretty text-md font-bold">
            {position !== null && (
              <>
                <span
                  aria-hidden="true"
                  className="mr-2 text-xs font-normal tabular-nums text-muted-foreground"
                >
                  {rankText(position)}
                </span>
                <span className="sr-only">Rank {position}: </span>
              </>
            )}
            {r.title}
          </h3>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Benefit <span className="text-foreground">{benefitText(r.expectedBenefit)}</span>
            </span>
            <span>
              Effort <span className="text-foreground">{effortText(r.effort)}</span>
            </span>
            <span>
              Confidence <span className="text-foreground">{confidenceText(r.uncertainty)}</span>
            </span>
          </p>
          <p className="text-pretty text-sm leading-normal text-muted-foreground">{r.rationale}</p>
          {(evidence.length > 0 || r.learning) && (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              {evidence.length > 0 && <p>Evidence: {evidence.join(' · ')}</p>}
              {r.learning && <p>Hypothesis: {r.learning.hypothesis}</p>}
            </div>
          )}
          {accept.data && (
            <p role="status" className="text-xs text-muted-foreground" data-testid="recommendation-accepted">
              <span className="text-foreground">Accepted: {ACTION_LABEL[accept.data.action]}.</span>{' '}
              {accept.data.downstreamId ? (
                <>
                  Created {accept.data.downstreamType.replace(/_/g, ' ')} {accept.data.downstreamId} with a
                  back-reference to this recommendation.
                </>
              ) : (
                <>
                  Your decision is recorded; open the {accept.data.downstreamType.replace(/_/g, ' ')} to act
                  on it.
                </>
              )}
              {href && (
                <>
                  {' '}
                  <Link
                    to={href}
                    className="inline-flex min-h-6 items-center font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Open <span aria-hidden="true">&nbsp;→</span>
                  </Link>
                </>
              )}
            </p>
          )}
          {dismiss.data && (
            <p role="status" className="text-xs text-muted-foreground">
              Dismissed — {dismiss.variables?.reason}. The reason is stored with the learning record.
            </p>
          )}
          {!accept.data && !dismiss.data && r.actions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5" role="group" aria-label={`Actions for ${r.title}`}>
              {r.actions.map((a) => (
                <Button
                  key={a}
                  size="sm"
                  variant={a === 'dismiss' ? 'secondary' : 'primary'}
                  aria-expanded={open === a}
                  aria-controls={`${formId}-form`}
                  onClick={() => setOpen(open === a ? null : a)}
                >
                  {a === 'dismiss' ? 'Dismiss' : ACTION_LABEL[a]}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      {open !== null && open !== 'dismiss' && (
        <form
          id={`${formId}-form`}
          onSubmit={submitAccept}
          className={cn('flex flex-col gap-2 border-t border-border pt-2', row && 'col-span-full')}
          noValidate
        >
          {open === 'create_brief' && (
            <>
              <Field label="Audience" htmlFor={`${formId}-audience`} error={fieldIssue('brief.audience')}>
                <Input
                  id={`${formId}-audience`}
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  required
                />
              </Field>
              <Field label="Message" htmlFor={`${formId}-message`} error={fieldIssue('brief.message')}>
                <Textarea
                  id={`${formId}-message`}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  required
                />
              </Field>
            </>
          )}
          {open === 'generate_variants' && (
            <>
              {principals.isPending && <Skeleton label="Loading agent principals" lines={1} />}
              {principalsForbidden && (
                <StatusBanner
                  tone="critical"
                  title="Permission denied"
                  description={`${toUiError(principals.error).message} Generating variants starts an agent run, which needs the agent.start_run permission for this brand.`}
                  data-testid="recommendation-denied"
                />
              )}
              {principals.isError && !principalsForbidden && (
                <RequestError error={principals.error} onRetry={() => void principals.refetch()} />
              )}
              {principals.isSuccess && principals.items.length === 0 && (
                <StatusBanner
                  tone="warning"
                  title="No agent principal is granted this brand"
                  description="An owner or admin creates one under Settings → Members and mandates with grants for this brand; the copywriting run starts under a principal's grants and autonomy ceiling."
                />
              )}
              {principals.isSuccess && principals.items.length > 0 && (
                <Field
                  label="Service principal"
                  htmlFor={`${formId}-principal`}
                  hint={
                    principal
                      ? `Ceiling ${principal.maxAutonomy.replace(/_/g, ' ')}; acts on this brand with ${principal.actions.join(', ')}.`
                      : 'The agent identity the copywriting run acts as; its grants and autonomy ceiling bound the run.'
                  }
                  error={fieldIssue('servicePrincipalId')}
                >
                  <Select
                    id={`${formId}-principal`}
                    value={principalId}
                    onValueChange={setPrincipalId}
                    placeholder="Choose a principal"
                    options={principals.items.map((p) => ({
                      value: p.id,
                      label: `${p.name} · up to ${p.maxAutonomy.replace(/_/g, ' ')}`,
                    }))}
                  />
                </Field>
              )}
              <EffectiveLimits
                brandId={brandId}
                servicePrincipalId={principal?.id ?? null}
                taskKind="copywriting"
                requestedAutonomy="create"
              />
            </>
          )}
          {open === 'prepare_test' && (
            <>
              <p className="text-xs text-muted-foreground">
                The pre-registration draft; validated by the experiments module and frozen only when you
                pre-register it from the experiment.
              </p>
              <DesignFields
                brandId={brandId}
                form={design}
                onChange={setDesign}
                issue={designIssue}
                idPrefix={`${formId}-design`}
              />
              {designIssues.length > 0 && (
                <StatusBanner
                  tone="critical"
                  title="The design is incomplete"
                  description={designIssues.map((i) => `${i.path || 'design'}: ${i.issue}`).join('; ')}
                  data-testid="design-issues"
                />
              )}
            </>
          )}
          {open === 'propose_playbook_update' && (
            <>
              <Field label="Practice" htmlFor={`${formId}-practice`} error={fieldIssue('playbook.practice')}>
                <Textarea
                  id={`${formId}-practice`}
                  value={practice}
                  onChange={(e) => setPractice(e.target.value)}
                  rows={3}
                  required
                />
              </Field>
              <Field
                label="Reconsider by"
                htmlFor={`${formId}-review`}
                hint="Approval is a separate step for a person with playbook.approve."
              >
                <Input
                  id={`${formId}-review`}
                  type="datetime-local"
                  value={reviewAfter}
                  onChange={(e) => setReviewAfter(e.target.value)}
                  required
                />
              </Field>
            </>
          )}
          {(open === 'open_canvas' || open === 'assign_response') && (
            <p className="text-sm text-muted-foreground">
              Accepting records your decision and creates the downstream object with a back-reference.
            </p>
          )}
          {acceptDenial && (
            <StatusBanner
              tone="critical"
              title={acceptDenial.title}
              description={
                acceptUi?.code === 'FORBIDDEN'
                  ? `${acceptDenial.description} Deciding on a recommendation needs insight.manage for this brand.`
                  : acceptDenial.description
              }
              data-testid="recommendation-denied"
            />
          )}
          {acceptUi && !acceptDenial && (
            <RequestError error={accept.error} title="The recommendation was not accepted" />
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={accept.isPending || (open === 'generate_variants' && !principal)}
              disabledReason={
                open === 'generate_variants' && !principal ? 'Choose a service principal first' : undefined
              }
            >
              {accept.isPending
                ? 'Accepting…'
                : row
                  ? `Keep: ${ACTION_LABEL[open].toLowerCase()}`
                  : `Accept: ${ACTION_LABEL[open]}`}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {open === 'dismiss' && (
        <form
          id={`${formId}-form`}
          onSubmit={submitDismiss}
          className={cn('flex flex-col gap-2 border-t border-border pt-2', row && 'col-span-full')}
          noValidate
        >
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dismiss with a reason">
            {DISMISS_REASONS.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => dismissWith(label)}
                disabled={dismiss.isPending}
                className="inline-flex h-7 items-center whitespace-nowrap rounded-full border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {label}
              </button>
            ))}
          </div>
          <Field
            label="Reason for dismissing"
            htmlFor={`${formId}-reason`}
            hint="Pick a reason above or write your own. Stored with the learning record; it explains a preference, never how the creative would have performed."
          >
            <Textarea
              id={`${formId}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              required
            />
          </Field>
          {dismiss.isError && (
            <RequestError error={dismiss.error} title="The recommendation was not dismissed" />
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="danger"
              disabled={dismiss.isPending || !reason.trim()}
              disabledReason={reason.trim() ? undefined : 'Give a reason first'}
            >
              {dismiss.isPending ? 'Dismissing…' : row ? 'Drop' : 'Dismiss'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
