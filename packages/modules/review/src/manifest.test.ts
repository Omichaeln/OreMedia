import { describe, expect, it } from 'vitest';
import type { FrozenManifestV1 } from '@oremedia/contracts/review';
import { hashCanonical } from '@oremedia/domain/hash';
import { comparableManifest, manifestChanges } from './manifest';

const article = {
  kind: 'article' as const,
  title: 'T',
  slug: 't',
  excerpt: '',
  blocks: [{ type: 'paragraph' as const, text: 'p' }],
  categories: [],
  tags: [],
};
const base: FrozenManifestV1 = {
  v: 1,
  contentRevisionId: 'cr_1',
  contentHash: 'c'.repeat(64),
  creativeRevisionIds: [],
  exports: [],
  captions: [
    { destinationId: 'dst_1', text: 'T\n\np', altTexts: [], settingsHash: 's'.repeat(64) },
    { channelConnectionId: 'cc_1', text: 'caption', altTexts: ['alt'], settingsHash: 'x'.repeat(64) },
  ],
  timing: { kind: 'exact', at: '2026-10-02T10:00:00.000Z' },
  brandVersionId: 'bv_1',
  policyVersionId: 'pv_1',
  article: {
    title: 'T',
    slug: 't',
    articleHash: 'a'.repeat(64),
    blocks: 1,
    renderedHtmlHash: 'r'.repeat(64),
    images: 0,
    document: article,
  },
  websites: [
    {
      destinationId: 'dst_1',
      kind: 'cms_site',
      displayName: 'blog.acme.example',
      siteUrl: 'https://blog.acme.example',
      path: '/t',
      publishMode: 'draft',
    },
  ],
};

describe('frozen manifests (RA-09)', () => {
  it('a manifest frozen before RA-09 is compared without the fields it never had, one frozen since whole', () => {
    const { websites: _w, ...rest } = base;
    const old: FrozenManifestV1 = {
      ...rest,
      article: { title: 'T', slug: 't', articleHash: 'a'.repeat(64), blocks: 1 },
    };
    expect(comparableManifest(base, old)).toEqual(old);
    expect(hashCanonical(comparableManifest(base, old))).toBe(hashCanonical(old));
    expect(comparableManifest(base, base)).toEqual(base);
    expect(manifestChanges(old, comparableManifest(base, old))).toEqual([]);
  });

  it('names what changed: the document, its rendering, a caption, settings, exports, targets, websites, brand', () => {
    expect(manifestChanges(base, base)).toEqual([]);
    const live = (over: Partial<FrozenManifestV1>): FrozenManifestV1 => ({ ...base, ...over });
    expect(
      manifestChanges(base, live({ article: { ...base.article!, articleHash: 'b'.repeat(64) } })),
    ).toEqual(['article']);
    expect(
      manifestChanges(base, live({ article: { ...base.article!, renderedHtmlHash: 'q'.repeat(64) } })),
    ).toEqual(['rendering']);
    expect(
      manifestChanges(
        base,
        live({
          captions: [
            { destinationId: 'dst_1', text: 'T\n\np', altTexts: [], settingsHash: 'z'.repeat(64) },
            base.captions[1]!,
          ],
          websites: [{ ...base.websites![0]!, publishMode: 'publish' }],
        }),
      ),
    ).toEqual(['settings', 'websites']);
    expect(
      manifestChanges(
        base,
        live({ captions: [base.captions[0]!, { ...base.captions[1]!, text: 'edited', altTexts: ['alt'] }] }),
      ),
    ).toEqual(['captions']);
    expect(
      manifestChanges(
        base,
        live({ exports: [{ exportId: 'e', contentHash: 'h'.repeat(64), channelConnectionId: 'cc_1' }] }),
      ),
    ).toEqual(['exports']);
    expect(manifestChanges(base, live({ captions: [base.captions[0]!] }))).toEqual(['targets']);
    expect(manifestChanges(base, live({ brandVersionId: 'bv_2' }))).toEqual(['brand']);
  });
});
