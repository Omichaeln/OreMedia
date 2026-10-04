import type { z } from 'zod';
import { CreativeAttributesV1, type CopyDocumentV1 } from '@oremedia/contracts/content';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { isVideoProject } from '@oremedia/contracts/video';
import { NotFoundError, ValidationFailedError } from '@oremedia/contracts/errors';
import {
  COMPARISON_MINIMUM_SAMPLE,
  CreativeAttributesAggregate,
  CreativeAttributesCorrect,
  CreativeAttributesGet,
} from '@oremedia/contracts/measurement';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { CreativeAttributeRepository, type AttributeCaptureInput } from '@oremedia/module-content';
import { CreativeRevisionRepository } from '@oremedia/module-creative';
import { audit } from '@oremedia/module-operations';
import { assertBrandExists, releasedPublications } from './hooks';
import { metricService } from './metrics';

/**
 * Spec 16.2: creative attributes are captured at creation from the structured inputs (the copy document and the
 * creative documents' element semantics), never reconstructed from flattened images. Humans may correct any
 * attribute; `source` then reads human_corrected.
 */
const attributesRepo = new CreativeAttributeRepository();
const creativeRevisionsRepo = new CreativeRevisionRepository();

const CTA_PATTERN =
  /\b(shop|buy|learn more|sign up|register|book|download|subscribe|get started|try|discover|visit|order|join|apply|call|contact|claim|explore|read more|see more|watch)\b/i;

/** Copy features from the master text: hook type, topic, message, offer fact and call to action. */
export function copyFeatures(copy: CopyDocumentV1): CreativeAttributesV1 {
  const text = copy.master.text.trim();
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = sentences[0] ?? text;
  const hookType = !first
    ? undefined
    : first.endsWith('?')
      ? 'question'
      : /^\d/.test(first)
        ? 'number'
        : /!$/.test(first)
          ? 'exclamation'
          : /^(you|your)\b/i.test(first)
            ? 'direct_address'
            : 'statement';
  const hashtag = text.match(/#([\p{L}\p{N}_]+)/u)?.[1];
  const topic = hashtag ?? first.split(/\s+/).slice(0, 6).join(' ');
  const ctaSentence = [...sentences].reverse().find((s) => CTA_PATTERN.test(s));
  const out: CreativeAttributesV1 = {};
  if (hookType) out.hookType = hookType;
  if (topic) out.topic = topic.slice(0, 120);
  if (first) out.message = first.slice(0, 300);
  if (copy.master.factRefs[0]) out.offerFactId = copy.master.factRefs[0];
  if (ctaSentence) out.cta = ctaSentence.slice(0, 120);
  return out;
}

type Element = CreativeDocumentV1['pages'][number]['elements'][number];

function flatten(elements: Element[]): Element[] {
  const out: Element[] = [];
  for (const e of elements) {
    out.push(e);
    if (e.type === 'group') out.push(...flatten(e.children as Element[]));
  }
  return out;
}

/** Layout features from a creative document's element semantic roles and kinds (spec 16.2, 11.2). */
export function layoutFeatures(doc: CreativeDocumentV1): CreativeAttributesV1 {
  const elements = flatten(doc.pages.flatMap((p) => p.elements as Element[]));
  const roles = [
    ...new Set(elements.flatMap((e) => (e.semanticRole ? [String(e.semanticRole)] : []))),
  ].sort();
  const texts = elements.filter((e): e is Extract<Element, { type: 'text' }> => e.type === 'text');
  const typographyRoles = [...new Set(texts.map((t) => t.style.typeRole))].sort();
  const tokenised = texts.filter((t) => t.style.colourToken).length;
  const raw = texts.filter((t) => !t.style.colourToken && t.style.colourValue).length;
  const images = elements.filter((e) => e.type === 'image');
  const imageryKind =
    images.length === 0
      ? 'none'
      : images.some((e) => e.semanticRole === 'product')
        ? 'product'
        : /illustration/i.test(images.map((e) => e.name).join(' '))
          ? 'illustration'
          : /people|person|team|portrait/i.test(images.map((e) => e.name).join(' '))
            ? 'people'
            : 'photography';
  const out: CreativeAttributesV1 = {
    layoutKey: roles.length ? roles.join('+') : 'unlabelled',
    colourTreatment: texts.length === 0 ? 'none' : raw === 0 ? 'tokens' : tokenised === 0 ? 'raw' : 'mixed',
    typographyRoles,
    imageryKind,
  };
  if (doc.templateVersionId) out.templateVersionId = doc.templateVersionId;
  return out;
}

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};

export const toAttributesDto = (a: Awaited<ReturnType<CreativeAttributeRepository['getById']>>) => ({
  id: a.id,
  brandId: a.brandId,
  contentRevisionId: a.contentRevisionId,
  channelVariantId: a.channelVariantId,
  attributes: a.attributes,
  source: a.source,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
  version: a.version,
});

export interface AttributeFeatureAggregate {
  feature: string;
  value: string;
  publications: number;
  engagement: number;
  impressions: number;
  rate: number | null;
  sufficient: boolean;
}

/** The attribute values a post is grouped by: the captured scalars, and whether a call to action was present. */
const AGGREGATED_FEATURES = [
  'hookType',
  'imageryKind',
  'layoutKey',
  'colourTreatment',
  'templateVersionId',
  'distribution',
  'pacing',
] as const;
function featureValues(attributes: CreativeAttributesV1): Array<[feature: string, value: string]> {
  const out: Array<[string, string]> = [];
  for (const feature of AGGREGATED_FEATURES) {
    const v = attributes[feature];
    if (typeof v === 'string' && v) out.push([feature, v]);
  }
  out.push(['cta', attributes.cta ? 'present' : 'absent']);
  if (attributes.subtitles !== undefined) out.push(['subtitles', attributes.subtitles ? 'yes' : 'no']);
  return out;
}

export const attributeService = {
  /**
   * The content module's AttributeCapturer (registered by the composition root): runs inside the revision's
   * transaction. Copy features come from the copy document, layout features from the first pinned creative
   * revision's snapshot; `distribution` records who authored the revision (user editor or agent skill).
   */
  async capture(input: AttributeCaptureInput, tx: Tx): Promise<string> {
    let attributes: CreativeAttributesV1 = { ...copyFeatures(input.copy), distribution: input.authorKind };
    const firstCreative = input.creativeRevisionIds[0];
    if (firstCreative) {
      const revision = await creativeRevisionsRepo.getById(firstCreative, tx);
      // Layout features describe graphic pages; a video's timeline (STU-2b) contributes none yet.
      if (!isVideoProject(revision.snapshot))
        attributes = { ...attributes, ...layoutFeatures(revision.snapshot as CreativeDocumentV1) };
    }
    const id = newId('creativeAttributes');
    await attributesRepo.create(
      {
        id,
        brandId: input.brandId,
        contentRevisionId: input.contentRevisionId,
        channelVariantId: null,
        attributes: CreativeAttributesV1.parse(attributes),
        source: 'captured',
      },
      tx,
    );
    return id;
  },

  /**
   * UX-12 "what the creative did": for the brand's released publications in the window, the pooled engagement
   * rate (Σ engagement ÷ Σ impressions, D-15) of the posts sharing each captured attribute value, beside the
   * brand's own pooled rate; a value below the minimum sample is listed but marked insufficient. Attributes are
   * the captured ones (spec 16.2), never reconstructed, and every released publication of the window counts (the
   * outcomes are read in query-sized chunks). insight.read on the brand; a foreign brand is NOT_FOUND.
   */
  async aggregate(actor: ResolvedActor, input: z.infer<typeof CreativeAttributesAggregate>, tx?: Tx) {
    const parsed = CreativeAttributesAggregate.parse(input);
    await assertBrandExists(parsed.brandId, tx);
    await policy.assert(actor, 'insight.read', brandResource(parsed.brandId), {}, tx);
    const windowStart = new Date(parsed.windowStart);
    const windowEnd = new Date(parsed.windowEnd);
    const publications = await releasedPublications(parsed.brandId, windowStart, windowEnd, tx);
    const empty = {
      brandId: parsed.brandId,
      windowStart: parsed.windowStart,
      windowEnd: parsed.windowEnd,
      publications: publications.length,
      withAttributes: 0,
      withNumbers: 0,
      minimum: COMPARISON_MINIMUM_SAMPLE,
      brand: { publications: 0, engagement: 0, impressions: 0, rate: null as number | null },
      features: [] as AttributeFeatureAggregate[],
    };
    if (publications.length === 0) return empty;
    const rows = await attributesRepo.listForRevisions(
      parsed.brandId,
      publications.map((p) => p.contentRevisionId),
      tx,
    );
    const byRevision = new Map(rows.map((r) => [r.contentRevisionId, r.attributes]));
    const outcomes = await metricService.brandOutcomes(
      actor,
      parsed.brandId,
      publications.map((p) => p.publicationId),
      windowStart,
      windowEnd,
      tx,
    );
    const brand = { publications: 0, engagement: 0, impressions: 0 };
    const cells = new Map<string, AttributeFeatureAggregate>();
    for (const p of publications) {
      const outcome = outcomes.get(p.publicationId);
      if (!outcome) continue;
      brand.publications += 1;
      brand.engagement += outcome.engagement;
      brand.impressions += outcome.impressions;
      const attributes = byRevision.get(p.contentRevisionId);
      if (!attributes) continue;
      for (const [feature, value] of featureValues(attributes)) {
        const key = `${feature}\u0000${value}`;
        const cell = cells.get(key) ?? {
          feature,
          value,
          publications: 0,
          engagement: 0,
          impressions: 0,
          rate: null,
          sufficient: false,
        };
        cell.publications += 1;
        cell.engagement += outcome.engagement;
        cell.impressions += outcome.impressions;
        cells.set(key, cell);
      }
    }
    const features = [...cells.values()]
      .map((c) => ({
        ...c,
        rate: c.impressions > 0 ? c.engagement / c.impressions : null,
        sufficient: c.publications >= COMPARISON_MINIMUM_SAMPLE,
      }))
      .sort((a, b) => a.feature.localeCompare(b.feature) || b.publications - a.publications);
    return {
      ...empty,
      withAttributes: publications.filter((p) => byRevision.has(p.contentRevisionId)).length,
      withNumbers: brand.publications,
      brand: { ...brand, rate: brand.impressions > 0 ? brand.engagement / brand.impressions : null },
      features,
    };
  },

  /** insight.read on the brand of the attributes row; a foreign id is NOT_FOUND. */
  async get(actor: ResolvedActor, input: z.infer<typeof CreativeAttributesGet>, tx?: Tx) {
    const parsed = CreativeAttributesGet.parse(input);
    const row = parsed.attributeId
      ? await attributesRepo.getById(parsed.attributeId, tx)
      : parsed.contentRevisionId
        ? await attributesRepo.findForRevision(parsed.contentRevisionId, tx)
        : parsed.channelVariantId
          ? await attributesRepo.findForVariant(parsed.channelVariantId, tx)
          : null;
    if (!parsed.attributeId && !parsed.contentRevisionId && !parsed.channelVariantId)
      throw new ValidationFailedError([
        { path: 'attributeId', issue: 'one_of_attributeId_contentRevisionId_channelVariantId' },
      ]);
    if (!row)
      throw new NotFoundError(
        'CreativeAttributes',
        parsed.attributeId ?? parsed.contentRevisionId ?? parsed.channelVariantId ?? '',
      );
    await policy.assert(actor, 'insight.read', brandResource(row.brandId), {}, tx);
    return toAttributesDto(row);
  },

  /** content.edit on the brand: merges the correction and records the human source (spec 16.2). */
  async correct(actor: ResolvedActor, input: z.infer<typeof CreativeAttributesCorrect>, tx: Tx) {
    const parsed = CreativeAttributesCorrect.parse(input);
    const row = await attributesRepo.getById(parsed.attributeId, tx);
    await policy.assert(actor, 'content.edit', brandResource(row.brandId), {}, tx);
    const attributes = CreativeAttributesV1.parse({ ...row.attributes, ...parsed.attributes });
    await attributesRepo.update(
      row.id,
      parsed.expectedVersion,
      { attributes, source: 'human_corrected' },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'measurement.attributes.correct',
      { type: 'creative_attributes', id: row.id },
      'allowed',
      tx,
      { brandId: row.brandId, fields: Object.keys(parsed.attributes) },
    );
    return toAttributesDto(await attributesRepo.getById(row.id, tx));
  },
};
