import { describe, expect, it } from 'vitest';
import type { CreativeDocumentV1, Element, Operation } from '@oremedia/contracts/creative';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { GenerationRequest, type ModelFill } from '@oremedia/contracts/generation';
import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import { hashCanonical } from '@oremedia/domain/hash';
import { eid, fixtureSnapshot } from './fixtures';
import {
  compileFill,
  generationSlots,
  groupOperations,
  operationsOfGroups,
  preflightGeneration,
  structureFor,
  type CompileContext,
  type PreflightInput,
} from './generation';
import { guardScope, scopeState } from './guard';
import { applyBatch, findElement } from './reduce';
import { instantiateStarter, starterByKey, type StarterBrand } from './starters';

const brand = (): StarterBrand => {
  const snapshot = fixtureSnapshot();
  return {
    brandVersionId: snapshot.brandVersionId,
    colours: snapshot.document.tokens.colours,
    typeRoles: snapshot.document.tokens.typeRoles.map((t) => ({
      role: t.role,
      fontAssetVersionId: 'av_font',
      weight: t.weight,
      minSizePx: t.minSizePx,
    })),
    logos: [
      {
        variant: 'primary',
        assetVersionId: 'av_logo',
        aspect: 10 / 3,
        minWidthPx: 120,
        allowedBackgroundColourKeys: ['paper'],
      },
    ],
  };
};

/** The photo feature starter: background, image area, headline (60), body (120) and a logo. */
const photoFeature = () => instantiateStarter(starterByKey('post-photo-feature')!, brand());
const byName = (doc: CreativeDocumentV1, name: string, page = 0): Element =>
  doc.pages[page]!.elements.find((e) => e.name === name || e.name.startsWith(name))!;

let counter = 0;
const newId = () => eid(`01HNEW${String(++counter).padStart(4, '0')}`);

const contextFor = (doc: CreativeDocumentV1, over: Partial<CompileContext> = {}): CompileContext => {
  const page = doc.pages[0]!;
  return {
    variation: 0,
    targetPageIds: [page.id],
    scope: null,
    createdPageIds: new Set(),
    slots: generationSlots(doc, page),
    eligibleAssetIds: new Set(['av_photo']),
    paletteTokens: new Set(fixtureSnapshot().document.tokens.colours.map((c) => c.key)),
    effectiveFactIds: new Set(['fact_1']),
    newId,
    ...over,
  };
};

describe('generation slots', () => {
  it('lists every element: text with its limit, the image area, the logo as fixed', () => {
    const { document } = photoFeature();
    const slots = generationSlots(document, document.pages[0]!);
    const headline = slots.find((s) => s.role === 'headline')!;
    expect(headline).toMatchObject({
      kind: 'text',
      key: 'headline',
      text: 'A headline that names the benefit',
    });
    expect(headline.maxLength).toBeGreaterThan(10);
    expect(slots.find((s) => s.kind === 'image_area')).toMatchObject({ role: 'product' });
    expect(slots.find((s) => s.kind === 'logo')?.fixed).toBe('logo');
  });

  it('template slots give the limit and required flag; locks, locked pages and the scope make elements fixed', () => {
    const { document } = photoFeature();
    const headline = byName(document, 'Headline');
    const body = byName(document, 'Body');
    const slots = generationSlots(document, document.pages[0]!, {
      templateSlots: [
        { key: 'title', elementId: headline.id, required: true, constraints: { maxLength: 42 } },
      ],
    });
    expect(slots.find((s) => s.elementId === headline.id)).toMatchObject({
      key: 'title',
      maxLength: 42,
      required: true,
    });
    const locked = structuredClone(document);
    (locked.pages[0]!.elements.find((e) => e.id === body.id) as Element).locked = true;
    expect(generationSlots(locked, locked.pages[0]!).find((s) => s.elementId === body.id)?.fixed).toBe(
      'locked',
    );
    locked.pages[0]!.locked = true;
    expect(generationSlots(locked, locked.pages[0]!).every((s) => s.fixed === 'page_locked')).toBe(true);
    const scoped = generationSlots(document, document.pages[0]!, {
      scope: { pageId: document.pages[0]!.id, elementIds: [headline.id] },
    });
    expect(scoped.find((s) => s.elementId === body.id)?.fixed).toBe('out_of_scope');
    expect(scoped.find((s) => s.elementId === headline.id)?.fixed).toBeUndefined();
  });
});

describe('compile slot fills to operations', () => {
  it('text, facts, an eligible image into the image area and a palette colour compile to guarded operations', () => {
    const { document } = photoFeature();
    const page = document.pages[0]!;
    const headline = byName(document, 'Headline');
    const area = byName(document, 'Image area');
    const fill: ModelFill = {
      summary: 'October offer',
      edits: [
        {
          label: 'Headline',
          pageId: page.id,
          elementId: headline.id,
          text: '20% off in October',
          factIds: ['fact_1'],
        },
        { label: 'Photo', pageId: page.id, elementId: area.id, assetVersionId: 'av_photo' },
        { label: 'Headline', pageId: page.id, elementId: headline.id, colourToken: 'ink', sizePx: 72 },
      ],
    };
    const out = compileFill(document, fill, contextFor(document));
    expect(out.refused).toEqual([]);
    expect(out.operations.map((o) => o.op)).toEqual([
      'setText',
      'removeElement',
      'insertElement',
      'setStyle',
      'setStyle',
    ]);
    expect(out.operations[0]).toMatchObject({ factRefs: ['fact_1'] });
    expect(out.assetVersionIds).toEqual(['av_photo']);
    expect(out.factIds).toEqual(['fact_1']);
    const next = applyBatch(document, { operations: out.operations });
    const image = next.pages[0]!.elements.find((e) => e.type === 'image')!;
    expect(image).toMatchObject({
      assetVersionId: 'av_photo',
      semanticRole: 'product',
      transform: area.transform,
    });
    // The image takes the area's place in the layer order.
    expect(next.pages[0]!.elements.indexOf(image)).toBe(page.elements.indexOf(area));
  });

  it('refuses, with the reason, everything outside the rules and keeps the rest', () => {
    const { document } = photoFeature();
    const page = document.pages[0]!;
    const headline = byName(document, 'Headline');
    const body = byName(document, 'Body');
    const logo = page.elements.find((e) => e.type === 'logo')!;
    const area = byName(document, 'Image area');
    const at = (elementId: string, extra: Partial<ModelFill['edits'][number]>) => ({
      label: 'x',
      pageId: page.id,
      elementId,
      ...extra,
    });
    const out = compileFill(
      document,
      {
        summary: 's',
        edits: [
          at(headline.id, { text: 'x'.repeat(500) }),
          at(headline.id, { text: 'Founded in 1998', factIds: ['fact_revoked'] }),
          at(area.id, { assetVersionId: 'av_not_eligible' }),
          at(body.id, { colourToken: '#ff0000' }),
          at(logo.id, { box: { x: 0, y: 0, width: 100, height: 30 } }),
          at(body.id, { box: { x: 900, y: 900, width: 400, height: 100 } }),
          { label: 'x', pageId: 'page_9', elementId: body.id, text: 'Elsewhere' },
          at(eid('01HMISSING'), { text: 'Ghost' }),
          at(body.id, { text: 'A short line that fits.' }),
        ],
      },
      contextFor(document),
    );
    expect(out.refused.map((r) => r.reason)).toEqual([
      expect.stringMatching(/^text_too_long:/),
      'fact_not_effective:fact_revoked',
      'asset_not_eligible',
      'colour_not_in_palette',
      'element_logo',
      'box_outside_page',
      'page_not_in_scope',
      'element_not_found',
    ]);
    expect(out.operations).toEqual([
      { op: 'setText', pageId: page.id, elementId: body.id, text: 'A short line that fits.', factRefs: [] },
    ]);
  });

  it('locked elements and elements outside the scope are refused', () => {
    const { document } = photoFeature();
    const page = document.pages[0]!;
    const headline = byName(document, 'Headline');
    const body = byName(document, 'Body');
    const locked = structuredClone(document);
    (locked.pages[0]!.elements.find((e) => e.id === body.id) as Element).locked = true;
    const scope = { pageId: page.id, elementIds: [headline.id] };
    const out = compileFill(
      locked,
      {
        summary: 's',
        edits: [
          { label: 'a', pageId: page.id, elementId: body.id, text: 'Locked' },
          { label: 'b', pageId: page.id, elementId: headline.id, text: 'Shorter' },
        ],
      },
      contextFor(locked, { scope, slots: generationSlots(locked, locked.pages[0]!, { scope }) }),
    );
    expect(out.refused.map((r) => r.reason)).toEqual(['element_locked']);
    expect(out.operations).toHaveLength(1);
    const outOfScope = compileFill(
      document,
      { summary: 's', edits: [{ label: 'a', pageId: page.id, elementId: body.id, text: 'Body' }] },
      contextFor(document, { scope, slots: generationSlots(document, page, { scope }) }),
    );
    expect(outOfScope.refused.map((r) => r.reason)).toEqual(['element_out_of_scope']);
  });
});

describe('scope guard', () => {
  const groupDoc = (): { doc: CreativeDocumentV1; headline: string; body: string; groupId: string } => {
    const { document } = photoFeature();
    const headline = byName(document, 'Headline').id;
    const body = byName(document, 'Body').id;
    const groupId = eid('01HGRP');
    const doc = applyBatch(document, {
      operations: [{ op: 'groupElements', pageId: 'page_1', elementIds: [headline, body], groupId }],
    });
    return { doc, headline, body, groupId };
  };

  it('allows the selection and what a selected group contains, refuses anything else', () => {
    const { document } = photoFeature();
    const headline = byName(document, 'Headline').id;
    const body = byName(document, 'Body').id;
    const state = scopeState({ pageId: 'page_1', elementIds: [headline] });
    expect(() =>
      guardScope(document, { op: 'setText', pageId: 'page_1', elementId: headline, text: 'x' }, state),
    ).not.toThrow();
    expect(() =>
      guardScope(document, { op: 'setText', pageId: 'page_1', elementId: body, text: 'x' }, state),
    ).toThrow(PolicyDeniedError);
    const g = groupDoc();
    const groupScope = scopeState({ pageId: 'page_1', elementIds: [g.groupId] });
    expect(() =>
      guardScope(g.doc, { op: 'setText', pageId: 'page_1', elementId: g.body, text: 'x' }, groupScope),
    ).not.toThrow();
    // A child selected alone does not bring its group (moving the group moves the other child).
    const childScope = scopeState({ pageId: 'page_1', elementIds: [g.headline] });
    expect(() =>
      guardScope(
        g.doc,
        { op: 'moveElement', pageId: 'page_1', elementId: g.groupId, x: 0, y: 0 },
        childScope,
      ),
    ).toThrow(/scope/);
  });

  it('other pages, page removal and unrelated insertions are refused; a replacement insertion is allowed', () => {
    const { document } = photoFeature();
    const area = byName(document, 'Image area');
    const state = scopeState({ pageId: 'page_1', elementIds: [area.id] });
    const deny = (op: Operation) => expect(() => guardScope(document, op, state)).toThrow(PolicyDeniedError);
    deny({ op: 'removePage', pageId: 'page_1' });
    deny({ op: 'setText', pageId: 'page_2', elementId: area.id, text: 'x' });
    const image = {
      ...area,
      id: eid('01HIMG'),
      type: 'image',
      assetVersionId: 'av_photo',
      fit: 'cover',
    } as Element;
    deny({ op: 'insertElement', pageId: 'page_1', element: image });
    const areaIndex = document.pages[0]!.elements.findIndex((e) => e.id === area.id);
    guardScope(document, { op: 'removeElement', pageId: 'page_1', elementId: area.id }, state);
    // The freed place takes one insertion, at that place only.
    deny({ op: 'insertElement', pageId: 'page_1', element: image });
    deny({ op: 'insertElement', pageId: 'page_1', element: image, index: areaIndex + 1 });
    expect(() =>
      guardScope(
        document,
        { op: 'insertElement', pageId: 'page_1', element: image, index: areaIndex },
        state,
      ),
    ).not.toThrow();
    deny({
      op: 'insertElement',
      pageId: 'page_1',
      element: { ...image, id: eid('01HIMG2') },
      index: areaIndex,
    });
    // The inserted image is in scope for the rest of the batch.
    expect(() =>
      guardScope(document, { op: 'setMask', pageId: 'page_1', elementId: image.id, mask: null }, state),
    ).not.toThrow();
  });

  it('a whole-page scope may copy or adapt the page, and the new pages are in scope', () => {
    const { document } = photoFeature();
    const structure = structureFor(
      document,
      GenerationRequest.parse({
        kind: 'refine',
        refine: {
          instruction: 'Two alternatives',
          scope: { pageId: 'page_1' },
          action: { kind: 'alternatives', count: 2 },
        },
      }),
      { newId },
    );
    expect(structure.createdPageIds).toEqual(['page_1_alt1', 'page_1_alt2']);
    const state = scopeState({ pageId: 'page_1', elementIds: [] });
    let doc = document;
    for (const op of structure.operations) {
      guardScope(doc, op, state);
      doc = applyBatch(doc, { operations: [op] });
    }
    const copy = doc.pages.find((p) => p.id === 'page_1_alt2')!;
    const text = copy.elements.find((e) => e.type === 'text')!;
    expect(() =>
      guardScope(doc, { op: 'setText', pageId: copy.id, elementId: text.id, text: 'x' }, state),
    ).not.toThrow();
    const selected = scopeState({ pageId: 'page_1', elementIds: [text.id] });
    expect(() => guardScope(document, structure.operations[0]!, selected)).toThrow(/copies/);
  });
});

describe('structure', () => {
  it('adapt makes a format variant whose id is the target page; the original page is untouched', () => {
    const { document } = photoFeature();
    const s = structureFor(
      document,
      GenerationRequest.parse({
        kind: 'refine',
        refine: {
          instruction: 'Vertical story',
          scope: { pageId: 'page_1' },
          action: { kind: 'adapt', formatKey: 'ig_story_9x16' },
        },
      }),
      { newId },
    );
    expect(s.operations).toEqual([
      { op: 'createFormatVariant', sourcePageId: 'page_1', formatKey: 'ig_story_9x16' },
    ]);
    const next = applyBatch(document, { operations: s.operations });
    expect(next.pages.map((p) => p.id)).toEqual(['page_1', ...s.targetPageIds]);
    expect(next.pages[0]).toEqual(document.pages[0]);
  });
});

describe('operation bound', () => {
  it('edits past the batch bound are refused as too_many_operations; the ones before it are kept', () => {
    const { document } = photoFeature();
    const headline = byName(document, 'Headline');
    const edits = Array.from({ length: 6 }, (_, i) => ({
      label: `Size ${i}`,
      pageId: 'page_1',
      elementId: headline.id,
      sizePx: 64 + i,
      weight: 700,
    }));
    const out = compileFill(document, { summary: 's', edits }, contextFor(document, { maxOperations: 4 }));
    expect(out.operations).toHaveLength(4);
    expect(out.refused.map((r) => r.reason)).toEqual(['too_many_operations', 'too_many_operations']);
  });
});

describe('proposal groups', () => {
  it('one group per change: same label, same element, a new page with everything on it', () => {
    const { document } = photoFeature();
    const headline = byName(document, 'Headline').id;
    const body = byName(document, 'Body').id;
    const ops: Operation[] = [
      { op: 'setText', pageId: 'page_1', elementId: headline, text: 'A' },
      { op: 'setStyle', pageId: 'page_1', elementId: headline, patch: { sizePx: 70 } },
      { op: 'setText', pageId: 'page_1', elementId: body, text: 'B' },
      { op: 'createFormatVariant', sourcePageId: 'page_1', formatKey: 'ig_story_9x16' },
      { op: 'setText', pageId: 'page_1_ig_story_9x16', elementId: body, text: 'C' },
    ];
    const groups = groupOperations(ops, [
      'Shorter headline',
      'Bigger headline',
      'Body',
      'Story',
      'Story copy',
    ]);
    expect(groups.map((g) => g.operationIndexes)).toEqual([[0, 1], [2], [3, 4]]);
    expect(groups[0]!.label).toBe('Shorter headline; Bigger headline');
    expect(operationsOfGroups(ops, groups, ['g3', 'g1'])).toEqual([ops[0], ops[1], ops[3], ops[4]]);
  });
});

describe('preflight rules', () => {
  const channel = (key: string, aspect: { min: number; max: number }): ProviderCapabilityV1 =>
    ({
      key,
      version: 1,
      text: {
        maxLength: 2200,
        weighted: false,
        supportsLinks: true,
        supportsMentions: true,
        supportsHashtags: true,
      },
      media: {
        image: {
          mimes: ['image/png'],
          minWidth: 320,
          maxWidth: 1440,
          aspectRatios: [aspect],
          maxBytes: 8e6,
          maxCount: 10,
        },
        altText: true,
        publicUrlFetch: { required: false, processingWindowSec: 0 },
      },
      certifiedAt: '2026-01-01T00:00:00.000Z',
    }) as unknown as ProviderCapabilityV1;

  const input = (request: unknown, over: Partial<PreflightInput> = {}): PreflightInput => {
    const { document } = photoFeature();
    return {
      document,
      request: GenerationRequest.parse(request),
      snapshot: fixtureSnapshot(),
      slots: generationSlots(document, document.pages[0]!),
      targetPageIds: ['page_1'],
      eligibleAssets: [{ assetVersionId: 'av_photo', kind: 'image', altText: null }],
      channels: [
        channel('instagram', { min: 0.8, max: 1.91 }),
        channel('story_only', { min: 0.5, max: 0.6 }),
      ],
      knownChannelKeys: new Set(['instagram', 'story_only']),
      imageGeneration: { available: false, reason: 'not set up' },
      templateResolved: true,
      costMicros: 200_000,
      remainingMicros: 5_000_000,
      ...over,
    };
  };
  const codes = (r: ReturnType<typeof preflightGeneration>, severity = 'blocking') =>
    r.issues.filter((i) => i.severity === severity).map((i) => i.code);

  it('a complete brief passes and lists the constraints that will apply', () => {
    const r = preflightGeneration(
      input({
        kind: 'generate',
        brief: { keyMessage: 'October offer', channelKeys: ['instagram'], factIds: ['fact_1'] },
      }),
    );
    expect(codes(r)).toEqual([]);
    const kinds = new Set(r.constraints.map((c) => c.kind));
    for (const k of ['channel', 'safe_area', 'logo_rule', 'protected', 'slot', 'fact'])
      expect(kinds.has(k as never)).toBe(true);
    expect(r.emptyImageSlots).toBe(1);
  });

  it('reports missing requirements, ineligible inputs, unsupported combinations and the budget', () => {
    const r = preflightGeneration(
      input(
        {
          kind: 'generate',
          brief: {
            channelKeys: ['story_only', 'nowhere'],
            factIds: ['fact_expired'],
            assets: { include: ['av_secret'] },
            generateImages: true,
          },
        },
        { costMicros: 9_000_000 },
      ),
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        'fact_not_effective',
        'asset_not_eligible',
        'brief_missing_message',
        'channel_unknown',
        'format_not_supported_by_channel',
        'image_generation_unavailable',
        'budget_insufficient',
      ]),
    );
  });

  it('a refinement on a locked element or with a selection for an adaptation is blocked', () => {
    const { document } = photoFeature();
    const headline = byName(document, 'Headline');
    const locked = structuredClone(document);
    (locked.pages[0]!.elements.find((e) => e.id === headline.id) as Element).locked = true;
    const r = preflightGeneration(
      input(
        {
          kind: 'refine',
          refine: { instruction: 'Shorter', scope: { pageId: 'page_1', elementIds: [headline.id] } },
        },
        { document: locked },
      ),
    );
    expect(codes(r)).toEqual(['element_locked']);
    const adapt = preflightGeneration(
      input({
        kind: 'refine',
        refine: {
          instruction: 'Story',
          scope: { pageId: 'page_1', elementIds: [headline.id] },
          action: { kind: 'adapt', formatKey: 'square_1080' },
        },
      }),
    );
    expect(codes(adapt)).toEqual(expect.arrayContaining(['format_same', 'scope_page_only']));
    expect(findElement(document.pages[0]!, headline.id)?.locked).toBe(false);
  });
});

describe('inputs hash', () => {
  it('equal intents hash equally once defaults are applied; any material change hashes differently', () => {
    const a = GenerationRequest.parse({ kind: 'generate', brief: { keyMessage: 'Hello' } });
    const b = GenerationRequest.parse({
      kind: 'generate',
      brief: { keyMessage: 'Hello', variations: 1, channelKeys: [], assets: {}, layout: { kind: 'current' } },
    });
    const c = GenerationRequest.parse({ kind: 'generate', brief: { keyMessage: 'Hello', variations: 2 } });
    expect(hashCanonical(a)).toBe(hashCanonical(b));
    expect(hashCanonical(a)).not.toBe(hashCanonical(c));
  });
});
