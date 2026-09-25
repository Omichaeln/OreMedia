import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

/** Spec 12.7: where agent inference may run. Read here; changed through agents.routingPolicy.set by an admin. */
export function ModelRouting() {
  const routing = useRoutingPolicy(true);
  const p = routing.data?.policy ?? null;
  return (
    <Section id="routing-heading" title="Model routing" testId="model-routing">
      <p className="text-xs text-muted-foreground">
        Checked before every model call; a run whose model or vendor is not permitted stops.
      </p>
      {routing.isPending && <Skeleton label="Loading model routing" lines={3} />}
      {routing.isError && <RequestError error={routing.error} onRetry={() => void routing.refetch()} />}
      {routing.data && !p && (
        <EmptyState
          title="No routing policy stored"
          description="The platform default applies until an admin stores a routing policy for the company."
        />
      )}
      {p && (
        <dl className="flex flex-col divide-y divide-border text-sm">
          {(
            [
              ['Default model', p.defaultModel],
              ['Permitted vendors', listOrNone(p.permittedVendors)],
              [
                'Regions',
                p.permittedRegions.length ? p.permittedRegions.join(', ') : 'Any region the vendor offers',
              ],
              ['Data retention at vendor', RETENTION[p.retention] ?? p.retention],
              ['Data classes sent', listOrNone(p.dataClasses.map((d) => d.replace(/_/g, ' ')))],
              ['Denied models', listOrNone(p.deniedModels)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-3">
              <dt className="font-medium">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {routing.data?.version !== null && routing.data?.version !== undefined && (
        <p className="text-xs text-muted-foreground">Stored version {routing.data.version}.</p>
      )}
    </Section>
  );
}
