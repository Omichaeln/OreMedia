import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, EmptyState, Field, Input, Skeleton } from '@oremedia/ui';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useDocuments } from './use-document';
import { useTRPC } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';

/** The form that creates a document and opens it; shown with Documents on the home page and the Studio section. */
export function NewDocument({ disabledReason }: { disabledReason?: string }) {
  const { companyId, brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const intent = useIntentKey();
  const [title, setTitle] = useState('');
  const create = useMutation(
    trpc.creative.documents.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.creative.documents.pathFilter());
        navigate(brandPath(companyId, brandId, `studio/${encodeURIComponent(res.documentId)}`));
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) create.mutate({ brandId, title: title.trim() });
  };
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field
          label="New document title"
          htmlFor="doc-title"
          error={create.isError ? toUiError(create.error).message : undefined}
        >
          <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || !title.trim()}
            disabledReason={disabledReason}
          >
            {create.isPending ? 'Creating…' : 'Create and open'}
          </Button>
        </div>
      </form>
    </div>
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
        description="Create the first one below; every document of the brand is listed here."
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
