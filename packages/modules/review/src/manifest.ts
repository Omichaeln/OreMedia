import { bindingTargetId } from '@oremedia/contracts/approval';
import type { FrozenManifestV1, ManifestChange } from '@oremedia/contracts/review';
import { hashCanonical } from '@oremedia/domain/hash';

/**
 * RA-09 roll-forward: a request frozen before RA-09 carries no rendered hash, document or websites. The live
 * manifest is compared in the frozen one's shape (those parts left out when the frozen manifest lacks them), so an
 * open request from before the deploy is still decidable; one frozen since is compared whole.
 */
export function comparableManifest(live: FrozenManifestV1, frozen: FrozenManifestV1): FrozenManifestV1 {
  const out: FrozenManifestV1 = { ...live };
  if (frozen.websites === undefined) delete out.websites;
  if (live.article && frozen.article) {
    const article = { ...live.article };
    if (frozen.article.renderedHtmlHash === undefined) delete article.renderedHtmlHash;
    if (frozen.article.images === undefined) delete article.images;
    if (frozen.article.document === undefined) delete article.document;
    out.article = article;
  }
  return out;
}

/** RA-09: what differs between a frozen manifest and the live one (the frozen shape), part by part. */
export function manifestChanges(frozen: FrozenManifestV1, live: FrozenManifestV1): ManifestChange[] {
  const same = (a: unknown, b: unknown) => hashCanonical(a ?? null) === hashCanonical(b ?? null);
  const changes: ManifestChange[] = [];
  if (!same(frozen.article?.articleHash, live.article?.articleHash)) changes.push('article');
  if (!same(frozen.article?.renderedHtmlHash, live.article?.renderedHtmlHash)) changes.push('rendering');
  const byTarget = (m: FrozenManifestV1) => new Map(m.captions.map((c) => [bindingTargetId(c), c] as const));
  const f = byTarget(frozen);
  const l = byTarget(live);
  if (!same([...f.keys()].sort(), [...l.keys()].sort())) changes.push('targets');
  for (const [id, caption] of f) {
    const current = l.get(id);
    if (!current) continue;
    if (!same(caption.text, current.text) || !same(caption.altTexts, current.altTexts)) {
      if (!changes.includes('captions')) changes.push('captions');
    }
    if (caption.settingsHash !== current.settingsHash && !changes.includes('settings'))
      changes.push('settings');
  }
  if (!same(frozen.exports, live.exports)) changes.push('exports');
  if (!same(frozen.websites, live.websites)) changes.push('websites');
  if (frozen.brandVersionId !== live.brandVersionId || frozen.policyVersionId !== live.policyVersionId)
    changes.push('brand');
  return changes;
}
