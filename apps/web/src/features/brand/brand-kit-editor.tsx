import { useState, type ChangeEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AssetKind } from '@oremedia/contracts/assets';
import type { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { useToast } from '../../components/toast';
import { AssetThumb } from '../assets/asset-thumb';
import { useAsset, useBrandAssetsOfKind } from '../assets/use-assets';
import { useAssetUpload, type UploadStep } from '../assets/use-upload';
import { useBrandContext } from './brand-context';
import type { BrandVersionDto } from './use-brand';
import { VoiceExtraction } from './voice-extraction';
import { useTRPC } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError, type UiError } from '../../lib/errors';

type Doc = BrandSystemDocumentV1;
type Colour = Doc['tokens']['colours'][number];
type LogoRule = Doc['logoRules'][number];
type LogoVariant = LogoRule['variant'];

const COLOUR_ROLES: Colour['role'][] = [
  'primary',
  'secondary',
  'accent',
  'neutral',
  'background',
  'text',
  'semantic',
];
const LOGO_VARIANTS: Array<{ variant: LogoVariant; label: string; hint: string }> = [
  { variant: 'primary', label: 'Primary', hint: 'The default lock-up on light grounds.' },
  { variant: 'reversed', label: 'Reversed', hint: 'For dark or photographic grounds.' },
  { variant: 'mono', label: 'Mono', hint: 'Single colour, for embossing, stamps and low-ink use.' },
  {
    variant: 'mark_only',
    label: 'Mark only',
    hint: 'The symbol without the wordmark, for avatars and favicons.',
  },
];
/** Reference imagery lives in the document as one pattern with this key; other patterns are kept as they are. */
const REFERENCE_PATTERN = 'reference-imagery';
const REFERENCE_KINDS: AssetKind[] = ['photo', 'illustration'];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** WCAG 2 relative luminance of a hex colour; null when the value is not hex. */
function luminance(hex: string): number | null {
  if (!HEX.test(hex)) return null;
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 2 contrast ratio of two hex colours; null when either is not hex. */
export const contrast = (a: string, b: string): number | null => {
  const [la, lb] = [luminance(a), luminance(b)];
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/**
 * Spec 8.1 brand kit: palette, voice, logo variants and reference imagery of a draft (or in-review) brand version,
 * edited locally and saved as one document through brand.versions.update. The server checks every reference (hex
 * colours, unique keys, logos and images of this brand) and reports all problems at once; publishing stays a
 * separate, reviewed step.
 */
/** The kit's editable sections; the brand system shows one at a time, the versions list shows them all. */
export type KitSection = 'guidelines' | 'palette' | 'voice' | 'logos' | 'imagery';

export function BrandKitEditor({ version, only }: { version: BrandVersionDto; only?: KitSection }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [doc, setDoc] = useState<Doc>(version.document);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const change = (next: Doc) => {
    setDoc(next);
    setDirty(true);
  };
  const show = (section: KitSection) => only === undefined || only === section;
  const intent = useIntentKey();
  const save = useMutation(
    trpc.brand.versions.update.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setDirty(false);
        setError(null);
        void queryClient.invalidateQueries(trpc.brand.pathFilter());
        toast({ tone: 'good', title: 'Brand kit saved' });
      },
      onError: (err) => setError(toUiError(err)),
    }),
  );

  return (
    <div className="mt-3 flex flex-col gap-4 rounded-md border border-border p-3" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          Editing <strong>version {version.number}</strong>. Changes are saved to this draft; publish it when
          it has been reviewed.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDoc(version.document);
              setDirty(false);
              setError(null);
            }}
          >
            Discard changes
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate({ brandId, versionId: version.id, expectedVersion: version.version, document: doc })
            }
          >
            {save.isPending ? 'Saving…' : 'Save brand kit'}
          </Button>
        </div>
      </div>
      {error && (
        <StatusBanner
          tone={error.kind === 'conflict' ? 'warning' : 'critical'}
          title={error.kind === 'conflict' ? 'This version changed since you opened it' : 'Not saved'}
          description={
            <>
              {error.message}
              {error.details.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {error.details.map((d) => (
                    <li key={`${d.path}-${d.issue}`}>
                      <code className="text-xs">{d.path}</code> {d.issue.replaceAll('_', ' ')}
                    </li>
                  ))}
                </ul>
              )}
            </>
          }
        />
      )}
      {show('guidelines') && doc.guidelines && (
        <GuidelinesSection doc={doc} onChange={change}>
          {version.state === 'draft' && version.document.guidelines && (
            <VoiceExtraction versionId={version.id} unsaved={dirty} />
          )}
        </GuidelinesSection>
      )}
      {show('palette') && <PaletteSection doc={doc} onChange={change} />}
      {show('voice') && <VoiceSection doc={doc} onChange={change} />}
      {show('logos') && <LogosSection doc={doc} onChange={change} />}
      {show('imagery') && <ReferenceImagerySection doc={doc} onChange={change} />}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
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

function GuidelinesSection({
  doc,
  onChange,
  children,
}: {
  doc: Doc;
  onChange: (d: Doc) => void;
  children?: ReactNode;
}) {
  const g = doc.guidelines;
  if (!g) return null;
  const { guidelines: _removed, ...withoutGuidelines } = doc;
  return (
    <Section
      title="Brand guidelines"
      hint="Imported from a brand skill. Agents receive this text with the brand constraints once the version is published; publishing new guidelines needs a second person."
    >
      <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
        <div className="min-w-0">
          <p className="font-medium">{g.source.name}</p>
          {g.source.description && <p className="text-xs text-muted-foreground">{g.source.description}</p>}
        </div>
        <Button size="sm" variant="danger" onClick={() => onChange(withoutGuidelines)}>
          Remove guidelines
        </Button>
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
      {children}
    </Section>
  );
}

function PaletteSection({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const colours = doc.tokens.colours;
  // A logo's allowed grounds follow the palette: a removed or renamed key is dropped rather than left dangling.
  const setColours = (next: Colour[]) => {
    const keys = new Set(next.map((c) => c.key));
    onChange({
      ...doc,
      tokens: { ...doc.tokens, colours: next },
      logoRules: doc.logoRules.map((r) => ({
        ...r,
        allowedBackgroundColourKeys: r.allowedBackgroundColourKeys.filter((k) => keys.has(k)),
      })),
    });
  };
  const update = (i: number, patch: Partial<Colour>) =>
    setColours(colours.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const target = doc.tokens.contrastTarget === 'AAA' ? 7 : 4.5;
  const texts = colours.filter((c) => c.role === 'text');
  const grounds = colours.filter((c) => c.role === 'background');
  return (
    <Section
      title="Palette"
      hint="Each colour has a key agents and templates refer to, a hex value and a role. Text on background pairs are checked against the contrast target."
    >
      {colours.length === 0 && <p className="text-sm text-muted-foreground">No colours yet.</p>}
      <ul className="flex flex-col gap-2">
        {colours.map((c, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              aria-label={`Pick colour ${c.key || i + 1}`}
              value={HEX.test(c.value) && c.value.length === 7 ? c.value : '#000000'}
              onChange={(e) => update(i, { value: e.target.value.toUpperCase() })}
              className="h-9 w-9 cursor-pointer rounded-md border border-border bg-background p-0.5"
            />
            <Input
              aria-label="Colour key"
              placeholder="key, e.g. ore-red"
              className="w-40 flex-1 sm:flex-none"
              value={c.key}
              onChange={(e) => update(i, { key: e.target.value.trim().toLowerCase().replace(/\s+/g, '-') })}
              maxLength={40}
            />
            <Input
              aria-label="Hex value"
              value={c.value}
              onChange={(e) => update(i, { value: e.target.value.trim() })}
              aria-invalid={!HEX.test(c.value)}
              className={`w-28 ${HEX.test(c.value) ? '' : 'border-status-critical'}`}
              maxLength={7}
            />
            <Select
              aria-label="Colour role"
              className="w-36"
              value={c.role}
              onValueChange={(v) => update(i, { role: v as Colour['role'] })}
              options={COLOUR_ROLES.map((r) => ({ value: r, label: r }))}
            />
            <Button size="sm" variant="ghost" onClick={() => setColours(colours.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          onClick={() => setColours([...colours, { key: '', value: '#000000', role: 'primary' }])}
          disabled={colours.length >= 40}
        >
          Add colour
        </Button>
        <label className="flex items-center gap-2 text-xs">
          <span>Contrast target</span>
          <Select
            size="sm"
            value={doc.tokens.contrastTarget}
            onValueChange={(v) =>
              onChange({ ...doc, tokens: { ...doc.tokens, contrastTarget: v as 'AA' | 'AAA' } })
            }
            options={[
              { value: 'AA', label: 'AA (4.5:1)' },
              { value: 'AAA', label: 'AAA (7:1)' },
            ]}
          />
        </label>
      </div>
      {texts.length > 0 && grounds.length > 0 && (
        <table className="w-full max-w-xl text-xs">
          <caption className="sr-only">Contrast of text colours on background colours</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 pr-3">
                Text
              </th>
              <th scope="col" className="py-1 pr-3">
                On
              </th>
              <th scope="col" className="py-1">
                Contrast
              </th>
            </tr>
          </thead>
          <tbody>
            {texts.flatMap((t) =>
              grounds.map((g) => {
                const ratio = contrast(t.value, g.value);
                return (
                  <tr key={`${t.key}-${g.key}`} className="border-t border-border">
                    <td className="py-1 pr-3">
                      <code>{t.key}</code>
                    </td>
                    <td className="py-1 pr-3">
                      <code>{g.key}</code>
                    </td>
                    <td className="py-1 tabular-nums">
                      {ratio === null ? (
                        <span className="text-muted-foreground">n/a</span>
                      ) : (
                        <Badge tone={ratio >= target ? 'good' : 'critical'}>
                          {ratio.toFixed(2)}:1 {ratio >= target ? 'passes' : 'fails'}
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      )}
    </Section>
  );
}

type Voice = Doc['voice'];
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const commas = (text: string, max: number) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, max);

/** "key: description" per line. */
const audiencesText = (v: Voice) => v.audiences.map((a) => `${a.key}: ${a.description}`).join('\n');
const parseAudiences = (text: string): Voice['audiences'] =>
  lines(text).map((l) => {
    const at = l.indexOf(':');
    return at === -1
      ? { key: l, description: '' }
      : { key: l.slice(0, at).trim(), description: l.slice(at + 1).trim() };
  });
/** "use instead of avoid, avoid" per line. */
const termsText = (v: Voice) =>
  v.preferredTerms
    .map((t) => (t.avoid.length ? `${t.use} instead of ${t.avoid.join(', ')}` : t.use))
    .join('\n');
const parseTerms = (text: string): Voice['preferredTerms'] =>
  lines(text).map((l) => {
    const [use = '', avoid = ''] = l.split(/\s+instead of\s+/i);
    return { use: use.trim(), avoid: commas(avoid, 10) };
  });
/** Examples of one verdict, one per line; a line that matches an existing example keeps its note. */
const examplesText = (v: Voice, verdict: 'on_brand' | 'off_brand') =>
  v.examples
    .filter((e) => e.verdict === verdict)
    .map((e) => e.text)
    .join('\n');
const parseExamples = (text: string, verdict: 'on_brand' | 'off_brand', current: Voice['examples']) =>
  lines(text).map((t) => ({
    text: t,
    verdict,
    note: current.find((e) => e.verdict === verdict && e.text === t)?.note ?? '',
  }));

function VoiceSection({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const v = doc.voice;
  const [text, setText] = useState({
    tone: v.tone.join(', '),
    audiences: audiencesText(v),
    terms: termsText(v),
    prohibited: v.prohibitedPhrases.join('\n'),
    onBrand: examplesText(v, 'on_brand'),
    offBrand: examplesText(v, 'off_brand'),
    locales: v.locales.join(', '),
  });
  const edit = (key: keyof typeof text, value: string, voice: (next: string) => Partial<Voice>) => {
    setText((t) => ({ ...t, [key]: value }));
    onChange({ ...doc, voice: { ...doc.voice, ...voice(value) } });
  };
  return (
    <Section
      title="Voice"
      hint="How the brand sounds. Agents read this with the approved facts on every run."
    >
      <Field label="Summary" htmlFor="kit-voice-summary">
        <Textarea
          id="kit-voice-summary"
          rows={3}
          maxLength={2000}
          value={v.summary}
          onChange={(e) => onChange({ ...doc, voice: { ...v, summary: e.target.value } })}
        />
      </Field>
      <Field
        label="Tone"
        htmlFor="kit-voice-tone"
        hint="Up to 12 words or short phrases, separated by commas."
      >
        <Input
          id="kit-voice-tone"
          value={text.tone}
          onChange={(e) => edit('tone', e.target.value, (t) => ({ tone: commas(t, 12) }))}
        />
      </Field>
      <Field
        label="Audiences"
        htmlFor="kit-voice-audiences"
        hint="One per line: name, a colon, then who they are."
      >
        <Textarea
          id="kit-voice-audiences"
          rows={3}
          value={text.audiences}
          onChange={(e) => edit('audiences', e.target.value, (t) => ({ audiences: parseAudiences(t) }))}
        />
      </Field>
      <Field
        label="Preferred terms"
        htmlFor="kit-voice-terms"
        hint="One per line, for example: roast instead of blend, mix"
      >
        <Textarea
          id="kit-voice-terms"
          rows={4}
          value={text.terms}
          onChange={(e) => edit('terms', e.target.value, (t) => ({ preferredTerms: parseTerms(t) }))}
        />
      </Field>
      <Field label="Never write" htmlFor="kit-voice-prohibited" hint="One word or phrase per line.">
        <Textarea
          id="kit-voice-prohibited"
          rows={3}
          value={text.prohibited}
          onChange={(e) => edit('prohibited', e.target.value, (t) => ({ prohibitedPhrases: lines(t) }))}
        />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="On-brand examples" htmlFor="kit-voice-on" hint="One per line.">
          <Textarea
            id="kit-voice-on"
            rows={3}
            value={text.onBrand}
            onChange={(e) =>
              edit('onBrand', e.target.value, (t) => ({
                examples: [
                  ...parseExamples(t, 'on_brand', v.examples),
                  ...v.examples.filter((x) => x.verdict === 'off_brand'),
                ],
              }))
            }
          />
        </Field>
        <Field label="Off-brand examples" htmlFor="kit-voice-off" hint="One per line.">
          <Textarea
            id="kit-voice-off"
            rows={3}
            value={text.offBrand}
            onChange={(e) =>
              edit('offBrand', e.target.value, (t) => ({
                examples: [
                  ...v.examples.filter((x) => x.verdict === 'on_brand'),
                  ...parseExamples(t, 'off_brand', v.examples),
                ],
              }))
            }
          />
        </Field>
      </div>
      <Field
        label="Locales"
        htmlFor="kit-voice-locales"
        hint="Language tags separated by commas, for example en-GB, fr-FR."
      >
        <Input
          id="kit-voice-locales"
          value={text.locales}
          onChange={(e) => edit('locales', e.target.value, (t) => ({ locales: commas(t, 12) }))}
        />
      </Field>
    </Section>
  );
}

function UploadButton({ label, kind, accept }: { label: string; kind: AssetKind; accept: string }) {
  const { brandId } = useBrandContext();
  const { step, pending, upload } = useAssetUpload(brandId);
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(file, kind);
    e.target.value = '';
  };
  return (
    <div className="flex flex-col gap-2">
      <label className="inline-flex w-fit cursor-pointer items-center rounded-md border border-border bg-secondary px-2.5 py-1.5 text-sm hover:bg-muted">
        {label}
        <input type="file" accept={accept} onChange={onFile} disabled={pending} className="sr-only" />
      </label>
      <UploadStatus step={step} />
    </div>
  );
}

function UploadStatus({ step }: { step: UploadStep }) {
  if (step.kind === 'uploading') return <StatusBanner tone="info" busy title={`Uploading ${step.name}`} />;
  if (step.kind === 'queued')
    return (
      <StatusBanner
        tone="info"
        title="Processing"
        description="Scanning and preparing the file. It appears below within a minute; use Refresh if it has not."
      />
    );
  if (step.kind === 'failed')
    return (
      <StatusBanner
        tone="critical"
        title="Upload not accepted"
        description={[step.message, ...step.details].join(' · ')}
      />
    );
  return null;
}

function LogosSection({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const { brandId } = useBrandContext();
  const logos = useBrandAssetsOfKind(brandId, ['logo']);
  const ruleFor = (variant: LogoVariant) => doc.logoRules.find((r) => r.variant === variant);
  const setRule = (variant: LogoVariant, rule: LogoRule | null) =>
    onChange({
      ...doc,
      logoRules: [...doc.logoRules.filter((r) => r.variant !== variant), ...(rule ? [rule] : [])],
    });
  const options = (logos.data?.items ?? []).map((l, i) => ({
    value: l.assetId,
    label: l.altText ?? `Logo ${i + 1}${l.width && l.height ? ` (${l.width}×${l.height})` : ''}`,
  }));
  return (
    <Section
      title="Logos"
      hint="Upload each lock-up once, then assign it to a variant with the grounds it may sit on, its clear space (a multiple of the mark height) and its minimum width. Logos are never generated."
    >
      <div className="flex flex-wrap items-start gap-3">
        <UploadButton
          label="Upload logo"
          kind="logo"
          accept="image/svg+xml,image/png,image/webp,application/pdf"
        />
        <Button size="sm" variant="ghost" onClick={() => void logos.refetch()}>
          Refresh
        </Button>
      </div>
      {logos.isPending && <Skeleton label="Loading logos" lines={2} />}
      {logos.isError && <RequestError error={logos.error} onRetry={() => void logos.refetch()} />}
      {logos.isSuccess && options.length === 0 && (
        <EmptyState
          title="No logos uploaded"
          description="Upload SVG where you have it; PNG with transparency otherwise."
        />
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {LOGO_VARIANTS.map(({ variant, label, hint }) => (
          <LogoSlot
            key={variant}
            label={label}
            hint={hint}
            rule={ruleFor(variant)}
            options={options}
            colourKeys={doc.tokens.colours.map((c) => c.key).filter(Boolean)}
            onChange={(rule) => setRule(variant, rule && { ...rule, variant })}
          />
        ))}
      </ul>
    </Section>
  );
}

function LogoSlot({
  label,
  hint,
  rule,
  options,
  colourKeys,
  onChange,
}: {
  label: string;
  hint: string;
  rule: LogoRule | undefined;
  options: Array<{ value: string; label: string }>;
  colourKeys: string[];
  onChange: (rule: LogoRule | null) => void;
}) {
  const base: LogoRule = rule ?? {
    assetId: '',
    variant: 'primary',
    allowedBackgroundColourKeys: [],
    clearSpaceRatio: 0.5,
    minWidthPx: 96,
  };
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{label}</h4>
        {rule && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Clear
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {rule?.assetId && <LogoPreview assetId={rule.assetId} />}
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">Upload a logo above to assign it here.</p>
      ) : (
        <Select
          aria-label={`${label} logo`}
          placeholder="Choose an uploaded logo"
          value={rule?.assetId ?? ''}
          onValueChange={(assetId) => onChange({ ...base, assetId })}
          options={options}
        />
      )}
      {rule && (
        <>
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <legend className="mb-1 text-muted-foreground">Allowed grounds</legend>
            {colourKeys.length === 0 && (
              <span className="text-muted-foreground">Add palette colours first.</span>
            )}
            {colourKeys.map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={rule.allowedBackgroundColourKeys.includes(k)}
                  onChange={(e) =>
                    onChange({
                      ...rule,
                      allowedBackgroundColourKeys: e.target.checked
                        ? [...rule.allowedBackgroundColourKeys, k]
                        : rule.allowedBackgroundColourKeys.filter((x) => x !== k),
                    })
                  }
                />
                <code>{k}</code>
              </label>
            ))}
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Clear space (× mark height)" htmlFor={`${label}-clear`}>
              <Input
                id={`${label}-clear`}
                type="number"
                min={0}
                step={0.05}
                value={rule.clearSpaceRatio}
                onChange={(e) => onChange({ ...rule, clearSpaceRatio: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label="Minimum width (px)" htmlFor={`${label}-min`}>
              <Input
                id={`${label}-min`}
                type="number"
                min={1}
                value={rule.minWidthPx}
                onChange={(e) => onChange({ ...rule, minWidthPx: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
        </>
      )}
    </li>
  );
}

/**
 * The chosen logo's preview, and its rights: a logo is only offered for publishing once usage rights are recorded
 * (spec 9.2), so a logo with none gets a one-click "our own logo" record.
 */
function LogoPreview({ assetId }: { assetId: string }) {
  const { brand } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const asset = useAsset(assetId);
  const intent = useIntentKey();
  const record = useMutation(
    trpc.assets.rights.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.assets.pathFilter());
      },
    }),
  );
  if (asset.isPending) return <Skeleton label="Loading logo" lines={1} />;
  if (asset.isError) return <RequestError error={asset.error} />;
  const a = asset.data;
  return (
    <div className="flex items-center gap-3">
      {a.currentVersion ? (
        <AssetThumb
          assetVersionId={a.currentVersion.id}
          alt={a.name}
          className="h-16 w-24 rounded-sm border border-border bg-muted object-contain"
        />
      ) : (
        <div className="flex h-16 w-24 items-center justify-center rounded-sm border border-border bg-muted text-xs text-muted-foreground">
          Processing
        </div>
      )}
      <div className="flex flex-col gap-1 text-xs">
        <span className="truncate">{a.name}</span>
        {a.state !== 'approved' && <Badge tone="warning">Awaiting approval</Badge>}
        {a.rightsState === 'recorded' ? (
          <Badge tone="good">Rights recorded</Badge>
        ) : (
          <Button
            size="sm"
            onClick={() =>
              record.mutate({
                assetId,
                owner: brand.name,
                permittedChannels: 'all',
                territories: 'all',
                releases: [],
                restrictions: [],
              })
            }
            disabled={record.isPending}
          >
            Record as our own logo
          </Button>
        )}
      </div>
    </div>
  );
}

function ReferenceImagerySection({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const { brandId } = useBrandContext();
  const images = useBrandAssetsOfKind(brandId, REFERENCE_KINDS);
  const pattern = doc.patterns.find((p) => p.key === REFERENCE_PATTERN) ?? {
    key: REFERENCE_PATTERN,
    description: '',
    exampleAssetIds: [],
    templateVersionIds: [],
  };
  const setPattern = (next: typeof pattern) =>
    onChange({ ...doc, patterns: [...doc.patterns.filter((p) => p.key !== REFERENCE_PATTERN), next] });
  const toggle = (assetId: string) =>
    setPattern({
      ...pattern,
      exampleAssetIds: pattern.exampleAssetIds.includes(assetId)
        ? pattern.exampleAssetIds.filter((id) => id !== assetId)
        : [...pattern.exampleAssetIds, assetId].slice(0, 24),
    });
  return (
    <Section
      title="Reference imagery"
      hint="Photographs and illustrations that show what the brand looks like. Selected images guide agents and image generation; they are not published as they are."
    >
      <Field label="What these images show" htmlFor="kit-ref-description">
        <Textarea
          id="kit-ref-description"
          rows={2}
          maxLength={1000}
          value={pattern.description}
          onChange={(e) => setPattern({ ...pattern, description: e.target.value })}
          placeholder="e.g. Natural light on raw materials; people at work, never posed; warm grade, no filters."
        />
      </Field>
      <div className="flex flex-wrap items-start gap-3">
        <UploadButton label="Upload image" kind="photo" accept="image/jpeg,image/png,image/webp" />
        <Button size="sm" variant="ghost" onClick={() => void images.refetch()}>
          Refresh
        </Button>
        <span className="self-center text-xs text-muted-foreground">
          {pattern.exampleAssetIds.length} selected (up to 24)
        </span>
      </div>
      {images.isPending && <Skeleton label="Loading images" lines={2} />}
      {images.isError && <RequestError error={images.error} onRetry={() => void images.refetch()} />}
      {images.isSuccess && images.data.items.length === 0 && (
        <EmptyState
          title="No images yet"
          description="Upload photographs or illustrations that represent the brand."
        />
      )}
      {images.isSuccess && images.data.items.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {images.data.items.map((img) => {
            const selected = pattern.exampleAssetIds.includes(img.assetId);
            return (
              <li key={img.assetId}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggle(img.assetId)}
                  className={`relative block w-full overflow-hidden rounded-md border-2 ${selected ? 'border-primary' : 'border-transparent'}`}
                >
                  <AssetThumb
                    assetVersionId={img.assetVersionId}
                    alt={img.altText ?? 'Brand image'}
                    className="aspect-square w-full"
                  />
                  {selected && (
                    <span className="absolute right-1 top-1 rounded-sm bg-primary px-1 text-xs text-primary-foreground">
                      Selected
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
