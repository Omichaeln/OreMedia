import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SOURCE_DOCUMENT_MAX_BYTES,
  SOURCE_PASTE_MAX_CHARS,
  type BrandSourceReason,
  type BrandSourceStatus,
} from '@oremedia/contracts/brand-assist';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Skeleton,
  StatusBanner,
  Textarea,
  type Tone,
} from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandAssetsOfKind } from '../assets/use-assets';
import { useBrandContext } from './brand-context';
import { useBrandSources, useDocumentSourceUpload, type BrandSourceDto } from './use-assist';

/**
 * BSC-4 sources of the guided setup: what can be read (said before anything is added), a website, documents,
 * pasted text and the brand's own approved assets, and each source with its status in words: waiting to be read,
 * read (how much), or why it could not be and what to do. A person picks which sources a job reads.
 */

export const SOURCE_STATUS: Record<BrandSourceStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Read when you start', tone: 'neutral' },
  captured: { label: 'Read', tone: 'good' },
  unsupported: { label: 'Cannot be read', tone: 'warning' },
  inaccessible: { label: 'Could not be reached', tone: 'warning' },
  failed: { label: 'Reading failed', tone: 'critical' },
};

/** Why a source could not be used, and what to do about it. */
export const SOURCE_REASON: Record<BrandSourceReason, string> = {
  not_https: 'The address must start with https://. Use the secure address of the site.',
  blocked_address: 'The address points to a private or reserved network, so it cannot be read.',
  robots_disallowed:
    'The site asks automated readers not to read this page (robots.txt). Paste the text or upload a document instead.',
  http_error: 'The site answered with an error. Check that the address opens in a browser.',
  timeout: 'The site took too long to answer. Try again later.',
  too_large:
    'It is larger than can be read (2 MB a page, 20 MB a file). Upload a smaller file or paste the text.',
  not_html: 'This address is not a web page. Upload the file instead.',
  no_text: 'No readable text was found in it.',
  redirect_elsewhere: 'The address sends visitors to another website. Add that website’s address instead.',
  unreachable: 'The site could not be reached. Check the address.',
  scanned_pdf:
    'This PDF has no selectable text (it may be scanned images). Export it with text, or paste the text.',
  encrypted: 'The file is password-protected. Remove the password and upload it again.',
  corrupt: 'The file could not be opened. Check that it opens on your computer and upload it again.',
  unsupported_type: 'This kind of file cannot be read. Use PDF, Word (.docx), Markdown or plain text.',
  not_uploaded: 'The file did not finish uploading. Remove it and add it again.',
  asset_not_usable: 'This asset can no longer be used.',
  capture_failed: 'Reading it failed. Try again; if it keeps failing, paste the text instead.',
  processing_limit:
    'It took too long or was too complex to read safely. Paste the text, or upload a simpler file.',
  expired: 'Its text was removed after the retention period. Add it again to use it.',
};

const KIND_LABEL: Record<BrandSourceDto['kind'], string> = {
  url: 'Website',
  document: 'Document',
  text: 'Pasted text',
  brand_asset: 'Brand asset',
};

export const isUsableSource = (s: BrandSourceDto) =>
  (s.status === 'captured' && !s.duplicateOfSourceId) || s.status === 'pending';

function sizeText(s: BrandSourceDto): string | null {
  if (s.status !== 'captured' || s.charCount === null) return null;
  const pages = s.pages.length > 1 ? `${s.pages.length} pages, ` : '';
  return `${pages}${s.charCount.toLocaleString()} characters${s.truncated ? ' (the rest was cut)' : ''}`;
}

export function SourceExplainer() {
  return (
    <details className="rounded-md border border-border px-3 py-2 text-sm" data-testid="source-explainer">
      <summary className="cursor-pointer font-medium">What can be read, and how</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        <li>
          A website: its home page and up to nine more pages of the same site chosen from its menu and sitemap
          (about, products, services first). Pages the site asks not to be read are skipped.
        </li>
        <li>
          Documents: PDF (with selectable text), Word (.docx), Markdown and plain text, up to 20 MB each.
        </li>
        <li>Pasted text: guidelines, approved copy, notes from the team.</li>
        <li>
          Your approved assets: guideline PDFs are read; logos and images are described by their name and alt
          text only.
        </li>
      </ul>
      <p className="mt-2 text-muted-foreground">
        What is read is used only as evidence for suggestions. It never changes the brand system by itself:
        you review every suggestion first.
      </p>
    </details>
  );
}

/** The forms that add sources: a website, documents, pasted text and approved assets. */
export function SourceAdders() {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [url, setUrl] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [paste, setPaste] = useState('');
  const [status, setStatus] = useState('');
  const refresh = () => void queryClient.invalidateQueries(trpc.brand.sources.pathFilter());
  const add = useMutation(
    trpc.brand.sources.add.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setStatus(res.duplicate ? 'Already added: the existing source is kept.' : 'Source added.');
        refresh();
      },
      onError: () => intent.renew(),
    }),
  );
  const upload = useDocumentSourceUpload(brandId);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const assets = useBrandAssetsOfKind(brandId, ['reference', 'template', 'logo']);
  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    const errors: string[] = [];
    for (const file of files) {
      if (file.size > SOURCE_DOCUMENT_MAX_BYTES) {
        errors.push(`${file.name}: larger than 20 MB.`);
        continue;
      }
      try {
        await upload.mutateAsync(file);
      } catch (err) {
        errors.push(toUiError(err).message);
      }
    }
    setUploadErrors(errors);
    setStatus(files.length - errors.length > 0 ? `${files.length - errors.length} document(s) added.` : '');
  };
  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    add.mutate(
      { kind: 'url', brandId, url: /^https?:\/\//i.test(value) ? value : `https://${value}` },
      { onSuccess: () => setUrl('') },
    );
  };
  const submitPaste = (e: FormEvent) => {
    e.preventDefault();
    if (!pasteTitle.trim() || !paste.trim()) return;
    add.mutate(
      { kind: 'text', brandId, title: pasteTitle.trim(), text: paste },
      {
        onSuccess: () => {
          setPaste('');
          setPasteTitle('');
        },
      },
    );
  };
  const error = add.error ? toUiError(add.error) : null;
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="source-adders">
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <form className="flex flex-col gap-2 rounded-md border border-border p-3" onSubmit={submitUrl}>
        <Field label="Website" htmlFor="source-url" hint="The address of your website or a page of it.">
          <Input
            id="source-url"
            inputMode="url"
            placeholder="https://www.example.com"
            value={url}
            maxLength={1000}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={add.isPending || !url.trim()}>
            Add website
          </Button>
        </div>
      </form>
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm font-medium">Documents</p>
        <p className="text-xs text-muted-foreground">
          PDF, Word (.docx), Markdown or text, up to 20 MB each.
        </p>
        <label className="inline-flex w-fit cursor-pointer items-center rounded-md border border-border bg-secondary px-2.5 py-1.5 text-sm focus-within:ring-2 focus-within:ring-ring hover:bg-muted">
          {upload.isPending ? 'Uploading…' : 'Upload documents'}
          <input
            type="file"
            multiple
            accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
            className="sr-only"
            disabled={upload.isPending}
            onChange={(e) => void onFiles(e)}
          />
        </label>
        {uploadErrors.length > 0 && (
          <StatusBanner
            tone="critical"
            title="Some documents were not added"
            description={uploadErrors.join(' ')}
          />
        )}
      </div>
      <form
        className="flex flex-col gap-2 rounded-md border border-border p-3 lg:col-span-2"
        onSubmit={submitPaste}
      >
        <Field label="Title" htmlFor="source-paste-title" hint="What the text is, e.g. Tone of voice notes.">
          <Input
            id="source-paste-title"
            value={pasteTitle}
            maxLength={200}
            onChange={(e) => setPasteTitle(e.target.value)}
          />
        </Field>
        <Field label="Text" htmlFor="source-paste">
          <Textarea
            id="source-paste"
            rows={4}
            maxLength={SOURCE_PASTE_MAX_CHARS}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Paste guidelines, approved copy or notes."
          />
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={add.isPending || !pasteTitle.trim() || !paste.trim()}>
            Add text
          </Button>
        </div>
      </form>
      {assets.isSuccess && assets.data.items.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 lg:col-span-2">
          <p className="text-sm font-medium">Your approved assets</p>
          <ul className="flex flex-wrap gap-2">
            {assets.data.items.slice(0, 24).map((a) => (
              <li key={a.assetVersionId}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={add.isPending}
                  onClick={() =>
                    add.mutate({ kind: 'brand_asset', brandId, assetVersionId: a.assetVersionId })
                  }
                >
                  Use {a.kind}: {a.altText ?? a.semanticRole ?? 'untitled'}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <StatusBanner
          tone="critical"
          title="Not added"
          description={[error.message, ...error.details.map((d) => d.issue.replaceAll('_', ' '))].join(' · ')}
          className="lg:col-span-2"
        />
      )}
    </div>
  );
}

/** The sources with their status; `selected` (when given) picks which ones a job reads. */
export function SourceList({
  selected,
  onToggle,
  polling = false,
}: {
  selected?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  polling?: boolean;
}) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const sources = useBrandSources(brandId, polling);
  const intent = useIntentKey();
  const remove = useMutation(
    trpc.brand.sources.remove.mutationOptions({
      ...mutationIntent(intent.key),
      onSettled: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.brand.sources.pathFilter());
      },
    }),
  );
  if (sources.isPending) return <Skeleton label="Loading sources" lines={2} />;
  if (sources.isError) return <RequestError error={sources.error} onRetry={() => void sources.refetch()} />;
  const items = sources.data.items;
  if (items.length === 0)
    return (
      <EmptyState
        title="No sources yet"
        description="Add your website, documents or pasted text above. Each one is read when you start."
      />
    );
  const titleOf = (id: string) => items.find((x) => x.id === id)?.title ?? 'another source';
  return (
    <ul
      className="flex flex-col divide-y divide-border rounded-md border border-border"
      aria-label="Sources"
      data-testid="source-list"
    >
      {items.map((s) => {
        const status = SOURCE_STATUS[s.status];
        const size = sizeText(s);
        const usable = isUsableSource(s);
        return (
          <li key={s.id} className="flex flex-wrap items-start gap-3 px-3 py-2" data-testid="source-row">
            {selected && onToggle && (
              <input
                type="checkbox"
                className="mt-1"
                aria-label={`Use ${s.title}`}
                checked={selected.has(s.id)}
                disabled={!usable}
                onChange={() => onToggle(s.id)}
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{s.title}</span>
                <Badge tone="neutral" glyph={false}>
                  {KIND_LABEL[s.kind]}
                </Badge>
                <Badge tone={status.tone} data-testid="source-status">
                  {status.label}
                </Badge>
              </p>
              {s.url && <p className="truncate text-xs text-muted-foreground">{s.url}</p>}
              {size && <p className="text-xs text-muted-foreground">{size}</p>}
              {s.duplicateOfSourceId && (
                <p className="text-xs text-muted-foreground">
                  Same text as {titleOf(s.duplicateOfSourceId)}: it is read once.
                </p>
              )}
              {s.reason && (
                <p className="text-xs text-status-critical" data-testid="source-reason">
                  {SOURCE_REASON[s.reason]}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ brandId, sourceId: s.id, expectedVersion: s.version })}
            >
              Remove<span className="sr-only"> {s.title}</span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
