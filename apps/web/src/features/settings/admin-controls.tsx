import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ModelRoutingPolicy, ModelVendor } from '@oremedia/contracts/agents';
import { defaultPolicyDocument, type PolicyDocumentV1 } from '@oremedia/contracts/brand';
import { Badge, Button, EmptyState, Field, Skeleton, StatusBanner, Textarea } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import { useKillSwitch, useReleasePolicy, useRoutingPolicy, type KillSwitchScope } from './use-settings';

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
const listOrNone = (xs: readonly string[]) => (xs.length ? xs.join(', ') : 'None');

/** The release policy rows, as the prototype lists them: what each setting does, then its value. */
function policyRows(p: PolicyDocumentV1): Array<[label: string, hint: string, value: string]> {
  return [
    [
      'Review required for',
      'Content classes that always need a person’s review before release.',
      listOrNone(p.reviewThresholds.requireReviewForContentClasses),
    ],
    [
      'Brand review blocks on',
      'The finding severity that stops a release.',
      p.reviewThresholds.blockOnBrandReviewSeverity === 'blocking'
        ? 'Blocking findings'
        : 'Warnings and above',
    ],
    ['Distinct approver', 'The author may not approve their own work.', yesNo(p.requireDistinctApprover)],
    [
      'Hold on revoked facts',
      'Scheduled posts citing a revoked fact are held rather than flagged.',
      yesNo(p.holdOnDependencyRevocation),
    ],
    ['MFA to approve', 'Approvers must have multi-factor authentication.', yesNo(p.mfaRequired)],
    ['Restricted topics', 'Topics that need review wherever they appear.', listOrNone(p.restrictedTopics)],
    ['Prohibited terms', 'Terms the release policy refuses outright.', listOrNone(p.prohibitedTerms)],
  ];
}

/** Spec 8.1: the release policy in force. Every brand member can read it; a new version is activated by an admin. */
export function ReleasePolicy() {
  const { brandId } = useBrandContext();
  const policy = useReleasePolicy(brandId);
  const ui = policy.isError ? toUiError(policy.error) : null;
  const doc = policy.data?.document ?? (ui?.kind === 'not_found' ? defaultPolicyDocument() : null);
  return (
    <Section id="release-policy-heading" title="Release policy" testId="release-policy">
      {doc && (
        <p className="text-xs text-muted-foreground">
          {policy.data
            ? `Policy version ${policy.data.number}. The release policy re-checks every limit at dispatch.`
            : 'No policy version is activated for this brand, so the defaults below are in force.'}
        </p>
      )}
      {policy.isPending && <Skeleton label="Loading the release policy" lines={3} />}
      {ui && ui.kind !== 'not_found' && (
        <RequestError error={policy.error} onRetry={() => void policy.refetch()} />
      )}
      {doc && (
        <dl className="flex flex-col divide-y divide-border text-sm">
          {policyRows(doc).map(([label, hint, value]) => (
            <div key={label} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 py-3">
              <dt className="min-w-0">
                <span className="font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </dt>
              <dd className="text-right">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

const SWITCHES: Array<{ scope: KillSwitchScope; label: string; effect: string }> = [
  {
    scope: 'release_dispatch',
    label: 'Mandate publishing',
    effect:
      'Posts released under a mandate (without a per-post approval) are held with the kill switch as the reason. Posts a person approved still publish.',
  },
  {
    scope: 'agent_starts',
    label: 'Agent starts',
    effect: 'No new agent run starts. Runs already started carry on.',
  },
];

function KillSwitchRow({
  scope,
  label,
  effect,
  brandId,
  brandName,
}: {
  scope: KillSwitchScope;
  label: string;
  effect: string;
  brandId: string | undefined;
  brandName: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const state = useKillSwitch(scope, brandId, true);
  // The server reports a brand as engaged when the company-wide switch is; that one is released on its own row.
  const company = useKillSwitch(scope, undefined, brandId !== undefined);
  const byCompany = brandId !== undefined && company.data?.engaged === true;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const engaged = state.data?.engaged ?? false;
  const target = brandId ? brandName : 'every brand of this company';
  const set = useMutation(
    trpc.operations.killSwitch.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        setReason('');
        void queryClient.invalidateQueries(trpc.operations.killSwitch.pathFilter());
      },
    }),
  );
  const ui = set.isError ? toUiError(set.error) : null;
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`kill-${scope}-${brandId ? 'brand' : 'company'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {label} · {brandId ? 'this brand' : 'whole company'}
          </p>
          <p className="text-xs text-muted-foreground">{effect}</p>
        </div>
        <div className="flex items-center gap-2">
          {state.isPending && <Skeleton label={`Loading ${label}`} />}
          {state.data && (
            <Badge tone={engaged ? 'critical' : 'good'}>
              {byCompany ? 'Engaged company-wide' : engaged ? 'Engaged' : 'Running'}
            </Badge>
          )}
          {state.data && byCompany && (
            <Button
              size="sm"
              variant="secondary"
              disabledReason="Release the whole-company switch below first"
            >
              Release
            </Button>
          )}
          {state.data && !byCompany && (
            <Dialog open={open} onOpenChange={setOpen}>
              <Button size="sm" variant={engaged ? 'secondary' : 'danger'} onClick={() => setOpen(true)}>
                {engaged ? 'Release' : 'Engage'}
              </Button>
              <DialogContent
                role="alertdialog"
                title={`${engaged ? 'Release' : 'Engage'} the ${label.toLowerCase()} kill switch for ${target}?`}
                description={
                  engaged
                    ? `${label} resumes for ${target}.`
                    : `${effect} It applies to ${target} until someone releases it. The change is audited with your reason.`
                }
              >
                <Field label="Reason" htmlFor={`kill-reason-${scope}-${brandId ?? 'company'}`}>
                  <Textarea
                    id={`kill-reason-${scope}-${brandId ?? 'company'}`}
                    rows={2}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                <DialogActions>
                  <DialogClose asChild>
                    <Button variant="ghost">Cancel</Button>
                  </DialogClose>
                  <Button
                    variant={engaged ? 'primary' : 'danger'}
                    onClick={() =>
                      set.mutate({
                        scope,
                        brandId: brandId ?? null,
                        engaged: !engaged,
                        reason: reason.trim() || null,
                      })
                    }
                    disabled={set.isPending}
                    data-testid={`confirm-kill-${scope}`}
                  >
                    {set.isPending ? 'Saving…' : engaged ? 'Release' : 'Engage'}
                  </Button>
                </DialogActions>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>
      {state.isError && <RequestError error={state.error} onRetry={() => void state.refetch()} />}
      {ui && (
        <StatusBanner
          tone="critical"
          title={ui.kind === 'forbidden' ? 'Permission denied' : 'The kill switch did not change'}
          description={
            ui.kind === 'forbidden'
              ? `${ui.message} Changing a kill switch needs a company owner or admin, signed in as a person.`
              : ui.message
          }
        />
      )}
    </li>
  );
}

/** Runbook kill switches for this brand and the whole company. Admin-only; the server re-checks every change. */
export function KillSwitches() {
  const { brandId, brand } = useBrandContext();
  return (
    <Section id="kill-switches-heading" title="Kill switches" testId="kill-switches">
      <p className="text-xs text-muted-foreground">
        Hold mandate publishing or refuse new agent runs, for this brand or the whole company. Engaging never
        deletes or cancels anything, and the change is audited.
      </p>
      <ul className="flex flex-col divide-y divide-border">
        {SWITCHES.flatMap((s) => [
          <KillSwitchRow key={`${s.scope}:b`} {...s} brandId={brandId} brandName={brand.name} />,
          <KillSwitchRow key={`${s.scope}:c`} {...s} brandId={undefined} brandName={brand.name} />,
        ])}
      </ul>
    </Section>
  );
}

const RETENTION: Record<string, string> = { zero: 'Zero retention', standard_30d: 'Standard (30 days)' };
/** The vendors a company chooses between; `fake` (the test adapter) is kept if stored, never offered. */
const VENDORS: ReadonlyArray<[ModelVendor, string]> = [
  ['anthropic', 'Anthropic'],
  ['openrouter', 'OpenRouter'],
];
const vendorLabel = (v: string) => VENDORS.find(([k]) => k === v)?.[1] ?? v;

function Rows({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="flex flex-col divide-y divide-border text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-3">
          <dt className="font-medium">{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Spec 12.7: which model routes the company permits. Before every model call the platform checks the vendor and
 * the model against this policy (assertRoutingAllowed); the model itself is deployment configuration, shown as "In
 * use". Regions, retention, data classes and the default model are stored with the policy but not checked yet, so
 * they are shown apart and an edit keeps them as they are. Owners and admins edit; the server re-checks.
 */
export function ModelRouting() {
  const routing = useRoutingPolicy(true);
  const [editing, setEditing] = useState(false);
  const p = routing.data?.policy ?? null;
  const inUse = routing.data?.inUse ?? null;
  return (
    <Section id="routing-heading" title="Model routing" testId="model-routing">
      <p className="text-xs text-muted-foreground">
        Checked before every model call; a run whose model or vendor is not permitted stops.
      </p>
      {routing.isPending && <Skeleton label="Loading model routing" lines={3} />}
      {routing.isError && <RequestError error={routing.error} onRetry={() => void routing.refetch()} />}
      {inUse && (
        <p className="text-sm" data-testid="model-in-use">
          In use: <span className="font-medium">{inUse.model}</span> through {vendorLabel(inUse.provider)}
          <span className="text-muted-foreground"> · set by the deployment, not by this policy</span>
        </p>
      )}
      {routing.data && !p && !editing && (
        <EmptyState
          title="No routing policy stored"
          description="The platform default applies until an admin stores a routing policy for the company."
        />
      )}
      {p && !editing && (
        <>
          <Rows
            rows={[
              ['Permitted vendors', listOrNone(p.permittedVendors.map(vendorLabel))],
              ['Denied models', listOrNone(p.deniedModels)],
            ]}
          />
          <h3 className="mt-2 text-sm font-medium">Recorded, not enforced yet</h3>
          <p className="text-xs text-muted-foreground">
            Stored with the policy for the record; no model call is checked against these yet.
          </p>
          <Rows
            rows={[
              ['Default model', p.defaultModel],
              [
                'Regions',
                p.permittedRegions.length ? p.permittedRegions.join(', ') : 'Any region the vendor offers',
              ],
              ['Data retention at vendor', RETENTION[p.retention] ?? p.retention],
              ['Data classes sent', listOrNone(p.dataClasses.map((d) => d.replace(/_/g, ' ')))],
            ]}
          />
        </>
      )}
      {routing.data?.version !== null && routing.data?.version !== undefined && !editing && (
        <p className="text-xs text-muted-foreground">Stored version {routing.data.version}.</p>
      )}
      {routing.data && inUse && !editing && (
        <div>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {p ? 'Edit' : 'Store a policy'}
          </Button>
        </div>
      )}
      {routing.data && inUse && editing && (
        <RoutingForm
          base={
            p ?? {
              schemaVersion: 1,
              defaultModel: inUse.model,
              permittedVendors: VENDORS.some(([v]) => v === inUse.provider)
                ? [inUse.provider as ModelVendor]
                : ['anthropic'],
              permittedRegions: [],
              retention: 'standard_30d',
              dataClasses: ['brand_content'],
              deniedModels: [],
            }
          }
          version={routing.data.version}
          inUse={inUse}
          onDone={() => setEditing(false)}
        />
      )}
    </Section>
  );
}

function RoutingForm({
  base,
  version,
  inUse,
  onDone,
}: {
  base: ModelRoutingPolicy;
  version: number | null;
  inUse: { provider: string; model: string };
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [vendors, setVendors] = useState<ModelVendor[]>(base.permittedVendors.filter((v) => v !== 'fake'));
  const [denied, setDenied] = useState(base.deniedModels.join('\n'));
  const [confirming, setConfirming] = useState(false);
  const save = useMutation(
    trpc.agents.routingPolicy.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.agents.routingPolicy.pathFilter());
        onDone();
      },
    }),
  );
  const next: ModelRoutingPolicy = {
    ...base,
    permittedVendors: [...vendors, ...base.permittedVendors.filter((v) => v === 'fake')],
    deniedModels: [
      ...new Set(
        denied
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ],
  };
  const blocksVendor = !next.permittedVendors.some((v) => v === inUse.provider);
  const blocksModel = next.deniedModels.includes(inUse.model);
  const submit = () =>
    save.mutate({ policy: next, ...(version === null ? {} : { expectedVersion: version }) });
  const ui = save.isError ? toUiError(save.error) : null;
  const toggle = (v: ModelVendor) =>
    setVendors((xs) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]));

  return (
    <form
      className="flex flex-col gap-4 border-t border-border pt-4"
      data-testid="routing-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (blocksVendor || blocksModel) setConfirming(true);
        else submit();
      }}
      noValidate
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Permitted vendors</legend>
        {VENDORS.map(([v, label]) => (
          <label key={v} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={vendors.includes(v)} onChange={() => toggle(v)} />
            {label}
          </label>
        ))}
      </fieldset>
      <Field
        label="Denied models"
        htmlFor="routing-denied"
        hint="One model id per line, exactly as the vendor names it."
      >
        <Textarea id="routing-denied" rows={3} value={denied} onChange={(e) => setDenied(e.target.value)} />
      </Field>
      {(blocksVendor || blocksModel) && (
        <StatusBanner
          tone="warning"
          title="This policy stops every agent run for the company"
          description={`The model in use, ${inUse.model} through ${vendorLabel(inUse.provider)}, would not be permitted. To pause agents for a while, the agent-starts kill switch is the reversible way.`}
        />
      )}
      {ui && (
        <StatusBanner
          tone="critical"
          title={
            ui.kind === 'forbidden'
              ? 'Permission denied'
              : ui.kind === 'conflict'
                ? 'Someone else changed the policy'
                : 'The policy was not saved'
          }
          description={
            ui.kind === 'conflict'
              ? 'Cancel to see the current policy, then make the change again.'
              : ui.message
          }
        />
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={save.isPending}
          disabledReason={vendors.length === 0 ? 'Permit at least one vendor' : undefined}
        >
          {save.isPending ? 'Saving…' : 'Save policy'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          role="alertdialog"
          title="Stop every agent run?"
          description={`${inUse.model} through ${vendorLabel(inUse.provider)} would not be permitted, so no agent can run for this company until the policy changes again.`}
        >
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              data-testid="confirm-routing-block"
              disabled={save.isPending}
              onClick={() => {
                setConfirming(false);
                submit();
              }}
            >
              Save and stop agent runs
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </form>
  );
}
