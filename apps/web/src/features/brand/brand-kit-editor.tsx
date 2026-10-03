import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AssetKind } from '@oremedia/contracts/assets';
import type { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { useToast } from '../../components/toast';
import { AssetThumb } from '../assets/asset-thumb';
import { useBrandAssetsOfKind, useBrandFonts, type BrandFontFaceDto } from '../assets/use-assets';
import { useFontFaces } from '../assets/use-font-faces';
import { useAssetUpload } from '../assets/use-upload';
import { UploadStatus } from '../assets/upload-status';
import { useBrandContext } from './brand-context';
import { useBrandVersionImpact } from './use-brand';
import { PublishImpact } from './publish-impact';
import { LogosSection } from './logo-rules';
import { RELEASE_1_PROVIDERS } from '../publishing/channel-connect';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { useTRPC } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError, type UiError } from '../../lib/errors';

type Doc = BrandSystemDocumentV1;
type Colour = Doc['tokens']['colours'][number];
type TypeRole = Doc['tokens']['typeRoles'][number];
type TypeRoleKey = TypeRole['role'];

const COLOUR_ROLES: Colour['role'][] = [
  'primary',
  'secondary',
  'accent',
  'neutral',
  'background',
  'text',
  'semantic',
];
const TYPE_ROLES: Array<{ role: TypeRoleKey; label: string; minSizePx: number; sample: string }> = [
  { role: 'display', label: 'Display', minSizePx: 40, sample: 'Built to last' },
  { role: 'heading', label: 'Heading', minSizePx: 28, sample: 'The quick brown fox' },
  { role: 'body', label: 'Body', minSizePx: 16, sample: 'The quick brown fox jumps over the lazy dog.' },
  { role: 'label', label: 'Label', minSizePx: 14, sample: 'Shop the range' },
  { role: 'caption', label: 'Caption', minSizePx: 12, sample: 'Photographed on site, 2026' },
];
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const FONT_ACCEPT = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf';
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

/** The kit's editable sections; the brand system edits one at a time, a proposed update is reviewed with all of them. */
export type KitSection =
  'guidelines' | 'palette' | 'typography' | 'voice' | 'logos' | 'imagery' | 'patterns' | 'channels';

/**
 * Spec 8.1 brand kit, D-22: one brand system, edited in place. The document (the applied brand system, or a proposed
 * update under review) is edited locally and saved through brand.system.save, which applies it at once. Before the
 * save, what applying reaches is read (UX-20): approvals, open review requests or scheduled posts it would reach are
 * confirmed first. The server checks every reference (hex colours, unique keys, logos and images of this brand) and
 * reports all problems at once; a save over a brand system someone else saved since is a conflict.
 */
export function BrandKitEditor({
  document,
  basedOnVersionId,
  proposal,
  only,
  onClose,
  onReload,
}: {
  document: Doc;
  /** The applied version the edit starts from (null before the first save); a newer one makes the save a conflict. */
  basedOnVersionId: string | null;
  /** The proposed update this save applies and closes. */
  proposal?: { versionId: string; expectedVersion: number };
  only?: KitSection;
  onClose: () => void;
  /** After a conflict: drop the local edits and reopen on the brand system as it is now. */
  onReload: () => void;
}) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [doc, setDoc] = useState<Doc>(document);
  const [error, setError] = useState<UiError | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const impact = useBrandVersionImpact(brandId, confirming);
  const impactKnown = impact.data?.available === true;
  const show = (section: KitSection) => only === undefined || only === section;
  const invalid =
    (show('patterns') && patternIssues(doc).length > 0) ||
    (show('channels') && channelIssues(doc).length > 0);
  const intent = useIntentKey();
  const save = useMutation(
    trpc.brand.system.save.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setConfirming(false);
        setError(null);
        void queryClient.invalidateQueries(trpc.brand.pathFilter());
        toast(
          res.changed
            ? { tone: 'good', title: 'Brand system saved' }
            : { tone: 'info', title: 'No changes to save' },
        );
        onClose();
      },
      onError: (err) => {
        setConfirming(false);
        setError(toUiError(err));
      },
    }),
  );
  const commit = () =>
    save.mutate({ brandId, basedOnVersionId, document: doc, ...(proposal ? { proposal } : {}) });
  // UX-20: what applying reaches is read fresh; anything reached (or a reach that cannot be computed) is confirmed.
  const requestSave = async () => {
    setError(null);
    setChecking(true);
    try {
      const reach = await queryClient.fetchQuery({
        ...trpc.brand.versions.impact.queryOptions({ brandId }),
        staleTime: 0,
      });
      if (
        !reach.available ||
        reach.requests.length > 0 ||
        reach.approvals > 0 ||
        reach.publications.length > 0
      )
        setConfirming(true);
      else commit();
    } catch (err) {
      setError(toUiError(err));
    } finally {
      setChecking(false);
    }
  };
  const busy = checking || save.isPending;

  return (
    <div
      className="flex flex-col gap-4 rounded-md border border-border p-3"
      aria-live="polite"
      data-testid="brand-kit-editor"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {proposal
            ? 'Saving applies the proposed update, with any edits you make here, to the brand system.'
            : 'Saving applies your changes to the brand system at once.'}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || invalid}
            disabledReason={invalid ? 'Fix the highlighted rows first' : undefined}
            onClick={() => void requestSave()}
          >
            {save.isPending ? 'Saving…' : checking ? 'Checking…' : 'Save'}
          </Button>
        </div>
      </div>
      {error && error.code === 'CONFLICT' && (
        <StatusBanner
          tone="warning"
          title="Someone saved the brand system since you opened it"
          description="Reload to start again from the brand system as it is now. Your edits here are discarded."
          actions={
            <Button size="sm" onClick={onReload}>
              Reload
            </Button>
          }
          data-testid="brand-system-conflict"
        />
      )}
      {error && error.code !== 'CONFLICT' && (
        <StatusBanner
          tone="critical"
          title="Not saved"
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
      {show('guidelines') && <GuidelinesSection doc={doc} onChange={setDoc} />}
      {show('palette') && <PaletteSection doc={doc} onChange={setDoc} />}
      {show('typography') && <TypographySection doc={doc} onChange={setDoc} />}
      {show('voice') && <VoiceSection doc={doc} onChange={setDoc} />}
      {show('logos') && <LogosSection doc={doc} onChange={setDoc} />}
      {show('imagery') && <ReferenceImagerySection doc={doc} onChange={setDoc} />}
      {show('patterns') && <PatternsSection doc={doc} onChange={setDoc} />}
      {show('channels') && <ChannelsSection doc={doc} onChange={setDoc} />}
      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        {confirming && (
          <DialogContent
            role="alertdialog"
            title="Save and apply the brand system?"
            description="What saving reaches, before it happens."
          >
            <PublishImpact brandId={brandId} />
            <DialogActions>
              <DialogClose asChild>
                <Button size="sm" variant="ghost">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                size="sm"
                variant="primary"
                onClick={commit}
                disabled={save.isPending || !impactKnown}
                disabledReason={impactKnown ? undefined : 'Wait for what the save reaches to load'}
              >
                {save.isPending ? 'Saving…' : 'Save and apply'}
              </Button>
            </DialogActions>
          </DialogContent>
        )}
      </Dialog>
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

function GuidelinesSection({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const g = doc.guidelines;
  const { guidelines: _removed, ...withoutGuidelines } = doc;
  return (
    <Section
      title="Brand guidelines"
      hint="Imported from a brand skill. Agents receive this text with the brand constraints once the brand system is saved."
    >
      {!g && (
        <p className="text-sm text-muted-foreground">
          No imported guidelines. Saving applies the brand system without them.
        </p>
      )}
      {g && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
            <div className="min-w-0">
              <p className="font-medium">{g.source.name}</p>
              {g.source.description && (
                <p className="text-xs text-muted-foreground">{g.source.description}</p>
              )}
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
        </>
      )}
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

/** A face's weight as people read it: one weight, or the range a variable face covers (400–700). */
const faceWeight = (f: BrandFontFaceDto) =>
  f.weightRange ? `${f.weightRange.min}–${f.weightRange.max}` : (f.weight ?? '');

/** How a face is named in lists and pickers: family, weight, style and format. */
const faceLabel = (f: BrandFontFaceDto) =>
  `${f.family ?? f.name} ${faceWeight(f)}${f.style === 'italic' ? ' italic' : ''} (${f.format}${f.weightRange ? ', variable' : ''})`.replace(
    /\s+/g,
    ' ',
  );

/** The weights a role may take with a face: any for a static face (synthesised), the axis range for a variable one. */
const weightsFor = (f: BrandFontFaceDto | undefined) => {
  const range = f?.weightRange;
  return range ? WEIGHTS.filter((w) => w >= range.min && w <= range.max) : WEIGHTS;
};

/**
 * Typography (spec 8.1 type roles): the brand's fonts (uploaded files, or a family imported from Google Fonts,
 * each file an asset with its provenance and licence) and, per type role, the face, weight and minimum size, with a
 * preview line drawn in the chosen font loaded from its pinned files. Saved with the rest of the brand system.
 */
function TypographySection({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const { brandId } = useBrandContext();
  const fonts = useBrandFonts(brandId);
  const faces = fonts.data?.items ?? [];
  const roles = doc.tokens.typeRoles;
  const setRole = (role: TypeRoleKey, next: TypeRole | null) =>
    onChange({
      ...doc,
      tokens: {
        ...doc.tokens,
        typeRoles: TYPE_ROLES.flatMap(({ role: r }) => {
          if (r === role) return next ? [next] : [];
          const current = roles.find((x) => x.role === r);
          return current ? [current] : [];
        }),
      },
    });
  // Every face a role uses is loaded once, under its representative file's version id.
  const used = useMemo(
    () =>
      faces
        .filter((f) => roles.some((r) => r.fontAssetId === f.assetId))
        .flatMap((f) =>
          f.files.map((x) => ({
            family: f.assetVersionId,
            assetVersionId: x.assetVersionId,
            unicodeRange: f.files.length > 1 ? x.unicodeRange : null,
          })),
        ),
    [faces, roles],
  );
  const loaded = useFontFaces(used);
  return (
    <Section
      title="Typography"
      hint="Upload font files (WOFF2, WOFF, TTF or OTF) or import a family from Google Fonts, then give each type role a font, weight and minimum size. Creative work and exports use these files, never system fonts."
    >
      <div className="flex flex-wrap items-start gap-3">
        <UploadButton label="Upload font" kind="font" accept={FONT_ACCEPT} />
        <Button size="sm" variant="ghost" onClick={() => void fonts.refetch()}>
          Refresh
        </Button>
      </div>
      <GoogleFontImportForm onImported={() => void fonts.refetch()} />
      {fonts.isPending && <Skeleton label="Loading fonts" lines={2} />}
      {fonts.isError && <RequestError error={fonts.error} onRetry={() => void fonts.refetch()} />}
      {fonts.isSuccess && faces.length === 0 && (
        <EmptyState
          title="No fonts yet"
          description="Upload the brand's font files or import a family from Google Fonts."
        />
      )}
      {faces.length > 0 && (
        <ul
          className="flex flex-col divide-y divide-border rounded-md border border-border text-sm"
          aria-label="Brand fonts"
        >
          {faces.map((f) => (
            <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="font-medium">{f.family ?? f.name}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  {f.weightRange ? `weights ${faceWeight(f)} (variable)` : (f.weight ?? 'weight unknown')} ·{' '}
                  {f.style} · {f.format}
                  {f.files.length > 1 ? ` · ${f.files.map((x) => x.subset ?? 'all').join(', ')}` : ''}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1">
                <Badge tone="neutral" glyph={false}>
                  {f.source === 'google_fonts'
                    ? 'Google Fonts'
                    : f.source === 'upload'
                      ? 'Uploaded'
                      : 'Imported'}
                </Badge>
                {f.state !== 'approved' && <Badge tone="warning">Awaiting approval</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ul className="grid gap-3 md:grid-cols-2" aria-label="Type roles">
        {TYPE_ROLES.map((r) => (
          <TypeRoleSlot
            key={r.role}
            spec={r}
            value={roles.find((x) => x.role === r.role)}
            faces={faces}
            loadedFamily={(assetId) => {
              const face = faces.find((f) => f.assetId === assetId);
              return face && loaded.has(face.assetVersionId) ? face.assetVersionId : null;
            }}
            onChange={(next) => setRole(r.role, next)}
          />
        ))}
      </ul>
    </Section>
  );
}

function TypeRoleSlot({
  spec,
  value,
  faces,
  loadedFamily,
  onChange,
}: {
  spec: (typeof TYPE_ROLES)[number];
  value: TypeRole | undefined;
  faces: BrandFontFaceDto[];
  loadedFamily: (assetId: string) => string | null;
  onChange: (next: TypeRole | null) => void;
}) {
  const known = value ? faces.some((f) => f.assetId === value.fontAssetId) : true;
  const options = [
    ...faces.map((f) => ({ value: f.assetId, label: faceLabel(f) })),
    ...(value && !known
      ? [{ value: value.fontAssetId, label: 'A font not in this brand', disabled: true }]
      : []),
  ];
  const family = value ? loadedFamily(value.fontAssetId) : null;
  const id = `kit-type-${spec.role}`;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{spec.label}</h4>
        {value && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Clear
          </Button>
        )}
      </div>
      {faces.length === 0 ? (
        <p className="text-xs text-muted-foreground">Add a font above to assign it here.</p>
      ) : (
        <Select
          aria-label={`${spec.label} font`}
          placeholder="Choose a font"
          value={value?.fontAssetId ?? ''}
          onValueChange={(assetId) => {
            const face = faces.find((f) => f.assetId === assetId);
            const allowed = weightsFor(face);
            const wanted = value?.weight ?? face?.weight ?? 400;
            onChange({
              role: spec.role,
              fontAssetId: assetId,
              weight: allowed.includes(wanted) ? wanted : (face?.weight ?? allowed[0] ?? 400),
              minSizePx: value?.minSizePx ?? spec.minSizePx,
              ...(value?.tracking !== undefined ? { tracking: value.tracking } : {}),
            });
          }}
          options={options}
        />
      )}
      {value && (
        <>
          {!known && (
            <p className="text-xs text-status-critical">
              <span aria-hidden="true">! </span>This role names a font that is not one of the brand&apos;s
              fonts.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Weight" htmlFor={`${id}-weight`}>
              <Select
                id={`${id}-weight`}
                aria-label={`${spec.label} weight`}
                value={String(value.weight)}
                onValueChange={(w) => onChange({ ...value, weight: Number(w) })}
                options={[
                  ...new Set([
                    ...weightsFor(faces.find((f) => f.assetId === value.fontAssetId)),
                    value.weight,
                  ]),
                ]
                  .sort((a, b) => a - b)
                  .map((w) => ({ value: String(w), label: String(w) }))}
              />
            </Field>
            <Field label="Minimum size (px)" htmlFor={`${id}-min`}>
              <Input
                id={`${id}-min`}
                type="number"
                min={1}
                value={value.minSizePx}
                onChange={(e) => onChange({ ...value, minSizePx: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
          <p
            data-testid={`type-preview-${spec.role}`}
            className="truncate rounded-sm bg-muted px-2 py-1"
            style={{
              fontFamily: family ? `"${family}", sans-serif` : 'sans-serif',
              fontWeight: value.weight,
              fontSize: Math.min(Math.max(value.minSizePx, 12), 40),
            }}
          >
            {spec.sample}
          </p>
          {!family && known && (
            <p className="text-xs text-muted-foreground">Loading the font for the preview…</p>
          )}
        </>
      )}
    </li>
  );
}

/**
 * Google Fonts import: the server fetches the family's WOFF2 files (latin and latin-ext) from Google and ingests
 * each as a font asset recording the source and licence. Files the brand already holds are reused, not duplicated.
 */
function GoogleFontImportForm({ onImported }: { onImported: () => void }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [family, setFamily] = useState('');
  const [weights, setWeights] = useState<number[]>([400, 700]);
  const [italic, setItalic] = useState(false);
  const run = useMutation(
    trpc.assets.fonts.importGoogle.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.assets.pathFilter());
        onImported();
      },
      onError: () => intent.renew(),
    }),
  );
  const error = run.error ? toUiError(run.error) : null;
  const queued = run.data?.files.filter((f) => f.outcome === 'queued').length ?? 0;
  const existing = run.data?.files.filter((f) => f.outcome === 'existing').length ?? 0;
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      aria-labelledby="kit-google-fonts"
      onSubmit={(e) => {
        e.preventDefault();
        run.mutate({
          brandId,
          family: family.trim(),
          weights,
          styles: italic ? ['normal', 'italic'] : ['normal'],
        });
      }}
    >
      <h4 id="kit-google-fonts" className="text-sm font-medium">
        Import from Google Fonts
      </h4>
      <Field
        label="Family"
        htmlFor="kit-google-family"
        hint="As fonts.google.com names it, for example Inter or IBM Plex Sans. Google Fonts families are open source (SIL Open Font License or Apache 2.0)."
      >
        <Input
          id="kit-google-family"
          value={family}
          maxLength={100}
          onChange={(e) => setFamily(e.target.value)}
          placeholder="Inter"
        />
      </Field>
      <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <legend className="mb-1 text-muted-foreground">Weights</legend>
        {WEIGHTS.map((w) => (
          <label key={w} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={weights.includes(w)}
              onChange={(e) =>
                setWeights(
                  e.target.checked ? [...weights, w].sort((a, b) => a - b) : weights.filter((x) => x !== w),
                )
              }
            />
            {w}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={italic} onChange={(e) => setItalic(e.target.checked)} />
        Include italics
      </label>
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={run.isPending || family.trim().length === 0 || weights.length === 0}
        >
          {run.isPending ? 'Importing…' : 'Import family'}
        </Button>
      </div>
      {error && (
        <StatusBanner
          tone="critical"
          title="Not imported"
          description={[error.message, ...error.details.map((d) => d.issue.replaceAll('_', ' '))].join(' · ')}
        />
      )}
      {run.isSuccess && (
        <StatusBanner
          tone="good"
          title={`${run.data.family}: ${queued} file${queued === 1 ? '' : 's'} importing`}
          description={`${existing ? `${existing} already in the brand. ` : ''}New files are scanned and appear in the list within a minute; use Refresh if they have not.`}
        />
      )}
    </form>
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

type Pattern = Doc['patterns'][number];
type ChannelGuidance = Doc['channelGuidance'][number];

/** The pattern the Imagery section edits (the first with the reference key); the Patterns section lists the rest. */
const referenceIndex = (doc: Doc) => doc.patterns.findIndex((p) => p.key === REFERENCE_PATTERN);

/** Per pattern of the document (reference imagery excluded): what is wrong with its key, if anything. */
function patternIssues(doc: Doc): Array<{ index: number; issue: string }> {
  const reference = referenceIndex(doc);
  const seen = new Set<string>();
  return doc.patterns.flatMap((p, index) => {
    if (index === reference) return [];
    const issue = !p.key
      ? 'Give the pattern a key.'
      : p.key === REFERENCE_PATTERN
        ? 'This key is the reference imagery; choose another.'
        : seen.has(p.key)
          ? 'Another pattern has this key.'
          : null;
    seen.add(p.key);
    return issue ? [{ index, issue }] : [];
  });
}

/** Per channel row: what is wrong with its channel, if anything (one row per channel). */
function channelIssues(doc: Doc): Array<{ index: number; issue: string }> {
  const seen = new Set<string>();
  return doc.channelGuidance.flatMap((c, index) => {
    const issue = !c.providerKey
      ? 'Choose the channel.'
      : seen.has(c.providerKey)
        ? 'Another row has this channel.'
        : null;
    seen.add(c.providerKey);
    return issue ? [{ index, issue }] : [];
  });
}

/**
 * Patterns: named layouts a brief or template refers to by key, each with what it is for. Example images and the
 * templates that implement a pattern are attached elsewhere and kept as they are; reference imagery is edited under
 * Imagery and is not listed here.
 */
function PatternsSection({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const issues = patternIssues(doc);
  const update = (i: number, patch: Partial<Pattern>) =>
    onChange({ ...doc, patterns: doc.patterns.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const reference = referenceIndex(doc);
  const rows = doc.patterns.flatMap((p, i) => (i === reference ? [] : [{ p, i }]));
  return (
    <Section
      title="Patterns"
      hint="Named layouts agents and templates refer to by key, each with what it is for. Examples and templates attached to a pattern are kept as they are."
    >
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No patterns yet.</p>}
      <ul className="flex flex-col gap-3" aria-label="Patterns">
        {rows.map(({ p, i }) => {
          const issue = issues.find((x) => x.index === i)?.issue;
          return (
            <li key={i} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Key" htmlFor={`kit-pattern-${i}-key`} error={issue} className="min-w-48 flex-1">
                  <Input
                    id={`kit-pattern-${i}-key`}
                    placeholder="e.g. quote-card"
                    value={p.key}
                    aria-invalid={issue ? true : undefined}
                    className={issue ? 'border-status-critical' : undefined}
                    onChange={(e) => update(i, { key: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
                    maxLength={60}
                  />
                </Field>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onChange({ ...doc, patterns: doc.patterns.filter((_, j) => j !== i) })}
                >
                  Remove<span className="sr-only"> pattern {p.key || i + 1}</span>
                </Button>
              </div>
              <Field label="What it is for" htmlFor={`kit-pattern-${i}-description`}>
                <Textarea
                  id={`kit-pattern-${i}-description`}
                  rows={2}
                  maxLength={1000}
                  value={p.description}
                  onChange={(e) => update(i, { description: e.target.value })}
                />
              </Field>
              {(p.exampleAssetIds.length > 0 || p.templateVersionIds.length > 0) && (
                <p className="font-mono text-xs text-muted-foreground">
                  {p.exampleAssetIds.length} examples · {p.templateVersionIds.length} templates (kept as they
                  are)
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <div>
        <Button
          size="sm"
          onClick={() =>
            onChange({
              ...doc,
              patterns: [
                ...doc.patterns,
                { key: '', description: '', exampleAssetIds: [], templateVersionIds: [] },
              ],
            })
          }
          disabled={doc.patterns.length >= 40}
        >
          Add pattern
        </Button>
      </div>
    </Section>
  );
}

/**
 * Channel guidance: per channel, the caption style, preferred formats and call-to-action conventions agents follow
 * when they write for it. A channel the document names that is not a Release 1 provider is kept and offered as is.
 */
function ChannelsSection({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const rows = doc.channelGuidance;
  const issues = channelIssues(doc);
  // Rows have no id of their own; a local one keeps each row's typed formats with it when another is removed.
  const next = useRef(0);
  const [ids, setIds] = useState(() => rows.map(() => next.current++));
  const update = (i: number, patch: Partial<ChannelGuidance>) =>
    onChange({ ...doc, channelGuidance: rows.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <Section
      title="Channel guidance"
      hint="How the brand writes for each channel: caption style, preferred formats and calls to action."
    >
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No channel guidance yet.</p>}
      <ul className="flex flex-col gap-3" aria-label="Channel guidance">
        {rows.map((c, i) => (
          <ChannelRow
            key={ids[i] ?? `row-${i}`}
            index={i}
            value={c}
            issue={issues.find((x) => x.index === i)?.issue}
            used={rows.filter((_, j) => j !== i).map((x) => x.providerKey)}
            onChange={(patch) => update(i, patch)}
            onRemove={() => {
              setIds(ids.filter((_, j) => j !== i));
              onChange({ ...doc, channelGuidance: rows.filter((_, j) => j !== i) });
            }}
          />
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          onClick={() => {
            setIds([...ids, next.current++]);
            onChange({
              ...doc,
              channelGuidance: [
                ...rows,
                { providerKey: '', captionStyle: '', preferredFormats: [], ctaConventions: '' },
              ],
            });
          }}
          disabled={rows.length >= 20}
        >
          Add channel
        </Button>
      </div>
    </Section>
  );
}

function ChannelRow({
  index,
  value,
  issue,
  used,
  onChange,
  onRemove,
}: {
  index: number;
  value: ChannelGuidance;
  issue: string | undefined;
  used: string[];
  onChange: (patch: Partial<ChannelGuidance>) => void;
  onRemove: () => void;
}) {
  const [formats, setFormats] = useState(value.preferredFormats.join(', '));
  const id = `kit-channel-${index}`;
  const known = RELEASE_1_PROVIDERS.some((p) => p.key === value.providerKey);
  const options = [
    ...RELEASE_1_PROVIDERS.map((p) => ({ value: p.key, label: p.label, disabled: used.includes(p.key) })),
    ...(value.providerKey && !known ? [{ value: value.providerKey, label: value.providerKey }] : []),
  ];
  const label = RELEASE_1_PROVIDERS.find((p) => p.key === value.providerKey)?.label ?? value.providerKey;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Channel" htmlFor={`${id}-provider`} error={issue} className="min-w-48 flex-1">
          <Select
            id={`${id}-provider`}
            placeholder="Choose a channel"
            value={value.providerKey}
            onValueChange={(providerKey) => onChange({ providerKey })}
            options={options}
          />
        </Field>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove<span className="sr-only"> guidance for {label || `row ${index + 1}`}</span>
        </Button>
      </div>
      <Field label="Caption style" htmlFor={`${id}-caption`}>
        <Textarea
          id={`${id}-caption`}
          rows={2}
          maxLength={2000}
          value={value.captionStyle}
          onChange={(e) => onChange({ captionStyle: e.target.value })}
        />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label="Preferred formats"
          htmlFor={`${id}-formats`}
          hint="Separated by commas, for example carousel, short video."
        >
          <Input
            id={`${id}-formats`}
            value={formats}
            onChange={(e) => {
              setFormats(e.target.value);
              onChange({ preferredFormats: commas(e.target.value, 12) });
            }}
          />
        </Field>
        <Field label="Calls to action" htmlFor={`${id}-cta`}>
          <Input
            id={`${id}-cta`}
            value={value.ctaConventions}
            maxLength={1000}
            onChange={(e) => onChange({ ctaConventions: e.target.value })}
          />
        </Field>
      </div>
    </li>
  );
}
