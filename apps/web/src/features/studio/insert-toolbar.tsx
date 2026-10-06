import type { CreativePage, Element } from '@oremedia/contracts/creative';
import type { IntentBatch } from '@oremedia/editor';
import { Button } from '@oremedia/ui';
import { newBackgroundElement, newShapeElement, newTextElement, type BrandKit } from './element-factory';

export interface InsertToolbarProps {
  page: CreativePage;
  kit: BrandKit | null;
  readOnly: boolean;
  onIntent: (batch: IntentBatch) => boolean;
  /** The new element is selected so it can be moved and edited at once. */
  onInserted: (elementId: string) => void;
}

/**
 * STU-1a: insert text, shapes and a background with brand tokens and fonts (images and logos come from the assets
 * tab). Every insert is one insertElement operation, the same one an agent would use.
 */
export function InsertToolbar({ page, kit, readOnly, onIntent, onInserted }: InsertToolbarProps) {
  const hasBackground = page.elements.some((e) => e.type === 'background');
  const insert = (element: Element | null, index?: number) => {
    if (!element) return;
    const ok = onIntent({
      operations: [
        { op: 'insertElement', pageId: page.id, element, ...(index !== undefined ? { index } : {}) },
      ],
      summary: `Insert ${element.name.toLowerCase()}`,
      origin: 'user',
    });
    if (ok) onInserted(element.id);
  };
  const noFont =
    kit && kit.typeRoles.length === 0 ? 'Add fonts to the brand system (type roles) first' : undefined;
  const blocked = readOnly ? 'This page cannot be edited' : !kit ? 'Loading the brand system' : undefined;
  return (
    <div
      role="toolbar"
      aria-label="Insert"
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-card px-3 py-1.5"
      data-testid="insert-toolbar"
    >
      <span className="mr-1 text-xs text-muted-foreground">Insert</span>
      <Button
        size="sm"
        variant="ghost"
        disabledReason={blocked ?? noFont}
        onClick={() => kit && insert(newTextElement(page, kit, 'heading'))}
      >
        Heading
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabledReason={blocked ?? noFont}
        onClick={() => kit && insert(newTextElement(page, kit, 'body'))}
      >
        Text
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabledReason={blocked}
        onClick={() => kit && insert(newShapeElement(page, kit, 'rect'))}
      >
        Rectangle
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabledReason={blocked}
        onClick={() => kit && insert(newShapeElement(page, kit, 'ellipse'))}
      >
        Ellipse
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabledReason={blocked}
        onClick={() => kit && insert(newShapeElement(page, kit, 'line'))}
      >
        Line
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabledReason={
          blocked ??
          (hasBackground ? 'The page has a background; change its colour in the properties' : undefined)
        }
        onClick={() => kit && insert(newBackgroundElement(page, kit), 0)}
      >
        Background
      </Button>
    </div>
  );
}
