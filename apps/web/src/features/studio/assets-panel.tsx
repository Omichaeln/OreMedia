import { useState } from 'react';
import type { LogoRuleV1, LogoVariant } from '@oremedia/contracts/brand';
import { IMAGE_CREATIVE_KINDS } from '@oremedia/contracts/assets';
import type { CreativePage, Element } from '@oremedia/contracts/creative';
import { findElement, type IntentBatch } from '@oremedia/editor';
import { Badge, Button, EmptyState, Input, Skeleton } from '@oremedia/ui';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { LOGO_LABEL } from '../brand/logo-rules';
import { AssetThumb } from '../assets/asset-thumb';
import { useAssetSearch, type AssetRefDto } from '../assets/use-assets';
import { newElementId } from '../../lib/ids';

export interface AssetsPanelProps {
  brandId: string;
  page: CreativePage;
  selection: string[];
  readOnly: boolean;
  onIntent: (batch: IntentBatch) => void;
  /** The brand system's logo rules (BSC-2): which logo each variant is, and the grounds it may sit on. */
  logoRules?: LogoRuleV1[];
}

/** The palette key of the page's background fill, when it has one. */
export const pageGround = (page: CreativePage): string | null => {
  const bg = page.elements.find((e) => e.type === 'background');
  return bg?.type === 'background' ? (bg.fillToken ?? null) : null;
};

/**
 * The variant a new logo should be on this ground: the first rule (in the brand system's order) allowed on it, else
 * the primary rule, else the first one; null when the brand names no logos.
 */
export function defaultLogoVariant(rules: readonly LogoRuleV1[], ground: string | null): LogoVariant | null {
  const allowed = ground ? rules.find((r) => r.allowedBackgroundColourKeys.includes(ground)) : undefined;
  return (allowed ?? rules.find((r) => r.variant === 'primary') ?? rules[0])?.variant ?? null;
}

/** The eligible asset a rule's logo is: its pinned version, else the asset's current version. */
const assetForRule = (rule: LogoRuleV1, eligible: readonly AssetRefDto[]) =>
  eligible.find((a) =>
    rule.assetVersionId ? a.assetVersionId === rule.assetVersionId : a.assetId === rule.assetId,
  );

/**
 * Why a rule's logo cannot be inserted, in words a person acts on; null when it can. Only the current version of an
 * approved logo with usage rights is eligible, so a pin to an earlier version blocks insertion until it is updated.
 */
export function logoUnavailableReason(rule: LogoRuleV1, eligible: readonly AssetRefDto[]): string | null {
  if (assetForRule(rule, eligible)) return null;
  if (rule.assetVersionId && eligible.some((a) => a.assetId === rule.assetId))
    return 'The brand system names an earlier version of this logo. Update it in the brand system (logos) to use the newer one.';
  return 'This logo is not usable yet: it needs approval and recorded usage rights (Assets).';
}

/**
 * A new image element: 40% of the page width (a logo at least its minimum width), centred, aspect from the asset when
 * known. A logo carries the variant it is placed as (BSC-2: the rule's variant, never assumed primary when known).
 */
export function imageElementFor(
  page: CreativePage,
  asset: AssetRefDto,
  logo: { variant: LogoVariant; minWidthPx?: number } = { variant: 'primary' },
): Element {
  const width = Math.min(
    page.width,
    Math.max(Math.round(page.width * 0.4), asset.kind === 'logo' ? Math.ceil(logo.minWidthPx ?? 0) : 0),
  );
  const ratio = asset.width && asset.height ? asset.width / asset.height : 1;
  const height = Math.max(1, Math.round(width / ratio));
  return {
    id: newElementId(),
    name: asset.altText ?? asset.kind,
    type: asset.kind === 'logo' ? 'logo' : 'image',
    locked: false,
    visible: true,
    opacity: 1,
    protected: asset.kind === 'logo',
    ...(asset.kind === 'logo' ? { semanticRole: 'logo' as const } : {}),
    transform: {
      x: Math.round((page.width - width) / 2),
      y: Math.round((page.height - height) / 2),
      width,
      height,
      rotation: 0,
    },
    ...(asset.kind === 'logo'
      ? { assetVersionId: asset.assetVersionId, variant: logo.variant }
      : { assetVersionId: asset.assetVersionId, fit: 'cover' as const }),
  } as Element;
}

/** Spec 9.2/11.4: only eligible assets are offered; the server authorises every referenced version again. */
export function AssetsPanel({
  brandId,
  page,
  selection,
  readOnly,
  onIntent,
  logoRules = [],
}: AssetsPanelProps) {
  const [query, setQuery] = useState('');
  const ground = pageGround(page);
  // Graphic layers take still images (STU-2b: the creative purpose also covers video and audio for timelines).
  const search = useAssetSearch(brandId, 'creative', query, IMAGE_CREATIVE_KINDS);
  const selected = selection[0] ? findElement(page, selection[0]) : null;
  const replaceable =
    selected &&
    (selected.type === 'image' || selected.type === 'logo' || selected.type === 'background') &&
    !selected.locked;

  const use = (asset: AssetRefDto) => {
    if (readOnly) return;
    if (replaceable && selected)
      onIntent({
        operations: [
          {
            op: 'replaceAsset',
            pageId: page.id,
            elementId: selected.id,
            assetVersionId: asset.assetVersionId,
          },
        ],
        summary: `Replace asset of ${selected.name}`,
        origin: 'user',
      });
    else {
      // A logo picked from the grid is placed as the variant the brand system names it (the one allowed on this
      // ground first); a logo no rule names stays primary and the brand check says so.
      // Matched by asset: a newer version than the one pinned keeps its variant (the brand check flags the mismatch).
      const rules = logoRules.filter((r) => r.assetId === asset.assetId);
      const variant = defaultLogoVariant(rules, ground);
      const rule = rules.find((r) => r.variant === variant);
      const element = imageElementFor(
        page,
        asset,
        rule ? { variant: rule.variant, minWidthPx: rule.minWidthPx } : undefined,
      );
      onIntent({
        operations: [{ op: 'insertElement', pageId: page.id, element }],
        summary: `Insert ${element.name}`,
        origin: 'user',
      });
    }
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      {logoRules.length > 0 && (
        <BrandLogoInsert
          brandId={brandId}
          page={page}
          ground={ground}
          rules={logoRules}
          readOnly={readOnly}
          onIntent={onIntent}
        />
      )}
      <Input
        aria-label="Search eligible assets"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-8"
      />
      <p className="text-xs text-muted-foreground">
        {replaceable
          ? `Choosing an asset replaces the asset of ${selected.name}.`
          : 'Choosing an asset inserts it as a new layer.'}
      </p>
      {search.isPending && <Skeleton label="Loading assets" lines={2} />}
      {search.isError && <RequestError error={search.error} onRetry={() => void search.refetch()} />}
      {search.isSuccess && search.items.length === 0 && (
        <EmptyState
          title="No eligible assets"
          description="Approved assets with usage rights for creative use appear here."
        />
      )}
      {search.isSuccess && search.items.length > 0 && (
        <ul className="grid grid-cols-3 gap-1" aria-label="Eligible assets">
          {search.items.map((a) => (
            <li key={a.assetVersionId}>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => use(a)}
                aria-label={`${replaceable ? 'Use' : 'Insert'} ${a.altText ?? a.kind}`}
                className="flex w-full flex-col gap-0.5 rounded-md border border-border p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <AssetThumb
                  assetVersionId={a.assetVersionId}
                  alt={a.altText ?? a.kind}
                  className="aspect-square w-full rounded-sm"
                />
                <Badge glyph={false} className="self-start">
                  {a.kind}
                </Badge>
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
    </div>
  );
}

/**
 * BSC-2: insert one of the brand's logos by variant. The variants come from the brand system's logo rules; the one
 * allowed on the page's background is chosen first. The element carries the rule's logo version and variant, so the
 * brand check can confirm the artwork is the one the brand names for that variant.
 */
function BrandLogoInsert({
  brandId,
  page,
  ground,
  rules,
  readOnly,
  onIntent,
}: {
  brandId: string;
  page: CreativePage;
  ground: string | null;
  rules: LogoRuleV1[];
  readOnly: boolean;
  onIntent: (batch: IntentBatch) => void;
}) {
  const logos = useAssetSearch(brandId, 'logo');
  const suggested = defaultLogoVariant(rules, ground);
  const [picked, setPicked] = useState<LogoVariant | null>(null);
  const variant = picked ?? suggested;
  const rule = rules.find((r) => r.variant === variant);
  const asset = rule ? assetForRule(rule, logos.items) : undefined;
  const unavailable = rule ? logoUnavailableReason(rule, logos.items) : null;
  const insert = () => {
    if (!rule || !asset || readOnly) return;
    const element = imageElementFor(page, asset, { variant: rule.variant, minWidthPx: rule.minWidthPx });
    onIntent({
      operations: [{ op: 'insertElement', pageId: page.id, element }],
      summary: `Insert ${LOGO_LABEL[rule.variant].toLowerCase()} logo`,
      origin: 'user',
    });
  };
  const fits = (r: LogoRuleV1) => ground !== null && r.allowedBackgroundColourKeys.includes(ground);
  return (
    <section
      className="flex flex-col gap-1.5 border-b border-border pb-2"
      aria-labelledby="brand-logo-heading"
    >
      <h3 id="brand-logo-heading" className="text-xs font-semibold">
        Brand logo
      </h3>
      {logos.isPending && <Skeleton label="Loading logos" lines={1} />}
      {logos.isError && <RequestError error={logos.error} onRetry={() => void logos.refetch()} />}
      {logos.isSuccess && (
        <>
          <Select
            aria-label="Logo variant"
            size="sm"
            value={variant ?? ''}
            onValueChange={(v) => setPicked(v as LogoVariant)}
            options={rules.map((r) => ({
              value: r.variant,
              label: `${LOGO_LABEL[r.variant]}${fits(r) ? ' (suits this background)' : ''}${assetForRule(r, logos.items) ? '' : ' (not usable now)'}`,
            }))}
          />
          {asset && (
            <AssetThumb
              assetVersionId={asset.assetVersionId}
              alt={`${LOGO_LABEL[rule?.variant ?? 'primary']} logo`}
              className="h-16 w-full rounded-sm border border-border bg-muted object-contain"
            />
          )}
          {rule && ground && !fits(rule) && (
            <p className="text-xs text-status-warning">
              The brand system does not allow this variant on <code>{ground}</code>.
            </p>
          )}
          {unavailable && (
            <p className="text-xs text-status-warning" role="status" data-testid="logo-unavailable">
              {unavailable}
            </p>
          )}
          <Button
            size="sm"
            disabled={readOnly || !asset}
            disabledReason={unavailable ?? undefined}
            onClick={insert}
          >
            Insert {variant ? LOGO_LABEL[variant].toLowerCase() : ''} logo
          </Button>
        </>
      )}
    </section>
  );
}
