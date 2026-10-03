import { useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CreativeDocumentV1, Element, SemanticRole } from '@oremedia/contracts/creative';
import { formatFor } from '@oremedia/editor';
import { Badge, Button, Field, Input, StatusBanner } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { useTRPC, useTRPCClient } from '../../lib/trpc';
import { intentContext, newIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';

/** A slot row in the dialog: inferred from an element's semantic role, editable before saving. */
interface SlotRow {
  include: boolean;
  key: string;
  elementId: string;
  elementName: string;
  kind: string;
  required: boolean;
  maxLength: string;
}

const TEXT_ROLES: ReadonlySet<SemanticRole> = new Set(['headline', 'body', 'cta', 'price', 'legal']);

/** The slot kind an element fills: enforced kinds by element type; an image area (shape) is a legacy kind. */
function slotKind(el: Element): string | null {
  if (el.type === 'text') return el.semanticRole && TEXT_ROLES.has(el.semanticRole) ? 'text' : null;
  if (el.type === 'image' || el.type === 'logo' || el.type === 'background') return el.type;
  if (el.type === 'shape' && el.semanticRole === 'product') return 'image_area';
  return null;
}

/**
 * STU-1a: slots inferred from semantic roles (headline, body, CTA, price, legal text; images, logos, backgrounds,
 * image areas), keyed by role and numbered when a role repeats; the headline is required.
 */
export function inferSlots(doc: CreativeDocumentV1): SlotRow[] {
  const counts = new Map<string, number>();
  const rows: SlotRow[] = [];
  const walk = (els: Element[]) => {
    for (const el of els) {
      if (el.type === 'group') {
        walk(el.children);
        continue;
      }
      const kind = slotKind(el);
      if (!kind) continue;
      const base = el.semanticRole ?? el.type;
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      rows.push({
        include: true,
        key: n === 1 ? base : `${base}_${n}`,
        elementId: el.id,
        elementName: el.name,
        kind,
        required: base === 'headline' && n === 1,
        maxLength: '',
      });
    }
  };
  for (const p of doc.pages) walk(p.elements);
  return rows;
}

/** "Save as template": a draft template version of the committed document; a brand manager approves it. */
export function SaveAsTemplateDialog({
  brandId,
  title,
  document,
  onClose,
}: {
  brandId: string;
  title: string;
  document: CreativeDocumentV1;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState(title);
  const [rows, setRows] = useState<SlotRow[]>(() => inferSlots(document));
  const [state, setState] = useState<
    { kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string }
  >({
    kind: 'idle',
  });
  const formats = useMemo(
    () => [...new Set(document.pages.map((p) => p.formatKey))].filter((k) => formatFor(k)),
    [document],
  );
  const included = rows.filter((r) => r.include);
  const keys = included.map((r) => r.key.trim());
  const duplicate = keys.find((k, i) => keys.indexOf(k) !== i);
  const invalid = !name.trim()
    ? 'Name the template'
    : keys.some((k) => !k)
      ? 'Every included slot needs a key'
      : duplicate
        ? `Slot key "${duplicate}" is used twice`
        : null;
  const update = (i: number, patch: Partial<SlotRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    setState({ kind: 'saving' });
    try {
      const created = await client.creative.templates.create.mutate(
        { brandId, name: name.trim() },
        intentContext(newIntentKey()),
      );
      await client.creative.templates.createVersion.mutate(
        {
          templateId: created.templateId,
          document,
          formats,
          slots: included.map((r) => ({
            key: r.key.trim(),
            elementId: r.elementId,
            kind: r.kind,
            required: r.required,
            replaceable: true,
            constraints:
              r.kind === 'text' && Number(r.maxLength) > 0
                ? { maxLength: Math.round(Number(r.maxLength)) }
                : {},
          })),
        },
        intentContext(newIntentKey()),
      );
      void queryClient.invalidateQueries(trpc.creative.templates.pathFilter());
      setState({ kind: 'saved' });
    } catch (err) {
      setState({ kind: 'error', message: toUiError(err).message });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Save as template"
        description="The saved revision becomes a draft template version. It appears in the creation gallery once a brand manager approves it."
        className="w-[min(92vw,40rem)]"
      >
        {state.kind === 'saved' ? (
          <div className="flex flex-col gap-3">
            <StatusBanner
              tone="good"
              title="Template saved as a draft"
              description="Approve it in the templates tab (brand managers) to offer it in the gallery."
            />
            <DialogActions>
              <DialogClose asChild>
                <Button variant="primary">Done</Button>
              </DialogClose>
            </DialogActions>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
            <Field label="Template name" htmlFor="template-name">
              <Input
                id="template-name"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              Formats: {formats.length ? formats.join(', ') : 'none recognised'} · {document.pages.length}{' '}
              page
              {document.pages.length === 1 ? '' : 's'}
            </p>
            <fieldset className="flex flex-col gap-2" data-testid="template-slots">
              <legend className="text-sm font-medium">Slots</legend>
              {rows.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No element has a role yet (headline, body, logo, image…); the template is saved without
                  slots.
                </p>
              )}
              {rows.map((r, i) => (
                <div
                  key={r.elementId}
                  className="grid grid-cols-[auto_1fr] items-center gap-2 rounded-md border border-border p-2 sm:grid-cols-[auto_1fr_auto_auto]"
                >
                  <input
                    type="checkbox"
                    id={`slot-include-${i}`}
                    checked={r.include}
                    onChange={(e) => update(i, { include: e.target.checked })}
                    aria-label={`Include ${r.elementName} as a slot`}
                  />
                  <div className="flex min-w-0 flex-col gap-1">
                    <label htmlFor={`slot-key-${i}`} className="truncate text-xs text-muted-foreground">
                      {r.elementName} <Badge glyph={false}>{r.kind}</Badge>
                    </label>
                    <Input
                      id={`slot-key-${i}`}
                      value={r.key}
                      disabled={!r.include}
                      maxLength={80}
                      className="h-8"
                      onChange={(e) => update(i, { key: e.target.value })}
                    />
                  </div>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={r.required}
                      disabled={!r.include}
                      onChange={(e) => update(i, { required: e.target.checked })}
                    />
                    Required
                  </label>
                  {r.kind === 'text' ? (
                    <Input
                      aria-label={`Maximum length of ${r.key}`}
                      placeholder="Max chars"
                      type="number"
                      min={1}
                      max={5000}
                      value={r.maxLength}
                      disabled={!r.include}
                      className="h-8 w-24"
                      onChange={(e) => update(i, { maxLength: e.target.value })}
                    />
                  ) : (
                    <span />
                  )}
                </div>
              ))}
            </fieldset>
            {state.kind === 'error' && (
              <StatusBanner tone="critical" title="The template was not saved" description={state.message} />
            )}
            <DialogActions>
              <DialogClose asChild>
                <Button type="button">Cancel</Button>
              </DialogClose>
              <Button
                type="submit"
                variant="primary"
                disabled={state.kind === 'saving'}
                disabledReason={invalid ?? undefined}
              >
                {state.kind === 'saving' ? 'Saving…' : 'Save template'}
              </Button>
            </DialogActions>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
