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
export const ARTICLE_LIST_ITEMS_MAX = 100;
/**
 * The separators `articlePlainText` (article.ts) adds at most: a blank line between the title, the excerpt and
 * every block, and a line break between a list's items, a FAQ's question and its answer, an image's alt text and
 * its caption, or a quote and its source (RA-08: a rich FAQ answer's own line breaks count as body characters).
 */
const ARTICLE_TEXT_SEPARATORS_MAX =
  2 * (ARTICLE_BLOCKS_MAX + 2) + ARTICLE_BLOCKS_MAX * (ARTICLE_LIST_ITEMS_MAX - 1);
/**
 * RA-03: the one cap for an article's text everywhere it travels as a string (a destination variant's text, a
 * remote edit of a live article): the body cap plus the title, the excerpt and the separators the plain text adds.
 * The body itself stays bounded by ARTICLE_BODY_MAX_CHARS over its blocks.
 */
export const ARTICLE_TEXT_MAX_CHARS =
  ARTICLE_BODY_MAX_CHARS + ARTICLE_TITLE_MAX + ARTICLE_EXCERPT_MAX + ARTICLE_TEXT_SEPARATORS_MAX;
/** A channel (social) variant's caption cap; a destination variant carries the article's text (ARTICLE_TEXT_MAX_CHARS). */
export const CHANNEL_VARIANT_TEXT_MAX_CHARS = 10_000;

// RA-08: the rich blocks (links, images from the asset library, quotes, FAQ answers made of blocks) and the caps
// that bound them. Every addition is optional or a new block type, so a document written before RA-08 parses,
// hashes and renders exactly as it did.
export const ARTICLE_IMAGES_MAX = 20;
export const ARTICLE_IMAGE_ALT_MAX = 1000;
export const ARTICLE_IMAGE_CAPTION_MAX = 500;
export const ARTICLE_LINK_URL_MAX = 2000;
export const ARTICLE_LINK_TEXT_MAX = 300;
export const ARTICLE_QUOTE_MAX = 5000;
export const ARTICLE_QUOTE_CITE_MAX = 300;
export const ARTICLE_FAQ_ANSWER_BLOCKS_MAX = 10;
/** A link an article may carry: an absolute http(s) URL without whitespace or markup characters. */
export const ARTICLE_LINK_PATTERN = /^https?:\/\/[^\s<>"]+$/i;
export const ArticleLinkUrl = z
  .string()
  .max(ARTICLE_LINK_URL_MAX)
  .regex(ARTICLE_LINK_PATTERN, 'an absolute http(s) URL');
/** The asset kinds and (raster) types an article image may be: never an SVG or a video on a website's page (RA-08). */
export const ARTICLE_IMAGE_KINDS = ['photo', 'illustration', 'icon', 'logo'] as const;
export const ARTICLE_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
] as const;
/**
 * BSC-2: types an article may name that are never sent as they are: an SVG (a vector logo, icon or illustration) is
 * released to the site as its PNG rendition, so the page still only carries a raster.
 */
export const ARTICLE_RASTERISED_MIMES = ['image/svg+xml'] as const;
/** Every type an article image may be chosen as: the rasters, and the vectors sent as their PNG rendition. */
export const ARTICLE_IMAGE_SOURCE_MIMES = [...ARTICLE_IMAGE_MIMES, ...ARTICLE_RASTERISED_MIMES] as const;
/** An image from the asset library: the asset version (immutable bytes) and the alt text the page carries. */
export const ArticleImageV1 = z.object({
  assetVersionId: z.string().min(1),
  alt: z.string().max(ARTICLE_IMAGE_ALT_MAX),
});
export type ArticleImageV1 = z.infer<typeof ArticleImageV1>;

const ParagraphBlock = z.object({ type: z.literal('paragraph'), text: z.string().max(10_000) });
const HeadingBlock = z.object({
  type: z.literal('heading'),
  level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  text: z.string().max(300),
});
const ListBlock = z.object({
  type: z.literal('list'),
  ordered: z.boolean().default(false),
  items: z.array(z.string().max(2000)).min(1).max(ARTICLE_LIST_ITEMS_MAX),
});
/** A standalone link: its text (the URL itself when empty) pointing at an absolute http(s) address. */
const LinkBlock = z.object({
  type: z.literal('link'),
  href: ArticleLinkUrl,
  text: z.string().max(ARTICLE_LINK_TEXT_MAX),
});
const QuoteBlock = z.object({
  type: z.literal('quote'),
  text: z.string().max(ARTICLE_QUOTE_MAX),
  cite: z.string().max(ARTICLE_QUOTE_CITE_MAX).optional(),
});
const ImageBlock = ArticleImageV1.extend({
  type: z.literal('image'),
  caption: z.string().max(ARTICLE_IMAGE_CAPTION_MAX).optional(),
});
/** What a FAQ answer may be made of: text blocks only (no images, headings or nested FAQs). */
export const ArticleFaqAnswerBlockV1 = z.discriminatedUnion('type', [
  ParagraphBlock,
  ListBlock,
  LinkBlock,
  QuoteBlock,
]);
export type ArticleFaqAnswerBlockV1 = z.infer<typeof ArticleFaqAnswerBlockV1>;
/**
 * A FAQ entry. `answer` is the plain answer (R2-3); `answerBlocks` (RA-08), when present and not empty, is the rich
 * answer that renders instead of it. A client that writes blocks keeps `answer` as their plain text, so a reader
 * that knows only the plain shape still sees the answer.
 */
const FaqBlock = z.object({
  type: z.literal('faq'),
  question: z.string().max(500),
  answer: z.string().max(5000),
  answerBlocks: z.array(ArticleFaqAnswerBlockV1).max(ARTICLE_FAQ_ANSWER_BLOCKS_MAX).optional(),
});

/** The body is an ordered list of blocks; a FAQ block renders as a question with its answer. */
export const ArticleBlockV1 = z.discriminatedUnion('type', [
  ParagraphBlock,
  HeadingBlock,
  ListBlock,
  FaqBlock,
  LinkBlock,
  QuoteBlock,
  ImageBlock,
]);
export type ArticleBlockV1 = z.infer<typeof ArticleBlockV1>;

/** A FAQ's answer as text: the rich answer's blocks joined by line breaks, else the plain answer. */
export const faqAnswerText = (block: {
  answer: string;
  answerBlocks?: readonly ArticleFaqAnswerBlockV1[];
}) =>
  block.answerBlocks && block.answerBlocks.length > 0
    ? block.answerBlocks.map(articleBlockText).join('\n')
    : block.answer;

/**
 * One block as plain text: a list's items and an image's alt text and caption on their own lines, a FAQ's question
 * above its answer, a link's text (or its address). The lines `articlePlainText` (article.ts) joins.
 */
export function articleBlockText(b: ArticleBlockV1 | ArticleFaqAnswerBlockV1): string {
  switch (b.type) {
    case 'paragraph':
    case 'heading':
      return b.text;
    case 'list':
      return b.items.join('\n');
    case 'faq':
      return `${b.question}\n${faqAnswerText(b)}`;
    case 'link':
      return b.text.trim() === '' ? b.href : b.text;
    case 'quote':
      return b.cite ? `${b.text}\n${b.cite}` : b.text;
    case 'image':
      return [b.alt, b.caption ?? ''].filter((t) => t.trim() !== '').join('\n');
  }
}

/**
 * The characters the body carries over every block (headings, items, questions and answers, link texts, quotes,
 * alt texts and captions included; never a link's address). A rich FAQ answer counts the line breaks between its
 * blocks, so the separators `articlePlainText` adds stay bounded by ARTICLE_TEXT_SEPARATORS_MAX.
 */
export const articleBodyChars = (blocks: readonly ArticleBlockV1[]): number =>
  blocks.reduce((n, b) => {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        return n + b.text.length;
      case 'list':
        return n + b.items.reduce((m, i) => m + i.length, 0);
      case 'faq':
        return n + b.question.length + faqAnswerText(b).length;
      case 'link':
        return n + b.text.length;
      case 'quote':
        return n + b.text.length + (b.cite?.length ?? 0);
      case 'image':
        return n + b.alt.length + (b.caption?.length ?? 0);
    }
  }, 0);

/** The images an article publishes, in order: the featured image first, then every image block. */
export const articleImages = (
  article: Pick<ArticleDocumentV1, 'blocks' | 'featuredImage'>,
): ArticleImageV1[] => [
  ...(article.featuredImage ? [article.featuredImage] : []),
  ...article.blocks.flatMap((b) =>
    b.type === 'image' ? [{ assetVersionId: b.assetVersionId, alt: b.alt }] : [],
  ),
];

/**
 * An article as the website receives it: title, slug, excerpt, the body as blocks, the terms it is filed under and
 * (RA-08) an optional featured image. Rendered to HTML in one place (`article.ts`, allow-listed tags only). `kind`
 * is the discriminator for the document types to come.
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
    /** R2-3's field, never written by a client; kept so a stored document parses. `featuredImage` supersedes it. */
    featuredAssetId: z.string().optional(),
    /**
     * RA-08: the document's version. Absent, the article is a plain one (R2-3: paragraphs, headings, lists and plain
     * FAQs); `2` says the editor that wrote it knew the rich blocks and the featured image.
     */
    v: z.literal(2).optional(),
    /** RA-08: the page's featured image (an asset version with its alt text), sent with the article when it publishes. */
    featuredImage: ArticleImageV1.optional(),
  })
  .superRefine((a, ctx) => {
    const chars = articleBodyChars(a.blocks);
    if (chars > ARTICLE_BODY_MAX_CHARS)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blocks'],
        message: `body_too_long:${chars}>${ARTICLE_BODY_MAX_CHARS}`,
      });
    // A rich FAQ answer's plain text is the blocks' text: a client cannot make the two say different things.
    for (const [i, b] of a.blocks.entries())
      if (b.type === 'faq' && b.answerBlocks && b.answerBlocks.length > 0 && b.answer !== faqAnswerText(b))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', i, 'answer'],
          message: 'faq_answer_mismatch',
        });
    const images = articleImages(a).length;
    if (images > ARTICLE_IMAGES_MAX)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blocks'],
        message: `too_many_images:${images}>${ARTICLE_IMAGES_MAX}`,
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

/**
 * The text cap here is the article's (RA-03): a destination variant's text is the article as plain text, which the
 * website editor re-sends when the publish mode changes. The content service holds a channel variant to
 * CHANNEL_VARIANT_TEXT_MAX_CHARS once it knows the variant's target (the id alone does not say).
 */
export const ChannelVariantUpdate = z.object({
  channelVariantId: z.string(),
  expectedVersion: z.number().int(),
  text: z.string().max(ARTICLE_TEXT_MAX_CHARS),
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
/**
 * G12: changes what create accepts (name, run dates, objective), version-checked. Only the fields sent change;
 * `objectiveId: null` clears the objective. A completed or archived campaign is not edited.
 */
export const CampaignUpdate = z.object({
  campaignId: z.string(),
  expectedVersion: z.number().int(),
  name: CampaignCreate.shape.name.optional(),
  objectiveId: z.string().nullable().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});
/** G12: draft or active → completed (spec 13.1 transition), version-checked and audited; its briefs are untouched. */
export const CampaignClose = z.object({ campaignId: z.string(), expectedVersion: z.number().int() });

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
  /**
   * RA-02 (destination publications only; null for a channel): what the website holds after the write (a draft, the
   * live page, or reverted to a draft since) and whether the read-back and the rendered page proved it.
   */
  remoteStatus: string | null;
  remoteVerification: string | null;
}

/** A content revision's brand-review class (spec 13.4 mandate_content_class, 8.1 requireReviewForContentClasses). */
export const ContentClass = z.enum(['general', 'offer']);
export type ContentClass = z.infer<typeof ContentClass>;
