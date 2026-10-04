import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, StatusBanner } from '@oremedia/ui';
import { toUiError } from '../../../lib/errors';
import { mutationIntent, useIntentKey } from '../../../lib/intent-key';
import { useTRPC } from '../../../lib/trpc';
import { jobStatusText, type VideoAiJobDto } from './use-video-ai';

/**
 * A video AI job's state for the person: progress (announced through a live region), cancel while it runs, retry
 * after a failure or a cancel, the cost so far. The job keeps running if the page is closed; the panel reattaches.
 */
export function VideoAiJobStatus({ job }: { job: VideoAiJobDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const cancelKey = useIntentKey();
  const retryKey = useIntentKey();
  const refresh = () => {
    void queryClient.invalidateQueries(trpc.creative.videoAi.pathFilter());
  };
  const cancel = useMutation(
    trpc.creative.videoAi.cancel.mutationOptions({
      ...mutationIntent(cancelKey.key),
      onSuccess: () => {
        cancelKey.renew();
        refresh();
      },
    }),
  );
  const retry = useMutation(
    trpc.creative.videoAi.retry.mutationOptions({
      ...mutationIntent(retryKey.key),
      onSuccess: () => {
        retryKey.renew();
        refresh();
      },
    }),
  );
  const error = cancel.error ?? retry.error;
  return (
    <div className="flex flex-col gap-2" data-testid={`video-job-${job.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        {job.live && (
          <progress
            className="h-2 w-32"
            max={100}
            value={job.progress}
            aria-label={`${job.kind === 'storyboard' ? 'Storyboard' : 'Change'} progress`}
          />
        )}
        <p className="text-sm" role="status" aria-live="polite" data-testid="video-job-status">
          {jobStatusText(job)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {job.live && job.state !== 'saving' && (
          <Button
            size="sm"
            onClick={() => cancel.mutate({ jobId: job.id, expectedVersion: job.version })}
            disabled={cancel.isPending}
            data-testid="cancel-video-job"
          >
            Cancel
          </Button>
        )}
        {(job.state === 'failed' || job.state === 'cancelled') && (
          <Button
            size="sm"
            onClick={() => retry.mutate({ jobId: job.id, expectedVersion: job.version })}
            disabled={retry.isPending}
            data-testid="retry-video-job"
          >
            Try again
          </Button>
        )}
        {job.costSpentMicros > 0 && (
          <span className="self-center text-xs text-muted-foreground">
            Cost so far {(job.costSpentMicros / 1_000_000).toFixed(2)} credits
          </span>
        )}
      </div>
      {error && (
        <StatusBanner tone="critical" title="That did not work" description={toUiError(error).message} />
      )}
    </div>
  );
}
