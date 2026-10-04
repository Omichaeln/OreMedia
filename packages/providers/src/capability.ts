import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import {
  capabilityNotCertifiedIssue,
  type CapabilityCertificationStatusV1,
  type CertifiableCapability,
  type ChannelVariantInput,
  type ProviderCapabilityV1,
  type ValidationResult,
} from '@oremedia/contracts/providers';

/**
 * Spec 14.6 / 20.2: server-side validation shared by every entry point, driven by the capability register.
 * Pure: no network. The adapter supplies `measureText` so weighted counting stays inside the adapter.
 */
export function validateVariantAgainstCapability(
  cap: ProviderCapabilityV1,
  variant: ChannelVariantInput,
  measure: (text: string) => { length: number; limit: number },
): ValidationResult {
  const issues: ValidationResult['issues'] = [];
  const m = measure(variant.text);
  if (m.length > m.limit) issues.push({ path: 'text', issue: `text_too_long:${m.length}>${m.limit}` });
  if (!cap.text.supportsLinks && /https?:\/\//i.test(variant.text))
    issues.push({ path: 'text', issue: 'links_not_supported' });
  if (!cap.text.supportsMentions && /(^|\s)@\w+/.test(variant.text))
    issues.push({ path: 'text', issue: 'mentions_not_supported' });
  if (!cap.text.supportsHashtags && /(^|\s)#\w+/.test(variant.text))
    issues.push({ path: 'text', issue: 'hashtags_not_supported' });

  const images = variant.media.filter((x) => x.mime.startsWith('image/'));
  const videos = variant.media.filter((x) => x.mime.startsWith('video/'));
  if (images.length && !cap.media.image) issues.push({ path: 'media', issue: 'images_not_supported' });
  if (videos.length && !cap.media.video) issues.push({ path: 'media', issue: 'video_not_supported' });
  if (cap.media.image) {
    if (images.length > cap.media.image.maxCount)
      issues.push({ path: 'media', issue: `too_many_images:${images.length}>${cap.media.image.maxCount}` });
    images.forEach((img, i) => {
      const p = `media.${i}`;
      if (!cap.media.image?.mimes.includes(img.mime))
        issues.push({ path: p, issue: `mime_not_supported:${img.mime}` });
      if (img.width < (cap.media.image?.minWidth ?? 0)) issues.push({ path: p, issue: 'image_too_narrow' });
      if (img.width > (cap.media.image?.maxWidth ?? Infinity))
        issues.push({ path: p, issue: 'image_too_wide' });
      if (img.bytes > (cap.media.image?.maxBytes ?? Infinity))
        issues.push({ path: p, issue: 'image_too_large' });
      const ratio = img.width / img.height;
      const ok = cap.media.image?.aspectRatios.length
        ? cap.media.image.aspectRatios.some((r) => ratio >= r.min - 1e-6 && ratio <= r.max + 1e-6)
        : true;
      if (!ok) issues.push({ path: p, issue: `aspect_ratio_not_supported:${ratio.toFixed(3)}` });
    });
  }
  if (cap.media.video) {
    const limits = cap.media.video;
    videos.forEach((v, i) => {
      const p = `media.${i}`;
      if (!limits.mimes.includes(v.mime)) issues.push({ path: p, issue: `mime_not_supported:${v.mime}` });
      // STU-2a: a video without a measured duration cannot be held to the channel's limit, so it is not passed.
      if (v.durationMs === undefined || v.durationMs <= 0)
        issues.push({ path: p, issue: 'video_duration_unknown' });
      else if (v.durationMs > limits.maxDurationSec * 1000)
        issues.push({
          path: p,
          issue: `video_too_long:${Math.ceil(v.durationMs / 1000)}s>${limits.maxDurationSec}s`,
        });
      if (v.bytes > limits.maxBytes)
        issues.push({ path: p, issue: `video_too_large:${v.bytes}>${limits.maxBytes}` });
    });
  }
  if (images.length > 1) {
    if (!cap.media.carousel) issues.push({ path: 'media', issue: 'carousel_not_supported' });
    else if (images.length < cap.media.carousel.min || images.length > cap.media.carousel.max)
      issues.push({ path: 'media', issue: `carousel_count_out_of_range:${images.length}` });
  }
  if (!cap.media.altText && variant.altTexts.some((a) => a.length > 0))
    issues.push({ path: 'altTexts', issue: 'alt_text_not_supported' });
  if (variant.altTexts.length > variant.media.length)
    issues.push({ path: 'altTexts', issue: 'more_alt_texts_than_media' });
  return { ok: issues.length === 0, issues };
}

/** Default unweighted counting; adapters with weighted rules (e.g. X) override measureText. */
export const plainMeasure = (limit: number) => (text: string) => ({
  length: [...text.normalize('NFC')].length,
  limit,
});

/**
 * PR-06: the refusal the three registries share for a capability the provider supports but nobody certified
 * (CAPABILITY_UNSUPPORTED, like an uncertified provider). A capability the provider does not support passes here:
 * the caller's own support check refuses it with its established code (`edit_not_supported`, ...).
 */
export function assertCapabilityCertified(
  path: string,
  key: string,
  capability: CertifiableCapability,
  statuses: readonly CapabilityCertificationStatusV1[],
): void {
  if (statuses.find((s) => s.capability === capability)?.state === 'uncertified')
    throw new CapabilityUnsupportedError([{ path, issue: capabilityNotCertifiedIssue(key, capability) }]);
}

/**
 * PR-06: the publish capabilities a variant exercises: `publish_image` for images, `publish_video` for a video
 * (both for mixed media), `publish_text` for text alone (the text of a media post rides on the media publish).
 */
export function publishCapabilitiesOf(
  variant: Pick<ChannelVariantInput, 'media'>,
): Array<Extract<CertifiableCapability, 'publish_text' | 'publish_image' | 'publish_video'>> {
  const needed: Array<Extract<CertifiableCapability, 'publish_image' | 'publish_video'>> = [];
  if (variant.media.some((m) => m.mime.startsWith('image/'))) needed.push('publish_image');
  if (variant.media.some((m) => m.mime.startsWith('video/'))) needed.push('publish_video');
  return needed.length > 0 ? needed : ['publish_text'];
}
