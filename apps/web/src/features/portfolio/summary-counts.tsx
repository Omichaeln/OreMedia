import { Badge } from '@oremedia/ui';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The portfolio's per-brand (or per-company, summed) counts from brand.summary. What needs a person is a chip with
 * its glyph; what is merely coming up is plain text, so a quiet brand reads as quiet.
 */
export function SummaryCounts({
  overdueApprovals,
  publicationsNeedingPerson,
  upcomingPublications,
  upcomingDays,
}: {
  overdueApprovals: number;
  publicationsNeedingPerson: number;
  upcomingPublications: number;
  upcomingDays: number;
}) {
  return (
    <span
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
      data-testid="summary-counts"
    >
      {overdueApprovals > 0 && (
        <Badge tone="warning">{plural(overdueApprovals, 'overdue approval', 'overdue approvals')}</Badge>
      )}
      {publicationsNeedingPerson > 0 && (
        <Badge tone="critical">
          {plural(publicationsNeedingPerson, 'post failed or held', 'posts failed or held')}
        </Badge>
      )}
      <span>
        {plural(upcomingPublications, 'post', 'posts')} due in the next {upcomingDays} days
      </span>
    </span>
  );
}
