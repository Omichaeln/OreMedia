import { useState, type ChangeEvent } from 'react';
import { AssetKind, AssetPurpose, type AssetPurpose as AssetPurposeT } from '@oremedia/contracts/assets';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner, cn, type Tone } from '@oremedia/ui';
import { LoadMore } from '../../../../../../components/load-more';
import { RequestError } from '../../../../../../components/request-state';
import { Drawer, DrawerContent, DrawerTrigger } from '../../../../../../components/drawer';
import { Select } from '../../../../../../components/select';
import { useBrandContext } from '../../../../../../features/brand/brand-context';
import { AssetThumb } from '../../../../../../features/assets/asset-thumb';
import { AssetActions } from '../../../../../../features/assets/asset-actions';
import { RIGHTS_ATTENTION_DAYS } from '@oremedia/contracts/assets';
import {
  ASSET_ISSUE_TEXT,
  useAsset,
  useAssetList,
  useAssetSearch,
  type AssetDto,
  type AssetIssueDto,
  type AssetListFilter,
} from '../../../../../../features/assets/use-assets';
import { useAssetUpload } from '../../../../../../features/assets/use-upload';
import { toUiError } from '../../../../../../lib/errors';

const PURPOSE_LABEL: Record<AssetPurposeT, string> = {
  creative: 'Creative',
  logo: 'Logos',
  font: 'Fonts',
  reference: 'Reference',
};

/** The librarian's filters over every asset (spec 21.2): what needs a person, what is waiting, what is gone. */
const LIST_FILTERS: Array<{ key: string; label: string; filter: AssetListFilter }> = [
  { key: 'all', label: 'All', filter: {} },
  { key: 'attention', label: 'Needs attention', filter: { needsAttention: true } },
  { key: 'pending', label: 'Pending review', filter: { state: 'pending_review' } },
  { key: 'retired', label: 'Retired', filter: { state: 'retired' } },
];

/**
 * Spec 21.2 asset library states (processing; restricted; expired rights; missing rights; duplicate; retired) in
 * the prototype's layout: search and upload in the header, one chip per eligibility purpose, the eligible assets as
 * a grid, and an asset's state, rights and versions in a side sheet. Search returns eligible assets only; "All
 * assets" is the librarian's view (assets.list) where every asset appears with the issues that keep it out, so
 * nothing needs a pasted id (UX-05).
 */
export function AssetLibraryRoute() {
  const { brandId, brand } = useBrandContext();
  const [view, setView] = useState<'eligible' | 'all'>('eligible');
  const [purpose, setPurpose] = useState<AssetPurposeT>('creative');
  const [listFilter, setListFilter] = useState('all');
  const [text, setText] = useState('');
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const timeZone = brand.timezone || 'UTC';

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose">
          <h1 className="text-xl font-semibold">Assets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rights are tracked per version. Only approved assets with valid rights for the purpose reach the
            studio and agents.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Search assets"
            placeholder="Search assets"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-9 w-48"
          />
          <Drawer open={uploading} onOpenChange={setUploading}>
            <DrawerTrigger asChild>
              <Button variant="primary">Upload</Button>
            </DrawerTrigger>
            <DrawerContent
              title="Upload an asset"
              side="right"
              className="w-[min(92vw,26rem)] overflow-y-auto p-5"
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
      </header>
      <div role="group" aria-label="View" className="flex flex-wrap items-center gap-1.5">
        {(
          [
            ['eligible', 'Eligible assets'],
            ['all', 'All assets'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              view === v
                ? 'border-foreground bg-secondary font-medium'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'eligible' ? (
        <EligibleGrid
          brandId={brandId}
          purpose={purpose}
          onPurpose={setPurpose}
          text={text}
          onInspect={setInspectId}
        />
      ) : (
        <AllAssets
          brandId={brandId}
          filterKey={listFilter}
          onFilter={setListFilter}
          text={text}
          onInspect={setInspectId}
        />
      )}
      <Drawer open={inspectId !== null} onOpenChange={(open) => !open && setInspectId(null)}>
        <DrawerContent title="Asset" side="right" className="w-[min(92vw,28rem)] overflow-y-auto p-5">
          {inspectId && <Inspect assetId={inspectId} timeZone={timeZone} />}
        </DrawerContent>
      </Drawer>
    </main>
  );
}

function PurposeChips({
  purpose,
  onPurpose,
}: {
  purpose: AssetPurposeT;
  onPurpose: (p: AssetPurposeT) => void;
}) {
  return (
    <div role="group" aria-label="Eligible for" className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-muted-foreground">Eligible for</span>
      {AssetPurpose.options.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={purpose === p}
          onClick={() => onPurpose(p)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            purpose === p
              ? 'border-foreground bg-secondary font-medium'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {PURPOSE_LABEL[p]}
        </button>
      ))}
    </div>
  );
}

/** Spec 9.2: the eligibility search per purpose; ineligible assets never appear here. */
function EligibleGrid({
  brandId,
  purpose,
  onPurpose,
  text,
  onInspect,
}: {
  brandId: string;
  purpose: AssetPurposeT;
  onPurpose: (p: AssetPurposeT) => void;
  text: string;
  onInspect: (assetId: string) => void;
}) {
  const search = useAssetSearch(brandId, purpose, text);
  return (
    <>
      <PurposeChips purpose={purpose} onPurpose={onPurpose} />
      {search.isPending && <Skeleton label="Loading assets" lines={3} />}
      {search.isError && (
        <RequestError error={search.error} onRetry={() => void search.refetch()} title="Restricted access" />
      )}
      {search.isSuccess && search.items.length === 0 && (
        <EmptyState
          title="No eligible assets"
          description={`Nothing approved with rights permitting ${purpose} use. Upload assets or record their usage rights; "All assets" shows what is waiting.`}
        />
      )}
      {search.isSuccess && search.items.length > 0 && (
        <ul
          className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
          aria-label="Eligible assets"
        >
          {search.items.map((a) => (
            <li key={a.assetVersionId}>
              <button
                type="button"
                className="flex w-full flex-col gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onInspect(a.assetId)}
                aria-label={`Inspect ${a.altText ?? a.kind} ${a.assetId}`}
              >
                <AssetThumb
                  assetVersionId={a.assetVersionId}
                  alt={a.altText ?? a.kind}
                  className="aspect-square w-full rounded-md border border-border bg-muted object-cover hover:opacity-90"
                />
                <span className="truncate text-sm">{a.altText || a.kind}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {a.kind}
                  {a.width && a.height ? ` · ${a.width}×${a.height}` : ''}
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
  onFilter,
  text,
  onInspect,
}: {
  brandId: string;
  filterKey: string;
  onFilter: (key: string) => void;
  text: string;
  onInspect: (assetId: string) => void;
}) {
  const filter = LIST_FILTERS.find((f) => f.key === filterKey) ?? { key: 'all', label: 'All', filter: {} };
  const list = useAssetList(brandId, { ...filter.filter, ...(text ? { query: text } : {}) });
  return (
    <>
      <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Show</span>
        {LIST_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filterKey === f.key}
            onClick={() => onFilter(f.key)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              filterKey === f.key
                ? 'border-foreground bg-secondary font-medium'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
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
      {list.isSuccess && list.items.length > 0 && (
        <ul className="divide-y divide-border" aria-label="All assets" data-testid="asset-list">
          {list.items.map((a) => (
            <li key={a.id} className="py-2" data-testid={`asset-${a.id}`}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onInspect(a.id)}
                aria-label={`Inspect ${a.name}`}
              >
                {a.currentVersion ? (
                  <AssetThumb
                    assetVersionId={a.currentVersion.id}
                    alt={a.currentVersion.altText ?? a.name}
                    className="h-12 w-12 shrink-0 rounded-md border border-border bg-muted object-cover"
                  />
                ) : (
                  <span
                    className="h-12 w-12 shrink-0 rounded-md border border-dashed border-border"
                    aria-hidden
                  />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-medium">{a.name}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-muted-foreground">{a.kind}</span>
                    {a.issues.length === 0 && <Badge tone="good">Usable</Badge>}
                    {a.issues.map((issue) => (
                      <Badge
                        key={issue}
                        tone={
                          issue === 'rights_expired' || issue === 'rejected'
                            ? 'critical'
                            : issue === 'retired'
                              ? 'neutral'
                              : issue === 'pending_review'
                                ? 'info'
                                : 'warning'
                        }
                      >
                        {ASSET_ISSUE_TEXT[issue].label}
                      </Badge>
                    ))}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.isSuccess && (
        <LoadMore
          shown={list.items.length}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          noun={list.items.length === 1 ? 'asset' : 'assets'}
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

const ISSUE_TONE: Record<AssetIssueDto, Tone> = {
  pending_review: 'info',
  rejected: 'critical',
  retired: 'neutral',
  rights_unknown: 'warning',
  rights_expired: 'critical',
  rights_expiring: 'warning',
  no_version: 'warning',
};

/**
 * The issues the server derives for the list (assetIssues), re-derived for the inspector from the asset DTO with the
 * same words (ASSET_ISSUE_TEXT), so a row flagged "Rights expiring" opens to the same chip; colour is never the only
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

function Inspect({ assetId, timeZone }: { assetId: string; timeZone: string }) {
  const asset = useAsset(assetId);
  return (
    <section aria-label="Asset detail" className="flex flex-col gap-3">
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
      {asset.isSuccess && (
        <div className="flex flex-col gap-3 text-sm" aria-live="polite">
          <div className="flex items-center gap-3">
            {asset.data.currentVersion && (
              <AssetThumb
                assetVersionId={asset.data.currentVersion.id}
                alt={asset.data.name}
                className="h-20 w-20 rounded-md"
              />
            )}
            <div>
              <p className="font-medium">{asset.data.name}</p>
              <p className="text-muted-foreground">
                {asset.data.kind}
                {asset.data.semanticRole ? ` · ${asset.data.semanticRole}` : ''}
              </p>
            </div>
          </div>
          <ul className="flex flex-col gap-1">
            {assetStatuses(asset.data).map((s) => (
              <li key={s.label} className="flex items-start gap-2">
                <Badge tone={s.tone}>{s.label}</Badge>
                <span className="text-muted-foreground">{s.detail}</span>
              </li>
            ))}
          </ul>
          {asset.data.currentVersion && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Version</dt>
              <dd>{asset.data.currentVersion.number}</dd>
              <dt className="text-muted-foreground">Hash</dt>
              <dd>
                <code>{asset.data.currentVersion.contentHash.slice(0, 16)}…</code>
              </dd>
              <dt className="text-muted-foreground">Provenance</dt>
              <dd>{asset.data.currentVersion.provenance.kind}</dd>
            </dl>
          )}
          <AssetActions key={asset.data.id} asset={asset.data} timeZone={timeZone} />
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
      <h2 id="upload-title" className="text-base font-semibold">
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
        <Field
          label="File"
          htmlFor="upload-file"
          hint="Images, SVG, fonts and PDF; archives are rejected. Video and audio processing arrives in Release 2."
        >
          <input id="upload-file" type="file" onChange={onFile} disabled={pending} className="text-sm" />
        </Field>
        {step.kind === 'uploading' && <StatusBanner tone="info" busy title={`Uploading ${step.name}`} />}
        {step.kind === 'queued' && (
          <StatusBanner
            tone="info"
            busy
            title="Processing"
            description={`Upload accepted (intent ${step.intentId}). Scanning, sanitising, hashing and derivatives run in the ingest workflow; this updates when it settles.`}
            data-testid="upload-queued"
          />
        )}
        {step.kind === 'accepted' && (
          <StatusBanner
            tone="good"
            title="Ready"
            description={`Ingested as asset ${step.assetId}. It is listed under All assets (approved, or pending review for someone without asset.approve).`}
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
        {step.kind === 'rejected' && (
          <StatusBanner
            tone="critical"
            title="Rejected at ingest"
            description={`The file was not catalogued: ${step.reason}. A duplicate of an existing asset names that asset; an unsafe or unrecognised file names the check that failed.`}
            data-testid="upload-rejected"
          />
        )}
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
