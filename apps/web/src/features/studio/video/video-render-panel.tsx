import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, StatusBanner } from '@oremedia/ui';
import { useTRPC } from '../../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../../lib/intent-key';
import { toUiError } from '../../../lib/errors';
import { VideoPlayer } from '../../assets/media-player';
import { mediaClock } from '../../assets/media';
import { useRenderJob } from '../use-document';

export interface VideoRenderPanelProps {
  documentId: string;
  revisionId: string;
  formatKey: string;
  title: string;
  hasLocalWork: boolean;
  blocking: number;
}

const PHASES: Record<string, string> = {
  encoding: 'Encoding',
  overlays: 'Drawing titles and captions',
  preparing: 'Preparing',
};

/**
 * Renders the committed revision on the `video` queue: progress while the worker composes and encodes (the job is
 * polled every two seconds), cancel while it runs, retry after a failure or cancel, and the finished MP4 to play,
 * download (with its poster and captions) and keep editing from. The export is bound by its hash in review.
 */
export function VideoRenderPanel({
  documentId,
  revisionId,
  formatKey,
  title,
  hasLocalWork,
  blocking,
}: VideoRenderPanelProps) {
  const trpc = useTRPC();
  const intent = useIntentKey();
  const cancelIntent = useIntentKey();
  const [jobId, setJobId] = useState<string | null>(null);
  const request = useMutation(
    trpc.creative.renders.request.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setJobId(res.renderJobId);
      },
    }),
  );
  const cancel = useMutation(
    trpc.creative.renders.cancel.mutationOptions({
      ...mutationIntent(cancelIntent.key),
      onSuccess: () => cancelIntent.renew(),
    }),
  );
  const job = useRenderJob(jobId);
  const ready = job.data?.state === 'ready';
  const media = useQuery({
    ...trpc.creative.renders.exportMedia.queryOptions({ renderJobId: jobId ?? '' }),
    enabled: Boolean(jobId) && ready,
    staleTime: 4 * 60_000,
  });
  const start = () => request.mutate({ documentId, revisionId, formatKeys: [formatKey] });
  const running = job.data && (job.data.state === 'pending' || job.data.state === 'rendering');
  const fraction = job.data?.progress?.fraction ?? 0;

  return (
    <div className="flex flex-col gap-2" data-testid="video-render">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={start}
          disabled={request.isPending || Boolean(running)}
          disabledReason={
            hasLocalWork
              ? 'Save your pending changes first; renders are made from a committed revision'
              : undefined
          }
          data-testid="render-video"
        >
          Render video
        </Button>
        {blocking > 0 && (
          <Badge tone="warning">
            {blocking} blocking finding{blocking === 1 ? '' : 's'}
          </Badge>
        )}
      </div>
      {request.isError && (
        <StatusBanner
          tone="critical"
          title="Render request failed"
          description={toUiError(request.error).message}
        />
      )}
      {jobId && job.isError && (
        <StatusBanner
          tone="critical"
          title="Cannot read the render"
          description={toUiError(job.error).message}
        />
      )}
      {jobId && running && (
        <div className="flex flex-col gap-1" role="status" aria-live="polite">
          <p className="text-sm">
            {job.data?.state === 'pending'
              ? 'Render queued'
              : `${PHASES[job.data?.progress?.phase ?? ''] ?? 'Rendering'}: ${Math.round(fraction * 100)}%`}
          </p>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Render progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            data-testid="render-progress"
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${Math.round(fraction * 100)}%` }}
            />
          </div>
          <Button
            size="sm"
            variant="danger"
            className="self-start"
            disabled={cancel.isPending}
            onClick={() => jobId && cancel.mutate({ renderJobId: jobId })}
            data-testid="cancel-render"
          >
            Cancel render
          </Button>
          {cancel.isError && (
            <StatusBanner
              tone="critical"
              title="Could not cancel"
              description={toUiError(cancel.error).message}
            />
          )}
        </div>
      )}
      {jobId && job.data?.state === 'cancelled' && (
        <StatusBanner
          tone="neutral"
          title="Render cancelled"
          description="The render was stopped before it finished; nothing was exported."
          actions={
            <Button size="sm" onClick={start}>
              Render again
            </Button>
          }
        />
      )}
      {jobId && job.data?.state === 'failed' && (
        <StatusBanner
          tone="critical"
          title="Render failed"
          description={job.data.error ?? 'The render worker could not finish.'}
          actions={
            <Button size="sm" onClick={start} data-testid="retry-render">
              Retry
            </Button>
          }
        />
      )}
      {jobId && ready && job.data && (
        <div className="flex flex-col gap-2" data-testid="render-ready">
          <StatusBanner
            tone="good"
            title="Video ready"
            description="This export is what review and publishing bind to (by its hash). Keep editing; render again for a new export."
          />
          {job.data.exports.map((e) => {
            const m = media.data?.items.find((x) => x.exportId === e.id);
            return (
              <div key={e.id} className="flex flex-col gap-1 text-sm">
                {m && (
                  <VideoPlayer
                    src={m.url}
                    poster={m.posterUrl}
                    captions={m.captionsUrl}
                    label={`Rendered video: ${title}`}
                    width={e.width}
                    height={e.height}
                  />
                )}
                <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span>
                    {e.width}×{e.height} · {e.durationMs ? mediaClock(e.durationMs) : ''} · {e.fps ?? ''} fps
                    · {Math.round((e.bytes / 1024 / 1024) * 10) / 10} MB
                  </span>
                  <code className="text-xs">{e.contentHash.slice(0, 12)}…</code>
                  {!e.validation.ok && <Badge tone="warning">Checks found issues</Badge>}
                </p>
                {m && (
                  <p className="flex flex-wrap gap-2">
                    <a
                      className="underline underline-offset-2"
                      href={m.url}
                      download={`${title}.mp4`}
                      data-testid="download-export"
                    >
                      Download MP4
                    </a>
                    {m.captionsUrl && (
                      <a
                        className="underline underline-offset-2"
                        href={m.captionsUrl}
                        download={`${title}.vtt`}
                      >
                        Download captions (WebVTT)
                      </a>
                    )}
                    <a className="underline underline-offset-2" href={m.url} target="_blank" rel="noreferrer">
                      Open in a new tab
                    </a>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!jobId && !request.isError && (
        <EmptyState
          title="Not rendered yet"
          description="The video is rendered by the worker from the committed revision; it takes about as long as the video plays."
          className="py-4"
        />
      )}
    </div>
  );
}
