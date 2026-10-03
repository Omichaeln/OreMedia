import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Skeleton, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { brandPath, useBrandContext } from './brand-context';
import type { BrandVersionSummary } from './use-brand';
import { useTRPC } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { denialOf, toUiError } from '../../lib/errors';
import { EffectiveLimits } from '../agents/effective-limits';
import { useAgentPrincipals } from '../agents/use-agent-runs';

/** The action the onboarding skill's brand.proposeVoice tool needs; a principal without it would be denied it. */
const NEEDED_ACTION = 'brand.edit_standards';

/**
 * Spec 8.2 onboarding, D-22: an agent reads the imported guidelines and suggests the brand's voice and vocabulary
 * (tone, audiences, preferred and avoided terms, prohibited phrases, examples) as a proposed update. It writes into
 * the pending proposal when there is one, otherwise into a new one copied from the brand system; the suggestion
 * replaces the proposal's voice only if nobody has changed it since the run started, and nothing applies until a
 * person reviews and saves it. The principal is picked from those granted the brand (UX-08, as the run form), never
 * typed as an id (RA-07).
 */
export function VoiceExtraction({ proposal }: { proposal: BrandVersionSummary | null }) {
  const { companyId, brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const draftIntent = useIntentKey();
  const principals = useAgentPrincipals(brandId);
  const [principalId, setPrincipalId] = useState('');
  const start = useMutation(
    trpc.brand.onboarding.start.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.agents.runs.pathFilter());
      },
    }),
  );
  // With no proposal waiting, the agent's suggestion needs one to land in: a copy of the brand system.
  const createProposal = useMutation(
    trpc.brand.versions.createDraft.mutationOptions({
      ...mutationIntent(draftIntent.key),
      onSuccess: () => {
        draftIntent.renew();
        void queryClient.invalidateQueries(trpc.brand.pathFilter());
      },
    }),
  );
  const principal = principals.items.find((p) => p.id === principalId) ?? null;
  // Onboarding writes into a draft; a proposal already submitted for review is applied or discarded first.
  const blocked = proposal !== null && proposal.state !== 'draft';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!principal || blocked) return;
    const servicePrincipalId = principal.id;
    if (proposal) start.mutate({ brandId, versionId: proposal.id, servicePrincipalId });
    else
      createProposal.mutate(
        { brandId },
        { onSuccess: (res) => start.mutate({ brandId, versionId: res.versionId, servicePrincipalId }) },
      );
  };
  const failed = start.error ?? createProposal.error;
  const ui = failed ? toUiError(failed) : null;
  const denial = ui ? denialOf(ui) : null;
  const fieldIssue = (path: string) => ui?.details.find((d) => d.path === path)?.issue;
  const forbidden = principals.isError && toUiError(principals.error).kind === 'forbidden';
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-border p-2" noValidate>
      <div>
        <h4 className="text-sm font-medium">Extract voice and vocabulary</h4>
        <p className="text-xs text-muted-foreground">
          An agent reads the imported guidelines and suggests the brand&apos;s voice: summary, tone,
          audiences, terms to use and avoid, banned phrases and examples. The suggestion appears as a proposed
          update to review; nothing changes until someone saves it.
        </p>
      </div>
      {principals.isPending && <Skeleton label="Loading agent principals" lines={1} />}
      {forbidden && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${toUiError(principals.error).message} Starting the extraction needs the agent.start_run permission for this brand.`}
          data-testid="voice-extraction-denied"
        />
      )}
      {principals.isError && !forbidden && (
        <RequestError error={principals.error} onRetry={() => void principals.refetch()} />
      )}
      {principals.isSuccess && principals.items.length === 0 && (
        <StatusBanner
          tone="warning"
          title="No agent principal is granted this brand"
          description="An owner or admin creates one under Settings → Members and mandates with grants for this brand, including brand.edit_standards so it may propose the voice."
          data-testid="voice-extraction-no-principals"
        />
      )}
      {principals.isSuccess && principals.items.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Agent principal"
            htmlFor="voice-extraction-principal"
            hint={
              principal
                ? `Ceiling ${principal.maxAutonomy.replace(/_/g, ' ')}; acts on this brand with ${principal.actions.join(', ')}.`
                : 'The agent identity the run acts as; it must be granted brand.edit_standards to propose the voice.'
            }
            error={fieldIssue('servicePrincipalId')}
            className="min-w-64 flex-1"
          >
            <Select
              id="voice-extraction-principal"
              value={principalId}
              onValueChange={setPrincipalId}
              placeholder="Choose a principal"
              options={principals.items.map((p) => ({
                value: p.id,
                label: `${p.name} · up to ${p.maxAutonomy.replace(/_/g, ' ')}${p.actions.includes(NEEDED_ACTION) ? '' : ' · cannot edit brand standards'}`,
                disabled: !p.actions.includes(NEEDED_ACTION),
              }))}
            />
          </Field>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={start.isPending || createProposal.isPending}
            disabledReason={
              blocked
                ? 'Apply or discard the proposed update first'
                : principal
                  ? undefined
                  : 'Choose an agent principal first'
            }
          >
            {start.isPending || createProposal.isPending ? 'Starting…' : 'Extract voice and vocabulary'}
          </Button>
        </div>
      )}
      <EffectiveLimits
        brandId={brandId}
        servicePrincipalId={principal?.id ?? null}
        taskKind="brand_onboarding"
        requestedAutonomy="create"
      />
      {ui && denial && (
        <StatusBanner
          tone="critical"
          title={`Not started: ${denial.title.toLowerCase()}`}
          description={denial.description}
        />
      )}
      {ui && !denial && (
        <StatusBanner
          tone="critical"
          title="Not started: check the request"
          description={[
            ui.message,
            ...ui.details.filter((d) => d.path !== 'servicePrincipalId').map((d) => d.issue),
          ].join(' · ')}
        />
      )}
      {start.isSuccess && (
        <StatusBanner
          tone="info"
          title="The agent is reading the guidelines"
          description={
            <>
              Its suggestion appears as a proposed update to review at the top of the brand system when the
              run finishes.{' '}
              <Link
                className="underline"
                to={`${brandPath(companyId, brandId, 'agents')}?run=${encodeURIComponent(start.data.runId)}`}
              >
                Follow the run
              </Link>
            </>
          }
        />
      )}
    </form>
  );
}
