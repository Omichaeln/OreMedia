import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { ContentType, CreativeDocumentV1 } from '@oremedia/contracts/creative';
import {
  STARTERS,
  blankDocument,
  customFormatIssue,
  customFormatKey,
  formatFor,
  instantiateStarter,
  type InstantiatedStarter,
  type StarterSpec,
} from '@oremedia/editor';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner, cn } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../../components/dialog';
import { RequestError } from '../../../components/request-state';
import { Select } from '../../../components/select';
import { toUiError } from '../../../lib/errors';
import { useBrandContext } from '../../brand/brand-context';
import type { TemplateDto } from '../types';
import { useDocuments, useTemplate, useTemplates } from '../use-document';
import {
  CHANNELS,
  CONTENT_TYPES,
  contentTypeOf,
  dimensionsLabel,
  formatLabel,
  suggestTitle,
} from './content-types';
import { ScenePreview, usePreviewResolvers, type PreviewResolvers } from './scene-preview';
import { useStarterBrand } from './use-starter-brand';
import { useStartDocument, type StartRequest } from './use-create-document';

type TypeFilter = ContentType | 'all';
type SourceFilter = 'all' | 'builtin' | 'brand';
interface Filters {
  type: TypeFilter;
  channel: string;
  format: string;
  source: SourceFilter;
}

const PREVIEW_WIDTH = 216;

/** A starter or brand template as the gallery shows it. */
interface GalleryEntry {
  id: string;
  name: string;
  description: string;
  contentType: ContentType;
  formatKey: string;
  channels: readonly string[];
  document: CreativeDocumentV1;
  badge: string;
  notes: string[];
  start: (title: string) => StartRequest;
}

const matches = (
  e: Pick<GalleryEntry, 'contentType' | 'formatKey' | 'channels'>,
  f: Filters,
  brandOwned: boolean,
) =>
  (f.type === 'all' || e.contentType === f.type) &&
  (f.format === 'all' || e.formatKey === f.format) &&
  (f.channel === 'all' || e.channels.includes(f.channel)) &&
  (f.source === 'all' || (f.source === 'brand') === brandOwned);

/**
 * STU-1a creation screen: start from what the document is for. Content types first, then the gallery of built-in
 * starters (instantiated with this brand's published system, previewed by the scene renderer) and approved brand
 * templates, filtered by type, channel, format and source; then blank, custom size and duplicate. Choosing a card
 * creates the document with a suggested title and opens the studio on it; "Details" shows the start first, with the
 * title editable.
 */
export function NewDocumentGallery({ disabledReason }: { disabledReason?: string }) {
  const { brandId, brand } = useBrandContext();
  const starterBrand = useStarterBrand(brandId, brand.publishedVersionId ?? null);
  const templates = useTemplates(brandId);
  const start = useStartDocument();
  const [filters, setFilters] = useState<Filters>({
    type: 'all',
    channel: 'all',
    format: 'all',
    source: 'all',
  });
  const [details, setDetails] = useState<GalleryEntry | null>(null);
  const [other, setOther] = useState<'blank' | 'custom' | 'duplicate' | null>(null);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const starters = useMemo((): Array<{ spec: StarterSpec; made: InstantiatedStarter }> => {
    const b = starterBrand.brand;
    if (!b || starterBrand.issue) return [];
    return STARTERS.map((spec) => ({ spec, made: instantiateStarter(spec, b) }));
  }, [starterBrand.brand, starterBrand.issue]);
  const colours = starterBrand.brand?.colours ?? [];
  const resolvers = usePreviewResolvers(
    useMemo(() => starters.map((s) => s.made.document), [starters]),
    colours,
  );
  const entries: GalleryEntry[] = starters.map(({ spec, made }) => ({
    id: `starter:${spec.key}`,
    name: spec.name,
    description: spec.description,
    contentType: spec.contentType,
    formatKey: spec.formatKey,
    channels: spec.channels,
    document: made.document,
    badge: 'Built-in',
    notes: made.notes,
    start: (title) => ({
      kind: 'create',
      input: {
        brandId,
        title,
        document: made.document,
        contentType: spec.contentType,
        source: { kind: 'starter', starterKey: spec.key },
      },
    }),
  }));
  const shownStarters = entries.filter((e) => matches(e, filters, false));
  const brandTemplates = (templates.data?.items ?? []).filter(
    (t) => t.state === 'active' && t.currentVersionId,
  );
  const formatsInUse = [
    ...new Set([...STARTERS.map((s) => s.formatKey), ...CONTENT_TYPES.flatMap((c) => c.formats)]),
  ];
  const startEntry = (e: GalleryEntry) => start.mutate(e.start(suggestTitle(e.contentType, e.name)));
  const busy = start.isPending;

  return (
    <div className="flex flex-col gap-4" data-testid="new-document">
      <div
        role="group"
        aria-label="Content type"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7"
      >
        <TypeTile
          label="Everything"
          description="Every start"
          pressed={filters.type === 'all'}
          onClick={() => set({ type: 'all' })}
        />
        {CONTENT_TYPES.map((c) => (
          <TypeTile
            key={c.key}
            label={c.label}
            description={c.available ? c.description : (c.unavailableReason ?? '')}
            pressed={filters.type === c.key}
            disabled={!c.available}
            onClick={() => set({ type: c.key })}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Channel" htmlFor="gallery-channel">
          <Select
            id="gallery-channel"
            size="sm"
            value={filters.channel}
            onValueChange={(channel) => set({ channel })}
            options={[
              { value: 'all', label: 'All channels' },
              ...CHANNELS.map((c) => ({ value: c.key, label: c.label })),
            ]}
          />
        </Field>
        <Field label="Format" htmlFor="gallery-format">
          <Select
            id="gallery-format"
            size="sm"
            value={filters.format}
            onValueChange={(format) => set({ format })}
            options={[
              { value: 'all', label: 'All formats' },
              ...formatsInUse.map((k) => ({ value: k, label: formatLabel(k) })),
            ]}
          />
        </Field>
        <Field label="Templates" htmlFor="gallery-source">
          <Select
            id="gallery-source"
            size="sm"
            value={filters.source}
            onValueChange={(source) => set({ source: source as SourceFilter })}
            options={[
              { value: 'all', label: 'Built-in and brand templates' },
              { value: 'builtin', label: 'Built-in starters' },
              { value: 'brand', label: 'Brand templates' },
            ]}
          />
        </Field>
      </div>

      {start.isError && (
        <StatusBanner
          tone="critical"
          title="The document could not be created"
          description={toUiError(start.error).message}
        />
      )}
      {starterBrand.isPending && <Skeleton label="Loading the brand's starters" lines={3} />}
      {starterBrand.isError && <RequestError error={starterBrand.error} onRetry={starterBrand.refetch} />}
      {starterBrand.brand && starterBrand.issue && (
        <StatusBanner
          tone="info"
          title="Built-in starters need more of the brand system"
          description={`${starterBrand.issue} You can still start from a blank canvas or a custom size.`}
        />
      )}

      <ul
        aria-label="Templates"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="template-gallery"
      >
        {filters.source !== 'builtin' &&
          brandTemplates.map((t) => (
            <BrandTemplateCard
              key={t.id}
              template={t}
              filters={filters}
              colours={colours}
              disabledReason={disabledReason}
              busy={busy}
              onStart={startEntry}
              onDetails={setDetails}
            />
          ))}
        {filters.source !== 'brand' &&
          shownStarters.map((e) => (
            <GalleryCard
              key={e.id}
              entry={e}
              resolvers={resolvers}
              disabledReason={disabledReason}
              busy={busy}
              onStart={() => startEntry(e)}
              onDetails={() => setDetails(e)}
            />
          ))}
      </ul>
      {starterBrand.brand && shownStarters.length === 0 && filters.source === 'builtin' && (
        <EmptyState
          title="No starter matches"
          description="Change the content type, channel or format filter."
        />
      )}
      {templates.isSuccess && brandTemplates.length === 0 && filters.source === 'brand' && (
        <EmptyState
          title="No approved brand templates"
          description="Save a document as a template from the studio; once a brand manager approves it, it appears here."
        />
      )}

      <section aria-labelledby="other-starts" className="flex flex-col gap-2">
        <h3 id="other-starts" className="text-sm font-semibold">
          Start another way
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <OtherStart
            title="Blank canvas"
            description="An empty page in the format you choose."
            onClick={() => setOther('blank')}
            disabledReason={disabledReason}
          />
          <OtherStart
            title="Custom size"
            description="Any width and height from 64 to 4096 px."
            onClick={() => setOther('custom')}
            disabledReason={disabledReason}
          />
          <OtherStart
            title="Duplicate a document"
            description="A copy of an existing document to change."
            onClick={() => setOther('duplicate')}
            disabledReason={disabledReason}
          />
        </div>
      </section>

      {details && (
        <DetailsDialog
          entry={details}
          resolvers={resolvers}
          busy={busy}
          disabledReason={disabledReason}
          onClose={() => setDetails(null)}
          onStart={(title) => start.mutate(details.start(title))}
        />
      )}
      {other === 'blank' && (
        <BlankDialog
          initialType={filters.type === 'all' ? 'social_post' : filters.type}
          colours={colours}
          brandVersionId={brand.publishedVersionId ?? ''}
          busy={busy}
          onClose={() => setOther(null)}
          onStart={(req) => start.mutate(req)}
        />
      )}
      {other === 'custom' && (
        <CustomDialog
          colours={colours}
          brandVersionId={brand.publishedVersionId ?? ''}
          busy={busy}
          onClose={() => setOther(null)}
          onStart={(req) => start.mutate(req)}
        />
      )}
      {other === 'duplicate' && (
        <DuplicateDialog busy={busy} onClose={() => setOther(null)} onStart={(req) => start.mutate(req)} />
      )}
    </div>
  );
}

function TypeTile(props: {
  label: string;
  description: string;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-md border p-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        props.pressed ? 'border-accent bg-secondary' : 'border-border hover:bg-muted',
        props.disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
      )}
    >
      <span className="font-medium">{props.label}</span>
      <span className="text-xs text-muted-foreground">{props.description}</span>
    </button>
  );
}

function Facts({
  entry,
}: {
  entry: Pick<GalleryEntry, 'contentType' | 'formatKey' | 'document' | 'description'>;
}) {
  const page = entry.document.pages[0];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
      <dt className="text-muted-foreground">Use</dt>
      <dd>{entry.description}</dd>
      <dt className="text-muted-foreground">Format</dt>
      <dd>{formatLabel(entry.formatKey)}</dd>
      <dt className="text-muted-foreground">Size</dt>
      <dd>{page ? dimensionsLabel(page.width, page.height) : '–'}</dd>
      <dt className="text-muted-foreground">Pages</dt>
      <dd>{entry.document.pages.length}</dd>
    </dl>
  );
}

function GalleryCard({
  entry,
  resolvers,
  disabledReason,
  busy,
  onStart,
  onDetails,
}: {
  entry: GalleryEntry;
  resolvers: PreviewResolvers;
  disabledReason?: string;
  busy: boolean;
  onStart: () => void;
  onDetails: () => void;
}) {
  const page = entry.document.pages[0];
  const headingId = `card-${entry.id.replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      aria-labelledby={headingId}
      data-testid="gallery-card"
    >
      <div className="flex justify-center">
        {page && (
          <ScenePreview
            page={page}
            width={PREVIEW_WIDTH}
            resolvers={resolvers}
            label={`Preview of ${entry.name}, ${page.width} by ${page.height}`}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={headingId} className="text-sm font-semibold">
          {entry.name}
        </h4>
        <Badge glyph={false}>{entry.badge}</Badge>
        <Badge tone="neutral" glyph={false}>
          {contentTypeOf(entry.contentType).label}
        </Badge>
      </div>
      <Facts entry={entry} />
      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={onStart} disabled={busy} disabledReason={disabledReason}>
          Use {entry.name}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDetails}>
          Details
        </Button>
      </div>
    </li>
  );
}

/** A brand template: its approved version is loaded for the preview and the facts, then filtered like a starter. */
function BrandTemplateCard({
  template,
  filters,
  colours,
  disabledReason,
  busy,
  onStart,
  onDetails,
}: {
  template: TemplateDto;
  filters: Filters;
  colours: ReadonlyArray<{ key: string; value: string }>;
  disabledReason?: string;
  busy: boolean;
  onStart: (e: GalleryEntry) => void;
  onDetails: (e: GalleryEntry) => void;
}) {
  const { brandId } = useBrandContext();
  const detail = useTemplate(template.id);
  const version = detail.data?.selectedVersion ?? null;
  const document = version?.document;
  const resolvers = usePreviewResolvers(
    useMemo(() => (document ? [document] : []), [document]),
    colours,
  );
  if (detail.isPending)
    return (
      <li className="rounded-md border border-border p-3">
        <Skeleton label={`Loading ${template.name}`} lines={3} />
      </li>
    );
  if (!document || !version) return null;
  const page = document.pages[0];
  const entry: GalleryEntry = {
    id: `template:${template.id}`,
    name: template.name,
    description: `Brand template, version ${version.number}, approved for this brand.`,
    contentType: document.contentType ?? 'custom',
    formatKey: page?.formatKey ?? '',
    channels: formatFor(page?.formatKey ?? '')?.providerKeys ?? [],
    document,
    badge: 'Brand template',
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
  if (!matches(entry, filters, true)) return null;
  return (
    <GalleryCard
      entry={entry}
      resolvers={resolvers}
      disabledReason={disabledReason}
      busy={busy}
      onStart={() => onStart(entry)}
      onDetails={() => onDetails(entry)}
    />
  );
}

function OtherStart(props: {
  title: string;
  description: string;
  onClick: () => void;
  disabledReason?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-3">
      <span className="text-sm font-medium">{props.title}</span>
      <span className="text-xs text-muted-foreground">{props.description}</span>
      <div className="mt-1">
        <Button size="sm" onClick={props.onClick} disabledReason={props.disabledReason}>
          {props.title}…
        </Button>
      </div>
    </div>
  );
}

/** The confirm step: the title is suggested and editable; the studio opens on the created document. */
function StartForm({
  defaultTitle,
  busy,
  disabledReason,
  invalid,
  onStart,
  children,
}: {
  defaultTitle: string;
  busy: boolean;
  disabledReason?: string;
  invalid?: string | null;
  onStart: (title: string) => void;
  children?: ReactNode;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim() && !invalid) onStart(title.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      {children}
      <Field
        label="New document title"
        htmlFor="doc-title"
        error={title.trim() ? undefined : 'A title is required'}
      >
        <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </Field>
      <DialogActions>
        <DialogClose asChild>
          <Button type="button">Cancel</Button>
        </DialogClose>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !title.trim() || Boolean(invalid)}
          disabledReason={disabledReason ?? invalid ?? undefined}
        >
          {busy ? 'Creating…' : 'Create and open'}
        </Button>
      </DialogActions>
    </form>
  );
}

function DetailsDialog({
  entry,
  resolvers,
  busy,
  disabledReason,
  onClose,
  onStart,
}: {
  entry: GalleryEntry;
  resolvers: PreviewResolvers;
  busy: boolean;
  disabledReason?: string;
  onClose: () => void;
  onStart: (title: string) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={entry.name} description={entry.description}>
        <div className="flex flex-col gap-3">
          <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Pages">
            {entry.document.pages.map((p, i) => (
              <ScenePreview
                key={p.id}
                page={p}
                width={entry.document.pages.length > 1 ? 140 : 260}
                resolvers={resolvers}
                label={`Page ${i + 1}: ${p.name}`}
                className="shrink-0"
              />
            ))}
          </div>
          <Facts entry={entry} />
          {entry.notes.map((n) => (
            <p key={n} className="text-xs text-status-warning">
              {n}
            </p>
          ))}
          <StartForm
            defaultTitle={suggestTitle(entry.contentType, entry.name)}
            busy={busy}
            disabledReason={disabledReason}
            onStart={onStart}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BlankDialog({
  initialType,
  colours,
  brandVersionId,
  busy,
  onClose,
  onStart,
}: {
  initialType: ContentType;
  colours: ReadonlyArray<{ key: string; value: string; role: string }>;
  brandVersionId: string;
  busy: boolean;
  onClose: () => void;
  onStart: (req: StartRequest) => void;
}) {
  const { brandId } = useBrandContext();
  const startable = CONTENT_TYPES.filter((c) => c.available);
  const [type, setType] = useState<ContentType>(
    contentTypeOf(initialType).available ? initialType : 'social_post',
  );
  const option = contentTypeOf(type);
  const [formatKey, setFormatKey] = useState(option.formats[0] ?? 'square_1080');
  const format = formatFor(formatKey);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Blank canvas" description="An empty page with the brand's background colour.">
        <StartForm
          defaultTitle={suggestTitle(type, 'Blank')}
          busy={busy}
          onStart={(title) =>
            onStart({
              kind: 'create',
              input: {
                brandId,
                title,
                contentType: type,
                document: blankDocument(formatKey, { brandVersionId, colours }, type, option.pages),
                source: { kind: 'blank' },
              },
            })
          }
        >
          <Field label="Content type" htmlFor="blank-type">
            <Select
              id="blank-type"
              value={type}
              onValueChange={(v) => {
                setType(v as ContentType);
                setFormatKey(contentTypeOf(v as ContentType).formats[0] ?? 'square_1080');
              }}
              options={startable.map((c) => ({ value: c.key, label: c.label }))}
            />
          </Field>
          <Field
            label="Format"
            htmlFor="blank-format"
            hint={
              format
                ? `${dimensionsLabel(format.width, format.height)} · ${option.pages} page${option.pages > 1 ? 's' : ''}`
                : undefined
            }
          >
            <Select
              id="blank-format"
              value={formatKey}
              onValueChange={setFormatKey}
              options={option.formats.map((k) => ({ value: k, label: formatLabel(k) }))}
            />
          </Field>
        </StartForm>
      </DialogContent>
    </Dialog>
  );
}

function CustomDialog({
  colours,
  brandVersionId,
  busy,
  onClose,
  onStart,
}: {
  colours: ReadonlyArray<{ key: string; value: string; role: string }>;
  brandVersionId: string;
  busy: boolean;
  onClose: () => void;
  onStart: (req: StartRequest) => void;
}) {
  const { brandId } = useBrandContext();
  const [width, setWidth] = useState('1500');
  const [height, setHeight] = useState('500');
  const w = Number(width);
  const h = Number(height);
  const issue = width && height ? customFormatIssue(w, h) : 'Enter a width and a height';
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Custom size"
        description="Any size the renderer can export: 64 to 4096 px on each side, the long side at most 8 times the short one."
      >
        <StartForm
          defaultTitle={suggestTitle('custom', 'Custom layout')}
          busy={busy}
          invalid={issue}
          onStart={(title) =>
            onStart({
              kind: 'create',
              input: {
                brandId,
                title,
                contentType: 'custom',
                document: blankDocument(customFormatKey(w, h), { brandVersionId, colours }, 'custom'),
                source: { kind: 'custom' },
              },
            })
          }
        >
          <div className="grid grid-cols-2 gap-2">
            <Field label="Width (px)" htmlFor="custom-width">
              <Input
                id="custom-width"
                type="number"
                inputMode="numeric"
                min={64}
                max={4096}
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
                value={height}
                onChange={(e) => setHeight(e.target.value)}
              />
            </Field>
          </div>
          <p
            role="status"
            aria-live="polite"
            className={cn('text-xs', issue ? 'text-status-critical' : 'text-muted-foreground')}
          >
            {issue ?? dimensionsLabel(w, h)}
          </p>
        </StartForm>
      </DialogContent>
    </Dialog>
  );
}

function DuplicateDialog({
  busy,
  onClose,
  onStart,
}: {
  busy: boolean;
  onClose: () => void;
  onStart: (req: StartRequest) => void;
}) {
  const { brandId } = useBrandContext();
  const documents = useDocuments(brandId);
  const [documentId, setDocumentId] = useState<string>('');
  const chosen = documents.items.find((d) => d.id === documentId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Duplicate a document"
        description="The copy starts from the document's latest saved revision; the original is not changed."
      >
        {documents.isPending && <Skeleton label="Loading documents" lines={2} />}
        {documents.isError && (
          <RequestError error={documents.error} onRetry={() => void documents.refetch()} />
        )}
        {documents.isSuccess && documents.items.length === 0 && (
          <EmptyState title="No documents yet" description="Create one from a template first." />
        )}
        {documents.items.length > 0 && (
          <div className="flex flex-col gap-3">
            <Field label="Document to copy" htmlFor="duplicate-source">
              <Select
                id="duplicate-source"
                value={documentId}
                placeholder="Choose a document"
                onValueChange={setDocumentId}
                options={documents.items.map((d) => ({ value: d.id, label: d.title }))}
              />
            </Field>
            {/* Keyed by the source so the suggested title follows the choice. */}
            <StartForm
              key={documentId}
              defaultTitle={chosen ? `${chosen.title} (copy)`.slice(0, 200) : ''}
              busy={busy}
              invalid={chosen ? null : 'Choose a document to copy'}
              onStart={(title) => onStart({ kind: 'duplicate', input: { documentId, title } })}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
