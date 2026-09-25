import { useState, type ReactNode } from 'react';
import { prohibitedPhrasesIn } from '@oremedia/editor';
import type { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { Badge, Field, Textarea, cn } from '@oremedia/ui';
import { AssetThumb } from '../assets/asset-thumb';
import { useAsset } from '../assets/use-assets';
import { contrast } from './brand-kit-editor';

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

const nothing = (what: string) => <p className="text-sm text-muted-foreground">No {what} in this version.</p>;

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

/** Voice and writing: the summary, tone, audiences, terms, prohibited phrases, locales and examples. */
export function VoiceView({ doc }: { doc: Doc }) {
  const v = doc.voice;
  return (
    <div className="flex flex-col gap-8">
      <ReadSection title="Summary">
        {v.summary ? <p className="max-w-prose text-sm">{v.summary}</p> : nothing('voice summary')}
        {v.tone.length > 0 && <Chips items={v.tone} />}
      </ReadSection>
      <ReadSection title="Audiences">
        {v.audiences.length === 0 ? (
          nothing('audiences')
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            {v.audiences.map((a) => (
              <div key={a.key} className="contents">
                <dt className="font-medium">{a.key}</dt>
                <dd className="text-muted-foreground">{a.description}</dd>
              </div>
            ))}
          </dl>
        )}
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
      <ReadSection title="Examples">
        {v.examples.length === 0 ? (
          nothing('examples')
        ) : (
          <ul className="flex flex-col gap-2">
            {v.examples.map((e, i) => (
              <li key={i} className="rounded-md border border-border p-3 text-sm">
                <Badge tone={e.verdict === 'on_brand' ? 'good' : 'critical'}>
                  {e.verdict === 'on_brand' ? 'On brand' : 'Off brand'}
                </Badge>
                <p className="mt-2">“{e.text}”</p>
                {e.note && <p className="mt-1 text-xs text-muted-foreground">{e.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </ReadSection>
      {v.locales.length > 0 && (
        <ReadSection title="Locales">
          <Chips items={v.locales} />
        </ReadSection>
      )}
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

/** The parts of the document each brand system section reads; used to say what a draft changes. */
const SECTION_PARTS: Array<{ key: string; label: string; parts: (d: Doc) => unknown }> = [
  { key: 'logo', label: 'Logo', parts: (d) => d.logoRules },
  { key: 'colour', label: 'Colour', parts: (d) => [d.tokens.colours, d.tokens.contrastTarget] },
  {
    key: 'typography',
    label: 'Typography & layout',
    parts: (d) => [d.tokens.typeRoles, d.tokens.spacingScale, d.tokens.radii],
  },
  { key: 'voice', label: 'Voice & writing', parts: (d) => d.voice },
  {
    key: 'imagery',
    label: 'Imagery',
    parts: (d) => d.patterns.find((p) => p.key === REFERENCE_PATTERN) ?? null,
  },
  {
    key: 'patterns',
    label: 'Patterns & templates',
    parts: (d) => d.patterns.filter((p) => p.key !== REFERENCE_PATTERN),
  },
  { key: 'channels', label: 'Channel guidance', parts: (d) => d.channelGuidance },
  { key: 'guidelines', label: 'Guidelines', parts: (d) => d.guidelines ?? null },
];

/** The sections whose content differs between a version and the one it would replace (none when both are equal). */
export function changedSections(next: Doc, base: Doc): Array<{ key: string; label: string }> {
  return SECTION_PARTS.filter((s) => JSON.stringify(s.parts(next)) !== JSON.stringify(s.parts(base))).map(
    ({ key, label }) => ({ key, label }),
  );
}

const LOGO_LABEL: Record<Doc['logoRules'][number]['variant'], string> = {
  primary: 'Primary',
  reversed: 'Reversed',
  mono: 'Mono',
  mark_only: 'Mark only',
};

export function LogoView({ doc }: { doc: Doc }) {
  if (doc.logoRules.length === 0) return nothing('logo rules');
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {doc.logoRules.map((r) => (
        <li
          key={`${r.variant}-${r.assetId}`}
          className="flex gap-3 rounded-md border border-border p-3 text-sm"
        >
          <AssetById assetId={r.assetId} className="h-16 w-24 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">{LOGO_LABEL[r.variant]}</p>
            <p className="text-muted-foreground">
              Clear space {r.clearSpaceRatio}× · min {r.minWidthPx} px
            </p>
            {r.allowedBackgroundColourKeys.length > 0 && (
              <p className="text-xs text-muted-foreground">On {r.allowedBackgroundColourKeys.join(', ')}</p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

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

export function TypographyView({ doc }: { doc: Doc }) {
  const t = doc.tokens;
  return (
    <div className="flex flex-col gap-8">
      <ReadSection title="Type roles">
        {t.typeRoles.length === 0 ? (
          nothing('type roles')
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {t.typeRoles.map((r) => (
              <li key={r.role} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium capitalize">{r.role}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  weight {r.weight} · min {r.minSizePx} px
                  {r.tracking !== undefined ? ` · tracking ${r.tracking}` : ''} · {r.fontAssetId}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ReadSection>
      <ReadSection title="Spacing and radii">
        <p className="font-mono text-xs">
          spacing {t.spacingScale.join(' · ') || '—'} · radii {t.radii.join(' · ') || '—'}
        </p>
      </ReadSection>
    </div>
  );
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

export function ChannelsView({ doc }: { doc: Doc }) {
  if (doc.channelGuidance.length === 0) return nothing('channel guidance');
  return (
    <ul className="flex flex-col divide-y divide-border text-sm">
      {doc.channelGuidance.map((c) => (
        <li key={c.providerKey} className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr]">
          <span className="font-medium">{c.providerKey}</span>
          <div className="flex flex-col gap-1">
            <p>{c.captionStyle}</p>
            {c.preferredFormats.length > 0 && <Chips items={c.preferredFormats} />}
            {c.ctaConventions && <p className="text-muted-foreground">Calls to action: {c.ctaConventions}</p>}
          </div>
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
      'Voice & writing',
      `${doc.voice.tone.length} tone words · ${doc.voice.preferredTerms.length} preferred terms · ${doc.voice.prohibitedPhrases.length} prohibited`,
    ],
    [
      'imagery',
      'Imagery',
      `${doc.patterns.find((p) => p.key === REFERENCE_PATTERN)?.exampleAssetIds.length ?? 0} reference images`,
    ],
    ['patterns', 'Patterns', `${doc.patterns.filter((p) => p.key !== REFERENCE_PATTERN).length} patterns`],
    ['channels', 'Channels', doc.channelGuidance.map((c) => c.providerKey).join(', ') || 'No guidance'],
    ['facts', 'Facts', factCount === undefined ? '…' : `${factCount} approved`],
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
          Every document revision records the brand version it was designed against. Agents read an immutable
          snapshot of the published version, the approved facts and the active objective; imported guideline
          text is evidence, never permission. These tokens style creative documents only, never this
          application.
        </p>
      </ReadSection>
    </div>
  );
}
