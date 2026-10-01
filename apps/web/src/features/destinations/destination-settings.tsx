import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DESTINATION_KIND_CAPABILITIES,
  DestinationKind,
  SOURCE_USE_RETENTION_MAX_DAYS,
  type DestinationHealth,
  type DestinationStatus,
  type SourceUse,
} from '@oremedia/contracts/destinations';
import type { ErrorDetail } from '@oremedia/contracts/errors';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner, type Tone } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import {
  useDestinations,
  useSourceUsePolicies,
  type DestinationDto,
  type SourceUsePolicyDto,
} from './use-destinations';

const KINDS = DestinationKind.options;
const kindLabel = (kind: DestinationKind) => DESTINATION_KIND_CAPABILITIES[kind].label;
const kindOptions = KINDS.map((k) => ({ value: k, label: kindLabel(k) }));

/** The health a check last found, as the channel chips say a connection's state. */
const HEALTH_CHIP: Record<DestinationHealth, { tone: Tone; label: string }> = {
  unknown: { tone: 'neutral', label: 'Not checked' },
  healthy: { tone: 'good', label: 'Healthy' },
  degraded: { tone: 'warning', label: 'Degraded' },
  unreachable: { tone: 'critical', label: 'Unreachable' },
};
const STATUS_CHIP: Record<DestinationStatus, { tone: Tone; label: string }> = {
  active: { tone: 'good', label: 'Active' },
  disconnected: { tone: 'neutral', label: 'Disconnected' },
};
const USE_LABEL: Record<SourceUse, string> = { read: 'Read', retain: 'Retain', write: 'Write' };

/** Policy dates are days in UTC (the input sends midnight UTC), so the label reads them in UTC too. */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
/** A date input's value (`YYYY-MM-DD`) for an instant; the policy's due date is sent as midnight UTC of that day. */
const toDateInput = (iso: string) => iso.slice(0, 10);
const fromDateInput = (date: string) => `${date}T00:00:00.000Z`;
const defaultReviewDue = () => toDateInput(new Date(Date.now() + 90 * 86_400_000).toISOString());

function DisconnectButton({ destination }: { destination: DestinationDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [open, setOpen] = useState(false);
  const disconnect = useMutation(
    trpc.destinations.disconnect.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        void queryClient.invalidateQueries(trpc.destinations.pathFilter());
      },
    }),
  );
  const ui = disconnect.isError ? toUiError(disconnect.error) : null;
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
          Disconnect
        </Button>
        <DialogContent
          role="alertdialog"
          title={`Disconnect ${destination.displayName}?`}
          description="Nothing is read from or written to this destination afterwards. What was already stored follows the source-use policy; the destination can be registered again later."
        >
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Keep connected</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() =>
                disconnect.mutate({
                  brandId: destination.brandId,
                  destinationId: destination.id,
                  expectedVersion: destination.version,
                })
              }
              disabled={disconnect.isPending}
              data-testid="confirm-disconnect-destination"
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Disconnecting needs destination.manage for this brand.`}
          data-testid="disconnect-denied"
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={disconnect.error} title="The destination was not disconnected" />
      )}
    </>
  );
}

function DestinationRow({
  destination,
  canManageDestinations,
}: {
  destination: DestinationDto;
  canManageDestinations: boolean;
}) {
  const health = HEALTH_CHIP[destination.health];
  const status = STATUS_CHIP[destination.status];
  return (
    <li
      className="flex flex-col gap-2 py-3"
      data-testid={`destination-${destination.id}`}
      data-destination-health={destination.health}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{destination.displayName}</span>
        <code className="text-xs text-muted-foreground">{destination.externalId}</code>
        <Badge tone={health.tone}>{health.label}</Badge>
        {destination.status !== 'active' && <Badge tone={status.tone}>{status.label}</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">
        Owner <code>{destination.ownerUserId}</code> · capability v{destination.capabilityVersion}
        {destination.healthCheckedAt &&
          ` · checked ${new Date(destination.healthCheckedAt).toLocaleString()}`}
        {destination.grantedScopes.length > 0 && ` · scopes: ${destination.grantedScopes.join(', ')}`}
      </p>
      {canManageDestinations && destination.status === 'active' && (
        <div className="flex flex-wrap items-start gap-2">
          <DisconnectButton destination={destination} />
        </div>
      )}
    </li>
  );
}

/** Registers a remote identity for the brand (destination.connect); a credential is attached by a connect flow later. */
function RegisterDestination({ brandId }: { brandId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [kind, setKind] = useState<DestinationKind>('ga4_property');
  const [externalId, setExternalId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const register = useMutation(
    trpc.destinations.register.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setExternalId('');
        setDisplayName('');
        void queryClient.invalidateQueries(trpc.destinations.pathFilter());
      },
    }),
  );
  const ui = register.isError ? toUiError(register.error) : null;
  const otherBrand = ui?.details.some(
    (d) => d.path === 'externalId' && d.issue === 'remote_identity_registered_to_another_brand',
  );
  const ready = externalId.trim().length > 0 && displayName.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready)
      register.mutate({ brandId, kind, externalId: externalId.trim(), displayName: displayName.trim() });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate data-testid="register-destination">
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr_1fr]">
        <Field label="Kind" htmlFor="destination-kind">
          <Select
            id="destination-kind"
            value={kind}
            onValueChange={(v) => setKind(DestinationKind.parse(v))}
            options={kindOptions}
          />
        </Field>
        <Field
          label="External id"
          htmlFor="destination-external-id"
          hint="The property, site, location, CMS or webhook id as the provider names it."
        >
          <Input
            id="destination-external-id"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label="Display name" htmlFor="destination-display-name">
          <Input
            id="destination-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={200}
          />
        </Field>
      </div>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Registering needs destination.connect for this brand.`}
          data-testid="register-denied"
        />
      )}
      {ui && ui.kind === 'conflict' && (
        <StatusBanner
          tone="warning"
          title="Already registered"
          description="This brand holds this remote identity already; it is listed above."
          data-testid="destination-conflict"
        />
      )}
      {otherBrand && (
        <StatusBanner
          tone="warning"
          title="Registered to another brand"
          description="Another brand of this company holds this remote identity; a destination belongs to one brand."
          data-testid="destination-other-brand"
        />
      )}
      {ui && ui.kind !== 'forbidden' && ui.kind !== 'conflict' && !otherBrand && (
        <RequestError error={register.error} title="The destination was not registered" />
      )}
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!ready || register.isPending}
          disabledReason={ready ? undefined : 'Name the destination and its external id first'}
        >
          {register.isPending ? 'Registering…' : 'Register destination'}
        </Button>
      </div>
    </form>
  );
}

/** What a policy row edits; the row's own values until the person changes them. */
interface PolicyDraft {
  uses: SourceUse[];
  retentionDays: string;
  reviewDue: string;
}
const draftOf = (p: SourceUsePolicyDto): PolicyDraft => ({
  uses: p.allowedUses,
  retentionDays: p.retentionDays ? String(p.retentionDays) : '',
  reviewDue: toDateInput(p.reviewDueAt),
});

/** The allowed-use boxes a kind offers (D-17: a Business Profile location never offers retain or write). */
function UseBoxes({
  kind,
  idPrefix,
  draft,
  onChange,
  disabled,
}: {
  kind: DestinationKind;
  idPrefix: string;
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  disabled: boolean;
}) {
  const toggle = (use: SourceUse, on: boolean) =>
    onChange({
      ...draft,
      uses: on ? [...new Set([...draft.uses, use])] : draft.uses.filter((u) => u !== use),
      retentionDays: use === 'retain' && !on ? '' : draft.retentionDays,
    });
  return (
    <fieldset className="flex flex-wrap gap-3" disabled={disabled}>
      <legend className="sr-only">Allowed uses</legend>
      {DESTINATION_KIND_CAPABILITIES[kind].uses.map((use) => (
        <label key={use} className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            id={`${idPrefix}-${use}`}
            checked={draft.uses.includes(use)}
            onChange={(e) => toggle(use, e.target.checked)}
          />
          {USE_LABEL[use]}
        </label>
      ))}
    </fieldset>
  );
}

function PolicyFields({
  kind,
  idPrefix,
  draft,
  onChange,
  disabled,
  details,
}: {
  kind: DestinationKind;
  idPrefix: string;
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  disabled: boolean;
  details: ErrorDetail[];
}) {
  const issue = (path: string) => details.find((d) => d.path === path)?.issue;
  const retains = draft.uses.includes('retain');
  return (
    <div className="flex flex-wrap items-end gap-3">
      <UseBoxes kind={kind} idPrefix={idPrefix} draft={draft} onChange={onChange} disabled={disabled} />
      <Field
        label="Retention (days)"
        htmlFor={`${idPrefix}-retention`}
        error={issue('retentionDays') ? 'Needed when data is retained' : undefined}
        className="w-36"
      >
        <Input
          id={`${idPrefix}-retention`}
          type="number"
          min={1}
          max={SOURCE_USE_RETENTION_MAX_DAYS}
          value={draft.retentionDays}
          onChange={(e) => onChange({ ...draft, retentionDays: e.target.value })}
          disabled={disabled || !retains}
        />
      </Field>
      <Field
        label="Review due"
        htmlFor={`${idPrefix}-review-due`}
        error={issue('reviewDueAt') ? 'Must be ahead of today' : undefined}
        className="w-44"
      >
        <Input
          id={`${idPrefix}-review-due`}
          type="date"
          value={draft.reviewDue}
          onChange={(e) => onChange({ ...draft, reviewDue: e.target.value })}
          disabled={disabled}
        />
      </Field>
    </div>
  );
}

const toSetInput = (brandId: string, kind: DestinationKind, dataType: string, draft: PolicyDraft) => ({
  brandId,
  destinationKind: kind,
  dataType,
  allowedUses: draft.uses,
  retentionDays: draft.uses.includes('retain') && draft.retentionDays ? Number(draft.retentionDays) : null,
  reviewDueAt: fromDateInput(draft.reviewDue),
});

/** One (kind, data type) policy: its version and review, edited in place and saved as the next version. */
function PolicyRow({ policy, canManage }: { policy: SourceUsePolicyDto; canManage: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const current = draft ?? draftOf(policy);
  const set = useMutation(
    trpc.destinations.sourceUse.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setDraft(null);
        void queryClient.invalidateQueries(trpc.destinations.sourceUse.pathFilter());
      },
      // The policy moved on under this row: the list is refreshed so the next save names the current version.
      onError: (err) => {
        if (toUiError(err).kind === 'conflict')
          void queryClient.invalidateQueries(trpc.destinations.sourceUse.pathFilter());
      },
    }),
  );
  const ui = set.isError ? toUiError(set.error) : null;
  const idPrefix = `policy-${policy.id}`;
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`source-use-${policy.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p>
          <span className="font-medium">{kindLabel(policy.destinationKind)}</span>{' '}
          <code className="text-xs">{policy.dataType}</code>
        </p>
        <p className="text-xs text-muted-foreground" data-testid="policy-version">
          Version {policy.version} · reviewed {day(policy.reviewedAt)} · due {day(policy.reviewDueAt)}
          {new Date(policy.reviewDueAt).getTime() < Date.now() && (
            <>
              {' '}
              <Badge tone="warning">Review overdue</Badge>
            </>
          )}
        </p>
      </div>
      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            set.mutate({
              ...toSetInput(policy.brandId, policy.destinationKind, policy.dataType, current),
              expectedVersion: policy.version,
            });
          }}
        >
          <PolicyFields
            kind={policy.destinationKind}
            idPrefix={idPrefix}
            draft={current}
            onChange={setDraft}
            disabled={set.isPending}
            details={ui?.details ?? []}
          />
          <Button type="submit" size="sm" disabled={set.isPending || draft === null}>
            {set.isPending ? 'Saving…' : 'Save'}
          </Button>
        </form>
      ) : (
        <p className="text-sm">
          {policy.allowedUses.map((u) => USE_LABEL[u]).join(', ') || 'No use allowed'}
          {policy.retentionDays !== null && ` · kept ${policy.retentionDays} days`}
        </p>
      )}
      {ui && ui.kind === 'conflict' && (
        <StatusBanner
          tone="warning"
          title="The policy moved on"
          description="Someone saved another version of this policy; the list shows the current one."
        />
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Changing the policy needs source_use.manage for this brand.`}
          data-testid="source-use-denied"
        />
      )}
      {ui && ui.kind !== 'conflict' && ui.kind !== 'forbidden' && !ui.details.length && (
        <RequestError error={set.error} title="The policy was not saved" />
      )}
    </li>
  );
}

/** A new (kind, data type) policy, version 1. */
function AddPolicy({ brandId }: { brandId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [kind, setKind] = useState<DestinationKind>('ga4_property');
  const [dataType, setDataType] = useState('');
  const [draft, setDraft] = useState<PolicyDraft>({
    uses: [],
    retentionDays: '',
    reviewDue: defaultReviewDue(),
  });
  const set = useMutation(
    trpc.destinations.sourceUse.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setDataType('');
        setDraft({ uses: [], retentionDays: '', reviewDue: defaultReviewDue() });
        void queryClient.invalidateQueries(trpc.destinations.sourceUse.pathFilter());
      },
      // A row for this kind and data type exists already: the list is refreshed so it shows up to edit.
      onError: (err) => {
        if (toUiError(err).kind === 'conflict')
          void queryClient.invalidateQueries(trpc.destinations.sourceUse.pathFilter());
      },
    }),
  );
  const ui = set.isError ? toUiError(set.error) : null;
  const ready = dataType.trim().length > 0 && draft.uses.length > 0 && draft.reviewDue.length > 0;
  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-4"
      noValidate
      data-testid="source-use-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) set.mutate(toSetInput(brandId, kind, dataType.trim(), draft));
      }}
    >
      <p className="text-sm font-medium">Add a data type</p>
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
        <Field label="Destination kind" htmlFor="policy-new-kind">
          <Select
            id="policy-new-kind"
            value={kind}
            onValueChange={(v) => {
              const next = DestinationKind.parse(v);
              setKind(next);
              // Only the uses the new kind offers survive the change.
              setDraft((d) => ({
                ...d,
                uses: d.uses.filter((u) => DESTINATION_KIND_CAPABILITIES[next].uses.includes(u)),
              }));
            }}
            options={kindOptions}
          />
        </Field>
        <Field
          label="Data type"
          htmlFor="policy-new-data-type"
          hint="Namespaced by its source, for example ga4.reports or gbp.reviews."
          error={
            ui?.details.find((d) => d.path === 'dataType') ? 'Lower-case words joined by dots' : undefined
          }
        >
          <Input
            id="policy-new-data-type"
            value={dataType}
            onChange={(e) => setDataType(e.target.value)}
            maxLength={80}
          />
        </Field>
      </div>
      <PolicyFields
        kind={kind}
        idPrefix="policy-new"
        draft={draft}
        onChange={setDraft}
        disabled={set.isPending}
        details={ui?.details ?? []}
      />
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={ui.message}
          data-testid="source-use-denied"
        />
      )}
      {ui && ui.kind === 'conflict' && (
        <StatusBanner
          tone="warning"
          title="Already recorded"
          description="A policy for this kind and data type exists; edit it in its row."
        />
      )}
      {ui && ui.kind !== 'forbidden' && ui.kind !== 'conflict' && !ui.details.length && (
        <RequestError error={set.error} title="The policy was not saved" />
      )}
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!ready || set.isPending}
          disabledReason={ready ? undefined : 'Name the data type and tick at least one use'}
        >
          {set.isPending ? 'Saving…' : 'Save policy'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Settings → Destinations (R2-0): the brand's non-social destinations grouped by kind with their health and
 * owner, registration for those who hold destination.connect, and the source-use policy table (D-17) an admin
 * edits: one row per kind and data type, uses limited to what the kind offers, retention only when data is
 * retained, a review date, each save the next version.
 */
export function DestinationSettings({
  canManage,
  canConnectDestinations,
  canManageDestinations,
}: {
  /** source_use.manage: edits the policy table (owners and admins). */
  canManage: boolean;
  /** destination.connect: registers a destination. */
  canConnectDestinations: boolean;
  /** destination.manage: disconnects one. */
  canManageDestinations: boolean;
}) {
  const { brandId, brand } = useBrandContext();
  const destinations = useDestinations(brandId);
  const policies = useSourceUsePolicies(brandId);
  const listUi = destinations.isError ? toUiError(destinations.error) : null;
  const byKind = KINDS.map((kind) => ({
    kind,
    items: (destinations.data?.items ?? []).filter((d) => d.kind === kind),
  })).filter((g) => g.items.length > 0);
  return (
    <div className="flex flex-col gap-8">
      <Section id="destinations-heading" title="Destinations" testId="destinations">
        <p className="text-xs text-muted-foreground">
          Where {brand.name} reads performance from and publishes beyond social: analytics, search, its
          Business Profile, its website and announcement webhooks. Credentials are sealed server-side and
          never shown.
        </p>
        {destinations.isPending && <Skeleton label="Loading destinations" lines={3} />}
        {destinations.isError && (
          <RequestError
            error={destinations.error}
            onRetry={() => void destinations.refetch()}
            title={listUi?.kind === 'forbidden' ? 'Permission denied' : undefined}
          />
        )}
        {destinations.isSuccess && byKind.length === 0 && (
          <EmptyState title="No destinations" description="Register one below to read from or write to it." />
        )}
        {byKind.map((group) => (
          <div key={group.kind} className="flex flex-col gap-1" data-testid={`destinations-${group.kind}`}>
            <h3 className="text-sm font-semibold">{kindLabel(group.kind)}</h3>
            <ul className="divide-y divide-border" aria-label={kindLabel(group.kind)}>
              {group.items.map((d) => (
                <DestinationRow key={d.id} destination={d} canManageDestinations={canManageDestinations} />
              ))}
            </ul>
          </div>
        ))}
        {canConnectDestinations && <RegisterDestination brandId={brandId} />}
      </Section>
      <Section id="source-use-heading" title="Source-use policy" testId="source-use">
        <p className="text-xs text-muted-foreground">
          What the product may do with each source&apos;s data: read it through a restricted view, keep a copy
          for a bounded time, or write back. A use without a current policy, or past its review date, is
          refused.
          {!canManage && ' Only an owner or admin changes it.'}
        </p>
        {policies.isPending && <Skeleton label="Loading the source-use policy" lines={3} />}
        {policies.isError && <RequestError error={policies.error} onRetry={() => void policies.refetch()} />}
        {policies.isSuccess && policies.data.items.length === 0 && (
          <EmptyState
            title="No policy recorded"
            description="Nothing is read or retained until a policy says so."
          />
        )}
        {policies.isSuccess && policies.data.items.length > 0 && (
          <ul className="divide-y divide-border" aria-label="Source-use policies">
            {policies.data.items.map((p) => (
              <PolicyRow key={p.id} policy={p} canManage={canManage} />
            ))}
          </ul>
        )}
        {canManage && <AddPolicy brandId={brandId} />}
      </Section>
    </div>
  );
}
