import { toneGlyph } from '@oremedia/ui';
import { coverageDetail, freshnessText, type CoverageDto, type FreshnessDto } from './intelligence-helpers';

export interface FreshnessLineProps {
  freshness: FreshnessDto;
  /** The analysis's coverage statement (spec 16.1) when it has one. */
  coverage?: CoverageDto;
  className?: string;
}

/**
 * Spec 15.2: freshness is displayed next to every number and stale data is visibly marked (with text). Spec 16.1:
 * the coverage statement is shown wherever listening outputs are displayed. Set as the interface's strip under the
 * heading: a white ruled card, each part a dark label followed by its muted detail.
 */
export function FreshnessLine({ freshness, coverage, className }: FreshnessLineProps) {
  return (
    <div
      className={`flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground ${className ?? ''}`}
      data-testid="freshness"
    >
      <span>
        <span className="text-foreground">Freshness</span> {freshnessText(freshness)}
        {freshness.stale && freshness.asOf !== null && (
          <span className="text-status-warning" data-testid="stale">
            {' · '}
            <span className="sr-only">{toneGlyph.warning} </span>Stale
          </span>
        )}
      </span>
      {coverage && (
        <span data-testid="coverage">
          <span className="text-foreground">Coverage</span> {coverageDetail(coverage)}
        </span>
      )}
    </div>
  );
}
