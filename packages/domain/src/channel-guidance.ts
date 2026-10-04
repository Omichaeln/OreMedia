import {
  CHANNEL_GUIDANCE_FIELDS,
  channelOverride,
  type BrandSystemDocumentV1,
  type ChannelGuidanceField,
  type CopyContentType,
  type CopyTemplate,
} from '@oremedia/contracts/brand';
import type { ContentType } from '@oremedia/contracts/creative';

type ChannelExample = NonNullable<BrandSystemDocumentV1['channelGuidance'][number]['examples']>[number];

/** The guidance that applies on one channel: the brand's channel baseline overlaid by that channel's entry. */
export interface EffectiveChannelGuidance {
  providerKey: string;
  /** False when the document has no entry for the channel: only the baseline applies. */
  hasEntry: boolean;
  /** The value in force for each baseline field; a field neither sets is absent. */
  fields: Partial<Record<ChannelGuidanceField, string>>;
  /** Fields whose value comes from the baseline (the channel does not set them), in field order. */
  inherited: ChannelGuidanceField[];
  /** Fields the channel sets itself, in field order. */
  overridden: ChannelGuidanceField[];
  preferredFormats: string[];
  formats?: string;
  audience?: string;
  examples: ChannelExample[];
}

const filled = (value: string | undefined): string | undefined => (value?.trim() ? value : undefined);

/**
 * BSC-1: the effective channel guidance for `providerKey`. A channel entry overrides a baseline field by setting it
 * (its `captionStyle` and `ctaConventions` are its tone adaptation and CTA); a blank or absent value inherits the
 * baseline. Pure and deterministic: fields are reported in CHANNEL_GUIDANCE_FIELDS order. Brand preference only:
 * the provider's capability limits are not part of it and win wherever they conflict.
 */
export function effectiveChannelGuidance(
  document: BrandSystemDocumentV1,
  providerKey: string,
): EffectiveChannelGuidance {
  const entry = document.channelGuidance.find((c) => c.providerKey === providerKey);
  const baseline = document.channelBaseline ?? {};
  const fields: EffectiveChannelGuidance['fields'] = {};
  const inherited: ChannelGuidanceField[] = [];
  const overridden: ChannelGuidanceField[] = [];
  for (const field of CHANNEL_GUIDANCE_FIELDS) {
    const own = entry ? channelOverride(entry, field) : undefined;
    const base = filled(baseline[field]);
    if (own !== undefined) {
      fields[field] = own;
      overridden.push(field);
    } else if (base !== undefined) {
      fields[field] = base;
      inherited.push(field);
    }
  }
  const formats = filled(entry?.formats);
  const audience = filled(entry?.audience);
  return {
    providerKey,
    hasEntry: entry !== undefined,
    fields,
    inherited,
    overridden,
    preferredFormats: entry?.preferredFormats ?? [],
    ...(formats !== undefined ? { formats } : {}),
    ...(audience !== undefined ? { audience } : {}),
    examples: entry?.examples ?? [],
  };
}

/** What a run or a generation is for, as the brand guidance is selected by it. */
export interface GuidanceTarget {
  channelKey?: string;
  contentType?: string;
  templateKey?: string;
}

const MAX_TEMPLATES = 3;

/**
 * BSC-1: the copy templates that fit: the one the target names, else those for its content type and channel (a
 * template without channels fits every channel), at most three. Shared by the prompt and the studio's generate panel.
 */
export function matchingCopyTemplates(
  templates: readonly CopyTemplate[],
  target: GuidanceTarget,
): CopyTemplate[] {
  if (target.templateKey) return templates.filter((t) => t.key === target.templateKey).slice(0, 1);
  if (!target.contentType && !target.channelKey) return [];
  return templates
    .filter((t) => !target.contentType || t.contentType === target.contentType)
    .filter(
      (t) => !target.channelKey || t.channelKeys.length === 0 || t.channelKeys.includes(target.channelKey),
    )
    .slice(0, MAX_TEMPLATES);
}

/** STU-1b: the copy content type a graphic content type is written as (null: no copy template applies). */
export function copyContentTypeFor(contentType: ContentType | undefined): CopyContentType | null {
  switch (contentType) {
    case 'social_post':
    case 'carousel':
    case 'story':
      return 'social_post';
    case 'thumbnail_banner':
      return 'ad';
    default:
      return null;
  }
}
