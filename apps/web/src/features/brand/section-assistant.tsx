import { useMemo, useState } from 'react';
import type { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import {
  ASSIST_SECTION_LABEL,
  AssistSection,
  type BrandAssistRequest,
} from '@oremedia/contracts/brand-assist';
import { Button, Field, StatusBanner, Textarea } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { toUiError } from '../../lib/errors';
import { useBrandContext } from './brand-context';
import { EstimateLine, useStartAssist } from './assist-setup';
import { useBrandSources } from './use-assist';

/**
 * BSC-5 assistants: "Ask AI" on a Brand System section (the section assistant) or for several sections at once (the
 * overall assistant). A request in the person's words, with ready-made ones to start from, the statements to keep as
 * they are, the sources to read and the cost; the job's suggestions then show beside the section as changes to it.
 */

export const PROMPTS = [
  'Infer our writing style from these approved examples',
  'Adapt our voice for LinkedIn',
  'Find inconsistencies between these documents',
  'Suggest a clearer messaging framework',
  'Extract product facts and show their sources',
  'Create reusable templates using our approved voice',
  'Update this section while preserving these statements',
] as const;

type Doc = BrandSystemDocumentV1;
interface Keepable {
  path: string;
  label: string;
}
const cut = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const keyed = (
  collection: string,
  items: ReadonlyArray<unknown> | undefined,
  key: string,
  show: (i: Record<string, unknown>) => string,
) =>
  (items ?? []).map((raw) => {
    const i = raw as Record<string, unknown>;
    return { path: `${collection}#${String(i[key])}`, label: cut(show(i)) };
  });

/**
 * The items of a section a person may choose to keep, named as the server names them (collection#key, or the field).
 * The same names as packages/domain/src/brand-suggestions.ts; the server refuses any other.
 */
export function keepableItems(doc: Doc, section: AssistSection): Keepable[] {
  const v = doc.voice;
  switch (section) {
    case 'voice':
      return [
        ...(v.summary ? [{ path: 'voice.summary', label: `Summary: ${cut(v.summary)}` }] : []),
        ...(v.tone.length ? [{ path: 'voice.tone', label: `Tone: ${v.tone.join(', ')}` }] : []),
        ...keyed('voice.personality', v.personality, 'trait', (i) => `Trait: ${String(i['trait'])}`),
        ...keyed(
          'voice.principles',
          v.principles,
          'statement',
          (i) => `Principle: ${String(i['statement'])}`,
        ),
        ...keyed('voice.styleRules', v.styleRules, 'rule', (i) => `Style rule: ${String(i['rule'])}`),
        ...keyed('voice.claimRules', v.claimRules, 'rule', (i) => `Claim rule: ${String(i['rule'])}`),
      ];
    case 'messaging':
      return [
        ...(doc.messaging?.positioning
          ? [{ path: 'messaging.positioning', label: `Positioning: ${cut(doc.messaging.positioning)}` }]
          : []),
        ...(doc.messaging?.valueProposition
          ? [
              {
                path: 'messaging.valueProposition',
                label: `Value proposition: ${cut(doc.messaging.valueProposition)}`,
              },
            ]
          : []),
        ...keyed('messaging.pillars', doc.messaging?.pillars, 'key', (i) => `Pillar: ${String(i['title'])}`),
        ...keyed(
          'messaging.keyMessages',
          doc.messaging?.keyMessages,
          'text',
          (i) => `Key message: ${String(i['text'])}`,
        ),
        ...keyed('voice.audiences', v.audiences, 'key', (i) => `Audience: ${String(i['key'])}`),
      ];
    case 'vocabulary':
      return keyed('vocabulary', doc.vocabulary, 'term', (i) => `Term: ${String(i['term'])}`);
    case 'writing':
      return Object.entries(doc.writingPatterns ?? {}).flatMap(([part, p]) =>
        p
          ? [{ path: `writingPatterns.${part}`, label: `${part.replace('_', ' ')}: ${cut(p.guidance)}` }]
          : [],
      );
    case 'examples':
      return keyed('voice.examples', v.examples, 'text', (i) => `Example: ${String(i['text'])}`);
    case 'templates':
      return keyed('copyTemplates', doc.copyTemplates, 'key', (i) => `Template: ${String(i['name'])}`);
    case 'channels':
      return keyed(
        'channelGuidance',
        doc.channelGuidance,
        'providerKey',
        (i) => `Channel: ${String(i['providerKey'])}`,
      );
    case 'facts':
      return [];
  }
}

export function AssistantDialog({
  scope,
  doc,
  onClose,
  onStarted,
}: {
  /** One section (the section assistant) or every section (the overall assistant). */
  scope: AssistSection | 'all';
  doc: Doc;
  onClose: () => void;
  onStarted: (jobId: string, sections: AssistSection[]) => void;
}) {
  const { brandId } = useBrandContext();
  const sources = useBrandSources(brandId);
  const readable = (sources.data?.items ?? []).filter(
    (s) => s.status === 'captured' && !s.duplicateOfSourceId,
  );
  const [instruction, setInstruction] = useState('');
  const [sections, setSections] = useState<Set<AssistSection>>(
    new Set(scope === 'all' ? (['voice', 'messaging'] as AssistSection[]) : [scope]),
  );
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const keepable = useMemo(() => (scope === 'all' ? [] : keepableItems(doc, scope)), [doc, scope]);
  const chosen = AssistSection.options.filter((s) => sections.has(s));
  const sourceIds = readable.map((s) => s.id).filter((id) => !skip.has(id));
  const request: BrandAssistRequest | null =
    chosen.length && instruction.trim()
      ? {
          brandId,
          kind: 'section',
          sections: chosen,
          instruction: instruction.trim(),
          sourceIds,
          ...(keep.size ? { preserve: [...keep] } : {}),
        }
      : null;
  const start = useStartAssist((jobId) => onStarted(jobId, chosen));
  const toggle = <T,>(set: (f: (s: Set<T>) => Set<T>) => void, v: T) =>
    set((cur) => {
      const next = new Set(cur);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  const title = scope === 'all' ? 'Ask AI about the brand system' : `Ask AI: ${ASSIST_SECTION_LABEL[scope]}`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={title}
        description="Suggestions appear beside the section for you to accept, edit or reject. Nothing changes until you do."
        className="max-w-2xl"
      >
        <form
          className="flex flex-col gap-3"
          data-testid="assistant-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (request) start.mutate(request);
          }}
        >
          <Field label="What should it do?" htmlFor="assist-instruction">
            <Textarea
              id="assist-instruction"
              rows={3}
              maxLength={2000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2" aria-label="Suggested requests" role="group">
            {PROMPTS.map((p) => (
              <Button key={p} type="button" size="sm" variant="ghost" onClick={() => setInstruction(p)}>
                {p}
              </Button>
            ))}
          </div>
          {scope === 'all' && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">Sections</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {AssistSection.options.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sections.has(s)}
                      onChange={() => toggle(setSections, s)}
                    />
                    {ASSIST_SECTION_LABEL[s]}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {keepable.length > 0 && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">Keep these exactly as they are</legend>
              <ul className="flex max-h-40 flex-col gap-1 overflow-auto">
                {keepable.map((k) => (
                  <li key={k.path}>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={keep.has(k.path)}
                        onChange={() => toggle(setKeep, k.path)}
                      />
                      {k.label}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          {readable.length > 0 && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">Sources to read</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {readable.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={!skip.has(s.id)} onChange={() => toggle(setSkip, s.id)} />
                    {s.title}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {readable.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No sources have been read yet: it works from the brand system as it is. Add sources with “Import
              sources”.
            </p>
          )}
          <EstimateLine request={request} />
          {start.error && (
            <StatusBanner tone="critical" title="Not started" description={toUiError(start.error).message} />
          )}
          <DialogActions>
            <DialogClose asChild>
              <Button size="sm" variant="ghost" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button size="sm" variant="primary" type="submit" disabled={!request || start.isPending}>
              {start.isPending ? 'Starting…' : 'Suggest'}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
