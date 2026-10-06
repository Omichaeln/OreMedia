import { ExperimentMode, PreRegistrationV1, UnitType } from '@oremedia/contracts/experiments';
import type { ErrorDetail } from '@oremedia/contracts/errors';
import type { Tone } from '@oremedia/ui';

export interface Chip {
  tone: Tone;
  label: string;
}

/** Spec 16.6 experiment states as the contract defines them; every chip is text plus a glyph (spec 21.3). */
export const EXPERIMENT_STATE_CHIP: Record<string, Chip> = {
  designed: { tone: 'neutral', label: 'Designed' },
  pre_registered: { tone: 'info', label: 'Pre-registered' },
  running: { tone: 'info', label: 'Running' },
  stopped: { tone: 'warning', label: 'Stopped' },
  analysed: { tone: 'good', label: 'Analysed' },
};
export const experimentStateChip = (state: string): Chip =>
  EXPERIMENT_STATE_CHIP[state] ?? { tone: 'neutral', label: `Unknown state (${state})` };

export const MODE_LABEL: Record<string, string> = {
  randomised: 'Randomised',
  structured_comparison: 'Structured comparison',
};
export const modeLabel = (mode: string): string => MODE_LABEL[mode] ?? mode;

/** Spec 16.6: the label is shown verbatim; a structured comparison is always "directional; not causal". */
export const DIRECTIONAL_LABEL = 'directional; not causal';
export const conclusionText = (label: string): string =>
  label === 'causal_when_sound' ? 'Can support causal claims when design and execution are sound' : label;

/** What the mode means for the claims a result can carry, in the interface's words, then the label verbatim. */
const MODE_NOTE: Record<string, string> = {
  randomised: 'Oremedia controls assignment.',
  structured_comparison: 'Organic posting across matched slots; timing and audience differ.',
};
export const modeNote = (mode: string, conclusionLabel: string): string =>
  `${MODE_NOTE[mode] ?? ''} ${conclusionText(conclusionLabel)}.`.trim();

/** The list's second line: the arms compared, "A vs. B". */
export const variantsLine = (variants: ReadonlyArray<{ label: string }>): string =>
  variants.map((v) => v.label).join(' vs. ');

/** The allocation with its split: "Matched slots, 50/50". */
export function allocationText(
  method: string,
  variants: ReadonlyArray<{ allocationWeight: number }>,
): string {
  const total = variants.reduce((sum, v) => sum + v.allocationWeight, 0);
  const split =
    total > 0 ? variants.map((v) => Math.round((v.allocationWeight / total) * 100)).join('/') : '';
  const name = method.replace(/_/g, ' ');
  return `${name[0]?.toUpperCase() ?? ''}${name.slice(1)}${split ? `, ${split}` : ''}`;
}

/** A window in whole days when it is a whole number of days, otherwise in hours. */
export const windowText = (hours: number): string =>
  hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} h`;

export const stoppingText = (rule: { kind: string; alpha: number }): string =>
  `${rule.kind === 'sequential_msprt' ? 'Sequential (mSPRT)' : 'Fixed horizon'}, α = ${rule.alpha}`;

export interface Progress {
  label: string;
  /** 0 to 1. */
  fraction: number;
}

/**
 * The bar under the heading. With a result: the smallest arm against the pre-registered minimum sample. Running
 * without one: how much of the observation window has passed (observations are not reported before a result, so
 * the sample is not shown as if it were known). Not started: nothing has passed.
 */
export function experimentProgress(
  x: {
    startedAt: string | null;
    observationWindowHours: number;
    minSamplePerArm: number;
    variants: ReadonlyArray<{ id: string }>;
  },
  result: { perVariant: Record<string, { n: number } | undefined> } | null,
  now: Date = new Date(),
): Progress {
  const min = x.minSamplePerArm;
  if (result) {
    const smallest = Math.min(...x.variants.map((v) => result.perVariant[v.id]?.n ?? 0));
    return {
      label: `${smallest.toLocaleString()} / ${min.toLocaleString()} per arm`,
      fraction: min > 0 ? Math.min(1, smallest / min) : 1,
    };
  }
  if (x.startedAt) {
    const total = x.observationWindowHours;
    const elapsed = Math.max(0, (now.getTime() - Date.parse(x.startedAt)) / 3_600_000);
    const shown = Math.min(elapsed, total);
    const label =
      total % 24 === 0
        ? `Day ${Math.max(1, Math.ceil(shown / 24))} of ${total / 24} · window`
        : `${Math.floor(shown)} h of ${total} h · window`;
    return { label, fraction: total > 0 ? shown / total : 1 };
  }
  return { label: `Not started · minimum ${min.toLocaleString()} per arm`, fraction: 0 };
}

export const shortHash = (hash: string | null): string => (hash ? `${hash.slice(0, 12)}…` : '—');

export const windowEnd = (startedAt: string, observationWindowHours: number): Date =>
  new Date(new Date(startedAt).getTime() + observationWindowHours * 3600_000);

/**
 * Spec 16.6: results are not declared before the pre-registered sample and window; the server refuses with
 * `window_not_reached_until_<iso>` and `sample_below_<n>_per_arm` details, and `design_changed` when the design
 * no longer hashes to the frozen value. Each is turned into a sentence; unknown issues are shown verbatim.
 */
export function resultsRefusalText(details: readonly ErrorDetail[]): string[] {
  const out: string[] = [];
  for (const d of details) {
    const until = /^window_not_reached_until_(.+)$/.exec(d.issue);
    const sample = /^sample_below_(\d+)_per_arm$/.exec(d.issue);
    if (until?.[1])
      out.push(`The observation window has not ended; it ends ${new Date(until[1]).toLocaleString()}.`);
    else if (sample?.[1]) out.push(`The sample is below the pre-registered minimum of ${sample[1]} per arm.`);
    else if (d.issue === 'design_changed')
      out.push('The design changed after pre-registration, so results against it are rejected.');
    else if (d.issue === 'window_reached' || d.issue === 'sample_reached') continue;
    else out.push(d.path ? `${d.path}: ${d.issue}` : d.issue);
  }
  return out;
}

export const isDesignChanged = (details: readonly ErrorDetail[]): boolean =>
  details.some((d) => d.issue === 'design_changed');

export const formatRate = (rate: number | null): string =>
  rate === null ? 'unavailable' : `${(rate * 100).toFixed(1)}%`;

export const formatPoints = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pp`;

/** The result's headline: the difference between the arms, or why there is none. */
export const differenceText = (estimate: number | null): string =>
  estimate === null ? 'No estimate (no data in one arm)' : `Difference ${formatPoints(estimate)}`;

/** The line under it: the 95% interval and the p-value, each only when the method produced one. */
export function intervalText(interval: readonly number[] | null, pValue: number | null): string {
  const parts: string[] = [];
  if (interval && interval.length === 2)
    parts.push(
      `95% interval ${formatPoints(interval[0] as number)} to ${formatPoints(interval[1] as number)}`,
    );
  if (pValue !== null) parts.push(`p = ${pValue.toFixed(3)}`);
  return parts.join(' · ');
}

export interface VariantRow {
  label: string;
  contentRevisionId: string;
  allocationWeight: string;
}

export interface DesignForm {
  hypothesis: string;
  mode: string;
  variants: VariantRow[];
  primaryMetricKey: string;
  guardrailMetricKeys: string[];
  allocationMethod: string;
  unitType: string;
  minSamplePerArm: string;
  observationWindowHours: string;
  stoppingRule: string;
  alpha: string;
}

export const EMPTY_DESIGN: DesignForm = {
  hypothesis: '',
  mode: 'structured_comparison',
  variants: [
    { label: 'A', contentRevisionId: '', allocationWeight: '1' },
    { label: 'B', contentRevisionId: '', allocationWeight: '1' },
  ],
  primaryMetricKey: '',
  guardrailMetricKeys: [],
  allocationMethod: 'matched_slots',
  unitType: 'publication_slot',
  minSamplePerArm: '30',
  observationWindowHours: '168',
  stoppingRule: 'fixed_horizon',
  alpha: '0.05',
};

export const ALLOCATION_METHODS = ['hashed_visitor', 'matched_slots', 'random'] as const;
export const STOPPING_RULES = ['fixed_horizon', 'sequential_msprt'] as const;
export const MODES = ExperimentMode.options;
export const UNIT_TYPES = UnitType.options;

export type DesignParse =
  { ok: true; design: PreRegistrationV1 } | { ok: false; issues: Array<{ path: string; issue: string }> };

/** The form → the pre-registration document, validated by the contract so the server sees a shaped design. */
export function parseDesign(form: DesignForm): DesignParse {
  const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
  const alpha = num(form.alpha);
  const candidate = {
    v: 1,
    hypothesis: form.hypothesis.trim(),
    mode: form.mode,
    variants: form.variants.map((v) => ({
      label: v.label.trim(),
      contentRevisionId: v.contentRevisionId.trim(),
      allocationWeight: num(v.allocationWeight),
    })),
    primaryMetricKey: form.primaryMetricKey.trim(),
    guardrailMetricKeys: form.guardrailMetricKeys.filter((k) => k !== form.primaryMetricKey.trim()),
    allocationMethod: form.allocationMethod,
    unitType: form.unitType,
    minSamplePerArm: num(form.minSamplePerArm),
    observationWindowHours: num(form.observationWindowHours),
    stoppingRule:
      form.stoppingRule === 'sequential_msprt'
        ? { kind: 'sequential_msprt', alpha, tau: 1 }
        : { kind: 'fixed_horizon', alpha },
  };
  // A pick left empty is a shaped string the contract accepts; it is refused here, beside its field (RA-07).
  const unpicked: Array<{ path: string; issue: string }> = [];
  if (candidate.primaryMetricKey === '')
    unpicked.push({ path: 'primaryMetricKey', issue: 'Choose a metric.' });
  candidate.variants.forEach((v, i) => {
    if (v.contentRevisionId === '')
      unpicked.push({ path: `variants.${i}.contentRevisionId`, issue: 'Choose a content package.' });
  });
  const parsed = PreRegistrationV1.safeParse(candidate);
  if (parsed.success && unpicked.length === 0) return { ok: true, design: parsed.data };
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((i) => ({ path: i.path.join('.'), issue: i.message }));
  return {
    ok: false,
    issues: [...unpicked, ...issues.filter((i) => !unpicked.some((u) => u.path === i.path))],
  };
}
