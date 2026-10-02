import { describe, expect, it } from 'vitest';
import {
  articleFirstParagraph,
  articleHtmlChars,
  articleLastParagraph,
  articlePlainText,
  canonicalMatches,
  pageText,
  renderArticleHtml,
  renderedValidationOk,
  safeArticleUrl,
  sanitizeArticleHtml,
  validateRenderedPage,
} from './article';
import {
  ARTICLE_BODY_MAX_CHARS,
  ARTICLE_EXCERPT_MAX,
  ARTICLE_TEXT_MAX_CHARS,
  ARTICLE_TITLE_MAX,
  ArticleDocumentV1,
  CHANNEL_VARIANT_TEXT_MAX_CHARS,
  ChannelVariantUpdate,
  CopyDocumentV1,
  copyDocumentKind,
} from './content';
import { PublicationEditRemote } from './publishing';

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
    const page = (
      extra: string,
      body = '<p>Ore is heavy &amp; tar is &lt;sticky&gt;.</p><p>Yes, &quot;mostly&quot;.</p>',
    ) =>
      `<html><head><title>Why ore &amp; tar | Site</title>${extra}</head><body><h1>Other</h1>${body}</body></html>`;
    const live = {
      title: article.title,
      firstParagraph: articleFirstParagraph(article),
      lastParagraph: articleLastParagraph(article),
      slug: article.slug,
      remoteUrl: 'https://site.example/why-ore-and-tar/',
      draft: false,
    };
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
      'canonical_matches:false',
      'last_paragraph_present:false',
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

  it('rendered-page checks (RA-04): the canonical must name this page and the last paragraph must be present', () => {
    const live = {
      title: article.title,
      firstParagraph: articleFirstParagraph(article),
      lastParagraph: articleLastParagraph(article),
      slug: article.slug,
      remoteUrl: 'https://site.example/?p=42',
      draft: false,
    };
    const page = (canonical: string, body: string) =>
      `<html><head><title>Why ore &amp; tar</title><link rel="canonical" href="${canonical}"></head><body>${body}</body></html>`;
    const full = renderArticleHtml(article);
    const checksOf = (html: string) =>
      Object.fromEntries(validateRenderedPage({ status: 200, html, ...live }).map((c) => [c.key, c.ok]));
    expect(checksOf(page('https://site.example/why-ore-and-tar/', full))).toMatchObject({
      canonical_present: true,
      canonical_matches: true, // the slug's path on the site
      body_present: true,
      last_paragraph_present: true,
    });
    expect(checksOf(page('https://site.example/?p=42', full))).toMatchObject({ canonical_matches: true });
    expect(checksOf(page('https://other.example/why-ore-and-tar/', full))).toMatchObject({
      canonical_present: true,
      canonical_matches: false, // another site
    });
    // A later paragraph changed on the page: the first paragraph still passes, the last does not.
    const changed = full.replace('Yes, &quot;mostly&quot;.', 'No, never.');
    expect(checksOf(page('https://site.example/why-ore-and-tar/', changed))).toMatchObject({
      body_present: true,
      last_paragraph_present: false,
    });
    expect(articleLastParagraph(article)).toBe('Yes, "mostly".');
    expect(articleLastParagraph({ blocks: [{ type: 'list', ordered: false, items: ['a', 'b'] }] })).toBe('b');
    expect(articleLastParagraph({ blocks: [] })).toBe('');
    expect(canonicalMatches(null, 'https://site.example/x/', 'x')).toBe(false);
    expect(canonicalMatches('https://SITE.example/x', 'https://site.example/x/', 'x')).toBe(true);
    expect(canonicalMatches('not a url', 'https://site.example/x/', 'x')).toBe(false);
  });

  it('one article text cap everywhere (RA-03): the body measured as text, the variant and the remote edit at the article cap', () => {
    expect(ARTICLE_TEXT_MAX_CHARS).toBeGreaterThan(
      ARTICLE_BODY_MAX_CHARS + ARTICLE_TITLE_MAX + ARTICLE_EXCERPT_MAX,
    );
    // The plain text of a body at the cap fits the text cap with its title, excerpt and separators.
    const atCap = ArticleDocumentV1.parse({
      ...article,
      title: 't'.repeat(ARTICLE_TITLE_MAX),
      excerpt: 'e'.repeat(ARTICLE_EXCERPT_MAX),
      blocks: Array.from({ length: 5 }, () => ({ type: 'paragraph', text: 'x'.repeat(10_000) })),
    });
    const text = articlePlainText(atCap);
    expect(text.length).toBeGreaterThan(CHANNEL_VARIANT_TEXT_MAX_CHARS);
    expect(text.length).toBeLessThanOrEqual(ARTICLE_TEXT_MAX_CHARS);
    const update = {
      channelVariantId: 'cv_1',
      expectedVersion: 0,
      altTexts: [],
      settings: {},
      exportIds: [],
    };
    expect(ChannelVariantUpdate.safeParse({ ...update, text }).success).toBe(true);
    expect(
      ChannelVariantUpdate.safeParse({ ...update, text: 'x'.repeat(ARTICLE_TEXT_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(PublicationEditRemote.safeParse({ publicationId: 'pub_1', text }).success).toBe(true);
    expect(
      PublicationEditRemote.safeParse({
        publicationId: 'pub_1',
        text: 'x'.repeat(ARTICLE_TEXT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    // A body given as HTML is measured as the text it renders, never as its markup.
    expect(articleHtmlChars('<p>Ore &amp; tar</p><ul><li>one</li></ul>')).toBe(
      'Ore & tar'.length + 'one'.length,
    );
    expect(articleHtmlChars(`<p>${'x'.repeat(ARTICLE_BODY_MAX_CHARS)}</p>`)).toBe(ARTICLE_BODY_MAX_CHARS);
  });
});

// ---- RA-08: rich blocks, images and the featured image ----
import {
  ARTICLE_IMAGES_MAX,
  ArticleBlockV1,
  articleBlockText,
  articleBodyChars,
  articleImages,
  faqAnswerText,
} from './content';
import { renderArticleBlock } from './article';

const rich = ArticleDocumentV1.parse({
  kind: 'article',
  v: 2,
  title: 'How ore is weighed',
  slug: 'how-ore-is-weighed',
  excerpt: 'Scales.',
  featuredImage: { assetVersionId: 'av_feat', alt: 'A weighbridge' },
  blocks: [
    { type: 'paragraph', text: 'Every load is weighed twice.' },
    { type: 'image', assetVersionId: 'av_1', alt: 'The <bridge>', caption: 'North gate' },
    { type: 'link', href: 'https://acme.example/scales?a=1&b=2', text: '' },
    { type: 'link', href: 'https://acme.example/certified', text: 'Certified "scales"' },
    { type: 'quote', text: 'Weigh twice.', cite: 'Foreman' },
    {
      type: 'faq',
      question: 'What is tare?',
      answer: 'The empty weight.\nSubtracted from the gross.',
      answerBlocks: [
        { type: 'paragraph', text: 'The empty weight.' },
        { type: 'list', items: ['Subtracted from the gross.'] },
      ],
    },
    { type: 'image', assetVersionId: 'av_2', alt: 'Last image, no caption' },
  ],
});

describe('rich article documents (RA-08)', () => {
  it('a plain article still parses, hashes and renders exactly as before: no new key appears', () => {
    const plain = ArticleDocumentV1.parse({
      kind: 'article',
      title: 'T',
      slug: 't',
      blocks: [{ type: 'faq', question: 'Q?', answer: 'A.' }],
    });
    expect(Object.keys(plain).sort()).toEqual([
      'blocks',
      'categories',
      'excerpt',
      'kind',
      'slug',
      'tags',
      'title',
    ]);
    expect(Object.keys(plain.blocks[0] as object)).toEqual(['type', 'question', 'answer']);
    expect(renderArticleHtml(plain)).toBe('<section class="faq"><h3>Q?</h3><p>A.</p></section>');
    expect(articleLastParagraph(plain)).toBe('A.');
    expect(articlePlainText(plain)).toBe('T\n\nQ?\nA.');
    expect(articleBodyChars(plain.blocks)).toBe(4);
  });

  it('renders links, quotes, images and rich FAQ answers deterministically, with and without image addresses', () => {
    const noUrls = renderArticleHtml(rich);
    expect(noUrls).toBe(
      [
        '<p>Every load is weighed twice.</p>',
        '<figure><img alt="The &lt;bridge&gt;"><figcaption>North gate</figcaption></figure>',
        '<p><a href="https://acme.example/scales?a=1&amp;b=2" rel="noopener">https://acme.example/scales?a=1&amp;b=2</a></p>',
        '<p><a href="https://acme.example/certified" rel="noopener">Certified &quot;scales&quot;</a></p>',
        '<blockquote><p>Weigh twice.</p><p><em>Foreman</em></p></blockquote>',
        '<section class="faq"><h3>What is tare?</h3><p>The empty weight.</p><ul><li>Subtracted from the gross.</li></ul></section>',
        '<figure><img alt="Last image, no caption"></figure>',
      ].join('\n'),
    );
    expect(renderArticleHtml(rich)).toBe(noUrls); // same input, same bytes
    const urls = new Map([
      ['av_1', 'https://site.example/wp-content/uploads/how-ore-is-weighed-2.png'],
      ['av_2', 'https://site.example/wp-content/uploads/how-ore-is-weighed-3.png'],
    ]);
    const withUrls = renderArticleHtml(rich, { imageUrl: (i) => urls.get(i.assetVersionId) ?? null });
    expect(withUrls).toContain(
      '<figure><img src="https://site.example/wp-content/uploads/how-ore-is-weighed-2.png" alt="The &lt;bridge&gt;"><figcaption>North gate</figcaption></figure>',
    );
    // Only the image addresses differ between the two renderings (what a review manifest's hash leaves out).
    expect(withUrls.replace(/ src="[^"]*"/g, '')).toBe(noUrls);
    // A resolver that hands back an unsafe address loses it to the sanitiser, never to the page.
    expect(renderArticleHtml(rich, { imageUrl: () => 'javascript:alert(1)' })).toBe(noUrls);
    expect(renderArticleBlock({ type: 'quote', text: 'q' })).toBe('<blockquote><p>q</p></blockquote>');
  });

  it('plain text, first and last paragraph cover the new blocks (alt text is never page text)', () => {
    expect(articlePlainText(rich)).toBe(
      [
        'How ore is weighed',
        'Scales.',
        'Every load is weighed twice.',
        'The <bridge>\nNorth gate',
        'https://acme.example/scales?a=1&b=2',
        'Certified "scales"',
        'Weigh twice.\nForeman',
        'What is tare?\nThe empty weight.\nSubtracted from the gross.',
        'Last image, no caption',
      ].join('\n\n'),
    );
    expect(articleFirstParagraph(rich)).toBe('Every load is weighed twice.');
    // The last block is an image without a caption: the page's last text is the FAQ answer's last line.
    expect(articleLastParagraph(rich)).toBe('Subtracted from the gross.');
    expect(articleLastParagraph({ blocks: [rich.blocks[1] as ArticleBlockV1] })).toBe('North gate');
    // A quote ends with its source when it names one (the page shows the cite last).
    expect(articleLastParagraph({ blocks: [rich.blocks[4] as ArticleBlockV1] })).toBe('Foreman');
    expect(articleLastParagraph({ blocks: [{ type: 'quote', text: 'q' }] })).toBe('q');
    expect(articleFirstParagraph({ blocks: [rich.blocks[6] as ArticleBlockV1] })).toBe('');
    expect(articleFirstParagraph({ blocks: [rich.blocks[2] as ArticleBlockV1] })).toBe(
      'https://acme.example/scales?a=1&b=2',
    );
    expect(faqAnswerText(rich.blocks[5] as Extract<ArticleBlockV1, { type: 'faq' }>)).toBe(
      'The empty weight.\nSubtracted from the gross.',
    );
    expect(articleBlockText({ type: 'faq', question: 'Q', answer: 'A', answerBlocks: [] })).toBe('Q\nA');
    expect(articleImages(rich).map((i) => i.assetVersionId)).toEqual(['av_feat', 'av_1', 'av_2']);
    // Body characters count text, alt and caption, link text (never the address) and the rich answer's lines.
    expect(articleBodyChars(rich.blocks)).toBe(
      'Every load is weighed twice.'.length +
        'The <bridge>'.length +
        'North gate'.length +
        0 +
        'Certified "scales"'.length +
        'Weigh twice.'.length +
        'Foreman'.length +
        'What is tare?'.length +
        'The empty weight.\nSubtracted from the gross.'.length +
        'Last image, no caption'.length,
    );
  });

  it('caps: images bounded, links must be absolute http(s), FAQ answer blocks bounded, no nested FAQs or images', () => {
    const base = { kind: 'article', title: 't', slug: 't', blocks: [] as unknown[] };
    const image = (n: number) => ({ type: 'image', assetVersionId: `av_${n}`, alt: '' });
    expect(
      ArticleDocumentV1.safeParse({
        ...base,
        blocks: Array.from({ length: ARTICLE_IMAGES_MAX }, (_, i) => image(i)),
      }).success,
    ).toBe(true);
    const over = ArticleDocumentV1.safeParse({
      ...base,
      featuredImage: { assetVersionId: 'f', alt: '' },
      blocks: Array.from({ length: ARTICLE_IMAGES_MAX }, (_, i) => image(i)),
    });
    expect(over.success).toBe(false);
    if (!over.success)
      expect(over.error.issues[0]?.message).toBe(
        `too_many_images:${ARTICLE_IMAGES_MAX + 1}>${ARTICLE_IMAGES_MAX}`,
      );
    for (const href of ['javascript:alert(1)', '/relative', 'ftp://x.example/f', 'https://a.example/<x>', ''])
      expect(ArticleBlockV1.safeParse({ type: 'link', href, text: 'x' }).success).toBe(false);
    expect(
      ArticleBlockV1.safeParse({ type: 'link', href: 'HTTP://A.example/p?q=1#f', text: '' }).success,
    ).toBe(true);
    expect(
      ArticleBlockV1.safeParse({
        type: 'faq',
        question: 'q',
        answer: 'a',
        answerBlocks: [{ type: 'image', assetVersionId: 'x', alt: '' }],
      }).success,
    ).toBe(false);
    expect(
      ArticleBlockV1.safeParse({
        type: 'faq',
        question: 'q',
        answer: 'a',
        answerBlocks: Array.from({ length: 11 }, () => ({ type: 'paragraph', text: 'p' })),
      }).success,
    ).toBe(false);
    // A rich FAQ answer's plain text must be the blocks' text (an API client cannot make them diverge).
    const faq = (answer: string) =>
      ArticleDocumentV1.safeParse({
        ...base,
        blocks: [
          { type: 'faq', question: 'q', answer, answerBlocks: [{ type: 'paragraph', text: 'The answer.' }] },
        ],
      });
    expect(faq('The answer.').success).toBe(true);
    const diverged = faq('Something else.');
    expect(diverged.success).toBe(false);
    if (!diverged.success)
      expect(diverged.error.issues[0]).toMatchObject({
        path: ['blocks', 0, 'answer'],
        message: 'faq_answer_mismatch',
      });
    expect(ArticleDocumentV1.safeParse({ ...base, v: 1 }).success).toBe(false);
    expect(ArticleDocumentV1.safeParse({ ...base, v: 2 }).success).toBe(true);
  });
});
