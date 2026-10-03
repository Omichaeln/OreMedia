import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Badge, Button, StatusBanner, type Tone } from '@oremedia/ui';
import { toUiError } from '../../../lib/errors';
import { mutationIntent, useIntentKey } from '../../../lib/intent-key';
import { useTRPC } from '../../../lib/trpc';
import { timecode } from './timecode';
import type { VideoAiJobDto, VideoAiProposalDto } from './use-video-ai';
import type { VideoStudioApi } from './use-video-studio';

type Change = VideoAiProposalDto['changes'][number];

const KIND_TONE: Record<Change['kind'], Tone> = {
  added: 'good',
  removed: 'critical',
  moved: 'info',
  trimmed: 'warning',
  replaced: 'info',
  changed: 'neutral',
};
const span = (s: Change['before']) => (s ? `${timecode(s.startMs)}–${timecode(s.endMs)}` : '');

/** One change of the diff in words: what, where it was and where it goes (colour is never the only carrier). */
function ChangeLine({ change }: { change: Change }) {
  const where =
    change.before && change.after
      ? `${span(change.before)} → ${span(change.after)}`
      : span(change.after ?? change.before);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-xs">
      <Badge tone={KIND_TONE[change.kind]}>{change.kind}</Badge>
      <span className="font-medium">{change.label}</span>
      {change.trackKind && <span className="text-muted-foreground">{change.trackKind}</span>}
      {where && <span className="tabular-nums text-muted-foreground">{where}</span>}
    </li>
  );
}

/**
 * A proposal of a video AI job (an assembly over existing work, or a recut): its change groups with the timeline diff
 * of each, every one kept by default; the person keeps or leaves out groups and accepts. The server recompiles the
 * kept groups against the base revision and writes one revision with the job's inputs; undo and redo work on it like
 * any edit, and the history keeps every revision.
 */
export function ProposalReview({
  job,
  proposal,
  studio,
  onDone,
}: {
  job: VideoAiJobDto;
  proposal: VideoAiProposalDto;
  studio: VideoStudioApi;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const intent = useIntentKey();
  const [kept, setKept] = useState<Set<string>>(() => new Set(proposal.groups.map((g) => g.id)));
  useEffect(() => setKept(new Set(proposal.groups.map((g) => g.id))), [proposal]);
  const accept = useMutation(
    trpc.creative.videoAi.accept.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        studio.adoptRevision(res);
        onDone();
      },
    }),
  );
  const stale = studio.state.committed.revisionId !== proposal.baseRevisionId;
  const localWork = Boolean(studio.state.pending || studio.state.inFlight);
  const blocking = proposal.findings.filter((f) => f.severity === 'blocking');
  const accepted = Boolean(proposal.acceptedRevisionId);
  const reason = accepted
    ? 'Already accepted'
    : stale
      ? 'The video changed since this was proposed; ask again'
      : localWork
        ? 'Save your pending changes first'
        : kept.size === 0
          ? 'Keep at least one change'
          : undefined;
  const toggle = (id: string) =>
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section
      aria-labelledby={`proposal-${job.id}`}
      className="flex flex-col gap-2"
      data-testid="video-proposal"
    >
      <h3 id={`proposal-${job.id}`} className="text-sm font-semibold">
        {proposal.kind === 'assembly' ? 'Assembly proposal' : 'Proposed changes'}
      </h3>
      <p className="text-sm">{proposal.summary}</p>
      {stale && !accepted && (
        <StatusBanner
          tone="warning"
          title="The video changed since this was proposed"
          description="Nothing was replaced. Ask again to get changes for the current version."
        />
      )}
      {blocking.length > 0 && (
        <StatusBanner
          tone="critical"
          title={`${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}`}
          description={blocking.map((f) => f.message).join(' ')}
        />
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-muted-foreground">Changes to keep</legend>
        {proposal.groups.map((g) => (
          <div key={g.id} className="rounded-md border border-border p-2" data-testid={`group-${g.id}`}>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={kept.has(g.id)}
                disabled={accepted}
                onChange={() => toggle(g.id)}
                data-testid={`keep-${g.id}`}
              />
              {g.label}
              <span className="text-xs font-normal text-muted-foreground">
                {g.changes.length} change{g.changes.length === 1 ? '' : 's'}
              </span>
            </label>
            <ul className="mt-1 flex flex-col gap-1 pl-6" aria-label={`Changes in ${g.label}`}>
              {g.changes.slice(0, 30).map((c, i) => (
                <ChangeLine key={`${c.target}-${c.id}-${i}`} change={c} />
              ))}
              {g.changes.length > 30 && (
                <li className="text-xs text-muted-foreground">and {g.changes.length - 30} more</li>
              )}
            </ul>
          </div>
        ))}
      </fieldset>
      {accept.isError && (
        <StatusBanner
          tone="critical"
          title="Could not accept"
          description={toUiError(accept.error).message}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabledReason={reason}
          disabled={accept.isPending}
          onClick={() =>
            accept.mutate({ jobId: job.id, baseRevisionId: proposal.baseRevisionId, groupIds: [...kept] })
          }
          data-testid="accept-proposal"
        >
          {kept.size === proposal.groups.length
            ? 'Accept all'
            : `Accept ${kept.size} of ${proposal.groups.length}`}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} data-testid="dismiss-proposal">
          {accepted ? 'Close' : 'Leave it'}
        </Button>
      </div>
      {accepted && (
        <p className="text-xs text-muted-foreground" role="status">
          Accepted as a new revision. Undo takes it back; the history keeps every revision.
        </p>
      )}
    </section>
  );
}
