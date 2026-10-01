import { describe, expect, it } from 'vitest';
import {
  articleFirstParagraph,
  articlePlainText,
  pageText,
  renderArticleHtml,
  renderedValidationOk,
  safeArticleUrl,
  sanitizeArticleHtml,
  validateRenderedPage,
} from './article';
import { ARTICLE_BODY_MAX_CHARS, ArticleDocumentV1, CopyDocumentV1, copyDocumentKind } from './content';

const article = ArticleDocumentV1.parse({
  kind: 'article',
  title: 'Why ore & tar',
  slug: 'why-ore-and-tar',
  excerpt: 'A short answer.',
  blocks: [
    { type: 'heading', level: 2, text: 'The question' },
    { type: 'paragraph', text: 'Ore is heavy & tar is <sticky>.' },
    { type: 'list', ordered: true, items: ['one', 'two'] },
    { type: 'faq', question: 'Is it safe?', answer: 'Yes, "mostly".' },
  ],
  categories: ['Guides'],
  tags: ['ore', 'tar'],
});

describe('article document (ledger R2-3)', () => {
  it('a plain copy document parses exactly as before: no article key appears', () => {
    const copy = CopyDocumentV1.parse({ schemaVersion: 1, master: { text: 'Hello' } });
    expect(JSON.stringify(copy)).toBe('{"schemaVersion":1,"master":{"text":"Hello","factRefs":[]}}');
    expect(copyDocumentKind(copy)).toBe('text');
    expect(copyDocumentKind({ article })).toBe('article');
  });

  it('refuses a long title, a slug that is not a path segment and a body over the cap', () => {
    const base = { kind: 'article', title: 't', slug: 'ok-slug', blocks: [] };
    expect(ArticleDocumentV1.safeParse({ ...base, title: 'x'.repeat(201) }).success).toBe(false);
    expect(ArticleDocumentV1.safeParse({ ...base, slug: 'Not A Slug' }).success).toBe(false);
    expect(ArticleDocumentV1.safeParse({ ...base, slug: '-leading' }).success).toBe(false);
    const long = ArticleDocumentV1.safeParse({
      ...base,
      blocks: Array.from({ length: 6 }, () => ({ type: 'paragraph', text: 'y'.repeat(9000) })),
    });
    expect(long.success).toBe(false);
    if (!long.success)
      expect(long.error.issues[0]?.message).toBe(`body_too_long:54000>${ARTICLE_BODY_MAX_CHARS}`);
    expect(ArticleDocumentV1.safeParse(base).success).toBe(true);
  });

  it('renders blocks in order with every text escaped and a FAQ as a section', () => {
    expect(renderArticleHtml(article)).toBe(
      [
        '<h2>The question</h2>',
        '<p>Ore is heavy &amp; tar is &lt;sticky&gt;.</p>',
        '<ol><li>one</li><li>two</li></ol>',
        '<section class="faq"><h3>Is it safe?</h3><p>Yes, &quot;mostly&quot;.</p></section>',
      ].join('\n'),
    );
    expect(articleFirstParagraph(article)).toBe('Ore is heavy & tar is <sticky>.');
    expect(articlePlainText(article)).toContain('Is it safe?\nYes, "mostly".');
  });

  it('the sanitiser drops scripts, iframes, event handlers, styles and unsafe URLs and closes what is open', () => {
    const dirty =
      '<p onclick="x()" style="color:red">Hi <script>alert(1)</script><b>there</b>' +
      '<iframe src="https://evil.example"></iframe><a href="javascript:alert(1)">bad</a>' +
      '<a href="https://ok.example/p" target="_blank">ok</a><img src="data:x" alt="a">' +
      '<img src="https://ok.example/i.png" alt="pic"><custom>text</custom> 1 < 2 &amp; &copy;';
    expect(sanitizeArticleHtml(dirty)).toBe(
      '<p>Hi <b>there</b><a>bad</a><a href="https://ok.example/p" rel="noopener">ok</a><img alt="a">' +
        '<img src="https://ok.example/i.png" alt="pic">text 1 &lt; 2 &amp; &copy;</p>',
    );
    expect(sanitizeArticleHtml('<div><p>a</p></div></p>')).toBe('<p>a</p>');
    expect(sanitizeArticleHtml('<!-- c --><style>p{}</style>plain')).toBe('plain');
    expect(safeArticleUrl('//cdn.example/x')).toBeNull();
    expect(safeArticleUrl('/relative/path')).toBe('/relative/path');
    expect(safeArticleUrl('mailto:a@b.example')).toBe('mailto:a@b.example');
  });

  it('rendered-page checks: status, title in <title> or h1, canonical, noindex only for a draft, first paragraph', () => {
    const page = (extra: string, body = '<p>Ore is heavy &amp; tar is &lt;sticky&gt;.</p>') =>
      `<html><head><title>Why ore &amp; tar | Site</title>${extra}</head><body><h1>Other</h1>${body}</body></html>`;
    const live = { title: article.title, firstParagraph: articleFirstParagraph(article), draft: false };
    const ok = validateRenderedPage({
      status: 200,
      html: page('<link rel="canonical" href="https://site.example/why-ore-and-tar/">'),
      ...live,
    });
    expect(ok.every((c) => c.ok)).toBe(true);
    const bad = validateRenderedPage({
      status: 404,
      html: page('<meta name="robots" content="noindex">', '<p>Nothing</p>'),
      ...live,
    });
    expect(bad.map((c) => `${c.key}:${c.ok}`)).toEqual([
      'status_ok:false',
      'title_present:true',
      'canonical_present:false',
      'indexable:false',
      'body_present:false',
    ]);
    expect(renderedValidationOk(bad)).toBe(false);
    const draft = validateRenderedPage({
      status: 200,
      html: page('<meta name="robots" content="noindex, nofollow">'),
      ...live,
      draft: true,
    });
    expect(draft.find((c) => c.key === 'indexable')?.ok).toBe(true);
    expect(pageText('<p>A&nbsp;<b>B</b></p><script>x</script>')).toBe('a b');
  });
});
