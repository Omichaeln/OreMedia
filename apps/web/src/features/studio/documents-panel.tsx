import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Skeleton } from '@oremedia/ui';
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
 * G12: a document's menu in the index: archive (it leaves the default list) or, in the archived list, restore it
 * (creative.documents.archive / unarchive, version-checked). Nothing else about the document changes.
 */
function DocumentMenu({ document }: { document: DocumentRow }) {
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
            <DropdownMenuItem onSelect={() => archive.mutate(input)}>Archive</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * The brand's documents from the server, newest first, page by page; every title opens the studio. Archived documents
 * are listed only when asked for (G12), each with a menu to archive or restore it.
 */
export function Documents() {
  const { companyId, brandId } = useBrandContext();
  const [showArchived, setShowArchived] = useState(false);
  const documents = useDocuments(brandId, { archived: showArchived });
  const filter = (
    <label className="flex items-center gap-2 self-end text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={showArchived}
        onChange={(e) => setShowArchived(e.target.checked)}
        data-testid="show-archived-documents"
      />
      Show archived documents only
    </label>
  );
  if (documents.isPending)
    return (
      <div className="flex flex-col gap-2">
        {filter}
        <Skeleton label="Loading documents" lines={3} />
      </div>
    );
  if (documents.isError)
    return (
      <div className="flex flex-col gap-2">
        {filter}
        <RequestError
          error={documents.error}
          onRetry={() => void documents.refetch()}
          title="Documents could not be loaded"
        />
      </div>
    );
  if (documents.items.length === 0)
    return (
      <div className="flex flex-col gap-2">
        {filter}
        {showArchived ? (
          <EmptyState title="No archived documents" description="Archived documents are listed here." />
        ) : (
          <EmptyState
            title="No documents yet"
            description="Start one from a template above; every document of the brand is listed here."
          />
        )}
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      {filter}
      <ul
        className="flex flex-col divide-y divide-border"
        aria-label={showArchived ? 'Archived documents' : 'Documents'}
        data-testid="documents"
      >
        {documents.items.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 py-2.5">
            <Link
              to={brandPath(companyId, brandId, `studio/${encodeURIComponent(d.id)}`)}
              className="min-w-0 truncate text-sm font-medium underline-offset-2 hover:underline"
            >
              {d.title}
            </Link>
            <span className="flex shrink-0 items-center gap-2">
              {d.kind === 'video' && <Badge glyph={false}>Video</Badge>}
              {d.archivedAt && <Badge tone="neutral">Archived</Badge>}
              <span className="font-mono text-xs text-muted-foreground">
                {new Date(d.updatedAt).toLocaleDateString()}
              </span>
              <DocumentMenu document={d} />
            </span>
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
    </div>
  );
}
