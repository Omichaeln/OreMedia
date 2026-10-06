import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ContentType, CreativeDocumentV1, FormatDefinition } from '@oremedia/contracts/creative';
import { VIDEO_FORMATS, type VideoFormatKey } from '@oremedia/contracts/video';
import {
  FORMAT_DEFINITIONS,
  STARTERS,
  aspectLabel,
  blankDocument,
  customFormatIssue,
  customFormatKey,
  formatFor,
  instantiateStarter,
} from '@oremedia/editor';
import { Button, Chip, EmptyState, Field, Input, Skeleton, StatusBanner, cn } from '@oremedia/ui';
import { RequestError } from '../../../components/request-state';
import { Select } from '../../../components/select';
import { toUiError } from '../../../lib/errors';
import { brandPath, useBrandContext } from '../../brand/brand-context';
import { useBrandVersions } from '../../brand/use-brand';
import type { TemplateWithCurrentDto } from '../types';
import { useTemplatesWithCurrent, useVideoTemplates } from '../use-document';
import {
  KINDS,
  KIND_FORMATS,
  contentTypeOf,
  contentTypesFor,
  dimensionsLabel,
  platformsOf,
  suggestTitle,
  type StudioKind,
} from './content-types';
import { ScenePreview, usePreviewResolvers } from './scene-preview';
import { useStarterBrand } from './use-starter-brand';
import { useStartDocument, type StartRequest } from './use-create-document';

/** A layout the format step offers: blank, a built-in starter or an approved brand template, at one format. */
interface LayoutEntry {
  id: string;
  name: string;
  contentType: ContentType;
  formatKey: string;
  document: CreativeDocumentV1;
  /** Where it comes from, said under its name. */
  detail: string;
  notes: string[];
  start: (title: string) => StartRequest;
}

const PREVIEW_BOX = 128;
/** A preview's width inside the square box the interface draws layouts in. */
const previewWidth = (w: number, h: number) => Math.round(w >= h ? PREVIEW_BOX : (PREVIEW_BOX * w) / h);

export const kindLabel = (kind: StudioKind) => (kind === 'still' ? 'Still' : 'Motion');

/** The step the address names (refresh and Back keep it): `?kind=` and, once chosen, `&platform=&format=`. */
export const studioKindOf = (params: URLSearchParams): StudioKind | null => {
  const kind = params.get('kind');
  return kind === 'still' || kind === 'motion' ? kind : null;
};

/** The format a `format=` value names for a kind: a page format (custom sizes too) or a video output preset. */
export function formatOf(kind: StudioKind, key: string | null): FormatDefinition | null {
  if (!key) return null;
  if (kind === 'motion') return (VIDEO_FORMATS as Record<string, FormatDefinition>)[key] ?? null;
  return formatFor(key) ?? null;
}

/**
 * The interface's create screen (STU-1a, D-30): "What are you making?", the Still and Motion cards with the number
 * of formats each can make, and the brand-system warning when creation is blocked. The route puts the brand's
 * documents to continue under it.
 */
export function StudioStart({ children }: { children: ReactNode }) {
  const { brandId, brand } = useBrandContext();
  const versions = useBrandVersions(brandId);
  const published = versions.data?.items.find((v) => v.id === brand.publishedVersionId);
  const noBrandSystem = brand.status !== 'setup' && !brand.publishedVersionId;
  return (
    <main id="main" className="om-in min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-9 px-4 pb-20 pt-10 sm:px-8 sm:pt-16">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-title">What are you making?</h1>
          <p className="text-pretty text-base text-muted-foreground">
            {brand.publishedVersionId
              ? `Every format starts from ${brand.name}’s published brand system${published ? ` v${published.number}` : ''}. Colour, type, logo rules and approved assets come with it.`
              : `Every format starts from ${brand.name}’s published brand system, so documents can be created once it is saved.`}
          </p>
        </header>
        {noBrandSystem && <NoBrandSystemBanner />}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-4">
          {KINDS.map((k) => (
            <KindCard key={k.key} kind={k} />
          ))}
        </div>
        {children}
      </div>
    </main>
  );
}

function NoBrandSystemBanner() {
  const { companyId, brandId } = useBrandContext();
  return (
    <StatusBanner
      tone="warning"
      title="No brand system yet"
      description="The brand has no saved brand system. Documents cannot be created until the brand system is saved."
      actions={
        <Button asChild size="sm">
          <Link to={brandPath(companyId, brandId, 'system')}>Open brand system</Link>
        </Button>
      }
    />
  );
}

/** The interface's illustration of each kind: three frames in the ink, the accent and the card surface. */
const FRAMES: Record<StudioKind, Array<{ className: string; glyph?: string }>> = {
  still: [
    { className: 'h-[95px] w-[76px] bg-primary' },
    { className: 'h-24 w-24 bg-accent' },
    { className: 'h-24 w-[68px] bg-card' },
  ],
  motion: [
    { className: 'h-[100px] w-14 bg-primary text-primary-foreground', glyph: '▶' },
    { className: 'h-[84px] w-[150px] bg-accent text-accent-foreground', glyph: '▶' },
    { className: 'h-[100px] w-14 bg-card text-foreground', glyph: '▶' },
  ],
};

function KindCard({ kind }: { kind: (typeof KINDS)[number] }) {
  const count = KIND_FORMATS[kind.key].length;
  return (
    <Link
      to={{ search: `?kind=${kind.key}` }}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-[transform,box-shadow,border-color] duration-200 ease-out-soft hover:-translate-y-0.5 hover:border-border-strong hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      data-testid="studio-kind"
    >
      <span aria-hidden="true" className="flex h-[200px] items-center justify-center gap-3 bg-muted">
        {FRAMES[kind.key].map((f, i) => (
          <span
            key={i}
            // The glyph is large text (22 px bold), so the accent frame's light glyph keeps 3:1 (WCAG large text).
            className={cn(
              'flex items-center justify-center rounded-sm text-xl font-bold shadow-card',
              f.className,
            )}
          >
            {f.glyph}
          </span>
        ))}
      </span>
      <span className="flex flex-col gap-1.5 px-5 pb-5 pt-[18px]">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-xl font-bold tracking-title">{kind.label}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {count} format{count === 1 ? '' : 's'}
          </span>
        </span>
        <span className="text-pretty text-sm text-muted-foreground">{kind.description}</span>
        <span className="mt-1 text-xs">{kind.tools}</span>
      </span>
    </Link>
  );
}

/**
 * The interface's format step: Still / Motion and the platforms on the left (each with how many of its formats the
 * application makes), the platform's sizes in the centre with a custom size for pages, and once a size is chosen
 * the layouts for it on the right, with the title and "Open in canvas" / "Open in timeline". The step lives in the
 * address, so a refresh or Back keeps it.
 */
export function FormatPicker({ kind }: { kind: StudioKind }) {
  const { brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const platforms = platformsOf(kind);
  const platform = platforms.find((p) => p.key === params.get('platform')) ?? platforms[0];
  const format = formatOf(kind, params.get('format'));
  const go = (next: { kind?: StudioKind; platform?: string; format?: string }) => {
    const search = new URLSearchParams({ kind: next.kind ?? kind });
    if (next.platform) search.set('platform', next.platform);
    if (next.format) search.set('format', next.format);
    setParams(search);
  };
  const disabledReason = brand.publishedVersionId ? undefined : 'Save the brand system first';
  if (!platform) return null;

  return (
    <main
      id="main"
      className={cn(
        'om-in grid min-h-0 flex-1 grid-cols-1 overflow-auto md:overflow-hidden',
        format
          ? 'md:grid-cols-[170px_minmax(0,1fr)_280px] lg:grid-cols-[200px_minmax(0,1fr)_340px]'
          : 'md:grid-cols-[170px_minmax(0,1fr)] lg:grid-cols-[200px_minmax(0,1fr)]',
      )}
    >
      <nav
        aria-label="Formats"
        className="flex min-w-0 flex-col gap-px border-b border-border bg-card px-3 py-[18px] md:overflow-auto md:border-b-0 md:border-r"
      >
        <div
          role="group"
          aria-label="Kind"
          className="mb-4 flex overflow-hidden rounded-lg border border-border"
        >
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={k.key === kind}
              onClick={() => go({ kind: k.key })}
              className={cn(
                'h-[30px] flex-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                k.key === kind
                  ? 'bg-secondary text-foreground'
                  : 'bg-card text-muted-foreground hover:text-foreground',
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        <h2 className="om-label px-2.5 pb-1.5">Platform</h2>
        <ul className="flex flex-col gap-px">
          {platforms.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                aria-pressed={p.key === platform.key}
                onClick={() => go({ platform: p.key })}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2.5 py-[7px] text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  p.key === platform.key
                    ? 'bg-secondary font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span>{p.label}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {p.formats.length}
                  <span className="sr-only"> {p.formats.length === 1 ? 'format' : 'formats'}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section
        aria-labelledby="platform-title"
        className="flex min-w-0 flex-col gap-[18px] px-4 pb-16 pt-7 sm:px-8 md:overflow-auto"
      >
        <div className="flex flex-col gap-1">
          <h1 id="platform-title" className="text-xl font-bold tracking-title">
            {platform.label}
            {kind === 'motion' ? ' video' : ''}
          </h1>
          <p className="text-pretty text-sm text-muted-foreground">
            {kind === 'still'
              ? `Pick a size. Layouts for it open beside it: ${brand.name}’s approved templates and the built-in starters, made from its brand system.`
              : 'Pick a size. The timeline starts blank or from a video template made for that size.'}
          </p>
        </div>
        <ul aria-label="Sizes" className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">
          {platform.formats.map((f) => (
            <li key={f.key}>
              <SizeCard
                format={f}
                selected={format?.key === f.key}
                onSelect={() => go({ platform: platform.key, format: f.key })}
              />
            </li>
          ))}
        </ul>
        {kind === 'still' && <CustomSizeForm onUse={(key) => go({ platform: platform.key, format: key })} />}
      </section>

      {format &&
        (kind === 'still' ? (
          <StillLayouts key={format.key} format={format} disabledReason={disabledReason} />
        ) : (
          <MotionLayouts key={format.key} format={format} disabledReason={disabledReason} />
        ))}
    </main>
  );
}

/** A size as the interface draws it: the frame at its proportions, the name and the dimensions. */
function SizeCard({
  format,
  selected,
  onSelect,
}: {
  format: FormatDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  const scale = Math.min(120 / format.width, 76 / format.height);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-3 rounded-xl border bg-card p-3 text-left hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected ? 'border-foreground ring-1 ring-foreground' : 'border-border',
      )}
      data-testid="format-card"
    >
      <span aria-hidden="true" className="flex h-24 items-center justify-center rounded-lg bg-background">
        <span
          className={cn(
            'rounded-sm border transition-colors',
            selected ? 'border-foreground bg-accent-tint' : 'border-border-strong bg-card',
          )}
          style={{ width: Math.round(format.width * scale), height: Math.round(format.height * scale) }}
        />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{format.label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {format.width} × {format.height} px · {aspectLabel(format.width, format.height)}
        </span>
      </span>
    </button>
  );
}

/** Any size the renderer can export (64 to 4096 px a side, at most 8:1), checked before it is used. */
function CustomSizeForm({ onUse }: { onUse: (formatKey: string) => void }) {
  const [width, setWidth] = useState('1080');
  const [height, setHeight] = useState('1350');
  const w = Number(width);
  const h = Number(height);
  const issue = width && height ? customFormatIssue(w, h) : 'Enter a width and a height';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!issue) onUse(customFormatKey(w, h));
  };
  return (
    <form
      onSubmit={submit}
      aria-labelledby="custom-size-title"
      className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
      noValidate
    >
      <h2 id="custom-size-title" className="w-full text-sm font-medium">
        Custom size
      </h2>
      <Field label="Width (px)" htmlFor="custom-width">
        <Input
          id="custom-width"
          type="number"
          inputMode="numeric"
          min={64}
          max={4096}
          className="w-[90px]"
          value={width}
          onChange={(e) => setWidth(e.target.value)}
        />
      </Field>
      <Field label="Height (px)" htmlFor="custom-height">
        <Input
          id="custom-height"
          type="number"
          inputMode="numeric"
          min={64}
          max={4096}
          className="w-[90px]"
          value={height}
          onChange={(e) => setHeight(e.target.value)}
        />
      </Field>
      <Button type="submit" disabledReason={issue ?? undefined}>
        Use size
      </Button>
      <p
        role="status"
        aria-live="polite"
        className={cn('w-full text-xs', issue ? 'text-status-critical' : 'text-muted-foreground')}
      >
        {issue ?? dimensionsLabel(w, h)}
      </p>
    </form>
  );
}

/** An approved brand template's current version as a layout. */
const templateLayout = (template: TemplateWithCurrentDto, brandId: string): LayoutEntry => {
  const version = template.currentVersion;
  const document = version.document;
  const contentType = document.contentType ?? 'custom';
  return {
    id: `template:${template.id}`,
    name: template.name,
    contentType,
    formatKey: document.pages[0]?.formatKey ?? '',
    document,
    detail: `Brand template, version ${version.number} · ${contentTypeOf(contentType).label}`,
    notes: [],
    start: (title) => ({
      kind: 'create',
      input: {
        brandId,
        title,
        ...(document.contentType ? { contentType: document.contentType } : {}),
        source: { kind: 'template', templateId: template.id, templateVersionId: version.id },
      },
    }),
  };
};

/** The layouts panel's frame: the label, the chosen size, the list, and the form that opens the document. */
function LayoutsFrame({
  format,
  children,
  footer,
}: {
  format: FormatDefinition;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <aside
      aria-labelledby="layouts-title"
      className="om-drawer flex min-h-0 min-w-0 flex-col border-t border-border bg-card md:border-l md:border-t-0"
      data-testid="layouts"
    >
      <div className="flex shrink-0 flex-col gap-[3px] border-b border-border px-5 py-[18px]">
        <span className="om-label">Layouts</span>
        <h2 id="layouts-title" className="text-md font-bold">
          {format.label}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {format.width} × {format.height} px · {aspectLabel(format.width, format.height)}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4 md:overflow-auto">{children}</div>
      {footer}
    </aside>
  );
}

/** A layout tile: its preview in the square box, its name and where it comes from; double-click opens it. */
function LayoutTile({
  name,
  detail,
  selected,
  onSelect,
  onOpen,
  children,
}: {
  name: string;
  detail: string;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  children: ReactNode;
}) {
  // Named by the layout's name and described by its source, not by the preview's own label that comes first.
  const id = useId();
  return (
    <li data-testid="gallery-card">
      <button
        type="button"
        aria-labelledby={`${id}-name`}
        aria-describedby={`${id}-detail`}
        aria-pressed={selected}
        onClick={onSelect}
        onDoubleClick={onOpen}
        className="flex w-full flex-col gap-1.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card"
      >
        <span
          className={cn(
            'flex h-[140px] items-center justify-center rounded-lg bg-background outline outline-2 outline-offset-2 transition-[outline-color]',
            selected ? 'outline-foreground' : 'outline-transparent',
          )}
        >
          {children}
        </span>
        <span id={`${id}-name`} className="text-sm font-medium" data-testid="layout-name">
          {name}
        </span>
        <span id={`${id}-detail`} className="text-xs text-muted-foreground">
          {detail}
        </span>
      </button>
    </li>
  );
}

/** The title the document is created with (suggested, editable) and the button that creates and opens it. */
function OpenForm({
  defaultTitle,
  label,
  note,
  busy,
  disabledReason,
  onOpen,
  children,
}: {
  defaultTitle: string;
  label: string;
  note: string;
  busy: boolean;
  disabledReason?: string;
  onOpen: (title: string) => void;
  children?: ReactNode;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) onOpen(title.trim());
  };
  return (
    <form
      onSubmit={submit}
      className="flex shrink-0 flex-col gap-2.5 border-t border-border px-5 pb-[18px] pt-3.5"
      noValidate
    >
      {children}
      <Field
        label="New document title"
        htmlFor="doc-title"
        error={title.trim() ? undefined : 'A title is required'}
      >
        <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </Field>
      <Button
        type="submit"
        variant="primary"
        className="h-[38px] w-full"
        disabled={busy || !title.trim()}
        disabledReason={disabledReason}
      >
        {busy ? 'Creating…' : label}
      </Button>
      <p className="text-pretty text-xs text-muted-foreground">{note}</p>
    </form>
  );
}

/**
 * The layouts for a page size: blank (the brand's background), the approved brand templates and the built-in
 * starters made for it (instantiated with the brand's published system, previewed by the scene renderer). When the
 * size can be more than one content type (a square post or a carousel), chips choose it; a blank start takes it.
 */
function StillLayouts({ format, disabledReason }: { format: FormatDefinition; disabledReason?: string }) {
  const { brandId, brand } = useBrandContext();
  const starterBrand = useStarterBrand(brandId, brand.publishedVersionId ?? null);
  const templates = useTemplatesWithCurrent(brandId);
  const start = useStartDocument();
  const colours = useMemo(() => starterBrand.brand?.colours ?? [], [starterBrand.brand]);
  // A size typed in the custom form rather than one of the presets: its blank start is custom artwork.
  const custom = !FORMAT_DEFINITIONS[format.key];
  const brandVersionId = brand.publishedVersionId ?? '';

  const atFormat = useMemo((): LayoutEntry[] => {
    const b = starterBrand.brand;
    const fromTemplates = (templates.data?.items ?? [])
      .filter((t) => t.state === 'active' && t.currentVersionId)
      .map((t) => templateLayout(t, brandId));
    const fromStarters: LayoutEntry[] =
      b && !starterBrand.issue
        ? STARTERS.filter((spec) => spec.formatKey === format.key).map((spec) => {
            const made = instantiateStarter(spec, b);
            return {
              id: `starter:${spec.key}`,
              name: spec.name,
              contentType: spec.contentType,
              formatKey: spec.formatKey,
              document: made.document,
              detail: `Built-in · ${contentTypeOf(spec.contentType).label}`,
              notes: made.notes,
              start: (title: string): StartRequest => ({
                kind: 'create',
                input: {
                  brandId,
                  title,
                  document: made.document,
                  contentType: spec.contentType,
                  source: { kind: 'starter', starterKey: spec.key },
                },
              }),
            };
          })
        : [];
    return [...fromTemplates.filter((e) => e.formatKey === format.key), ...fromStarters];
  }, [starterBrand.brand, starterBrand.issue, templates.data, brandId, format.key]);

  const types: ContentType[] = custom
    ? ['custom']
    : contentTypesFor(
        format.key,
        atFormat.map((e) => e.contentType),
      );
  const [type, setType] = useState<ContentType | 'all'>('all');
  const blankType = type === 'all' ? (types[0] ?? 'custom') : type;
  const blankPages = contentTypeOf(blankType).pages;
  const blankDoc = useMemo(
    () => blankDocument(format.key, { brandVersionId, colours }, blankType, blankPages),
    [format.key, brandVersionId, colours, blankType, blankPages],
  );
  const blank: LayoutEntry = {
    id: 'blank',
    name: 'Blank',
    contentType: blankType,
    formatKey: format.key,
    document: blankDoc,
    detail: `${contentTypeOf(blankType).label} · the brand’s background, nothing placed`,
    notes: [],
    start: (title) => ({
      kind: 'create',
      input: {
        brandId,
        title,
        contentType: blankType,
        document: blankDoc,
        source: { kind: custom ? 'custom' : 'blank' },
      },
    }),
  };
  const shown = atFormat.filter((e) => type === 'all' || e.contentType === type);
  const layouts = [blank, ...shown];
  const [picked, setPicked] = useState<string | null>(null);
  const selected = layouts.find((l) => l.id === picked) ?? shown[0] ?? blank;
  const resolvers = usePreviewResolvers(
    useMemo(() => [...atFormat.map((e) => e.document), blankDoc], [atFormat, blankDoc]),
    colours,
  );
  const titleFor = (e: LayoutEntry) =>
    suggestTitle(e.contentType, e.id === 'blank' ? (custom ? 'Custom layout' : 'Blank') : e.name);
  const open = (e: LayoutEntry, title: string) => start.mutate(e.start(title));
  const width = previewWidth(format.width, format.height);

  return (
    <LayoutsFrame
      format={format}
      footer={
        <OpenForm
          key={`${selected.id}:${blankType}`}
          defaultTitle={titleFor(selected)}
          label="Open in canvas"
          note="The document starts from the brand’s published system. Every save is a new revision; template locks and logo rules stay in force."
          busy={start.isPending}
          disabledReason={disabledReason}
          onOpen={(title) => open(selected, title)}
        >
          {selected.notes.map((n) => (
            <p key={n} className="text-xs text-status-warning">
              {n}
            </p>
          ))}
        </OpenForm>
      }
    >
      {start.isError && (
        <StatusBanner
          tone="critical"
          title="The document could not be created"
          description={toUiError(start.error).message}
        />
      )}
      {starterBrand.isPending && <Skeleton label="Loading the brand's starters" lines={3} />}
      {starterBrand.isError && <RequestError error={starterBrand.error} onRetry={starterBrand.refetch} />}
      {templates.isError && <RequestError error={templates.error} onRetry={() => void templates.refetch()} />}
      {starterBrand.notes.length > 0 && (
        <StatusBanner
          tone="info"
          title="About the logos in the starters"
          description={starterBrand.notes.join(' ')}
        />
      )}
      {starterBrand.brand && starterBrand.issue && (
        <StatusBanner
          tone="info"
          title="Built-in starters need more of the brand system"
          description={`${starterBrand.issue} You can still start blank or at a custom size.`}
        />
      )}
      {types.length > 1 && (
        <div role="group" aria-label="Content type" className="flex flex-wrap gap-1.5">
          <Chip selected={type === 'all'} onClick={() => setType('all')}>
            All
          </Chip>
          {types.map((t) => (
            <Chip key={t} selected={type === t} onClick={() => setType(t)}>
              {contentTypeOf(t).label}
            </Chip>
          ))}
        </div>
      )}
      <ul aria-label="Layouts" className="grid grid-cols-2 gap-x-3.5 gap-y-4" data-testid="template-gallery">
        {layouts.map((l) => {
          const page = l.document.pages[0];
          return (
            <LayoutTile
              key={l.id}
              name={l.name}
              detail={l.detail}
              selected={l.id === selected.id}
              onSelect={() => setPicked(l.id)}
              onOpen={() => open(l, titleFor(l))}
            >
              {page && (
                <ScenePreview
                  page={page}
                  width={width}
                  resolvers={resolvers}
                  label={`Preview of ${l.name}, ${page.width} by ${page.height}`}
                />
              )}
            </LayoutTile>
          );
        })}
      </ul>
      {templates.isSuccess && starterBrand.brand && shown.length === 0 && (
        <EmptyState
          title="No templates for this size yet"
          description="Start blank, or save a document as a template from the studio; once a brand manager approves it, it appears here."
        />
      )}
    </LayoutsFrame>
  );
}

/**
 * The layouts for a video size: a blank timeline or a built-in video template bound to the brand (STU-2b) made for
 * that size, and the frame rate.
 */
function MotionLayouts({ format, disabledReason }: { format: FormatDefinition; disabledReason?: string }) {
  const { brandId } = useBrandContext();
  const templates = useVideoTemplates(brandId, true);
  const start = useStartDocument();
  const [picked, setPicked] = useState('blank');
  const [fps, setFps] = useState<24 | 25 | 30>(30);
  const blank = { key: 'blank', name: 'Blank video', description: 'An empty timeline at this size.' };
  const layouts = [blank, ...(templates.data?.items ?? []).filter((t) => t.formatKey === format.key)];
  const selected = layouts.find((l) => l.key === picked) ?? blank;
  const titleFor = (l: (typeof layouts)[number]) => suggestTitle('video', l.key === 'blank' ? null : l.name);
  const open = (key: string, title: string) =>
    start.mutate({
      kind: 'create',
      input: {
        brandId,
        title,
        kind: 'video',
        video: {
          formatKey: format.key as VideoFormatKey,
          fps,
          ...(key === 'blank' ? {} : { templateKey: key }),
        },
      },
    });
  const scale = Math.min(PREVIEW_BOX / format.width, PREVIEW_BOX / format.height);
  return (
    <LayoutsFrame
      format={format}
      footer={
        <OpenForm
          key={selected.key}
          defaultTitle={titleFor(selected)}
          label="Open in timeline"
          note="Clips, captions and titles go on the timeline; every save is a new revision you can restore."
          busy={start.isPending}
          disabledReason={disabledReason}
          onOpen={(title) => open(selected.key, title)}
        >
          <Field label="Frame rate" htmlFor="video-fps">
            <Select
              id="video-fps"
              value={String(fps)}
              onValueChange={(v) => {
                if (v) setFps(Number(v) as 24 | 25 | 30);
              }}
              options={[24, 25, 30].map((n) => ({ value: String(n), label: `${n} fps` }))}
            />
          </Field>
        </OpenForm>
      }
    >
      {start.isError && (
        <StatusBanner
          tone="critical"
          title="The document could not be created"
          description={toUiError(start.error).message}
        />
      )}
      {templates.isPending && <Skeleton label="Loading video templates" lines={2} />}
      {templates.isError && <RequestError error={templates.error} onRetry={() => void templates.refetch()} />}
      <ul aria-label="Layouts" className="grid grid-cols-2 gap-x-3.5 gap-y-4" data-testid="template-gallery">
        {layouts.map((l) => (
          <LayoutTile
            key={l.key}
            name={l.name}
            detail={l.key === 'blank' ? l.description : `Video template · ${l.description}`}
            selected={l.key === selected.key}
            onSelect={() => setPicked(l.key)}
            onOpen={() => open(l.key, titleFor(l))}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex items-center justify-center rounded-sm text-sm shadow-card',
                l.key === 'blank'
                  ? 'border border-border-strong bg-card text-foreground'
                  : 'bg-primary text-primary-foreground',
              )}
              style={{ width: Math.round(format.width * scale), height: Math.round(format.height * scale) }}
            >
              ▶
            </span>
          </LayoutTile>
        ))}
      </ul>
    </LayoutsFrame>
  );
}
