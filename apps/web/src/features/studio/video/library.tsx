import { useState } from 'react';
import { Link } from 'react-router';
import { IMAGE_CREATIVE_KINDS, type AssetKind } from '@oremedia/contracts/assets';
import type { VideoMediaInfo } from '@oremedia/contracts/video';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner } from '@oremedia/ui';
import { LoadMore } from '../../../components/load-more';
import { RequestError } from '../../../components/request-state';
import { Select } from '../../../components/select';
import { AssetThumb } from '../../assets/asset-thumb';
import { acceptFor, mediaClock, rejectionText } from '../../assets/media';
import { useAssetSearch, type AssetRefDto } from '../../assets/use-assets';
import { useAssetUpload } from '../../assets/use-upload';
import { brandPath, useBrandContext } from '../../brand/brand-context';

type LibraryKind = 'video' | 'audio' | 'image';
const KINDS: Record<LibraryKind, { label: string; kinds: readonly AssetKind[] }> = {
  video: { label: 'Video', kinds: ['video'] },
  audio: { label: 'Audio', kinds: ['audio'] },
  image: { label: 'Images', kinds: IMAGE_CREATIVE_KINDS },
};

/** What the editor knows of a library asset before its first save (the server describes it after). */
export function mediaOfAsset(a: AssetRefDto): VideoMediaInfo {
  const kind = a.kind === 'video' ? 'video' : a.kind === 'audio' ? 'audio' : 'image';
  return {
    assetVersionId: a.assetVersionId,
    kind,
    mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
    durationMs: a.durationMs ?? null,
    width: a.width,
    height: a.height,
    // Unknown until saved; the server's description replaces this after the next save.
    hasAudio: kind !== 'image',
    derivatives: kind === 'image' ? ['web'] : ['proxy', 'strip', 'strip_map', 'waveform'],
  };
}

export interface LibraryProps {
  readOnly: boolean;
  /** Set while the selected clip is waiting for a replacement source. */
  replacing: { label: string; kind: 'video' | 'audio' } | null;
  onPick: (asset: AssetRefDto) => void;
}

/**
 * The brand's eligible video, audio and images (approved, with usage rights for creative use; spec 9.2): a pick
 * adds the asset at the playhead (or replaces the selected clip's source), and an upload goes through the asset
 * library's ingest (processing makes the editing proxy, strip and waveform the timeline uses).
 */
export function Library({ readOnly, replacing, onPick }: LibraryProps) {
  const { brandId } = useBrandContext();
  const [kind, setKind] = useState<LibraryKind>(replacing?.kind === 'audio' ? 'audio' : 'video');
  const [query, setQuery] = useState('');
  const search = useAssetSearch(brandId, 'creative', query, KINDS[kind].kinds);
  return (
    <div className="flex flex-col gap-2" data-testid="video-library">
      <div role="tablist" aria-label="Library kind" className="flex gap-1">
        {(Object.keys(KINDS) as LibraryKind[]).map((k) => (
          <Button
            key={k}
            size="sm"
            variant={k === kind ? 'primary' : 'ghost'}
            role="tab"
            aria-selected={k === kind}
            onClick={() => setKind(k)}
          >
            {KINDS[k].label}
          </Button>
        ))}
      </div>
      <Input
        aria-label="Search the library"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-8"
      />
      <p className="text-xs text-muted-foreground" role="status">
        {replacing
          ? `Choosing an asset replaces the source of ${replacing.label}.`
          : 'Choosing an asset adds it at the playhead.'}
      </p>
      {search.isPending && <Skeleton label="Loading the library" lines={2} />}
      {search.isError && <RequestError error={search.error} onRetry={() => void search.refetch()} />}
      {search.isSuccess && search.items.length === 0 && (
        <EmptyState
          title={`No eligible ${KINDS[kind].label.toLowerCase()}`}
          description="Approved assets with usage rights for creative use appear here. Upload below, then approve and record rights in the asset library."
        />
      )}
      {search.isSuccess && search.items.length > 0 && (
        <ul className="grid grid-cols-2 gap-1" aria-label={`Eligible ${KINDS[kind].label.toLowerCase()}`}>
          {search.items.map((a) => (
            <li key={a.assetVersionId}>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => onPick(a)}
                aria-label={`${replacing ? 'Use' : 'Add'} ${a.altText ?? a.kind}${a.durationMs ? `, ${mediaClock(a.durationMs)}` : ''}`}
                className="flex w-full flex-col gap-0.5 rounded-md border border-border p-0.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                data-testid="library-item"
              >
                <AssetThumb
                  assetVersionId={a.assetVersionId}
                  alt={a.altText ?? a.kind}
                  className="aspect-video w-full rounded-sm"
                />
                <span className="flex items-center gap-1">
                  <Badge glyph={false}>{a.kind}</Badge>
                  {a.durationMs ? (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {mediaClock(a.durationMs)}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {search.isSuccess && (
        <LoadMore
          shown={search.items.length}
          hasNextPage={search.hasNextPage}
          isFetchingNextPage={search.isFetchingNextPage}
          onLoadMore={() => void search.fetchNextPage()}
          noun="assets"
          className="px-0"
        />
      )}
      <Upload readOnly={readOnly} />
    </div>
  );
}

function Upload({ readOnly }: { readOnly: boolean }) {
  const { companyId, brandId } = useBrandContext();
  const upload = useAssetUpload(brandId);
  const [kind, setKind] = useState<'video' | 'audio' | 'photo'>('video');
  const [file, setFile] = useState<File | null>(null);
  const step = upload.step;
  return (
    <details className="rounded-md border border-border p-2">
      <summary className="cursor-pointer text-sm font-medium">Upload video, audio or an image</summary>
      <div className="mt-2 flex flex-col gap-2">
        <Field label="Kind" htmlFor="video-upload-kind">
          <Select
            id="video-upload-kind"
            value={kind}
            onValueChange={(v) => setKind(v as typeof kind)}
            options={[
              { value: 'video', label: 'Video' },
              { value: 'audio', label: 'Audio' },
              { value: 'photo', label: 'Image' },
            ]}
          />
        </Field>
        <Field label="File" htmlFor="video-upload-file">
          <Input
            id="video-upload-file"
            type="file"
            accept={acceptFor(kind)}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Button
          size="sm"
          disabledReason={
            readOnly
              ? 'Read only'
              : !file
                ? 'Choose a file first'
                : upload.pending || step.kind === 'queued'
                  ? 'Uploading…'
                  : undefined
          }
          onClick={() => file && upload.upload(file, kind)}
        >
          Upload
        </Button>
        <div role="status" aria-live="polite" className="text-xs">
          {step.kind === 'uploading' && `Uploading ${step.name}…`}
          {step.kind === 'queued' &&
            'Processing: making the poster, thumbnail strip, editing proxy and waveform. This can take a few minutes.'}
          {step.kind === 'accepted' && (
            <StatusBanner
              tone="good"
              title="Uploaded"
              description="It appears here once it is approved with usage rights for creative use."
              actions={
                <Button asChild size="sm">
                  <Link to={brandPath(companyId, brandId, 'assets')}>Open the asset library</Link>
                </Button>
              }
            />
          )}
          {step.kind === 'rejected' && (
            <StatusBanner
              tone="critical"
              title="Not accepted"
              description={`${rejectionText(step.reason)}${step.detail ? ` (${step.detail})` : ''}`}
            />
          )}
          {step.kind === 'failed' && (
            <StatusBanner tone="critical" title="Upload failed" description={step.message} />
          )}
          {step.kind === 'unsettled' && (
            <StatusBanner tone="warning" title="Still processing" description={step.message} />
          )}
        </div>
      </div>
    </details>
  );
}
