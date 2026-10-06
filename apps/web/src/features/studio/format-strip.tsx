import { useState } from 'react';
import type { CreativeDocumentV1, CreativePage } from '@oremedia/contracts/creative';
import { FORMAT_DEFINITIONS, type IntentBatch } from '@oremedia/editor';
import { Button, cn } from '@oremedia/ui';
import { Select } from '../../components/select';
import { newElementId } from '../../lib/ids';
import { freshIdMap } from './element-factory';

const newPageId = (): string => `page_${newElementId().slice(3, 19).toLowerCase()}`;

/** A new empty page in the same format, keeping the current page's background colour. */
function emptyPageLike(page: CreativePage, name: string): CreativePage {
  const bg = page.elements.find((e) => e.type === 'background');
  return {
    id: newPageId(),
    name,
    formatKey: page.formatKey,
    width: page.width,
    height: page.height,
    elements: bg ? [{ ...structuredClone(bg), id: newElementId(), locked: false }] : [],
    layoutConstraints: [],
  };
}

export interface FormatStripProps {
  doc: CreativeDocumentV1;
  pageId: string;
  readOnly: boolean;
  onSelectPage: (id: string) => void;
  onIntent: (batch: IntentBatch) => void;
}

/** Spec 11.1 page and format strip; spec 11.3 createFormatVariant reflows via constraints (never scales blindly). */
export function FormatStrip({ doc, pageId, readOnly, onSelectPage, onIntent }: FormatStripProps) {
  const [formatKey, setFormatKey] = useState('ig_story_9x16');
  const formats = Object.values(FORMAT_DEFINITIONS);
  const index = doc.pages.findIndex((p) => p.id === pageId);
  const page = doc.pages[index];
  const full = doc.pages.length >= 20 ? 'A document has at most 20 pages' : undefined;
  const intent = (operations: IntentBatch['operations'], summary: string) =>
    onIntent({ operations, summary, origin: 'user' });
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next =
        doc.pages[(index + (e.key === 'ArrowRight' ? 1 : doc.pages.length - 1)) % doc.pages.length];
      if (next) onSelectPage(next.id);
    }
  };
  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-t border-border bg-card px-4 py-2"
      data-testid="page-strip"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Pages and formats"
          className="flex flex-wrap gap-1"
          onKeyDown={onKeyDown}
          data-testid="format-strip"
        >
          {doc.pages.map((p, i) => {
            const active = p.id === pageId;
            return (
              <button
                key={p.id}
                role="tab"
                type="button"
                aria-selected={active}
                aria-label={`${i + 1}. ${p.name}, ${p.width}×${p.height}${p.locked ? ', locked' : ''}`}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelectPage(p.id)}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-accent bg-secondary font-medium'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {i + 1}. {p.name}
                <span className="ml-1 text-muted-foreground">
                  {p.width}×{p.height}
                </span>
                {p.locked && (
                  <span className="ml-1" aria-hidden="true">
                    🔒
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {!readOnly && page && (
        <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Page actions">
          <Button
            size="sm"
            variant="ghost"
            disabledReason={full}
            onClick={() => {
              const added = emptyPageLike(page, `Page ${doc.pages.length + 1}`);
              intent([{ op: 'addPage', page: added, index: index + 1 }], 'Add a page');
              onSelectPage(added.id);
            }}
          >
            Add page
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabledReason={full}
            onClick={() => {
              const newId = newPageId();
              intent(
                [{ op: 'duplicatePage', pageId: page.id, newPageId: newId, elementIdMap: freshIdMap(page) }],
                `Duplicate ${page.name}`,
              );
              onSelectPage(newId);
            }}
          >
            Duplicate page
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabledReason={index <= 0 ? 'Already the first page' : undefined}
            onClick={() =>
              intent(
                [{ op: 'reorderPage', pageId: page.id, toIndex: index - 1 }],
                `Move ${page.name} earlier`,
              )
            }
          >
            Move earlier
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabledReason={index >= doc.pages.length - 1 ? 'Already the last page' : undefined}
            onClick={() =>
              intent([{ op: 'reorderPage', pageId: page.id, toIndex: index + 1 }], `Move ${page.name} later`)
            }
          >
            Move later
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={page.locked === true}
            onClick={() =>
              intent(
                [{ op: 'setPageLock', pageId: page.id, locked: !page.locked }],
                `${page.locked ? 'Unlock' : 'Lock'} ${page.name}`,
              )
            }
          >
            {page.locked ? 'Unlock page' : 'Lock page'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabledReason={
              doc.pages.length <= 1
                ? 'A document keeps at least one page'
                : page.locked
                  ? 'Unlock the page to remove it'
                  : undefined
            }
            onClick={() => {
              const next = doc.pages[index + 1] ?? doc.pages[index - 1];
              intent([{ op: 'removePage', pageId: page.id }], `Remove ${page.name}`);
              if (next) onSelectPage(next.id);
            }}
          >
            Remove page
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="variant-format" className="text-xs text-muted-foreground">
              Add format variant
            </label>
            <Select
              id="variant-format"
              size="sm"
              value={formatKey}
              onValueChange={setFormatKey}
              className="w-52"
              options={formats.map((f) => ({ value: f.key, label: `${f.label} (${f.width}×${f.height})` }))}
            />
            <Button
              size="sm"
              disabledReason={full}
              onClick={() =>
                intent(
                  [{ op: 'createFormatVariant', sourcePageId: pageId, formatKey }],
                  `Create ${FORMAT_DEFINITIONS[formatKey]?.label ?? formatKey} variant`,
                )
              }
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
