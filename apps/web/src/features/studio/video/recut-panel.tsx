import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TrackItem, VideoProjectV1 } from '@oremedia/contracts/video';
import type { VideoAiScope } from '@oremedia/contracts/video-ai';
import { Button, EmptyState, Field, StatusBanner, Textarea } from '@oremedia/ui';
import { Select } from '../../../components/select';
import { toUiError } from '../../../lib/errors';
import { mutationIntent, useIntentKey } from '../../../lib/intent-key';
import { useTRPC } from '../../../lib/trpc';
import { brandPath, useBrandContext } from '../../brand/brand-context';
import { ProposalReview } from './proposal-review';
import { useVideoAiActive, useVideoAiJob, type VideoAiJobDto } from './use-video-ai';
import type { VideoStudioApi } from './use-video-studio';
import { VideoAiJobStatus } from './video-ai-job';
import { itemLabel } from './video-actions';

type ScopeKind = VideoAiScope['kind'];
const EXAMPLES = [
  'Move the product demonstration before the introduction',
  'Shorten to 20 seconds',
  'Remove pauses and tighten the pacing',
  'Add captions and finish with the approved call to action',
  'Create a vertical version keeping the product visible',
];

/**
 * STU-3 targeted AI edits of the timeline: a plain-language request with an explicit scope (the selected item, one
 * scene, or the whole video) that the server holds the result to, a durable job, then the proposal with its timeline
 * diff accepted per change group, the conflicts it reported (locked material, missing messaging, out of scope), and
 * any new-format version it made as a separate document (the original is never changed).
 */
export function RecutPanel({
  documentId,
  project,
  studio,
}: {
  documentId: string;
  project: VideoProjectV1;
  studio: VideoStudioApi;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const startKey = useIntentKey();
  const active = useVideoAiActive(documentId);
  const [jobId, setJobId] = useState<string | null>(null);
  const live = active.data?.items.find((j) => j.kind === 'recut');
  const shownId = jobId ?? live?.id ?? active.data?.lastRecut?.id ?? null;
  const job = useVideoAiJob(shownId);
  const [instruction, setInstruction] = useState('');
  const selected = studio.state.selection;
  const selectedItem = selected
    ? (project.tracks.find((t) => t.id === selected.trackId)?.items as TrackItem[] | undefined)?.find(
        (i) => i.id === selected.itemId,
      )
    : undefined;
  const [scopeKind, setScopeKind] = useState<ScopeKind>('timeline');
  const scenes = [...project.scenes].sort((a, b) => a.startMs - b.startMs);
  const [sceneId, setSceneId] = useState<string>(scenes[0]?.id ?? '');
  const scope: VideoAiScope | null =
    scopeKind === 'timeline'
      ? { kind: 'timeline' }
      : scopeKind === 'scene'
        ? sceneId
          ? { kind: 'scene', sceneId }
          : null
        : selectedItem
          ? { kind: 'items', itemIds: [selectedItem.id] }
          : null;
  const start = useMutation(
    trpc.creative.videoAi.start.mutationOptions({
      ...mutationIntent(startKey.key),
      onSuccess: (res) => {
        startKey.renew();
        setJobId(res.id);
        void queryClient.invalidateQueries(trpc.creative.videoAi.active.pathFilter());
      },
    }),
  );
  const localWork = Boolean(studio.state.pending || studio.state.inFlight);
  const hasClips = project.tracks.some((t) => t.kind === 'video' && t.items.length > 0);
  const submit = () => {
    if (!scope || !instruction.trim()) return;
    start.mutate({
      documentId,
      baseRevisionId: studio.state.committed.revisionId,
      request: { kind: 'recut', recut: { instruction: instruction.trim(), scope } },
    });
  };
  return (
    <section aria-labelledby="recut-heading" className="flex flex-col gap-3" data-testid="recut-panel">
      <h2 id="recut-heading" className="text-sm font-semibold">
        Change with AI
      </h2>
      {!hasClips ? (
        <EmptyState
          title="Nothing to change yet"
          description="Write a storyboard and assemble it, or add clips, then ask for changes here."
          className="py-2"
        />
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field
            label="What should change?"
            htmlFor="recut-instruction"
            hint={`For example: ${EXAMPLES.join('; ')}. Ctrl+Enter sends.`}
          >
            <Textarea
              id="recut-instruction"
              rows={3}
              maxLength={2000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </Field>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="text-xs font-medium text-muted-foreground">What may change</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="recut-scope"
                checked={scopeKind === 'items'}
                disabled={!selectedItem}
                onChange={() => setScopeKind('items')}
              />
              {selectedItem
                ? `Only the selected item (${itemLabel(selectedItem)})`
                : 'Only the selected item (select one first)'}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="recut-scope"
                checked={scopeKind === 'scene'}
                disabled={scenes.length === 0}
                onChange={() => setScopeKind('scene')}
              />
              One scene
            </label>
            {scopeKind === 'scene' && scenes.length > 0 && (
              <Select
                size="sm"
                aria-label="Scene"
                value={sceneId}
                onValueChange={setSceneId}
                options={scenes.map((s) => ({ value: s.id, label: s.title }))}
              />
            )}
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="recut-scope"
                checked={scopeKind === 'timeline'}
                onChange={() => setScopeKind('timeline')}
              />
              The whole video
            </label>
            <p className="text-xs text-muted-foreground">
              Locked items never change. Outside the scope, items only move in time.
            </p>
          </fieldset>
          {start.isError && (
            <StatusBanner
              tone="critical"
              title="The change could not start"
              description={toUiError(start.error).message}
            />
          )}
          <Button
            type="submit"
            size="sm"
            variant="primary"
            className="self-start"
            disabled={start.isPending || !instruction.trim()}
            disabledReason={
              localWork ? 'Save your pending changes first' : !scope ? 'Choose what may change' : undefined
            }
            data-testid="start-recut"
          >
            Propose changes
          </Button>
        </form>
      )}
      {job.data && <RecutJob key={job.data.id} job={job.data} studio={studio} />}
    </section>
  );
}

function RecutJob({ job, studio }: { job: VideoAiJobDto; studio: VideoStudioApi }) {
  const { companyId, brandId } = useBrandContext();
  const [open, setOpen] = useState(true);
  const result = job.result;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2" data-testid="recut-job">
      <p className="text-xs text-muted-foreground">
        “{job.request.kind === 'recut' ? job.request.recut.instruction : ''}”
      </p>
      <VideoAiJobStatus job={job} />
      {result && result.conflicts.length > 0 && (
        <StatusBanner
          tone="warning"
          title={`${result.conflicts.length} thing${result.conflicts.length === 1 ? '' : 's'} could not be done as asked`}
          description={result.conflicts.map((c) => c.message).join(' ')}
          data-testid="recut-conflicts"
        />
      )}
      {result?.revisions.map((r) => (
        <p key={r.documentId} className="text-sm" data-testid="recut-version">
          {r.label} made as a new video; this one is unchanged.{' '}
          <Link
            className="underline"
            to={brandPath(companyId, brandId, `studio/${encodeURIComponent(r.documentId)}`)}
          >
            Open it
          </Link>
        </p>
      ))}
      {result?.proposal && open && (
        <ProposalReview job={job} proposal={result.proposal} studio={studio} onDone={() => setOpen(false)} />
      )}
      {job.state === 'completed' && !result?.proposal && result?.revisions.length === 0 && (
        <p className="text-sm text-muted-foreground">No change was proposed.</p>
      )}
    </div>
  );
}
