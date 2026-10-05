import { z } from 'zod';
import { PageRequest } from './pagination';

/** Imported guideline text is capped so it always fits an agent's context alongside everything else. */
export const GUIDELINES_MAX_BYTES = 64 * 1024;
export const GUIDELINES_MAX_DOCUMENTS = 40;

export const BrandGuidelinesV1 = z.object({
  source: z.object({
    /** The skill's name (front matter), e.g. ore-and-tar-brand. */
    name: z.string().min(1).max(200),
    description: z.string().max(1000),
    /** sha256 of the imported text files, sorted by path: the same package always hashes the same. */
    packageHash: z.string().length(64),
  }),
  documents: z
    .array(z.object({ path: z.string().min(1).max(200), content: z.string().max(GUIDELINES_MAX_BYTES) }))
    .min(1)
    .max(GUIDELINES_MAX_DOCUMENTS),
});
export type BrandGuidelinesV1 = z.infer<typeof BrandGuidelinesV1>;

/** Evidence behind an approved fact: source document/asset refs, URLs, reviewer. */
export const EvidenceRef = z.object({
  kind: z.enum([
    'asset',
    'document',
    'url',
    'reviewer',
    'metric_snapshot',
    'experiment_result',
    'comment',
    'other',
  ]),
  ref: z.string().max(1000),
  note: z.string().max(500).optional(),
  capturedAt: z.string().datetime().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

// ---- BSC-1 guidance model: additive, optional, bounded; no defaults, so stored documents parse and hash unchanged ----

/**
 * Where a guidance item came from: typed by a person (`user`), taken verbatim from a supplied document (`imported`),
 * a pattern drawn from supplied examples, which are cited (`inferred`), or an AI proposal with no direct source
 * (`suggested`). An item a person edits becomes `user`. Absent on items written before provenance existed.
 */
export const GuidanceOrigin = z.enum(['user', 'imported', 'inferred', 'suggested']);
export type GuidanceOrigin = z.infer<typeof GuidanceOrigin>;
export const GuidanceProvenance = z.object({
  origin: GuidanceOrigin,
  evidence: z.array(EvidenceRef).max(10).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  suggestionId: z.string().min(1).max(64).optional(),
});
export type GuidanceProvenance = z.infer<typeof GuidanceProvenance>;

const provenance = { provenance: GuidanceProvenance.optional() };
/** A short line of guidance: a do, a don't, a need, an objection. */
const Line = z.string().min(1).max(300);
const Lines = (max: number) => z.array(Line).max(max);
const Prose = z.string().max(1000);

/** What a piece of copy is; copy templates and examples say which they apply to. */
export const CopyContentType = z.enum(['social_post', 'article', 'email', 'ad', 'landing_section', 'other']);
export type CopyContentType = z.infer<typeof CopyContentType>;

export const VoicePersonalityTrait = z.object({
  trait: z.string().min(1).max(60),
  note: z.string().max(300).optional(),
  ...provenance,
});
export const VoicePrinciple = z.object({
  statement: z.string().min(1).max(300),
  rationale: Prose,
  ...provenance,
});
export const VoiceSpelling = z.object({ locale: z.string().min(2).max(20), notes: Prose });
export const StyleRuleTopic = z.enum([
  'numbers',
  'dates',
  'capitalisation',
  'punctuation',
  'formatting',
  'other',
]);
export type StyleRuleTopic = z.infer<typeof StyleRuleTopic>;
export const VoiceStyleRule = z.object({
  topic: StyleRuleTopic,
  rule: z.string().min(1).max(500),
  ...provenance,
});
/** How the brand may (and may not) make claims: superlatives, comparisons, guarantees, regulated words. */
export const VoiceClaimRule = z.object({ rule: z.string().min(1).max(500), ...provenance });

export const MessagingPillar = z.object({
  key: z.string().min(1).max(60),
  title: z.string().min(1).max(120),
  statement: Prose,
  /** Approved facts of this brand that prove the pillar (checked on save). */
  proofFactIds: z.array(z.string().min(1).max(64)).max(10),
  ...provenance,
});
export const KeyMessage = z.object({
  text: z.string().min(1).max(500),
  pillarKey: z.string().min(1).max(60).optional(),
  ...provenance,
});
export const BrandMessaging = z.object({
  positioning: z.string().max(2000),
  valueProposition: z.string().max(2000),
  pillars: z.array(MessagingPillar).max(8),
  keyMessages: z.array(KeyMessage).max(20),
});
export type BrandMessaging = z.infer<typeof BrandMessaging>;

export const VocabularyUsage = z.enum(['preferred', 'allowed', 'avoid', 'prohibited']);
export type VocabularyUsage = z.infer<typeof VocabularyUsage>;
export const VocabularyTerm = z.object({
  term: z.string().min(1).max(120),
  definition: z.string().max(500).optional(),
  usage: VocabularyUsage,
  /** What to write instead (for avoid and prohibited terms) or equivalents (for preferred ones). */
  alternatives: z.array(z.string().min(1).max(120)).max(10),
  note: z.string().max(500).optional(),
  ...provenance,
});
export type VocabularyTerm = z.infer<typeof VocabularyTerm>;

export const WRITING_PARTS = ['headline', 'introduction', 'body', 'cta', 'long_form'] as const;
export type WritingPart = (typeof WRITING_PARTS)[number];
export const WritingPattern = z.object({
  guidance: z.string().max(2000),
  dos: Lines(12),
  donts: Lines(12),
  examples: z.array(z.string().min(1).max(1000)).max(6),
  ...provenance,
});
export type WritingPattern = z.infer<typeof WritingPattern>;
export const WritingPatterns = z.object({
  headline: WritingPattern.optional(),
  introduction: WritingPattern.optional(),
  body: WritingPattern.optional(),
  cta: WritingPattern.optional(),
  long_form: WritingPattern.optional(),
});

export const CopyTemplateSlot = z.object({
  slot: z.string().min(1).max(60),
  guidance: Prose,
  maxLength: z.number().int().positive().max(100_000).optional(),
});
/** A copy structure (hook, proof, call to action...), not a visual layout: layout templates are creative rows. */
export const CopyTemplate = z.object({
  key: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  contentType: CopyContentType,
  /** The channels it is for; none means any channel. */
  channelKeys: z.array(z.string().min(1).max(40)).max(20),
  purpose: Prose,
  structure: z.array(CopyTemplateSlot).min(1).max(12),
  example: z.string().max(4000).optional(),
  ...provenance,
});
export type CopyTemplate = z.infer<typeof CopyTemplate>;

/**
 * The brand-wide channel defaults each channel entry inherits. A channel entry overrides a field by setting it;
 * `captionStyle` and `ctaConventions` (the entry's original fields) are its `toneAdaptation` and `cta`.
 */
export const CHANNEL_GUIDANCE_FIELDS = [
  'objectives',
  'toneAdaptation',
  'conventions',
  'cta',
  'accessibility',
  'hashtags',
  'mentions',
  'links',
  'frequency',
] as const;
export type ChannelGuidanceField = (typeof CHANNEL_GUIDANCE_FIELDS)[number];
export const ChannelBaseline = z.object({
  objectives: Prose.optional(),
  toneAdaptation: Prose.optional(),
  conventions: Prose.optional(),
  cta: Prose.optional(),
  accessibility: Prose.optional(),
  hashtags: Prose.optional(),
  mentions: Prose.optional(),
  links: Prose.optional(),
  frequency: Prose.optional(),
});
export type ChannelBaseline = z.infer<typeof ChannelBaseline>;
export const ChannelExample = z.object({
  text: z.string().min(1).max(1000),
  note: z.string().max(500).optional(),
});

/** The lock-ups a brand system names (BSC-2 adds `secondary`, an alternative lock-up such as a stacked version). */
export const LogoVariant = z.enum(['primary', 'secondary', 'reversed', 'mono', 'mark_only']);
export type LogoVariant = z.infer<typeof LogoVariant>;
export const LOGO_USAGE_NOTE_MAX = 500;
export const LOGO_DONTS_MAX = 10;
export const LOGO_DONT_MAX = 200;

/**
 * One logo rule: which logo asset is the variant, the grounds it may sit on, its clear space (a multiple of the mark
 * height) and minimum width. BSC-2 additions are optional with no defaults, so stored documents parse and hash as
 * they did: `assetVersionId` pins the logo's version (the studio checks a logo element against it), `usage` is the
 * written guidance (backgrounds, don'ts) and `preferredFormat` says whether the brand supplies the logo as vector.
 */
export const LogoRuleV1 = z.object({
  assetId: z.string(),
  assetVersionId: z.string().optional(),
  variant: LogoVariant,
  allowedBackgroundColourKeys: z.array(z.string()),
  clearSpaceRatio: z.number(), // multiple of mark height
  minWidthPx: z.number(),
  usage: z
    .object({
      backgroundsNote: z.string().max(LOGO_USAGE_NOTE_MAX),
      donts: z.array(z.string().max(LOGO_DONT_MAX)).max(LOGO_DONTS_MAX),
    })
    .optional(),
  preferredFormat: z.enum(['svg', 'raster']).optional(),
});
export type LogoRuleV1 = z.infer<typeof LogoRuleV1>;

/** Spec 8.1: the brand system document, versioned. */
export const BrandSystemDocumentV1 = z.object({
  schemaVersion: z.literal(1),
  voice: z.object({
    summary: z.string().max(2000),
    tone: z.array(z.string()).max(12),
    audiences: z.array(
      z.object({
        key: z.string(),
        description: z.string(),
        needs: Lines(10).optional(),
        objections: Lines(10).optional(),
        ...provenance,
      }),
    ),
    preferredTerms: z.array(z.object({ use: z.string(), avoid: z.array(z.string()) })),
    prohibitedPhrases: z.array(z.string()),
    locales: z.array(z.string()),
    examples: z.array(
      z.object({
        text: z.string(),
        verdict: z.enum(['on_brand', 'off_brand']),
        note: z.string(),
        channelKey: z.string().min(1).max(40).optional(),
        contentType: CopyContentType.optional(),
        /** Why it is (or is not) on brand. */
        rationale: Prose.optional(),
        /** For an off-brand example: the same message written on brand. */
        rewrite: z.string().max(1000).optional(),
        ...provenance,
      }),
    ),
    personality: z.array(VoicePersonalityTrait).max(12).optional(),
    principles: z.array(VoicePrinciple).max(12).optional(),
    spelling: VoiceSpelling.optional(),
    styleRules: z.array(VoiceStyleRule).max(40).optional(),
    claimRules: z.array(VoiceClaimRule).max(20).optional(),
  }),
  tokens: z.object({
    colours: z.array(
      z.object({
        key: z.string(),
        value: z.string(),
        role: z.enum(['primary', 'secondary', 'accent', 'neutral', 'background', 'text', 'semantic']),
      }),
    ),
    typeRoles: z.array(
      z.object({
        role: z.enum(['display', 'heading', 'body', 'label', 'caption']),
        fontAssetId: z.string(),
        weight: z.number(),
        minSizePx: z.number(),
        tracking: z.number().optional(),
        /**
         * The size the role is set at, in px, where the guidance names one besides its minimum; absent reads as the
         * minimum (as before). Optional with no default, so stored documents parse and hash as they did.
         */
        sizePx: z.number().positive().optional(),
        /** Line height as a multiple of the size (1.5 is 150%); absent where the guidance does not set one. */
        lineHeight: z.number().positive().optional(),
      }),
    ),
    spacingScale: z.array(z.number()),
    radii: z.array(z.number()),
    contrastTarget: z.enum(['AA', 'AAA']).default('AA'),
  }),
  logoRules: z.array(LogoRuleV1),
  patterns: z.array(
    z.object({
      key: z.string(),
      description: z.string(),
      exampleAssetIds: z.array(z.string()),
      templateVersionIds: z.array(z.string()),
    }),
  ),
  channelGuidance: z.array(
    z.object({
      providerKey: z.string(),
      captionStyle: z.string(),
      preferredFormats: z.array(z.string()),
      ctaConventions: z.string(),
      // BSC-1 overrides of the baseline (captionStyle and ctaConventions are its toneAdaptation and cta).
      objectives: Prose.optional(),
      conventions: Prose.optional(),
      accessibility: Prose.optional(),
      hashtags: Prose.optional(),
      mentions: Prose.optional(),
      links: Prose.optional(),
      frequency: Prose.optional(),
      /** Who the brand reaches on this channel. */
      audience: Prose.optional(),
      /** Format notes beyond the preferred formats (lengths, carousel size, video length). */
      formats: Prose.optional(),
      examples: z.array(ChannelExample).max(6).optional(),
      ...provenance,
    }),
  ),
  /** Brand-wide channel defaults; each channel entry inherits what it does not set. */
  channelBaseline: ChannelBaseline.optional(),
  messaging: BrandMessaging.optional(),
  vocabulary: z.array(VocabularyTerm).max(200).optional(),
  writingPatterns: WritingPatterns.optional(),
  copyTemplates: z.array(CopyTemplate).max(40).optional(),
  /**
   * The brand's written guidelines (an imported brand skill: SKILL.md and its references), carried with the version
   * and given to agents with the brand constraints. Absent on versions that have none. The last author of the
   * guidelines is recorded (brand_guideline_authors); any person with brand.publish_version publishes.
   */
  guidelines: BrandGuidelinesV1.optional(),
});
export type BrandSystemDocumentV1 = z.infer<typeof BrandSystemDocumentV1>;

export type ChannelGuidanceEntry = BrandSystemDocumentV1['channelGuidance'][number];

/** The entry field that holds a channel's own value for a baseline field. */
export const CHANNEL_OVERRIDE_KEY = {
  objectives: 'objectives',
  toneAdaptation: 'captionStyle',
  conventions: 'conventions',
  cta: 'ctaConventions',
  accessibility: 'accessibility',
  hashtags: 'hashtags',
  mentions: 'mentions',
  links: 'links',
  frequency: 'frequency',
} as const satisfies Record<ChannelGuidanceField, keyof ChannelGuidanceEntry>;

/** A channel entry's own value for a baseline field; blank (or absent) means it inherits the baseline. */
export function channelOverride(
  entry: ChannelGuidanceEntry,
  field: ChannelGuidanceField,
): string | undefined {
  const value = entry[CHANNEL_OVERRIDE_KEY[field]];
  return value?.trim() ? value : undefined;
}

/** A draft with no published predecessor starts from this document (spec 8.2). */
export const emptyBrandSystemDocument = (): BrandSystemDocumentV1 => ({
  schemaVersion: 1,
  voice: {
    summary: '',
    tone: [],
    audiences: [],
    preferredTerms: [],
    prohibitedPhrases: [],
    locales: [],
    examples: [],
  },
  tokens: { colours: [], typeRoles: [], spacingScale: [], radii: [], contrastTarget: 'AA' },
  logoRules: [],
  patterns: [],
  channelGuidance: [],
});

export const BrandVersionState = z.enum(['draft', 'in_review', 'published', 'retired']);
export type BrandVersionState = z.infer<typeof BrandVersionState>;

export const BrandStatus = z.enum(['setup', 'active', 'archived']);
export type BrandStatus = z.infer<typeof BrandStatus>;

export const FactKind = z.enum(['product', 'claim', 'offer', 'contact', 'price', 'statistic', 'legal']);
export type FactKind = z.infer<typeof FactKind>;

/** BSC-3: superseded (terminal) is a fact replaced by its approved correction or merged into another fact. */
export const FactState = z.enum(['proposed', 'approved', 'revoked', 'superseded']);
export type FactState = z.infer<typeof FactState>;

/**
 * BSC-3: what a fact is about. Wider than FactKind, which stays the stored, release-relevant classification (an
 * offer or a price makes content an offer, spec 8.2): every category maps to one kind (factKindOf), and every kind
 * is also a category, so facts stored before the categories read as the category of the same name.
 */
export const FactCategory = z.enum([
  'company',
  'product',
  'service',
  'location',
  'contact',
  'differentiator',
  'audience',
  'terminology',
  'claim',
  'faq',
  'offer',
  'price',
  'statistic',
  'legal',
]);
export type FactCategory = z.infer<typeof FactCategory>;

const FACT_KIND_OF: Record<FactCategory, FactKind> = {
  company: 'claim',
  product: 'product',
  service: 'product',
  location: 'contact',
  contact: 'contact',
  differentiator: 'claim',
  audience: 'claim',
  terminology: 'claim',
  claim: 'claim',
  faq: 'claim',
  offer: 'offer',
  price: 'price',
  statistic: 'statistic',
  legal: 'legal',
};
/** The stored kind a category implies (snapshots, content classes and agents' facts.list still read kinds). */
export const factKindOf = (category: FactCategory): FactKind => FACT_KIND_OF[category];

/**
 * BSC-3 provenance of a fact: typed by a person (user), taken verbatim from a supplied source (extracted), a
 * pattern drawn from supplied material (inferred), or an AI proposal with no direct source (suggested).
 */
export const FactOrigin = z.enum(['user', 'extracted', 'inferred', 'suggested']);
export type FactOrigin = z.infer<typeof FactOrigin>;

export const FactProposedByKind = z.enum(['user', 'agent']);
export type FactProposedByKind = z.infer<typeof FactProposedByKind>;

export const PolicyVersionState = z.enum(['draft', 'active', 'retired']);
export type PolicyVersionState = z.infer<typeof PolicyVersionState>;

/**
 * BSC-3: a source behind a fact: an evidence reference with an optional title and the excerpt that supports the
 * statement. A URL source names its URL in `ref`; an asset source its asset id; a note is kind `other` with the
 * note in `ref`; a reviewer's note at approval is kind `reviewer` (ref = the reviewer's user id, note = the note).
 */
export const FactSource = EvidenceRef.extend({
  title: z.string().max(200).optional(),
  excerpt: z.string().max(1000).optional(),
});
export type FactSource = z.infer<typeof FactSource>;

/** Source kinds that count as a source for the approval rule (a note or a comment is not evidence on its own). */
export const FACT_EVIDENCE_SOURCE_KINDS: ReadonlyArray<EvidenceRef['kind']> = [
  'asset',
  'document',
  'url',
  'metric_snapshot',
  'experiment_result',
];

/** BSC-3: something that disagrees with a fact: another fact of the brand, a source, or a note saying why. */
export const FactConflictInput = z.object({
  factId: z.string().max(32).optional(),
  source: FactSource.optional(),
  note: z.string().max(500).optional(),
});
export type FactConflictInput = z.infer<typeof FactConflictInput>;

export const FactConflictOutcome = z.enum(['kept_this', 'kept_other', 'annotated']);
export type FactConflictOutcome = z.infer<typeof FactConflictOutcome>;

/** A recorded conflict (stored in approved_facts.conflicts) and, once a person decided, how it was resolved. */
export const FactConflict = FactConflictInput.extend({
  id: z.string().max(40),
  raisedAt: z.string().datetime(),
  status: z.enum(['open', 'resolved']),
  resolution: z
    .object({
      outcome: FactConflictOutcome,
      note: z.string().max(500).optional(),
      byUserId: z.string(),
      at: z.string().datetime(),
    })
    .optional(),
});
export type FactConflict = z.infer<typeof FactConflict>;

/**
 * ADR-11 (5), ledger 4.27: which underlying providers may process this brand's generated content, applied to every
 * generation request through the gateway. Provider names are OpenRouter provider slugs (for example `google-vertex`).
 * permittedProviders [] permits any provider; deniedProviders excludes providers the client objects to;
 * zeroRetention routes only to providers that keep nothing (OpenRouter `zdr`). Training and storage of prompts are
 * always refused (`data_collection: deny`), whatever the brand sets.
 */
export const GenerationRestrictions = z.object({
  permittedProviders: z.array(z.string().min(1).max(80)).max(50).default([]),
  deniedProviders: z.array(z.string().min(1).max(80)).max(50).default([]),
  zeroRetention: z.boolean().default(false),
});
export type GenerationRestrictions = z.infer<typeof GenerationRestrictions>;

/**
 * D-13 / UX-20: what publishing a brand version does to the brand's approved and scheduled work.
 * `invalidate_and_hold` is today's behaviour (brandChangeImpactWorkflowV1); `flag` keeps approvals and marks the
 * work for attention instead, which needs approval binding v2 and is designed but not enabled.
 */
export const OnBrandVersionPublished = z.enum(['invalidate_and_hold', 'flag']);
export type OnBrandVersionPublished = z.infer<typeof OnBrandVersionPublished>;

/** Spec 6.3 policy_versions. */
export const PolicyDocumentV1 = z.object({
  schemaVersion: z.literal(1),
  reviewThresholds: z.object({
    requireReviewForContentClasses: z.array(z.string()).default([]),
    blockOnBrandReviewSeverity: z.enum(['blocking', 'warning']).default('blocking'),
  }),
  restrictedTopics: z.array(z.string()).default([]),
  prohibitedTerms: z.array(z.string()).default([]),
  requireDistinctApprover: z.boolean().default(false),
  holdOnDependencyRevocation: z.boolean().default(true), // spec 8.2 default: hold
  mfaRequired: z.boolean().default(false),
  /**
   * Absent on documents written before 27 September 2026 and on brands with no restriction: no default is filled
   * in, so those documents (and the snapshot hashes recorded from them) are unchanged.
   */
  generation: GenerationRestrictions.optional(),
  /**
   * D-13: no default is filled in, so documents written before 1 October 2026 and the snapshot hashes recorded
   * from them are unchanged; absent reads as `invalidate_and_hold`, today's behaviour.
   */
  onBrandVersionPublished: OnBrandVersionPublished.optional(),
});
export type PolicyDocumentV1 = z.infer<typeof PolicyDocumentV1>;

/** The policy in force while a brand has no active policy version: every default, including hold on revocation. */
export const defaultPolicyDocument = (): PolicyDocumentV1 =>
  PolicyDocumentV1.parse({ schemaVersion: 1, reviewThresholds: {} });

export const DesignTokenSetV1 = z.object({
  schemaVersion: z.literal(1),
  colour: z.record(z.string()),
  typeRoles: z.record(z.object({ fontAssetId: z.string(), weight: z.number(), minSizePx: z.number() })),
  spacing: z.array(z.number()),
  radius: z.array(z.number()),
});
export type DesignTokenSetV1 = z.infer<typeof DesignTokenSetV1>;

/**
 * Spec 8.3: immutable, hashed bundle for agents and validation. `hash` is hashCanonical of the bundle without
 * `hash` (packages/domain/src/brand-snapshot.ts). Every agent run and every revision records the hash.
 */
export const BrandSnapshotV1 = z.object({
  hash: z.string().length(64),
  brandId: z.string(),
  brandVersionId: z.string(),
  brandVersionNumber: z.number().int(),
  document: BrandSystemDocumentV1,
  /** Approved facts whose validity window contains the resolution time, sorted by id. */
  facts: z.array(
    z.object({
      id: z.string(),
      kind: FactKind,
      statement: z.string(),
      validFrom: z.string().datetime().nullable(),
      validUntil: z.string().datetime().nullable(),
    }),
  ),
  /** Objectives active at the resolution time, sorted by id. */
  objectives: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      primaryMetricKey: z.string(),
      guardrailMetricKeys: z.array(z.string()),
    }),
  ),
  /** null: no policy version has been activated yet; `policy` is then defaultPolicyDocument(). */
  policyVersionId: z.string().nullable(),
  policy: PolicyDocumentV1,
  /** Supplied by the creative module from Phase 3 (templates); always [] until then. */
  eligibleTemplateVersionIds: z.array(z.string()),
  timezone: z.string(),
  defaultLocale: z.string(),
});
export type BrandSnapshot = z.infer<typeof BrandSnapshotV1>;

// ---- router DTOs ----
/** D-11: separation of duties is on by default for client brands and off for internal ones. */
export const BrandClassification = z.enum(['client', 'internal']);
export type BrandClassification = z.infer<typeof BrandClassification>;

export const BrandCreate = z.object({
  name: z.string().min(1).max(200),
  timezone: z.string().min(1).max(64),
  defaultLocale: z.string().min(2).max(16),
  classification: BrandClassification.default('client'),
});
/** R1-D: a brand leaves `setup` once its first standards are published; the rest of the journey is optional. */
export const BrandCompleteSetup = z.object({ brandId: z.string(), expectedVersion: z.number().int() });
export const BrandClassify = z.object({
  brandId: z.string(),
  classification: BrandClassification,
  expectedVersion: z.number().int(),
});
export const BrandVersionCreateDraft = z.object({ brandId: z.string() });
export const BrandVersionUpdate = z.object({
  brandId: z.string(),
  versionId: z.string(),
  expectedVersion: z.number().int(),
  document: BrandSystemDocumentV1,
});
export const BrandVersionSubmit = z.object({
  brandId: z.string(),
  versionId: z.string(),
  expectedVersion: z.number().int(),
});
export const BrandVersionPublish = z.object({
  brandId: z.string(),
  versionId: z.string(),
  expectedVersion: z.number().int(),
});
/**
 * D-22: the brand has one brand system that a person edits and saves; the save applies at once. `basedOnVersionId`
 * is the applied version the edit started from (null before the first save): a save over a newer one is a conflict.
 * `proposal` names a pending proposal (an imported brand skill or an agent's suggestion) the save applies and closes.
 */
export const BrandSystemSave = z.object({
  brandId: z.string(),
  basedOnVersionId: z.string().nullable(),
  document: BrandSystemDocumentV1,
  proposal: z.object({ versionId: z.string(), expectedVersion: z.number().int() }).optional(),
});
/** D-22: dismiss a pending proposal without applying it. */
export const BrandProposalDiscard = z.object({
  brandId: z.string(),
  versionId: z.string(),
  expectedVersion: z.number().int(),
});
export const BrandVersionGet = z.object({ brandId: z.string(), versionId: z.string() });
/** UX-20: what publishing any version of the brand would reach now (open requests, valid approvals, scheduled posts). */
export const BrandVersionImpact = z.object({ brandId: z.string() });
export const BrandVersionList = z.object({ brandId: z.string(), page: PageRequest });
/**
 * Spec 8.2 / BSC-3: a fact lands as proposed. `category` (preferred) or the legacy `kind` names what it is about;
 * `sources` (preferred) or the legacy `evidence` say where it comes from. A person's fact is origin `user` unless
 * they say otherwise; an agent's is `suggested` unless it was `extracted` or `inferred` from supplied material. The
 * same statement (normalised) already live in the brand is not proposed twice: the existing fact is returned with
 * `duplicate: true`.
 */
export const FactPropose = z.object({
  brandId: z.string(),
  kind: FactKind.optional(),
  category: FactCategory.optional(),
  scope: z.string().max(200).optional(),
  origin: FactOrigin.optional(),
  statement: z.string().min(1).max(4000),
  evidence: z.array(EvidenceRef).min(1).max(20).optional(),
  sources: z.array(FactSource).max(20).optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  reviewDueAt: z.string().datetime().optional(),
  conflicts: z.array(FactConflictInput).max(10).optional(),
});
/**
 * A suggested or inferred fact without a source is approved only with a reviewer note (BSC-3: AI cannot promote an
 * assumption); the note is kept as a reviewer source. `reviewDueAt` sets when it is next due for review.
 */
export const FactApprove = z.object({
  brandId: z.string(),
  factId: z.string(),
  expectedVersion: z.number().int(),
  reviewerNote: z.string().min(1).max(500).optional(),
  reviewDueAt: z.string().datetime().optional(),
});
export const FactRevoke = z.object({
  brandId: z.string(),
  factId: z.string(),
  expectedVersion: z.number().int(),
  reason: z.string().max(500).optional(),
});
/** BSC-3: withdraw is a revoke whose reason is required (kept on the fact). */
export const FactWithdraw = z.object({
  brandId: z.string(),
  factId: z.string(),
  expectedVersion: z.number().int(),
  reason: z.string().trim().min(1).max(500),
});
/** BSC-3: edit a proposed fact. Omitted fields are kept; null clears an optional one. */
export const FactUpdate = z.object({
  brandId: z.string(),
  factId: z.string(),
  expectedVersion: z.number().int(),
  category: FactCategory.optional(),
  scope: z.string().max(200).nullable().optional(),
  statement: z.string().min(1).max(4000).optional(),
  sources: z.array(FactSource).max(20).optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  reviewDueAt: z.string().datetime().nullable().optional(),
});
/**
 * BSC-3: correct an approved fact. A new proposed fact is made that supersedes it; the approved one keeps applying
 * until the correction is approved, and then becomes superseded. Omitted fields are copied from the approved fact.
 */
export const FactCorrect = z.object({
  brandId: z.string(),
  factId: z.string(),
  expectedVersion: z.number().int(),
  statement: z.string().min(1).max(4000),
  category: FactCategory.optional(),
  scope: z.string().max(200).nullable().optional(),
  sources: z.array(FactSource).max(20).optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  reviewDueAt: z.string().datetime().nullable().optional(),
});
const FactRefVersion = z.object({ factId: z.string(), expectedVersion: z.number().int() });
/** BSC-3: keep one fact; the others become superseded by it and their sources join it. */
export const FactMerge = z.object({
  brandId: z.string(),
  keep: FactRefVersion,
  merge: z.array(FactRefVersion).min(1).max(20),
});
/** BSC-3: a person confirms an approved fact still holds; the next review is due at `nextReviewDueAt` (default a year). */
export const FactMarkReviewed = z.object({
  brandId: z.string(),
  factId: z.string(),
  expectedVersion: z.number().int(),
  nextReviewDueAt: z.string().datetime().optional(),
  note: z.string().min(1).max(500).optional(),
});
/**
 * BSC-3: decide a recorded conflict. kept_this: the fact stands (a conflicting fact of the brand is superseded by it);
 * kept_other: the conflicting fact stands and this one is superseded by it; annotated: both stand, the note says why.
 */
export const FactResolveConflict = z.object({
  brandId: z.string(),
  factId: z.string(),
  expectedVersion: z.number().int(),
  conflictId: z.string().max(40),
  outcome: FactConflictOutcome,
  note: z.string().min(1).max(500).optional(),
});
/**
 * BSC-3 workspace filters, all optional and combined with AND. `effective`: approved and inside the validity window
 * now (what generation uses). `reviewDue`: approved and past its review date. `expiringWithinDays`: approved and its
 * validity ends within that many days. `possibleDuplicates`: live facts whose statement matches or closely resembles
 * another live fact's. `search`: statement or scope contains the text.
 */
export const FactList = z.object({
  brandId: z.string(),
  state: FactState.optional(),
  category: FactCategory.optional(),
  origin: FactOrigin.optional(),
  effective: z.boolean().optional(),
  reviewDue: z.boolean().optional(),
  expiringWithinDays: z.number().int().min(1).max(366).optional(),
  hasConflicts: z.boolean().optional(),
  possibleDuplicates: z.boolean().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  /** Only these facts of the brand (a brief's offer facts, for example); another brand's ids are left out. */
  ids: z.array(z.string().max(32)).min(1).max(100).optional(),
  page: PageRequest,
});
export const ObjectiveSet = z.object({
  brandId: z.string(),
  name: z.string().min(1).max(160),
  primaryMetricKey: z.string().min(1).max(80),
  guardrailMetricKeys: z.array(z.string().max(80)).max(20),
  engagementQualityWeights: z.record(z.number().min(0).max(10)).optional(),
  activeFrom: z.string().datetime(),
  activeUntil: z.string().datetime().optional(),
});
export const ObjectiveList = z.object({
  brandId: z.string(),
  activeOnly: z.boolean().default(false),
  page: PageRequest,
});
/**
 * A new policy version may leave requireDistinctApprover out: it then follows the brand's classification (D-11, on
 * for client brands, off for internal ones). The stored document always carries the value.
 */
export const PolicyVersionCreate = z.object({
  brandId: z.string(),
  document: PolicyDocumentV1.extend({ requireDistinctApprover: z.boolean().optional() }),
});
export const PolicyVersionActivate = z.object({
  brandId: z.string(),
  policyVersionId: z.string(),
  expectedVersion: z.number().int(),
});
export const PolicyGet = z.object({ brandId: z.string(), policyVersionId: z.string().optional() });
export const BrandSnapshotResolve = z.object({ brandId: z.string(), versionId: z.string().optional() });
/**
 * An Agent Skills package describing the brand (SKILL.md plus references/*). Text files only; other files are
 * reported as skipped. The import creates a new draft version carrying the guidelines and the palette read from them.
 */
export const BrandGuidelinesImport = z.object({
  brandId: z.string(),
  /** Any one file may be larger than the cap: the import keeps what fits and reports the rest as skipped. */
  files: z
    .array(z.object({ path: z.string().min(1).max(200), content: z.string().max(512 * 1024) }))
    .min(1)
    .max(100),
});
/**
 * Spec 8.2: onboarding is a brand_onboarding agent run that reads the guidelines imported into a draft (as untrusted
 * evidence) and proposes the draft's voice and vocabulary. The run acts as `servicePrincipalId`; people publish.
 */
export const OnboardingStart = z.object({
  brandId: z.string(),
  /** The draft the guidelines were imported into; the run writes its proposal there and nowhere else. */
  versionId: z.string(),
  servicePrincipalId: z.string(),
  sourceAssetIds: z.array(z.string()).max(50).default([]),
  /** Website captures are not available yet: any URL is refused rather than silently ignored. */
  websiteUrls: z.array(z.string().url().max(1000)).max(10).default([]),
  notes: z.string().max(4000).optional(),
});

/**
 * The voice section an onboarding run proposes (brand.proposeVoice): the document's voice with bounds, since the
 * values come from a model. Every list is bounded so a proposal always fits the editor and the prompt.
 */
export const BrandVoiceProposal = z
  .object({
    summary: z.string().max(2000),
    tone: z.array(z.string().min(1).max(60)).max(12),
    audiences: z
      .array(z.object({ key: z.string().min(1).max(60), description: z.string().max(500) }).strict())
      .max(12),
    preferredTerms: z
      .array(
        z
          .object({ use: z.string().min(1).max(120), avoid: z.array(z.string().min(1).max(120)).max(10) })
          .strict(),
      )
      .max(60),
    prohibitedPhrases: z.array(z.string().min(1).max(200)).max(60),
    locales: z.array(z.string().min(2).max(20)).max(12),
    examples: z
      .array(
        z
          .object({
            text: z.string().min(1).max(1000),
            verdict: z.enum(['on_brand', 'off_brand']),
            note: z.string().max(500),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type BrandVoiceProposal = z.infer<typeof BrandVoiceProposal>;
