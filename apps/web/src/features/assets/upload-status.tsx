import { StatusBanner } from '@oremedia/ui';
import type { UploadStep } from './use-upload';

/**
 * Where an upload stands, as one banner: uploading, processing, ready, or why ingest refused the file. A refusal shows
 * what was wrong and what to do (BSC-2: an unsafe SVG names what to remove), with the reason code kept for support.
 */
export function UploadStatus({ step }: { step: UploadStep }) {
  if (step.kind === 'uploading') return <StatusBanner tone="info" busy title={`Uploading ${step.name}`} />;
  if (step.kind === 'queued')
    return (
      <StatusBanner
        tone="info"
        title="Processing"
        description="Scanning and preparing the file. It appears below within a minute; use Refresh if it has not."
      />
    );
  if (step.kind === 'accepted')
    return (
      <StatusBanner
        tone="good"
        title="Ready"
        description={`Ingested as asset ${step.assetId}; it is listed below.`}
        data-testid="upload-accepted"
      />
    );
  if (step.kind === 'unsettled')
    return <StatusBanner tone="warning" title="Outcome not known yet" description={step.message} />;
  if (step.kind === 'rejected') return <UploadRejected step={step} />;
  if (step.kind === 'failed')
    return (
      <StatusBanner
        tone="critical"
        title="Upload not accepted"
        description={[step.message, ...step.details].join(' · ')}
      />
    );
  return null;
}

/** Ingest refused the file: the explanation when the server gave one, the reason code either way. */
export function UploadRejected({ step }: { step: Extract<UploadStep, { kind: 'rejected' }> }) {
  return (
    <StatusBanner
      tone="critical"
      title="Rejected at ingest"
      description={
        <>
          {step.message ?? `The file was not catalogued: ${step.reason.replaceAll('_', ' ')}.`}{' '}
          <span className="text-xs text-muted-foreground">(reason: {step.reason})</span>
        </>
      }
      data-testid="upload-rejected"
    />
  );
}
