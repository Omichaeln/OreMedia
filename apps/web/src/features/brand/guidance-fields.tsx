import type { ReactNode } from 'react';
import type {
  ChannelGuidanceField,
  CopyContentType,
  GuidanceProvenance,
  StyleRuleTopic,
  WritingPart,
} from '@oremedia/contracts/brand';
import { Badge, Button, Input, type Tone } from '@oremedia/ui';
import type { ChannelLimitsV1 } from '@oremedia/contracts/publishing';
import { RELEASE_1_PROVIDERS } from '../publishing/channel-connect';

/** One part of the brand kit editor: a heading, what it holds, then its fields. */
export function EditorSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

const PROVENANCE: Record<GuidanceProvenance['origin'], { tone: Tone; label: (cited: number) => string }> = {
  user: { tone: 'neutral', label: () => 'Entered by you' },
  imported: { tone: 'info', label: () => 'From your documents' },
  inferred: { tone: 'info', label: (n) => `Inferred from examples (${n} cited)` },
  suggested: { tone: 'warning', label: () => 'AI suggestion' },
};

/** Where a guidance item came from (BSC-1 provenance); nothing for items written before provenance existed. */
export function ProvenanceBadge({ provenance }: { provenance: GuidanceProvenance | undefined }) {
  if (!provenance) return null;
  const p = PROVENANCE[provenance.origin];
  return (
    <Badge tone={p.tone} glyph={false} data-testid="provenance">
      {p.label(provenance.evidence?.length ?? 0)}
      {provenance.confidence === 'low' ? ' · low confidence' : ''}
    </Badge>
  );
}

/** An item a person adds or edits is theirs: its provenance becomes `user` (any cited evidence no longer applies). */
export const byPerson = <T extends object>(item: T): T & { provenance: GuidanceProvenance } => ({
  ...item,
  provenance: { origin: 'user' },
});

/**
 * A list of short lines edited one row each (dos, needs, alternatives...): no separators to type. Blank rows are
 * dropped when the brand system is saved.
 */
export function ListEditor({
  id,
  label,
  item,
  values,
  onChange,
  max,
  maxLength = 300,
}: {
  id: string;
  /** The list's name, read before each row ("Dos", "Needs"). */
  label: string;
  /** One row's name for the Add button ("do", "need"). */
  item: string;
  values: string[];
  onChange: (next: string[]) => void;
  max: number;
  maxLength?: number;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" id={id}>
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{label}</legend>
      {values.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {values.map((v, i) => (
            <li key={i} className="flex items-center gap-2">
              <Input
                aria-label={`${label} ${i + 1}`}
                value={v}
                maxLength={maxLength}
                onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <Button size="sm" variant="ghost" onClick={() => onChange(values.filter((_, j) => j !== i))}>
                Remove<span className="sr-only"> {`${label} ${i + 1}`}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button size="sm" onClick={() => onChange([...values, ''])} disabled={values.length >= max}>
          Add {item}
        </Button>
      </div>
    </fieldset>
  );
}

/** A lowercase key with hyphens, as pattern and template keys are written. */
export const slug = (text: string) => text.toLowerCase().replace(/\s+/g, '-');

export const channelLabel = (key: string): string =>
  RELEASE_1_PROVIDERS.find((p) => p.key === key)?.label ?? key;

export const CONTENT_TYPES: Array<{ value: CopyContentType; label: string }> = [
  { value: 'social_post', label: 'Social post' },
  { value: 'article', label: 'Article' },
  { value: 'email', label: 'Email' },
  { value: 'ad', label: 'Ad' },
  { value: 'landing_section', label: 'Landing page section' },
  { value: 'other', label: 'Other' },
];
export const contentTypeLabel = (t: CopyContentType) => CONTENT_TYPES.find((c) => c.value === t)?.label ?? t;

export const STYLE_TOPICS: Array<{ value: StyleRuleTopic; label: string }> = [
  { value: 'numbers', label: 'Numbers' },
  { value: 'dates', label: 'Dates' },
  { value: 'capitalisation', label: 'Capitalisation' },
  { value: 'punctuation', label: 'Punctuation' },
  { value: 'formatting', label: 'Formatting' },
  { value: 'other', label: 'Other' },
];

export const WRITING_PART_LABEL: Record<WritingPart, string> = {
  headline: 'Headlines',
  introduction: 'Introductions',
  body: 'Body copy',
  cta: 'Calls to action',
  long_form: 'Long-form',
};

/** The Select value for "no choice" (Radix Select items cannot have an empty value). */
export const NONE = '__none';

export const CHANNEL_FIELD_LABEL: Record<ChannelGuidanceField, string> = {
  objectives: 'Objectives',
  toneAdaptation: 'Tone and caption style',
  conventions: 'Conventions',
  cta: 'Calls to action',
  accessibility: 'Accessibility',
  hashtags: 'Hashtags',
  mentions: 'Mentions',
  links: 'Links',
  frequency: 'Posting frequency',
};

const yesNo = (v: boolean) => (v ? 'Supported' : 'Not supported');
const duration = (sec: number) => (sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} s`);

/**
 * A channel's platform limits from the capability register, read-only: set by the platform, they win over the
 * brand's channel guidance wherever the two conflict.
 */
export function PlatformLimits({ limit }: { limit: ChannelLimitsV1 | undefined }) {
  if (!limit)
    return (
      <p className="text-xs text-muted-foreground">No platform limits are registered for this channel.</p>
    );
  const rows: Array<[string, string]> = [
    [
      'Text',
      `Up to ${limit.text.maxLength.toLocaleString()} characters${limit.text.weighted ? ' (weighted)' : ''}`,
    ],
    ['Links', yesNo(limit.text.supportsLinks)],
    ['Mentions', yesNo(limit.text.supportsMentions)],
    ['Hashtags', yesNo(limit.text.supportsHashtags)],
    ['Images', limit.image ? `Up to ${limit.image.maxCount}` : 'Not supported'],
    ['Video', limit.video ? `Up to ${duration(limit.video.maxDurationSec)}` : 'Not supported'],
    ...(limit.carousel
      ? [['Carousel', `${limit.carousel.min} to ${limit.carousel.max} items`] as [string, string]]
      : []),
    ['Alt text', yesNo(limit.altText)],
  ];
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3 text-xs" data-testid="platform-limits">
      <div>
        <p className="font-medium">Platform limits · {limit.vendor}</p>
        <p className="text-muted-foreground">
          Set by the platform. They win over the brand&apos;s preferences.
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
