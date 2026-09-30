import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { brandPath } from '../brand/brand-context';
import { isoToZonedInput, zonedInputToIso } from '../publishing/publication-state';

export interface RequestReviewProps {
  companyId: string;
  brandId: string;
  /** The brand's time zone: the planned publish time is entered as the brand's wall clock (UX-06). */
  timeZone: string;
  contentPackageId: string;
  revision: { id: string; number: number; state: string };
  variantCount: number;
}

/**
 * Spec 13.3: sends the current draft revision for review. The request freezes the revision, its channel variants and
 * the planned timing into a manifest; the revision moves to in review and the request opens in the review inbox.
 * Shared by the package screen and the studio (UX-01), which reach the same revision from either side.
 */
export function RequestReview({
  companyId,
  brandId,
  timeZone,
  contentPackageId,
  revision,
  variantCount,
}: RequestReviewProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [at, setAt] = useState(() =>
    isoToZonedInput(new Date(Date.now() + 24 * 3_600_000).toISOString(), timeZone),
  );
  const [error, setError] = useState<string | null>(null);
  const request = useMutation(
    trpc.review.requests.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setError(null);
        void queryClient.invalidateQueries(trpc.content.pathFilter());
        void queryClient.invalidateQueries(trpc.review.pathFilter());
      },
    }),
  );
  if (request.data)
    return (
      <StatusBanner
        tone="good"
        title="Review requested"
        description={`Revision ${revision.number} and its channel variants are frozen for review (manifest ${request.data.manifestHash.slice(0, 12)}…).`}
        actions={
          <Button asChild size="sm">
            <Link
              to={brandPath(
                companyId,
                brandId,
                `review?request=${encodeURIComponent(request.data.reviewRequestId)}`,
              )}
            >
              Open in the review inbox
            </Link>
          </Button>
        }
        data-testid="review-requested"
      />
    );
  if (revision.state !== 'draft' && revision.state !== 'changes_requested') return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const iso = zonedInputToIso(at, timeZone);
    if (!iso) {
      setError('Enter the planned publish time.');
      return;
    }
    setError(null);
    request.mutate({ contentRevisionId: revision.id, timing: { kind: 'exact', at: iso } });
  };
  const ui = request.isError ? toUiError(request.error) : null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
      <Field
        label={`Planned publish time (${timeZone})`}
        htmlFor={`review-at-${contentPackageId}`}
        hint="Brand time, frozen into the review manifest; publishing outside it is held."
        error={error ?? undefined}
      >
        <Input
          id={`review-at-${contentPackageId}`}
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
          required
        />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Requesting a review needs review.request.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={request.error} title="The review was not requested" />
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={request.isPending}
          disabledReason={variantCount === 0 ? 'Generate at least one channel variant first' : undefined}
        >
          {request.isPending ? 'Requesting…' : 'Request review'}
        </Button>
      </div>
    </form>
  );
}
