import { Link } from 'react-router';
import { Button, EmptyState, Skeleton } from '@oremedia/ui';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
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

/** The brand's documents from the server, newest first, page by page; every title opens the studio. */
export function Documents() {
  const { companyId, brandId } = useBrandContext();
  const documents = useDocuments(brandId);
  if (documents.isPending) return <Skeleton label="Loading documents" lines={3} />;
  if (documents.isError)
    return (
      <RequestError
        error={documents.error}
        onRetry={() => void documents.refetch()}
        title="Documents could not be loaded"
      />
    );
  if (documents.items.length === 0)
    return (
      <EmptyState
        title="No documents yet"
        description="Start one from a template above; every document of the brand is listed here."
      />
    );
  return (
    <div className="flex flex-col">
      <ul className="flex flex-col divide-y divide-border" aria-label="Documents" data-testid="documents">
        {documents.items.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 py-2.5">
            <Link
              to={brandPath(companyId, brandId, `studio/${encodeURIComponent(d.id)}`)}
              className="min-w-0 truncate text-sm font-medium underline-offset-2 hover:underline"
            >
              {d.title}
            </Link>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {new Date(d.updatedAt).toLocaleDateString()}
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
