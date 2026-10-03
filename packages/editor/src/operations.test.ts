import { describe, expect, it } from 'vitest';
import { hashCanonical } from '@oremedia/domain/hash';
import {
  CreativeDocumentV1,
  OPERATION_NAMES,
  Operation,
  type CreativePage,
  type Element,
} from '@oremedia/contracts/creative';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { applyBatch, changedElementIds, findElement, OperationError, reduce } from './reduce';
import { guardLocks, guardLogoInsertion, guardProtected } from './guard';
import { invertBatch } from './invert';
import { rebaseBatch } from './rebase';
import { eid, fixtureDocument, ids } from './fixtures';
import { aspectLabel, customFormatIssue, customFormatKey, formatFor } from './formats';

const P = 'page_1';
const G = eid('01HGRP');

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    if (e instanceof OperationError) return e.code;
    if (e instanceof PolicyDeniedError) return e.reason;
    throw e;
  }
};

const page = (doc: CreativeDocumentV1, id = P): CreativePage => doc.pages.find((p) => p.id === id)!;
const el = (doc: CreativeDocumentV1, id: string, pageId = P): Element => findElement(page(doc, pageId), id)!;
const run = (ops: Operation[], doc = fixtureDocument()) => applyBatch(doc, { operations: ops });
const group: Operation = { op: 'groupElements', pageId: P, elementIds: [ids.image, ids.body], groupId: G };
const copyMap = (p: CreativePage): Record<string, string> =>
  Object.fromEntries(p.elements.map((e, i) => [e.id, eid(`01HCPY${i}`)]));

describe('STU-1a document model (additive, schemaVersion 1)', () => {
  it('a document stored before STU-1a parses and hashes exactly as before (no contentType, no page lock)', () => {
    const stored = JSON.parse(JSON.stringify(fixtureDocument()));
    const parsed = CreativeDocumentV1.parse(stored);
    expect(parsed).not.toHaveProperty('contentType');
    expect(parsed.pages[0]).not.toHaveProperty('locked');
    expect(hashCanonical(parsed)).toBe(hashCanonical(stored));
  });

  it('contentType and a page lock are kept when present', () => {
    const doc = CreativeDocumentV1.parse({
      ...fixtureDocument(),
      contentType: 'carousel',
      pages: [{ ...fixtureDocument().pages[0], locked: true }],
    });
    expect(doc.contentType).toBe('carousel');
    expect(doc.pages[0]?.locked).toBe(true);
  });

  it('every operation in the contract is named once (the agent tool schema enumerates these)', () => {
    expect(new Set(OPERATION_NAMES).size).toBe(OPERATION_NAMES.length);
    expect(OPERATION_NAMES).toEqual(
      expect.arrayContaining([
        'groupElements',
        'ungroupElement',
        'setRotation',
        'setMask',
        'removePage',
        'duplicatePage',
        'reorderPage',
        'setPageLock',
        'alignElements',
        'distributeElements',
      ]),
    );
  });
});

describe('custom formats', () => {
  it('validates sizes against the render limit and the aspect range', () => {
    expect(customFormatIssue(1500, 500)).toBeNull();
    expect(customFormatIssue(63, 500)).toMatch(/at least 64/);
    expect(customFormatIssue(4097, 500)).toMatch(/at most 4096/);
    expect(customFormatIssue(4000, 400)).toMatch(/8 times/);
    expect(customFormatIssue(100.5, 100)).toMatch(/whole/);
  });

  it('a custom key resolves to a definition with a proportional safe area; an invalid one is unknown', () => {
    const f = formatFor(customFormatKey(1500, 500));
    expect(f).toMatchObject({ width: 1500, height: 500, safeArea: { top: 25, left: 25 } });
    expect(formatFor('custom_5000x500')).toBeUndefined();
    expect(formatFor('custom_10x10')).toBeUndefined();
    expect(formatFor('yt_thumbnail_1280x720')).toMatchObject({ width: 1280, height: 720 });
  });

  it('labels aspect ratios', () => {
    expect(aspectLabel(1080, 1350)).toBe('4:5');
    expect(aspectLabel(1280, 720)).toBe('16:9');
    expect(aspectLabel(1584, 396)).toBe('4:1');
    expect(aspectLabel(1200, 627)).toBe('1.91:1');
  });
});

describe('groupElements / ungroupElement', () => {
  it('wraps top-level members in paint order at the front-most member, the box enclosing them', () => {
    const doc = run([group]);
    const p = page(doc);
    const g = p.elements.find((e) => e.id === G);
    expect(g?.type).toBe('group');
    if (g?.type !== 'group') return;
    expect(g.children.map((c) => c.id)).toEqual([ids.image, ids.body]);
    // bg, headline, group (where body was: the front-most member), logo
    expect(p.elements.map((e) => e.id)).toEqual([ids.bg, ids.headline, G, ids.logo]);
    expect(g.transform).toEqual({ x: 80, y: 260, width: 920, height: 580, rotation: 0 });
  });

  it('refuses backgrounds, locked or nested members, duplicate ids', () => {
    expect(codeOf(() => run([{ ...group, elementIds: [ids.bg, ids.body] } as Operation]))).toBe(
      'cannot_group_background',
    );
    expect(codeOf(() => run([{ op: 'setLock', pageId: P, elementId: ids.body, locked: true }, group]))).toBe(
      'element_locked',
    );
    expect(
      codeOf(() =>
        run([
          group,
          { ...group, groupId: eid('01HGR2'), elementIds: [ids.image, ids.headline] } as Operation,
        ]),
      ),
    ).toBe('nested_element');
    expect(codeOf(() => run([{ ...group, groupId: ids.headline } as Operation]))).toBe(
      'duplicate_element_id',
    );
    expect(codeOf(() => run([{ ...group, elementIds: [ids.body, ids.body] } as Operation]))).toBe(
      'duplicate_element_ids',
    );
  });

  it('moving a group moves its children (page-absolute); resizing scales them; rotation is per member', () => {
    const doc = run([group, { op: 'moveElement', pageId: P, elementId: G, x: 100, y: 300 }]);
    expect(el(doc, ids.image).transform).toMatchObject({ x: 100, y: 300 });
    expect(el(doc, ids.body).transform).toMatchObject({ x: 100, y: 800 });
    const resized = run([group, { op: 'resizeElement', pageId: P, elementId: G, width: 460, height: 580 }]);
    expect(el(resized, ids.image).transform).toMatchObject({ x: 80, width: 460, height: 460 });
    expect(codeOf(() => run([group, { op: 'setRotation', pageId: P, elementId: G, rotation: 10 }]))).toBe(
      'group_rotation_unsupported',
    );
  });

  it('a group with a locked child cannot be moved; ungroup puts children back and folds the group opacity', () => {
    const locked = run([group, { op: 'setLock', pageId: P, elementId: ids.body, locked: true }]);
    expect(codeOf(() => run([{ op: 'moveElement', pageId: P, elementId: G, x: 0, y: 0 }], locked))).toBe(
      'element_locked',
    );
    const doc = run([
      group,
      { op: 'setStyle', pageId: P, elementId: G, patch: { opacity: 0.5 } },
      { op: 'ungroupElement', pageId: P, elementId: G },
    ]);
    expect(page(doc).elements.map((e) => e.id)).toEqual([
      ids.bg,
      ids.headline,
      ids.image,
      ids.body,
      ids.logo,
    ]);
    expect(el(doc, ids.image).opacity).toBe(0.5);
    expect(codeOf(() => run([{ op: 'ungroupElement', pageId: P, elementId: ids.body }]))).toBe('not_a_group');
  });
});

describe('setRotation / setMask', () => {
  it('rotates unlocked elements; a locked element or page refuses', () => {
    expect(
      el(run([{ op: 'setRotation', pageId: P, elementId: ids.image, rotation: -15 }]), ids.image).transform
        .rotation,
    ).toBe(-15);
    expect(codeOf(() => run([{ op: 'setRotation', pageId: P, elementId: ids.bg, rotation: 5 }]))).toBe(
      'element_locked',
    );
    expect(
      codeOf(() =>
        run([
          { op: 'setPageLock', pageId: P, locked: true },
          { op: 'setRotation', pageId: P, elementId: ids.image, rotation: 5 },
        ]),
      ),
    ).toBe('page_locked');
  });

  it('sets and removes an image mask; other elements refuse', () => {
    const masked = run([
      { op: 'setMask', pageId: P, elementId: ids.image, mask: { kind: 'rounded', radius: 32 } },
    ]);
    expect(el(masked, ids.image)).toMatchObject({ mask: { kind: 'rounded', radius: 32 } });
    expect(
      el(run([{ op: 'setMask', pageId: P, elementId: ids.image, mask: null }], masked), ids.image),
    ).not.toHaveProperty('mask');
    expect(codeOf(() => run([{ op: 'setMask', pageId: P, elementId: ids.headline, mask: null }]))).toBe(
      'not_an_image',
    );
  });
});

describe('page operations', () => {
  const twoPages = () =>
    run([
      {
        op: 'duplicatePage',
        pageId: P,
        newPageId: 'page_2',
        elementIdMap: copyMap(fixtureDocument().pages[0]!),
      },
    ]);

  it('duplicatePage copies with the new ids (constraints follow), unlocked, after the source', () => {
    const doc = twoPages();
    expect(doc.pages.map((p) => p.id)).toEqual([P, 'page_2']);
    const copy = page(doc, 'page_2');
    expect(copy.name).toBe('Feed (copy)');
    expect(copy.elements.map((e) => e.id)).toEqual(Object.values(copyMap(fixtureDocument().pages[0]!)));
    expect(copy.layoutConstraints.map((c) => c.elementId)).toEqual([
      copyMap(fixtureDocument().pages[0]!)[ids.logo],
      copyMap(fixtureDocument().pages[0]!)[ids.headline],
    ]);
    const locked = run([{ op: 'setPageLock', pageId: P, locked: true }]);
    const copied = run(
      [{ op: 'duplicatePage', pageId: P, newPageId: 'page_2', elementIdMap: copyMap(locked.pages[0]!) }],
      locked,
    );
    expect(page(copied, 'page_2')).not.toHaveProperty('locked');
  });

  it('duplicatePage refuses an incomplete map, reused ids and an existing page id', () => {
    const map = copyMap(fixtureDocument().pages[0]!);
    const { [ids.bg]: _bg, ...partial } = map;
    expect(
      codeOf(() => run([{ op: 'duplicatePage', pageId: P, newPageId: 'p2', elementIdMap: partial }])),
    ).toBe('element_id_map_incomplete');
    expect(
      codeOf(() =>
        run([
          {
            op: 'duplicatePage',
            pageId: P,
            newPageId: 'p2',
            elementIdMap: { ...map, [ids.bg]: ids.headline },
          },
        ]),
      ),
    ).toBe('duplicate_element_id');
    expect(codeOf(() => run([{ op: 'duplicatePage', pageId: P, newPageId: P, elementIdMap: map }]))).toBe(
      'duplicate_page_id',
    );
  });

  it('reorderPage moves a page (clamped); removePage keeps at least one page and never removes a locked one', () => {
    const doc = run([{ op: 'reorderPage', pageId: 'page_2', toIndex: -4 }], twoPages());
    expect(doc.pages.map((p) => p.id)).toEqual(['page_2', P]);
    expect(run([{ op: 'removePage', pageId: P }], twoPages()).pages.map((p) => p.id)).toEqual(['page_2']);
    expect(codeOf(() => run([{ op: 'removePage', pageId: P }]))).toBe('last_page');
    expect(
      codeOf(() =>
        run(
          [
            { op: 'setPageLock', pageId: P, locked: true },
            { op: 'removePage', pageId: P },
          ],
          twoPages(),
        ),
      ),
    ).toBe('page_locked');
  });

  it('setPageLock stores true and removes the key on unlock; a locked page refuses manual transforms only', () => {
    const locked = run([{ op: 'setPageLock', pageId: P, locked: true }]);
    expect(locked.pages[0]?.locked).toBe(true);
    const unlocked = run([{ op: 'setPageLock', pageId: P, locked: false }], locked);
    expect(hashCanonical(unlocked)).toBe(hashCanonical(fixtureDocument()));
    for (const op of [
      { op: 'moveElement', pageId: P, elementId: ids.image, x: 1, y: 1 },
      { op: 'resizeElement', pageId: P, elementId: ids.image, width: 10, height: 10 },
      { op: 'alignElements', pageId: P, elementIds: [ids.image], align: 'left', relativeTo: 'page' },
      {
        op: 'distributeElements',
        pageId: P,
        elementIds: [ids.image, ids.body],
        axis: 'vertical',
        relativeTo: 'page',
      },
    ] as Operation[])
      expect(
        codeOf(() => reduce(locked, op)),
        op.op,
      ).toBe('page_locked');
    expect(() =>
      reduce(locked, { op: 'setText', pageId: P, elementId: ids.headline, text: 'Still editable' }),
    ).not.toThrow();
  });
});

describe('alignElements / distributeElements', () => {
  it('aligns to the page and to the selection bounds', () => {
    const right = run([
      { op: 'alignElements', pageId: P, elementIds: [ids.headline], align: 'right', relativeTo: 'page' },
    ]);
    expect(el(right, ids.headline).transform.x).toBe(1080 - 920);
    const middle = run([
      { op: 'alignElements', pageId: P, elementIds: [ids.image], align: 'middle', relativeTo: 'page' },
    ]);
    expect(el(middle, ids.image).transform.y).toBe((1080 - 460) / 2);
    const bottom = run([
      {
        op: 'alignElements',
        pageId: P,
        elementIds: [ids.headline, ids.body],
        align: 'bottom',
        relativeTo: 'selection',
      },
    ]);
    expect(el(bottom, ids.headline).transform.y).toBe(840 - 120);
    expect(el(bottom, ids.body).transform.y).toBe(760);
  });

  it('distributes with equal gaps within the selection span or across the page', () => {
    const doc = run([
      {
        op: 'distributeElements',
        pageId: P,
        elementIds: [ids.headline, ids.image, ids.body],
        axis: 'vertical',
        relativeTo: 'selection',
      },
    ]);
    const [h, i, b] = [ids.headline, ids.image, ids.body].map((id) => el(doc, id).transform);
    const gap1 = i!.y - (h!.y + h!.height);
    const gap2 = b!.y - (i!.y + i!.height);
    expect(gap1).toBeCloseTo(gap2, 1);
    expect(h!.y).toBe(80);
    expect(b!.y + b!.height).toBe(840);
    const across = run([
      {
        op: 'distributeElements',
        pageId: P,
        elementIds: [ids.headline, ids.body],
        axis: 'vertical',
        relativeTo: 'page',
      },
    ]);
    const top = el(across, ids.headline).transform.y;
    expect(top).toBeCloseTo((1080 - 200) / 3, 1);
  });

  it('locked members refuse', () => {
    expect(
      codeOf(() =>
        run([
          {
            op: 'alignElements',
            pageId: P,
            elementIds: [ids.bg, ids.body],
            align: 'left',
            relativeTo: 'page',
          },
        ]),
      ),
    ).toBe('element_locked');
  });

  it('changedElementIds names every member (comments outdate, rebase conflicts)', () => {
    expect(
      changedElementIds({
        operations: [
          group,
          { op: 'alignElements', pageId: P, elementIds: [ids.headline], align: 'left', relativeTo: 'page' },
        ],
      }),
    ).toEqual(expect.arrayContaining([ids.image, ids.body, G, ids.headline]));
  });
});

describe('lock guard (architecture principle 2: locks are binding for agents)', () => {
  const lockedBody = () => run([{ op: 'setLock', pageId: P, elementId: ids.body, locked: true }]);
  const agentOpsOnBody: Operation[] = [
    { op: 'setText', pageId: P, elementId: ids.body, text: 'x' },
    { op: 'setStyle', pageId: P, elementId: ids.body, patch: { sizePx: 30 } },
    { op: 'moveElement', pageId: P, elementId: ids.body, x: 0, y: 0 },
    { op: 'resizeElement', pageId: P, elementId: ids.body, width: 10, height: 10 },
    { op: 'setRotation', pageId: P, elementId: ids.body, rotation: 3 },
    { op: 'removeElement', pageId: P, elementId: ids.body },
    { op: 'reorderElement', pageId: P, elementId: ids.body, toIndex: 0 },
    { op: 'setLock', pageId: P, elementId: ids.body, locked: false },
    { op: 'groupElements', pageId: P, elementIds: [ids.body, ids.headline], groupId: G },
    { op: 'alignElements', pageId: P, elementIds: [ids.body], align: 'left', relativeTo: 'page' },
    {
      op: 'distributeElements',
      pageId: P,
      elementIds: [ids.body, ids.headline],
      axis: 'vertical',
      relativeTo: 'page',
    },
    { op: 'removePage', pageId: P },
    { op: 'applyTemplate', pageId: P, templateVersionId: 'tv', slotBindings: {} },
  ];
  for (const op of agentOpsOnBody)
    it(`refuses an agent ${op.op} that touches a locked element; a person is not refused by the guard`, () => {
      expect(codeOf(() => guardLocks(lockedBody(), op, 'agent'))).toBe('element_locked');
      expect(() => guardLocks(lockedBody(), op, 'user')).not.toThrow();
    });

  it('refuses agent crops and masks of a locked image, and edits inside a locked group', () => {
    const doc = run([{ op: 'setLock', pageId: P, elementId: ids.image, locked: true }]);
    expect(
      codeOf(() =>
        guardLocks(
          doc,
          { op: 'setCrop', pageId: P, elementId: ids.image, crop: { x: 0, y: 0, width: 1, height: 1 } },
          'agent',
        ),
      ),
    ).toBe('element_locked');
    expect(
      codeOf(() => guardLocks(doc, { op: 'setMask', pageId: P, elementId: ids.image, mask: null }, 'agent')),
    ).toBe('element_locked');
    expect(
      codeOf(() =>
        guardLocks(
          doc,
          { op: 'replaceAsset', pageId: P, elementId: ids.image, assetVersionId: 'av' },
          'agent',
        ),
      ),
    ).toBe('element_locked');
    const grouped = run([group, { op: 'setLock', pageId: P, elementId: G, locked: true }]);
    expect(
      codeOf(() => guardLocks(grouped, { op: 'ungroupElement', pageId: P, elementId: G }, 'agent')),
    ).toBe('element_locked');
  });

  it('a locked page refuses every agent operation on it, insertions and page operations included', () => {
    const doc = run([{ op: 'setPageLock', pageId: P, locked: true }]);
    const free = fixtureDocument().pages[0]!.elements[1] as Element;
    for (const op of [
      { op: 'setText', pageId: P, elementId: ids.headline, text: 'x' },
      { op: 'insertElement', pageId: P, element: { ...free, id: eid('01HNEW') } },
      { op: 'setPageLock', pageId: P, locked: false },
      { op: 'duplicatePage', pageId: P, newPageId: 'p2', elementIdMap: {} },
      { op: 'reorderPage', pageId: P, toIndex: 1 },
      { op: 'createFormatVariant', sourcePageId: P, formatKey: 'ig_story_9x16' },
    ] as Operation[])
      expect(
        codeOf(() => guardLocks(doc, op, 'agent')),
        op.op,
      ).toBe('page_locked');
    expect(() =>
      guardLocks(doc, { op: 'addPage', page: { ...doc.pages[0]!, id: 'p2' } }, 'agent'),
    ).not.toThrow();
  });

  it('agents may still change unlocked elements on an unlocked page', () => {
    expect(() =>
      guardLocks(lockedBody(), { op: 'setText', pageId: P, elementId: ids.headline, text: 'x' }, 'agent'),
    ).not.toThrow();
  });

  it('protection covers the new element operations and group members', () => {
    for (const op of [
      { op: 'setRotation', pageId: P, elementId: ids.logo, rotation: 3 },
      { op: 'alignElements', pageId: P, elementIds: [ids.logo], align: 'left', relativeTo: 'page' },
      { op: 'groupElements', pageId: P, elementIds: [ids.logo, ids.body], groupId: G },
    ] as Operation[])
      expect(
        codeOf(() => guardProtected(fixtureDocument(), op, 'agent')),
        op.op,
      ).toBe('protected_element');
    const grouped = run([{ op: 'groupElements', pageId: P, elementIds: [ids.logo, ids.body], groupId: G }]);
    expect(
      codeOf(() =>
        guardProtected(grouped, { op: 'moveElement', pageId: P, elementId: G, x: 0, y: 0 }, 'agent'),
      ),
    ).toBe('protected_element');
  });
});

describe('rebase with page operations', () => {
  it('a remote page removal conflicts with local edits on that page', () => {
    const local: Operation[] = [{ op: 'setText', pageId: 'page_2', elementId: ids.headline, text: 'x' }];
    const result = rebaseBatch(local, [[{ op: 'removePage', pageId: 'page_2' }]]);
    expect(result.ok).toBe(false);
  });

  it('local edits on another page re-apply over a remote duplicate, reorder or lock', () => {
    const local: Operation[] = [{ op: 'setText', pageId: P, elementId: ids.headline, text: 'x' }];
    const remote: Operation[] = [
      {
        op: 'duplicatePage',
        pageId: P,
        newPageId: 'page_2',
        elementIdMap: copyMap(fixtureDocument().pages[0]!),
      },
      { op: 'reorderPage', pageId: 'page_2', toIndex: 0 },
      { op: 'setPageLock', pageId: 'page_2', locked: true },
    ];
    expect(rebaseBatch(local, [remote])).toMatchObject({ ok: true });
  });

  it('the same element aligned remotely and moved locally conflicts', () => {
    const result = rebaseBatch(
      [{ op: 'moveElement', pageId: P, elementId: ids.body, x: 1, y: 1 }],
      [
        [
          {
            op: 'alignElements',
            pageId: P,
            elementIds: [ids.body, ids.headline],
            align: 'left',
            relativeTo: 'page',
          },
        ],
      ],
    );
    expect(result.ok).toBe(false);
  });
});

describe('operation contract', () => {
  it('parses every STU-1a operation', () => {
    for (const op of [
      group,
      { op: 'ungroupElement', pageId: P, elementId: G },
      { op: 'setRotation', pageId: P, elementId: G, rotation: 90 },
      { op: 'setMask', pageId: P, elementId: G, mask: { kind: 'circle' } },
      { op: 'removePage', pageId: P },
      { op: 'duplicatePage', pageId: P, newPageId: 'p', elementIdMap: { [ids.bg]: G } },
      { op: 'reorderPage', pageId: P, toIndex: 0 },
      { op: 'setPageLock', pageId: P, locked: true },
      { op: 'alignElements', pageId: P, elementIds: [G], align: 'center', relativeTo: 'page' },
      {
        op: 'distributeElements',
        pageId: P,
        elementIds: [G, ids.bg],
        axis: 'horizontal',
        relativeTo: 'selection',
      },
    ])
      expect(Operation.safeParse(op).success, String(op.op)).toBe(true);
    expect(Operation.safeParse({ op: 'setRotation', pageId: P, elementId: G, rotation: 400 }).success).toBe(
      false,
    );
    expect(Operation.safeParse({ ...group, elementIds: [ids.bg] }).success).toBe(false);
  });
});

describe('review fixes: protection and locks through groups and page operations', () => {
  const lockedGroup = () => run([group, { op: 'setLock', pageId: P, elementId: G, locked: true }]);

  it('a locked group covers its children: agents are refused, people cannot move or remove them', () => {
    const doc = lockedGroup();
    for (const op of [
      { op: 'setText', pageId: P, elementId: ids.body, text: 'x' },
      { op: 'removeElement', pageId: P, elementId: ids.body },
      { op: 'moveElement', pageId: P, elementId: ids.body, x: 0, y: 0 },
    ] as Operation[])
      expect(
        codeOf(() => guardLocks(doc, op, 'agent')),
        op.op,
      ).toBe('element_locked');
    expect(codeOf(() => reduce(doc, { op: 'moveElement', pageId: P, elementId: ids.body, x: 0, y: 0 }))).toBe(
      'element_locked',
    );
    expect(codeOf(() => reduce(doc, { op: 'removeElement', pageId: P, elementId: ids.body }))).toBe(
      'element_locked',
    );
    expect(codeOf(() => reduce(doc, { op: 'removeElement', pageId: P, elementId: G }))).toBe(
      'element_locked',
    );
    // A person may still edit the text of a child of a locked group.
    expect(() =>
      reduce(doc, { op: 'setText', pageId: P, elementId: ids.body, text: 'Person' }),
    ).not.toThrow();
  });

  it('a protected group covers its children for agents', () => {
    const doc = run([group, { op: 'setStyle', pageId: P, elementId: G, patch: { opacity: 0.9 } }]);
    const prot = structuredClone(doc);
    const g = prot.pages[0]!.elements.find((e) => e.id === G)!;
    g.protected = true;
    expect(
      codeOf(() =>
        guardProtected(prot, { op: 'setText', pageId: P, elementId: ids.body, text: 'x' }, 'agent'),
      ),
    ).toBe('protected_element');
  });

  it('agents cannot remove or replace a page holding a protected logo', () => {
    const two = run([
      {
        op: 'duplicatePage',
        pageId: P,
        newPageId: 'page_2',
        elementIdMap: copyMap(fixtureDocument().pages[0]!),
      },
    ]);
    expect(codeOf(() => guardProtected(two, { op: 'removePage', pageId: P }, 'agent'))).toBe(
      'protected_element',
    );
    expect(
      codeOf(() =>
        guardProtected(
          two,
          { op: 'applyTemplate', pageId: P, templateVersionId: 'tv', slotBindings: {} },
          'agent',
        ),
      ),
    ).toBe('protected_element');
    expect(() => guardProtected(two, { op: 'removePage', pageId: P }, 'user')).not.toThrow();
  });

  it('agents cannot bring logos in through new, copied, variant or template pages', () => {
    const doc = fixtureDocument();
    const logoPage = { ...doc.pages[0]!, id: 'page_2' };
    const cases: Array<[Operation, Element[] | undefined]> = [
      [{ op: 'addPage', page: logoPage }, undefined],
      [{ op: 'duplicatePage', pageId: P, newPageId: 'p2', elementIdMap: copyMap(doc.pages[0]!) }, undefined],
      [{ op: 'createFormatVariant', sourcePageId: P, formatKey: 'ig_story_9x16' }, undefined],
      [{ op: 'applyTemplate', pageId: P, templateVersionId: 'tv', slotBindings: {} }, doc.pages[0]!.elements],
    ];
    for (const [op, template] of cases) {
      expect(
        codeOf(() => guardLogoInsertion(op, 'agent', doc, template)),
        op.op,
      ).toBe('agent_logo_insert');
      expect(() => guardLogoInsertion(op, 'user', doc, template)).not.toThrow();
    }
    const noLogo = {
      ...doc.pages[0]!,
      id: 'page_3',
      elements: doc.pages[0]!.elements.filter((e) => e.type !== 'logo'),
    };
    expect(() => guardLogoInsertion({ op: 'addPage', page: noLogo }, 'agent', doc)).not.toThrow();
  });

  it('people: a template does not replace a locked page or a page holding locked elements', () => {
    const page = { ...fixtureDocument().pages[0]!, elements: [] };
    const templates = { tv: { page, slots: [] } };
    const op: Operation = { op: 'applyTemplate', pageId: P, templateVersionId: 'tv', slotBindings: {} };
    expect(codeOf(() => reduce(fixtureDocument(), op, { templates }))).toBe('element_locked');
    const unlocked = run([{ op: 'setLock', pageId: P, elementId: ids.bg, locked: false }]);
    expect(() => reduce(unlocked, op, { templates })).not.toThrow();
    const lockedPage = run([{ op: 'setPageLock', pageId: P, locked: true }], unlocked);
    expect(codeOf(() => reduce(lockedPage, op, { templates }))).toBe('page_locked');
  });

  it('undo of an insert or crop on a locked element unlocks before removing, then restores the lock', () => {
    const doc = fixtureDocument();
    const locked = { ...(doc.pages[0]!.elements[1] as Element), id: eid('01HKCK'), locked: true };
    const ops: Operation[] = [{ op: 'insertElement', pageId: P, element: locked }];
    const after = run(ops, doc);
    const inv = invertBatch(doc, { operations: ops });
    if (!inv.ok) throw new Error(inv.reason);
    expect(hashCanonical(applyBatch(after, { operations: inv.operations }))).toBe(hashCanonical(doc));
    const lockedImage = run([{ op: 'setLock', pageId: P, elementId: ids.image, locked: true }]);
    const crop: Operation[] = [
      { op: 'setCrop', pageId: P, elementId: ids.image, crop: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    const cropped = run(crop, lockedImage);
    const undo = invertBatch(lockedImage, { operations: crop });
    if (!undo.ok) throw new Error(undo.reason);
    expect(hashCanonical(applyBatch(cropped, { operations: undo.operations }))).toBe(
      hashCanonical(lockedImage),
    );
  });

  it('a local duplicate conflicts with remote edits or the removal of its source page', () => {
    const local: Operation[] = [
      {
        op: 'duplicatePage',
        pageId: P,
        newPageId: 'page_2',
        elementIdMap: copyMap(fixtureDocument().pages[0]!),
      },
    ];
    expect(rebaseBatch(local, [[{ op: 'setText', pageId: P, elementId: ids.headline, text: 'x' }]]).ok).toBe(
      false,
    );
    expect(rebaseBatch(local, [[{ op: 'removePage', pageId: P }]]).ok).toBe(false);
    expect(
      rebaseBatch(local, [[{ op: 'setText', pageId: 'other', elementId: eid('01HXTH'), text: 'x' }]]).ok,
    ).toBe(true);
  });

  it('align and distribute use rotated footprints', () => {
    const rotated = run([{ op: 'setRotation', pageId: P, elementId: ids.headline, rotation: 90 }]);
    const left = run(
      [{ op: 'alignElements', pageId: P, elementIds: [ids.headline], align: 'left', relativeTo: 'page' }],
      rotated,
    );
    const t = el(left, ids.headline).transform;
    // A 920×120 box turned 90° covers 120 px horizontally around its centre: that footprint's left edge is at 0.
    expect(t.x + t.width / 2 - t.height / 2).toBeCloseTo(0, 1);
  });
});
