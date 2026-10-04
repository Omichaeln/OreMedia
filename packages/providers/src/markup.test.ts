import { describe, expect, it } from 'vitest';
import { LINEAR_RATIO_MAX, LINEAR_SAFETY_MS, timeGrowth } from '@oremedia/contracts/testing/linear-time';
import { decodeEntities, robotsAllows, sitemapUrls } from './site-rules';

/** Inputs that sent the earlier regular expressions quadratic (or worse) must take time linear in their size. */
const linear = <T>(input: (size: number) => T, run: (input: T) => unknown, size: number) => {
  const growth = timeGrowth(input, run, { size });
  expect(growth.ratio).toBeLessThan(LINEAR_RATIO_MAX);
  expect(growth.largeMs).toBeLessThan(LINEAR_SAFETY_MS);
};

describe('site rules on hostile input', () => {
  it('decodes numeric references outside Unicode to U+FFFD instead of throwing', () => {
    expect(decodeEntities('a&#x110000;b&#xD800;c&#0;d&#99999999999;e&#65;')).toBe('a�b�c�d&#99999999999;eA');
  });

  it('matches robots rules with many wildcards in linear-ish time, with the same meaning', () => {
    const rule = `/${'*a'.repeat(60)}$`;
    linear(
      (n) => `https://site.example/${'a'.repeat(n)}b`,
      (url) => robotsAllows([rule], url),
      500,
    );
    expect(robotsAllows(['/p*q$'], 'https://site.example/pxxq')).toBe(false);
    expect(robotsAllows(['/p*q$'], 'https://site.example/pxxqr')).toBe(true);
    expect(robotsAllows(['/p*q'], 'https://site.example/pxxqr')).toBe(false);
    expect(robotsAllows(['/p.q'], 'https://site.example/pxq')).toBe(true);
  }, 30_000);

  it('reads sitemaps without lazy patterns', () => {
    linear(
      (n) => '<url><loc>'.repeat(n),
      (xml) => sitemapUrls(xml),
      1_000,
    );
    expect(
      sitemapUrls(
        '<urlset><url><loc> https://s.example/a?x=1&amp;y=2 </loc></url><url><loc></loc></url></urlset>',
      ),
    ).toEqual({ urls: ['https://s.example/a?x=1&y=2'], sitemaps: [] });
  }, 30_000);
});
