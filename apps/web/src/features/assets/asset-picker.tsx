import { useState } from 'react';
import type { AssetKind, AssetPurpose } from '@oremedia/contracts/assets';
import { Badge, Button, EmptyState, Input, Skeleton } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { AssetThumb } from './asset-thumb';
import { useAssetSearch, type AssetRefDto } from './use-assets';

export interface AssetPickerDialogProps {
  brandId: string;
  purpose: AssetPurpose;
  /** The asset kinds the use takes (an article image is a still); every kind of the purpose when absent. */
  kinds?: readonly AssetKind[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen asset (its current version); the dialog closes itself. */
  onPick: (asset: AssetRefDto) => void;
  title?: string;
}

/**
 * The asset library as a picker (spec 9.2: the eligibility search offers approved assets with rights for the
 * purpose, never the rest), in a dialog so a form can take one asset version without leaving the page. The same
 * grid the studio's assets panel shows; the server authorises every referenced version again on save.
 */
export function AssetPickerDialog({
  brandId,
  purpose,
  kinds,
  open,
  onOpenChange,
  onPick,
  title = 'Choose an image',
}: AssetPickerDialogProps) {
  const [query, setQuery] = useState('');
  const search = useAssetSearch(brandId, purpose, query, kinds);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description="Approved assets with usage rights for this use. The chosen version is pinned; a later upload never changes the article."
        data-testid="asset-picker"
      >
        <div className="flex flex-col gap-2">
          <Input
            aria-label="Search eligible assets"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8"
          />
          {search.isPending && <Skeleton label="Loading assets" lines={2} />}
          {search.isError && <RequestError error={search.error} onRetry={() => void search.refetch()} />}
          {search.isSuccess && search.items.length === 0 && (
            <EmptyState
              title="No eligible assets"
              description="Approved assets with usage rights appear here once the library holds some."
            />
          )}
          {search.isSuccess && search.items.length > 0 && (
            <ul className="grid grid-cols-3 gap-1" aria-label="Eligible assets">
              {search.items.map((a) => (
                <li key={a.assetVersionId}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(a);
                      onOpenChange(false);
                    }}
                    aria-label={`Use ${a.altText ?? a.kind}`}
                    data-testid={`asset-pick-${a.assetVersionId}`}
                    className="flex w-full flex-col gap-0.5 rounded-md border border-border p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <DialogActions>
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
