import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  Skeleton,
  StatusBanner,
  Textarea,
} from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { useToast } from '../../components/toast';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import { useTRPC } from '../../lib/trpc';
import {
  actionsFor,
  channelOutcomeSummary,
  holdReasonText,
  isoToZonedInput,
  zonedInputToIso,
  outcomeUnknownReasonText,
  plainLength,
  publicationChip,
  remoteChangeNoun,
  remoteChangeStatus,
  CHANNEL_CHIP,
} from './publication-state';
import {
  useChannelVariant,
  usePublication,
  usePublicationEvidence,
  useRevisionPublications,
  type CancelResultDto,
  type ChannelDto,
  type PublicationDto,
} from './use-publishing';

export interface PublicationDetailProps {
  brandId: string;
  publicationId: string | null;
  channels: ReadonlyMap<string, ChannelDto>;
  /** The brand's time zone: reschedule times are entered as the brand's wall clock (UX-06). */
  timeZone: string;
}

const when = (iso: string) => new Date(iso).toLocaleString();
const channelName = (channels: ReadonlyMap<string, ChannelDto>, id: string) => {
  const c = channels.get(id);
  return c ? `${c.displayName} (${c.providerKey})` : id;
};

/**
 * One publication: its state with the explanation, hold reasons verbatim, attempts, the per-channel outcomes of
 * its revision (spec 14.4) and the actions the state allows (spec 13.1, 13.5). Every action has a keyboard path
 * and every result is written out as text.
 */
export function PublicationDetail({ brandId, publicationId, channels, timeZone }: PublicationDetailProps) {
  const publication = usePublication(publicationId);
  return (
    <Panel title="Publication" data-testid="publication-detail">
      {publicationId === null && (
        <EmptyState
          title="Nothing selected"
          description="Pick a publication from the day list to see its outcome and actions."
        />
      )}
      {publicationId !== null && publication.isPending && <Skeleton label="Loading publication" />}
      {publicationId !== null && publication.isError && (
        <RequestError error={publication.error} onRetry={() => void publication.refetch()} />
      )}
      {publication.isSuccess && (
        <Loaded brandId={brandId} publication={publication.data} channels={channels} timeZone={timeZone} />
      )}
    </Panel>
  );
}

function Loaded({
  brandId,
  publication: p,
  channels,
  timeZone,
}: {
  brandId: string;
  publication: PublicationDto;
  channels: ReadonlyMap<string, ChannelDto>;
  timeZone: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const chip = publicationChip(p.state);
  const actions = actionsFor(p.state);
  const channel = channels.get(p.channelConnectionId);
  const [cancelResult, setCancelResult] = useState<CancelResultDto | null>(null);
  const [lastError, setLastError] = useState<unknown>(null);
  const siblings = useRevisionPublications(brandId, p.contentRevisionId);
  const remote = remoteChangeStatus(p.remote.changes);
  const deletedAt =
    p.remote.changes.find((c) => c.kind === 'delete' && c.state === 'succeeded')?.finishedAt ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries(trpc.publishing.publications.pathFilter());
    void queryClient.invalidateQueries(trpc.content.calendar.pathFilter());
  };
  const fail = (title: string) => (err: unknown) => {
    setLastError(err);
    toast({ tone: 'critical', title, description: toUiError(err).message });
  };

  const cancelIntent = useIntentKey();
  const cancel = useMutation(
    trpc.publishing.publications.cancel.mutationOptions({
      ...mutationIntent(cancelIntent.key),
      onSuccess: (res) => {
        cancelIntent.renew();
        setLastError(null);
        setCancelResult(res);
        refresh();
        toast(
          res.prevented
            ? { tone: 'good', title: 'Publication cancelled' }
            : { tone: 'warning', title: 'Dispatch already in progress; cancellation requested' },
        );
      },
      onError: fail('Cancel failed'),
    }),
  );

  const summary = siblings.data ? channelOutcomeSummary(siblings.data.items) : null;

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={chip.tone} data-testid="publication-state">
          {chip.label}
        </Badge>
        <span className="text-muted-foreground">{when(p.scheduledFor)}</span>
        {channel && (
          <Badge
            tone={CHANNEL_CHIP[channel.status].tone}
            glyph={CHANNEL_CHIP[channel.status].tone !== 'good'}
          >
            {channelName(channels, p.channelConnectionId)}: {CHANNEL_CHIP[channel.status].label}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground" data-testid="publication-state-detail">
        {chip.detail}
      </p>

      {p.state === 'held' && (
        <StatusBanner
          tone="warning"
          title="Held: a person needs to resolve it before it can publish"
          description={
            <>
              <p>Reasons, exactly as they were recorded:</p>
              <ul className="mt-1 list-disc pl-5" data-testid="hold-reasons">
                {p.holdReasons.map((r) => (
                  <li key={r}>
                    <code>{r}</code> — {holdReasonText(r)}
                  </li>
                ))}
                {p.holdReasons.length === 0 && p.stateReason && (
                  <li>
                    <code>{p.stateReason}</code>
                  </li>
                )}
              </ul>
              <p className="mt-1">Fix the cause, then release it again or cancel it.</p>
            </>
          }
        />
      )}
      {p.state === 'outcome_unknown' && (
        <StatusBanner
          tone="warning"
          title="Outcome unknown: reconcile before anything else happens"
          description={
            <>
              <p>
                The workflow could not tell whether the channel received the post. Automatic reconciliation
                looks for the remote post; if you can see it on the channel, confirm it here with its id, and
                if you are sure it is absent, confirm that so it becomes eligible for a retry. Nothing is
                re-sent until then.
              </p>
              {p.stateReason && (
                <p className="mt-1" data-testid="outcome-unknown-reason">
                  <code>{p.stateReason}</code>
                  {outcomeUnknownReasonText(p.stateReason) && (
                    <> — {outcomeUnknownReasonText(p.stateReason)}</>
                  )}
                </p>
              )}
            </>
          }
        />
      )}
      {p.state === 'retry_eligible' && (
        <StatusBanner
          tone="warning"
          title="Ready to retry"
          description="Reconciliation proved the post never appeared. Release it again to make a new attempt on the same occurrence."
        />
      )}
      {p.state === 'failed' && (
        <StatusBanner
          tone="critical"
          title="The channel rejected this publication"
          description={
            p.attempts.at(-1)?.errorDetail ??
            p.attempts.at(-1)?.errorCode ??
            'No error detail was recorded. Schedule a new publication after fixing the cause.'
          }
        />
      )}
      {channel && CHANNEL_CHIP[channel.status].needsAction && (
        <StatusBanner
          tone={CHANNEL_CHIP[channel.status].tone}
          title={`${channel.displayName}: ${CHANNEL_CHIP[channel.status].label}`}
          description={
            <>
              {CHANNEL_CHIP[channel.status].detail}
              {channel.tokenExpiresAt && ` Token expired ${when(channel.tokenExpiresAt)}.`} Reconnect it under
              Settings before this publication can dispatch.
            </>
          }
        />
      )}
      {cancelResult && !cancelResult.prevented && (
        <StatusBanner
          tone="warning"
          title="Dispatch already in progress; cancellation requested"
          data-testid="cancel-race"
          description={`The publication was already ${publicationChip(cancelResult.state).label.toLowerCase()} when the cancel arrived, so it could not be prevented here. ${cancelResult.message}. If the send had not started, the workflow honours the request; otherwise the outcome is reconciled and shown here.`}
        />
      )}
      {cancelResult?.prevented && (
        <StatusBanner
          tone="good"
          title="Cancelled before dispatch"
          description="No attempt was made on the channel."
        />
      )}
      {remote.open && (
        <StatusBanner
          tone="info"
          title={`${remote.open.kind === 'edit' ? 'Text edit' : 'Deletion'} requested: being carried out on the channel`}
          data-testid="remote-change-status"
          description={`Requested ${when(remote.open.requestedAt)}. This screen updates when the channel confirms it; nothing else can be changed on the live post meanwhile.`}
        />
      )}
      {remote.stale && (
        <StatusBanner
          tone="warning"
          title={`The ${remoteChangeNoun(remote.stale.kind)} has no confirmation from the channel`}
          data-testid="remote-change-status"
          description={`Requested ${when(remote.stale.requestedAt)}, and no outcome was recorded in time. Check the post on the channel; you can ask again, which closes this request.`}
        />
      )}
      {remote.failed && (
        <StatusBanner
          tone="critical"
          title={`The channel did not accept the ${remoteChangeNoun(remote.failed.kind)}`}
          data-testid="remote-change-status"
          description={
            <>
              <p>The live post was left as it was. The reason, as recorded:</p>
              <p className="mt-1">
                <code>{remote.failed.errorCode}</code>
                {remote.failed.errorDetail && <> — {remote.failed.errorDetail}</>}
              </p>
            </>
          }
        />
      )}
      {p.state === 'removed' && (
        <StatusBanner
          tone="neutral"
          title="Deleted from the channel"
          data-testid="remote-change-status"
          description={`The post was deleted on the channel${deletedAt ? ` on ${when(deletedAt)}` : ''}. The publication record and its evidence stay.`}
        />
      )}
      {p.state === 'published' && !p.remote.edit && !p.remote.delete && (
        <p className="text-xs text-muted-foreground" data-testid="remote-change-unsupported">
          This channel does not let Oremedia edit or delete a published post; change or delete it on the
          platform itself.
        </p>
      )}
      {lastError !== null && <RequestError error={lastError} />}

      <div className="flex flex-wrap gap-2" aria-label="Actions">
        {actions.cancel && (
          <CancelAction
            inFlight={actions.cancelInFlight}
            pending={cancel.isPending}
            onConfirm={() => cancel.mutate({ publicationId: p.id, expectedVersion: p.version })}
          />
        )}
        {(actions.reschedule || actions.release) && (
          <RescheduleAction
            publication={p}
            release={actions.release}
            timeZone={timeZone}
            onDone={refresh}
            onError={fail('Reschedule failed')}
          />
        )}
        {actions.reconcile && (
          <ReconcileAction publication={p} onDone={refresh} onError={fail('Reconcile failed')} />
        )}
        {actions.editRemote && p.remote.edit && p.remote.allowed.edit && !remote.open && (
          <EditRemoteAction publication={p} onDone={refresh} onError={fail('Edit request failed')} />
        )}
        {actions.deleteRemote && p.remote.delete && p.remote.allowed.delete && !remote.open && (
          <DeleteRemoteAction publication={p} onDone={refresh} onError={fail('Delete request failed')} />
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Publication</dt>
        <dd>
          <code>{p.id}</code>
        </dd>
        <dt className="text-muted-foreground">Revision</dt>
        <dd>
          <code>{p.contentRevisionId}</code>
        </dd>
        <dt className="text-muted-foreground">Variant</dt>
        <dd>
          <code>{p.channelVariantId}</code>
        </dd>
        <dt className="text-muted-foreground">Authority</dt>
        <dd>
          {p.authority} <code>{p.approvalId ?? p.mandateId ?? ''}</code>
        </dd>
        {p.remoteUrl && (
          <>
            <dt className="text-muted-foreground">Remote post</dt>
            <dd>
              <a href={p.remoteUrl} target="_blank" rel="noreferrer noopener" className="underline">
                {p.remoteUrl}
              </a>
            </dd>
          </>
        )}
        {!p.remoteUrl && p.remotePostId && (
          <>
            <dt className="text-muted-foreground">Remote post id</dt>
            <dd>
              <code>{p.remotePostId}</code>
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Version</dt>
        <dd>{p.version}</dd>
      </dl>

      <section aria-labelledby={`attempts-${p.id}`}>
        <h3 id={`attempts-${p.id}`} className="mb-1 text-xs font-semibold">
          Attempts
        </h3>
        {p.attempts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No attempt yet.</p>
        ) : (
          <ol className="flex flex-col gap-1 text-xs">
            {p.attempts.map((a) => (
              <li key={a.id} className="rounded-md border border-border p-2">
                Attempt {a.attemptNumber}: {a.outcome ?? 'open'}
                {a.sentAt ? `, sent ${when(a.sentAt)}` : ', not sent'}
                {a.errorCode && (
                  <>
                    {' '}
                    — <code>{a.errorCode}</code> {a.errorDetail}
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <EvidenceLedger publicationId={p.id} />

      <section aria-labelledby={`channels-${p.id}`} data-testid="channel-outcomes">
        <h3 id={`channels-${p.id}`} className="mb-1 text-xs font-semibold">
          Channels for this revision
        </h3>
        {siblings.isPending && <Skeleton label="Loading channel outcomes" lines={2} />}
        {siblings.isError && <RequestError error={siblings.error} onRetry={() => void siblings.refetch()} />}
        {siblings.isSuccess && summary && (
          <>
            {!siblings.data.complete && (
              <StatusBanner
                tone="warning"
                title="Channel list may be incomplete"
                description="This brand has more publications than were read; some channels of this revision may be missing here."
              />
            )}
            {summary.partial ? (
              <StatusBanner
                tone="warning"
                title="Partial success"
                description={`${summary.text} Successful channels are never republished to repair another; retry only the channels that did not succeed, after reconciliation.`}
              />
            ) : (
              <p className="text-xs text-muted-foreground">{summary.text}</p>
            )}
            <ul className="mt-2 flex flex-col gap-1 text-xs" aria-label="Per-channel outcomes">
              {siblings.data.items.map((s) => {
                const c = publicationChip(s.state);
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={c.tone}>{c.label}</Badge>
                    <span>{channelName(channels, s.channelConnectionId)}</span>
                    {s.id === p.id && <span className="text-muted-foreground">(this one)</span>}
                    {s.remoteUrl && (
                      <a href={s.remoteUrl} target="_blank" rel="noreferrer noopener" className="underline">
                        view post
                      </a>
                    )}
                    {s.state === 'held' && s.holdReasons.length > 0 && (
                      <span className="text-muted-foreground">held: {s.holdReasons.join(', ')}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

const EVIDENCE_KIND_TEXT: Record<string, string> = {
  accepted_response: 'Accepted response',
  status_poll: 'Status poll',
  reconciliation: 'Reconciliation',
  human_confirmation: 'Human confirmation',
  metrics_readback: 'Metrics read-back',
  remote_edit: 'Remote edit',
  remote_deletion: 'Remote deletion',
};

/**
 * R1-C attempt ledger: the evidence rows behind the attempts (spec 14.4), newest last, as the record of what the
 * channel said and what a person confirmed. Redacted payloads are summarised by their hash; the raw row is the API's.
 */
function EvidenceLedger({ publicationId }: { publicationId: string }) {
  const evidence = usePublicationEvidence(publicationId);
  return (
    <section aria-labelledby={`evidence-${publicationId}`} data-testid="evidence-ledger">
      <h3 id={`evidence-${publicationId}`} className="mb-1 text-xs font-semibold">
        Attempt ledger
      </h3>
      {evidence.isPending && <Skeleton label="Loading evidence" lines={2} />}
      {evidence.isError && <RequestError error={evidence.error} onRetry={() => void evidence.refetch()} />}
      {evidence.data && evidence.data.length === 0 && (
        <p className="text-xs text-muted-foreground">No evidence recorded yet.</p>
      )}
      {evidence.data && evidence.data.length > 0 && (
        <ol className="flex flex-col gap-1 text-xs" aria-label="Evidence">
          {evidence.data.map((e) => (
            <li key={e.id} className="rounded-md border border-border p-2">
              <span className="font-medium">{EVIDENCE_KIND_TEXT[e.kind] ?? e.kind}</span> at{' '}
              {when(e.capturedAt)}
              {e.attemptId && (
                <>
                  {' '}
                  · attempt <code>{e.attemptId}</code>
                </>
              )}
              {e.remotePostId && (
                <>
                  {' '}
                  · post{' '}
                  {e.remoteUrl ? (
                    <a
                      href={e.remoteUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      {e.remotePostId}
                    </a>
                  ) : (
                    <code>{e.remotePostId}</code>
                  )}
                </>
              )}{' '}
              · payload <code>{e.payloadHash.slice(0, 12)}…</code>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CancelAction({
  inFlight,
  pending,
  onConfirm,
}: {
  inFlight: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)} disabled={pending}>
        {inFlight ? 'Request cancellation' : 'Cancel publication'}
      </Button>
      <DialogContent
        role="alertdialog"
        title={inFlight ? 'Request cancellation?' : 'Cancel this publication?'}
        description={
          inFlight
            ? 'Dispatch is already in progress. The workflow is signalled; if the send has not started it stops, otherwise the outcome is reconciled. A post already made is never deleted automatically.'
            : 'It will not be sent. You can schedule the variant again later.'
        }
      >
        <DialogActions>
          <DialogClose asChild>
            <Button variant="ghost">Keep it</Button>
          </DialogClose>
          <Button
            variant="danger"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {inFlight ? 'Request cancellation' : 'Cancel publication'}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function RescheduleAction({
  publication: p,
  release,
  timeZone,
  onDone,
  onError,
}: {
  publication: PublicationDto;
  release: boolean;
  timeZone: string;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() =>
    isoToZonedInput(release ? new Date(Date.now() + 5 * 60_000).toISOString() : p.scheduledFor, timeZone),
  );
  const [error, setError] = useState<string | null>(null);
  const intent = useIntentKey();
  const reschedule = useMutation(
    trpc.publishing.publications.reschedule.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setOpen(false);
        onDone();
        toast({
          tone: 'good',
          title: release ? 'Released again' : 'Rescheduled',
          description: `Now ${publicationChip(res.state).label.toLowerCase()} for ${when(res.scheduledFor)}.`,
        });
      },
      onError: (err) => {
        setError(toUiError(err).message);
        onError(err);
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const iso = zonedInputToIso(value, timeZone);
    if (!iso) {
      setError('Enter a date and time.');
      return;
    }
    setError(null);
    reschedule.mutate({ publicationId: p.id, expectedVersion: p.version, scheduledFor: iso });
  };
  const label = release ? (p.state === 'retry_eligible' ? 'Retry' : 'Release again') : 'Reschedule';
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={release ? 'primary' : 'secondary'} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <DialogContent
        title={label}
        description={
          release
            ? 'A new attempt on the same occurrence; the release checks run again at dispatch.'
            : 'The waiting workflow is signalled with the new time; nothing is re-sent.'
        }
      >
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <Field label={`Publish at (${timeZone})`} htmlFor={`reschedule-${p.id}`} error={error ?? undefined}>
            <Input
              id={`reschedule-${p.id}`}
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </Field>
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Back</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={reschedule.isPending}>
              {reschedule.isPending ? 'Saving…' : label}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const RESOLUTIONS = [
  { value: 'confirm_published', label: 'I can see the post on the channel (confirm published)' },
  { value: 'confirm_absent', label: 'The post is definitely absent (allow a retry)' },
  { value: 'cancel', label: 'Cancel it (held only)' },
] as const;
type Resolution = (typeof RESOLUTIONS)[number]['value'];

function ReconcileAction({
  publication: p,
  onDone,
  onError,
}: {
  publication: PublicationDto;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<Resolution>('confirm_published');
  const [remotePostId, setRemotePostId] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const intent = useIntentKey();
  const reconcile = useMutation(
    trpc.publishing.publications.reconcile.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setOpen(false);
        onDone();
        toast({
          tone: 'good',
          title: 'Reconciled',
          description: `Now ${publicationChip(res.state).label.toLowerCase()}.`,
        });
      },
      onError: (err) => {
        setError(toUiError(err).message);
        onError(err);
      },
    }),
  );
  const options = RESOLUTIONS.filter((r) => r.value !== 'cancel' || p.state === 'held');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (resolution === 'confirm_published' && !remotePostId.trim()) {
      setError('The remote post id is required to confirm it was published.');
      return;
    }
    setError(null);
    reconcile.mutate({
      publicationId: p.id,
      resolution,
      remotePostId: remotePostId.trim() || undefined,
      remoteUrl: remoteUrl.trim() || undefined,
      note: note.trim() || undefined,
    });
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        Reconcile
      </Button>
      <DialogContent
        title="Reconcile the outcome"
        description="Your resolution is recorded as human-confirmation evidence. Confirming a post that does not exist, or absence of one that does, is how duplicates and lost posts happen: check the channel first."
      >
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <Field label="What did you find?" htmlFor={`resolution-${p.id}`}>
            <Select
              id={`resolution-${p.id}`}
              value={resolution}
              onValueChange={(v) => setResolution(v as Resolution)}
              options={options.map((o) => ({ value: o.value, label: o.label }))}
            />
          </Field>
          {resolution === 'confirm_published' && (
            <>
              <Field label="Remote post id" htmlFor={`remote-id-${p.id}`} error={error ?? undefined}>
                <Input
                  id={`remote-id-${p.id}`}
                  value={remotePostId}
                  onChange={(e) => setRemotePostId(e.target.value)}
                  required
                />
              </Field>
              <Field label="Remote URL (optional)" htmlFor={`remote-url-${p.id}`}>
                <Input
                  id={`remote-url-${p.id}`}
                  type="url"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                />
              </Field>
            </>
          )}
          {resolution !== 'confirm_published' && error && (
            <StatusBanner tone="critical" title="Not accepted" description={error} />
          )}
          <Field label="Note (optional)" htmlFor={`note-${p.id}`}>
            <Textarea
              id={`note-${p.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          </Field>
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Back</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={reconcile.isPending}>
              {reconcile.isPending ? 'Recording…' : 'Record resolution'}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRemoteAction({
  publication: p,
  onDone,
  onError,
}: {
  publication: PublicationDto;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const intent = useIntentKey();
  const del = useMutation(
    trpc.publishing.publications.deleteRemote.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        onDone();
        toast({
          tone: 'info',
          title: 'Deletion requested',
          description: 'The post is deleted on the channel shortly; this screen shows when it is done.',
        });
      },
      onError,
    }),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
        Request remote deletion
      </Button>
      <DialogContent
        role="alertdialog"
        title="Delete the live post?"
        description="The post is deleted on the channel and cannot be brought back from here. Deleting a live post is a separate, recorded action, never an automatic rollback. Give the reason that will be audited."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) del.mutate({ publicationId: p.id, reason: reason.trim() });
          }}
          className="flex flex-col gap-3"
          noValidate
        >
          <Field label="Reason" htmlFor={`delete-reason-${p.id}`}>
            <Textarea
              id={`delete-reason-${p.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              required
            />
          </Field>
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Keep the post</Button>
            </DialogClose>
            <Button type="submit" variant="danger" disabled={del.isPending || !reason.trim()}>
              Request deletion
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditRemoteAction({
  publication: p,
  onDone,
  onError,
}: {
  publication: PublicationDto;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const variant = useChannelVariant(open && p.remote.currentText === null ? p.channelVariantId : null);
  const live = p.remote.currentText ?? variant.data?.text ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const text = draft ?? live ?? '';
  const length = plainLength(text);
  const limit = p.remote.textMaxLength;
  const over = limit !== null && !p.remote.textWeighted && length > limit;
  const unchanged = live !== null && text.trimEnd() === live.trimEnd();
  const intent = useIntentKey();
  const edit = useMutation(
    trpc.publishing.publications.editRemote.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        setDraft(null);
        setReason('');
        onDone();
        toast({
          tone: 'info',
          title: 'Text edit requested',
          description: 'The new text is sent to the channel shortly; this screen shows when it is live.',
        });
      },
      onError: (err) => {
        setError(toUiError(err).message);
        onError(err);
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setError('Enter the new text.');
      return;
    }
    if (over || unchanged) return;
    setError(null);
    edit.mutate({ publicationId: p.id, text, reason: reason.trim() || undefined });
  };
  const count =
    limit === null
      ? `${length} characters`
      : `${length} / ${limit} characters${p.remote.textWeighted ? ' (the channel weighs some characters; checked on save)' : ''}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Edit text
      </Button>
      <DialogContent
        title="Edit the live post’s text"
        description="The new text replaces the post’s text on the channel; its media and link stay as they are. It is checked against the channel’s rules and the change is recorded with its evidence."
      >
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          {live === null && variant.isPending && <Skeleton label="Loading the current text" lines={3} />}
          {live === null && variant.isError && (
            <RequestError error={variant.error} onRetry={() => void variant.refetch()} />
          )}
          {(live !== null || variant.isError) && (
            <Field
              label="Text"
              htmlFor={`edit-text-${p.id}`}
              hint={count}
              error={
                error ??
                (over
                  ? `The text is ${length - (limit ?? 0)} characters over the channel’s limit.`
                  : undefined)
              }
            >
              <Textarea
                id={`edit-text-${p.id}`}
                value={text}
                onChange={(e) => setDraft(e.target.value)}
                rows={6}
                required
                data-testid="edit-remote-text"
              />
            </Field>
          )}
          <Field label="Reason (optional)" htmlFor={`edit-reason-${p.id}`}>
            <Textarea
              id={`edit-reason-${p.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
          </Field>
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Back</Button>
            </DialogClose>
            <Button
              type="submit"
              variant="primary"
              disabled={edit.isPending || over || unchanged || !text.trim()}
            >
              {edit.isPending ? 'Saving…' : 'Save to the channel'}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
