import type { InboxAttention } from '@oremedia/contracts/review';
import { pendingProposals, useBrandVersions, useFacts, type BrandDto } from '../brand/use-brand';
import { usePublicationsInState } from '../publishing/use-publishing';
import { useReviewInboxPages } from '../review/use-review';

/** Review states that wait on a person: a decision, a new request, the author's changes, or a lost approval. */
export const REVIEW_NEEDS_YOU: ReadonlySet<InboxAttention> = new Set([
  'awaiting_decision',
  'stale',
  'changes_requested',
  'approval_invalidated',
]);

/**
 * The shell's counts, each from the list the section itself shows (no count endpoint exists): review requests that
 * wait on a person, publications that failed, have an unknown outcome or are held, and the brand system's proposals
 * (proposed facts, facts due for review and proposed updates waiting to be reviewed, D-22). Undefined while loading or on error, so
 * the navigation never shows a number it does not have.
 */
export function useNavCounts(brand: BrandDto) {
  const inbox = useReviewInboxPages(brand.id);
  const failed = usePublicationsInState(brand.id, 'failed');
  const unknown = usePublicationsInState(brand.id, 'outcome_unknown');
  const held = usePublicationsInState(brand.id, 'held');
  const facts = useFacts(brand.id, 'proposed');
  const reviewDue = useFacts(brand.id, { reviewDue: true });
  const versions = useBrandVersions(brand.id);
  const review = inbox.items.filter((i) => i.attention.some((a) => REVIEW_NEEDS_YOU.has(a))).length;
  const calendar =
    failed.data && unknown.data && held.data
      ? failed.data.items.length + unknown.data.items.length + held.data.items.length
      : undefined;
  const proposals = versions.data
    ? pendingProposals(versions.data.items, brand.publishedVersionId).length
    : undefined;
  const system =
    facts.data && reviewDue.data && proposals !== undefined
      ? facts.data.items.length + reviewDue.data.items.length + proposals
      : undefined;
  return { review, calendar, system };
}
