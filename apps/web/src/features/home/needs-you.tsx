import { Link } from 'react-router';
import { Skeleton, StatusDot, toneGlyph, type Tone } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useFacts } from '../brand/use-brand';
import { PackageTitle } from '../content/package-title';
import { PUBLICATION_CHIP, holdReasonText, outcomeUnknownReasonText } from '../publishing/publication-state';
import { usePublicationsInState, type PublicationSummaryDto } from '../publishing/use-publishing';
import { ATTENTION_CHIP } from '../review/review-attention';
import { useReviewInboxPages, type InboxItemDto } from '../review/use-review';
import { REVIEW_NEEDS_YOU } from '../shell/use-nav-counts';
import { Section } from '../../components/section';

export interface NeedsYouRow {
  key: string;
  tone: Tone;
  state: string;
  title: React.ReactNode;
  detail: string;
  /** A machine reason (for example the channel's error code), shown as recorded. */
  meta?: string | null;
  href: string;
  action: string;
  at: string | null;
  atLabel?: 'due' | 'scheduled';
}

const when = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleString(undefined, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Most urgent first: what is already live or failing, then what blocks a release, then standards. */
const ORDER: Record<Tone, number> = { critical: 0, warning: 1, info: 2, neutral: 3, good: 4 };

const reviewRow = (item: InboxItemDto, reviewHref: string): NeedsYouRow | null => {
  const attention = item.attention.find((a) => REVIEW_NEEDS_YOU.has(a));
  if (!attention) return null;
  const chip = ATTENTION_CHIP[attention];
  return {
    key: `review:${item.id}`,
    tone: chip.tone,
    state: chip.label,
    title: <PackageTitle contentPackageId={item.contentPackageId} />,
    detail: chip.detail,
    href: `${reviewHref}?request=${encodeURIComponent(item.id)}`,
    action: attention === 'awaiting_decision' ? 'Decide' : 'Review',
    at: item.dueAt ?? null,
    atLabel: 'due',
  };
};

/** The first sentence of an explanation: the list names the problem; the item itself has the full account. */
const firstSentence = (text: string) => {
  const end = text.search(/[.;](\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1).replace(/;$/, '.');
};

const publicationRow = (p: PublicationSummaryDto, calendarHref: string): NeedsYouRow => {
  const chip = PUBLICATION_CHIP[p.state];
  const reason =
    p.state === 'outcome_unknown'
      ? outcomeUnknownReasonText(p.stateReason)
      : p.state === 'held'
        ? (p.holdReasons[0] && holdReasonText(p.holdReasons[0])) || null
        : null;
  const more = p.state === 'held' && p.holdReasons.length > 1 ? ` (+${p.holdReasons.length - 1} more)` : '';
  return {
    key: `publication:${p.id}`,
    tone: chip.tone,
    state: chip.label,
    title: <PackageTitle contentPackageId={p.contentPackageId} />,
    detail: firstSentence(reason ?? chip.detail) + more,
    meta: p.state === 'failed' && p.stateReason ? p.stateReason : null,
    href: `${calendarHref}?publication=${encodeURIComponent(p.id)}&day=${p.scheduledFor.slice(0, 10)}`,
    action: p.state === 'outcome_unknown' || p.state === 'held' ? 'Reconcile' : 'Open',
    at: p.scheduledFor,
    atLabel: 'scheduled',
  };
};

export interface NeedsYouRows {
  rows: NeedsYouRow[];
  /** Every list has answered (so an empty list is really empty). */
  settled: boolean;
  pending: boolean;
  failed: { error: unknown; refetch: () => void } | null;
  timeZone: string;
}

/**
 * Spec 21.2 "action needed" as one list: review requests that wait on a person, publications that failed, have an
 * unknown outcome or are held, proposed facts and facts due for review. Every row says what happened and what to do, and links to the
 * exact item. Only what the lists return; nothing is estimated.
 */
export function useNeedsYouRows(): NeedsYouRows {
  const { companyId, brandId, brand } = useBrandContext();
  const timeZone = brand.timezone || 'UTC';
  const inbox = useReviewInboxPages(brandId);
  const failed = usePublicationsInState(brandId, 'failed');
  const unknown = usePublicationsInState(brandId, 'outcome_unknown');
  const held = usePublicationsInState(brandId, 'held');
  const facts = useFacts(brandId, 'proposed');
  const reviewDue = useFacts(brandId, { reviewDue: true });
  const queries = [inbox, failed, unknown, held, facts, reviewDue];
  const reviewHref = brandPath(companyId, brandId, 'review');
  const calendarHref = brandPath(companyId, brandId, 'calendar');
  const factCount = facts.data?.items.length ?? 0;
  const reviewDueCount = reviewDue.data?.items.length ?? 0;
  const factsHref = `${brandPath(companyId, brandId, 'system')}?section=facts`;
  const rows: NeedsYouRow[] = [
    ...(unknown.data?.items ?? []).map((p) => publicationRow(p, calendarHref)),
    ...(failed.data?.items ?? []).map((p) => publicationRow(p, calendarHref)),
    ...(held.data?.items ?? []).map((p) => publicationRow(p, calendarHref)),
    ...inbox.items.flatMap((i) => reviewRow(i, reviewHref) ?? []),
    ...(factCount > 0
      ? [
          {
            key: 'facts',
            tone: 'warning' as const,
            state: 'Proposed',
            title: `${factCount} proposed brand ${factCount === 1 ? 'fact' : 'facts'}`,
            detail: 'Agents and checks cannot rely on them until a brand manager approves them.',
            href: factsHref,
            action: 'Review facts',
            at: null,
          },
        ]
      : []),
    ...(reviewDueCount > 0
      ? [
          {
            key: 'facts-review-due',
            tone: 'warning' as const,
            state: 'Review due',
            title: `${reviewDueCount} brand ${reviewDueCount === 1 ? 'fact is' : 'facts are'} due for review`,
            detail:
              'Confirm they still hold, correct them or withdraw them; copy keeps using them meanwhile.',
            href: factsHref,
            action: 'Review facts',
            at: null,
          },
        ]
      : []),
  ].sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
  const failedQuery = queries.find((q) => q.isError);
  return {
    rows,
    settled: queries.every((q) => q.isSuccess),
    pending: queries.some((q) => q.isPending),
    failed: failedQuery
      ? { error: failedQuery.error, refetch: () => queries.forEach((q) => void q.refetch()) }
      : null,
    timeZone,
  };
}

/** The rows as the interface sets them: a dot, a bold title with its detail under it, the action on the right. */
export function NeedsYou({ rows: needs }: { rows: NeedsYouRows }) {
  const { rows, settled, pending, failed, timeZone } = needs;
  return (
    <Section id="needs-you" title="Needs you">
      {failed && (
        <RequestError
          error={failed.error}
          onRetry={failed.refetch}
          title="Part of this list could not load"
        />
      )}
      {rows.length === 0 && pending && <Skeleton label="Loading what needs you" lines={3} />}
      {rows.length === 0 && settled && (
        <p role="status" className="py-3.5 text-base text-muted-foreground">
          Nothing needs attention. No review is waiting on a person, no publication failed or is unconfirmed,
          and no facts are proposed or due for review.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col" data-testid="needs-you">
          {rows.map((r) => (
            <li key={r.key} className="border-b border-border last:border-b-0">
              <Link
                to={r.href}
                className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-3.5 px-1 py-3.5 hover:bg-muted"
              >
                <StatusDot tone={r.tone} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-base font-bold">
                    <span className="sr-only">
                      {r.action}: {toneGlyph[r.tone]} {r.state}:{' '}
                    </span>
                    {r.title}
                  </span>
                  <span className="text-pretty text-sm text-muted-foreground">
                    {r.state === 'Proposed' || r.state === 'Review due' ? '' : `${r.state}. `}
                    {r.detail}
                  </span>
                  {(r.at || r.meta) && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {[r.at && `${r.atLabel} ${when(r.at, timeZone)}`, r.meta].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                <span aria-hidden="true" className="whitespace-nowrap text-sm text-muted-foreground">
                  {r.action} →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
