import { useState, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DOWNLOAD_PNG_WIDTHS, type AssetRef } from '@oremedia/contracts/assets';
import {
  LOGO_DONTS_MAX,
  LOGO_DONT_MAX,
  LOGO_USAGE_NOTE_MAX,
  type BrandSystemDocumentV1,
  type LogoRuleV1,
  type LogoVariant,
} from '@oremedia/contracts/brand';
import { Badge, Button, EmptyState, Field, Input, Skeleton, Textarea, cn } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { useAsset, useBrandAssetsOfKind, useSignedUrl } from '../assets/use-assets';
import { useAssetUpload } from '../assets/use-upload';
import { UploadStatus } from '../assets/upload-status';
import { useBrandContext } from './brand-context';
import { useTRPC } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';

type Doc = BrandSystemDocumentV1;
type Colour = Doc['tokens']['colours'][number];

/**
 * BSC-2 logos: the brand's lock-ups as first-class files. SVG is preferred and shown as vector (the signed original in
 * an <img>, never injected into the page), PNG and WebP are accepted; each variant names its logo, the grounds it may
 * sit on, its clear space and minimum width, and written usage guidance. The editor section and the read view share
 * the previews (checkerboard for transparency, one tile per allowed ground) and the download control.
 */
export const LOGO_VARIANTS: Array<{ variant: LogoVariant; label: string; hint: string }> = [
  { variant: 'primary', label: 'Primary', hint: 'The default lock-up on light grounds.' },
  {
    variant: 'secondary',
    label: 'Secondary',
    hint: 'An alternative lock-up (stacked or horizontal) for layouts the primary does not fit.',
  },
  { variant: 'reversed', label: 'Reversed', hint: 'For dark or photographic grounds.' },
  { variant: 'mono', label: 'Mono', hint: 'Single colour, for embossing, stamps and low-ink use.' },
  {
    variant: 'mark_only',
    label: 'Mark only',
    hint: 'The symbol without the wordmark, for avatars and favicons.',
  },
];
export const LOGO_LABEL = Object.fromEntries(LOGO_VARIANTS.map((v) => [v.variant, v.label])) as Record<
  LogoVariant,
  string
>;
/** Logos upload as SVG (preferred) or a transparent PNG or WebP; ingest refuses anything else for the logo kind. */
const LOGO_ACCEPT = '.svg,.png,.webp,image/svg+xml,image/png,image/webp';
const SVG = 'image/svg+xml';

/** A neutral checkerboard: transparent parts of the artwork show as squares. */
const CHECKERBOARD: CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage:
    'linear-gradient(45deg, #d4d4d4 25%, transparent 25%), linear-gradient(-45deg, #d4d4d4 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d4d4d4 75%), linear-gradient(-45deg, transparent 75%, #d4d4d4 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
};

const aspectText = (w: number | null | undefined, h: number | null | undefined) =>
  w && h ? `${w}×${h}, ${(w / h).toFixed(2)}:1` : 'size unknown';

/** Lines of a text area as a bounded list (empty lines dropped). */
const lines = (text: string, max: number, each: number) =>
  text
    .split('\n')
    .map((l) => l.trim().slice(0, each))
    .filter(Boolean)
    .slice(0, max);

// ---- previews --------------------------------------------------------------------------------------------------

/**
 * The logo's artwork as the browser draws it: an SVG from its sanitised original (vector, crisp at any size), anything
 * else from its preview rendition. Always an <img> from a signed URL, so the file's markup never enters the page.
 */
function LogoImage({
  assetVersionId,
  mime,
  alt,
  className,
  style,
}: {
  assetVersionId: string;
  mime: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
}) {
  const url = useSignedUrl(assetVersionId, mime === SVG ? 'original' : 'preview');
  if (url.isError || (url.isSuccess && !url.data.url))
    return (
      <span role="img" aria-label={`${alt} (preview unavailable)`} className="text-xs text-muted-foreground">
        No preview
      </span>
    );
  if (!url.data) return <span aria-hidden="true" className={cn('animate-pulse bg-muted', className)} />;
  return <img src={url.data.url} alt={alt} className={cn('object-contain', className)} style={style} />;
}

/**
 * The logo on a checkerboard (transparency) with its clear space drawn around it, then on each ground the rule allows,
 * with its proportions. `assetId` is the rule's logo; the version shown is its current one.
 */
export function LogoGrounds({
  rule,
  colours,
  label,
}: {
  rule: LogoRuleV1;
  colours: Colour[];
  label: string;
}) {
  const asset = useAsset(rule.assetId);
  if (asset.isPending) return <Skeleton label="Loading logo" lines={1} />;
  if (asset.isError) return <RequestError error={asset.error} />;
  const v = asset.data.currentVersion;
  if (!v)
    return (
      <p className="text-xs text-muted-foreground">Processing: the logo appears here once it is ingested.</p>
    );
  const pad = Math.round(Math.min(2, Math.max(0, rule.clearSpaceRatio)) * 32);
  const grounds = rule.allowedBackgroundColourKeys.flatMap((k) => {
    const c = colours.find((x) => x.key === k);
    return c ? [c] : [];
  });
  const alt = `${label} logo`;
  return (
    <div className="flex flex-col gap-2" data-testid={`logo-grounds-${rule.variant}`}>
      <div className="flex flex-wrap items-start gap-2">
        <figure className="flex flex-col gap-1">
          <div
            className="flex h-28 min-w-28 items-center justify-center rounded-sm border border-border p-2"
            style={CHECKERBOARD}
          >
            <div
              className="border border-dashed border-status-info"
              style={{ padding: pad }}
              title={`Clear space ${rule.clearSpaceRatio}× the mark height`}
            >
              <LogoImage
                assetVersionId={v.id}
                mime={v.mime}
                alt={alt}
                className="block h-8 w-auto max-w-56"
              />
            </div>
          </div>
          <figcaption className="text-xs text-muted-foreground">Transparency and clear space</figcaption>
        </figure>
        {grounds.map((c) => (
          <figure key={c.key} className="flex flex-col gap-1">
            <div
              className="flex h-28 min-w-28 items-center justify-center rounded-sm border border-border p-4"
              style={{ backgroundColor: c.value }}
              data-testid="logo-ground"
            >
              <LogoImage
                assetVersionId={v.id}
                mime={v.mime}
                alt={`${alt} on ${c.key}`}
                className="block h-10 w-auto max-w-56"
              />
            </div>
            <figcaption className="text-xs text-muted-foreground">
              On <code>{c.key}</code>
            </figcaption>
          </figure>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        <Badge tone={v.mime === SVG ? 'good' : 'neutral'} glyph={false}>
          {v.mime === SVG ? 'SVG (vector)' : `${v.mime.replace('image/', '').toUpperCase()} (raster)`}
        </Badge>{' '}
        {aspectText(v.width, v.height)}
        {rule.preferredFormat === 'svg' && v.mime !== SVG && (
          <span className="ml-1 text-status-warning">
            · The brand prefers SVG for this variant: upload one to replace it.
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * Download: the original (an SVG stays vector) or a PNG at a chosen width, as an attachment from the store (BSC-2:
 * never shown inline from the app). The URL is minted on request and lives five minutes.
 */
export function LogoDownload({ assetId, label }: { assetId: string; label: string }) {
  const trpc = useTRPC();
  const asset = useAsset(assetId);
  const intent = useIntentKey();
  const [format, setFormat] = useState<string>('original');
  const [error, setError] = useState<string | null>(null);
  const download = useMutation(
    trpc.assets.media.download.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setError(null);
        const a = document.createElement('a');
        a.href = res.url;
        a.download = res.filename;
        a.rel = 'noopener';
        document.body.append(a);
        a.click();
        a.remove();
      },
      onError: (err) => {
        intent.renew();
        setError(toUiError(err).message);
      },
    }),
  );
  const v = asset.data?.currentVersion;
  if (!v) return null;
  const isSvg = v.mime === SVG;
  const options = [
    { value: 'original', label: isSvg ? 'SVG (original, vector)' : 'Original file' },
    ...DOWNLOAD_PNG_WIDTHS.map((w) => ({ value: String(w), label: `PNG, ${w} px wide` })),
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label={`${label} logo download format`}
        size="sm"
        value={format}
        onValueChange={setFormat}
        options={options}
        className="w-48"
      />
      <Button
        size="sm"
        disabled={download.isPending}
        onClick={() =>
          download.mutate(
            format === 'original'
              ? { assetVersionId: v.id, format: 'original' }
              : {
                  assetVersionId: v.id,
                  format: 'png',
                  width: Number(format) as (typeof DOWNLOAD_PNG_WIDTHS)[number],
                },
          )
        }
      >
        {download.isPending ? 'Preparing…' : `Download ${label.toLowerCase()} logo`}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-status-critical">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The logo's state and rights: a logo is only offered for publishing once usage rights are recorded (spec 9.2), so a
 * logo with none gets a one-click "our own logo" record.
 */
function LogoRights({ assetId }: { assetId: string }) {
  const { brand } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const asset = useAsset(assetId);
  const intent = useIntentKey();
  const record = useMutation(
    trpc.assets.rights.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.assets.pathFilter());
      },
    }),
  );
  const a = asset.data;
  if (!a) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="truncate">{a.name}</span>
      {a.state !== 'approved' && <Badge tone="warning">Awaiting approval</Badge>}
      {a.rightsState === 'recorded' ? (
        <Badge tone="good">Rights recorded</Badge>
      ) : (
        <Button
          size="sm"
          onClick={() =>
            record.mutate({
              assetId,
              owner: brand.name,
              permittedChannels: 'all',
              territories: 'all',
              releases: [],
              restrictions: [],
            })
          }
          disabled={record.isPending}
        >
          Record as our own logo
        </Button>
      )}
    </div>
  );
}

// ---- editor ----------------------------------------------------------------------------------------------------

const newRule = (variant: LogoVariant, logo: { assetId: string; assetVersionId?: string }): LogoRuleV1 => ({
  assetId: logo.assetId,
  ...(logo.assetVersionId ? { assetVersionId: logo.assetVersionId } : {}),
  variant,
  allowedBackgroundColourKeys: [],
  clearSpaceRatio: 0.5,
  minWidthPx: 96,
});

/**
 * Logos section of the brand system editor: each variant is a slot holding one logo. A slot is filled by uploading
 * into it (which also replaces the logo it held) or by reusing a logo the brand already has; assigned slots can be
 * moved up or down (the order agents and people read them in) or cleared. Each slot edits its grounds, clear space,
 * minimum width, preferred format and usage guidance, with the previews and download beside them.
 */
export function LogosSection({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const { brandId } = useBrandContext();
  const logos = useBrandAssetsOfKind(brandId, ['logo']);
  const items = logos.data?.items ?? [];
  const rules = doc.logoRules;
  const setRules = (logoRules: LogoRuleV1[]) => onChange({ ...doc, logoRules });
  const setRule = (variant: LogoVariant, rule: LogoRuleV1 | null) => {
    const at = rules.findIndex((r) => r.variant === variant);
    if (!rule) return setRules(rules.filter((r) => r.variant !== variant));
    if (at < 0) return setRules([...rules, rule]);
    setRules(rules.map((r, i) => (i === at ? rule : r)));
  };
  const move = (variant: LogoVariant, by: -1 | 1) => {
    const at = rules.findIndex((r) => r.variant === variant);
    const to = at + by;
    if (at < 0 || to < 0 || to >= rules.length) return;
    const next = [...rules];
    [next[at], next[to]] = [next[to] as LogoRuleV1, next[at] as LogoRuleV1];
    setRules(next);
  };
  // Assigned variants in the document's order, then the empty slots in the usual order.
  const slots = [
    ...rules.map((r) => r.variant),
    ...LOGO_VARIANTS.map((v) => v.variant).filter((v) => !rules.some((r) => r.variant === v)),
  ];
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold">Logos</h3>
        <p className="text-xs text-muted-foreground">
          Upload SVG where you have it (it stays sharp at every size); PNG or WebP with a transparent
          background otherwise. Each variant names one logo, the grounds it may sit on, its clear space (a
          multiple of the mark height), its minimum width and how to use it. Logos are never generated.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => void logos.refetch()}>
          Refresh logos
        </Button>
      </div>
      {logos.isPending && <Skeleton label="Loading logos" lines={2} />}
      {logos.isError && <RequestError error={logos.error} onRetry={() => void logos.refetch()} />}
      {logos.isSuccess && items.length === 0 && rules.length === 0 && (
        <EmptyState
          title="No logos yet"
          description="Upload a logo into a variant below: SVG preferred, PNG or WebP with transparency otherwise."
        />
      )}
      <ul className="grid gap-3 lg:grid-cols-2" aria-label="Logo variants">
        {slots.map((variant) => {
          const meta = LOGO_VARIANTS.find((v) => v.variant === variant);
          const index = rules.findIndex((r) => r.variant === variant);
          return (
            <LogoSlot
              key={variant}
              variant={variant}
              label={meta?.label ?? variant}
              hint={meta?.hint ?? ''}
              rule={rules[index]}
              logos={items}
              colours={doc.tokens.colours.filter((c) => c.key)}
              canMoveUp={index > 0}
              canMoveDown={index >= 0 && index < rules.length - 1}
              onMove={(by) => move(variant, by)}
              onChange={(rule) => setRule(variant, rule && { ...rule, variant })}
            />
          );
        })}
      </ul>
    </section>
  );
}

function LogoSlot({
  variant,
  label,
  hint,
  rule,
  logos,
  colours,
  canMoveUp,
  canMoveDown,
  onMove,
  onChange,
}: {
  variant: LogoVariant;
  label: string;
  hint: string;
  rule: LogoRuleV1 | undefined;
  logos: AssetRef[];
  colours: Colour[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (by: -1 | 1) => void;
  onChange: (rule: LogoRuleV1 | null) => void;
}) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // A new logo replaces the old one's pinned version too (a stale pin would name another logo's version).
  const assign = (logo: { assetId: string; assetVersionId?: string }) => {
    if (!rule) return onChange(newRule(variant, logo));
    const { assetVersionId: _previous, ...kept } = rule;
    onChange({
      ...kept,
      assetId: logo.assetId,
      ...(logo.assetVersionId ? { assetVersionId: logo.assetVersionId } : {}),
    });
  };
  // An upload into the slot fills it (or replaces its logo) once ingest accepts the file; the version is pinned.
  const upload = useAssetUpload(brandId, {
    onAccepted: (assetId) => {
      void queryClient
        .fetchQuery(trpc.assets.get.queryOptions({ assetId }))
        .then((a) =>
          assign({ assetId, ...(a.currentVersion ? { assetVersionId: a.currentVersion.id } : {}) }),
        )
        .catch(() => assign({ assetId }));
    },
  });
  const options = logos.map((l, i) => ({
    value: l.assetId,
    label: l.altText ?? `Logo ${i + 1}${l.width && l.height ? ` (${l.width}×${l.height})` : ''}`,
  }));
  const id = `logo-${variant}`;
  const usage = rule?.usage ?? { backgroundsNote: '', donts: [] };
  const [dontsText, setDontsText] = useState(usage.donts.join('\n'));
  // Guidance emptied again leaves the rule as it was without any (the document hashes as before).
  const setUsage = (next: typeof usage) => {
    if (!rule) return;
    const { usage: _previous, ...withoutUsage } = rule;
    onChange(next.backgroundsNote.trim() || next.donts.length ? { ...rule, usage: next } : withoutUsage);
  };
  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3"
      data-testid={`logo-slot-${variant}`}
      aria-labelledby={`${id}-title`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`${id}-title`} className="text-sm font-medium">
          {label}
        </h4>
        {rule && (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={!canMoveUp}
              onClick={() => onMove(-1)}
              aria-label={`Move ${label} up`}
            >
              Up
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canMoveDown}
              onClick={() => onMove(1)}
              aria-label={`Move ${label} down`}
            >
              Down
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
              Clear
            </Button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {rule?.assetId && (
        <>
          <LogoRights assetId={rule.assetId} />
          <LogoGrounds rule={rule} colours={colours} label={label} />
        </>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="inline-flex w-fit cursor-pointer items-center rounded-md border border-border bg-secondary px-2.5 py-1.5 text-sm focus-within:ring-2 focus-within:ring-ring hover:bg-muted">
          {rule ? `Replace ${label.toLowerCase()} logo` : `Upload ${label.toLowerCase()} logo`}
          <input
            type="file"
            accept={LOGO_ACCEPT}
            disabled={upload.pending}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.upload(file, 'logo');
              e.target.value = '';
            }}
          />
        </label>
        <span className="text-xs text-muted-foreground">SVG preferred; PNG or WebP.</span>
      </div>
      <UploadStatus step={upload.step} />
      {options.length > 0 && (
        <Select
          aria-label={`Reuse an existing logo as ${label}`}
          placeholder="Or reuse a logo the brand has"
          value={rule?.assetId ?? ''}
          onValueChange={(assetId) => {
            const picked = logos.find((l) => l.assetId === assetId);
            assign({ assetId, ...(picked ? { assetVersionId: picked.assetVersionId } : {}) });
          }}
          options={options}
        />
      )}
      {rule && (
        <>
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <legend className="mb-1 text-muted-foreground">Allowed grounds</legend>
            {colours.length === 0 && (
              <span className="text-muted-foreground">Add palette colours first.</span>
            )}
            {colours.map((c) => (
              <label key={c.key} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={rule.allowedBackgroundColourKeys.includes(c.key)}
                  onChange={(e) =>
                    onChange({
                      ...rule,
                      allowedBackgroundColourKeys: e.target.checked
                        ? [...rule.allowedBackgroundColourKeys, c.key]
                        : rule.allowedBackgroundColourKeys.filter((x) => x !== c.key),
                    })
                  }
                />
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 rounded-sm border border-border"
                  style={{ backgroundColor: c.value }}
                />
                <code>{c.key}</code>
              </label>
            ))}
          </fieldset>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Clear space (× mark height)" htmlFor={`${id}-clear`}>
              <Input
                id={`${id}-clear`}
                type="number"
                min={0}
                step={0.05}
                value={rule.clearSpaceRatio}
                onChange={(e) => onChange({ ...rule, clearSpaceRatio: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label="Minimum width (px)" htmlFor={`${id}-min`}>
              <Input
                id={`${id}-min`}
                type="number"
                min={1}
                value={rule.minWidthPx}
                onChange={(e) => onChange({ ...rule, minWidthPx: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label="Preferred format" htmlFor={`${id}-format`}>
              <Select
                id={`${id}-format`}
                value={rule.preferredFormat ?? ''}
                placeholder="No preference"
                onValueChange={(f) => onChange({ ...rule, preferredFormat: f === 'svg' ? 'svg' : 'raster' })}
                options={[
                  { value: 'svg', label: 'SVG (vector)' },
                  { value: 'raster', label: 'PNG or WebP' },
                ]}
              />
            </Field>
          </div>
          <Field
            label="Backgrounds guidance"
            htmlFor={`${id}-backgrounds`}
            hint="Where this logo works beyond the palette grounds, for example on photographs."
          >
            <Textarea
              id={`${id}-backgrounds`}
              rows={2}
              maxLength={LOGO_USAGE_NOTE_MAX}
              value={usage.backgroundsNote}
              onChange={(e) => setUsage({ ...usage, backgroundsNote: e.target.value })}
            />
          </Field>
          <Field
            label="Don’ts"
            htmlFor={`${id}-donts`}
            hint={`One per line, up to ${LOGO_DONTS_MAX}: for example “Never recolour the mark”.`}
          >
            <Textarea
              id={`${id}-donts`}
              rows={3}
              value={dontsText}
              onChange={(e) => {
                setDontsText(e.target.value);
                setUsage({ ...usage, donts: lines(e.target.value, LOGO_DONTS_MAX, LOGO_DONT_MAX) });
              }}
            />
          </Field>
          <LogoDownload assetId={rule.assetId} label={label} />
        </>
      )}
    </li>
  );
}

// ---- read view -------------------------------------------------------------------------------------------------

/** The brand system's logos, read only: each variant's artwork on its grounds, its rules, guidance and download. */
export function LogoView({ doc }: { doc: Doc }) {
  if (doc.logoRules.length === 0) return <p className="text-sm text-muted-foreground">No logo rules yet.</p>;
  return (
    <ul className="grid gap-4 lg:grid-cols-2" aria-label="Logo variants">
      {doc.logoRules.map((r) => {
        const label = LOGO_LABEL[r.variant];
        return (
          <li
            key={`${r.variant}-${r.assetId}`}
            className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3 text-sm"
            data-testid={`logo-view-${r.variant}`}
          >
            <p className="font-medium">{label}</p>
            <LogoGrounds rule={r} colours={doc.tokens.colours} label={label} />
            <p className="text-muted-foreground">
              Clear space {r.clearSpaceRatio}× · min {r.minWidthPx} px
              {r.preferredFormat ? ` · prefers ${r.preferredFormat === 'svg' ? 'SVG' : 'raster'}` : ''}
            </p>
            {r.usage?.backgroundsNote && <p className="text-xs">{r.usage.backgroundsNote}</p>}
            {r.usage && r.usage.donts.length > 0 && (
              <div className="text-xs">
                <p className="font-medium">Don’ts</p>
                <ul className="list-disc pl-5">
                  {r.usage.donts.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
            <LogoDownload assetId={r.assetId} label={label} />
          </li>
        );
      })}
    </ul>
  );
}
