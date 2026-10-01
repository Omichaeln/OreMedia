import { describe, expect, it } from 'vitest';
import { SEO_AUDIT_LINKS_PER_PAGE, SEO_AUDIT_ROBOTS_RULES } from '@oremedia/contracts/seo-audit';
import { sha256Hex } from '@oremedia/domain/hash';
import {
  auditPage,
  crossPageChecks,
  extractLinks,
  findingsOf,
  pageSeverity,
  robotsAllows,
  robotsDisallowFor,
  sameOriginUrl,
  sitemapUrls,
  summarise,
  type FetchedPageFacts,
} from './audit-crawl';

const ORIGIN = 'https://site.example';
const page = (html: string, over: Partial<FetchedPageFacts> = {}): FetchedPageFacts => ({
  url: `${ORIGIN}/about`,
  origin: ORIGIN,
  status: 200,
  html,
  bytes: html.length,
  truncated: false,
  hops: 0,
  contentType: 'text/html; charset=utf-8',
  ...over,
});
const GOOD = `<!doctype html><html lang="en"><head><title>About us</title>
<meta name="description" content="What the company does, who runs it and how to reach the team by phone or email.">
<meta name="viewport" content="width=device-width">
<link rel="canonical" href="https://site.example/about">
<script type="application/ld+json">{"@type":"Organization"}</script></head>
<body><h1>About</h1><img src="/a.png" alt="team"><a href="/contact">Contact</a><a href="https://other.example/x">Out</a></body></html>`;
const checkOf = (html: string, key: string, over: Partial<FetchedPageFacts> = {}) =>
  auditPage(page(html, over)).checks.find((c) => c.key === key)!;

describe('robots.txt (R2-4: Disallow rules for *, minimal matcher)', () => {
  it('reads the * group only, merges consecutive user-agent lines and ignores comments and Allow', () => {
    const rules = robotsDisallowFor(`# comment
User-agent: Googlebot
Disallow: /only-google
User-agent: other
User-agent: *
Allow: /public
Disallow: /private/ # trailing comment
Disallow: /*.pdf$
Disallow:
User-agent: Bingbot
Disallow: /only-bing`);
    expect(rules).toEqual({ disallow: ['/private/', '/*.pdf$'], truncated: false });
  });
  it('keeps at most SEO_AUDIT_ROBOTS_RULES rules and says so', () => {
    const text = `User-agent: *\n${Array.from({ length: SEO_AUDIT_ROBOTS_RULES + 5 }, (_, i) => `Disallow: /p${i}`).join('\n')}`;
    const rules = robotsDisallowFor(text);
    expect(rules.disallow).toHaveLength(SEO_AUDIT_ROBOTS_RULES);
    expect(rules.truncated).toBe(true);
  });
  it('matches path prefixes, * wildcards and $ anchors; everything is allowed without rules', () => {
    const rules = ['/private/', '/*.pdf$', '/search?'];
    expect(robotsAllows(rules, `${ORIGIN}/about`)).toBe(true);
    expect(robotsAllows(rules, `${ORIGIN}/private/page`)).toBe(false);
    expect(robotsAllows(rules, `${ORIGIN}/docs/file.pdf`)).toBe(false);
    expect(robotsAllows(rules, `${ORIGIN}/docs/file.pdf.html`)).toBe(true);
    expect(robotsAllows(rules, `${ORIGIN}/search?q=x`)).toBe(false);
    expect(robotsAllows([], `${ORIGIN}/anything`)).toBe(true);
    expect(robotsAllows([], 'not a url')).toBe(false);
  });
});

describe('URLs and sitemaps', () => {
  it('keeps same-origin links only, resolved and without fragments', () => {
    expect(sameOriginUrl('/a#top', `${ORIGIN}/`, ORIGIN)).toBe(`${ORIGIN}/a`);
    expect(sameOriginUrl('b?x=1', `${ORIGIN}/dir/`, ORIGIN)).toBe(`${ORIGIN}/dir/b?x=1`);
    expect(sameOriginUrl('https://other.example/', `${ORIGIN}/`, ORIGIN)).toBeNull();
    expect(sameOriginUrl('http://site.example/plain', `${ORIGIN}/`, ORIGIN)).toBeNull(); // another origin
    expect(sameOriginUrl('mailto:x@site.example', `${ORIGIN}/`, ORIGIN)).toBeNull();
    expect(sameOriginUrl('javascript:void(0)', `${ORIGIN}/`, ORIGIN)).toBeNull();
    expect(sameOriginUrl('https://u:p@site.example/x', `${ORIGIN}/`, ORIGIN)).toBeNull();
  });
  it('extracts and caps a page’s links, skipping script bodies and the page itself', () => {
    const many = Array.from(
      { length: SEO_AUDIT_LINKS_PER_PAGE + 20 },
      (_, i) => `<a href="/p${i}">x</a>`,
    ).join('');
    const html = `<script>var a='<a href="/from-script">'</script><a href="/about">self</a><a href="/about#x">self</a>${many}`;
    const links = extractLinks(html, `${ORIGIN}/about`, ORIGIN);
    expect(links).toHaveLength(SEO_AUDIT_LINKS_PER_PAGE);
    expect(links).not.toContain(`${ORIGIN}/from-script`);
    expect(links).not.toContain(`${ORIGIN}/about`);
  });
  it('reads a urlset and a sitemap index', () => {
    expect(
      sitemapUrls(`<?xml version="1.0"?><urlset><url><loc>https://site.example/a</loc></url>
<url><loc> https://site.example/b&amp;c </loc></url></urlset>`),
    ).toEqual({ urls: ['https://site.example/a', 'https://site.example/b&c'], sitemaps: [] });
    expect(
      sitemapUrls(`<sitemapindex><sitemap><loc>https://site.example/s1.xml</loc></sitemap></sitemapindex>`),
    ).toEqual({ urls: [], sitemaps: ['https://site.example/s1.xml'] });
  });
});

describe('per-page lab checks', () => {
  it('a well-formed page passes every check and yields its facts', () => {
    const audit = auditPage(page(GOOD));
    expect(audit.checks.every((c) => c.ok)).toBe(true);
    expect(audit.titleHash).toBe(sha256Hex('about us')); // the hash of the folded text, never the text
    expect(audit.metaDescriptionHash).toBe(
      sha256Hex('what the company does, who runs it and how to reach the team by phone or email.'),
    );
    expect(audit.links).toEqual([`${ORIGIN}/contact`]);
    expect(pageSeverity(audit.checks)).toBe('ok');
  });
  it('status and redirect chain: a 404 is major, a 5xx critical, an unreachable page critical, 2+ hops minor', () => {
    expect(checkOf('', 'status', { status: 404 })).toMatchObject({
      ok: false,
      severity: 'major',
      detail: 'status=404',
    });
    expect(checkOf('', 'status', { status: 503 })).toMatchObject({ severity: 'critical' });
    expect(checkOf('', 'status', { status: null })).toMatchObject({
      severity: 'critical',
      detail: 'unreachable',
    });
    expect(checkOf(GOOD, 'redirect_chain', { hops: 1 }).ok).toBe(true);
    expect(checkOf(GOOD, 'redirect_chain', { hops: 2 })).toMatchObject({
      severity: 'minor',
      detail: 'hops=2',
    });
    // A non-200 page gets no content checks (its content is an error page).
    expect(auditPage(page(GOOD, { status: 404 })).checks.map((c) => c.key)).toEqual([
      'status',
      'redirect_chain',
    ]);
    expect(auditPage(page(GOOD, { contentType: 'application/pdf' })).checks).toHaveLength(2);
  });
  it('title: missing is major, over 70 major, over 60 minor', () => {
    expect(checkOf(GOOD.replace(/<title>.*<\/title>/, ''), 'title')).toMatchObject({
      severity: 'major',
      detail: 'missing',
    });
    expect(checkOf(GOOD.replace('About us', 'x'.repeat(65)), 'title')).toMatchObject({
      severity: 'minor',
      detail: 'length=65',
    });
    expect(checkOf(GOOD.replace('About us', 'x'.repeat(75)), 'title')).toMatchObject({ severity: 'major' });
  });
  it('meta description: missing is major, off-length minor', () => {
    expect(checkOf(GOOD.replace(/<meta name="description"[^>]*>/, ''), 'meta_description')).toMatchObject({
      severity: 'major',
    });
    expect(checkOf(GOOD.replace(/content="What[^"]*"/, 'content="short"'), 'meta_description')).toMatchObject(
      {
        severity: 'minor',
        detail: 'length=5',
      },
    );
  });
  it('h1: none is major, several minor', () => {
    expect(checkOf(GOOD.replace('<h1>About</h1>', ''), 'h1')).toMatchObject({
      severity: 'major',
      detail: 'count=0',
    });
    expect(checkOf(GOOD.replace('<h1>About</h1>', '<h1>A</h1><h1>B</h1>'), 'h1')).toMatchObject({
      severity: 'minor',
    });
  });
  it('canonical: missing minor, another origin major, same origin ok', () => {
    expect(checkOf(GOOD.replace(/<link rel="canonical"[^>]*>/, ''), 'canonical')).toMatchObject({
      severity: 'minor',
    });
    expect(
      checkOf(GOOD.replace('https://site.example/about', 'https://cdn.example/about'), 'canonical'),
    ).toMatchObject({ severity: 'major', detail: 'other_origin' });
    expect(checkOf(GOOD.replace('https://site.example/about', '/other'), 'canonical').ok).toBe(true);
  });
  it('robots meta: noindex is critical, nofollow minor; viewport and lang missing are minor', () => {
    expect(
      checkOf(GOOD.replace('<head>', '<head><meta name="robots" content="noindex, follow">'), 'robots_meta'),
    ).toMatchObject({
      severity: 'critical',
      detail: 'noindex',
    });
    expect(
      checkOf(GOOD.replace('<head>', '<head><meta name="googlebot" content="nofollow">'), 'robots_meta'),
    ).toMatchObject({
      severity: 'minor',
    });
    expect(checkOf(GOOD.replace(/<meta name="viewport"[^>]*>/, ''), 'viewport')).toMatchObject({
      severity: 'minor',
    });
    expect(checkOf(GOOD.replace('<html lang="en">', '<html>'), 'lang')).toMatchObject({ severity: 'minor' });
  });
  it('images without alt are counted (an empty alt counts as present)', () => {
    const html = GOOD.replace(
      '<img src="/a.png" alt="team">',
      '<img src="/a.png"><img src="/b.png" alt=""><img src="/c.png">',
    );
    expect(checkOf(html, 'image_alt')).toMatchObject({ severity: 'minor', detail: 'count=2' });
  });
  it('hreflang: absent passes; relative or without the page itself is minor', () => {
    const set = (hrefs: string[]) =>
      GOOD.replace(
        '<head>',
        `<head>${hrefs.map((h) => `<link rel="alternate" hreflang="x" href="${h}">`).join('')}`,
      );
    expect(checkOf(set(['https://site.example/about', 'https://site.example/fr/about']), 'hreflang').ok).toBe(
      true,
    );
    expect(checkOf(set(['/about', '/fr/about']), 'hreflang')).toMatchObject({ detail: 'relative' });
    expect(checkOf(set(['https://site.example/fr/about']), 'hreflang')).toMatchObject({ detail: 'no_self' });
  });
  it('structured data: absent minor, invalid JSON major', () => {
    expect(
      checkOf(GOOD.replace(/<script type="application\/ld\+json">.*<\/script>/, ''), 'structured_data'),
    ).toMatchObject({
      severity: 'minor',
      detail: 'absent',
    });
    expect(checkOf(GOOD.replace('{"@type":"Organization"}', '{not json'), 'structured_data')).toMatchObject({
      severity: 'major',
      detail: 'invalid',
    });
  });
  it('page size: over 1.5 MiB minor, truncated at the cap major', () => {
    expect(checkOf(GOOD, 'page_size', { bytes: 1.6 * 1024 * 1024 })).toMatchObject({ severity: 'minor' });
    expect(checkOf(GOOD, 'page_size', { bytes: 2 * 1024 * 1024, truncated: true })).toMatchObject({
      severity: 'major',
    });
  });
  it('mixed content: http subresources on an https page are major', () => {
    const html = GOOD.replace(
      '<body>',
      '<body><script src="http://cdn.example/x.js"></script><link rel="stylesheet" href="http://cdn.example/x.css">',
    );
    expect(checkOf(html, 'mixed_content')).toMatchObject({ severity: 'major', detail: 'count=2' });
  });
});

describe('cross-page checks, summary and findings', () => {
  const crawled = [
    {
      url: `${ORIGIN}/`,
      status: 200,
      titleHash: sha256Hex('home'),
      metaDescriptionHash: sha256Hex('d1'),
      links: [`${ORIGIN}/gone`, `${ORIGIN}/a`],
      checks: [],
    },
    {
      url: `${ORIGIN}/a`,
      status: 200,
      titleHash: sha256Hex('home'),
      metaDescriptionHash: sha256Hex('d2'),
      links: [],
      checks: [],
    },
    {
      url: `${ORIGIN}/b`,
      status: 200,
      titleHash: sha256Hex('b'),
      metaDescriptionHash: sha256Hex('d1'),
      links: [`${ORIGIN}/gone`],
      checks: [],
    },
    { url: `${ORIGIN}/gone`, status: 404, titleHash: null, metaDescriptionHash: null, links: [], checks: [] },
  ];
  it('finds broken internal links and case-insensitive duplicate titles and descriptions; skips non-200 pages', () => {
    const out = crossPageChecks(crawled);
    expect(out.has(`${ORIGIN}/gone`)).toBe(false);
    expect(out.get(`${ORIGIN}/`)!.find((c) => c.key === 'broken_links')).toMatchObject({
      severity: 'major',
      detail: 'count=1',
    });
    expect(out.get(`${ORIGIN}/`)!.find((c) => c.key === 'duplicate_title')).toMatchObject({
      detail: 'count=2',
    });
    expect(out.get(`${ORIGIN}/a`)!.find((c) => c.key === 'broken_links')!.ok).toBe(true);
    expect(out.get(`${ORIGIN}/b`)!.find((c) => c.key === 'duplicate_description')).toMatchObject({
      detail: 'count=2',
    });
    expect(out.get(`${ORIGIN}/b`)!.find((c) => c.key === 'duplicate_title')!.ok).toBe(true);
  });
  it('summarises pages by worst severity and failing checks, and words one finding per check', () => {
    const checked = crawled.slice(0, 3).map((p) => {
      const checks = crossPageChecks(crawled).get(p.url)!;
      return { url: p.url, checks, severity: pageSeverity(checks) };
    });
    expect(summarise(checked)).toEqual({
      critical: 0,
      major: 2,
      minor: 1,
      byCheck: { broken_links: 2, duplicate_title: 2, duplicate_description: 2 },
    });
    const findings = findingsOf(checked);
    expect(findings.map((f) => f.check)).toEqual([
      'broken_links',
      'duplicate_title',
      'duplicate_description',
    ]);
    expect(findings[0]).toMatchObject({
      severity: 'major',
      count: 2,
      examples: [`${ORIGIN}/`, `${ORIGIN}/b`],
      suggestedTask:
        'Fix or remove the internal links on 2 pages that lead to pages answering with an error.',
    });
  });
});
