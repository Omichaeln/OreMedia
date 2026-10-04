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
import { renderArticleHtml } from '@oremedia/contracts/article';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import { useTRPC } from '../../lib/trpc';
import { destinationLabel, type DestinationDto } from '../destinations/use-destinations';
import {
  actionsFor,
  articleConflictOf,
  compareArticleBlocks,
  channelOutcomeSummary,
  holdReasonText,
  isoToZonedInput,
  zonedInputToIso,
  outcomeUnknownReasonText,
  plainLength,
  publicationChip,
  remoteChangeNoun,
  remoteChangeStatus,
  remoteVerificationChip,
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
  /** R2-3: the brand's websites, named when the publication targets one. */
  destinations: ReadonlyMap<string, DestinationDto>;
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
export function PublicationDetail({
  brandId,
  publicationId,
  channels,
  destinations,
  timeZone,
}: PublicationDetailProps) {
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
        <Loaded
          brandId={brandId}
          publication={publication.data}
          channels={channels}
          destinations={destinations}
          timeZone={timeZone}
        />
      )}
    </Panel>
  );
}

function Loaded({
  brandId,
  publication: p,
  channels,
  destinations,
  timeZone,
}: {
  brandId: string;
  publication: PublicationDto;
  channels: ReadonlyMap<string, ChannelDto>;
  destinations: ReadonlyMap<string, DestinationDto>;
  timeZone: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const chip = publicationChip(p.state, p.remoteStatus);
  const verification = p.destinationId ? remoteVerificationChip(p.remoteVerification) : null;
  const actions = actionsFor(p.state);
  const channel = p.channelConnectionId ? channels.get(p.channelConnectionId) : undefined;
  const website = p.destinationId
    ? destinationLabel(destinations.get(p.destinationId), p.destinationId)
    : null;
  const [cancelResult, setCancelResult] = useState<CancelResultDto | null>(null);
  const [lastError, setLastError] = useState<unknown>(null);
  const siblings = useRevisionPublications(brandId, p.contentRevisionId);
  const remote = remoteChangeStatus(p.remote.changes);
  // PR-03: a refused website edit with what the site holds now, recorded with the refreshed read-back.
  const conflict = articleConflictOf(
    p.remote.article?.readback?.payload ?? null,
    remote.failed?.kind === 'edit' ? remote.failed.id : null,
  );
  const deletedAt =
    p.remote.changes.find((c) => c.kind === 'delete' && c.state === 'succeeded')?.finishedAt ?? null;
  // RA-12: the latest change went through but replaced a change made on the website in the write's window.
  const overwritten =
    p.remote.changes[0]?.state === 'succeeded' && p.remote.changes[0].errorCode === 'conflict_overwritten'
      ? p.remote.changes[0]
      : null;

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
        {channel && p.channelConnectionId && (
          <Badge
            tone={CHANNEL_CHIP[channel.status].tone}
            glyph={CHANNEL_CHIP[channel.status].tone !== 'good'}
          >
            {channelName(channels, p.channelConnectionId)}: {CHANNEL_CHIP[channel.status].label}
          </Badge>
        )}
        {website && (
          <Badge tone="info" glyph={false} data-testid="publication-target-website">
            {website}
          </Badge>
        )}
        {verification && p.state === 'published' && (
          <Badge tone={verification.tone} data-testid="publication-verification">
            {verification.label}
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
      {conflict && (
        <ArticleConflictPanel
          publication={p}
          conflict={conflict}
          canReapply={actions.editRemote && p.remote.edit && p.remote.allowed.edit && !remote.open}
          onDone={refresh}
          onError={fail('Edit request failed')}
        />
      )}
      {remote.failed && !conflict && (
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
      {overwritten && (
        <StatusBanner
          tone="warning"
          title="The edit went through, but it replaced a change made on the website"
          data-testid="remote-change-overwritten"
          description={
            <>
              <p>
                The website changed the article between the read before the write and the write itself; the
                website offers no way to refuse a write in that window, so it was detected afterwards. The
                revision that was replaced is recorded as evidence.
              </p>
              {overwritten.errorDetail && <p className="mt-1">{overwritten.errorDetail}</p>}
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
      {p.remote.article && (
        <ArticlePanel publication={p} onDone={refresh} onError={fail('Validation failed')} />
      )}
      {p.state === 'published' && !p.remote.edit && !p.remote.delete && !p.remote.unpublish && (
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
        {actions.deleteRemote &&
          p.remote.unpublish &&
          p.remote.allowed.unpublish &&
          p.remoteStatus === 'live' &&
          !remote.open && (
            <RevertToDraftAction publication={p} onDone={refresh} onError={fail('Revert request failed')} />
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
                const c = publicationChip(s.state, s.remoteStatus);
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={c.tone}>{c.label}</Badge>
                    <span>
                      {s.destinationId
                        ? destinationLabel(destinations.get(s.destinationId), s.destinationId)
                        : channelName(channels, s.channelConnectionId ?? '')}
                    </span>
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
  remote_readback: 'Article read back from the website',
  rendered_validation: 'Rendered page validation',
  remote_unpublish: 'Reverted to draft on the website',
};

const RENDERED_CHECK_TEXT: Record<string, string> = {
  status_ok: 'The page answered 200',
  title_present: 'The title is in the page title or its heading',
  canonical_present: 'A canonical link is present',
  indexable: 'No noindex (a draft is allowed one)',
  body_present: 'The first paragraph is in the page',
  canonical_matches: 'The canonical link names this page (its address or its slug)',
  last_paragraph_present: 'The last paragraph is in the page',
};

/** RA-04: what the read-back proved, as the server recorded it in the read-back evidence (read as data). */
function readbackVerificationOf(payload: Record<string, unknown>): string | null {
  const v = payload['verification'];
  if (typeof v !== 'object' || v === null) return null;
  const outcome = (v as { outcome?: unknown }).outcome;
  const list = (key: string) => {
    const value = (v as Record<string, unknown>)[key];
    return Array.isArray(value) ? value.map(String).join(', ') : '';
  };
  if (outcome === 'verified') return `The read-back matched what was sent (${list('matched')}).`;
  if (outcome === 'mismatch') return `The read-back differs from what was sent on: ${list('mismatched')}.`;
  if (outcome === 'unverified') {
    const reason = (v as { reason?: unknown }).reason;
    return `Nothing could be compared${typeof reason === 'string' ? ` (${reason})` : ''}: the write is unproven.`;
  }
  return null;
}

/** What the evidence payload of a rendered validation carries (recorded by the server, read as data). */
function renderedChecks(payload: Record<string, unknown>): Array<{ key: string; ok: boolean }> {
  const checks = payload['checks'];
  return Array.isArray(checks)
    ? checks
        .filter((c): c is { key: string; ok: boolean } => typeof c === 'object' && c !== null && 'key' in c)
        .map((c) => ({ key: String(c.key), ok: c.ok === true }))
    : [];
}

/**
 * R2-3: what the website said back after the article was written (the read-back with its content hash), what the
 * rendered page showed (the validation, re-run on demand) and whether the article was reverted to a draft since.
 */
function ArticlePanel({
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
  const intent = useIntentKey();
  const article = p.remote.article;
  const validate = useMutation(
    trpc.publishing.publications.validateRendered.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        onDone();
        toast(
          res.ok
            ? { tone: 'good', title: 'The page checks out' }
            : {
                tone: 'warning',
                title: 'The page did not pass every check',
                description: 'See the checks below.',
              },
        );
      },
      onError,
    }),
  );
  if (!article) return null;
  const readback = article.readback?.payload ?? null;
  const validation = article.validation?.payload ?? null;
  const checks = validation ? renderedChecks(validation) : [];
  const ok = validation ? validation['ok'] === true : null;
  const remoteStatus = publicationChip(p.state, p.remoteStatus);
  const verification = remoteVerificationChip(p.remoteVerification);
  const readbackVerification = readback ? readbackVerificationOf(readback) : null;
  return (
    <section
      aria-labelledby={`article-${p.id}`}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      data-testid="article-panel"
    >
      <h3 id={`article-${p.id}`} className="text-xs font-semibold">
        Website article
      </h3>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {p.remoteStatus && (
          <Badge tone={remoteStatus.tone} data-testid="article-remote-status">
            {remoteStatus.label}
          </Badge>
        )}
        {verification && (
          <Badge tone={verification.tone} data-testid="article-verification">
            {verification.label}
          </Badge>
        )}
        {readback ? (
          <Badge tone={readback['status'] === 'publish' ? 'good' : 'info'} data-testid="article-readback">
            Read back: {String(readback['status'])}
          </Badge>
        ) : (
          <Badge tone="neutral" data-testid="article-readback">
            Not read back yet
          </Badge>
        )}
        {article.unpublished && (
          <Badge tone="warning" data-testid="article-unpublished">
            Reverted to draft {when(article.unpublished.capturedAt)}
          </Badge>
        )}
        {ok === null ? (
          <Badge tone="neutral" data-testid="article-validation">
            Page not validated
          </Badge>
        ) : (
          <Badge tone={ok ? 'good' : 'critical'} data-testid="article-validation">
            {ok ? 'Page validated' : 'Page validation failed'}
          </Badge>
        )}
      </div>
      {p.remoteStatus && (
        <p className="text-xs text-muted-foreground" data-testid="article-remote-status-detail">
          {remoteStatus.detail}
          {verification ? ` ${verification.detail}` : ''}
          {p.remoteVerifiedAt ? ` Verified ${when(p.remoteVerifiedAt)}.` : ''}
        </p>
      )}
      {readback && (
        <p className="text-xs text-muted-foreground">
          Remote revision <code>{String(readback['remoteId'])}</code>
          {typeof readback['modifiedAt'] === 'string' ? ` modified ${when(readback['modifiedAt'])}` : ''} ·
          content hash <code>{String(readback['contentHash']).slice(0, 12)}…</code>. An edit from here is
          refused when the website moved past this hash; nothing is overwritten.
          {readbackVerification && (
            <span data-testid="article-readback-verification"> {readbackVerification}</span>
          )}
        </p>
      )}
      {validation && (
        <ul
          className="flex flex-col gap-0.5 text-xs"
          aria-label="Rendered page checks"
          data-testid="article-checks"
        >
          {checks.map((c) => (
            <li key={c.key} data-check={c.key} data-ok={c.ok ? 'true' : 'false'}>
              {c.ok ? 'Pass' : 'Fail'}: {RENDERED_CHECK_TEXT[c.key] ?? c.key}
            </li>
          ))}
          {typeof validation['error'] === 'string' && validation['error'] && (
            <li>
              The page could not be read: <code>{validation['error']}</code>
            </li>
          )}
        </ul>
      )}
      {p.state === 'published' && p.remoteUrl && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={validate.isPending}
            onClick={() => validate.mutate({ publicationId: p.id })}
            data-testid="validate-article"
          >
            {validate.isPending ? 'Checking the page…' : 'Validate the page now'}
          </Button>
        </div>
      )}
    </section>
  );
}

/** R2-3 rollback: the live article is set back to a draft on its website (publication.delete_remote), recorded. */
function RevertToDraftAction({
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
  const revert = useMutation(
    trpc.publishing.publications.unpublishRemote.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        onDone();
        toast({
          tone: 'info',
          title: 'Revert requested',
          description:
            'The article is set back to a draft on the website shortly; this screen shows when it is done.',
        });
      },
      onError,
    }),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)} data-testid="revert-to-draft">
        Revert to draft
      </Button>
      <DialogContent
        role="alertdialog"
        title="Revert the article to a draft?"
        description="The page stops being public on the website; the article and its revisions stay. Reverting is a separate, recorded action, never an automatic rollback. Give the reason that will be audited."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) revert.mutate({ publicationId: p.id, reason: reason.trim() });
          }}
          className="flex flex-col gap-3"
          noValidate
        >
          <Field label="Reason" htmlFor={`revert-reason-${p.id}`}>
            <Textarea
              id={`revert-reason-${p.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              required
            />
          </Field>
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Keep it live</Button>
            </DialogClose>
            <Button type="submit" variant="danger" disabled={revert.isPending || !reason.trim()}>
              Request revert
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * PR-03: a website edit the site refused, and the way to resolve it. Nothing was written. Beside each other: the
 * article as the website holds it now and the edit that was not applied, block by block (a block the other side
 * lacks is marked). `remote_changed`: the person re-applies the edit to the current version on purpose (a new
 * edit request whose precondition is the version shown, so a further change on the site is refused again) or
 * reconciles it in the site's own editor. `limited_mode`: the site cannot apply an edit safely at all, so the edit
 * is made on the site (or the site administrator installs the conditional-write plugin).
 */
function ArticleConflictPanel({
  publication: p,
  conflict,
  canReapply,
  onDone,
  onError,
}: {
  publication: PublicationDto;
  conflict: NonNullable<ReturnType<typeof articleConflictOf>>;
  canReapply: boolean;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const intent = useIntentKey();
  const compared =
    conflict.currentHtml !== null ? compareArticleBlocks(conflict.currentHtml, conflict.attemptedHtml) : null;
  const reapply = useMutation(
    trpc.publishing.publications.editRemote.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        onDone();
        toast({
          tone: 'info',
          title: 'Edit requested again',
          description:
            'It is applied only if the website still holds the version shown here; this screen shows the outcome.',
        });
      },
      onError,
    }),
  );
  const limited = conflict.reason === 'limited_mode';
  const side = (label: string, blocks: Array<{ text: string; changed: boolean }>, testId: string) => (
    <section className="flex min-w-0 flex-col gap-1" aria-label={label} data-testid={testId}>
      <h4 className="text-xs font-semibold">{label}</h4>
      {blocks.length === 0 ? (
        <p className="text-xs text-muted-foreground">No text.</p>
      ) : (
        <ol className="flex flex-col gap-1 text-xs">
          {blocks.map((b, i) => (
            <li
              key={i}
              data-changed={b.changed ? 'true' : 'false'}
              className={b.changed ? 'border-l-2 border-status-warning pl-2' : 'pl-2.5'}
            >
              {b.changed && <span className="sr-only">Differs: </span>}
              {b.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-status-warning p-3"
      aria-labelledby={`conflict-${p.id}`}
      data-testid="article-conflict"
      data-conflict-reason={conflict.reason}
    >
      <StatusBanner
        tone="warning"
        title={
          limited
            ? 'The edit was not applied: this website is in limited mode'
            : 'The edit was not applied: the article changed on the website'
        }
        description={
          limited
            ? 'This website cannot guarantee that an edit does not overwrite a change made there, so Oremedia does not edit existing articles on it. Make the change in the website’s own editor, or ask the site administrator to install the Oremedia conditional-write plugin. Nothing was written.'
            : `Someone changed the article on the website${conflict.currentModifiedAt ? ` (${when(conflict.currentModifiedAt)})` : ''} after Oremedia last read it, so the website refused the edit and nothing was written. Compare the two versions, then re-apply your edit to the current version or reconcile the article on the website.`
        }
      />
      <h3 id={`conflict-${p.id}`} className="sr-only">
        Compare the website’s current article with your edit
      </h3>
      {compared ? (
        <div className="grid gap-3 md:grid-cols-2">
          {side('On the website now', compared.current, 'conflict-current')}
          {side('Your edit (not applied)', compared.attempted, 'conflict-attempted')}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          The website’s current article could not be read; open it on the website to compare.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!limited && canReapply && conflict.attemptedHtml.trim() !== '' && (
          <Dialog open={open} onOpenChange={setOpen}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setOpen(true)}
              data-testid="conflict-reapply"
            >
              Re-apply my edit to the current version
            </Button>
            <DialogContent
              role="alertdialog"
              title="Replace the website’s current version with your edit?"
              description="Your edit replaces the article body shown under “On the website now”, including the changes made on the website. It is applied only if the website still holds exactly that version; if it changed again, it is refused again and nothing is written."
            >
              <DialogActions>
                <DialogClose asChild>
                  <Button variant="ghost">Back</Button>
                </DialogClose>
                <Button
                  variant="primary"
                  disabled={reapply.isPending}
                  onClick={() =>
                    reapply.mutate({
                      publicationId: p.id,
                      text: conflict.attemptedHtml,
                      reason: 'Re-applied after comparing with the website’s current version',
                    })
                  }
                  data-testid="confirm-conflict-reapply"
                >
                  {reapply.isPending ? 'Requesting…' : 'Re-apply my edit'}
                </Button>
              </DialogActions>
            </DialogContent>
          </Dialog>
        )}
        {conflict.editUrl && (
          <a
            href={conflict.editUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs underline"
            data-testid="conflict-open-editor"
          >
            Open in the website’s editor
          </a>
        )}
        {p.remoteUrl && (
          <a href={p.remoteUrl} target="_blank" rel="noreferrer noopener" className="text-xs underline">
            View the page
          </a>
        )}
      </div>
    </section>
  );
}

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
  // RA-12: a website article is edited as the HTML the site holds (rendered from its blocks), never as the plain
  // text the variant carries for captions; a channel post is edited as its text.
  const website = p.destinationId !== null;
  const live =
    p.remote.currentText ??
    (variant.data
      ? website && variant.data.article
        ? renderArticleHtml(variant.data.article)
        : variant.data.text
      : null);
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
        title={website ? 'Edit the article’s body' : 'Edit the live post’s text'}
        description={
          website
            ? 'The HTML replaces the article’s body on the website after it is read back and found unchanged since; the title, slug and terms stay as they are. The change is recorded with its evidence.'
            : 'The new text replaces the post’s text on the channel; its media and link stay as they are. It is checked against the channel’s rules and the change is recorded with its evidence.'
        }
      >
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          {live === null && variant.isPending && <Skeleton label="Loading the current text" lines={3} />}
          {live === null && variant.isError && (
            <RequestError error={variant.error} onRetry={() => void variant.refetch()} />
          )}
          {(live !== null || variant.isError) && (
            <Field
              label={website ? 'Body (HTML)' : 'Text'}
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
