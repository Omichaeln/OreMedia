import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AUTONOMY_ORDER, type AutonomyMode } from '@oremedia/contracts/tenancy';
import { TaskKind } from '@oremedia/contracts/skills';
import { Button, Field, Skeleton, StatusBanner, cn } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { denialOf, toUiError } from '../../lib/errors';
import { intentContext, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { EffectiveLimits } from './effective-limits';
import { humanise } from './run-helpers';
import { SchemaFields, briefFromValues, type BriefValues, type ObjectSchema } from './schema-fields';
import { useAgentPrincipals, useEffectiveLimits, useTaskKinds } from './use-agent-runs';

export interface StartRunFormProps {
  brandId: string;
  brandName: string;
  hrefFor: (runId: string) => string;
  /** A task kind and brief values another screen prefilled (UX-09 "Plan with agent"); the person can still edit. */
  initial?: { taskKind: string; values: BriefValues };
  /** Closes the form without starting anything (the agents screen's "Cancel"); a side sheet closes itself. */
  onCancel?: () => void;
}

/** Runs that start from their own command, never from this form (agents.runs.start refuses them). */
const COMMAND_ONLY: ReadonlySet<string> = new Set(['brand_onboarding']);

/** The interface's mode labels and what each mode may do (spec 12.5); the server grants the minimum that applies. */
const MODE_LABEL: Record<AutonomyMode, string> = {
  assist: 'Assist',
  create: 'Create',
  prepare_release: 'Prepare release',
  managed_autopublish: 'Autopublish',
};
const MODE_NOTE: Record<AutonomyMode, string> = {
  assist: 'Research, suggest and critique. Changes nothing.',
  create: 'Drafts, revisions and renders within budget. Never publishes.',
  prepare_release:
    'Channel variants, proposed slots and review requests. Publishing still needs an approval.',
  managed_autopublish:
    'Publishes within an active mandate and entitlement; the server grants it only when both hold.',
};

/**
 * Spec 12.5 through the skill, not the API (UX-08): the principal is picked from those granted this brand, the
 * skill from those published for the brand's task kinds, and the brief is the skill's input schema as fields. The
 * mode actually granted is min(requested, principal, tenant policy, entitlement); the server decides and the form
 * only requests, showing the principal's ceiling and, once a principal is chosen, the limits the server will hold
 * the run to (RA-07: autonomy, budget, denied actions, blockers). One idempotency key per submission intent,
 * renewed after success. Laid out as the interface's "Start a run" form.
 */
export function StartRunForm({ brandId, brandName, hrefFor, initial, onCancel }: StartRunFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const intent = useIntentKey();
  const principals = useAgentPrincipals(brandId);
  const taskKinds = useTaskKinds(brandId);
  const [principalId, setPrincipalId] = useState('');
  const [taskKind, setTaskKind] = useState<string>(initial?.taskKind ?? 'copywriting');
  const [autonomy, setAutonomy] = useState<AutonomyMode>('create');
  const [values, setValues] = useState<BriefValues>(initial?.values ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const start = useMutation(
    trpc.agents.runs.start.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: (res) => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.agents.runs.pathFilter());
        navigate(hrefFor(res.runId));
      },
    }),
  );
  const principal = principals.items.find((p) => p.id === principalId) ?? null;
  const limits = useEffectiveLimits(brandId, principal?.id ?? null, taskKind, autonomy);
  const kinds = taskKinds.data?.items ?? [];
  const kind = kinds.find((k) => k.taskKind === taskKind) ?? null;
  // The first resolved skill is the one a run would use first (spec 12.3 precedence); its schema shapes the form.
  const skill = kind?.skills[0] ?? null;
  const schema = (skill?.inputSchema ?? {}) as ObjectSchema;
  const ceiling = principal ? AUTONOMY_ORDER.indexOf(principal.maxAutonomy) : AUTONOMY_ORDER.length - 1;
  const skillOf = (k: string) => kinds.find((x) => x.taskKind === k)?.skills[0] ?? null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!principal) return;
    const built = briefFromValues(schema, values);
    setErrors(built.errors);
    if (Object.keys(built.errors).length > 0) return;
    start.mutate({
      brandId,
      servicePrincipalId: principal.id,
      taskKind: TaskKind.parse(taskKind),
      requestedAutonomy: autonomy,
      brief: built.brief,
    });
  };
  const ui = start.isError ? toUiError(start.error) : null;
  const fieldIssue = (path: string) => ui?.details.find((d) => d.path === path)?.issue;
  const denial = ui ? denialOf(ui) : null;
  const blocked = !principal
    ? 'Choose a service principal'
    : !skill
      ? 'No published skill serves this task kind for the brand'
      : limits.data && !limits.data.canStart
        ? limits.data.blockers[0]?.message
        : undefined;
  return (
    <section aria-labelledby="start-run-title" id="start-run" className="flex flex-col gap-3.5">
      <h2 id="start-run-title" className="text-lg font-bold">
        Start a run
      </h2>
      <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
        {principals.isPending && <Skeleton label="Loading service principals" lines={1} />}
        {principals.isError && toUiError(principals.error).kind === 'forbidden' && (
          <StatusBanner
            tone="critical"
            title="Permission denied"
            description={`${toUiError(principals.error).message} Starting a run needs the agent.start_run permission for this brand.`}
            data-testid="start-denied"
          />
        )}
        {principals.isError && toUiError(principals.error).kind !== 'forbidden' && (
          <RequestError error={principals.error} onRetry={() => void principals.refetch()} />
        )}
        {principals.isSuccess && principals.items.length === 0 && (
          <StatusBanner
            tone="warning"
            title="No agent principal is granted this brand"
            description="An owner or admin creates one under Settings → Members and mandates with grants for this brand; runs start under a principal's grants and autonomy ceiling."
            data-testid="no-principals"
          />
        )}
        {principals.isSuccess && principals.items.length > 0 && (
          <Field
            label="Service principal"
            htmlFor="run-principal"
            hint={
              principal
                ? `Ceiling ${humanise(principal.maxAutonomy)}; acts on ${brandName} with ${principal.actions.join(', ')}.`
                : `The agent identity the run acts as on ${brandName}; its grants and autonomy ceiling bound the run.`
            }
            error={fieldIssue('servicePrincipalId')}
          >
            <Select
              id="run-principal"
              value={principalId}
              onValueChange={(id) => {
                setPrincipalId(id);
                const p = principals.items.find((x) => x.id === id);
                if (p && AUTONOMY_ORDER.indexOf(autonomy) > AUTONOMY_ORDER.indexOf(p.maxAutonomy))
                  setAutonomy(p.maxAutonomy);
              }}
              placeholder="Choose a principal"
              options={principals.items.map((p) => ({
                value: p.id,
                label: `${p.name} · up to ${humanise(p.maxAutonomy)}`,
              }))}
            />
          </Field>
        )}
        <Field
          label="Skill"
          htmlFor="run-task"
          error={fieldIssue('taskKind')}
          hint={
            taskKinds.isPending
              ? 'Loading the skills published for this brand…'
              : skill
                ? `${skill.title} v${skill.versionNumber} (${skill.key}) serves ${humanise(taskKind)} here.`
                : `No published skill serves ${humanise(taskKind)} for the brand yet.`
          }
        >
          <Select
            id="run-task"
            value={taskKind}
            onValueChange={(k) => {
              setTaskKind(k);
              setValues({});
              setErrors({});
            }}
            options={TaskKind.options
              .filter((k) => !COMMAND_ONLY.has(k))
              .map((k) => {
                const s = skillOf(k);
                return {
                  value: k,
                  label: s
                    ? `${s.title} v${s.versionNumber} · ${humanise(k)}`
                    : `${humanise(k)}${kinds.length ? ' · no published skill' : ''}`,
                };
              })}
          />
        </Field>
        <div role="group" aria-labelledby="run-autonomy-label" className="flex flex-col gap-1.5">
          <span id="run-autonomy-label" className="text-xs font-medium text-muted-foreground">
            Mode
          </span>
          <div
            id="run-autonomy"
            className="flex w-fit max-w-full overflow-hidden rounded-lg border border-border bg-card"
          >
            {AUTONOMY_ORDER.map((m, i) => {
              const above = i > ceiling;
              const selected = autonomy === m;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={selected}
                  aria-disabled={above || undefined}
                  title={above ? 'Above the principal’s ceiling' : undefined}
                  onClick={() => {
                    if (!above) setAutonomy(m);
                  }}
                  className={cn(
                    'h-8 border-r border-border px-3 text-xs transition-colors last:border-r-0',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    selected
                      ? 'bg-primary text-primary-foreground'
                      : above
                        ? 'cursor-not-allowed text-muted-foreground'
                        : 'text-foreground hover:bg-muted',
                  )}
                >
                  {MODE_LABEL[m]}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-muted-foreground">
            {MODE_NOTE[autonomy]} Granted mode is the minimum of this, the principal’s ceiling, company policy
            and plan.
          </span>
        </div>
        <EffectiveLimits
          brandId={brandId}
          servicePrincipalId={principal?.id ?? null}
          taskKind={taskKind}
          requestedAutonomy={autonomy}
        />
        <fieldset className="flex flex-col gap-3" data-testid="run-brief">
          <legend className="text-xs font-medium text-muted-foreground">
            Brief{skill ? ` for ${skill.title}` : ''}
          </legend>
          {skill?.description && <p className="text-xs text-muted-foreground">{skill.description}</p>}
          {taskKinds.isPending && <Skeleton label="Loading the brief fields" lines={2} />}
          {skill && (
            <SchemaFields
              schema={schema}
              values={values}
              errors={errors}
              onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
              idPrefix="run-brief"
            />
          )}
          {fieldIssue('brief') && (
            <p className="text-xs text-status-critical" role="alert">
              {fieldIssue('brief')}
            </p>
          )}
        </fieldset>
        {denial && (
          <StatusBanner
            tone="critical"
            title={denial.title}
            description={
              ui?.code === 'FORBIDDEN'
                ? `${denial.description} Starting a run needs the agent.start_run permission for this brand.`
                : denial.description
            }
            data-testid="start-denied"
          />
        )}
        {ui && !denial && ui.kind !== 'validation' && (
          <RequestError error={start.error} title="The run did not start" />
        )}
        {ui && ui.kind === 'validation' && !ui.details.length && (
          <RequestError error={start.error} title="The run did not start" />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={start.isPending || Boolean(blocked)}
            disabledReason={blocked}
          >
            {start.isPending ? 'Starting…' : 'Start run'}
          </Button>
          {onCancel && (
            <Button type="button" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
