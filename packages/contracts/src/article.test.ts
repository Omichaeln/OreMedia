import { describe, expect, it } from 'vitest';
import {
  ArticleRegionSelector,
  articleFirstParagraph,
  articleHtmlBlocks,
  articleManifest,
  canonicalFromLinkHeader,
  compareArticleRegion,
  robotsHeaderNoindex,
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
import { LINEAR_RATIO_MAX, LINEAR_SAFETY_MS, timeGrowth } from './testing/linear-time';
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

  it.each([
    ['a decimal reference for the colon', 'javascript&#58;alert(1)'],
    ['a decimal reference without its semicolon', 'javascript&#58alert(1)'],
    ['a hex reference for the colon', 'javascript&#x3a;alert(1)'],
    ['the named colon reference', 'javascript&colon;alert(1)'],
    ['a tab reference inside the scheme', 'java&#x09;script:alert(1)'],
    ['the named tab reference inside the scheme', 'java&Tab;script:alert(1)'],
    ['a newline reference inside the scheme', 'java&NewLine;script:alert(1)'],
    ['a raw tab inside the scheme', 'java\tscript:alert(1)'],
    ['a raw newline inside the scheme', 'java\nscript:alert(1)'],
    ['a leading NUL', '\u0000javascript:alert(1)'],
    ['a leading NUL reference', '&#0;javascript:alert(1)'],
    ['a zero-width space inside the scheme', 'java​script:alert(1)'],
    ['mixed case', 'JaVaScRiPt:alert(1)'],
    ['an encoded letter in the scheme', '&#106;avascript:alert(1)'],
    ['a data URL behind a reference', 'data&#58;text/html,x'],
  ])('refuses a script URL hidden by %s, in a link and an image', (_, url) => {
    expect(safeArticleUrl(url)).toBeNull();
    const html = sanitizeArticleHtml(`<p><a href="${url}">x</a><img src="${url}" alt="i"></p>`);
    expect(html).toBe('<p><a>x</a><img alt="i"></p>');
    expect(html).not.toMatch(/href|src/);
  });

  it('keeps http, https, mailto and relative URLs exactly as before, escaping what it emits', () => {
    for (const [input, expected] of [
      ['https://example.com/a?b=1&amp;c=2#f', 'https://example.com/a?b=1&amp;c=2#f'],
      ['http://example.com/p', 'http://example.com/p'],
      ['HTTPS://Example.com/P', 'HTTPS://Example.com/P'],
      ['mailto:a@b.example', 'mailto:a@b.example'],
      ['/relative/path?x=1&amp;y=2', '/relative/path?x=1&amp;y=2'],
      ['relative/page', 'relative/page'],
      ['#section', '#section'],
      ['https://example.com/a?b=1&c=2', 'https://example.com/a?b=1&amp;c=2'],
      ['https&#58;//example.com/p', 'https://example.com/p'],
      ['https://example.com/&copy;', 'https://example.com/&amp;copy;'],
    ] as const) {
      expect(sanitizeArticleHtml(`<a href="${input}">x</a>`)).toBe(
        `<a href="${expected}" rel="noopener">x</a>`,
      );
      expect(sanitizeArticleHtml(`<img src="${input}">`)).toBe(`<img src="${expected}">`);
    }
    expect(safeArticleUrl('/relative/path')).toBe('/relative/path');
    expect(safeArticleUrl('&#47;&#47;cdn.example/x')).toBeNull();
  });

  it('rendered-page checks: status, title in <title> or h1, canonical, noindex only for a draft, the article content', () => {
    const page = (
      extra: string,
      body = '<p>Ore is heavy &amp; tar is &lt;sticky&gt;.</p><p>Yes, &quot;mostly&quot;.</p>',
    ) =>
      `<html><head><title>Why ore &amp; tar | Site</title>${extra}</head><body><h1>Other</h1><article>${body}</article></body></html>`;
    const live = {
      title: article.title,
      manifest: articleManifest(
        '<p>Ore is heavy &amp; tar is &lt;sticky&gt;.</p><p>Yes, &quot;mostly&quot;.</p>',
      ),
      slug: article.slug,
      remoteUrl: 'https://site.example/why-ore-and-tar/',
      draft: false,
    };
    const ok = validateRenderedPage({
      status: 200,
      html: page('<link rel="canonical" href="https://site.example/why-ore-and-tar/">'),
      ...live,
    });
    expect(ok.checks.every((c) => c.ok)).toBe(true);
    expect(ok.outcome).toBe('verified');
    const bad = validateRenderedPage({
      status: 404,
      html: page('<meta name="robots" content="noindex">', '<p>Nothing</p>'),
      ...live,
    });
    expect(bad.checks.map((c) => `${c.key}:${c.ok}`)).toEqual([
      'status_ok:false',
      'title_present:true',
      'canonical_present:false',
      'indexable:false',
      'canonical_matches:false',
      'article_region_found:true',
      'content_complete:false',
      'images_present:true',
      'header_indexable:true',
    ]);
    expect(bad.outcome).toBe('failed');
    expect(renderedValidationOk(bad.checks)).toBe(false);
    const draft = validateRenderedPage({
      status: 200,
      html: page('<meta name="robots" content="noindex, nofollow">'),
      ...live,
      draft: true,
    });
    expect(draft.checks.find((c) => c.key === 'indexable')?.ok).toBe(true);
    expect(pageText('<p>A&nbsp;<b>B</b></p><script>x</script>')).toBe('a b');
  });

  it('rendered-page checks (RA-04, PR-04): the canonical must name this page and every block must be present', () => {
    const live = {
      title: article.title,
      manifest: articleManifest(renderArticleHtml(article)),
      slug: article.slug,
      remoteUrl: 'https://site.example/?p=42',
      draft: false,
    };
    const page = (canonical: string, body: string) =>
      `<html><head><title>Why ore &amp; tar</title><link rel="canonical" href="${canonical}"></head><body><div class="entry-content">${body}</div></body></html>`;
    const full = renderArticleHtml(article);
    const checksOf = (html: string) =>
      Object.fromEntries(
        validateRenderedPage({ status: 200, html, ...live }).checks.map((c) => [c.key, c.ok]),
      );
    expect(checksOf(page('https://site.example/why-ore-and-tar/', full))).toMatchObject({
      canonical_present: true,
      canonical_matches: true, // the slug's path on the site
      content_complete: true,
    });
    expect(checksOf(page('https://site.example/?p=42', full))).toMatchObject({ canonical_matches: true });
    expect(checksOf(page('https://other.example/why-ore-and-tar/', full))).toMatchObject({
      canonical_present: true,
      canonical_matches: false, // another site
    });
    // A later paragraph changed on the page: the content check fails, whatever the first paragraph shows.
    const changed = full.replace('Yes, &quot;mostly&quot;.', 'No, never.');
    expect(checksOf(page('https://site.example/why-ore-and-tar/', changed))).toMatchObject({
      content_complete: false,
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

describe('character references that are not Unicode scalar values (crafted pages)', () => {
  const refs = ['&#99999999;', '&#x110000;', '&#xD800;', '&#55296;', '&#0;', '&#x0;'];

  it.each(refs)('pageText reads %s as U+FFFD instead of throwing', (ref) => {
    expect(pageText(`<p>a${ref}b</p>`)).toBe('a�b');
  });

  it.each(refs)('articleHtmlChars counts %s as one character instead of throwing', (ref) => {
    expect(articleHtmlChars(`<p>a${ref}b</p>`)).toBe(3);
  });

  it.each(refs)('the canonical check reads %s in the canonical href as U+FFFD instead of throwing', (ref) => {
    const { checks } = validateRenderedPage({
      status: 200,
      html: `<html><head><title>T</title><link rel="canonical" href="https://site.example/a${ref}b"></head><body><p>p</p></body></html>`,
      title: 'T',
      manifest: articleManifest('<p>p</p>'),
      draft: false,
      remoteUrl: 'https://site.example/a%EF%BF%BDb',
      slug: 'other',
    });
    expect(checks.find((c) => c.key === 'canonical_present')?.ok).toBe(true);
    expect(checks.find((c) => c.key === 'canonical_matches')?.ok).toBe(true);
  });
});

describe('reading untrusted markup in linear time (the sanitiser and the rendered-page checks)', () => {
  /**
   * Time grows with the input, not its square: 8× the input takes well under 64× the CPU time. The regular
   * expressions these replace took seconds (or, for attributes, forever) at the larger sizes.
   */
  const linear = (input: (size: number) => string, run: (html: string) => unknown, size = 12_500) => {
    const growth = timeGrowth(input, run, { size });
    expect(growth.ratio).toBeLessThan(LINEAR_RATIO_MAX);
    expect(growth.largeMs).toBeLessThan(LINEAR_SAFETY_MS);
  };
  const check = (html: string) =>
    validateRenderedPage({
      status: 200,
      html,
      title: 't',
      manifest: articleManifest('<p>p</p><p>q</p>'),
      draft: false,
    });

  it.each([
    ['unclosed comments', (n: number) => '<!--'.repeat(n / 4)],
    ['unclosed tags', (n: number) => '<a x'.repeat(n / 4)],
    ['bare angle brackets', (n: number) => '<'.repeat(n)],
    ['unclosed quotes', (n: number) => '<a "'.repeat(n / 4)],
    ['a URL of character references', (n: number) => `<a href="${'&#x3a'.repeat(n / 5)}&#">x</a>`],
  ])(
    'sanitises %s in linear time',
    (_, input) => {
      linear(input, sanitizeArticleHtml);
    },
    30_000,
  );

  it('sanitises a tag with many empty attributes and no `>` (exponential for the earlier pattern)', () => {
    // 2 → 16 attributes is ×8 time for the scanner and ×2^14 for the earlier token pattern, which never finished
    // at 40 (2^40 steps); the growth checks come first, so a backtracking pattern fails them instead of hanging.
    const attrs = (n: number) => `<a${' x=""'.repeat(n)}`;
    linear(attrs, sanitizeArticleHtml, 2);
    linear(attrs, sanitizeArticleHtml, 2_500);
    expect(sanitizeArticleHtml(attrs(40))).toBe(`&lt;a${' x=""'.repeat(40)}`);
  }, 30_000);

  it.each([
    ['bare angle brackets', (n: number) => '<'.repeat(n)],
    ['unclosed tags', (n: number) => '<a '.repeat(n / 3)],
    ['unclosed scripts', (n: number) => '<script>'.repeat(n / 8)],
    ['unclosed titles', (n: number) => '<title>'.repeat(n / 7)],
    ['unclosed headings', (n: number) => '<h1>'.repeat(n / 4)],
    ['unclosed metas', (n: number) => '<meta '.repeat(n / 6)],
    ['unclosed links', (n: number) => '<link '.repeat(n / 6)],
  ])(
    'reads a rendered page of %s in linear time',
    (_, input) => {
      linear(input, check);
      linear(input, pageText);
      linear(input, articleHtmlChars);
    },
    30_000,
  );

  it('sanitises well-formed article markup exactly as before', () => {
    // Expected values are the earlier implementation's output for the same input.
    const cases: Array<[string, string, number]> = [
      [
        '<h2 id="x" class="y">Title</h2><p>Text with <a href="https://example.com/a?b=1&amp;c=2" title="T" target="_blank" onclick="x()">link</a>.</p>',
        '<h2>Title</h2><p>Text with <a href="https://example.com/a?b=1&amp;c=2" title="T" rel="noopener">link</a>.</p>',
        20,
      ],
      [
        '<ul><li>One</li><li>Two<br/>lines</li></ul><img src="/a.png" alt="A &quot;q&quot;" width="10" height="5" style="x">',
        '<ul><li>One</li><li>Two<br>lines</li></ul><img src="/a.png" alt="A &quot;q&quot;" width="10" height="5">',
        11,
      ],
      [
        '<section class="faq"><h3>Q?</h3><p>A.</p></section><figure><img src="https://cdn.example/x.jpg" alt="x"><figcaption>Cap</figcaption></figure>',
        '<section class="faq"><h3>Q?</h3><p>A.</p></section><figure><img src="https://cdn.example/x.jpg" alt="x"><figcaption>Cap</figcaption></figure>',
        7,
      ],
      [
        '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1 &lt; 2</td></tr></tbody></table>',
        '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1 &lt; 2</td></tr></tbody></table>',
        6,
      ],
      ['<p>a < b and c > d, AT&T</p>', '<p>a &lt; b and c &gt; d, AT&amp;T</p>', 21],
      [
        '<div><span>kept text</span><script>alert("<p>x</p>")</script><iframe src="https://x"></iframe></div><p>end',
        'kept text<p>end</p>',
        12,
      ],
      [
        '<P CLASS="x">Upper</P><A HREF="javascript:alert(1)">bad</A><a href="mailto:a@b.c">mail</a>',
        '<p>Upper</p><a>bad</a><a href="mailto:a@b.c" rel="noopener">mail</a>',
        12,
      ],
      [
        '<!-- note --><blockquote>Quote</blockquote><pre><code>if (a &amp;&amp; b) {}</code></pre>',
        '<blockquote>Quote</blockquote><pre><code>if (a &amp;&amp; b) {}</code></pre>',
        19,
      ],
      [
        "<p>single 'quotes' <a href='/rel/path' title='it&#39;s'>r</a></p>",
        '<p>single \'quotes\' <a href="/rel/path" title="it&#39;s" rel="noopener">r</a></p>',
        17,
      ],
      [
        '<dl><dt>T</dt><dd>D</dd></dl><hr><p>x<svg><circle/></svg>y</p>',
        '<dl><dt>T</dt><dd>D</dd></dl><hr><p>xy</p>',
        4,
      ],
      ['<p>\n  Multi\n  line <b\n  >bold</b>\n</p>', '<p>\n  Multi\n  line <b>bold</b>\n</p>', 21],
      [
        '<a href="//evil.example/x">proto</a><img src="data:image/png;base64,AA" alt="d"><a href="#frag">f</a>',
        '<a>proto</a><img alt="d"><a href="#frag" rel="noopener">f</a>',
        6,
      ],
      [
        '<p>unclosed <em>em <strong>strong</p> after',
        '<p>unclosed <em>em <strong>strong</strong></em></p> after',
        24,
      ],
      ['<p><a title="1<2" href="/x">t</a></p>', '<p><a title="1&lt;2" href="/x" rel="noopener">t</a></p>', 1],
    ];
    for (const [input, output, chars] of cases) {
      expect(sanitizeArticleHtml(input)).toBe(output);
      expect(articleHtmlChars(output)).toBe(chars);
    }
  });

  it('drops a tag named after an Object property instead of passing it through or throwing', () => {
    expect(sanitizeArticleHtml('<constructor>x</constructor><constructor onclick="y">z</constructor>')).toBe(
      'xz',
    );
  });

  it('reads well-formed rendered pages exactly as before', () => {
    const page = (head: string, body: string) =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
    const input = {
      status: 200,
      title: 'Ore & Tar',
      manifest: articleManifest('<p>First paragraph here.</p><p>Last one.</p>'),
      draft: false,
      remoteUrl: 'https://site.example/blog/post',
      slug: 'post',
    };
    const failing = (html: string) =>
      validateRenderedPage({ ...input, html })
        .checks.filter((c) => !c.ok)
        .map((c) => c.key);
    const live = page(
      '<title>Ore &amp; Tar | Blog</title><link rel="canonical" href="https://site.example/blog/post"><meta name="robots" content="index, follow">',
      '<header><nav><a href="/">Home</a></nav></header><main><h1>Post <em>title</em></h1><p>First paragraph &nbsp; here.</p><script>var x = "<h1>not</h1>";</script><style>p{}</style><p>Last one.</p></main>',
    );
    expect(pageText(live)).toBe('ore & tar | blog home post title first paragraph here. last one.');
    expect(failing(live)).toEqual([]);
    const draft = page(
      '<title>\n  Draft\n</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/a.css"><link rel="canonical" href="https://site.example/x/">',
      '<h1>Draft</h1><p>Body</p>',
    );
    expect(pageText(draft)).toBe('draft draft body');
    expect(failing(draft)).toEqual([
      'title_present',
      'indexable',
      'canonical_matches',
      'article_region_found',
      'content_complete',
      'images_present',
    ]);
    const googlebot = page(
      '<meta name="googlebot" content="NOINDEX"><link href="https://site.example/post" rel="canonical">',
      '<div><h1 class="t">A <span>B</span></h1></div><p>A &amp; B &#39;c&#39; &#x41;</p>',
    );
    expect(pageText(googlebot)).toBe("a b a & b 'c' a");
    expect(failing(googlebot)).toEqual([
      'title_present',
      'indexable',
      'article_region_found',
      'content_complete',
      'images_present',
    ]);
    expect(validateRenderedPage({ ...input, html: googlebot, title: 'A B' }).checks[1]).toEqual({
      key: 'title_present',
      ok: true,
    });
  });
});

describe('rendered article verification (PR-04): the manifest against the article region', () => {
  const sent =
    '<h2>The question</h2>\n<p>Ore is heavy &amp; tar is &lt;sticky&gt;.</p>\n<p>The weighbridge reads 40 t -- every "morning" at 6.</p>\n<figure><img src="https://site.example/wp-content/uploads/bridge.png" alt="The weighbridge"><figcaption>The bridge at the north gate.</figcaption></figure>\n<ul><li>one</li><li>two</li></ul>\n<p>Yes, it\'s mostly safe...</p>';
  const manifest = articleManifest(sent);
  // What WordPress serves: wptexturize typography, lazy-loading attributes, a noscript copy, theme wrappers, a
  // sharing block inside the content after it, related posts and a sidebar outside it.
  const served = (
    body: string,
    head = '<link rel="canonical" href="https://site.example/why-ore-and-tar/">',
  ) =>
    `<!doctype html><html><head><title>Why ore &amp; tar &#8211; Site</title>${head}</head><body class="single"><div id="page" class="site"><header class="site-header"><nav><a href="/">Home</a></nav></header><main id="main"><article id="post-42" class="post-42 post type-post"><header class="entry-header"><h1 class="entry-title">Why ore &amp; tar</h1></header><div class="entry-content">${body}<div class="sharedaddy sd-sharing-enabled"><h3 class="sd-title">Share this:</h3><ul><li><a href="#">X</a></li></ul></div></div></article><section class="related-posts"><article class="post"><h2>Another post</h2><p>Ore is heavy &amp; tar is &lt;sticky&gt;.</p></article></section></main><aside class="widget-area"><p>The weighbridge reads 40 t – every “morning” at 6.</p></aside></div></body></html>`;
  const texturized =
    '<h2>The question</h2>\n<p>Ore is heavy &amp; tar is &lt;sticky&gt;.</p>\n<p>The weighbridge reads 40&nbsp;t &#8211; every &#8220;morning&#8221; at 6.</p>\n<figure class="wp-block-image"><img loading="lazy" decoding="async" width="1200" height="800" src="data:image/gif;base64,R0lGOD" data-src="https://site.example/wp-content/uploads/bridge-1200x800.png" srcset="https://site.example/a.png 1200w" class="lazyload wp-image-77" alt="The weighbridge"><noscript><img src="https://site.example/wp-content/uploads/bridge.png" alt="The weighbridge"></noscript><figcaption class="wp-element-caption">The bridge at the north gate.</figcaption></figure>\n<ul class="wp-block-list"><li>one</li><li>two</li></ul>\n<p>Yes, it&#8217;s mostly safe&#8230;</p>';
  const check = (html: string, over: Partial<Parameters<typeof validateRenderedPage>[0]> = {}) =>
    validateRenderedPage({
      status: 200,
      html,
      title: 'Why ore & tar',
      slug: 'why-ore-and-tar',
      remoteUrl: 'https://site.example/why-ore-and-tar/',
      draft: false,
      manifest,
      ...over,
    });

  it('the manifest is every block of the HTML sent, folded, and every image alt', () => {
    expect(manifest).toEqual({
      version: 1,
      blocks: [
        'the question',
        'ore is heavy & tar is <sticky>.',
        'the weighbridge reads 40 t - every "morning" at 6.',
        'the bridge at the north gate.',
        'one',
        'two',
        "yes, it's mostly safe...",
      ],
      images: ['the weighbridge'],
    });
    expect(articleManifest(sent)).toEqual(manifest); // deterministic
  });

  it('a page with the theme’s wrappers, WordPress typography, lazy-loaded images and sharing and related-post blocks passes', () => {
    const result = check(served(texturized));
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result).toMatchObject({
      outcome: 'verified',
      reason: null,
      content: {
        selector: '.entry-content',
        expectedBlocks: 7,
        matchedBlocks: 7,
        missingBlocks: [],
        missingImages: [],
      },
      indexability: { meta: 'index', header: 'index' },
    });
  });

  it('an interior paragraph altered or removed fails, even when its text still appears outside the article region', () => {
    const altered = check(served(texturized.replace('40&nbsp;t', '41&nbsp;t')));
    expect(altered).toMatchObject({
      outcome: 'failed',
      reason: 'content_changed',
      content: {
        matchedBlocks: 6,
        missingBlocks: [{ index: 2, text: 'the weighbridge reads 40 t - every "morning" at 6.' }],
      },
    });
    expect(altered.checks.find((c) => c.key === 'content_complete')?.ok).toBe(false);
    // Removed from the article; the sidebar still carries the sentence: it does not count.
    const removed = check(served(texturized.replace(/<p>The weighbridge[^]*?<\/p>/, '')));
    expect(removed).toMatchObject({ outcome: 'failed', content: { missingBlocks: [{ index: 2 }] } });
    // A paragraph moved out of order is a changed article too.
    const reordered = check(
      served(
        '<p>Yes, it&#8217;s mostly safe&#8230;</p>' +
          texturized.replace('<p>Yes, it&#8217;s mostly safe&#8230;</p>', ''),
      ),
    );
    expect(reordered.outcome).toBe('failed');
    // An image dropped from the article fails the image check.
    const noImage = check(
      served(
        texturized.replace(
          /<figure[^]*?<\/figure>/,
          '<figure><figcaption class="wp-element-caption">The bridge at the north gate.</figcaption></figure>',
        ),
      ),
    );
    expect(noImage).toMatchObject({ outcome: 'failed', content: { missingImages: ['the weighbridge'] } });
  });

  it('a header-only noindex is recognised (the meta tags say index); a draft is expected to be hidden', () => {
    const hidden = check(served(texturized), { headers: { xRobotsTag: 'noindex', link: null } });
    expect(hidden).toMatchObject({ outcome: 'failed', indexability: { meta: 'index', header: 'noindex' } });
    expect(hidden.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual(['header_indexable']);
    expect(
      check(served(texturized), { headers: { xRobotsTag: 'noindex', link: null }, draft: true }).outcome,
    ).toBe('verified');
    expect(robotsHeaderNoindex('noindex')).toBe(true);
    expect(robotsHeaderNoindex('NONE')).toBe(true);
    expect(robotsHeaderNoindex('noarchive, NOINDEX, nofollow')).toBe(true);
    expect(robotsHeaderNoindex('googlebot: noindex')).toBe(true);
    expect(robotsHeaderNoindex('otherbot: noindex, nofollow')).toBe(false);
    expect(robotsHeaderNoindex('unavailable_after: Monday, 25-Jun-2026 15:00:00 GMT')).toBe(false);
    expect(robotsHeaderNoindex('noarchive, nosnippet')).toBe(false);
    expect(robotsHeaderNoindex(null)).toBe(false);
    expect(
      check(
        served(
          texturized,
          '<link rel="canonical" href="https://site.example/why-ore-and-tar/"><meta name="robots" content="none">',
        ),
      ).indexability,
    ).toEqual({ meta: 'noindex', header: 'index' });
  });

  it('the canonical identity: an HTTP Link canonical counts, and one naming another page fails', () => {
    expect(
      check(served(texturized, ''), {
        headers: { xRobotsTag: null, link: '<https://site.example/why-ore-and-tar/>; rel="canonical"' },
      }).outcome,
    ).toBe('verified');
    const other = check(served(texturized), {
      headers: { xRobotsTag: null, link: '<https://site.example/another-post/>; rel=canonical' },
    });
    expect(other.checks.find((c) => c.key === 'canonical_matches')?.ok).toBe(false);
    expect(other.outcome).toBe('failed');
    expect(
      canonicalFromLinkHeader(
        '<https://cdn.example/x.css>; rel="preload", <https://site.example/a/>; rel="canonical"',
      ),
    ).toBe('https://site.example/a/');
  });

  it('an unavailable page (timeout, 503, 429) or one cut before the article ends stays unverified, never passing', () => {
    for (const status of [null, 503, 429, 408]) {
      const result = check(status === null ? '' : '<html><body>Service unavailable</body></html>', {
        status,
      });
      expect(result.outcome).toBe('unverified');
      expect(result.checks.some((c) => !c.ok)).toBe(true);
    }
    const page = served(texturized);
    const cut = page.slice(0, page.indexOf('<ul class="wp-block-list">'));
    expect(check(cut, { truncated: true })).toMatchObject({
      outcome: 'unverified',
      reason: 'page_truncated',
    });
    // A page with no recognisable article region proves nothing either.
    expect(
      check('<html><head><title>Why ore &amp; tar</title></head><body><p>Ore</p></body></html>'),
    ).toMatchObject({
      outcome: 'unverified',
      reason: 'article_region_not_found',
    });
  });

  it('a destination’s own selector is tried first; the selector grammar is simple selectors only', () => {
    const custom = `<html><head><title>Why ore &amp; tar</title><link rel="canonical" href="https://site.example/why-ore-and-tar/"></head><body><div class="layout"><div class="post-body" data-x="1">${texturized}</div><article class="teaser"><p>Unrelated.</p></article></div></body></html>`;
    expect(check(custom).outcome).toBe('failed'); // the default `article` names the teaser
    expect(check(custom, { regionSelector: 'div.post-body' })).toMatchObject({
      outcome: 'verified',
      content: { selector: 'div.post-body' },
    });
    expect(compareArticleRegion(custom, manifest, ['[data-x=1]']).matchedBlocks).toBe(7);
    for (const ok of [
      '.entry-content',
      'div.post-body',
      '#content',
      '[itemprop=articleBody]',
      'main, article',
      'div.a.b[data-x="y z"]',
    ])
      expect(ArticleRegionSelector.safeParse(ok).success).toBe(true);
    for (const bad of ['div p', 'div > p', 'a:hover', '', '*', '.a,', 'x'.repeat(201)])
      expect(ArticleRegionSelector.safeParse(bad).success).toBe(false);
  });
});

describe('articleHtmlBlocks (PR-03: the conflict comparison)', () => {
  it('reads each block as text, in order: entities decoded, whitespace folded, case kept, scripts and empty blocks dropped', () => {
    expect(
      articleHtmlBlocks(
        '<h2>Why  ore</h2>\n<p>Ore &amp; tar<br>are <strong>heavy</strong>.</p><p> </p><ul><li>One</li><li>Two</li></ul><script>alert(1)</script><blockquote>Quoted</blockquote>',
      ),
    ).toEqual(['Why ore', 'Ore & tar are heavy.', 'One', 'Two', 'Quoted']);
    expect(articleHtmlBlocks('')).toEqual([]);
    expect(articleHtmlBlocks('plain text without tags')).toEqual(['plain text without tags']);
  });
});
