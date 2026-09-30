import { Badge, Skeleton } from '@oremedia/ui';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { useDocuments } from '../studio/use-document';
import type { PackageDocumentDto } from './use-content';

export interface DocumentPickerProps {
  brandId: string;
  /** The documents the current revision publishes with; they are listed first, with their pin state. */
  pinned: readonly PackageDocumentDto[];
  selected: readonly string[];
  onToggle: (documentId: string) => void;
  legend: string;
}

/**
 * The creative documents a package revision publishes with, chosen from the brand's documents (spec 6.3: the
 * revision pins their current creative revisions). The pinned ones come first so unchecking one is a visible act.
 */
export function DocumentPicker({ brandId, pinned, selected, onToggle, legend }: DocumentPickerProps) {
  const documents = useDocuments(brandId);
  const pinnedIds = new Set(pinned.map((d) => d.documentId));
  const others = documents.items.filter((d) => !pinnedIds.has(d.id));
  return (
    <fieldset className="flex flex-col gap-1" data-testid="document-picker">
      <legend className="text-xs font-medium text-muted-foreground">{legend}</legend>
      {pinned.map((d) => (
        <label key={d.documentId} className="flex flex-wrap items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(d.documentId)}
            onChange={() => onToggle(d.documentId)}
          />
          <span>{d.title}</span>
          <span className="text-xs text-muted-foreground">· pinned</span>
          {d.stale && <Badge tone="warning">Stale: newer revision exists</Badge>}
        </label>
      ))}
      {documents.isPending && <Skeleton label="Loading documents" lines={2} />}
      {documents.isError && (
        <RequestError
          error={documents.error}
          onRetry={() => void documents.refetch()}
          title="Documents could not be loaded"
        />
      )}
      {documents.isSuccess && pinned.length === 0 && others.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No documents in this brand yet; create one from the brand home.
        </p>
      )}
      {others.map((d) => (
        <label key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
          <input type="checkbox" checked={selected.includes(d.id)} onChange={() => onToggle(d.id)} />
          <span>{d.title}</span>
        </label>
      ))}
      <LoadMore
        shown={others.length}
        hasNextPage={documents.hasNextPage}
        isFetchingNextPage={documents.isFetchingNextPage}
        onLoadMore={() => void documents.fetchNextPage()}
        noun="other documents"
        className="px-0"
      />
    </fieldset>
  );
}
