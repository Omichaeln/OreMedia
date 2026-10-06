import type { EvidenceStrength, RecommendationAction } from '@oremedia/contracts/intelligence';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import type { Tone } from '@oremedia/ui';
import { experimentStateChip } from '../experiments/experiment-helpers';

export interface Chip {
  tone: Tone;
  label: string;
}

/** Spec 15.2 / 16.9: freshness next to every number; stale is marked with text, never a colour alone. */
export interface FreshnessDto {
  asOf: string | null;
  ageHours: number | null;
  stale: boolean;
}

export const ageText = (ageHours: number): string => {
  if (ageHours < 1) return `${Math.round(ageHours * 60)} min ago`;
  if (ageHours < 48) return `${Math.round(ageHours)} h ago`;
  return `${Math.round(ageHours / 24)} d ago`;
};

export function freshnessText(f: FreshnessDto): string {
  if (f.asOf === null) return 'No data yet';
  const fetched = new Date(f.asOf).toLocaleString();
  const age = f.ageHours === null ? '' : ` (${ageText(f.ageHours)})`;
  return `Fetched ${fetched}${age}`;
}

/** Spec 16.1: the coverage statement is always shown; empty listening coverage is said, not hidden. */
export interface CoverageDto {
  sources: string[];
  competitors: string[];
  languages: string[];
  periodStart: string;
  periodEnd: string;
  statement?: string;
}

/** The coverage statement without its "Coverage" label (the strip sets the label apart, as the interface does). */
export function coverageDetail(c: CoverageDto): string {
  const period = `${new Date(c.periodStart).toLocaleDateString()} to ${new Date(c.periodEnd).toLocaleDateString()}`;
  const sources = c.sources.length ? `sources: ${c.sources.join(', ')}` : 'no sources yet';
  const competitors = c.competitors.length
    ? `competitors: ${c.competitors.join(', ')}`
    : 'no competitor monitoring';
  const languages = c.languages.length ? `languages: ${c.languages.join(', ')}` : 'no language filter';
  return `${period}; ${sources}; ${competitors}; ${languages}.`;
}

export const coverageText = (c: CoverageDto): string => `Coverage ${coverageDetail(c)}`;

/** "Partial" when the period has inputs but the analysis reports gaps (an insight with a `gap` evidence). */
export const hasCoverageGaps = (items: ReadonlyArray<{ evidence: Array<{ kind: string }> }>): boolean =>
  items.some((i) => i.evidence.some((e) => e.kind === 'gap'));

export const STRENGTH_CHIP: Record<EvidenceStrength, Chip> = {
  observed: { tone: 'neutral', label: 'Observed' },
  directional: { tone: 'info', label: 'Directional' },
  experimentally_supported: { tone: 'good', label: 'Experimentally supported' },
};

/** Spec 16.3: likely reasons are hypotheses; only experimentally supported entries are findings. */
export const insightLabel = (kind: string, strength: EvidenceStrength): string => {
  if (kind === 'experimental_finding' && strength === 'experimentally_supported') return 'Finding';
  if (kind === 'association' || kind === 'experimental_finding') return 'Hypothesis';
  if (kind === 'anomaly') return 'Anomaly';
  return 'Change';
};

export const ACTION_LABEL: Record<RecommendationAction, string> = {
  create_brief: 'Create brief',
  generate_variants: 'Generate variants',
  open_canvas: 'Open canvas',
  prepare_test: 'Prepare test',
  assign_response: 'Assign response',
  propose_playbook_update: 'Propose playbook update',
};

/** The interface's "01", "02" … rank before a recommendation's title. */
export const rankText = (position: number): string => String(position).padStart(2, '0');

/**
 * The interface states confidence; the server records uncertainty on the same three-step scale. Confidence is its
 * inverse, so nothing is estimated: low uncertainty reads "High" confidence. An unknown level is shown as it came.
 */
const CONFIDENCE: Record<string, string> = { low: 'High', medium: 'Medium', high: 'Low' };
export const confidenceText = (uncertainty: string): string =>
  CONFIDENCE[uncertainty] ?? `unknown (${uncertainty})`;

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const effortText = (effort: string): string => capitalise(effort);

/** "Benefit": the expected movement on its metric, with the magnitude when the analyst gave one. */
export const benefitText = (b: { metricKey: string; direction: string; magnitude?: string | null }): string =>
  `${b.metricKey.replace(/_/g, ' ')} ${b.direction}${b.magnitude ? ` (${b.magnitude})` : ''}`;

/** The interface's quick dismissal reasons; each is sent as the stored reason, like a typed one. */
export const DISMISS_REASONS = [
  'Not relevant to objective',
  'Already doing it',
  'Evidence too weak',
  'Conflicts with brand',
] as const;

/** An anomaly as one sentence: what was observed against its baseline, and how many times the baseline it is. */
export function anomalyText(a: { signal: string; baseline: number; observed: number }): string {
  const ratio = a.baseline > 0 ? ` (${(a.observed / a.baseline).toFixed(1)}× baseline)` : '';
  return `${a.signal}: observed ${a.observed} against a baseline of ${a.baseline}${ratio}`;
}

export const SEVERITY_CHIP: Record<string, Chip> = {
  low: { tone: 'info', label: 'Low severity' },
  medium: { tone: 'warning', label: 'Medium severity' },
  high: { tone: 'critical', label: 'High severity' },
};
export const severityChip = (severity: string): Chip =>
  SEVERITY_CHIP[severity] ?? { tone: 'neutral', label: severity };

export const CLUSTER_KIND_CHIP: Record<string, Chip> = {
  question: { tone: 'info', label: 'Question' },
  objection: { tone: 'warning', label: 'Objection' },
  praise: { tone: 'good', label: 'Praise' },
  need: { tone: 'info', label: 'Need' },
  complaint: { tone: 'critical', label: 'Complaint' },
};
export const clusterKindChip = (kind: string): Chip =>
  CLUSTER_KIND_CHIP[kind] ?? { tone: 'neutral', label: kind };

export const PLAYBOOK_STATE_CHIP: Record<string, Chip> = {
  proposed: { tone: 'warning', label: 'Proposed' },
  approved: { tone: 'good', label: 'Approved' },
  retired: { tone: 'neutral', label: 'Retired' },
};
export const playbookStateChip = (state: string): Chip =>
  PLAYBOOK_STATE_CHIP[state] ?? { tone: 'neutral', label: state };

/**
 * Spec 5.5 default grants: `playbook.approve` belongs to owner, admin and brand_manager. The server decides on
 * every call; this only hides the control from roles that never hold it so the screen is honest before a click.
 */
const PLAYBOOK_APPROVERS: ReadonlySet<MembershipRole> = new Set<MembershipRole>([
  'owner',
  'admin',
  'brand_manager',
]);
export const canApprovePlaybook = (role: MembershipRole | null | undefined): boolean =>
  role !== null && role !== undefined && PLAYBOOK_APPROVERS.has(role);

/** Spec 16.9 "Experiments" view groups, as the workspace hands them over, in the order the view lists them. */
export const EXPERIMENT_GROUPS = ['running', 'planned', 'completed', 'inconclusive'] as const;

/** The workspace's experiment group is shown as text; `directional; not causal` is preserved verbatim. */
export const VERDICT_CHIP: Record<string, Chip> = {
  supported: { tone: 'good', label: 'Supported' },
  not_supported: { tone: 'critical', label: 'Not supported' },
  inconclusive: { tone: 'neutral', label: 'Inconclusive' },
};
export const verdictChip = (verdict: string): Chip =>
  VERDICT_CHIP[verdict] ?? { tone: 'neutral', label: verdict };

/** An experiment row in the workspace: its verdict once a result exists, otherwise where it is in its lifecycle. */
export const workspaceExperimentChip = (x: {
  state: string;
  latestResult: { verdict: string } | null;
}): Chip => (x.latestResult ? verdictChip(x.latestResult.verdict) : experimentStateChip(x.state));

/** A date-time-local default for a review-after date: 90 days from now, at minute precision. */
export function defaultReviewAfter(now = new Date()): string {
  const d = new Date(now.getTime() + 90 * 86_400_000);
  d.setSeconds(0, 0);
  return d.toISOString();
}
