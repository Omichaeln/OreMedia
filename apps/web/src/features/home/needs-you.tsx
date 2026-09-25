import { Link } from 'react-router';
import { Badge, EmptyState, Skeleton, type Tone } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useFacts } from '../brand/use-brand';
import { PackageTitle } from '../content/package-title';
import { PUBLICATION_CHIP, holdReasonText, outcomeUnknownReasonText } from '../publishing/publication-state';
import { usePublicationsInState, type PublicationSummaryDto } from '../publishing/use-publishing';
import { ATTENTION_CHIP } from '../review/review-attention';
import { useReviewInbox, type InboxItemDto } from '../review/use-review';
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

/**
 * Spec 21.2 "action needed" as one list: review requests that wait on a person, publications that failed, have an
 * unknown outcome or are held, and proposed facts. Every row says what happened and what to do, and links to the
 * exact item. Only what the lists return; nothing is estimated.
 */
export function NeedsYou() {
  const { companyId, brandId, brand } = useBrandContext();
  const timeZone = brand.timezone || 'UTC';
  const inbox = useReviewInbox(brandId);
  const failed = usePublicationsInState(brandId, 'failed');
  const unknown = usePublicationsInState(brandId, 'outcome_unknown');
  const held = usePublicationsInState(brandId, 'held');
  const facts = useFacts(brandId, 'proposed');
  const queries = [inbox, failed, unknown, held, facts];
  const reviewHref = brandPath(companyId, brandId, 'review');
  const calendarHref = brandPath(companyId, brandId, 'calendar');
  const factCount = facts.data?.items.length ?? 0;
  const rows: NeedsYouRow[] = [
    ...(unknown.data?.items ?? []).map((p) => publicationRow(p, calendarHref)),
    ...(failed.data?.items ?? []).map((p) => publicationRow(p, calendarHref)),
    ...(held.data?.items ?? []).map((p) => publicationRow(p, calendarHref)),
    ...(inbox.data?.items ?? []).flatMap((i) => reviewRow(i, reviewHref) ?? []),
    ...(factCount > 0
      ? [
          {
            key: 'facts',
            tone: 'warning' as const,
            state: 'Proposed',
            title: `${factCount} proposed brand ${factCount === 1 ? 'fact' : 'facts'}`,
            detail: 'Agents and checks cannot rely on them until a brand manager approves them.',
            href: `${brandPath(companyId, brandId, 'system')}?section=facts`,
            action: 'Review facts',
            at: null,
          },
        ]
      : []),
  ].sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
  const failedQuery = queries.find((q) => q.isError);
  return (
    <Section id="needs-you" title="Needs you">
      {failedQuery && (
        <RequestError
          error={failedQuery.error}
          onRetry={() => queries.forEach((q) => void q.refetch())}
          title="Part of this list could not load"
        />
      )}
      {rows.length === 0 && queries.some((q) => q.isPending) && (
        <Skeleton label="Loading what needs you" lines={3} />
      )}
      {rows.length === 0 && queries.every((q) => q.isSuccess) && (
        <EmptyState
          title="Nothing needs you"
          description="No review is waiting on a person, no publication failed or is unconfirmed, and no facts are proposed."
        />
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col divide-y divide-border" data-testid="needs-you">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <Badge tone={r.tone}>{r.state}</Badge>
                  <span className="min-w-0 break-words">{r.title}</span>
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{r.detail}</p>
                {(r.at || r.meta) && (
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {[r.at && `${r.atLabel} ${when(r.at, timeZone)}`, r.meta].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
              <Link to={r.href} className="shrink-0 text-sm font-medium underline-offset-2 hover:underline">
                {r.action} <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
