import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AUTONOMY_ORDER, AutonomyMode } from '@oremedia/contracts/tenancy';
import { TaskKind } from '@oremedia/contracts/skills';
import { Button, Field, Input, Skeleton, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { denialOf, toUiError } from '../../lib/errors';
import { intentContext, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { EffectiveLimits } from './effective-limits';
import { SchemaFields, briefFromValues, type BriefValues, type ObjectSchema } from './schema-fields';
import { useAgentPrincipals, useEffectiveLimits, useTaskKinds } from './use-agent-runs';

export interface StartRunFormProps {
  brandId: string;
  brandName: string;
  hrefFor: (runId: string) => string;
  /** A task kind and brief values another screen prefilled (UX-09 "Plan with agent"); the person can still edit. */
  initial?: { taskKind: string; values: BriefValues };
}

/** Runs that start from their own command, never from this form (agents.runs.start refuses them). */
const COMMAND_ONLY: ReadonlySet<string> = new Set(['brand_onboarding']);

/**
 * Spec 12.5 through the skill, not the API (UX-08): the principal is picked from those granted this brand, the task
 * kind from those a published skill serves here, and the brief is the skill's input schema as fields. The mode
 * actually granted is min(requested, principal, tenant policy, entitlement); the server decides and the form only
 * requests, showing the principal's ceiling and, once a principal is chosen, the limits the server will hold the
 * run to (RA-07: autonomy, budget, denied actions, blockers). One idempotency key per submission intent, renewed
 * after success.
 */
export function StartRunForm({ brandId, brandName, hrefFor, initial }: StartRunFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const intent = useIntentKey();
  const principals = useAgentPrincipals(brandId);
  const taskKinds = useTaskKinds(brandId);
  const [principalId, setPrincipalId] = useState('');
  const [taskKind, setTaskKind] = useState<string>(initial?.taskKind ?? 'copywriting');
  const [autonomy, setAutonomy] = useState<string>('create');
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
  const requested = AutonomyMode.safeParse(autonomy);
  const limits = useEffectiveLimits(
    brandId,
    principal?.id ?? null,
    taskKind,
    requested.success ? requested.data : 'create',
  );
  const kinds = taskKinds.data?.items ?? [];
  const kind = kinds.find((k) => k.taskKind === taskKind) ?? null;
  // The first resolved skill is the one a run would use first (spec 12.3 precedence); its schema shapes the form.
  const skill = kind?.skills[0] ?? null;
  const schema = (skill?.inputSchema ?? {}) as ObjectSchema;
  const ceiling = principal ? AUTONOMY_ORDER.indexOf(principal.maxAutonomy) : AUTONOMY_ORDER.length - 1;

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
      requestedAutonomy: AutonomyMode.parse(autonomy),
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
    <section aria-labelledby="start-run-title" id="start-run" className="flex flex-col gap-4">
      <h2 id="start-run-title" className="text-lg font-semibold">
        Start a run
      </h2>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field label="Brand" htmlFor="run-brand" hint="Runs belong to the brand in the address bar.">
          <Input id="run-brand" value={brandName} readOnly aria-readonly="true" />
        </Field>
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
                ? `Ceiling ${principal.maxAutonomy.replace(/_/g, ' ')}; acts on this brand with ${principal.actions.join(', ')}.`
                : 'The agent identity the run acts as; its grants and autonomy ceiling bound the run.'
            }
            error={fieldIssue('servicePrincipalId')}
          >
            <Select
              id="run-principal"
              value={principalId}
              onValueChange={(id) => {
                setPrincipalId(id);
                const p = principals.items.find((x) => x.id === id);
                if (
                  p &&
                  AUTONOMY_ORDER.indexOf(autonomy as (typeof AUTONOMY_ORDER)[number]) >
                    AUTONOMY_ORDER.indexOf(p.maxAutonomy)
                )
                  setAutonomy(p.maxAutonomy);
              }}
              placeholder="Choose a principal"
              options={principals.items.map((p) => ({
                value: p.id,
                label: `${p.name} · up to ${p.maxAutonomy.replace(/_/g, ' ')}`,
              }))}
            />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Task kind"
            htmlFor="run-task"
            error={fieldIssue('taskKind')}
            hint={
              taskKinds.isPending
                ? 'Loading the skills published for this brand…'
                : skill
                  ? `${skill.title} v${skill.versionNumber} (${skill.key}) serves it here.`
                  : 'No published skill serves this kind for the brand yet.'
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
                .map((k) => ({
                  value: k,
                  label: `${k.replace(/_/g, ' ')}${kinds.length && !kinds.find((x) => x.taskKind === k)?.skills.length ? ' · no skill' : ''}`,
                }))}
            />
          </Field>
          <Field
            label="Requested autonomy"
            htmlFor="run-autonomy"
            hint="Granted mode is the minimum of this, the principal's ceiling, tenant policy and plan."
          >
            <Select
              id="run-autonomy"
              value={autonomy}
              onValueChange={setAutonomy}
              options={AUTONOMY_ORDER.map((m, i) => ({
                value: m,
                label: `${m.replace(/_/g, ' ')}${i > ceiling ? ' · above the principal’s ceiling' : ''}`,
                disabled: i > ceiling,
              }))}
            />
          </Field>
        </div>
        <EffectiveLimits
          brandId={brandId}
          servicePrincipalId={principal?.id ?? null}
          taskKind={taskKind}
          requestedAutonomy={requested.success ? requested.data : 'create'}
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
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={start.isPending || Boolean(blocked)}
            disabledReason={blocked}
          >
            {start.isPending ? 'Starting…' : 'Start run'}
          </Button>
        </div>
      </form>
    </section>
  );
}
