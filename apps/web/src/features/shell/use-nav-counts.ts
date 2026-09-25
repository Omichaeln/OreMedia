import type { InboxAttention } from '@oremedia/contracts/review';
import { useBrandVersions, useFacts, type BrandDto } from '../brand/use-brand';
import { usePublicationsInState } from '../publishing/use-publishing';
import { useReviewInbox } from '../review/use-review';

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
 * (proposed facts and a version in review newer than the published one). Undefined while loading or on error, so
 * the navigation never shows a number it does not have.
 */
export function useNavCounts(brand: BrandDto) {
  const inbox = useReviewInbox(brand.id);
  const failed = usePublicationsInState(brand.id, 'failed');
  const unknown = usePublicationsInState(brand.id, 'outcome_unknown');
  const held = usePublicationsInState(brand.id, 'held');
  const facts = useFacts(brand.id, 'proposed');
  const versions = useBrandVersions(brand.id);
  const review = inbox.data?.items.filter((i) => i.attention.some((a) => REVIEW_NEEDS_YOU.has(a))).length;
  const calendar =
    failed.data && unknown.data && held.data
      ? failed.data.items.length + unknown.data.items.length + held.data.items.length
      : undefined;
  const published = versions.data?.items.find((v) => v.id === brand.publishedVersionId);
  const inReview = versions.data?.items.filter(
    (v) => v.state === 'in_review' && (!published || v.number > published.number),
  ).length;
  const system = facts.data && inReview !== undefined ? facts.data.items.length + inReview : undefined;
  return { review, calendar, system };
}
