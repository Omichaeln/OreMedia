import type { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import {
  REPORT_SECTIONS,
  REPORT_SECTION_LABEL,
  type ReportCompareMode,
  type ReportFields,
  type ReportSection,
} from '@oremedia/contracts/reports';
import type { ReportDto, ReportFiguresDto } from './use-reports';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const parts = (periodMonth: string) => {
  const [y, m] = periodMonth.split('-').map(Number) as [number, number];
  return { year: y, month: m };
};
export const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;
export function shiftMonth(periodMonth: string, by: number): string {
  const { year, month } = parts(periodMonth);
  const index = year * 12 + (month - 1) + by;
  return monthKey(Math.floor(index / 12), (index % 12) + 1);
}
/** "September 2026". */
export function monthLabel(periodMonth: string): string {
  const { year, month } = parts(periodMonth);
  return `${MONTHS[month - 1]} ${year}`;
}
export const monthName = (periodMonth: string) => MONTHS[parts(periodMonth).month - 1] as string;
/** "Sep" / "Sep 2025". */
export function monthShort(periodMonth: string, withYear = false): string {
  const { year, month } = parts(periodMonth);
  const name = (MONTHS[month - 1] as string).slice(0, 3);
  return withYear ? `${name} ${year}` : name;
}
/** How a comparison names its month: "vs. Aug" or "vs. Sep 2025". */
export const compareShort = (compareMonth: string, mode: ReportCompareMode) =>
  `vs. ${monthShort(compareMonth, mode === 'last_year')}`;
/** The current month in the brand's zone, as the builder's default. */
export function currentMonth(now: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(
    now,
  );
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}
/** The months the builder offers: the current one and the eleven before it. */
export const monthOptions = (current: string) =>
  Array.from({ length: 12 }, (_, i) => shiftMonth(current, -i));
/** The number of days in the month. */
export function daysIn(periodMonth: string): number {
  const { year, month } = parts(periodMonth);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export const dayOf = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleDateString('en-GB', { timeZone, day: 'numeric', month: 'short' });

export const DEFAULT_FIELDS = (preparedFor: string, preparedBy: string): ReportFields => ({
  compareMode: 'previous_month',
  sections: [...REPORT_SECTIONS],
  executiveSummary: '',
  recommendations: '',
  preparedFor,
  preparedBy,
  theme: 'dark',
});
export const fieldsOf = (r: ReportDto): ReportFields => ({
  compareMode: r.compareMode,
  sections: r.sections,
  executiveSummary: r.executiveSummary,
  recommendations: r.recommendations,
  preparedFor: r.preparedFor,
  preparedBy: r.preparedBy,
  theme: r.theme,
});
export const sameFields = (a: ReportFields, b: ReportFields) => JSON.stringify(a) === JSON.stringify(b);

/** The pages in order with their numbers ("p. 2"), as the SECTIONS list and the page footers show them. */
export function pageOrder(sections: readonly ReportSection[]): ReportSection[] {
  return REPORT_SECTIONS.filter((s) => sections.includes(s));
}
export const pageNumber = (order: readonly ReportSection[], section: ReportSection) =>
  order.indexOf(section) + 1;
/** The content pages' running number ("01", "02"): the cover is not counted. */
export const kicker = (order: readonly ReportSection[], section: ReportSection) =>
  String(order.filter((s) => s !== 'cover').indexOf(section) + 1).padStart(2, '0');
export const sectionLabel = (s: ReportSection) => REPORT_SECTION_LABEL[s];

/** The report's state in the Recent list: "Draft" or "Sent 2 Sep". */
export function stateLabel(r: ReportDto, timeZone: string): { label: string; sent: boolean } {
  return r.state === 'sent' && r.sentAt
    ? { label: `Sent ${dayOf(r.sentAt, timeZone)}`, sent: true }
    : { label: 'Draft', sent: false };
}

/** Number formats as the interface prints them: 57,397 · 1.23M · 4.8% · +6.4%. */
export const fmtN = (n: number | null) =>
  n === null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.round(n).toLocaleString('en-GB');
export const fmtRate = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
export const fmtChange = (c: number | null) =>
  c === null ? null : `${c >= 0 ? '+' : '−'}${Math.abs(c * 100).toFixed(1)}%`;
export const fmtPts = (a: number | null, b: number | null) =>
  a === null || b === null ? null : `${a - b >= 0 ? '+' : '−'}${Math.abs((a - b) * 100).toFixed(2)} pts`;
export const fmtK = (n: number | null) => (n === null ? '—' : `${Math.round(n / 1000)}k`);

/** The brand kit a report is set in, read from the published brand system (D-29); the fallback where it has none. */
export interface ReportKit {
  dark: string;
  light: string;
  accent: string;
  accentInk: string;
  second: string;
  third: string;
  ink: string;
  muted: string;
  rule: string;
  /** The display face's asset version (loaded as a FontFace under this id) or null for the fallback face. */
  displayFontRef: string | null;
  displayWeight: number;
  swatches: string[];
}
export const FALLBACK_KIT: ReportKit = {
  dark: '#1a1917',
  light: '#f1efea',
  accent: '#d9a35b',
  accentInk: '#8a5a1e',
  second: '#6f6b64',
  third: '#9a958c',
  ink: '#1a1917',
  muted: '#6f6b64',
  rule: '#e7e4de',
  displayFontRef: null,
  displayWeight: 700,
  swatches: ['#1a1917', '#f1efea', '#d9a35b', '#6f6b64', '#9a958c'],
};
const byRole = (doc: BrandSystemDocumentV1, role: string, i = 0) =>
  doc.tokens.colours.filter((c) => c.role === role)[i]?.value ?? null;
export function kitOf(doc: BrandSystemDocumentV1 | null): ReportKit {
  if (!doc) return FALLBACK_KIT;
  const primary = byRole(doc, 'primary');
  const text = byRole(doc, 'text');
  const background = byRole(doc, 'background');
  const accent = byRole(doc, 'accent') ?? byRole(doc, 'secondary');
  const second = byRole(doc, 'secondary') ?? byRole(doc, 'accent', 1);
  const neutral = byRole(doc, 'neutral');
  const display =
    doc.tokens.typeRoles.find((t) => t.role === 'display') ??
    doc.tokens.typeRoles.find((t) => t.role === 'heading');
  const dark = primary ?? text ?? FALLBACK_KIT.dark;
  const kit: ReportKit = {
    dark,
    light: background ?? FALLBACK_KIT.light,
    accent: accent ?? FALLBACK_KIT.accent,
    accentInk: accent ?? FALLBACK_KIT.accentInk,
    second: second ?? FALLBACK_KIT.second,
    third: neutral ?? FALLBACK_KIT.third,
    ink: text ?? FALLBACK_KIT.ink,
    muted: neutral ?? FALLBACK_KIT.muted,
    rule: FALLBACK_KIT.rule,
    displayFontRef: display?.fontAssetId ?? null,
    displayWeight: display?.weight ?? 700,
    swatches: [],
  };
  kit.swatches = [kit.dark, kit.light, kit.accent, kit.second, kit.third];
  return kit;
}

/** The overview page's highlight lines from the figures: strongest channel, top post, the weakest channel. */
export function highlightsOf(f: ReportFiguresDto, cmp: string): Array<{ up: boolean; text: string }> {
  const out: Array<{ up: boolean; text: string }> = [];
  const compared = f.channels.filter((c) => c.impressionsChange !== null);
  const byGrowth = [...compared].sort(
    (a, b) => (b.impressionsChange as number) - (a.impressionsChange as number),
  );
  const best = byGrowth[0];
  if (best)
    out.push({
      up: (best.impressionsChange as number) >= 0,
      text: `${best.displayName} grew fastest: impressions ${fmtChange(best.impressionsChange)} ${cmp}.`,
    });
  const top = f.posts.ranked[0];
  if (top) {
    const ch = f.channels.find((c) => c.channelConnectionId === top.channelConnectionId);
    out.push({
      up: true,
      text: `Top post: on ${ch?.displayName ?? 'a channel'}, ${fmtN(top.engagement)} engagements${top.engagementRate !== null ? ` at ${fmtRate(top.engagementRate)}` : ''}.`,
    });
  }
  const worst = byGrowth[byGrowth.length - 1];
  if (worst && worst !== best)
    out.push({
      up: (worst.impressionsChange as number) >= 0,
      text: `${worst.displayName} ${(worst.impressionsChange as number) >= 0 ? 'grew least' : 'declined'}: impressions ${fmtChange(worst.impressionsChange)}.`,
    });
  if (!f.sample.sufficient)
    out.push({
      up: false,
      text: `Insufficient sample: ${f.sample.current} and ${f.sample.previous} posts of ${f.sample.minimum} needed to compare.`,
    });
  return out;
}
