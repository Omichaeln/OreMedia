import { describe, expect, it } from 'vitest';
import { ARTICLE_BODY_MAX_CHARS, type ArticleDocumentV1 } from '@oremedia/contracts/content';
import { articlePlainText } from '@oremedia/contracts/article';
import { articleTextIssues } from './articles';

const article: ArticleDocumentV1 = {
  kind: 'article',
  title: 'Why ore and tar last',
  slug: 'why-ore-and-tar-last',
  excerpt: '',
  blocks: [{ type: 'paragraph', text: 'Ore is heavy and tar is sticky.' }],
  categories: [],
  tags: [],
};

describe('articleTextIssues (an edit override is the HTML the site receives)', () => {
  it('the variant text itself, or an override with a body, raises nothing', () => {
    expect(articleTextIssues({ article, text: articlePlainText(article) })).toEqual([]);
    expect(articleTextIssues({ article, text: '<p>Corrected.</p>' })).toEqual([]);
    expect(articleTextIssues({ article: null, text: '' })).toEqual([]);
  });

  it('an override that sanitises to nothing, or exceeds the article limit, is an issue', () => {
    expect(articleTextIssues({ article, text: '<script>alert(1)</script>  ' })).toEqual([
      { path: 'text', issue: 'body_empty' },
    ]);
    const issues = articleTextIssues({ article, text: `<p>${'x'.repeat(ARTICLE_BODY_MAX_CHARS)}</p>` });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.issue).toMatch(/^body_too_long:/);
  });
});
