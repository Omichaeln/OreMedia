import { useState, type ChangeEvent } from 'react';
import { AssetKind, AssetPurpose, type AssetPurpose as AssetPurposeT } from '@oremedia/contracts/assets';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner, cn, type Tone } from '@oremedia/ui';
import { RequestError } from '../../../../../../components/request-state';
import { Drawer, DrawerContent, DrawerTrigger } from '../../../../../../components/drawer';
import { Select } from '../../../../../../components/select';
import { useBrandContext } from '../../../../../../features/brand/brand-context';
import { AssetThumb } from '../../../../../../features/assets/asset-thumb';
import { useAsset, useAssetSearch, type AssetDto } from '../../../../../../features/assets/use-assets';
import { useAssetUpload } from '../../../../../../features/assets/use-upload';
import { toUiError } from '../../../../../../lib/errors';

const PURPOSE_LABEL: Record<AssetPurposeT, string> = {
  creative: 'Creative',
  logo: 'Logos',
  font: 'Fonts',
  reference: 'Reference',
};

/**
 * Spec 21.2 asset library states (processing; restricted; expired rights; missing rights; duplicate; retired) in
 * the prototype's layout: search and upload in the header, one chip per eligibility purpose, the eligible assets as
 * a grid, and an asset's state, rights and versions in a side sheet. Search returns eligible assets only, so assets
 * that are not eligible are opened by id, with the reason.
 */
export function AssetLibraryRoute() {
  const { brandId } = useBrandContext();
  const [purpose, setPurpose] = useState<AssetPurposeT>('creative');
  const [text, setText] = useState('');
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [openId, setOpenId] = useState('');
  const search = useAssetSearch(brandId, purpose, text);

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
              <Upload />
            </DrawerContent>
          </Drawer>
        </div>
      </header>
      <div role="group" aria-label="Eligible for" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Eligible for</span>
        {AssetPurpose.options.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={purpose === p}
            onClick={() => setPurpose(p)}
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
      {search.isPending && <Skeleton label="Loading assets" lines={3} />}
      {search.isError && (
        <RequestError error={search.error} onRetry={() => void search.refetch()} title="Restricted access" />
      )}
      {search.isSuccess && search.data.items.length === 0 && (
        <EmptyState
          title="No eligible assets"
          description={`Nothing approved with rights permitting ${purpose} use. Upload assets or record their usage rights.`}
        />
      )}
      {search.isSuccess && search.data.items.length > 0 && (
        <ul
          className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
          aria-label="Eligible assets"
        >
          {search.data.items.map((a) => (
            <li key={a.assetVersionId}>
              <button
                type="button"
                className="flex w-full flex-col gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setInspectId(a.assetId)}
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
      <form
        className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (openId.trim()) setInspectId(openId.trim());
        }}
      >
        <Field
          label="Asset id"
          htmlFor="asset-id"
          className="w-64"
          hint="Not in the grid? Assets that are not eligible open by id, with the reason."
        >
          <Input
            id="asset-id"
            value={openId}
            onChange={(e) => setOpenId(e.target.value)}
            placeholder="ast_…"
          />
        </Field>
        <Button type="submit" disabled={!openId.trim()}>
          Inspect
        </Button>
      </form>
      <Drawer open={inspectId !== null} onOpenChange={(open) => !open && setInspectId(null)}>
        <DrawerContent title="Asset" side="right" className="w-[min(92vw,28rem)] overflow-y-auto p-5">
          {inspectId && <Inspect assetId={inspectId} />}
        </DrawerContent>
      </Drawer>
    </main>
  );
}

interface AssetStatus {
  tone: Tone;
  label: string;
  detail: string;
}

/** Every non-eligible condition named explicitly, with the reason; colour is never the only carrier. */
export function assetStatuses(a: AssetDto, now = Date.now()): AssetStatus[] {
  const out: AssetStatus[] = [];
  if (a.state === 'pending_review')
    out.push({ tone: 'info', label: 'Processing', detail: 'Ingested and awaiting review; not usable yet.' });
  if (a.state === 'rejected')
    out.push({ tone: 'critical', label: 'Rejected', detail: 'Rejected at review.' });
  if (a.state === 'retired')
    out.push({
      tone: 'neutral',
      label: 'Retired',
      detail: 'No longer usable in new work; existing usages are recorded.',
    });
  if (a.state === 'approved') out.push({ tone: 'good', label: 'Approved', detail: 'Reviewed and approved.' });
  if (a.rightsState === 'unknown' || !a.rights)
    out.push({
      tone: 'warning',
      label: 'Missing rights',
      detail: 'No usage rights recorded; ineligible for creative and logo use until they are.',
    });
  else if (a.rights.expiresAt && new Date(a.rights.expiresAt).getTime() < now)
    out.push({
      tone: 'critical',
      label: 'Expired rights',
      detail: `Rights expired on ${new Date(a.rights.expiresAt).toLocaleDateString()}.`,
    });
  else
    out.push({
      tone: 'good',
      label: 'Rights recorded',
      detail: a.rights.expiresAt
        ? `Valid until ${new Date(a.rights.expiresAt).toLocaleDateString()}.`
        : 'No expiry.',
    });
  if (!a.currentVersion)
    out.push({ tone: 'warning', label: 'No version', detail: 'The file has not been ingested.' });
  return out;
}

function Inspect({ assetId }: { assetId: string }) {
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
        </div>
      )}
    </section>
  );
}

/** Spec 9.1 upload; the ingest workflow does the rest (see useAssetUpload). */
function Upload() {
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
            title="Processing"
            description={`Upload accepted (intent ${step.intentId}). Scanning, sanitising, hashing and derivatives run in the ingest workflow; a duplicate of an existing asset is rejected with the existing asset id.`}
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
