import { describe, expect, it } from 'vitest';
import { htmlToText, sameSiteUrl, tidyText } from './html-text';
import { choosePages } from './site-crawl';

const PAGE = `<!doctype html><html><head><title>Ore &amp; Co — About</title>
<link rel="stylesheet" href="/s.css"><link rel="canonical" href="https://ore.example/about">
<script>document.write("tracking")</script><style>.x{color:red}</style></head>
<body><header><a href="/">Home</a><nav><a href="/products">Products</a><a href="https://other.example/x">Elsewhere</a></nav></header>
<!-- a comment that is not content -->
<main><h1>About   us</h1><p>We roast <strong>single-origin</strong> coffee.<br>Since 2014.</p>
<ul><li>Traceable</li><li>Fresh</li></ul><table><tr><td>Light</td><td>Fruity</td></tr></table>
<form><input name="q"><button>Search</button></form><svg><text>logo text</text></svg>
<a href="/team#people">Team</a><a href="mailto:hi@ore.example">Mail</a></main>
<footer>© Ore · Privacy</footer><aside>Related posts</aside></body></html>`;

describe('htmlToText (BSC-4)', () => {
  const out = htmlToText(PAGE, 'https://ore.example/about');

  it('keeps headings, lists, paragraphs and table rows; drops scripts, styles, forms, svg, comments and boilerplate', () => {
    expect(out.text).toBe(
      [
        '# About us',
        '',
        'We roast single-origin coffee.',
        'Since 2014.',
        '',
        '- Traceable',
        '',
        '- Fresh',
        '',
        'Light | Fruity',
        '',
        'Team Mail',
      ].join('\n'),
    );
    for (const gone of [
      'tracking',
      'color:red',
      'Search',
      'logo text',
      'a comment',
      'Privacy',
      'Related posts',
    ])
      expect(out.text).not.toContain(gone);
  });

  it('records the page title and canonical URL as the page states them', () => {
    expect(out.title).toBe('Ore & Co — About');
    expect(out.canonicalUrl).toBe('https://ore.example/about');
  });

  it('returns same-site links (navigation first), absolute and without fragments; never another site or mailto', () => {
    expect(out.navLinks).toEqual(['https://ore.example/', 'https://ore.example/products']);
    expect(out.links).toEqual([
      'https://ore.example/',
      'https://ore.example/products',
      'https://ore.example/team',
    ]);
  });

  it('treats the www and bare hosts as one site; other schemes and hosts are not the site', () => {
    expect(sameSiteUrl('https://www.ore.example/a', 'https://ore.example/')).toBe(
      'https://www.ore.example/a',
    );
    expect(sameSiteUrl('http://ore.example/a', 'https://ore.example/')).toBeNull();
    expect(sameSiteUrl('javascript:alert(1)', 'https://ore.example/')).toBeNull();
    expect(sameSiteUrl('https://user:pw@ore.example/', 'https://ore.example/')).toBeNull();
  });

  it('tidies text: line ends, spaces, blank lines and non-breaking spaces', () => {
    expect(tidyText('  a  b \r\n\r\n\r\n\tc  ')).toBe('a b\n\nc');
  });
});

describe('choosePages (BSC-4 crawl order)', () => {
  it('reads navigation before the sitemap before other links, pages about the brand first, skipping log-ins and files', () => {
    const start = 'https://ore.example/';
    expect(
      choosePages(
        start,
        [
          'https://ore.example/blog',
          'https://ore.example/about-us',
          'https://ore.example/login',
          'https://ore.example/',
        ],
        ['https://ore.example/products/roasts', 'https://ore.example/guide.pdf'],
        ['https://ore.example/faq', 'https://www.ore.example/about-us'],
        3,
      ),
    ).toEqual([
      'https://ore.example/about-us',
      'https://ore.example/blog',
      'https://ore.example/products/roasts',
    ]);
  });
});
