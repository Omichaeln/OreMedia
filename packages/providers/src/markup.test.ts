import { describe, expect, it } from 'vitest';
import { scanMarkup } from './markup';
import { decodeEntities, robotsAllows, sitemapUrls } from './site-rules';

/** Inputs that sent the earlier regular expressions quadratic (or worse) must finish in linear time. */
const fast = (run: () => unknown) => {
  const started = performance.now();
  run();
  expect(performance.now() - started).toBeLessThan(200);
};
const N = 50_000;

describe('scanMarkup', () => {
  it('yields text, tags with attributes, and raw-text contents; skips comments and doctypes', () => {
    const tokens = [
      ...scanMarkup(
        '<!doctype html><!-- x --><P class="a > b" data-x=1 hidden>Hi<br/><script>if (a<b) "</p>"</SCRIPT>&amp;</p>',
      ),
    ];
    expect(tokens).toEqual([
      {
        type: 'open',
        name: 'p',
        attrs: new Map([
          ['class', 'a > b'],
          ['data-x', '1'],
          ['hidden', ''],
        ]),
        selfClosing: false,
      },
      { type: 'text', text: 'Hi' },
      { type: 'open', name: 'br', attrs: new Map(), selfClosing: true },
      { type: 'open', name: 'script', attrs: new Map(), selfClosing: false },
      { type: 'text', text: 'if (a<b) "</p>"' },
      { type: 'close', name: 'script' },
      { type: 'text', text: '&amp;' },
      { type: 'close', name: 'p' },
    ]);
  });

  it('a stray `<` stays text', () => {
    expect([...scanMarkup('a < b <c d')]).toEqual([{ type: 'text', text: 'a < b <c d' }]);
  });

  it.each([
    ['unclosed tags', '<a '.repeat(N)],
    ['bare angle brackets', '<'.repeat(N)],
    ['unclosed quotes', '<a "'.repeat(N)],
    ['unclosed comments', '<!--'.repeat(N)],
    ['unclosed raw text', '<script>'.repeat(N)],
    ['deep nesting', '<div aria-hidden=true>'.repeat(N / 10)],
  ])('stays linear on %s', (_, input) => {
    fast(() => [...scanMarkup(input)].length);
  });
});

describe('site rules on hostile input', () => {
  it('decodes numeric references outside Unicode to U+FFFD instead of throwing', () => {
    expect(decodeEntities('a&#x110000;b&#xD800;c&#0;d&#99999999999;e&#65;')).toBe('a�b�c�d&#99999999999;eA');
  });

  it('matches robots rules with many wildcards in linear-ish time, with the same meaning', () => {
    const rule = `/${'*a'.repeat(60)}$`;
    fast(() => robotsAllows([rule], `https://site.example/${'a'.repeat(4000)}b`));
    expect(robotsAllows(['/p*q$'], 'https://site.example/pxxq')).toBe(false);
    expect(robotsAllows(['/p*q$'], 'https://site.example/pxxqr')).toBe(true);
    expect(robotsAllows(['/p*q'], 'https://site.example/pxxqr')).toBe(false);
    expect(robotsAllows(['/p.q'], 'https://site.example/pxq')).toBe(true);
  });

  it('reads sitemaps without lazy patterns', () => {
    fast(() => sitemapUrls('<url><loc>'.repeat(N / 10)));
    expect(
      sitemapUrls(
        '<urlset><url><loc> https://s.example/a?x=1&amp;y=2 </loc></url><url><loc></loc></url></urlset>',
      ),
    ).toEqual({ urls: ['https://s.example/a?x=1&y=2'], sitemaps: [] });
  });
});
