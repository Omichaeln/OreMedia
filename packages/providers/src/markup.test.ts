import { describe, expect, it } from 'vitest';
import { decodeEntities, robotsAllows, sitemapUrls } from './site-rules';

/** Inputs that sent the earlier regular expressions quadratic (or worse) must finish in linear time. */
const fast = (run: () => unknown) => {
  const started = performance.now();
  run();
  expect(performance.now() - started).toBeLessThan(200);
};
const N = 50_000;

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
