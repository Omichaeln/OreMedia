import { z } from 'zod';

export const CampaignState = z.enum(['draft', 'active', 'completed', 'archived']);
export const BriefState = z.enum(['draft', 'accepted', 'in_progress', 'delivered', 'cancelled']);
export const ContentPackageState = z.enum([
  'draft',
  'in_review',
  'approved',
  'scheduled',
  'published',
  'archived',
]);

// ---- Website articles and FAQs (ledger R2-3, D-16): a structured document type beside the master copy ----

export const ARTICLE_TITLE_MAX = 200;
export const ARTICLE_SLUG_MAX = 200;
/** Lower-case words joined by single hyphens, as a CMS slugs a path segment. */
export const ARTICLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ARTICLE_EXCERPT_MAX = 1000;
export const ARTICLE_BLOCKS_MAX = 500;
/** The body's text over every block, before rendering (the CMS stores the rendered HTML). */
export const ARTICLE_BODY_MAX_CHARS = 50_000;
export const ARTICLE_TERM_MAX = 100;
export const ARTICLE_TERMS_MAX = 20;

/** The body is an ordered list of blocks; a FAQ block renders as a question with its answer. */
export const ArticleBlockV1 = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string().max(10_000) }),
  z.object({
    type: z.literal('heading'),
    level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    text: z.string().max(300),
  }),
  z.object({
    type: z.literal('list'),
    ordered: z.boolean().default(false),
    items: z.array(z.string().max(2000)).min(1).max(100),
  }),
  z.object({ type: z.literal('faq'), question: z.string().max(500), answer: z.string().max(5000) }),
]);
export type ArticleBlockV1 = z.infer<typeof ArticleBlockV1>;

/** The characters the body carries over every block (headings, items, questions and answers included). */
export const articleBodyChars = (blocks: readonly ArticleBlockV1[]): number =>
  blocks.reduce((n, b) => {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        return n + b.text.length;
      case 'list':
        return n + b.items.reduce((m, i) => m + i.length, 0);
      case 'faq':
        return n + b.question.length + b.answer.length;
    }
  }, 0);

/**
 * An article as the website receives it: title, slug, excerpt, the body as blocks, the terms it is filed under and
 * an optional featured asset. Rendered to HTML in one place (`article.ts`, allow-listed tags only). `kind` is the
 * discriminator for the document types to come.
 */
export const ArticleDocumentV1 = z
  .object({
    kind: z.literal('article'),
    title: z.string().min(1).max(ARTICLE_TITLE_MAX),
    slug: z
      .string()
      .min(1)
      .max(ARTICLE_SLUG_MAX)
      .regex(ARTICLE_SLUG_PATTERN, 'lower-case words joined by hyphens'),
    excerpt: z.string().max(ARTICLE_EXCERPT_MAX).default(''),
    blocks: z.array(ArticleBlockV1).max(ARTICLE_BLOCKS_MAX),
    categories: z.array(z.string().min(1).max(ARTICLE_TERM_MAX)).max(ARTICLE_TERMS_MAX).default([]),
    tags: z.array(z.string().min(1).max(ARTICLE_TERM_MAX)).max(ARTICLE_TERMS_MAX).default([]),
    featuredAssetId: z.string().optional(),
  })
  .superRefine((a, ctx) => {
    const chars = articleBodyChars(a.blocks);
    if (chars > ARTICLE_BODY_MAX_CHARS)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blocks'],
        message: `body_too_long:${chars}>${ARTICLE_BODY_MAX_CHARS}`,
      });
  });
export type ArticleDocumentV1 = z.infer<typeof ArticleDocumentV1>;

/**
 * The master copy of a content revision. `article` (R2-3) is additive: a document without it is the plain text
 * every channel variant is generated from, parsed and hashed exactly as before; with it the package is a website
 * article whose channel variants carry the excerpt (or the master text) and whose destination variant carries the
 * rendered article.
 */
export const CopyDocumentV1 = z.object({
  schemaVersion: z.literal(1),
  master: z.object({ text: z.string().max(10000), factRefs: z.array(z.string()).default([]) }),
  rationale: z.string().max(2000).optional(),
  article: ArticleDocumentV1.optional(),
});
export type CopyDocumentV1 = z.infer<typeof CopyDocumentV1>;

/** What a copy document is: `article` when it carries one, else the plain `text` master. */
export type CopyDocumentKind = 'text' | 'article';
export const copyDocumentKind = (copy: Pick<CopyDocumentV1, 'article'>): CopyDocumentKind =>
  copy.article ? 'article' : 'text';

export const BriefCreate = z.object({
  brandId: z.string(),
  campaignId: z.string().optional(),
  audience: z.string().max(1000),
  message: z.string().max(2000),
  offerFactIds: z.array(z.string()).max(20).default([]),
  channelConnectionIds: z.array(z.string()).max(20).default([]),
  constraints: z.array(z.string().max(300)).max(20).default([]),
  /** Spec 16.4: a brief created by accepting a recommendation carries the back-reference for the learning record. */
  recommendationId: z.string().optional(),
});

export const CampaignCreate = z.object({
  brandId: z.string(),
  objectiveId: z.string().optional(),
  name: z.string().min(1).max(200),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

export const ChannelVariantUpdate = z.object({
  channelVariantId: z.string(),
  expectedVersion: z.number().int(),
  text: z.string().max(10000),
  altTexts: z.array(z.string().max(1000)).max(20),
  settings: z.record(z.unknown()),
  exportIds: z.array(z.string()).max(20),
});

export const CreativeAttributeSource = z.enum(['captured', 'human_corrected', 'inferred']);
export const ImageryKind = z.enum(['people', 'product', 'illustration', 'photography', 'none']);

export const CreativeAttributesV1 = z.object({
  hookType: z.string().max(80).optional(),
  topic: z.string().max(120).optional(),
  message: z.string().max(300).optional(),
  offerFactId: z.string().optional(),
  cta: z.string().max(120).optional(),
  templateVersionId: z.string().optional(),
  layoutKey: z.string().max(80).optional(),
  colourTreatment: z.string().max(80).optional(),
  typographyRoles: z.array(z.string()).optional(),
  imageryKind: ImageryKind.optional(),
  videoOpening: z.string().max(120).optional(),
  durationMs: z.number().int().optional(),
  subtitles: z.boolean().optional(),
  pacing: z.string().max(40).optional(),
  distribution: z.string().max(40).optional(),
});
export type CreativeAttributesV1 = z.infer<typeof CreativeAttributesV1>;

// ---------------------------------------------------------------------------------------------------------------
// Phase 5 content module (spec 7.5 `content` router, 6.3 content tables). Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PageRequest } from './pagination';

export const CampaignList = z.object({ brandId: z.string(), page: PageRequest });
export const CampaignGet = z.object({ campaignId: z.string() });

export const BriefList = z.object({
  brandId: z.string(),
  campaignId: z.string().optional(),
  page: PageRequest,
});
export const BriefGet = z.object({ briefId: z.string() });
export const BriefAccept = z.object({ briefId: z.string(), expectedVersion: z.number().int() });

// ---- plan items (UX-09): the calendar behind a brief, materialised as packages on acceptance ----

export const PlanItemState = z.enum(['proposed', 'dropped', 'materialised']);
export type PlanItemState = z.infer<typeof PlanItemState>;
/** One planned post: a calendar date (brand zone), the channel key the planner named, a theme and a format. */
export const PlanItemInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  channelKey: z.string().min(1).max(60),
  /** A connection of the brand; when omitted it is resolved from the brief's channels by provider key. */
  channelConnectionId: z.string().optional(),
  theme: z.string().min(1).max(300),
  formatKey: z.string().min(1).max(60),
  factIds: z.array(z.string()).max(20).default([]),
});
export const PlanItemsPropose = z.object({
  briefId: z.string(),
  items: z.array(PlanItemInput).min(1).max(100),
});
export const PlanItemList = z.object({ briefId: z.string() });
export const PlanItemUpdate = z.object({
  planItemId: z.string(),
  expectedVersion: z.number().int(),
  date: PlanItemInput.shape.date.optional(),
  /** `null` leaves the item without a connection until a person assigns one. */
  channelConnectionId: z.string().nullable().optional(),
  theme: PlanItemInput.shape.theme.optional(),
  formatKey: PlanItemInput.shape.formatKey.optional(),
  factIds: z.array(z.string()).max(20).optional(),
});
export const PlanItemDrop = z.object({ planItemId: z.string(), expectedVersion: z.number().int() });
export const PlanItemRestore = PlanItemDrop;

/**
 * A package is born with content revision 1: the master copy (spec 6.3 content_revisions.copy) and the creative
 * documents it publishes with. The revision pins those documents' *current* creative revisions and the brand's
 * published version and active policy version at creation time.
 */
export const ContentPackageCreate = z.object({
  brandId: z.string(),
  briefId: z.string().optional(),
  title: z.string().min(1).max(200),
  copy: CopyDocumentV1,
  creativeDocumentIds: z.array(z.string()).max(20).default([]),
});
/**
 * A revision is never edited: revising creates content revision n+1 and supersedes the current one (spec 13.1).
 * `creativeDocumentIds` omitted keeps the documents the current revision publishes with (re-pinned at their current
 * creative revisions, as re-submitting them would); `[]` removes every creative; a list replaces the selection. A
 * client that only changes copy therefore never detaches the creative by accident.
 */
export const ContentPackageRevise = z.object({
  contentPackageId: z.string(),
  expectedVersion: z.number().int(),
  copy: CopyDocumentV1,
  creativeDocumentIds: z.array(z.string()).max(20).optional(),
  summary: z.string().max(500).optional(),
});
export const ContentPackageGet = z.object({ contentPackageId: z.string() });
export const ContentPackageList = z.object({ brandId: z.string(), page: PageRequest });
/**
 * The live packages whose current revision pins a creative document (the studio's way into review, UX-01). The set
 * is bounded by the brand's live revisions (as listReferencingCreativeDocument), so it is not paged.
 */
export const ContentPackageListForDocument = z.object({ documentId: z.string() });
export const ContentRevisionGet = z.object({ revisionId: z.string() });

/**
 * One variant per (content revision, target); existing targets are returned, never duplicated. A target is a channel
 * connection or (R2-3) a write-capable brand destination (a website); at least one of either is named.
 */
export const ChannelVariantGenerate = z
  .object({
    contentRevisionId: z.string(),
    channelConnectionIds: z.array(z.string()).max(20).default([]),
    destinationIds: z.array(z.string()).max(20).default([]),
  })
  .refine((v) => v.channelConnectionIds.length + v.destinationIds.length > 0, {
    path: ['channelConnectionIds'],
    message: 'at least one channel or destination',
  });
export const ChannelVariantGet = z.object({ variantId: z.string() });

export const CalendarRange = z.object({
  brandId: z.string(),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

/** What a calendar shows for a publication; supplied by the publishing module through the content module's calendar source hook. */
export interface CalendarPublication {
  publicationId: string;
  contentPackageId: string;
  contentRevisionId: string;
  channelVariantId: string;
  /** The channel, or null for a publication to a brand destination (R2-3). */
  channelConnectionId: string | null;
  /** The brand destination (a website), or null for a channel publication. */
  destinationId: string | null;
  scheduledFor: string;
  state: string;
}

/** A content revision's brand-review class (spec 13.4 mandate_content_class, 8.1 requireReviewForContentClasses). */
export const ContentClass = z.enum(['general', 'offer']);
export type ContentClass = z.infer<typeof ContentClass>;
