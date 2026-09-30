import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Field, Input, Panel, Skeleton, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { brandPath } from '../brand/brand-context';
import { revisionChip } from '../content/content-helpers';
import { RequestReview } from '../content/request-review';
import { usePackagesForDocument } from '../content/use-content';

export interface ReviewPanelProps {
  companyId: string;
  brandId: string;
  timeZone: string;
  documentId: string;
  documentTitle: string;
  /** The saved head: a package pinning an earlier revision would send stale creative for review. */
  headRevisionId: string;
  hasLocalWork: boolean;
  onClose: () => void;
}

/** Spec 13 first package from the studio: pins this document at its saved head; variants come next on the package. */
function CreatePackageForm({
  brandId,
  documentId,
  documentTitle,
}: {
  brandId: string;
  documentId: string;
  documentTitle: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [title, setTitle] = useState(documentTitle);
  const [text, setText] = useState('');
  const create = useMutation(
    trpc.content.packages.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.content.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !text.trim()) return;
    create.mutate({
      brandId,
      title: title.trim(),
      copy: { schemaVersion: 1, master: { text: text.trim(), factRefs: [] } },
      creativeDocumentIds: [documentId],
    });
  };
  const ui = create.isError ? toUiError(create.error) : null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" noValidate data-testid="studio-create-package">
      <p className="text-xs text-muted-foreground">
        No package publishes this document yet. Create one: it pins the saved revision, and its channel
        variants are generated on the package before it goes to review.
      </p>
      <Field label="Package title" htmlFor="studio-package-title">
        <Input id="studio-package-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <Field label="Master copy" htmlFor="studio-package-copy">
        <Textarea id="studio-package-copy" value={text} onChange={(e) => setText(e.target.value)} rows={3} />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Creating a package needs content.edit.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={create.error} title="The package was not created" />
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={create.isPending || !title.trim() || !text.trim()}
          disabledReason={!title.trim() || !text.trim() ? 'Enter a title and the master copy' : undefined}
        >
          {create.isPending ? 'Creating…' : 'Create package'}
        </Button>
      </div>
    </form>
  );
}

/**
 * UX-01: the studio's way into review. A review is requested on a content revision (spec 13.3), never on a document,
 * so the panel lists the live packages that pin this document at their current revision and offers the request
 * there; with none, it creates the first package. Unsaved local work is never what goes to review: the pin is the
 * saved head, so the panel says so until the work is saved.
 */
export function ReviewPanel({
  companyId,
  brandId,
  timeZone,
  documentId,
  documentTitle,
  headRevisionId,
  hasLocalWork,
  onClose,
}: ReviewPanelProps) {
  const packages = usePackagesForDocument(documentId);
  return (
    <Panel
      title="Send for review"
      data-testid="studio-review"
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {hasLocalWork && (
          <StatusBanner
            tone="warning"
            title="Unsaved changes"
            description="A review freezes the saved revision. Save your changes first so the reviewer sees them."
            data-testid="studio-review-unsaved"
          />
        )}
        {packages.isPending && <Skeleton label="Loading packages" lines={2} />}
        {packages.isError && <RequestError error={packages.error} onRetry={() => void packages.refetch()} />}
        {packages.data && packages.data.items.length === 0 && (
          <CreatePackageForm brandId={brandId} documentId={documentId} documentTitle={documentTitle} />
        )}
        {packages.data && packages.data.items.length > 0 && (
          <ul className="flex flex-col gap-3" aria-label="Packages publishing this document">
            {packages.data.items.map((item) => {
              const chip = revisionChip(item.revision.state);
              const staleHead = item.pinnedRevisionId !== headRevisionId;
              return (
                <li
                  key={item.package.id}
                  className="flex flex-col gap-2 rounded-md border border-border p-3"
                  data-testid="studio-review-package"
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{item.package.title}</span>
                    <Badge tone={chip.tone}>{chip.label}</Badge>
                    <span className="text-xs text-muted-foreground">
                      revision {item.revision.number} · {item.variantCount} variant
                      {item.variantCount === 1 ? '' : 's'}
                    </span>
                    <Link
                      to={brandPath(
                        companyId,
                        brandId,
                        `campaigns?package=${encodeURIComponent(item.package.id)}`,
                      )}
                      className="text-xs underline underline-offset-2"
                    >
                      Open package
                    </Link>
                  </div>
                  {staleHead && (
                    <StatusBanner
                      tone="warning"
                      title="Pins an earlier revision of this document"
                      description="Revise the package (it re-pins the saved head) before requesting a review, or the reviewer sees the older creative."
                      data-testid="studio-review-stale"
                    />
                  )}
                  {!hasLocalWork && !staleHead && (
                    <RequestReview
                      key={item.revision.id}
                      companyId={companyId}
                      brandId={brandId}
                      timeZone={timeZone}
                      contentPackageId={item.package.id}
                      revision={item.revision}
                      variantCount={item.variantCount}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
