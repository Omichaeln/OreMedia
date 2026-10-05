import { useState, type ChangeEvent, type ReactNode } from 'react';
import { AssetKind, AssetPurpose, type AssetPurpose as AssetPurposeT } from '@oremedia/contracts/assets';
import {
  Button,
  Chip,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Skeleton,
  StatusBanner,
  StatusDot,
  cn,
  toneGlyph,
  type Tone,
} from '@oremedia/ui';
import { LoadMore } from '../../../../../../components/load-more';
import { RequestError } from '../../../../../../components/request-state';
import { DialogClose } from '../../../../../../components/dialog';
import { Drawer, DrawerContent, DrawerTrigger } from '../../../../../../components/drawer';
import { Select } from '../../../../../../components/select';
import { useBrandContext } from '../../../../../../features/brand/brand-context';
import { AssetThumb } from '../../../../../../features/assets/asset-thumb';
import { AssetActions } from '../../../../../../features/assets/asset-actions';
import { RIGHTS_ATTENTION_DAYS } from '@oremedia/contracts/assets';
import {
  ALL_ASSET_CHIP,
  ASSET_ISSUE_TEXT,
  ASSET_LIST_CHIPS,
  ISSUE_TONE,
  cardState,
  useAsset,
  useAssetList,
  useAssetSearch,
  useAssetUsages,
  useAssetVersions,
  type AssetDto,
  type AssetIssueDto,
} from '../../../../../../features/assets/use-assets';
import { useAssetUpload } from '../../../../../../features/assets/use-upload';
import {
  acceptFor,
  formatBytes,
  isTimeBased,
  mediaClock,
  uploadHint,
} from '../../../../../../features/assets/media';
import { AudioPlayer, VideoPlayer } from '../../../../../../features/assets/media-player';
import { useSignedUrl } from '../../../../../../features/assets/use-assets';
import { UploadRejected } from '../../../../../../features/assets/upload-status';
import { toUiError } from '../../../../../../lib/errors';

const PURPOSE_LABEL: Record<AssetPurposeT, string> = {
  creative: 'Creative',
  logo: 'Logos',
  font: 'Fonts',
  reference: 'Reference',
};

type Shown = { kind: 'list'; key: string } | { kind: 'eligible'; purpose: AssetPurposeT };

/**
 * Spec 21.2 asset library in the supplied interface's form: the heading with search and Upload, one row of filter
 * chips, a card grid (hatched placeholder, "kind · tag" inside the frame, the name, a dot and the rights state) and
 * the asset's inspector as a right drawer. The chips are two groups: the states (assets.list, the librarian's view
 * where every asset appears with the issues that keep it out) and "Eligible for" (assets.search, spec 9.2: only
 * assets usable for that purpose), so nothing needs a pasted id (UX-05).
 */
export function AssetLibraryRoute() {
  const { brandId, brand } = useBrandContext();
  const [shown, setShown] = useState<Shown>({ kind: 'list', key: 'all' });
  const [text, setText] = useState('');
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const timeZone = brand.timezone || 'UTC';

  return (
    <main
      id="main"
      className="om-fade flex w-full min-w-0 flex-col gap-5 px-4 py-8 sm:px-9 sm:pb-20 sm:pt-10"
    >
      <PageHeader
        title="Assets"
        description="Rights are tracked per version. Only approved assets with valid rights reach the studio and agents."
        actions={
          <div className="flex items-center gap-2">
            <Input
              aria-label="Search assets"
              placeholder="Search assets"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-60 max-w-full"
            />
            <Drawer open={uploading} onOpenChange={setUploading}>
              <DrawerTrigger asChild>
                <Button variant="primary">Upload</Button>
              </DrawerTrigger>
              <DrawerContent
                title="Upload an asset"
                side="right"
                className="w-[min(92vw,26rem)] overflow-y-auto p-6"
              >
                <Upload
                  onAccepted={(assetId) => {
                    setUploading(false);
                    setInspectId(assetId);
                  }}
                />
              </DrawerContent>
            </Drawer>
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1">
          {ASSET_LIST_CHIPS.map((f) => (
            <Chip
              key={f.key}
              selected={shown.kind === 'list' && shown.key === f.key}
              onClick={() => setShown({ kind: 'list', key: f.key })}
            >
              {f.label}
            </Chip>
          ))}
        </div>
        <span aria-hidden="true" className="hidden h-4 w-px bg-border lg:inline-block" />
        <div role="group" aria-label="Eligible for" className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">Eligible for</span>
          {AssetPurpose.options.map((p) => (
            <Chip
              key={p}
              selected={shown.kind === 'eligible' && shown.purpose === p}
              onClick={() => setShown({ kind: 'eligible', purpose: p })}
            >
              {PURPOSE_LABEL[p]}
            </Chip>
          ))}
        </div>
      </div>
      {shown.kind === 'eligible' ? (
        <EligibleGrid
          brandId={brandId}
          purpose={shown.purpose}
          text={text}
          selectedId={inspectId}
          onInspect={setInspectId}
        />
      ) : (
        <AllAssets
          brandId={brandId}
          filterKey={shown.key}
          text={text}
          selectedId={inspectId}
          onInspect={setInspectId}
        />
      )}
      <Drawer open={inspectId !== null} onOpenChange={(open) => !open && setInspectId(null)}>
        <DrawerContent title="Asset" side="right" className="w-[min(92vw,340px)] overflow-y-auto">
          {inspectId && <Inspect assetId={inspectId} timeZone={timeZone} />}
        </DrawerContent>
      </Drawer>
    </main>
  );
}

interface AssetCardProps {
  /** The version whose thumbnail is shown; null shows the hatched placeholder. */
  versionId: string | null;
  name: string;
  /** "kind · tag" inside the frame: the role, the dimensions or the duration. */
  caption: ReactNode;
  tone: Tone;
  stateLabel: ReactNode;
  selected: boolean;
  /** Retired assets are dimmed (the frame only, so the words keep their contrast). */
  dimmed?: boolean;
  index: number;
  onClick: () => void;
}

/** One card of the grid as the interface draws it: a 4:5 frame, the caption in its corner, the name, dot and state. */
function AssetCard({
  versionId,
  name,
  caption,
  tone,
  stateLabel,
  selected,
  dimmed,
  index,
  onClick,
}: AssetCardProps) {
  return (
    <button
      type="button"
      className="om-in flex w-full flex-col gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      onClick={onClick}
      aria-label={`Inspect ${name}`}
      aria-current={selected ? 'true' : undefined}
    >
      <span
        className={cn(
          'om-stripes relative flex aspect-[4/5] w-full items-end overflow-hidden rounded-lg p-2.5',
          selected && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
          dimmed && 'opacity-50',
        )}
      >
        {versionId && (
          <AssetThumb
            assetVersionId={versionId}
            alt={name}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <span
          className={cn(
            'relative text-2xs tabular-nums text-muted-foreground',
            versionId && 'rounded-md bg-card/90 px-1.5 py-0.5',
          )}
        >
          {caption}
        </span>
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="truncate text-sm">{name}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone={tone} size="sm" />
          <span className="sr-only">{toneGlyph[tone]} </span>
          <span className="truncate">{stateLabel}</span>
        </span>
      </span>
    </button>
  );
}

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-[18px]';

/** Spec 9.2: the eligibility search per purpose; ineligible assets never appear here. */
function EligibleGrid({
  brandId,
  purpose,
  text,
  selectedId,
  onInspect,
}: {
  brandId: string;
  purpose: AssetPurposeT;
  text: string;
  selectedId: string | null;
  onInspect: (assetId: string) => void;
}) {
  const search = useAssetSearch(brandId, purpose, text);
  return (
    <>
      {search.isPending && <Skeleton label="Loading assets" lines={3} />}
      {search.isError && (
        <RequestError error={search.error} onRetry={() => void search.refetch()} title="Restricted access" />
      )}
      {search.isSuccess && search.items.length === 0 && (
        <EmptyState
          title="No eligible assets"
          description={`Nothing approved with rights permitting ${purpose} use. Upload assets or record their usage rights; "All" shows what is waiting.`}
        />
      )}
      {search.isSuccess && search.items.length > 0 && (
        <ul className={GRID} aria-label="Eligible assets">
          {search.items.map((a, i) => (
            <li key={a.assetVersionId} className="min-w-0">
              <AssetCard
                index={i}
                versionId={a.assetVersionId}
                name={a.altText || a.kind}
                caption={
                  <>
                    {a.kind}
                    {a.width && a.height ? ` · ${a.width}×${a.height}` : ''}
                    {a.durationMs ? ` · ${mediaClock(a.durationMs)}` : ''}
                  </>
                }
                tone="good"
                stateLabel={`Eligible · ${PURPOSE_LABEL[purpose].toLowerCase()}`}
                selected={selectedId === a.assetId}
                onClick={() => onInspect(a.assetId)}
              />
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
          noun={search.items.length === 1 ? 'asset' : 'assets'}
          className="px-0"
        />
      )}
    </>
  );
}

/** Spec 21.2: every asset with its issues named, so what is waiting or expiring is found here, not by id (UX-05). */
function AllAssets({
  brandId,
  filterKey,
  text,
  selectedId,
  onInspect,
}: {
  brandId: string;
  filterKey: string;
  text: string;
  selectedId: string | null;
  onInspect: (assetId: string) => void;
}) {
  const filter = ASSET_LIST_CHIPS.find((f) => f.key === filterKey) ?? ALL_ASSET_CHIP;
  const list = useAssetList(brandId, { ...filter.filter, ...(text ? { query: text } : {}) });
  const kept = filter.keep && list.isSuccess ? list.items.filter(filter.keep) : list.items;
  return (
    <>
      {list.isPending && <Skeleton label="Loading assets" lines={3} />}
      {list.isError && (
        <RequestError error={list.error} onRetry={() => void list.refetch()} title="Restricted access" />
      )}
      {list.isSuccess && list.items.length === 0 && (
        <EmptyState
          title={filter.key === 'all' ? 'No assets yet' : `Nothing under ${filter.label.toLowerCase()}`}
          description={
            filter.key === 'all' ? 'Upload the first asset for this brand.' : 'Nothing needs you here.'
          }
        />
      )}
      {list.isSuccess && list.items.length > 0 && kept.length === 0 && (
        <EmptyState
          title={`Nothing under ${filter.label.toLowerCase()}`}
          description={`None of the ${list.items.length} assets loaded ${filter.looksFor}.${list.hasNextPage ? ' More exist; load them to check the rest.' : ''}`}
          action={
            list.hasNextPage ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            ) : undefined
          }
        />
      )}
      {list.isSuccess && kept.length > 0 && (
        <ul className={GRID} aria-label="All assets" data-testid="asset-list">
          {kept.map((a, i) => {
            const state = cardState(a.issues);
            return (
              <li key={a.id} className="min-w-0" data-testid={`asset-${a.id}`}>
                <AssetCard
                  index={i}
                  versionId={a.currentVersion?.id ?? null}
                  name={a.name}
                  caption={
                    <>
                      {a.kind}
                      {a.semanticRole
                        ? ` · ${a.semanticRole}`
                        : a.currentVersion?.width && a.currentVersion.height
                          ? ` · ${a.currentVersion.width}×${a.currentVersion.height}`
                          : ''}
                      {a.currentVersion?.durationMs ? (
                        <span data-testid="asset-duration"> · {mediaClock(a.currentVersion.durationMs)}</span>
                      ) : null}
                    </>
                  }
                  tone={state.tone}
                  stateLabel={state.label}
                  selected={selectedId === a.id}
                  dimmed={a.state === 'retired'}
                  onClick={() => onInspect(a.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
      {list.isSuccess && kept.length > 0 && (
        <LoadMore
          shown={kept.length}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          noun={
            filter.keep
              ? `of ${list.items.length} loaded ${list.items.length === 1 ? 'asset' : 'assets'}`
              : kept.length === 1
                ? 'asset'
                : 'assets'
          }
          className="px-0"
        />
      )}
    </>
  );
}

interface AssetStatus {
  tone: Tone;
  label: string;
  detail: string;
}

/**
 * The issues the server derives for the list (assetIssues), re-derived for the inspector from the asset DTO with the
 * same words (ASSET_ISSUE_TEXT), so a card flagged "Rights expiring" opens to the same state; colour is never the only
 * carrier.
 */
export function assetStatuses(a: AssetDto, now = Date.now()): AssetStatus[] {
  const issues: AssetIssueDto[] = [];
  if (a.state === 'pending_review' || a.state === 'rejected' || a.state === 'retired') issues.push(a.state);
  const expiresAt = a.rights?.expiresAt ? new Date(a.rights.expiresAt).getTime() : null;
  if (a.rightsState === 'unknown' || !a.rights) issues.push('rights_unknown');
  else if (expiresAt !== null && expiresAt < now) issues.push('rights_expired');
  else if (expiresAt !== null && expiresAt < now + RIGHTS_ATTENTION_DAYS * 86_400_000)
    issues.push('rights_expiring');
  if (!a.currentVersion) issues.push('no_version');
  const out: AssetStatus[] = issues.map((i) => ({ tone: ISSUE_TONE[i], ...ASSET_ISSUE_TEXT[i] }));
  if (a.state === 'approved')
    out.unshift({ tone: 'good', label: 'Approved', detail: 'Reviewed and approved.' });
  if (a.rights && !issues.includes('rights_expired') && !issues.includes('rights_expiring'))
    out.push({
      tone: 'good',
      label: 'Rights recorded',
      detail: expiresAt !== null ? `Valid until ${new Date(expiresAt).toLocaleDateString()}.` : 'No expiry.',
    });
  return out;
}

const scopeText = (scope: 'all' | string[]): string => (scope === 'all' ? 'All' : scope.join(', ') || '—');

const dayText = (value: string | Date, timeZone: string): string =>
  new Date(value).toLocaleDateString('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric' });

/** A row under an uppercase label in the drawer (Derivatives, Versions), as the interface rules them. */
function DrawerRow({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-t border-border py-2 text-xs">
      <span className="min-w-0 truncate">{left}</span>
      <span className="shrink-0 text-muted-foreground">{right}</span>
    </div>
  );
}

function Inspect({ assetId, timeZone }: { assetId: string; timeZone: string }) {
  const asset = useAsset(assetId);
  const versions = useAssetVersions(assetId, asset.isSuccess);
  const usages = useAssetUsages(assetId, asset.isSuccess);
  const a = asset.data;
  const statuses = a ? assetStatuses(a) : [];
  // The state line under the name: the first thing that keeps the asset out, else its good state.
  const primary = statuses.find((s) => s.tone !== 'good') ?? statuses[0];
  const current = a?.currentVersion ?? null;
  return (
    <section aria-label="Asset detail" className="flex min-h-full flex-col gap-[18px] p-6 pt-7">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          {assetId}
          {current ? ` · v${current.number}` : ''}
        </span>
        <DialogClose asChild>
          <IconButton label="Close" variant="ghost" size="sm" className="-mr-2 -mt-1.5 text-lg">
            ×
          </IconButton>
        </DialogClose>
      </div>
      {asset.isPending && <Skeleton label="Loading asset" />}
      {asset.isError && (
        <RequestError
          error={asset.error}
          onRetry={() => void asset.refetch()}
          title={
            toUiError(asset.error).kind === 'forbidden'
              ? 'Restricted: this asset is not in a brand you can see'
              : undefined
          }
        />
      )}
      {a && (
        <div className="flex flex-1 flex-col gap-[18px] text-sm" aria-live="polite">
          {current && isTimeBased(a.kind) ? (
            <MediaPreview
              kind={a.kind}
              name={a.name}
              versionId={current.id}
              hasProxy={a.derivatives.some((d) => d.purpose === 'proxy')}
              hasPoster={a.derivatives.some((d) => d.purpose === 'poster')}
            />
          ) : (
            <div className="om-stripes relative flex aspect-[4/3] items-end overflow-hidden rounded-lg p-2.5">
              {current && (
                <AssetThumb
                  assetVersionId={current.id}
                  alt={a.name}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
              <span
                className={cn(
                  'relative text-2xs tabular-nums text-muted-foreground',
                  current && 'rounded-md bg-card/90 px-1.5 py-0.5',
                )}
              >
                {a.kind}
                {a.semanticRole ? ` · ${a.semanticRole}` : ''}
              </span>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-lg font-bold">{a.name}</p>
            {primary && (
              <p className="flex items-center gap-1.5">
                <StatusDot tone={primary.tone} size="sm" />
                <span className="sr-only">{toneGlyph[primary.tone]} </span>
                {primary.label}
              </p>
            )}
          </div>
          {statuses.map((s) => (
            <div
              key={s.label}
              className={cn(
                'text-pretty rounded-lg px-3 py-2.5 text-sm',
                s.tone === 'good' ? 'bg-muted' : 'bg-accent-tint',
              )}
            >
              <span className="font-medium">{s.label}.</span> {s.detail}
            </div>
          ))}
          <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Kind</dt>
            <dd className="min-w-0">
              {a.kind}
              {current ? ` · ${formatBytes(current.bytes)}` : ''}
              {current?.width && current.height ? ` · ${current.width}×${current.height}` : ''}
            </dd>
            <dt className="text-muted-foreground">Channels</dt>
            <dd className="min-w-0">{a.rights ? scopeText(a.rights.permittedChannels) : '—'}</dd>
            <dt className="text-muted-foreground">Territory</dt>
            <dd className="min-w-0">{a.rights ? scopeText(a.rights.territories) : '—'}</dd>
            <dt className="text-muted-foreground">Rights until</dt>
            <dd className="min-w-0">
              {a.rights ? (a.rights.expiresAt ? dayText(a.rights.expiresAt, timeZone) : 'No expiry') : '—'}
            </dd>
            <dt className="text-muted-foreground">Used in</dt>
            <dd className="min-w-0">
              {usages.data
                ? `${usages.data.items.length}${usages.data.nextCursor ? '+' : ''} ${usages.data.items.length === 1 ? 'usage' : 'usages'}`
                : usages.isError
                  ? 'Not available'
                  : '…'}
            </dd>
            {current?.durationMs ? (
              <>
                <dt className="text-muted-foreground">Duration</dt>
                <dd>{mediaClock(current.durationMs)}</dd>
              </>
            ) : null}
            {current?.media?.video ? (
              <>
                <dt className="text-muted-foreground">Video</dt>
                <dd>
                  {current.media.video.codec} · {current.media.video.width}×{current.media.video.height} ·{' '}
                  {current.media.video.fps} fps
                  {current.media.video.variableFrameRate ? ' (variable)' : ''}
                </dd>
              </>
            ) : null}
            {current?.media?.audio[0] ? (
              <>
                <dt className="text-muted-foreground">Audio</dt>
                <dd>
                  {current.media.audio[0].codec} · {current.media.audio[0].channels} ch ·{' '}
                  {current.media.audio[0].sampleRate / 1000} kHz
                </dd>
              </>
            ) : null}
          </dl>
          {current && (
            <div className="flex flex-col">
              <h3 className="om-label mb-1.5">Derivatives</h3>
              <DrawerRow
                left={
                  a.derivatives.length ? a.derivatives.map((d) => d.purpose).join(' · ') : 'None recorded'
                }
                right={a.derivatives.length ? 'ready' : '—'}
              />
              <DrawerRow
                left={
                  <span className="tabular-nums">
                    sha256 {current.contentHash.slice(0, 4)}…{current.contentHash.slice(-4)}
                  </span>
                }
                right={current.provenance.kind}
              />
            </div>
          )}
          <div className="flex flex-col">
            <h3 className="om-label mb-1.5">Versions</h3>
            {versions.isPending && <Skeleton label="Loading versions" lines={1} />}
            {versions.isError && <DrawerRow left="Versions not available" right="—" />}
            {versions.data?.items.map((v) => (
              <DrawerRow
                key={v.id}
                left={`v${v.number} · ${formatBytes(v.bytes)}`}
                right={dayText(v.createdAt, timeZone)}
              />
            ))}
          </div>
          <div className="mt-auto">
            <AssetActions key={a.id} asset={a} timeZone={timeZone} />
          </div>
        </div>
      )}
    </section>
  );
}

/** Spec 9.1 upload; the ingest workflow does the rest (see useAssetUpload). */
function Upload({ onAccepted }: { onAccepted: (assetId: string) => void }) {
  const { brandId } = useBrandContext();
  const [kind, setKind] = useState<string>('photo');
  const { step, pending, upload } = useAssetUpload(brandId);
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(file, AssetKind.parse(kind));
    e.target.value = '';
  };
  return (
    <section aria-labelledby="upload-title" className="flex flex-col gap-3">
      <h2 id="upload-title" className="text-lg font-bold">
        Upload an asset
      </h2>
      <div className="flex flex-col gap-3">
        <Field label="Kind" htmlFor="upload-kind">
          <Select
            id="upload-kind"
            value={kind}
            onValueChange={setKind}
            options={AssetKind.options.map((k) => ({ value: k, label: k }))}
          />
        </Field>
        <Field label="File" htmlFor="upload-file" hint={uploadHint(AssetKind.parse(kind))}>
          <input
            id="upload-file"
            type="file"
            accept={acceptFor(AssetKind.parse(kind))}
            onChange={onFile}
            disabled={pending}
            className="text-sm"
          />
        </Field>
        {step.kind === 'uploading' && <StatusBanner tone="info" busy title={`Uploading ${step.name}`} />}
        {step.kind === 'queued' && (
          <StatusBanner
            tone="info"
            busy
            title={step.timeBased ? 'Processing video or audio' : 'Processing'}
            description={
              step.timeBased
                ? 'Upload received. Scanning, checking the file, then making the poster, thumbnail strip, editing proxy and waveform; a long video can take several minutes. You can close this sheet: the asset appears under All when it is ready.'
                : `Upload accepted (intent ${step.intentId}). Scanning, sanitising, hashing and derivatives run in the ingest workflow; this updates when it settles.`
            }
            data-testid="upload-queued"
          />
        )}
        {step.kind === 'accepted' && (
          <StatusBanner
            tone="good"
            title="Ready"
            description={`Ingested as asset ${step.assetId}. It is listed under All (approved, or pending review for someone without asset.approve).`}
            actions={
              <Button size="sm" onClick={() => onAccepted(step.assetId)}>
                Inspect
              </Button>
            }
            data-testid="upload-accepted"
          />
        )}
        {step.kind === 'unsettled' && (
          <StatusBanner
            tone="warning"
            title="Outcome not known yet"
            description={`${step.message} (intent ${step.intentId})`}
            data-testid="upload-unsettled"
          />
        )}
        {step.kind === 'rejected' && <UploadRejected step={step} />}
        {step.kind === 'failed' && (
          <StatusBanner
            tone="critical"
            title="Upload not accepted"
            description={
              <>
                {step.message}
                {step.details.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {step.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
              </>
            }
          />
        )}
      </div>
    </section>
  );
}

/**
 * STU-2a: an ingested video plays its editing proxy (720p H.264) with the poster frame; audio plays its proxy over the
 * waveform image. Both are signed through the media endpoint like any derivative.
 */
function MediaPreview({
  kind,
  name,
  versionId,
  hasProxy,
  hasPoster,
}: {
  kind: string;
  name: string;
  versionId: string;
  hasProxy: boolean;
  hasPoster: boolean;
}) {
  const proxy = useSignedUrl(hasProxy ? versionId : null, 'proxy');
  const poster = useSignedUrl(hasPoster ? versionId : null, 'poster');
  const waveform = useSignedUrl(kind === 'audio' ? versionId : null, 'preview');
  if (!hasProxy)
    return (
      <p className="text-xs text-muted-foreground">
        No playable preview for this version (it was catalogued before previews were made).
      </p>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="asset-media-preview">
      {kind === 'video' ? (
        <VideoPlayer
          src={proxy.data?.url ?? null}
          poster={poster.data?.url ?? null}
          label={`Preview of ${name}`}
        />
      ) : (
        <>
          {waveform.data?.url && (
            <img
              src={waveform.data.url}
              alt={`Waveform of ${name}`}
              className="h-16 w-full rounded-sm object-cover"
            />
          )}
          <AudioPlayer src={proxy.data?.url ?? null} label={`Preview of ${name}`} />
        </>
      )}
      {proxy.isError && (
        <p className="text-xs text-status-critical" role="status">
          The preview could not be loaded.
        </p>
      )}
    </div>
  );
}
