import { useEffect, useRef, useState } from 'react';
import type { CreativePage, Element, Operation } from '@oremedia/contracts/creative';
import { findElement, findWithAncestors, isLockedInContext, type IntentBatch } from '@oremedia/editor';
import { Badge, Button, EmptyState, Field, Input, Textarea } from '@oremedia/ui';
import { Select } from '../../components/select';
import { elementTypeLabel } from './document-helpers';
import { isImageArea } from './element-factory';
import { newElementId } from '../../lib/ids';

export interface FontOption {
  assetVersionId: string;
  label: string;
}

/** A brand font face as the font picker lists it ("Inter Bold", "Lora 400"). */
export const toFontOption = (f: {
  assetVersionId: string;
  name: string;
  family?: string | null;
  subfamily?: string | null;
  weight?: number | null;
}): FontOption => ({
  assetVersionId: f.assetVersionId,
  label: [f.family ?? f.name, f.subfamily ?? (f.weight ? String(f.weight) : null)].filter(Boolean).join(' '),
});

export interface PropertiesPanelProps {
  page: CreativePage;
  selection: string[];
  readOnly: boolean;
  colourTokens: Array<{ key: string; value: string }>;
  /** The brand's font faces (STU-1a font picker); the current font stays listed when it is not one of them. */
  fonts: FontOption[];
  /** Asset versions whose file was generated (provenance): labelled as raster images. */
  generatedIds: ReadonlySet<string>;
  resolveAssetUrl: (assetVersionId: string) => string | null;
  onIntent: (batch: IntentBatch) => boolean;
  onSelect: (ids: string[]) => void;
  /** Set to focus the text field (Enter in the layers panel). */
  focusTextRequest: number;
}

/** A numeric field that commits on blur or Enter (Shift+arrow keys change the value by 10). */
export function NumberField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value]);
  const valid = (n: number) =>
    Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max);
  const commit = () => {
    const n = Number(draft);
    if (!valid(n)) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey) {
            e.preventDefault();
            const n = Number(draft) + (e.key === 'ArrowUp' ? 10 : -10);
            setDraft(String(n));
            if (valid(n)) onCommit(n);
          }
        }}
      />
    </Field>
  );
}

const ALIGNS: ReadonlyArray<{ align: Extract<Operation, { op: 'alignElements' }>['align']; label: string }> =
  [
    { align: 'left', label: 'Left' },
    { align: 'center', label: 'Centre' },
    { align: 'right', label: 'Right' },
    { align: 'top', label: 'Top' },
    { align: 'middle', label: 'Middle' },
    { align: 'bottom', label: 'Bottom' },
  ];

/** Align (and, for several elements, distribute) buttons: one alignElements / distributeElements operation each. */
function Arrange({
  page,
  ids,
  disabledReason,
  onIntent,
}: {
  page: CreativePage;
  ids: string[];
  disabledReason?: string;
  onIntent: (batch: IntentBatch) => boolean;
}) {
  const [relativeTo, setRelativeTo] = useState<'selection' | 'page'>(ids.length > 1 ? 'selection' : 'page');
  const to = ids.length > 1 ? relativeTo : 'page';
  return (
    <fieldset className="flex flex-col gap-2 border-t border-border pt-3">
      <legend className="text-xs font-medium text-muted-foreground">Align and distribute</legend>
      {ids.length > 1 && (
        <Select
          aria-label="Align relative to"
          size="sm"
          value={relativeTo}
          onValueChange={(v) => setRelativeTo(v as 'selection' | 'page')}
          options={[
            { value: 'selection', label: 'To the selection' },
            { value: 'page', label: 'To the page' },
          ]}
        />
      )}
      <div className="grid grid-cols-3 gap-1">
        {ALIGNS.map((a) => (
          <Button
            key={a.align}
            size="sm"
            disabledReason={disabledReason}
            aria-label={`Align ${a.label.toLowerCase()} to the ${to}`}
            onClick={() =>
              onIntent({
                operations: [
                  { op: 'alignElements', pageId: page.id, elementIds: ids, align: a.align, relativeTo: to },
                ],
                summary: `Align ${a.label.toLowerCase()} to the ${to}`,
                origin: 'user',
              })
            }
          >
            {a.label}
          </Button>
        ))}
      </div>
      {ids.length > 1 && (
        <div className="grid grid-cols-2 gap-1">
          {(['horizontal', 'vertical'] as const).map((axis) => (
            <Button
              key={axis}
              size="sm"
              disabledReason={
                disabledReason ??
                (to === 'selection' && ids.length < 3
                  ? 'Select three or more to distribute within them'
                  : undefined)
              }
              onClick={() =>
                onIntent({
                  operations: [
                    { op: 'distributeElements', pageId: page.id, elementIds: ids, axis, relativeTo: to },
                  ],
                  summary: `Distribute ${axis === 'horizontal' ? 'horizontally' : 'vertically'}`,
                  origin: 'user',
                })
              }
            >
              Distribute {axis === 'horizontal' ? 'horizontally' : 'vertically'}
            </Button>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** Several elements selected: arrange them, group them, or lock or remove them together. */
function MultiSelection({
  page,
  selection,
  readOnly,
  onIntent,
  onSelect,
}: Pick<PropertiesPanelProps, 'page' | 'selection' | 'readOnly' | 'onIntent' | 'onSelect'>) {
  const elements = selection.map((id) => findElement(page, id)).filter((e): e is Element => e !== null);
  const locked = elements.filter((e) => isLockedInContext(e, findWithAncestors(page, e.id)?.ancestors ?? []));
  const topLevel = elements.every((e) => page.elements.some((p) => p.id === e.id));
  const moveBlocked = readOnly
    ? 'This page is locked or read-only'
    : locked.length
      ? `Unlock ${locked.map((e) => e.name).join(', ')} first`
      : undefined;
  const group = () => {
    const groupId = newElementId();
    if (
      onIntent({
        operations: [{ op: 'groupElements', pageId: page.id, elementIds: selection, groupId }],
        summary: `Group ${elements.length} elements`,
        origin: 'user',
      })
    )
      onSelect([groupId]);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="properties" aria-live="polite">
      <p className="font-medium">{elements.length} elements selected</p>
      <ul className="flex flex-wrap gap-1 text-xs">
        {elements.map((e) => (
          <li key={e.id}>
            <Badge glyph={false}>{e.name}</Badge>
          </li>
        ))}
      </ul>
      <Arrange page={page} ids={selection} disabledReason={moveBlocked} onIntent={onIntent} />
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button
          size="sm"
          onClick={group}
          disabledReason={
            moveBlocked ??
            (!topLevel
              ? 'Only elements outside groups can be grouped'
              : elements.some((e) => e.type === 'background')
                ? 'A background cannot be grouped'
                : undefined)
          }
        >
          Group
        </Button>
        <Button
          size="sm"
          disabled={readOnly}
          onClick={() =>
            onIntent({
              operations: elements.map((e) => ({
                op: 'setLock',
                pageId: page.id,
                elementId: e.id,
                locked: true,
              })),
              summary: `Lock ${elements.length} elements`,
              origin: 'user',
            })
          }
        >
          Lock all
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabledReason={
            readOnly
              ? 'This page is read-only'
              : locked.length
                ? 'Unlock the locked elements first'
                : undefined
          }
          onClick={() =>
            onIntent({
              operations: elements.map((e) => ({ op: 'removeElement', pageId: page.id, elementId: e.id })),
              summary: `Remove ${elements.length} elements`,
              origin: 'user',
            })
          }
        >
          Remove all
        </Button>
      </div>
    </div>
  );
}

/** The natural size of an image file, for crop fields in percent of the original. */
function useNaturalSize(url: string | null): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    setSize(null);
    if (!url) return;
    const img = new Image();
    img.onload = () => setSize({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);
  return size;
}

/** STU-1a crop and mask editing: the crop is a region of the original in percent; the mask shapes the box. */
function CropAndMask({
  page,
  el,
  locked,
  url,
  onIntent,
}: {
  page: CreativePage;
  el: Extract<Element, { type: 'image' }>;
  locked: boolean;
  url: string | null;
  onIntent: (batch: IntentBatch) => boolean;
}) {
  const natural = useNaturalSize(url);
  const crop = el.crop ?? (natural ? { x: 0, y: 0, width: natural.width, height: natural.height } : null);
  const pct = (v: number, of: number) => Math.round((v / of) * 1000) / 10;
  const setCrop = (patch: Partial<{ x: number; y: number; width: number; height: number }>) => {
    if (!natural || !crop) return;
    const next = { ...crop, ...patch };
    next.width = Math.max(1, Math.min(next.width, natural.width - next.x));
    next.height = Math.max(1, Math.min(next.height, natural.height - next.y));
    onIntent({
      operations: [{ op: 'setCrop', pageId: page.id, elementId: el.id, crop: next }],
      summary: `Crop ${el.name}`,
      origin: 'user',
    });
  };
  const mask = (kind: string, radius?: number) =>
    onIntent({
      operations: [
        {
          op: 'setMask',
          pageId: page.id,
          elementId: el.id,
          mask:
            kind === 'none'
              ? null
              : { kind: kind as 'rect' | 'rounded' | 'circle', ...(radius !== undefined ? { radius } : {}) },
        },
      ],
      summary: kind === 'none' ? `Remove the mask of ${el.name}` : `Mask ${el.name}`,
      origin: 'user',
    });
  return (
    <fieldset className="flex flex-col gap-2 border-t border-border pt-3" data-testid="crop-mask">
      <legend className="text-xs font-medium text-muted-foreground">Crop and mask</legend>
      {!natural || !crop ? (
        <p className="text-xs text-muted-foreground">The crop can be set once the image has loaded.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            id="crop-x"
            label="Crop left (%)"
            value={pct(crop.x, natural.width)}
            min={0}
            max={99}
            disabled={locked}
            onCommit={(v) => setCrop({ x: Math.round((v / 100) * natural.width) })}
          />
          <NumberField
            id="crop-y"
            label="Crop top (%)"
            value={pct(crop.y, natural.height)}
            min={0}
            max={99}
            disabled={locked}
            onCommit={(v) => setCrop({ y: Math.round((v / 100) * natural.height) })}
          />
          <NumberField
            id="crop-w"
            label="Crop width (%)"
            value={pct(crop.width, natural.width)}
            min={1}
            max={100}
            disabled={locked}
            onCommit={(v) => setCrop({ width: Math.round((v / 100) * natural.width) })}
          />
          <NumberField
            id="crop-h"
            label="Crop height (%)"
            value={pct(crop.height, natural.height)}
            min={1}
            max={100}
            disabled={locked}
            onCommit={(v) => setCrop({ height: Math.round((v / 100) * natural.height) })}
          />
          <Button
            size="sm"
            className="col-span-2"
            disabled={locked || !el.crop}
            onClick={() => setCrop({ x: 0, y: 0, width: natural.width, height: natural.height })}
          >
            Show the whole image
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Mask" htmlFor="prop-mask">
          <Select
            id="prop-mask"
            value={el.mask?.kind ?? 'none'}
            disabled={locked}
            onValueChange={(v) => mask(v, v === 'rounded' ? (el.mask?.radius ?? 24) : undefined)}
            options={[
              { value: 'none', label: 'None' },
              { value: 'rect', label: 'Rectangle' },
              { value: 'rounded', label: 'Rounded corners' },
              { value: 'circle', label: 'Circle or oval' },
            ]}
          />
        </Field>
        {el.mask?.kind === 'rounded' && (
          <NumberField
            id="prop-mask-radius"
            label="Corner radius (px)"
            value={el.mask.radius ?? 0}
            min={0}
            max={4096}
            disabled={locked}
            onCommit={(radius) => mask('rounded', radius)}
          />
        )}
      </div>
    </fieldset>
  );
}

/** Spec 21.3 + STU-1a: numeric position, size and rotation; typography from the brand's fonts; crop and mask; locks. */
export function PropertiesPanel(props: PropertiesPanelProps) {
  const {
    page,
    selection,
    readOnly,
    colourTokens,
    fonts,
    generatedIds,
    resolveAssetUrl,
    onIntent,
    onSelect,
    focusTextRequest,
  } = props;
  const elementId = selection.length === 1 ? (selection[0] ?? null) : null;
  const el = elementId ? findElement(page, elementId) : null;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusTextRequest > 0) (textRef.current ?? headingRef.current)?.focus();
  }, [focusTextRequest, elementId]);

  if (selection.length > 1) return <MultiSelection {...props} readOnly={readOnly || page.locked === true} />;
  if (!el)
    return (
      <EmptyState
        title="Nothing selected"
        description="Select an element on the canvas or in the layers panel; Shift-click or drag a frame on the canvas to select several."
      />
    );

  const pageLocked = page.locked === true;
  const ancestors = findWithAncestors(page, el.id)?.ancestors ?? [];
  const inLockedGroup = ancestors.some((a) => a.locked);
  const lockedDeep = isLockedInContext(el, ancestors);
  const locked = el.locked || readOnly; // content edits stop when the element itself is locked
  const fixed = lockedDeep || readOnly || pageLocked; // position, size and rotation
  const one = (op: Operation, summary: string) => onIntent({ operations: [op], summary, origin: 'user' });
  const style = (patch: Record<string, unknown>, summary: string) =>
    one({ op: 'setStyle', pageId: page.id, elementId: el.id, patch }, summary);
  const t = el.transform;
  const topIndex = page.elements.findIndex((e) => e.id === el.id); // z-order = array order (spec 11.2)
  const generated =
    (el.type === 'image' || el.type === 'background') &&
    el.assetVersionId &&
    generatedIds.has(el.assetVersionId);
  const reorder = (toIndex: number, summary: string) =>
    one({ op: 'reorderElement', pageId: page.id, elementId: el.id, toIndex }, summary);

  return (
    <div className="flex flex-col gap-3" aria-live="polite" data-testid="properties">
      <div
        ref={headingRef}
        tabIndex={-1}
        className="flex flex-wrap items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="font-medium">{el.name}</span>
        <Badge glyph={false}>{elementTypeLabel[el.type]}</Badge>
        {el.protected && <Badge tone="info">Protected from agents</Badge>}
        {el.locked && <Badge tone="neutral">Locked</Badge>}
      </div>
      {(lockedDeep || pageLocked) && (
        <p className="rounded-md border border-border bg-muted p-2 text-xs" data-testid="lock-explanation">
          {pageLocked
            ? 'This page is locked: nothing on it can be moved, resized or rotated, and AI agents cannot change anything on it. Unlock the page in the page strip to change it.'
            : el.locked
              ? 'Locked: it cannot be moved, resized or rotated, and AI agents cannot change it at all (text, style, image, position or removal). You can still edit its content here; unlock it to move it.'
              : inLockedGroup
                ? 'It is inside a locked group: it cannot be moved, resized, rotated or removed, and AI agents cannot change it. Unlock the group to change it.'
                : 'Part of this group is locked, so the group cannot be moved, resized or removed and agents cannot change it.'}
        </p>
      )}
      {generated && (
        <p className="rounded-md border border-status-warning p-2 text-xs" data-testid="generated-label">
          Generated image — regenerate or replace to change its content. Its pixels cannot be edited like text
          or shapes.
        </p>
      )}
      {isImageArea(el) && (
        <p className="text-xs text-muted-foreground">
          Image area: choose a photo in the assets tab to fill it.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          id="prop-x"
          label="X"
          value={t.x}
          disabled={fixed}
          onCommit={(x) =>
            one({ op: 'moveElement', pageId: page.id, elementId: el.id, x, y: t.y }, `Move ${el.name}`)
          }
        />
        <NumberField
          id="prop-y"
          label="Y"
          value={t.y}
          disabled={fixed}
          onCommit={(y) =>
            one({ op: 'moveElement', pageId: page.id, elementId: el.id, x: t.x, y }, `Move ${el.name}`)
          }
        />
        <NumberField
          id="prop-w"
          label="Width"
          value={t.width}
          min={1}
          disabled={fixed}
          onCommit={(width) =>
            one(
              {
                op: 'resizeElement',
                pageId: page.id,
                elementId: el.id,
                width,
                height:
                  el.type === 'logo'
                    ? Math.max(1, Math.round((width / (t.width / t.height)) * 100) / 100)
                    : t.height,
              },
              `Resize ${el.name}`,
            )
          }
        />
        <NumberField
          id="prop-h"
          label="Height"
          value={t.height}
          min={1}
          disabled={fixed || el.type === 'logo'}
          onCommit={(height) =>
            one(
              { op: 'resizeElement', pageId: page.id, elementId: el.id, width: t.width, height },
              `Resize ${el.name}`,
            )
          }
        />
        <NumberField
          id="prop-rotation"
          label="Rotation (°)"
          value={t.rotation}
          min={-360}
          max={360}
          disabled={fixed || el.type === 'logo' || el.type === 'group' || el.type === 'background'}
          onCommit={(rotation) =>
            one({ op: 'setRotation', pageId: page.id, elementId: el.id, rotation }, `Rotate ${el.name}`)
          }
        />
        {el.type !== 'text' && (
          <NumberField
            id="prop-opacity"
            label="Opacity (0–1)"
            value={el.opacity}
            min={0}
            max={1}
            step={0.05}
            disabled={locked}
            onCommit={(opacity) => style({ opacity }, `Fade ${el.name}`)}
          />
        )}
      </div>
      {el.type === 'logo' && (
        <p className="text-xs text-muted-foreground">
          Logos keep their aspect ratio and are never rotated; change the width. Variant {el.variant}: replace
          the asset from the assets tab.
        </p>
      )}
      {el.type === 'group' && (
        <p className="text-xs text-muted-foreground">Rotate the elements inside a group one by one.</p>
      )}

      {el.type === 'text' && (
        <>
          <Field
            label="Text"
            htmlFor="prop-text"
            hint="Double-click the text on the canvas to edit it in place."
          >
            <Textarea
              ref={textRef}
              id="prop-text"
              value={el.text}
              disabled={locked}
              maxLength={5000}
              rows={3}
              onChange={(e) =>
                one(
                  { op: 'setText', pageId: page.id, elementId: el.id, text: e.target.value },
                  `Edit ${el.name}`,
                )
              }
            />
          </Field>
          <fieldset className="grid grid-cols-2 gap-2" data-testid="typography">
            <legend className="col-span-2 text-xs font-medium text-muted-foreground">Typography</legend>
            <Field label="Font" htmlFor="prop-font" className="col-span-2">
              <Select
                id="prop-font"
                value={el.style.fontAssetVersionId}
                disabled={locked}
                onValueChange={(fontAssetVersionId) =>
                  style({ fontAssetVersionId }, `Change the font of ${el.name}`)
                }
                options={[
                  ...fonts.map((f) => ({ value: f.assetVersionId, label: f.label })),
                  ...(fonts.some((f) => f.assetVersionId === el.style.fontAssetVersionId)
                    ? []
                    : [
                        {
                          value: el.style.fontAssetVersionId,
                          label: 'Current font (not in the brand fonts)',
                        },
                      ]),
                ]}
              />
            </Field>
            <NumberField
              id="prop-size"
              label="Size (px)"
              value={el.style.sizePx}
              min={1}
              disabled={locked}
              onCommit={(sizePx) => style({ sizePx }, `Resize text ${el.name}`)}
            />
            <NumberField
              id="prop-weight"
              label="Weight"
              value={el.style.weight}
              min={100}
              max={900}
              step={100}
              disabled={locked}
              onCommit={(weight) => style({ weight }, `Restyle ${el.name}`)}
            />
            <NumberField
              id="prop-lh"
              label="Line height"
              value={el.style.lineHeight}
              min={0.5}
              step={0.05}
              disabled={locked}
              onCommit={(lineHeight) => style({ lineHeight }, `Restyle ${el.name}`)}
            />
            <NumberField
              id="prop-tracking"
              label="Tracking (em)"
              value={el.style.tracking}
              min={-0.5}
              max={2}
              step={0.01}
              disabled={locked}
              onCommit={(tracking) => style({ tracking }, `Restyle ${el.name}`)}
            />
            <Field label="Align" htmlFor="prop-align">
              <Select
                id="prop-align"
                value={el.style.align}
                disabled={locked}
                onValueChange={(align) => style({ align }, `Align ${el.name}`)}
                options={['left', 'center', 'right', 'justify'].map((v) => ({ value: v, label: v }))}
              />
            </Field>
            <Field label="Overflow" htmlFor="prop-overflow">
              <Select
                id="prop-overflow"
                value={el.style.overflow}
                disabled={locked}
                onValueChange={(overflow) => style({ overflow }, `Restyle ${el.name}`)}
                options={[
                  { value: 'error', label: 'Report overflow' },
                  { value: 'shrink_to_fit', label: 'Shrink to fit' },
                  { value: 'clip', label: 'Clip' },
                ]}
              />
            </Field>
            <Field label="Colour token" htmlFor="prop-colour" className="col-span-2">
              <Select
                id="prop-colour"
                value={el.style.colourToken ?? '__none'}
                disabled={locked}
                onValueChange={(v) =>
                  style({ colourToken: v === '__none' ? undefined : v }, `Recolour ${el.name}`)
                }
                options={[
                  { value: '__none', label: el.style.colourValue ? `raw ${el.style.colourValue}` : 'none' },
                  ...colourTokens.map((c) => ({ value: c.key, label: `${c.key} (${c.value})` })),
                ]}
              />
            </Field>
          </fieldset>
        </>
      )}
      {el.type === 'image' && (
        <>
          <Field label="Fit" htmlFor="prop-fit">
            <Select
              id="prop-fit"
              value={el.fit}
              disabled={locked}
              onValueChange={(fit) => style({ fit }, `Refit ${el.name}`)}
              options={['cover', 'contain', 'fill'].map((v) => ({ value: v, label: v }))}
            />
          </Field>
          <CropAndMask
            page={page}
            el={el}
            locked={locked}
            url={resolveAssetUrl(el.assetVersionId)}
            onIntent={onIntent}
          />
        </>
      )}
      {(el.type === 'shape' || el.type === 'background') && (
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Fill token"
            htmlFor="prop-fill"
            className={el.type === 'background' ? 'col-span-2' : undefined}
          >
            <Select
              id="prop-fill"
              value={el.fillToken ?? '__none'}
              disabled={locked}
              onValueChange={(v) =>
                style({ fillToken: v === '__none' ? undefined : v }, `Recolour ${el.name}`)
              }
              options={[
                { value: '__none', label: 'none' },
                ...colourTokens.map((c) => ({ value: c.key, label: `${c.key} (${c.value})` })),
              ]}
            />
          </Field>
          {el.type === 'shape' && el.shape === 'rect' && (
            <NumberField
              id="prop-radius"
              label="Corner radius"
              value={el.cornerRadius}
              min={0}
              disabled={locked}
              onCommit={(cornerRadius) => style({ cornerRadius }, `Round ${el.name}`)}
            />
          )}
        </div>
      )}
      {!readOnly && el.type !== 'background' && (
        <Arrange
          page={page}
          ids={[el.id]}
          disabledReason={fixed ? 'Locked elements and pages cannot be moved' : undefined}
          onIntent={onIntent}
        />
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {topIndex >= 0 && (
            <>
              <Button
                size="sm"
                disabled={topIndex >= page.elements.length - 1}
                onClick={() => reorder(topIndex + 1, `Bring ${el.name} forward`)}
              >
                Bring forward
              </Button>
              <Button
                size="sm"
                disabled={topIndex <= 0}
                onClick={() => reorder(topIndex - 1, `Send ${el.name} backward`)}
              >
                Send backward
              </Button>
              <Button
                size="sm"
                disabled={topIndex >= page.elements.length - 1}
                onClick={() => reorder(page.elements.length - 1, `Bring ${el.name} to front`)}
              >
                To front
              </Button>
              <Button
                size="sm"
                disabled={topIndex <= 0}
                onClick={() => reorder(0, `Send ${el.name} to back`)}
              >
                To back
              </Button>
            </>
          )}
          {el.type === 'group' && topIndex >= 0 && (
            <Button
              size="sm"
              disabledReason={el.locked ? 'Unlock the group first' : undefined}
              onClick={() => {
                if (one({ op: 'ungroupElement', pageId: page.id, elementId: el.id }, `Ungroup ${el.name}`))
                  onSelect(el.children.map((c) => c.id));
              }}
            >
              Ungroup
            </Button>
          )}
          <Button
            size="sm"
            aria-pressed={el.locked}
            onClick={() =>
              one(
                { op: 'setLock', pageId: page.id, elementId: el.id, locked: !el.locked },
                `${el.locked ? 'Unlock' : 'Lock'} ${el.name}`,
              )
            }
          >
            {el.locked ? 'Unlock' : 'Lock'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabledReason={
              lockedDeep ? 'Locked elements are not removed: unlock it (or its group) first' : undefined
            }
            onClick={() =>
              one({ op: 'removeElement', pageId: page.id, elementId: el.id }, `Remove ${el.name}`)
            }
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

export const isTextElement = (el: Element | null): boolean => el?.type === 'text';
