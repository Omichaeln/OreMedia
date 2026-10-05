import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  PublicationAuthority,
  type PublicationAuthority as PublicationAuthorityT,
} from '@oremedia/contracts/publishing';
import { Badge, Button, Field, Input, Skeleton, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { useToast } from '../../components/toast';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import { useTRPC } from '../../lib/trpc';
import { brandPath } from '../brand/brand-context';
import { destinationLabel, type DestinationDto } from '../destinations/use-destinations';
import { useApprovals, type ApprovalDto } from '../review/use-review';
import { useMandates } from '../settings/use-settings';
import { CHANNEL_CHIP, dayKey, isoToZonedInput, zonedInputToIso } from './publication-state';
import { useChannelVariant, type ChannelDto } from './use-publishing';

export interface ScheduleFormProps {
  companyId: string;
  brandId: string;
  timeZone: string;
  channels: ReadonlyMap<string, ChannelDto>;
  /** R2-3: the brand's websites, named when the variant targets one. */
  destinations: ReadonlyMap<string, DestinationDto>;
  /** The variant to schedule, chosen on its content package (the calendar's `schedule` search param). */
  variantId: string | null;
  /** Called with the scheduled instant's day key so the calendar shows it. */
  onScheduled: (publicationId: string, dayKey: string) => void;
}

/** Where an approval's frozen timing starts: the exact instant, or the first instant of the window. */
const timingStart = (timing: ApprovalDto['binding']['timing']): string =>
  timing.kind === 'exact' ? timing.at : timing.from;
const timingText = (timing: ApprovalDto['binding']['timing'], timeZone: string): string =>
  timing.kind === 'exact'
    ? `at ${new Date(timing.at).toLocaleString(undefined, { timeZone })}`
    : `${new Date(timing.from).toLocaleString(undefined, { timeZone })} – ${new Date(timing.to).toLocaleString(undefined, { timeZone })}`;

/**
 * Spec 14.1: schedule a channel variant with an authority. The variant comes from its content package (never a
 * typed id), the authority is picked from the revision's valid approvals or the brand's active mandates, and the
 * time is entered as the brand's wall clock (UX-06): the release policy holds a publication scheduled outside the
 * approval's frozen timing, so the form prefills that timing and reads the input in the same zone. The person sees
 * the channel's connection state and the variant's validation findings before anything is scheduled; the API
 * re-checks all of it (fail-fast pre-check).
 */
export function ScheduleForm({
  companyId,
  brandId,
  timeZone,
  channels,
  destinations,
  variantId,
  onScheduled,
}: ScheduleFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [at, setAt] = useState(() =>
    isoToZonedInput(new Date(Date.now() + 60 * 60_000).toISOString(), timeZone),
  );
  const [atTouched, setAtTouched] = useState(false);
  const [authority, setAuthority] = useState<PublicationAuthorityT>('approval');
  const [authorityId, setAuthorityId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const variant = useChannelVariant(variantId);
  const approvals = useApprovals(brandId, variant.data?.contentRevisionId ?? null);
  const mandates = useMandates(brandId);
  const channel = variant.data?.channelConnectionId
    ? channels.get(variant.data.channelConnectionId)
    : undefined;
  const website = variant.data?.destinationId
    ? destinationLabel(destinations.get(variant.data.destinationId), variant.data.destinationId)
    : null;
  const findings = variant.data?.validation as
    { ok: boolean; issues: Array<{ path?: string; issue: string }> } | undefined;
  const intent = useIntentKey();
  const schedule = useMutation(
    trpc.publishing.publications.schedule.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res, vars) => {
        intent.renew();
        setError(null);
        void queryClient.invalidateQueries(trpc.content.calendar.pathFilter());
        void queryClient.invalidateQueries(trpc.publishing.publications.pathFilter());
        toast({
          tone: 'good',
          title: 'Scheduled',
          description: `Publication ${res.id} for ${new Date(vars.scheduledFor).toLocaleString(undefined, { timeZone })} (${timeZone}).`,
        });
        onScheduled(res.id, dayKey(vars.scheduledFor, timeZone));
      },
      onError: (err) => setError(toUiError(err).message),
    }),
  );

  // Valid approvals first; a spent or invalidated one is offered with its state, because the release policy (not
  // this form) decides what it still releases, and a person may schedule knowingly under it.
  const approvalItems = [...(approvals.data?.items ?? [])].sort(
    (a, b) => Number(b.state === 'valid') - Number(a.state === 'valid'),
  );
  const approvalOptions = approvalItems.map((a) => ({
    value: a.id,
    label: `${a.id} · ${a.approverKind === 'external_reviewer' ? 'external reviewer' : 'team'} · ${timingText(a.binding.timing, timeZone)}${a.state === 'valid' ? '' : ` · ${a.state}${a.invalidatedReason ? ` (${a.invalidatedReason})` : ''}`}`,
  }));
  const noValidApproval = approvals.isSuccess && !approvalItems.some((a) => a.state === 'valid');
  const mandateOptions = (mandates.data?.items ?? [])
    .filter((m) => m.state === 'active')
    .map((m) => ({ value: m.id, label: `${m.id} · ${m.channelConnectionIds.length} channel(s)` }));
  const options = authority === 'approval' ? approvalOptions : mandateOptions;
  const chooseAuthority = (id: string) => {
    setAuthorityId(id);
    // The approval froze the timing the release policy will hold against; start from it unless a time was typed.
    const approval = approvals.data?.items.find((a) => a.id === id);
    if (approval && !atTouched) setAt(isoToZonedInput(timingStart(approval.binding.timing), timeZone));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!variantId) return;
    const iso = zonedInputToIso(at, timeZone);
    if (!iso) {
      setError('Enter a date and time.');
      return;
    }
    if (!authorityId) {
      setError(authority === 'approval' ? 'Choose an approval.' : 'Choose a mandate.');
      return;
    }
    setError(null);
    schedule.mutate({
      channelVariantId: variantId,
      scheduledFor: iso,
      authority,
      ...(authority === 'approval' ? { approvalId: authorityId } : { mandateId: authorityId }),
    });
  };

  const blocked = findings ? !findings.ok : false;
  const channelBlocked = channel ? !channel.usable : false;
  const noAuthority =
    options.length === 0 && (authority === 'approval' ? approvals.isSuccess : mandates.isSuccess);

  return (
    <section
      aria-labelledby="schedule-title"
      className="om-in flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <h2 id="schedule-title" className="text-base font-bold">
        Schedule a channel variant
      </h2>
      {variantId === null && (
        <p className="text-sm text-muted-foreground" data-testid="schedule-empty">
          Choose a channel variant on its content package (Campaigns → package → Schedule) to schedule it
          here.{' '}
          <Link to={brandPath(companyId, brandId, 'campaigns')} className="underline underline-offset-2">
            Open campaigns
          </Link>
        </p>
      )}
      {variantId !== null && variant.isPending && <Skeleton label="Loading variant" lines={2} />}
      {variantId !== null && variant.isError && (
        <RequestError error={variant.error} onRetry={() => void variant.refetch()} />
      )}
      {variant.isSuccess && (
        <div className="flex flex-col gap-3" data-testid="variant-preview">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{website ? 'Website:' : 'Channel:'}</span>
            {website ? (
              <Badge tone="info" glyph={false} data-testid="schedule-target-website">
                {website}
              </Badge>
            ) : channel ? (
              <Badge
                tone={CHANNEL_CHIP[channel.status].tone}
                glyph={CHANNEL_CHIP[channel.status].tone !== 'good'}
              >
                {channel.displayName} ({channel.providerKey}): {CHANNEL_CHIP[channel.status].label}
              </Badge>
            ) : (
              <code>{variant.data.channelConnectionId}</code>
            )}
            <Link
              to={brandPath(
                companyId,
                brandId,
                `campaigns?package=${encodeURIComponent(variant.data.contentPackageId)}`,
              )}
              className="text-xs underline underline-offset-2"
            >
              Open the package
            </Link>
          </div>
          <p className="line-clamp-3 rounded-md border border-border bg-muted p-2 text-sm">
            {variant.data.text}
          </p>
          {channel && channelBlocked && (
            <StatusBanner
              tone={CHANNEL_CHIP[channel.status].tone}
              title={`${channel.displayName}: ${CHANNEL_CHIP[channel.status].label}`}
              description={
                <>
                  {CHANNEL_CHIP[channel.status].detail}
                  {channel.tokenExpiresAt &&
                    ` Token expired ${new Date(channel.tokenExpiresAt).toLocaleString()}.`}{' '}
                  Scheduling would be held at dispatch with reason <code>channel_active</code>; reconnect the
                  channel under Settings first.
                </>
              }
            />
          )}
          {findings && !findings.ok && (
            <StatusBanner
              tone="critical"
              title="Invalid media: this variant does not pass the channel's capability check"
              description={
                <ul className="list-disc pl-5" data-testid="variant-findings">
                  {findings.issues.map((i, n) => (
                    <li key={n}>
                      {i.path && <code className="text-xs">{i.path}</code>} {i.issue}
                    </li>
                  ))}
                </ul>
              }
            />
          )}
          {findings?.ok && (
            <p className="text-xs text-muted-foreground">
              Capability check passed for capability version {String(variant.data.capabilityVersion)}.
            </p>
          )}
          <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
              <Field label="Authority" htmlFor="schedule-authority">
                <Select
                  id="schedule-authority"
                  value={authority}
                  onValueChange={(v) => {
                    setAuthority(PublicationAuthority.parse(v));
                    setAuthorityId('');
                  }}
                  options={[
                    { value: 'approval', label: 'Approval' },
                    { value: 'mandate', label: 'Mandate' },
                  ]}
                />
              </Field>
              <Field
                label={authority === 'approval' ? 'Approval' : 'Mandate'}
                htmlFor="schedule-authority-id"
                hint={
                  authority === 'approval'
                    ? 'Valid approvals of this revision (spec 13.2).'
                    : 'Active mandates of this brand (spec 13.4).'
                }
              >
                <Select
                  id="schedule-authority-id"
                  value={authorityId}
                  onValueChange={chooseAuthority}
                  options={options}
                  placeholder={authority === 'approval' ? 'Choose an approval' : 'Choose a mandate'}
                  disabled={options.length === 0}
                />
              </Field>
              <Field
                label={`Publish at (${timeZone})`}
                htmlFor="schedule-at"
                hint="Brand time. An approval's frozen timing is prefilled; publishing outside it is held."
              >
                <Input
                  id="schedule-at"
                  type="datetime-local"
                  value={at}
                  onChange={(e) => {
                    setAt(e.target.value);
                    setAtTouched(true);
                  }}
                  required
                />
              </Field>
            </div>
            {authority === 'approval' && noValidApproval && (
              <StatusBanner
                tone="warning"
                title="No valid approval for this revision"
                description={
                  noAuthority
                    ? 'Request a review on the package and schedule once it is approved, or switch the authority to a mandate.'
                    : 'Every approval of this revision is spent, expired or invalidated; a publication scheduled under one is held at dispatch until the package is approved again.'
                }
                data-testid="no-approval"
              />
            )}
            {noAuthority && authority === 'mandate' && (
              <StatusBanner
                tone="warning"
                title="No active mandate"
                description="Mandates are created under Settings → Members and mandates when the feature is enabled."
              />
            )}
            {error && <StatusBanner tone="critical" title="Not scheduled" description={error} />}
            <div>
              <Button
                type="submit"
                variant="primary"
                disabled={schedule.isPending}
                disabledReason={
                  blocked
                    ? 'Fix the validation findings first'
                    : channelBlocked
                      ? 'Reconnect the channel first'
                      : noAuthority
                        ? 'No authority to publish under'
                        : undefined
                }
              >
                {schedule.isPending ? 'Scheduling…' : 'Schedule'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
