import { useRef, useState, type ReactNode } from 'react';
import {
  CHANNEL_GUIDANCE_FIELDS,
  CHANNEL_OVERRIDE_KEY,
  WRITING_PARTS,
  channelOverride,
  type BrandSystemDocumentV1,
  type ChannelGuidanceField,
  type CopyContentType,
  type StyleRuleTopic,
  type VocabularyUsage,
  type WritingPattern,
} from '@oremedia/contracts/brand';
import { Badge, Button, Field, Input, Skeleton, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { RELEASE_1_PROVIDERS } from '../publishing/channel-connect';
import { useChannelLimits } from '../publishing/use-publishing';
import { useBrandContext } from './brand-context';
import { useFacts } from './use-brand';
import {
  CHANNEL_FIELD_LABEL,
  CONTENT_TYPES,
  EditorSection,
  ListEditor,
  NONE,
  PlatformLimits,
  ProvenanceBadge,
  STYLE_TOPICS,
  WRITING_PART_LABEL,
  byPerson,
  channelLabel,
  slug,
} from './guidance-fields';

type Doc = BrandSystemDocumentV1;
type Voice = Doc['voice'];
type Messaging = NonNullable<Doc['messaging']>;
type Pillar = Messaging['pillars'][number];
type Audience = Voice['audiences'][number];
type Example = Voice['examples'][number];
type Term = NonNullable<Doc['vocabulary']>[number];
type Template = NonNullable<Doc['copyTemplates']>[number];
type Channel = Doc['channelGuidance'][number];
type Props = { doc: Doc; onChange: (d: Doc) => void };

/** Replaces row `i` of a list with the patched row, now the person's. */
const patchRow = <T extends object>(rows: readonly T[], i: number, patch: Partial<T>): T[] =>
  rows.map((r, j) => (j === i ? byPerson({ ...r, ...patch }) : r));

/** A bordered card for one row of a repeatable list, with its Remove button and provenance. */
function Row({
  children,
  provenance,
  onRemove,
  removeLabel,
}: {
  children: ReactNode;
  provenance?: Parameters<typeof ProvenanceBadge>[0]['provenance'];
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ProvenanceBadge provenance={provenance} />
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onRemove}>
          Remove<span className="sr-only"> {removeLabel}</span>
        </Button>
      </div>
      {children}
    </li>
  );
}

/** A problem that blocks the save, shown above the rows it names. */
function Issues({ issues }: { issues: string[] }) {
  if (issues.length === 0) return null;
  return (
    <ul role="alert" className="flex list-disc flex-col gap-0.5 pl-5 text-xs text-status-critical">
      {issues.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

const dupes = (keys: string[]): Set<string> => {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const k of keys) (seen.has(k) ? out : seen).add(k);
  return out;
};

/**
 * What blocks saving the guidance sections, by section key. Blank lines in short lists (dos, needs, alternatives)
 * are not problems: they are dropped on save (pruneGuidance).
 */
export function guidanceIssues(doc: Doc): Record<string, string[]> {
  const v = doc.voice;
  const voice = [
    ...((v.personality ?? []).some((p) => !p.trait.trim()) ? ['Every personality trait needs a word.'] : []),
    ...((v.principles ?? []).some((p) => !p.statement.trim()) ? ['Every principle needs a statement.'] : []),
    ...((v.styleRules ?? []).some((r) => !r.rule.trim()) ? ['Every style rule needs its rule.'] : []),
    ...((v.claimRules ?? []).some((r) => !r.rule.trim()) ? ['Every claim rule needs its rule.'] : []),
    ...(v.spelling && v.spelling.locale.trim().length < 2 ? ['Choose the spelling locale, e.g. en-GB.'] : []),
  ];
  const pillars = doc.messaging?.pillars ?? [];
  const messaging = [
    ...(pillars.some((p) => !p.key.trim() || !p.title.trim())
      ? ['Every pillar needs a key and a title.']
      : []),
    ...(dupes(pillars.map((p) => p.key)).size ? ['Two pillars have the same key.'] : []),
    ...((doc.messaging?.keyMessages ?? []).some((m) => !m.text.trim())
      ? ['Every key message needs its text.']
      : []),
  ];
  const terms = doc.vocabulary ?? [];
  const vocabulary = [
    ...(terms.some((t) => !t.term.trim()) ? ['Every row needs its term.'] : []),
    ...(dupes(terms.map((t) => t.term.trim().toLocaleLowerCase())).size ? ['A term is listed twice.'] : []),
  ];
  const examples = v.examples.some((e) => !e.text.trim()) ? ['Every example needs its text.'] : [];
  const templates = doc.copyTemplates ?? [];
  const templateIssues = [
    ...(templates.some((t) => !t.key.trim() || !t.name.trim())
      ? ['Every template needs a name and a key.']
      : []),
    ...(dupes(templates.map((t) => t.key)).size ? ['Two templates have the same key.'] : []),
    ...(templates.some((t) => t.structure.length === 0) ? ['Every template needs at least one part.'] : []),
    ...(templates.some((t) => t.structure.some((s) => !s.slot.trim())) ? ['Every part needs a name.'] : []),
  ];
  return { voice, messaging, vocabulary, examples, templates: templateIssues };
}

const keep = (list: string[]) => list.filter((x) => x.trim());

/** Blank rows of the short-line lists are not saved (the editor adds an empty row to type into). */
export function pruneGuidance(doc: Doc): Doc {
  const writing = doc.writingPatterns;
  return {
    ...doc,
    voice: {
      ...doc.voice,
      audiences: doc.voice.audiences.map((a) => ({
        ...a,
        ...(a.needs ? { needs: keep(a.needs) } : {}),
        ...(a.objections ? { objections: keep(a.objections) } : {}),
      })),
    },
    ...(doc.vocabulary
      ? { vocabulary: doc.vocabulary.map((t) => ({ ...t, alternatives: keep(t.alternatives) })) }
      : {}),
    ...(writing
      ? {
          writingPatterns: Object.fromEntries(
            Object.entries(writing).map(([part, p]) => [
              part,
              p && { ...p, dos: keep(p.dos), donts: keep(p.donts), examples: keep(p.examples) },
            ]),
          ),
        }
      : {}),
    channelGuidance: doc.channelGuidance.map((c) => ({
      ...c,
      preferredFormats: keep(c.preferredFormats),
      ...(c.examples ? { examples: c.examples.filter((e) => e.text.trim()) } : {}),
    })),
  };
}

// ---- Voice & personality ----

/** Personality, principles, spelling, style and claim rules: added to the Voice section of the editor. */
export function VoicePersonalitySection({ doc, onChange }: Props) {
  const v = doc.voice;
  const setVoice = (patch: Partial<Voice>) => onChange({ ...doc, voice: { ...doc.voice, ...patch } });
  const personality = v.personality ?? [];
  const principles = v.principles ?? [];
  const styleRules = v.styleRules ?? [];
  const claimRules = v.claimRules ?? [];
  return (
    <EditorSection
      title="Personality, style and claims"
      hint="Who the brand is when it writes, the principles behind its choices, and the house rules for spelling, style and claims."
    >
      <Issues issues={guidanceIssues(doc).voice ?? []} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Personality</legend>
        <ul className="flex flex-col gap-2" aria-label="Personality traits">
          {personality.map((p, i) => (
            <Row
              key={i}
              provenance={p.provenance}
              removeLabel={`trait ${p.trait || i + 1}`}
              onRemove={() => setVoice({ personality: personality.filter((_, j) => j !== i) })}
            >
              <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
                <Field label="Trait" htmlFor={`kit-trait-${i}`}>
                  <Input
                    id={`kit-trait-${i}`}
                    value={p.trait}
                    maxLength={60}
                    onChange={(e) =>
                      setVoice({ personality: patchRow(personality, i, { trait: e.target.value }) })
                    }
                  />
                </Field>
                <Field label="What it means here" htmlFor={`kit-trait-${i}-note`}>
                  <Input
                    id={`kit-trait-${i}-note`}
                    value={p.note ?? ''}
                    maxLength={300}
                    onChange={(e) =>
                      setVoice({ personality: patchRow(personality, i, { note: e.target.value }) })
                    }
                  />
                </Field>
              </div>
            </Row>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            disabled={personality.length >= 12}
            onClick={() => setVoice({ personality: [...personality, byPerson({ trait: '' })] })}
          >
            Add trait
          </Button>
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Principles</legend>
        <ul className="flex flex-col gap-2" aria-label="Principles">
          {principles.map((p, i) => (
            <Row
              key={i}
              provenance={p.provenance}
              removeLabel={`principle ${i + 1}`}
              onRemove={() => setVoice({ principles: principles.filter((_, j) => j !== i) })}
            >
              <Field label="Principle" htmlFor={`kit-principle-${i}`}>
                <Input
                  id={`kit-principle-${i}`}
                  value={p.statement}
                  maxLength={300}
                  onChange={(e) =>
                    setVoice({ principles: patchRow(principles, i, { statement: e.target.value }) })
                  }
                />
              </Field>
              <Field label="Why" htmlFor={`kit-principle-${i}-why`}>
                <Textarea
                  id={`kit-principle-${i}-why`}
                  rows={2}
                  value={p.rationale}
                  maxLength={1000}
                  onChange={(e) =>
                    setVoice({ principles: patchRow(principles, i, { rationale: e.target.value }) })
                  }
                />
              </Field>
            </Row>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            disabled={principles.length >= 12}
            onClick={() =>
              setVoice({ principles: [...principles, byPerson({ statement: '', rationale: '' })] })
            }
          >
            Add principle
          </Button>
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Spelling" htmlFor="kit-spelling-locale" hint="A language tag, e.g. en-GB.">
          <Input
            id="kit-spelling-locale"
            value={v.spelling?.locale ?? ''}
            maxLength={20}
            onChange={(e) => {
              const locale = e.target.value.trim();
              const notes = v.spelling?.notes ?? '';
              const { spelling: _drop, ...rest } = v;
              onChange({
                ...doc,
                voice: locale || notes ? { ...v, spelling: { locale, notes } } : rest,
              });
            }}
          />
        </Field>
        <Field label="Spelling notes" htmlFor="kit-spelling-notes">
          <Input
            id="kit-spelling-notes"
            value={v.spelling?.notes ?? ''}
            maxLength={1000}
            onChange={(e) => {
              const locale = v.spelling?.locale ?? '';
              const notes = e.target.value;
              const { spelling: _drop, ...rest } = v;
              onChange({ ...doc, voice: locale || notes ? { ...v, spelling: { locale, notes } } : rest });
            }}
          />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Style rules</legend>
        <ul className="flex flex-col gap-2" aria-label="Style rules">
          {styleRules.map((r, i) => (
            <Row
              key={i}
              provenance={r.provenance}
              removeLabel={`style rule ${i + 1}`}
              onRemove={() => setVoice({ styleRules: styleRules.filter((_, j) => j !== i) })}
            >
              <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
                <Field label="Topic" htmlFor={`kit-style-${i}-topic`}>
                  <Select
                    id={`kit-style-${i}-topic`}
                    value={r.topic}
                    onValueChange={(topic) =>
                      setVoice({ styleRules: patchRow(styleRules, i, { topic: topic as StyleRuleTopic }) })
                    }
                    options={STYLE_TOPICS}
                  />
                </Field>
                <Field label="Rule" htmlFor={`kit-style-${i}-rule`}>
                  <Input
                    id={`kit-style-${i}-rule`}
                    value={r.rule}
                    maxLength={500}
                    onChange={(e) =>
                      setVoice({ styleRules: patchRow(styleRules, i, { rule: e.target.value }) })
                    }
                  />
                </Field>
              </div>
            </Row>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            disabled={styleRules.length >= 40}
            onClick={() =>
              setVoice({ styleRules: [...styleRules, byPerson({ topic: 'numbers' as const, rule: '' })] })
            }
          >
            Add style rule
          </Button>
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Claim rules</legend>
        <ul className="flex flex-col gap-2" aria-label="Claim rules">
          {claimRules.map((r, i) => (
            <Row
              key={i}
              provenance={r.provenance}
              removeLabel={`claim rule ${i + 1}`}
              onRemove={() => setVoice({ claimRules: claimRules.filter((_, j) => j !== i) })}
            >
              <Field label="Claim rule" htmlFor={`kit-claim-${i}`}>
                <Input
                  id={`kit-claim-${i}`}
                  value={r.rule}
                  maxLength={500}
                  onChange={(e) =>
                    setVoice({ claimRules: patchRow(claimRules, i, { rule: e.target.value }) })
                  }
                />
              </Field>
            </Row>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            disabled={claimRules.length >= 20}
            onClick={() => setVoice({ claimRules: [...claimRules, byPerson({ rule: '' })] })}
          >
            Add claim rule
          </Button>
        </div>
      </fieldset>
    </EditorSection>
  );
}

// ---- Messaging ----

const emptyMessaging = (): Messaging => ({
  positioning: '',
  valueProposition: '',
  pillars: [],
  keyMessages: [],
});

export function MessagingSection({ doc, onChange }: Props) {
  const { brandId } = useBrandContext();
  const facts = useFacts(brandId, 'approved');
  const approved = facts.data?.items ?? [];
  const m = doc.messaging ?? emptyMessaging();
  const setM = (patch: Partial<Messaging>) => onChange({ ...doc, messaging: { ...m, ...patch } });
  const audiences = doc.voice.audiences;
  const setAudiences = (next: Audience[]) => onChange({ ...doc, voice: { ...doc.voice, audiences: next } });
  // A renamed pillar keeps its key messages.
  const updatePillar = (i: number, patch: Partial<Pillar>) => {
    const before = m.pillars[i]?.key;
    setM({
      pillars: patchRow(m.pillars, i, patch),
      keyMessages:
        patch.key !== undefined && before !== undefined
          ? m.keyMessages.map((k) => (k.pillarKey === before ? { ...k, pillarKey: patch.key } : k))
          : m.keyMessages,
    });
  };
  const pillarOptions = [
    { value: NONE, label: 'No pillar' },
    ...m.pillars.filter((p) => p.key.trim()).map((p) => ({ value: p.key, label: p.title || p.key })),
  ];
  return (
    <EditorSection
      title="Messaging"
      hint="What the brand stands for and says: positioning, value proposition, pillars proved by approved facts, key messages and the audiences they are for."
    >
      <Issues issues={guidanceIssues(doc).messaging ?? []} />
      <Field label="Positioning" htmlFor="kit-positioning">
        <Textarea
          id="kit-positioning"
          rows={2}
          maxLength={2000}
          value={m.positioning}
          onChange={(e) => setM({ positioning: e.target.value })}
        />
      </Field>
      <Field label="Value proposition" htmlFor="kit-value-proposition">
        <Textarea
          id="kit-value-proposition"
          rows={2}
          maxLength={2000}
          value={m.valueProposition}
          onChange={(e) => setM({ valueProposition: e.target.value })}
        />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Pillars</legend>
        <ul className="flex flex-col gap-2" aria-label="Pillars">
          {m.pillars.map((p, i) => (
            <Row
              key={i}
              provenance={p.provenance}
              removeLabel={`pillar ${p.title || i + 1}`}
              onRemove={() =>
                setM({
                  pillars: m.pillars.filter((_, j) => j !== i),
                  keyMessages: m.keyMessages.map((k) => {
                    if (k.pillarKey !== p.key) return k;
                    const { pillarKey: _gone, ...rest } = k;
                    return rest;
                  }),
                })
              }
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Pillar title" htmlFor={`kit-pillar-${i}-title`}>
                  <Input
                    id={`kit-pillar-${i}-title`}
                    value={p.title}
                    maxLength={120}
                    onChange={(e) => updatePillar(i, { title: e.target.value })}
                  />
                </Field>
                <Field label="Pillar key" htmlFor={`kit-pillar-${i}-key`} hint="Key messages refer to it.">
                  <Input
                    id={`kit-pillar-${i}-key`}
                    value={p.key}
                    maxLength={60}
                    onChange={(e) => updatePillar(i, { key: slug(e.target.value) })}
                  />
                </Field>
              </div>
              <Field label="What the pillar says" htmlFor={`kit-pillar-${i}-statement`}>
                <Textarea
                  id={`kit-pillar-${i}-statement`}
                  rows={2}
                  maxLength={1000}
                  value={p.statement}
                  onChange={(e) => updatePillar(i, { statement: e.target.value })}
                />
              </Field>
              <ProofFacts
                index={i}
                cited={p.proofFactIds}
                approved={approved}
                loading={facts.isPending}
                error={facts.isError ? facts.error : null}
                onRetry={() => void facts.refetch()}
                onChange={(proofFactIds) => updatePillar(i, { proofFactIds })}
              />
            </Row>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            disabled={m.pillars.length >= 8}
            onClick={() =>
              setM({
                pillars: [...m.pillars, byPerson({ key: '', title: '', statement: '', proofFactIds: [] })],
              })
            }
          >
            Add pillar
          </Button>
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Key messages</legend>
        <ul className="flex flex-col gap-2" aria-label="Key messages">
          {m.keyMessages.map((k, i) => (
            <Row
              key={i}
              provenance={k.provenance}
              removeLabel={`key message ${i + 1}`}
              onRemove={() => setM({ keyMessages: m.keyMessages.filter((_, j) => j !== i) })}
            >
              <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
                <Field label="Key message" htmlFor={`kit-message-${i}`}>
                  <Input
                    id={`kit-message-${i}`}
                    value={k.text}
                    maxLength={500}
                    onChange={(e) =>
                      setM({ keyMessages: patchRow(m.keyMessages, i, { text: e.target.value }) })
                    }
                  />
                </Field>
                <Field label="Pillar" htmlFor={`kit-message-${i}-pillar`}>
                  <Select
                    id={`kit-message-${i}-pillar`}
                    value={k.pillarKey ?? NONE}
                    options={pillarOptions}
                    onValueChange={(value) => {
                      const { pillarKey: _old, ...rest } = k;
                      const next = value === NONE ? rest : { ...rest, pillarKey: value };
                      setM({ keyMessages: m.keyMessages.map((x, j) => (j === i ? byPerson(next) : x)) });
                    }}
                  />
                </Field>
              </div>
            </Row>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            disabled={m.keyMessages.length >= 20}
            onClick={() => setM({ keyMessages: [...m.keyMessages, byPerson({ text: '' })] })}
          >
            Add key message
          </Button>
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Audiences</legend>
        <ul className="flex flex-col gap-2" aria-label="Audiences">
          {audiences.map((a, i) => (
            <Row
              key={i}
              provenance={a.provenance}
              removeLabel={`audience ${a.key || i + 1}`}
              onRemove={() => setAudiences(audiences.filter((_, j) => j !== i))}
            >
              <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
                <Field label="Audience" htmlFor={`kit-audience-${i}`}>
                  <Input
                    id={`kit-audience-${i}`}
                    value={a.key}
                    maxLength={60}
                    onChange={(e) => setAudiences(patchRow(audiences, i, { key: e.target.value }))}
                  />
                </Field>
                <Field label="Who they are" htmlFor={`kit-audience-${i}-description`}>
                  <Input
                    id={`kit-audience-${i}-description`}
                    value={a.description}
                    maxLength={500}
                    onChange={(e) => setAudiences(patchRow(audiences, i, { description: e.target.value }))}
                  />
                </Field>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <ListEditor
                  id={`kit-audience-${i}-needs`}
                  label="Needs"
                  item="need"
                  values={a.needs ?? []}
                  max={10}
                  onChange={(needs) => setAudiences(patchRow(audiences, i, { needs }))}
                />
                <ListEditor
                  id={`kit-audience-${i}-objections`}
                  label="Objections"
                  item="objection"
                  values={a.objections ?? []}
                  max={10}
                  onChange={(objections) => setAudiences(patchRow(audiences, i, { objections }))}
                />
              </div>
            </Row>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            disabled={audiences.length >= 12}
            onClick={() => setAudiences([...audiences, byPerson({ key: '', description: '' })])}
          >
            Add audience
          </Button>
        </div>
      </fieldset>
    </EditorSection>
  );
}

/** A pillar's proof: approved facts picked by their statement; a cited fact that is no longer approved is flagged. */
function ProofFacts({
  index,
  cited,
  approved,
  loading,
  error,
  onRetry,
  onChange,
}: {
  index: number;
  cited: string[];
  approved: Array<{ id: string; statement: string }>;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onChange: (ids: string[]) => void;
}) {
  const stale = cited.filter((id) => !approved.some((f) => f.id === id));
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">Proof (approved facts)</legend>
      {loading && <Skeleton label="Loading approved facts" lines={2} />}
      {error !== null && <RequestError error={error} onRetry={onRetry} />}
      {!loading && error === null && approved.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No approved facts yet. Propose and approve facts under Facts to prove a pillar.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {approved.map((f) => (
          <li key={f.id}>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={cited.includes(f.id)}
                disabled={!cited.includes(f.id) && cited.length >= 10}
                onChange={(e) =>
                  onChange(e.target.checked ? [...cited, f.id] : cited.filter((id) => id !== f.id))
                }
              />
              <span>{f.statement}</span>
            </label>
          </li>
        ))}
        {!loading &&
          stale.map((id, j) => (
            <li key={id} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="warning">No longer approved</Badge>
              <span className="text-muted-foreground">A cited fact is no longer approved.</span>
              <Button size="sm" variant="ghost" onClick={() => onChange(cited.filter((x) => x !== id))}>
                Remove<span className="sr-only"> {`stale proof ${j + 1} of pillar ${index + 1}`}</span>
              </Button>
            </li>
          ))}
      </ul>
    </fieldset>
  );
}

// ---- Vocabulary ----

const USAGES: Array<{ value: VocabularyUsage; label: string }> = [
  { value: 'preferred', label: 'Preferred' },
  { value: 'allowed', label: 'Allowed' },
  { value: 'avoid', label: 'Avoid' },
  { value: 'prohibited', label: 'Prohibited' },
];

export function VocabularySection({ doc, onChange }: Props) {
  const terms = doc.vocabulary ?? [];
  const set = (next: Term[]) => onChange({ ...doc, vocabulary: next });
  return (
    <EditorSection
      title="Vocabulary"
      hint="Terms the brand prefers, allows, avoids or never uses, with what to write instead. Never write and preferred terms under Voice still apply."
    >
      <Issues issues={guidanceIssues(doc).vocabulary ?? []} />
      {terms.length === 0 && <p className="text-sm text-muted-foreground">No terms yet.</p>}
      <ul className="flex flex-col gap-2" aria-label="Vocabulary">
        {terms.map((t, i) => (
          <Row
            key={i}
            provenance={t.provenance}
            removeLabel={`term ${t.term || i + 1}`}
            onRemove={() => set(terms.filter((_, j) => j !== i))}
          >
            <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
              <Field label="Term" htmlFor={`kit-term-${i}`}>
                <Input
                  id={`kit-term-${i}`}
                  value={t.term}
                  maxLength={120}
                  onChange={(e) => set(patchRow(terms, i, { term: e.target.value }))}
                />
              </Field>
              <Field label="Usage" htmlFor={`kit-term-${i}-usage`}>
                <Select
                  id={`kit-term-${i}-usage`}
                  value={t.usage}
                  options={USAGES}
                  onValueChange={(usage) => set(patchRow(terms, i, { usage: usage as VocabularyUsage }))}
                />
              </Field>
            </div>
            <Field label="Definition" htmlFor={`kit-term-${i}-definition`}>
              <Input
                id={`kit-term-${i}-definition`}
                value={t.definition ?? ''}
                maxLength={500}
                onChange={(e) => set(patchRow(terms, i, { definition: e.target.value }))}
              />
            </Field>
            <ListEditor
              id={`kit-term-${i}-alternatives`}
              label={t.usage === 'avoid' || t.usage === 'prohibited' ? 'Write instead' : 'Alternatives'}
              item="alternative"
              values={t.alternatives}
              max={10}
              maxLength={120}
              onChange={(alternatives) => set(patchRow(terms, i, { alternatives }))}
            />
          </Row>
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          disabled={terms.length >= 200}
          onClick={() =>
            set([...terms, byPerson({ term: '', usage: 'preferred' as const, alternatives: [] })])
          }
        >
          Add term
        </Button>
      </div>
    </EditorSection>
  );
}

// ---- Writing patterns ----

const emptyPattern = (): WritingPattern => byPerson({ guidance: '', dos: [], donts: [], examples: [] });

export function WritingPatternsSection({ doc, onChange }: Props) {
  const patterns = doc.writingPatterns ?? {};
  const setPart = (part: (typeof WRITING_PARTS)[number], value: WritingPattern | undefined) => {
    const { [part]: _old, ...rest } = patterns;
    onChange({ ...doc, writingPatterns: value ? { ...rest, [part]: value } : rest });
  };
  return (
    <EditorSection
      title="Writing patterns"
      hint="How each part of a piece of copy is written: guidance, dos, don'ts and examples."
    >
      {WRITING_PARTS.map((part) => {
        const p = patterns[part];
        const label = WRITING_PART_LABEL[part];
        const id = `kit-writing-${part}`;
        if (!p)
          return (
            <div
              key={part}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border p-3"
            >
              <span className="text-sm">{label}</span>
              <Button size="sm" onClick={() => setPart(part, emptyPattern())}>
                Add guidance<span className="sr-only"> for {label.toLowerCase()}</span>
              </Button>
            </div>
          );
        const update = (patch: Partial<WritingPattern>) => setPart(part, byPerson({ ...p, ...patch }));
        return (
          <fieldset
            key={part}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
            aria-label={label}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <legend className="text-sm font-medium">{label}</legend>
              <div className="flex items-center gap-2">
                <ProvenanceBadge provenance={p.provenance} />
                <Button size="sm" variant="ghost" onClick={() => setPart(part, undefined)}>
                  Remove<span className="sr-only"> guidance for {label.toLowerCase()}</span>
                </Button>
              </div>
            </div>
            <Field label={`${label}: guidance`} htmlFor={`${id}-guidance`}>
              <Textarea
                id={`${id}-guidance`}
                rows={2}
                maxLength={2000}
                value={p.guidance}
                onChange={(e) => update({ guidance: e.target.value })}
              />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <ListEditor
                id={`${id}-dos`}
                label={`${label}: dos`}
                item="do"
                values={p.dos}
                max={12}
                onChange={(dos) => update({ dos })}
              />
              <ListEditor
                id={`${id}-donts`}
                label={`${label}: don'ts`}
                item="don't"
                values={p.donts}
                max={12}
                onChange={(donts) => update({ donts })}
              />
            </div>
            <ListEditor
              id={`${id}-examples`}
              label={`${label}: examples`}
              item="example"
              values={p.examples}
              max={6}
              maxLength={1000}
              onChange={(examples) => update({ examples })}
            />
          </fieldset>
        );
      })}
    </EditorSection>
  );
}

// ---- Examples ----

const channelOptions = (any: string) => [
  { value: NONE, label: any },
  ...RELEASE_1_PROVIDERS.map((p) => ({ value: p.key, label: p.label })),
];
const contentOptions = [{ value: NONE, label: 'Any content' }, ...CONTENT_TYPES];

export function ExamplesSection({ doc, onChange }: Props) {
  const examples = doc.voice.examples;
  const set = (next: Example[]) => onChange({ ...doc, voice: { ...doc.voice, examples: next } });
  // Optional fields are removed rather than stored empty when the person picks "Any".
  const setOptional = (i: number, key: 'channelKey' | 'contentType', value: string) => {
    const e = examples[i];
    if (!e) return;
    const { [key]: _old, ...rest } = e;
    set(examples.map((x, j) => (j === i ? byPerson(value === NONE ? rest : { ...rest, [key]: value }) : x)));
  };
  return (
    <EditorSection
      title="Examples"
      hint="Copy that is on brand and copy that is not, with why. Off-brand examples can carry the on-brand rewrite."
    >
      <Issues issues={guidanceIssues(doc).examples ?? []} />
      {examples.length === 0 && <p className="text-sm text-muted-foreground">No examples yet.</p>}
      <ul className="flex flex-col gap-2" aria-label="Examples">
        {examples.map((e, i) => (
          <Row
            key={i}
            provenance={e.provenance}
            removeLabel={`example ${i + 1}`}
            onRemove={() => set(examples.filter((_, j) => j !== i))}
          >
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Verdict" htmlFor={`kit-example-${i}-verdict`}>
                <Select
                  id={`kit-example-${i}-verdict`}
                  value={e.verdict}
                  options={[
                    { value: 'on_brand', label: 'On brand' },
                    { value: 'off_brand', label: 'Off brand' },
                  ]}
                  onValueChange={(verdict) =>
                    set(patchRow(examples, i, { verdict: verdict as Example['verdict'] }))
                  }
                />
              </Field>
              <Field label="Channel" htmlFor={`kit-example-${i}-channel`}>
                <Select
                  id={`kit-example-${i}-channel`}
                  value={e.channelKey ?? NONE}
                  options={channelOptions('Any channel')}
                  onValueChange={(v) => setOptional(i, 'channelKey', v)}
                />
              </Field>
              <Field label="Content type" htmlFor={`kit-example-${i}-type`}>
                <Select
                  id={`kit-example-${i}-type`}
                  value={e.contentType ?? NONE}
                  options={contentOptions}
                  onValueChange={(v) => setOptional(i, 'contentType', v)}
                />
              </Field>
            </div>
            <Field label="Example text" htmlFor={`kit-example-${i}-text`}>
              <Textarea
                id={`kit-example-${i}-text`}
                rows={2}
                value={e.text}
                onChange={(ev) => set(patchRow(examples, i, { text: ev.target.value }))}
              />
            </Field>
            <Field label="Why" htmlFor={`kit-example-${i}-why`}>
              <Textarea
                id={`kit-example-${i}-why`}
                rows={2}
                maxLength={1000}
                value={e.rationale ?? e.note}
                onChange={(ev) => set(patchRow(examples, i, { rationale: ev.target.value, note: '' }))}
              />
            </Field>
            {e.verdict === 'off_brand' && (
              <Field label="On-brand rewrite" htmlFor={`kit-example-${i}-rewrite`}>
                <Textarea
                  id={`kit-example-${i}-rewrite`}
                  rows={2}
                  maxLength={1000}
                  value={e.rewrite ?? ''}
                  onChange={(ev) => set(patchRow(examples, i, { rewrite: ev.target.value }))}
                />
              </Field>
            )}
          </Row>
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          disabled={examples.length >= 40}
          onClick={() => set([...examples, byPerson({ text: '', verdict: 'on_brand' as const, note: '' })])}
        >
          Add example
        </Button>
      </div>
    </EditorSection>
  );
}

// ---- Copy templates ----

export function TemplatesSection({ doc, onChange }: Props) {
  const templates = doc.copyTemplates ?? [];
  const set = (next: Template[]) => onChange({ ...doc, copyTemplates: next });
  const update = (i: number, patch: Partial<Template>) => set(patchRow(templates, i, patch));
  return (
    <EditorSection
      title="Copy templates"
      hint="Structures copy follows: the parts in order, what each part does and how long it may be. Visual layouts are under Visual patterns."
    >
      <Issues issues={guidanceIssues(doc).templates ?? []} />
      {templates.length === 0 && <p className="text-sm text-muted-foreground">No copy templates yet.</p>}
      <ul className="flex flex-col gap-2" aria-label="Copy templates">
        {templates.map((t, i) => (
          <Row
            key={i}
            provenance={t.provenance}
            removeLabel={`template ${t.name || i + 1}`}
            onRemove={() => set(templates.filter((_, j) => j !== i))}
          >
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Template name" htmlFor={`kit-template-${i}-name`}>
                <Input
                  id={`kit-template-${i}-name`}
                  value={t.name}
                  maxLength={120}
                  onChange={(e) =>
                    update(i, {
                      name: e.target.value,
                      // A new template's key follows its name until the person sets one.
                      ...(t.key === '' || t.key === slug(t.name)
                        ? { key: slug(e.target.value).slice(0, 60) }
                        : {}),
                    })
                  }
                />
              </Field>
              <Field
                label="Template key"
                htmlFor={`kit-template-${i}-key`}
                hint="A brief names it to use it."
              >
                <Input
                  id={`kit-template-${i}-key`}
                  value={t.key}
                  maxLength={60}
                  onChange={(e) => update(i, { key: slug(e.target.value) })}
                />
              </Field>
              <Field label="Content type" htmlFor={`kit-template-${i}-type`}>
                <Select
                  id={`kit-template-${i}-type`}
                  value={t.contentType}
                  options={CONTENT_TYPES}
                  onValueChange={(v) => update(i, { contentType: v as CopyContentType })}
                />
              </Field>
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-xs font-medium text-muted-foreground">
                Channels (none: any channel)
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {RELEASE_1_PROVIDERS.map((p) => (
                  <label key={p.key} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={t.channelKeys.includes(p.key)}
                      onChange={(e) =>
                        update(i, {
                          channelKeys: e.target.checked
                            ? [...t.channelKeys, p.key]
                            : t.channelKeys.filter((k) => k !== p.key),
                        })
                      }
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Purpose" htmlFor={`kit-template-${i}-purpose`}>
              <Textarea
                id={`kit-template-${i}-purpose`}
                rows={2}
                maxLength={1000}
                value={t.purpose}
                onChange={(e) => update(i, { purpose: e.target.value })}
              />
            </Field>
            <TemplateParts
              index={i}
              structure={t.structure}
              onChange={(structure) => update(i, { structure })}
            />
            <Field label="Example" htmlFor={`kit-template-${i}-example`}>
              <Textarea
                id={`kit-template-${i}-example`}
                rows={3}
                maxLength={4000}
                value={t.example ?? ''}
                onChange={(e) => update(i, { example: e.target.value })}
              />
            </Field>
          </Row>
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          disabled={templates.length >= 40}
          onClick={() =>
            set([
              ...templates,
              byPerson({
                key: '',
                name: '',
                contentType: 'social_post' as const,
                channelKeys: [],
                purpose: '',
                structure: [{ slot: '', guidance: '' }],
              }),
            ])
          }
        >
          Add copy template
        </Button>
      </div>
    </EditorSection>
  );
}

/** A template's parts in order, each movable up and down. */
function TemplateParts({
  index,
  structure,
  onChange,
}: {
  index: number;
  structure: Template['structure'];
  onChange: (next: Template['structure']) => void;
}) {
  const move = (from: number, to: number) => {
    const next = [...structure];
    const [part] = next.splice(from, 1);
    if (part) next.splice(to, 0, part);
    onChange(next);
  };
  const update = (j: number, patch: Partial<Template['structure'][number]>) =>
    onChange(structure.map((s, k) => (k === j ? { ...s, ...patch } : s)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">Parts, in order</legend>
      <ol className="flex flex-col gap-2" aria-label={`Parts of template ${index + 1}`}>
        {structure.map((s, j) => {
          const id = `kit-template-${index}-part-${j}`;
          return (
            <li key={j} className="grid gap-2 rounded-md bg-muted/40 p-2 sm:grid-cols-[10rem_1fr_7rem]">
              <Field label={`Part ${j + 1}`} htmlFor={`${id}-slot`}>
                <Input
                  id={`${id}-slot`}
                  value={s.slot}
                  maxLength={60}
                  placeholder="e.g. hook"
                  onChange={(e) => update(j, { slot: e.target.value })}
                />
              </Field>
              <Field label={`Part ${j + 1} guidance`} htmlFor={`${id}-guidance`}>
                <Input
                  id={`${id}-guidance`}
                  value={s.guidance}
                  maxLength={1000}
                  onChange={(e) => update(j, { guidance: e.target.value })}
                />
              </Field>
              <Field label={`Part ${j + 1} max length`} htmlFor={`${id}-max`}>
                <Input
                  id={`${id}-max`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={s.maxLength ?? ''}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const { maxLength: _old, ...rest } = s;
                    onChange(
                      structure.map((x, k) =>
                        k === j ? (n > 0 ? { ...rest, maxLength: Math.min(n, 100_000) } : rest) : x,
                      ),
                    );
                  }}
                />
              </Field>
              <div className="flex flex-wrap gap-1 sm:col-span-3">
                <Button size="sm" variant="ghost" disabled={j === 0} onClick={() => move(j, j - 1)}>
                  Move up<span className="sr-only"> part {j + 1}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={j === structure.length - 1}
                  onClick={() => move(j, j + 1)}
                >
                  Move down<span className="sr-only"> part {j + 1}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={structure.length === 1}
                  onClick={() => onChange(structure.filter((_, k) => k !== j))}
                >
                  Remove<span className="sr-only"> part {j + 1}</span>
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <div>
        <Button
          size="sm"
          disabled={structure.length >= 12}
          onClick={() => onChange([...structure, { slot: '', guidance: '' }])}
        >
          Add part
        </Button>
      </div>
    </fieldset>
  );
}

// ---- Channel guidance: a baseline and per-channel overrides ----

/** Per channel row: what is wrong with its channel, if anything (one row per channel). */
export function channelIssues(doc: Doc): Array<{ index: number; issue: string }> {
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

/** Sets (or, with '', clears) a channel's own value for a baseline field. */
function withOverride(entry: Channel, field: ChannelGuidanceField, value: string): Channel {
  const key = CHANNEL_OVERRIDE_KEY[field];
  if (key === 'captionStyle' || key === 'ctaConventions') return { ...entry, [key]: value };
  const { [key]: _old, ...rest } = entry;
  return (value ? { ...rest, [key]: value } : rest) as Channel;
}

/**
 * Channel guidance: the brand-wide baseline every channel inherits, then each channel's overrides. Each field of a
 * channel says whether it is inherited from the baseline or overridden, with a reset to the baseline; the channel's
 * platform limits (the capability register) are shown read-only beside it, since they win over any preference.
 */
export function ChannelsSection({ doc, onChange }: Props) {
  const rows = doc.channelGuidance;
  // Rows have no id of their own; a local one keeps each row's state with it when another is removed.
  const next = useRef(0);
  const [rowIds, setRowIds] = useState(() => rows.map(() => next.current++));
  const issues = channelIssues(doc);
  const baseline = doc.channelBaseline ?? {};
  const setBaseline = (field: ChannelGuidanceField, value: string) => {
    const { [field]: _old, ...rest } = baseline;
    onChange({ ...doc, channelBaseline: value ? { ...rest, [field]: value } : rest });
  };
  const update = (i: number, next: Channel) =>
    onChange({ ...doc, channelGuidance: rows.map((c, j) => (j === i ? byPerson(next) : c)) });
  return (
    <EditorSection
      title="Channel guidance"
      hint="The brand's defaults for every channel, then what changes per channel. Platform limits always win over these preferences."
    >
      <fieldset
        className="flex flex-col gap-2 rounded-md border border-border p-3"
        data-testid="channel-baseline"
      >
        <legend className="px-1 text-sm font-medium">All channels (baseline)</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {CHANNEL_GUIDANCE_FIELDS.map((field) => (
            <Field key={field} label={CHANNEL_FIELD_LABEL[field]} htmlFor={`kit-baseline-${field}`}>
              <Textarea
                id={`kit-baseline-${field}`}
                rows={2}
                maxLength={1000}
                value={baseline[field] ?? ''}
                onChange={(e) => setBaseline(field, e.target.value)}
              />
            </Field>
          ))}
        </div>
      </fieldset>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No channel guidance yet.</p>}
      <ul className="flex flex-col gap-3" aria-label="Channel guidance">
        {rows.map((c, i) => (
          <ChannelRow
            key={rowIds[i] ?? `row-${i}`}
            index={i}
            value={c}
            baseline={baseline}
            issue={issues.find((x) => x.index === i)?.issue}
            used={rows.filter((_, j) => j !== i).map((x) => x.providerKey)}
            onChange={(next) => update(i, next)}
            onRemove={() => {
              setRowIds(rowIds.filter((_, j) => j !== i));
              onChange({ ...doc, channelGuidance: rows.filter((_, j) => j !== i) });
            }}
          />
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          onClick={() => {
            setRowIds([...rowIds, next.current++]);
            onChange({
              ...doc,
              channelGuidance: [
                ...rows,
                byPerson({ providerKey: '', captionStyle: '', preferredFormats: [], ctaConventions: '' }),
              ],
            });
          }}
          disabled={rows.length >= 20}
        >
          Add channel
        </Button>
      </div>
    </EditorSection>
  );
}

function ChannelRow({
  index,
  value,
  baseline,
  issue,
  used,
  onChange,
  onRemove,
}: {
  index: number;
  value: Channel;
  baseline: NonNullable<Doc['channelBaseline']>;
  issue: string | undefined;
  used: string[];
  onChange: (next: Channel) => void;
  onRemove: () => void;
}) {
  const { brandId } = useBrandContext();
  const limits = useChannelLimits(brandId);
  const id = `kit-channel-${index}`;
  const known = RELEASE_1_PROVIDERS.some((p) => p.key === value.providerKey);
  const options = [
    ...RELEASE_1_PROVIDERS.map((p) => ({ value: p.key, label: p.label, disabled: used.includes(p.key) })),
    ...(value.providerKey && !known ? [{ value: value.providerKey, label: value.providerKey }] : []),
  ];
  const label = value.providerKey ? channelLabel(value.providerKey) : '';
  const limit = limits.data?.items.find((l) => l.providerKey === value.providerKey);
  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      data-testid={`channel-row-${index}`}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Channel" htmlFor={`${id}-provider`} error={issue} className="min-w-48 flex-1">
          <Select
            id={`${id}-provider`}
            placeholder="Choose a channel"
            value={value.providerKey}
            onValueChange={(providerKey) => onChange({ ...value, providerKey })}
            options={options}
          />
        </Field>
        <ProvenanceBadge provenance={value.provenance} />
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove<span className="sr-only"> guidance for {label || `row ${index + 1}`}</span>
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_16rem]">
        <div className="flex min-w-0 flex-col gap-3">
          {CHANNEL_GUIDANCE_FIELDS.map((field) => {
            const own = channelOverride(value, field);
            const inherited = baseline[field]?.trim() ? baseline[field] : undefined;
            const fid = `${id}-${field}`;
            return (
              <div key={field} className="flex flex-col gap-1" data-testid={`${fid}-field`}>
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={fid} className="text-xs font-medium text-muted-foreground">
                    {CHANNEL_FIELD_LABEL[field]}
                  </label>
                  {own !== undefined ? (
                    <>
                      <Badge tone="info" glyph={false}>
                        Overridden
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onChange(withOverride(value, field, ''))}
                      >
                        Reset to baseline
                        <span className="sr-only"> {`for ${CHANNEL_FIELD_LABEL[field].toLowerCase()}`}</span>
                      </Button>
                    </>
                  ) : inherited !== undefined ? (
                    <Badge glyph={false}>Inherited from baseline</Badge>
                  ) : null}
                </div>
                <Textarea
                  id={fid}
                  rows={2}
                  maxLength={1000}
                  value={own ?? ''}
                  placeholder={inherited ?? ''}
                  aria-describedby={
                    inherited !== undefined && own === undefined ? `${fid}-inherited` : undefined
                  }
                  onChange={(e) => onChange(withOverride(value, field, e.target.value))}
                />
                {inherited !== undefined && own === undefined && (
                  <p id={`${fid}-inherited`} className="text-xs text-muted-foreground">
                    Baseline: {inherited}
                  </p>
                )}
              </div>
            );
          })}
          <ListEditor
            id={`${id}-formats`}
            label="Preferred formats"
            item="format"
            values={value.preferredFormats}
            max={12}
            maxLength={60}
            onChange={(preferredFormats) => onChange({ ...value, preferredFormats })}
          />
          <Field label="Format notes" htmlFor={`${id}-format-notes`}>
            <Textarea
              id={`${id}-format-notes`}
              rows={2}
              maxLength={1000}
              value={value.formats ?? ''}
              onChange={(e) => {
                const { formats: _old, ...rest } = value;
                onChange(e.target.value ? { ...rest, formats: e.target.value } : rest);
              }}
            />
          </Field>
          <Field label="Audience on this channel" htmlFor={`${id}-audience`}>
            <Textarea
              id={`${id}-audience`}
              rows={2}
              maxLength={1000}
              value={value.audience ?? ''}
              onChange={(e) => {
                const { audience: _old, ...rest } = value;
                onChange(e.target.value ? { ...rest, audience: e.target.value } : rest);
              }}
            />
          </Field>
          <ListEditor
            id={`${id}-examples`}
            label="Channel examples"
            item="example"
            values={(value.examples ?? []).map((e) => e.text)}
            max={6}
            maxLength={1000}
            onChange={(texts) =>
              onChange({
                ...value,
                examples: texts.map((text, k) => ({ ...(value.examples ?? [])[k], text })),
              })
            }
          />
        </div>
        <aside aria-label={`Platform limits${label ? ` for ${label}` : ''}`}>
          {!value.providerKey ? (
            <p className="text-xs text-muted-foreground">Choose a channel to see its platform limits.</p>
          ) : limits.isPending ? (
            <Skeleton label="Loading platform limits" lines={3} />
          ) : limits.isError ? (
            <RequestError error={limits.error} onRetry={() => void limits.refetch()} />
          ) : (
            <PlatformLimits limit={limit} />
          )}
        </aside>
      </div>
    </li>
  );
}
