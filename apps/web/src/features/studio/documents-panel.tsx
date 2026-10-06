import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, EmptyState, Field, Input, Skeleton, StatusBanner } from '@oremedia/ui';
import { Section } from '../../components/section';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { Select } from '../../components/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/dropdown-menu';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useDocuments } from './use-document';
import { useStartDocument } from './create/use-create-document';

/** Where documents are made (STU-1a): the Studio's creation screen; the home page links to it. */
export function NewDocumentLink({ disabledReason }: { disabledReason?: string }) {
  const { companyId, brandId } = useBrandContext();
  if (disabledReason)
    return (
      <Button variant="primary" disabledReason={disabledReason}>
        New document
      </Button>
    );
  return (
    <Button asChild variant="primary">
      <Link to={brandPath(companyId, brandId, 'studio')}>New document</Link>
    </Button>
  );
}

type DocumentRow = ReturnType<typeof useDocuments>['items'][number];

const RECENT = 4;

/** When a document last changed, as the interface shows it: minutes or hours today, otherwise the weekday or date. */
const whenChanged = (iso: string, now = new Date()): string => {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/**
 * The brand's most recent documents on the home (creative.documents.list, newest first): the title, what it is
 * and when it last changed; each opens in the studio. The Studio section lists them all.
 */
export function RecentDocuments() {
  const { companyId, brandId } = useBrandContext();
  const documents = useDocuments(brandId, { archived: false });
  const recent = documents.items.slice(0, RECENT);
  if (documents.isPending) return <Skeleton label="Loading documents" lines={3} />;
  if (documents.isError)
    return (
      <RequestError
        error={documents.error}
        onRetry={() => void documents.refetch()}
        title="Documents could not be loaded"
      />
    );
  if (recent.length === 0)
    return (
      <EmptyState
        title="No documents yet"
        description="Start one in the studio; the brand's documents are listed here as they change."
      />
    );
  return (
    <ul className="flex flex-col" aria-label="Recent documents" data-testid="recent-documents">
      {recent.map((d) => (
        <li key={d.id} className="border-b border-border last:border-b-0">
          <Link
            to={brandPath(companyId, brandId, `studio/${encodeURIComponent(d.id)}`)}
            className="flex items-center justify-between gap-3 py-[11px] text-sm hover:text-accent-ink"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate">{d.title}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {d.kind === 'video' ? 'Motion' : 'Still'}
              </span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {whenChanged(d.updatedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * G12: a document's menu in the Continue list: duplicate it, archive it (it leaves the default list) or, in the
 * archived list, restore it (creative.documents.archive / unarchive, version-checked). Nothing else about the
 * document changes.
 */
function DocumentMenu({ document, onDuplicate }: { document: DocumentRow; onDuplicate: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const archived = document.archivedAt !== null;
  const options = {
    ...mutationIntent(intent.key),
    onSettled: () => {
      intent.renew();
      void queryClient.invalidateQueries(trpc.creative.documents.list.pathFilter());
    },
  };
  const archive = useMutation(trpc.creative.documents.archive.mutationOptions(options));
  const unarchive = useMutation(trpc.creative.documents.unarchive.mutationOptions(options));
  const failed = archive.error ?? unarchive.error;
  const input = { documentId: document.id, expectedVersion: document.version };
  return (
    <>
      {failed && (
        <span role="alert" className="text-xs text-status-critical">
          {toUiError(failed).message}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label={`Actions for ${document.title}`}>
            <span aria-hidden="true">⋯</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {archived ? (
            <DropdownMenuItem onSelect={() => unarchive.mutate(input)}>Restore from archive</DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={onDuplicate}>Duplicate…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => archive.mutate(input)}>Archive</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** The interface's thumbnail of a document in a list: a still frame in the ink, a motion frame in the accent. */
function KindFrame({ kind }: { kind: DocumentRow['kind'] }) {
  return (
    <span aria-hidden="true" className="flex h-11 w-[52px] shrink-0 items-center justify-center">
      <span
        className={kind === 'video' ? 'h-10 w-[22px] rounded-sm bg-accent' : 'h-10 w-8 rounded-sm bg-primary'}
      />
    </span>
  );
}

/**
 * The create screen's "Continue" list: the brand's documents from the server, newest first, page by page, as the
 * interface's rows (kind, title, when it last changed); every row opens the studio. Archived documents are listed
 * only when asked for (G12); each row's menu duplicates, archives or restores it.
 */
export function Documents() {
  const { companyId, brandId } = useBrandContext();
  const [showArchived, setShowArchived] = useState(false);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const documents = useDocuments(brandId, { archived: showArchived });
  const filter = (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={showArchived}
        onChange={(e) => setShowArchived(e.target.checked)}
        data-testid="show-archived-documents"
      />
      Show archived documents only
    </label>
  );
  return (
    <Section id="continue" title="Continue" action={filter}>
      {documents.isPending && <Skeleton label="Loading documents" lines={3} />}
      {documents.isError && (
        <RequestError
          error={documents.error}
          onRetry={() => void documents.refetch()}
          title="Documents could not be loaded"
        />
      )}
      {documents.isSuccess &&
        documents.items.length === 0 &&
        (showArchived ? (
          <EmptyState title="No archived documents" description="Archived documents are listed here." />
        ) : (
          <EmptyState
            title="No documents yet"
            description="Start one above: choose Still or Motion, a size and a layout. Every document of the brand is listed here."
          />
        ))}
      {documents.items.length > 0 && (
        <>
          <ul
            className="-mt-2 flex flex-col"
            aria-label={showArchived ? 'Archived documents' : 'Documents'}
            data-testid="documents"
          >
            {documents.items.map((d) => (
              <li key={d.id} className="flex items-center gap-2 border-b border-border last:border-b-0">
                <Link
                  to={brandPath(companyId, brandId, `studio/${encodeURIComponent(d.id)}`)}
                  className="grid min-w-0 flex-1 grid-cols-[52px_minmax(0,1fr)_auto_16px] items-center gap-3.5 rounded-md px-1 py-2.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <KindFrame kind={d.kind} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-base font-bold">{d.title}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {d.kind === 'video' ? 'Motion' : 'Still'}
                      {d.archivedAt && ' · Archived'}
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {whenChanged(d.updatedAt)}
                  </span>
                  <span aria-hidden="true" className="text-muted-foreground">
                    →
                  </span>
                </Link>
                <DocumentMenu document={d} onDuplicate={() => setDuplicating(d.id)} />
              </li>
            ))}
          </ul>
          <LoadMore
            shown={documents.items.length}
            hasNextPage={documents.hasNextPage}
            isFetchingNextPage={documents.isFetchingNextPage}
            onLoadMore={() => void documents.fetchNextPage()}
            noun="documents"
            className="px-0"
          />
        </>
      )}
      {duplicating && (
        <DuplicateDialog initialDocumentId={duplicating} onClose={() => setDuplicating(null)} />
      )}
    </Section>
  );
}

/** The confirm step of the duplicate dialog: the title is suggested and editable. */
function StartForm({
  defaultTitle,
  busy,
  invalid,
  onStart,
}: {
  defaultTitle: string;
  busy: boolean;
  invalid: string | null;
  onStart: (title: string) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim() && !invalid) onStart(title.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
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
          disabledReason={invalid ?? undefined}
        >
          {busy ? 'Creating…' : 'Create and open'}
        </Button>
      </DialogActions>
    </form>
  );
}

/**
 * STU-1a: a copy of a document from its latest saved revision (creative.documents.duplicate), opened from a row's
 * menu with that document chosen; another can be picked in the dialog. The studio opens on the copy.
 */
function DuplicateDialog({ initialDocumentId, onClose }: { initialDocumentId: string; onClose: () => void }) {
  const { brandId } = useBrandContext();
  const documents = useDocuments(brandId);
  const start = useStartDocument({ onCreated: onClose });
  const [documentId, setDocumentId] = useState(initialDocumentId);
  const chosen = documents.items.find((d) => d.id === documentId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Duplicate a document"
        description="The copy starts from the document's latest saved revision; the original is not changed."
      >
        {start.isError && (
          <StatusBanner
            tone="critical"
            title="The document could not be created"
            description={toUiError(start.error).message}
          />
        )}
        {documents.isPending && <Skeleton label="Loading documents" lines={2} />}
        {documents.isError && (
          <RequestError error={documents.error} onRetry={() => void documents.refetch()} />
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
            {/* Keyed by the source (and whether it has loaded) so the suggested title follows the choice. */}
            <StartForm
              key={`${documentId}:${chosen ? 'loaded' : 'waiting'}`}
              defaultTitle={chosen ? `${chosen.title} (copy)`.slice(0, 200) : ''}
              busy={start.isPending}
              invalid={chosen ? null : 'Choose a document to copy'}
              onStart={(title) => start.mutate({ kind: 'duplicate', input: { documentId, title } })}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
