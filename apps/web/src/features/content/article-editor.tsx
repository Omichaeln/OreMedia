import { Button, Field, Input, Textarea, toneTextClass } from '@oremedia/ui';
import {
  ARTICLE_BLOCKS_MAX,
  ARTICLE_SLUG_PATTERN,
  ARTICLE_TITLE_MAX,
  ArticleDocumentV1,
  type ArticleBlockV1,
} from '@oremedia/contracts/content';
import { Select } from '../../components/select';

/** What the editor holds between keystrokes: the document with its terms as comma-separated text. */
export interface ArticleDraft {
  title: string;
  slug: string;
  excerpt: string;
  blocks: ArticleBlockV1[];
  categories: string;
  tags: string;
}

export const emptyArticleDraft = (): ArticleDraft => ({
  title: '',
  slug: '',
  excerpt: '',
  blocks: [{ type: 'paragraph', text: '' }],
  categories: '',
  tags: '',
});

export const articleToDraft = (a: ArticleDocumentV1): ArticleDraft => ({
  title: a.title,
  slug: a.slug,
  excerpt: a.excerpt,
  blocks: a.blocks.map((b) => ({ ...b })),
  categories: a.categories.join(', '),
  tags: a.tags.join(', '),
});

/** The CMS's slug rule: lower-case words joined by hyphens, as a person would type a path segment. */
export const slugify = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);

const terms = (text: string): string[] => [
  ...new Set(
    text
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];

/** The draft as the server parses it, or the first problems by field (the server re-checks on save). */
export function parseArticleDraft(
  draft: ArticleDraft,
): { ok: true; article: ArticleDocumentV1 } | { ok: false; issues: Record<string, string> } {
  const parsed = ArticleDocumentV1.safeParse({
    kind: 'article',
    title: draft.title.trim(),
    slug: draft.slug.trim(),
    excerpt: draft.excerpt.trim(),
    blocks: draft.blocks,
    categories: terms(draft.categories),
    tags: terms(draft.tags),
  });
  if (parsed.success) return { ok: true, article: parsed.data };
  const issues: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.');
    const key = path.startsWith('blocks') ? 'blocks' : path || 'article';
    if (!issues[key]) issues[key] = issue.message === 'Required' ? 'Required' : issue.message;
  }
  return { ok: false, issues };
}

const BLOCK_OPTIONS = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'heading', label: 'Heading' },
  { value: 'list', label: 'List' },
  { value: 'faq', label: 'FAQ (question and answer)' },
];
const HEADING_OPTIONS = [
  { value: '2', label: 'Heading 2' },
  { value: '3', label: 'Heading 3' },
  { value: '4', label: 'Heading 4' },
];
const newBlock = (type: ArticleBlockV1['type']): ArticleBlockV1 => {
  switch (type) {
    case 'paragraph':
      return { type, text: '' };
    case 'heading':
      return { type, level: 2, text: '' };
    case 'list':
      return { type, ordered: false, items: [''] };
    case 'faq':
      return { type, question: '', answer: '' };
  }
};
const BLOCK_LABEL: Record<ArticleBlockV1['type'], string> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  list: 'List',
  faq: 'FAQ',
};

function BlockFields({
  block,
  idPrefix,
  onChange,
}: {
  block: ArticleBlockV1;
  idPrefix: string;
  onChange: (next: ArticleBlockV1) => void;
}) {
  switch (block.type) {
    case 'paragraph':
      return (
        <Field label="Text" htmlFor={`${idPrefix}-text`}>
          <Textarea
            id={`${idPrefix}-text`}
            value={block.text}
            onChange={(e) => onChange({ ...block, text: e.target.value })}
            rows={3}
          />
        </Field>
      );
    case 'heading':
      return (
        <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
          <Field label="Level" htmlFor={`${idPrefix}-level`}>
            <Select
              id={`${idPrefix}-level`}
              value={String(block.level)}
              onValueChange={(v) => onChange({ ...block, level: Number(v) as 2 | 3 | 4 })}
              options={HEADING_OPTIONS}
            />
          </Field>
          <Field label="Heading" htmlFor={`${idPrefix}-text`}>
            <Input
              id={`${idPrefix}-text`}
              value={block.text}
              onChange={(e) => onChange({ ...block, text: e.target.value })}
              maxLength={300}
            />
          </Field>
        </div>
      );
    case 'list':
      return (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={block.ordered}
              onChange={(e) => onChange({ ...block, ordered: e.target.checked })}
            />
            Numbered list
          </label>
          <Field label="Items" htmlFor={`${idPrefix}-items`} hint="One item per line.">
            <Textarea
              id={`${idPrefix}-items`}
              value={block.items.join('\n')}
              onChange={(e) => onChange({ ...block, items: e.target.value.split('\n') })}
              rows={3}
            />
          </Field>
        </div>
      );
    case 'faq':
      return (
        <div className="flex flex-col gap-2">
          <Field label="Question" htmlFor={`${idPrefix}-question`}>
            <Input
              id={`${idPrefix}-question`}
              value={block.question}
              onChange={(e) => onChange({ ...block, question: e.target.value })}
              maxLength={500}
            />
          </Field>
          <Field label="Answer" htmlFor={`${idPrefix}-answer`}>
            <Textarea
              id={`${idPrefix}-answer`}
              value={block.answer}
              onChange={(e) => onChange({ ...block, answer: e.target.value })}
              rows={3}
            />
          </Field>
        </div>
      );
  }
}

export interface ArticleEditorProps {
  draft: ArticleDraft;
  onChange: (next: ArticleDraft) => void;
  idPrefix: string;
  /** Problems the last parse found, by field (`title`, `slug`, `blocks`…). */
  issues?: Record<string, string>;
}

/**
 * Ledger R2-3: the article document a website package carries (title, slug, excerpt, the body as an ordered list
 * of blocks with FAQ blocks, the terms it is filed under). Blocks are added, removed and moved by buttons, so the
 * whole editor works from the keyboard; the slug follows the title until it is edited by hand. Rendering to HTML
 * happens on the server in one place (article.ts); nothing here produces markup.
 */
export function ArticleEditor({ draft, onChange, idPrefix, issues = {} }: ArticleEditorProps) {
  // The slug follows the title until it was edited by hand (it then differs from the title's slug).
  const slugTouched = draft.slug !== '' && draft.slug !== slugify(draft.title);
  const setBlock = (i: number, next: ArticleBlockV1) =>
    onChange({ ...draft, blocks: draft.blocks.map((b, j) => (j === i ? next : b)) });
  const move = (i: number, by: -1 | 1) => {
    const blocks = [...draft.blocks];
    const j = i + by;
    if (j < 0 || j >= blocks.length) return;
    [blocks[i], blocks[j]] = [blocks[j] as ArticleBlockV1, blocks[i] as ArticleBlockV1];
    onChange({ ...draft, blocks });
  };
  return (
    <div className="flex flex-col gap-3" data-testid="article-editor">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" htmlFor={`${idPrefix}-title`} error={issues['title']}>
          <Input
            id={`${idPrefix}-title`}
            value={draft.title}
            onChange={(e) =>
              onChange({
                ...draft,
                title: e.target.value,
                slug: slugTouched ? draft.slug : slugify(e.target.value),
              })
            }
            maxLength={ARTICLE_TITLE_MAX}
          />
        </Field>
        <Field
          label="Slug"
          htmlFor={`${idPrefix}-slug`}
          hint="The page's path segment: lower-case words joined by hyphens."
          error={
            issues['slug'] ??
            (draft.slug && !ARTICLE_SLUG_PATTERN.test(draft.slug)
              ? 'Lower-case words joined by hyphens'
              : undefined)
          }
        >
          <Input
            id={`${idPrefix}-slug`}
            value={draft.slug}
            onChange={(e) => onChange({ ...draft, slug: e.target.value })}
            maxLength={200}
          />
        </Field>
      </div>
      <Field
        label="Excerpt"
        htmlFor={`${idPrefix}-excerpt`}
        hint="Shown in listings and used as the caption of the package's channel variants."
        error={issues['excerpt']}
      >
        <Textarea
          id={`${idPrefix}-excerpt`}
          value={draft.excerpt}
          onChange={(e) => onChange({ ...draft, excerpt: e.target.value })}
          rows={2}
        />
      </Field>
      <fieldset className="flex flex-col gap-2" data-testid="article-blocks">
        <legend className="text-xs font-medium text-muted-foreground">
          Body ({draft.blocks.length} block{draft.blocks.length === 1 ? '' : 's'})
        </legend>
        {issues['blocks'] && (
          <p className={`text-xs ${toneTextClass.critical}`} role="alert">
            {issues['blocks']}
          </p>
        )}
        <ol className="flex flex-col gap-2" aria-label="Article blocks">
          {draft.blocks.map((block, i) => (
            <li
              key={i}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
              data-testid="article-block"
              data-block-type={block.type}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">
                  {i + 1}. {BLOCK_LABEL[block.type]}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move block ${i + 1} up`}
                >
                  Up
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => move(i, 1)}
                  disabled={i === draft.blocks.length - 1}
                  aria-label={`Move block ${i + 1} down`}
                >
                  Down
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onChange({ ...draft, blocks: draft.blocks.filter((_, j) => j !== i) })}
                  aria-label={`Remove block ${i + 1}`}
                >
                  Remove
                </Button>
              </div>
              <BlockFields
                block={block}
                idPrefix={`${idPrefix}-block-${i}`}
                onChange={(next) => setBlock(i, next)}
              />
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add a block" htmlFor={`${idPrefix}-add`}>
            <AddBlock
              id={`${idPrefix}-add`}
              disabled={draft.blocks.length >= ARTICLE_BLOCKS_MAX}
              onAdd={(type) => onChange({ ...draft, blocks: [...draft.blocks, newBlock(type)] })}
            />
          </Field>
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Categories"
          htmlFor={`${idPrefix}-categories`}
          hint="Comma-separated, as the website names them."
          error={issues['categories']}
        >
          <Input
            id={`${idPrefix}-categories`}
            value={draft.categories}
            onChange={(e) => onChange({ ...draft, categories: e.target.value })}
          />
        </Field>
        <Field label="Tags" htmlFor={`${idPrefix}-tags`} hint="Comma-separated." error={issues['tags']}>
          <Input
            id={`${idPrefix}-tags`}
            value={draft.tags}
            onChange={(e) => onChange({ ...draft, tags: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}

function AddBlock({
  id,
  disabled,
  onAdd,
}: {
  id: string;
  disabled: boolean;
  onAdd: (type: ArticleBlockV1['type']) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Select
        id={id}
        value=""
        placeholder="Choose a block type"
        onValueChange={(v) => onAdd(v as ArticleBlockV1['type'])}
        options={BLOCK_OPTIONS}
        disabled={disabled}
        aria-label="Block type to add"
      />
    </div>
  );
}

/** A read-only rendering of an article's structure (the revision as it is), without producing HTML. */
export function ArticleSummary({ article }: { article: ArticleDocumentV1 }) {
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="article-summary">
      <p>
        <span className="font-medium">{article.title}</span>{' '}
        <code className="text-xs text-muted-foreground">/{article.slug}</code>
      </p>
      {article.excerpt && <p className="text-muted-foreground">{article.excerpt}</p>}
      <ol className="flex flex-col gap-1" aria-label="Article body">
        {article.blocks.map((b, i) => (
          <li key={i} className="text-xs" data-block-type={b.type}>
            <span className="text-muted-foreground">{BLOCK_LABEL[b.type]}:</span>{' '}
            {b.type === 'list'
              ? b.items.join(' · ')
              : b.type === 'faq'
                ? `${b.question} — ${b.answer}`
                : b.text}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {article.categories.length ? `Categories: ${article.categories.join(', ')}` : 'No categories'}
        {article.tags.length ? ` · Tags: ${article.tags.join(', ')}` : ''}
      </p>
    </div>
  );
}
