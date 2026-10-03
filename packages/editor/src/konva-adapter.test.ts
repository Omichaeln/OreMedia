import { describe, expect, it } from 'vitest';
import {
  fitScale,
  formatForPage,
  frameTransformIntent,
  marqueeSelection,
  toggleSelection,
  isInteractive,
  moveIntent,
  nudgeIntent,
  resizeIntent,
  transformIntent,
} from './konva-adapter';
import { findElement } from './reduce';
import { fixtureDocument, ids } from './fixtures';

const page = () => fixtureDocument().pages[0]!;

/** The stage only reports positions and sizes; this mapping decides which operations a gesture becomes (spec 11.6). */
describe('KonvaEditorAdapter intent mapping (DOM-free)', () => {
  it('drag end becomes moveElement with 2-decimal coordinates; a no-op drag emits nothing', () => {
    expect(moveIntent(page(), ids.image, 100.004, 300.996)).toEqual({
      operations: [{ op: 'moveElement', pageId: 'page_1', elementId: ids.image, x: 100, y: 301 }],
      summary: 'Move Hero',
      origin: 'user',
    });
    expect(moveIntent(page(), ids.image, 80, 260)).toBeNull();
  });

  it('locked and unknown elements never produce intents (the UI mirrors the server guard, never replaces it)', () => {
    expect(moveIntent(page(), ids.bg, 1, 1)).toBeNull();
    expect(resizeIntent(page(), ids.bg, 10, 10)).toBeNull();
    expect(moveIntent(page(), 'el_00000000000000000000000000', 1, 1)).toBeNull();
    expect(isInteractive(findElement(page(), ids.bg)!, false)).toBe(false);
    expect(isInteractive(findElement(page(), ids.image)!, false)).toBe(true);
    expect(isInteractive(findElement(page(), ids.image)!, true)).toBe(false);
  });

  it('arrow-key nudges are 1px or 10px moves from the current position', () => {
    expect(nudgeIntent(page(), ids.headline, 1, 0)?.operations[0]).toMatchObject({ x: 81, y: 80 });
    expect(nudgeIntent(page(), ids.headline, 0, -10)?.operations[0]).toMatchObject({ x: 80, y: 70 });
  });

  it('transform end becomes resizeElement (plus moveElement when the box moved)', () => {
    const both = transformIntent(page(), ids.image, { x: 90, y: 270, width: 800, height: 400 });
    expect(both?.operations.map((o) => o.op)).toEqual(['moveElement', 'resizeElement']);
    expect(both?.summary).toBe('Resize Hero');
    const resizeOnly = transformIntent(page(), ids.image, { x: 80, y: 260, width: 800, height: 400 });
    expect(resizeOnly?.operations).toEqual([
      { op: 'resizeElement', pageId: 'page_1', elementId: ids.image, width: 800, height: 400 },
    ]);
    expect(transformIntent(page(), ids.image, { x: 80, y: 260, width: 920, height: 460 })).toBeNull();
  });

  it('logos keep their aspect ratio whatever the gesture asked for', () => {
    const intent = resizeIntent(page(), ids.logo, 300, 10);
    expect(intent?.operations[0]).toMatchObject({ op: 'resizeElement', width: 300, height: 90 });
  });

  it('sizes never collapse below 1px', () => {
    expect(resizeIntent(page(), ids.image, 0, -5)?.operations[0]).toMatchObject({ width: 1, height: 1 });
  });

  it('fits the page into the viewport without enlarging past 1:1', () => {
    expect(fitScale({ width: 1080, height: 1080 }, { width: 540, height: 800 })).toBe(0.5);
    expect(fitScale({ width: 1080, height: 1920 }, { width: 2000, height: 960 })).toBe(0.5);
    expect(fitScale({ width: 500, height: 500 }, { width: 2000, height: 2000 })).toBe(1);
    expect(fitScale({ width: 500, height: 500 }, { width: 0, height: 0 })).toBe(1);
  });

  it('an unknown format key falls back to the page dimensions with no safe area', () => {
    expect(formatForPage(page()).key).toBe('square_1080');
    expect(formatForPage({ ...page(), formatKey: 'custom' })).toMatchObject({
      key: 'custom',
      width: 1080,
      height: 1080,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  });

  it('shift-click toggles an element in the selection; a marquee selects the top-level elements it touches', () => {
    expect(toggleSelection([ids.image], ids.body)).toEqual([ids.image, ids.body]);
    expect(toggleSelection([ids.image, ids.body], ids.image)).toEqual([ids.body]);
    // The headline (80..200) and the image (260..720) but never the background.
    expect(marqueeSelection(page(), { x: 0, y: 100, width: 300, height: 200 })).toEqual([
      ids.image,
      ids.headline,
    ]);
    expect(marqueeSelection(page(), { x: 300, y: 300, width: -250, height: -250 })).toEqual([
      ids.image,
      ids.headline,
    ]);
    expect(marqueeSelection(page(), { x: 1040, y: 1040, width: 10, height: 10 })).toEqual([]);
  });

  it('a rotation gesture keeps the element turning about its centre and emits setRotation', () => {
    // The image box is 80,260 920×460; rotating its frame by 90° about the frame origin.
    const intent = frameTransformIntent(page(), ids.image, {
      x: 80,
      y: 260,
      width: 920,
      height: 460,
      rotation: 90,
    });
    expect(intent?.summary).toBe('Rotate Hero');
    const move = intent?.operations.find((o) => o.op === 'moveElement');
    // centre = origin + R(90°)·(460, 230) = (80 - 230, 260 + 460) → box top-left = centre − half size.
    expect(move).toMatchObject({ x: 80 - 230 - 460, y: 260 + 460 - 230 });
    expect(intent?.operations.at(-1)).toEqual({
      op: 'setRotation',
      pageId: 'page_1',
      elementId: ids.image,
      rotation: 90,
    });
    expect(
      frameTransformIntent(page(), ids.image, { x: 80, y: 260, width: 920, height: 460, rotation: 0 }),
    ).toBeNull();
    expect(
      frameTransformIntent(page(), ids.bg, { x: 0, y: 0, width: 10, height: 10, rotation: 5 }),
    ).toBeNull();
  });
});
