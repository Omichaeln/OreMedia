import Konva from 'konva';
import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  FormatDefinition,
  Operation,
  OperationBatch,
} from '@oremedia/contracts/creative';
import type { EditorAdapter, EditorHandle, Unsubscribe } from './adapter';
import { formatFor } from './formats';
import { findElement, footprintOf, isLockedDeep } from './reduce';
import { buildScene, type SceneContext, type SceneHandle } from './renderer/scene';

/** A batch without its base revision: the application owns the committed document and decides when to send it. */
export type IntentBatch = Omit<OperationBatch, 'baseRevisionId'>;

// ---------------------------------------------------------------------------------------------------------------
// Gesture → operation mapping. Pure, unit-tested without a DOM: the stage only reports positions and sizes.
// ---------------------------------------------------------------------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Locked, hidden and background elements are not draggable in the UI; the server guard is the real policy. Groups
 * are draggable (moveElement translates their page-absolute children, see reduce.ts) but not resized or rotated on
 * the canvas; a group holding a locked element is pinned.
 */
export function isInteractive(el: Element, readOnly: boolean): boolean {
  return !readOnly && el.visible && !isLockedDeep(el) && el.type !== 'background';
}

/** Shift-click: adds an element to the selection or takes it out. */
export function toggleSelection(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id];
}

/**
 * Marquee selection: the visible top-level elements (backgrounds excepted) whose footprint the dragged rectangle
 * touches, in paint order. Locked ones are selected too, so their lock can be seen and explained.
 */
export function marqueeSelection(
  page: CreativePage,
  rect: { x: number; y: number; width: number; height: number },
): string[] {
  const r = {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
  return page.elements
    .filter((el) => el.visible && el.type !== 'background')
    .filter((el) => {
      const f = footprintOf(el.transform);
      return f.x < r.x + r.width && f.x + f.width > r.x && f.y < r.y + r.height && f.y + f.height > r.y;
    })
    .map((el) => el.id);
}

/**
 * A transformer gesture on one element's frame node (the unrotated box, scene.ts): the node was moved to (x, y),
 * scaled and rotated by `rotation` degrees about its own origin. The element keeps rotating about its centre, so
 * the new centre is the node origin plus the rotated half-size; the box follows from it.
 */
export function frameTransformIntent(
  page: CreativePage,
  elementId: string,
  node: { x: number; y: number; width: number; height: number; rotation: number },
): IntentBatch | null {
  const el = findElement(page, elementId);
  if (!el || el.locked) return null;
  if (!node.rotation) return transformIntent(page, elementId, node);
  const rad = (node.rotation * Math.PI) / 180;
  const cx = node.x + (node.width / 2) * Math.cos(rad) - (node.height / 2) * Math.sin(rad);
  const cy = node.y + (node.width / 2) * Math.sin(rad) + (node.height / 2) * Math.cos(rad);
  const box = { x: cx - node.width / 2, y: cy - node.height / 2, width: node.width, height: node.height };
  const moved = transformIntent(page, elementId, box);
  let rotation = round2(el.transform.rotation + node.rotation);
  while (rotation > 180) rotation -= 360;
  while (rotation <= -180) rotation += 360;
  const operations: Operation[] = [...(moved?.operations ?? [])];
  if (rotation !== el.transform.rotation)
    operations.push({ op: 'setRotation', pageId: page.id, elementId, rotation });
  if (operations.length === 0) return null;
  return { operations, summary: `Rotate ${el.name}`, origin: 'user' };
}

export function moveIntent(page: CreativePage, elementId: string, x: number, y: number): IntentBatch | null {
  const el = findElement(page, elementId);
  if (!el || el.locked) return null;
  const nx = round2(x);
  const ny = round2(y);
  if (nx === el.transform.x && ny === el.transform.y) return null;
  return {
    operations: [{ op: 'moveElement', pageId: page.id, elementId, x: nx, y: ny }],
    summary: `Move ${el.name}`,
    origin: 'user',
  };
}

/** Keyboard path (spec 21.3): arrow keys nudge by 1px, 10px with shift; the app decides the step. */
export function nudgeIntent(
  page: CreativePage,
  elementId: string,
  dx: number,
  dy: number,
): IntentBatch | null {
  const el = findElement(page, elementId);
  if (!el) return null;
  return moveIntent(page, elementId, el.transform.x + dx, el.transform.y + dy);
}

/** Logos keep their aspect ratio whatever the gesture (spec 11.5: logo distortion is a blocking check). */
export function resizeIntent(
  page: CreativePage,
  elementId: string,
  width: number,
  height: number,
): IntentBatch | null {
  const el = findElement(page, elementId);
  if (!el || el.locked) return null;
  let w = Math.max(1, round2(width));
  let h = Math.max(1, round2(height));
  if (el.type === 'logo') {
    const ratio = el.transform.width / el.transform.height;
    h = round2(w / ratio);
    if (h < 1) {
      h = 1;
      w = round2(ratio);
    }
  }
  if (w === el.transform.width && h === el.transform.height) return null;
  return {
    operations: [{ op: 'resizeElement', pageId: page.id, elementId, width: w, height: h }],
    summary: `Resize ${el.name}`,
    origin: 'user',
  };
}

/** A transform gesture can move and resize at once; only the operations that change something are emitted. */
export function transformIntent(
  page: CreativePage,
  elementId: string,
  box: { x: number; y: number; width: number; height: number },
): IntentBatch | null {
  const el = findElement(page, elementId);
  if (!el) return null;
  const operations: Operation[] = [];
  const move = moveIntent(page, elementId, box.x, box.y);
  const resize = resizeIntent(page, elementId, box.width, box.height);
  if (move) operations.push(...move.operations);
  if (resize) operations.push(...resize.operations);
  if (operations.length === 0) return null;
  return { operations, summary: resize ? `Resize ${el.name}` : `Move ${el.name}`, origin: 'user' };
}

/** The scene needs a format for safe areas; a page whose format key is unknown falls back to its own dimensions. */
export function formatForPage(page: CreativePage): FormatDefinition {
  return (
    formatFor(page.formatKey) ?? {
      key: page.formatKey,
      label: page.formatKey,
      width: page.width,
      height: page.height,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      providerKeys: [],
    }
  );
}

/** Scale that fits a page into a viewport, never enlarging beyond 1:1. */
export function fitScale(
  page: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(1, viewport.width / page.width, viewport.height / page.height);
}

// ---------------------------------------------------------------------------------------------------------------
// The adapter. State lives OUTSIDE the stage: the app owns the committed document plus its pending batch and
// passes the document it wants shown through mount/applyRemote; the stage only renders and translates gestures.
// ---------------------------------------------------------------------------------------------------------------

export interface KonvaAdapterOptions {
  /** Spec 9.3: the app resolves signed URLs; the adapter never fetches. */
  resolveAssetUrl?: (assetVersionId: string) => string | null;
  /** The CSS family a document font ref was loaded under; null renders the fallback and reports missingFont. */
  fontFamilyFor?: (fontRef: string) => string | null;
  /** Brand colour token → #rrggbb (from the brand snapshot the document is designed against). */
  colourFor?: (token: string) => string | null;
  /** The page to show first; defaults to the first page. */
  pageId?: string;
}

export interface KonvaEditorHandle extends EditorHandle {
  /** Spec 11.1 page/format strip: switch the page the stage shows. */
  setPage(pageId: string): void;
  /** Re-fit the page into the container (after a layout change). */
  fit(): void;
  getSelection(): string[];
  getPageId(): string;
  onSelectionChange(cb: (elementIds: string[]) => void): Unsubscribe;
  /** Double-click on a text element: the app focuses the side text field (spec 21.3 keyboard path). */
  onEditText(cb: (elementId: string) => void): Unsubscribe;
}

export class KonvaEditorAdapter implements EditorAdapter {
  private readonly options: KonvaAdapterOptions;

  constructor(options: KonvaAdapterOptions = {}) {
    this.options = options;
  }

  mount(container: HTMLElement, doc: CreativeDocumentV1, opts: { readOnly: boolean }): KonvaEditorHandle {
    return new MountedStage(container, doc, opts.readOnly, this.options);
  }
}

class MountedStage implements KonvaEditorHandle {
  private doc: CreativeDocumentV1;
  private pageId: string;
  private readonly readOnly: boolean;
  private readonly container: HTMLElement;
  private readonly options: KonvaAdapterOptions;
  private readonly stage: Konva.Stage;
  private readonly layer: Konva.Layer;
  private readonly overlay: Konva.Layer;
  private readonly transformer: Konva.Transformer;
  private scene: SceneHandle | null = null;
  private selection: string[] = [];
  private readonly marquee: Konva.Rect;
  private marqueeStart: { x: number; y: number } | null = null;
  private readonly intentSubscribers = new Set<(batch: IntentBatch) => void>();
  private readonly selectionSubscribers = new Set<(ids: string[]) => void>();
  private readonly editTextSubscribers = new Set<(id: string) => void>();
  private destroyed = false;

  constructor(
    container: HTMLElement,
    doc: CreativeDocumentV1,
    readOnly: boolean,
    options: KonvaAdapterOptions,
  ) {
    this.container = container;
    this.doc = doc;
    this.readOnly = readOnly;
    this.options = options;
    this.pageId =
      options.pageId && doc.pages.some((p) => p.id === options.pageId)
        ? options.pageId
        : (doc.pages[0]?.id ?? '');
    this.stage = new Konva.Stage({
      container: container as HTMLDivElement,
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
    });
    this.layer = new Konva.Layer();
    this.overlay = new Konva.Layer();
    this.transformer = new Konva.Transformer({
      rotateEnabled: true,
      rotationSnaps: [0, 45, 90, 135, 180, 225, 270, 315],
      rotationSnapTolerance: 4,
      ignoreStroke: true,
      borderStrokeWidth: 1,
      anchorSize: 8,
    });
    this.marquee = new Konva.Rect({
      visible: false,
      fill: 'rgba(37, 99, 235, 0.08)',
      stroke: 'rgb(37, 99, 235)',
      strokeWidth: 1,
      strokeScaleEnabled: false,
      listening: false,
    });
    this.overlay.add(this.transformer);
    this.overlay.add(this.marquee);
    this.stage.add(this.layer);
    this.stage.add(this.overlay);
    // One batch for the whole gesture: every node the transformer moved, scaled or rotated.
    this.transformer.on('transformend', () => this.emitTransform());
    this.wireMarquee();
    this.rebuild();
  }

  private page(): CreativePage | undefined {
    return this.doc.pages.find((p) => p.id === this.pageId) ?? this.doc.pages[0];
  }

  private sceneContext(page: CreativePage): SceneContext {
    return {
      format: formatForPage(page),
      resolveAssetUrl: this.options.resolveAssetUrl ?? (() => null),
      fontFamilyFor: this.options.fontFamilyFor ?? (() => null),
      colourFor: this.options.colourFor ?? (() => null),
    };
  }

  private rebuild(): void {
    if (this.destroyed) return;
    this.transformer.nodes([]);
    this.scene?.destroy();
    this.scene = null;
    this.layer.destroyChildren();
    const page = this.page();
    if (!page) {
      this.layer.batchDraw();
      return;
    }
    const scene = buildScene(this.layer, page, this.sceneContext(page));
    this.scene = scene;
    for (const [id, node] of scene.nodes) this.wire(page, id, node);
    this.fit();
    this.applySelection();
    // Images arrive asynchronously; the scene asks for a draw once they are laid out.
    void scene.ready().then(() => {
      if (this.scene === scene && !this.destroyed) this.layer.batchDraw();
    });
  }

  /** Pointer position in page pixels (the stage is scaled to fit). */
  private pagePointer(): { x: number; y: number } | null {
    const p = this.stage.getPointerPosition();
    if (!p) return null;
    const scale = this.stage.scaleX() || 1;
    return { x: p.x / scale, y: p.y / scale };
  }

  /** A press on the empty canvas (or the background) starts a marquee; a click without a drag clears the selection. */
  private wireMarquee(): void {
    this.stage.on('mousedown touchstart', (e) => {
      if (e.target !== this.stage) return;
      this.marqueeStart = this.pagePointer();
    });
    this.stage.on('mousemove touchmove', () => {
      if (!this.marqueeStart) return;
      const p = this.pagePointer();
      if (!p) return;
      this.marquee.setAttrs({
        visible: true,
        x: Math.min(this.marqueeStart.x, p.x),
        y: Math.min(this.marqueeStart.y, p.y),
        width: Math.abs(p.x - this.marqueeStart.x),
        height: Math.abs(p.y - this.marqueeStart.y),
      });
      this.overlay.batchDraw();
    });
    this.stage.on('mouseup touchend', (e) => {
      const start = this.marqueeStart;
      this.marqueeStart = null;
      if (!start) return;
      const dragged = this.marquee.visible() && this.marquee.width() > 3 && this.marquee.height() > 3;
      const rect = {
        x: this.marquee.x(),
        y: this.marquee.y(),
        width: this.marquee.width(),
        height: this.marquee.height(),
      };
      this.marquee.visible(false);
      this.overlay.batchDraw();
      const page = this.page();
      if (!page) return;
      if (!dragged) {
        if (!e.evt.shiftKey) this.setSelection([]);
        return;
      }
      const hits = marqueeSelection(page, rect);
      this.setSelection(e.evt.shiftKey ? [...new Set([...this.selection, ...hits])] : hits);
    });
  }

  private interactiveOn(page: CreativePage, el: Element): boolean {
    return isInteractive(el, this.readOnly || page.locked === true);
  }

  private wire(page: CreativePage, id: string, node: Konva.Node): void {
    const el = findElement(page, id);
    if (!el) return;
    const interactive = this.interactiveOn(page, el);
    // The scene builds every node non-listening (the worker never needs hit graphs); the studio switches them on.
    const listening = el.visible && el.type !== 'background';
    node.listening(listening);
    if (node instanceof Konva.Container)
      for (const child of node.find(() => true)) child.listening(listening);
    // Children of a group are picked through the group (shift-click or the layers panel reaches them).
    const topLevel = page.elements.some((e) => e.id === id);
    node.draggable(interactive && topLevel);
    if (!topLevel) return;
    node.on('click tap', (e) => {
      e.cancelBubble = true;
      const shift = 'shiftKey' in e.evt && e.evt.shiftKey;
      this.setSelection(shift ? toggleSelection(this.selection, id) : [id]);
    });
    if (el.type === 'text')
      node.on('dblclick dbltap', () => {
        for (const cb of this.editTextSubscribers) cb(id);
      });
    if (!interactive) return;
    node.on('dragstart', () => {
      if (!this.selection.includes(id)) this.setSelection([id]);
    });
    node.on('dragend', () => {
      const current = this.currentPage();
      if (el.type === 'group') {
        // A group node sits at the origin (its children are page-absolute): its offset is the move.
        const intent = moveIntent(current, id, el.transform.x + node.x(), el.transform.y + node.y());
        node.position({ x: 0, y: 0 });
        this.emit(intent);
        return;
      }
      this.emit(moveIntent(current, id, node.x(), node.y()));
    });
    node.on('mouseenter', () => this.stage.container().style.setProperty('cursor', 'move'));
    node.on('mouseleave', () => this.stage.container().style.removeProperty('cursor'));
  }

  /** The transformer finished: one batch with the move/resize/rotation of every node it held. */
  private emitTransform(): void {
    const page = this.currentPage();
    const operations: Operation[] = [];
    const names: string[] = [];
    for (const node of this.transformer.nodes()) {
      const id = node.id();
      const el = findElement(page, id);
      if (!el || el.type === 'group') continue;
      const box = {
        x: node.x(),
        y: node.y(),
        width: node.width() * node.scaleX(),
        height: node.height() * node.scaleY(),
        rotation: node.rotation(),
      };
      node.scale({ x: 1, y: 1 });
      node.rotation(0);
      const intent = frameTransformIntent(page, id, box);
      if (intent) {
        operations.push(...intent.operations);
        names.push(el.name);
      }
    }
    if (operations.length === 0) return;
    const rotated = operations.some((o) => o.op === 'setRotation');
    const resized = operations.some((o) => o.op === 'resizeElement');
    const verb = rotated ? 'Rotate' : resized ? 'Resize' : 'Move';
    this.emit({
      operations,
      summary: `${verb} ${names.length === 1 ? names[0] : `${names.length} elements`}`,
      origin: 'user',
    });
  }

  private currentPage(): CreativePage {
    const page = this.page();
    if (!page) throw new Error('editor has no page');
    return page;
  }

  private emit(batch: IntentBatch | null): void {
    if (!batch) return;
    for (const cb of this.intentSubscribers) cb(batch);
  }

  private setSelection(ids: string[]): void {
    const same = ids.length === this.selection.length && ids.every((id, i) => id === this.selection[i]);
    this.selection = ids;
    this.applySelection();
    if (!same) for (const cb of this.selectionSubscribers) cb([...ids]);
  }

  private applySelection(): void {
    const page = this.page();
    const nodes: Konva.Node[] = [];
    let keepRatio = false;
    let rotatable = true;
    let resizable = true;
    if (page && this.scene)
      for (const id of this.selection) {
        const el = findElement(page, id);
        const node = this.scene.nodes.get(id);
        if (el && node && this.interactiveOn(page, el) && page.elements.some((e) => e.id === id)) {
          nodes.push(node);
          if (el.type === 'logo') {
            keepRatio = true;
            rotatable = false; // logos are never rotated (brand check logo_rotated)
          }
          if (el.type === 'group') {
            rotatable = false;
            resizable = false;
          }
        }
      }
    this.transformer.keepRatio(keepRatio);
    this.transformer.rotateEnabled(rotatable);
    this.transformer.enabledAnchors(
      !resizable
        ? []
        : keepRatio
          ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
          : [
              'top-left',
              'top-center',
              'top-right',
              'middle-left',
              'middle-right',
              'bottom-left',
              'bottom-center',
              'bottom-right',
            ],
    );
    this.transformer.nodes(nodes);
    this.overlay.batchDraw();
  }

  onIntent(cb: (batch: IntentBatch) => void): Unsubscribe {
    this.intentSubscribers.add(cb);
    return () => this.intentSubscribers.delete(cb);
  }

  onSelectionChange(cb: (elementIds: string[]) => void): Unsubscribe {
    this.selectionSubscribers.add(cb);
    return () => this.selectionSubscribers.delete(cb);
  }

  onEditText(cb: (elementId: string) => void): Unsubscribe {
    this.editTextSubscribers.add(cb);
    return () => this.editTextSubscribers.delete(cb);
  }

  applyRemote(doc: CreativeDocumentV1): void {
    this.doc = doc;
    if (!doc.pages.some((p) => p.id === this.pageId)) this.pageId = doc.pages[0]?.id ?? '';
    this.rebuild();
  }

  select(elementIds: string[]): void {
    this.setSelection([...elementIds]);
  }

  getSelection(): string[] {
    return [...this.selection];
  }

  getPageId(): string {
    return this.pageId;
  }

  setPage(pageId: string): void {
    if (pageId === this.pageId || !this.doc.pages.some((p) => p.id === pageId)) return;
    this.pageId = pageId;
    this.selection = [];
    this.rebuild();
    for (const cb of this.selectionSubscribers) cb([]);
  }

  fit(): void {
    const page = this.page();
    if (!page || this.destroyed) return;
    const scale = fitScale(page, { width: this.container.clientWidth, height: this.container.clientHeight });
    this.stage.scale({ x: scale, y: scale });
    this.stage.size({
      width: Math.max(1, Math.round(page.width * scale)),
      height: Math.max(1, Math.round(page.height * scale)),
    });
    this.stage.batchDraw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.intentSubscribers.clear();
    this.selectionSubscribers.clear();
    this.editTextSubscribers.clear();
    this.scene?.destroy();
    this.scene = null;
    this.stage.destroy();
  }
}
