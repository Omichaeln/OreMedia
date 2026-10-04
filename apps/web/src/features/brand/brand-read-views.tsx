import { useState, type ReactNode } from 'react';
import { prohibitedPhrasesIn } from '@oremedia/editor';
import {
  CHANNEL_GUIDANCE_FIELDS,
  WRITING_PARTS,
  channelOverride,
  type BrandSystemDocumentV1,
  type VocabularyUsage,
} from '@oremedia/contracts/brand';
import { Badge, Field, Skeleton, Textarea, cn } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { AssetThumb } from '../assets/asset-thumb';
import { useAsset } from '../assets/use-assets';
import { useChannelLimits } from '../publishing/use-publishing';
import { useBrandContext } from './brand-context';
import { TypographySpecimen } from './typography-specimen';
import { contrast } from './brand-kit-editor';
import {
  CHANNEL_FIELD_LABEL,
  PlatformLimits,
  ProvenanceBadge,
  STYLE_TOPICS,
  WRITING_PART_LABEL,
  channelLabel,
  contentTypeLabel,
} from './guidance-fields';

type Doc = BrandSystemDocumentV1;
type Colour = Doc['tokens']['colours'][number];

/** A read-only section: an uppercase heading over its content, the same rule as the home and review screens. */
export function ReadSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="border-b border-border pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** An asset of the brand by id, as its current version's thumbnail (read only). */
function AssetById({ assetId, className }: { assetId: string; className?: string }) {
  const asset = useAsset(assetId);
  const version = asset.data?.currentVersion;
  if (!version)
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-sm border border-border bg-muted text-xs text-muted-foreground',
          className,
        )}
      >
        {asset.isError ? 'Unavailable' : asset.isPending ? 'Loading' : 'Processing'}
      </div>
    );
  return (
    <AssetThumb
      assetVersionId={version.id}
      alt={asset.data?.name ?? ''}
      className={cn('rounded-sm border border-border bg-muted object-contain', className)}
    />
  );
}

const nothing = (what: string) => <p className="text-sm text-muted-foreground">No {what} yet.</p>;
const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** Swatch text in whichever of near-black or near-white reads better on the colour. */
const inkOn = (hex: string) =>
  (contrast(hex, '#111111') ?? 0) >= (contrast(hex, '#ffffff') ?? 0) ? '#111111' : '#ffffff';

const ROLE_GROUPS: Array<[string, Colour['role'][]]> = [
  ['Primary and background', ['primary', 'background']],
  ['Accent and secondary', ['accent', 'secondary']],
  ['Neutral, text and semantic', ['neutral', 'text', 'semantic']],
];

function Swatch({ c }: { c: Colour }) {
  return (
    <li className="flex w-40 flex-col gap-1">
      <span
        className="flex h-20 items-end rounded-md border border-border p-2 text-sm font-medium"
        style={{ background: c.value, color: inkOn(c.value) }}
        aria-hidden="true"
      >
        Aa
      </span>
      <span className="text-sm font-medium">{c.key}</span>
      <span className="font-mono text-xs text-muted-foreground">
        {c.value.toUpperCase()} · {c.role}
      </span>
    </li>
  );
}

const verdict = (ratio: number) =>
  ratio >= 7
    ? { tone: 'good' as const, label: 'AA · AAA' }
    : ratio >= 4.5
      ? { tone: 'good' as const, label: 'AA' }
      : ratio >= 3
        ? { tone: 'warning' as const, label: 'Large text only' }
        : { tone: 'critical' as const, label: 'Not for text' };

/** Colour tokens by role, then every text-on-surface pairing of the palette with its WCAG ratio and verdict. */
export function ColourView({ doc }: { doc: Doc }) {
  const colours = doc.tokens.colours;
  if (colours.length === 0) return nothing('colours');
  const surfaces = colours.filter((c) => ['background', 'primary', 'accent', 'secondary'].includes(c.role));
  const inks = colours.filter((c) => ['text', 'background', 'neutral'].includes(c.role));
  const pairs = surfaces.flatMap((bg) =>
    inks.filter((fg) => fg.key !== bg.key).map((fg) => ({ fg, bg, ratio: contrast(fg.value, bg.value) })),
  );
  return (
    <div className="flex flex-col gap-8">
      {ROLE_GROUPS.map(([title, roles]) => {
        const group = colours.filter((c) => roles.includes(c.role));
        return group.length === 0 ? null : (
          <ReadSection key={title} title={title}>
            <ul className="flex flex-wrap gap-4">
              {group.map((c) => (
                <Swatch key={c.key} c={c} />
              ))}
            </ul>
          </ReadSection>
        );
      })}
      {pairs.length > 0 && (
        <ReadSection title={`Text pairings · target ${doc.tokens.contrastTarget}`}>
          <ul className="flex flex-col divide-y divide-border" aria-label="Text pairings">
            {pairs.map(({ fg, bg, ratio }) => {
              const v = ratio === null ? null : verdict(ratio);
              return (
                <li key={`${fg.key}-${bg.key}`} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span
                    className="w-28 rounded-md border border-border px-2 py-1.5 font-medium"
                    style={{ background: bg.value, color: fg.value }}
                    aria-hidden="true"
                  >
                    Aa text
                  </span>
                  <span className="min-w-0 flex-1">
                    {fg.key} on {bg.key}
                  </span>
                  <span className="font-mono text-xs tabular-nums">
                    {ratio === null ? '—' : `${ratio.toFixed(1)} : 1`}
                  </span>
                  {v && <Badge tone={v.tone}>{v.label}</Badge>}
                </li>
              );
            })}
          </ul>
        </ReadSection>
      )}
    </div>
  );
}

const Chips = ({ items }: { items: string[] }) => (
  <ul className="flex flex-wrap gap-1.5">
    {items.map((t) => (
      <li key={t}>
        <Badge glyph={false}>{t}</Badge>
      </li>
    ))}
  </ul>
);

/** Voice and personality: the summary, tone, terms, prohibited phrases, locales, then personality and the rules. */
export function VoiceView({ doc }: { doc: Doc }) {
  const v = doc.voice;
  return (
    <div className="flex flex-col gap-8">
      <ReadSection title="Summary">
        {v.summary ? <p className="max-w-prose text-sm">{v.summary}</p> : nothing('voice summary')}
        {v.tone.length > 0 && <Chips items={v.tone} />}
      </ReadSection>
      <ReadSection title="Preferred terms">
        {v.preferredTerms.length === 0 ? (
          nothing('preferred terms')
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {v.preferredTerms.map((t) => (
              <li key={t.use} className="flex flex-wrap gap-x-2 py-1.5">
                <span className="font-medium">Use “{t.use}”</span>
                {t.avoid.length > 0 && (
                  <span className="text-muted-foreground">
                    instead of {t.avoid.map((a) => `“${a}”`).join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </ReadSection>
      <ReadSection title="Never write">
        {v.prohibitedPhrases.length === 0 ? (
          nothing('prohibited phrases')
        ) : (
          <Chips items={v.prohibitedPhrases} />
        )}
      </ReadSection>
      {v.locales.length > 0 && (
        <ReadSection title="Locales">
          <Chips items={v.locales} />
        </ReadSection>
      )}
      <PersonalityView voice={v} />
      <DraftCheck voice={v} />
    </div>
  );
}

/** A word or phrase as a whole-word, case-insensitive match (so "blend" does not match "blender"). */
const wordIn = (text: string, phrase: string) =>
  new RegExp(
    `(^|[^\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`,
    'iu',
  ).test(text);

/**
 * "Check a draft": the prohibited-phrase rule the studio blocks on save (the same function), and the preferred terms
 * as suggestions, which the studio does not enforce. Nothing leaves the page.
 */
function DraftCheck({ voice }: { voice: Doc['voice'] }) {
  const [text, setText] = useState('');
  const blocked = text.trim() ? prohibitedPhrasesIn(text, voice.prohibitedPhrases) : [];
  const suggestions = text.trim()
    ? voice.preferredTerms.flatMap((t) =>
        t.avoid.filter((a) => a && wordIn(text, a)).map((a) => ({ use: t.use, avoid: a })),
      )
    : [];
  return (
    <ReadSection title="Check a draft">
      <Field
        label="Draft copy"
        htmlFor="voice-draft"
        hint="Prohibited phrases are the check the studio blocks on save; preferred terms are suggestions."
      >
        <Textarea id="voice-draft" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {text.trim() && (
        <ul
          className="flex flex-col gap-1.5 text-sm"
          aria-label="Draft findings"
          data-testid="draft-findings"
        >
          {blocked.map((p) => (
            <li key={`b:${p}`} className="flex flex-wrap items-center gap-2">
              <Badge tone="critical">Blocked</Badge>
              <span>Never write “{p}”.</span>
            </li>
          ))}
          {suggestions.map((s) => (
            <li key={`s:${s.avoid}`} className="flex flex-wrap items-center gap-2">
              <Badge tone="warning">Suggestion</Badge>
              <span>
                Use “{s.use}” instead of “{s.avoid}”.
              </span>
            </li>
          ))}
          {blocked.length === 0 && suggestions.length === 0 && (
            <li className="flex items-center gap-2">
              <Badge tone="good">Clear</Badge>
              <span>No prohibited phrases or avoided terms.</span>
            </li>
          )}
        </ul>
      )}
    </ReadSection>
  );
}

/** The parts of the document each brand system section reads; used to say what a proposed update changes. */
const SECTION_PARTS: Array<{ key: string; label: string; parts: (d: Doc) => unknown }> = [
  { key: 'logo', label: 'Logo', parts: (d) => d.logoRules },
  { key: 'colour', label: 'Colour', parts: (d) => [d.tokens.colours, d.tokens.contrastTarget] },
  {
    key: 'typography',
    label: 'Typography & layout',
    parts: (d) => [d.tokens.typeRoles, d.tokens.spacingScale, d.tokens.radii],
  },
  {
    key: 'voice',
    label: 'Voice & personality',
    parts: (d) => {
      const { audiences: _a, examples: _e, ...voice } = d.voice;
      return voice;
    },
  },
  { key: 'messaging', label: 'Messaging', parts: (d) => [d.messaging ?? null, d.voice.audiences] },
  { key: 'vocabulary', label: 'Vocabulary', parts: (d) => d.vocabulary ?? [] },
  { key: 'writing', label: 'Writing patterns', parts: (d) => d.writingPatterns ?? {} },
  { key: 'examples', label: 'Examples', parts: (d) => d.voice.examples },
  { key: 'templates', label: 'Templates', parts: (d) => d.copyTemplates ?? [] },
  {
    key: 'imagery',
    label: 'Imagery',
    parts: (d) => d.patterns.find((p) => p.key === REFERENCE_PATTERN) ?? null,
  },
  {
    key: 'patterns',
    label: 'Visual patterns',
    parts: (d) => d.patterns.filter((p) => p.key !== REFERENCE_PATTERN),
  },
  {
    key: 'channels',
    label: 'Channel guidance',
    parts: (d) => [d.channelGuidance, d.channelBaseline ?? null],
  },
  { key: 'guidelines', label: 'Guidelines', parts: (d) => d.guidelines ?? null },
];

/** The sections whose content differs between a proposed update and the brand system (none when both are equal). */
export function changedSections(next: Doc, base: Doc): Array<{ key: string; label: string }> {
  return SECTION_PARTS.filter((s) => JSON.stringify(s.parts(next)) !== JSON.stringify(s.parts(base))).map(
    ({ key, label }) => ({ key, label }),
  );
}

/** BSC-2: the logo read view lives with the logo editor (vector previews on grounds, guidance, download). */
export { LogoView } from './logo-rules';

const REFERENCE_PATTERN = 'reference-imagery';

export function ImageryView({ doc }: { doc: Doc }) {
  const reference = doc.patterns.find((p) => p.key === REFERENCE_PATTERN);
  if (!reference || reference.exampleAssetIds.length === 0) return nothing('reference imagery');
  return (
    <div className="flex flex-col gap-3">
      {reference.description && <p className="max-w-prose text-sm">{reference.description}</p>}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {reference.exampleAssetIds.map((id) => (
          <li key={id}>
            <AssetById assetId={id} className="aspect-square w-full object-cover" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Typography & layout: the brand's type roles as a live specimen in their own font files, then spacing and radii. */
export function TypographyView({ doc }: { doc: Doc }) {
  return <TypographySpecimen doc={doc} />;
}

export function PatternsView({ doc }: { doc: Doc }) {
  const patterns = doc.patterns.filter((p) => p.key !== REFERENCE_PATTERN);
  if (patterns.length === 0) return nothing('patterns');
  return (
    <ul className="flex flex-col divide-y divide-border text-sm">
      {patterns.map((p) => (
        <li key={p.key} className="py-2">
          <p className="font-medium">{p.key}</p>
          <p className="text-muted-foreground">{p.description}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {p.exampleAssetIds.length} examples · {p.templateVersionIds.length} templates
          </p>
        </li>
      ))}
    </ul>
  );
}

export function GuidelinesView({ doc }: { doc: Doc }) {
  const g = doc.guidelines;
  if (!g) return nothing('imported guidelines');
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="font-medium">{g.source.name}</p>
        {g.source.description && <p className="text-sm text-muted-foreground">{g.source.description}</p>}
      </div>
      <ul className="flex flex-col gap-1">
        {g.documents.map((d) => (
          <li key={d.path}>
            <details className="rounded-md border border-border">
              <summary className="cursor-pointer px-2 py-1.5 text-sm">
                <code className="text-xs">{d.path}</code>
              </summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border p-2 text-xs">
                {d.content}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The overview: the voice beside the palette, then one tile per part of the system with what it holds. */
export function OverviewView({
  doc,
  brandName,
  factCount,
  onOpen,
}: {
  doc: Doc;
  brandName: string;
  factCount: number | undefined;
  onOpen: (section: string) => void;
}) {
  const tiles: Array<[string, string, string]> = [
    ['logo', 'Logo', `${doc.logoRules.length} variant${doc.logoRules.length === 1 ? '' : 's'}`],
    ['colour', 'Colour', `${doc.tokens.colours.length} tokens · ${doc.tokens.contrastTarget} target`],
    ['typography', 'Typography', `${doc.tokens.typeRoles.length} roles`],
    [
      'voice',
      'Voice & personality',
      `${doc.voice.tone.length} tone words · ${doc.voice.preferredTerms.length} preferred terms · ${doc.voice.prohibitedPhrases.length} prohibited`,
    ],
    [
      'messaging',
      'Messaging',
      `${count(doc.messaging?.pillars.length ?? 0, 'pillar')} · ${count(doc.messaging?.keyMessages.length ?? 0, 'key message')}`,
    ],
    ['vocabulary', 'Vocabulary', count(doc.vocabulary?.length ?? 0, 'term')],
    ['writing', 'Writing patterns', count(Object.keys(doc.writingPatterns ?? {}).length, 'part')],
    ['examples', 'Examples', count(doc.voice.examples.length, 'example')],
    ['templates', 'Templates', count(doc.copyTemplates?.length ?? 0, 'copy template')],
    [
      'imagery',
      'Imagery',
      `${doc.patterns.find((p) => p.key === REFERENCE_PATTERN)?.exampleAssetIds.length ?? 0} reference images`,
    ],
    [
      'patterns',
      'Visual patterns',
      count(doc.patterns.filter((p) => p.key !== REFERENCE_PATTERN).length, 'pattern'),
    ],
    ['channels', 'Channels', doc.channelGuidance.map((c) => c.providerKey).join(', ') || 'No guidance'],
    ['facts', 'Facts', factCount === undefined ? '…' : `${factCount} in effect`],
  ];
  const accent = doc.tokens.colours.find((c) => c.role === 'primary') ?? doc.tokens.colours[0];
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 lg:grid-cols-2">
        <div
          className="flex min-h-48 flex-col justify-between rounded-lg border border-border p-6"
          style={accent ? { background: accent.value, color: inkOn(accent.value) } : undefined}
        >
          <p className="text-xs font-semibold uppercase tracking-widest">{brandName}</p>
          <ul className="flex gap-1.5" aria-label="Palette">
            {doc.tokens.colours.slice(0, 6).map((c) => (
              <li
                key={c.key}
                title={`${c.key} ${c.value}`}
                className="h-2.5 w-7 rounded-sm border border-black/10"
                style={{ background: c.value }}
              >
                <span className="sr-only">{`${c.key} ${c.value}`}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-3">
          {doc.voice.summary ? (
            <p className="text-base leading-relaxed">{doc.voice.summary}</p>
          ) : (
            nothing('voice summary')
          )}
          {doc.voice.tone.length > 0 && <Chips items={doc.voice.tone} />}
        </div>
      </div>
      <ul className="grid overflow-hidden rounded-md border border-border sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(([key, title, detail]) => (
          <li key={key} className="border-b border-r border-border">
            <button
              type="button"
              onClick={() => onOpen(key)}
              className={cn(
                'flex h-full w-full flex-col gap-1 bg-background p-4 text-left hover:bg-secondary',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              )}
            >
              <span className="text-sm font-medium">{title}</span>
              <span className="text-xs text-muted-foreground">{detail}</span>
            </button>
          </li>
        ))}
      </ul>
      <ReadSection title="How this is used">
        <p className="max-w-prose text-sm text-muted-foreground">
          Every save of the brand system is kept as a record, and every document revision records the one it
          was designed against. Agents read an immutable snapshot of the brand system, the approved facts and
          the active objective; imported guideline text is evidence, never permission. These tokens style
          creative documents only, never this application.
        </p>
      </ReadSection>
    </div>
  );
}

/** A titled list of guidance rows, each with its provenance; nothing when the list is empty. */
function GuidanceList<T extends { provenance?: Parameters<typeof ProvenanceBadge>[0]['provenance'] }>({
  title,
  items,
  render,
}: {
  title: string;
  items: readonly T[];
  render: (item: T) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <ReadSection title={title}>
      <ul className="flex flex-col divide-y divide-border text-sm">
        {items.map((item, i) => (
          <li key={i} className="flex flex-wrap items-start justify-between gap-2 py-2">
            <div className="min-w-0 flex-1">{render(item)}</div>
            <ProvenanceBadge provenance={item.provenance} />
          </li>
        ))}
      </ul>
    </ReadSection>
  );
}

/** Personality, principles, spelling, style rules and claim rules (BSC-1), under the voice. */
function PersonalityView({ voice: v }: { voice: Doc['voice'] }) {
  const topic = (t: string) => STYLE_TOPICS.find((x) => x.value === t)?.label ?? t;
  return (
    <>
      <GuidanceList
        title="Personality"
        items={v.personality ?? []}
        render={(p) => (
          <>
            <span className="font-medium">{p.trait}</span>
            {p.note && <span className="text-muted-foreground"> · {p.note}</span>}
          </>
        )}
      />
      <GuidanceList
        title="Principles"
        items={v.principles ?? []}
        render={(p) => (
          <>
            <p className="font-medium">{p.statement}</p>
            {p.rationale && <p className="text-muted-foreground">{p.rationale}</p>}
          </>
        )}
      />
      {v.spelling && (
        <ReadSection title="Spelling">
          <p className="text-sm">
            <span className="font-medium">{v.spelling.locale}</span>
            {v.spelling.notes && <span className="text-muted-foreground"> · {v.spelling.notes}</span>}
          </p>
        </ReadSection>
      )}
      <GuidanceList
        title="Style rules"
        items={v.styleRules ?? []}
        render={(r) => (
          <>
            <span className="font-medium">{topic(r.topic)}:</span> {r.rule}
          </>
        )}
      />
      <GuidanceList title="Claim rules" items={v.claimRules ?? []} render={(r) => r.rule} />
    </>
  );
}

/** Messaging: positioning, value proposition, pillars with their proof (by statement), key messages, audiences. */
export function MessagingView({
  doc,
  facts,
}: {
  doc: Doc;
  facts: Array<{ id: string; statement: string }> | undefined;
}) {
  const m = doc.messaging;
  const audiences = doc.voice.audiences;
  if (!m && audiences.length === 0) return nothing('messaging');
  const pillarTitle = (key: string) => m?.pillars.find((p) => p.key === key)?.title ?? key;
  return (
    <div className="flex flex-col gap-8">
      {m?.positioning && (
        <ReadSection title="Positioning">
          <p className="max-w-prose text-sm">{m.positioning}</p>
        </ReadSection>
      )}
      {m?.valueProposition && (
        <ReadSection title="Value proposition">
          <p className="max-w-prose text-sm">{m.valueProposition}</p>
        </ReadSection>
      )}
      <GuidanceList
        title="Pillars"
        items={m?.pillars ?? []}
        render={(p) => (
          <>
            <p className="font-medium">{p.title}</p>
            {p.statement && <p className="text-muted-foreground">{p.statement}</p>}
            {p.proofFactIds.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5 text-xs" aria-label={`Proof for ${p.title}`}>
                {p.proofFactIds.map((id) => {
                  const fact = facts?.find((f) => f.id === id);
                  return (
                    <li key={id} className="flex flex-wrap items-center gap-1.5">
                      {fact ? (
                        <>
                          <Badge tone="good">Proof</Badge> {fact.statement}
                        </>
                      ) : facts ? (
                        <Badge tone="warning">A cited fact is no longer in effect</Badge>
                      ) : (
                        <span className="text-muted-foreground">Loading proof…</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      />
      <GuidanceList
        title="Key messages"
        items={m?.keyMessages ?? []}
        render={(k) => (
          <>
            {k.text}
            {k.pillarKey && <span className="text-muted-foreground"> · {pillarTitle(k.pillarKey)}</span>}
          </>
        )}
      />
      <GuidanceList
        title="Audiences"
        items={audiences}
        render={(a) => (
          <>
            <p className="font-medium">{a.key}</p>
            {a.description && <p className="text-muted-foreground">{a.description}</p>}
            {(a.needs?.length ?? 0) > 0 && <p className="text-xs">Needs: {a.needs?.join('; ')}</p>}
            {(a.objections?.length ?? 0) > 0 && (
              <p className="text-xs">Objections: {a.objections?.join('; ')}</p>
            )}
          </>
        )}
      />
    </div>
  );
}

const USAGE: Record<VocabularyUsage, { label: string; tone: 'good' | 'neutral' | 'warning' | 'critical' }> = {
  preferred: { label: 'Preferred', tone: 'good' },
  allowed: { label: 'Allowed', tone: 'neutral' },
  avoid: { label: 'Avoid', tone: 'warning' },
  prohibited: { label: 'Prohibited', tone: 'critical' },
};

export function VocabularyView({ doc }: { doc: Doc }) {
  const terms = doc.vocabulary ?? [];
  if (terms.length === 0) return nothing('vocabulary');
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <caption className="sr-only">Vocabulary</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Term
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Usage
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Instead or also
            </th>
            <th scope="col" className="py-1.5 font-medium">
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          {terms.map((t) => (
            <tr key={t.term} className="border-b border-border align-top">
              <td className="py-2 pr-3">
                <span className="font-medium">{t.term}</span>
                {t.definition && <p className="text-xs text-muted-foreground">{t.definition}</p>}
              </td>
              <td className="py-2 pr-3">
                <Badge tone={USAGE[t.usage].tone}>{USAGE[t.usage].label}</Badge>
              </td>
              <td className="py-2 pr-3">{t.alternatives.join(', ') || '—'}</td>
              <td className="py-2">
                <ProvenanceBadge provenance={t.provenance} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WritingView({ doc }: { doc: Doc }) {
  const patterns = doc.writingPatterns ?? {};
  const parts = WRITING_PARTS.filter((p) => patterns[p]);
  if (parts.length === 0) return nothing('writing patterns');
  return (
    <div className="flex flex-col gap-8">
      {parts.map((part) => {
        const p = patterns[part];
        if (!p) return null;
        return (
          <ReadSection key={part} title={WRITING_PART_LABEL[part]}>
            <div className="flex flex-col gap-2 text-sm">
              <ProvenanceBadge provenance={p.provenance} />
              {p.guidance && <p className="max-w-prose">{p.guidance}</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                {p.dos.length > 0 && (
                  <ul className="flex flex-col gap-1" aria-label={`${WRITING_PART_LABEL[part]}: dos`}>
                    {p.dos.map((d) => (
                      <li key={d} className="flex gap-1.5">
                        <Badge tone="good">Do</Badge> {d}
                      </li>
                    ))}
                  </ul>
                )}
                {p.donts.length > 0 && (
                  <ul className="flex flex-col gap-1" aria-label={`${WRITING_PART_LABEL[part]}: don'ts`}>
                    {p.donts.map((d) => (
                      <li key={d} className="flex gap-1.5">
                        <Badge tone="critical">Don&apos;t</Badge> {d}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {p.examples.map((e) => (
                <p key={e} className="rounded-md border border-border p-2">
                  “{e}”
                </p>
              ))}
            </div>
          </ReadSection>
        );
      })}
    </div>
  );
}

export function ExamplesView({ doc }: { doc: Doc }) {
  const examples = doc.voice.examples;
  if (examples.length === 0) return nothing('examples');
  return (
    <ul className="flex flex-col gap-2">
      {examples.map((e, i) => (
        <li key={i} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={e.verdict === 'on_brand' ? 'good' : 'critical'}>
              {e.verdict === 'on_brand' ? 'On brand' : 'Off brand'}
            </Badge>
            {e.channelKey && <Badge glyph={false}>{channelLabel(e.channelKey)}</Badge>}
            {e.contentType && <Badge glyph={false}>{contentTypeLabel(e.contentType)}</Badge>}
            <ProvenanceBadge provenance={e.provenance} />
          </div>
          <p className="mt-2">“{e.text}”</p>
          {(e.rationale || e.note) && (
            <p className="mt-1 text-xs text-muted-foreground">{e.rationale || e.note}</p>
          )}
          {e.rewrite && (
            <p className="mt-1 text-xs">
              <span className="font-medium">On brand:</span> “{e.rewrite}”
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function TemplatesView({ doc }: { doc: Doc }) {
  const templates = doc.copyTemplates ?? [];
  if (templates.length === 0) return nothing('copy templates');
  return (
    <ul className="flex flex-col gap-3">
      {templates.map((t) => (
        <li key={t.key} className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{t.name}</span>
            <Badge glyph={false}>{contentTypeLabel(t.contentType)}</Badge>
            {t.channelKeys.length === 0 ? (
              <Badge glyph={false}>Any channel</Badge>
            ) : (
              t.channelKeys.map((k) => (
                <Badge key={k} glyph={false}>
                  {channelLabel(k)}
                </Badge>
              ))
            )}
            <ProvenanceBadge provenance={t.provenance} />
          </div>
          {t.purpose && <p className="text-muted-foreground">{t.purpose}</p>}
          <ol className="flex list-decimal flex-col gap-0.5 pl-5" aria-label={`Parts of ${t.name}`}>
            {t.structure.map((part, i) => (
              <li key={i}>
                <span className="font-medium">{part.slot}</span>
                {part.guidance && <span>: {part.guidance}</span>}
                {part.maxLength !== undefined && (
                  <span className="text-muted-foreground"> (at most {part.maxLength} characters)</span>
                )}
              </li>
            ))}
          </ol>
          {t.example && <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-2">{t.example}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Channel guidance: the baseline, then per channel what applies there, each field marked inherited from the
 * baseline or overridden, beside the platform's limits (which win over any preference).
 */
export function ChannelsView({ doc }: { doc: Doc }) {
  const { brandId } = useBrandContext();
  const limits = useChannelLimits(brandId);
  const baseline = doc.channelBaseline ?? {};
  const baseFields = CHANNEL_GUIDANCE_FIELDS.filter((f) => baseline[f]?.trim());
  if (doc.channelGuidance.length === 0 && baseFields.length === 0) return nothing('channel guidance');
  return (
    <div className="flex flex-col gap-8">
      <ReadSection title="All channels (baseline)">
        {baseFields.length === 0 ? (
          nothing('baseline guidance')
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
            {baseFields.map((f) => (
              <div key={f} className="contents">
                <dt className="font-medium">{CHANNEL_FIELD_LABEL[f]}</dt>
                <dd className="text-muted-foreground">{baseline[f]}</dd>
              </div>
            ))}
          </dl>
        )}
      </ReadSection>
      {doc.channelGuidance.map((c) => {
        const fields = CHANNEL_GUIDANCE_FIELDS.flatMap((f) => {
          const own = channelOverride(c, f);
          const base = baseline[f]?.trim() ? baseline[f] : undefined;
          return own !== undefined
            ? [{ f, value: own, inherited: false }]
            : base !== undefined
              ? [{ f, value: base, inherited: true }]
              : [];
        });
        return (
          <ReadSection key={c.providerKey} title={channelLabel(c.providerKey)}>
            <div
              className="grid gap-4 lg:grid-cols-[1fr_16rem]"
              data-testid={`channel-view-${c.providerKey}`}
            >
              <div className="flex min-w-0 flex-col gap-2 text-sm">
                <ProvenanceBadge provenance={c.provenance} />
                {fields.length === 0 && nothing('guidance for this channel')}
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr]">
                  {fields.map(({ f, value, inherited }) => (
                    <div key={f} className="contents">
                      <dt className="font-medium">{CHANNEL_FIELD_LABEL[f]}</dt>
                      <dd>
                        <p>{value}</p>
                        <p className="text-xs text-muted-foreground">
                          {inherited ? 'Inherited from baseline' : 'Overridden for this channel'}
                        </p>
                      </dd>
                    </div>
                  ))}
                </dl>
                {c.preferredFormats.length > 0 && <Chips items={c.preferredFormats} />}
                {c.formats && <p className="text-muted-foreground">Formats: {c.formats}</p>}
                {c.audience && <p className="text-muted-foreground">Audience: {c.audience}</p>}
                {(c.examples ?? []).map((e) => (
                  <p key={e.text} className="rounded-md border border-border p-2">
                    “{e.text}”
                  </p>
                ))}
              </div>
              <div>
                {limits.isPending && <Skeleton label="Loading platform limits" lines={3} />}
                {limits.isError && (
                  <RequestError error={limits.error} onRetry={() => void limits.refetch()} />
                )}
                {limits.isSuccess && (
                  <PlatformLimits limit={limits.data.items.find((l) => l.providerKey === c.providerKey)} />
                )}
              </div>
            </div>
          </ReadSection>
        );
      })}
    </div>
  );
}
