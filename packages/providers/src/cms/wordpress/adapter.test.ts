import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../../testing';
import { textFingerprint } from '../../shared';
import { RenderedPageError, remoteArticleFingerprint, wordpressCmsAdapter as adapter } from './adapter';

const fx = (name: string) => loadScenario(new URL('./fixtures/articles.json', import.meta.url), name);
const site = { siteUrl: 'https://site.example', username: 'ore-editor' };
const creds: DecryptedCredentials = { accessToken: 'abcd efgh ijkl mnop', extra: { username: 'ore-editor' } };
const expectedAuth = `Basic ${Buffer.from('ore-editor:abcd efgh ijkl mnop').toString('base64')}`;
/** The hash of a revision of post 42 as the fixture serves it (no terms listed): RA-12 covers title, slug, status and content. */
const hashOf = (status: string, html: string, title = 'Why ore & tar') =>
  remoteArticleFingerprint({ title, slug: 'why-ore-and-tar', status, categories: [], tags: [], html });
const input = {
  title: 'Why ore & tar',
  slug: 'why-ore-and-tar',
  excerpt: 'A short answer.',
  html: '<p>Ore is heavy.</p>',
  categories: ['Guides'],
  tags: ['ore'],
  status: 'draft' as const,
};

describe('WordPress CMS adapter (ledger R2-3, D-16; spec 14.5 / 14.6)', () => {
  const server = new FixtureServer();
  let io: FixtureIO;
  beforeAll(async () => {
    await server.start();
    io = await fixtureIO(server, { providerKey: adapter.key });
  });
  afterAll(() => server.stop());
  const load = (name: string): void => {
    server.load(fx(name));
    io.calls.length = 0;
  };

  it('verify: the application password over HTTP Basic reaches the editor; a 401 is a reconnect; a reader is refused', async () => {
    load('verify_ok');
    expect(await adapter.verify(site, creds, io)).toEqual({
      ok: true,
      displayName: 'Ore Editor',
      canPublish: true,
    });
    expect(server.requests[0]?.headers['authorization']).toBe(expectedAuth);
    expect(io.calls).toEqual([
      { method: 'GET', url: 'https://site.example/wp-json/wp/v2/users/me?context=edit', mutation: false },
    ]);
    load('verify_unauthorised');
    const denied = await adapter.verify(site, creds, io);
    expect(denied).toMatchObject({ ok: false, reason: 'reconnect_required' });
    if (!denied.ok) expect(denied.detail).not.toContain('abcd');
    load('verify_subscriber');
    expect(await adapter.verify(site, creds, io)).toMatchObject({ ok: false, reason: 'rejected' });
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(await adapter.verify(site, creds, refused)).toMatchObject({ ok: false, reason: 'transient' });
  });

  it('uploadMedia (RA-08): the bytes come from the signed release URL through ProviderIO, land as an attachment with the file name and alt text; a refusal is a reconnect', async () => {
    load('upload_media_ok');
    const media = {
      url: 'https://releases.example/releases/t/b/av_1/original/x.png',
      mime: 'image/png',
      contentHash: 'h'.repeat(64),
      alt: 'The weighbridge',
      filename: 'why-ore-and-tar-1.png',
    };
    expect(await adapter.uploadMedia(site, creds, io, media)).toEqual({
      outcome: 'done',
      media: { remoteId: '77', url: 'https://site.example/wp-content/uploads/2026/10/why-ore-and-tar-1.png' },
    });
    expect(io.calls).toEqual([
      { method: 'GET', url: media.url, mutation: false },
      { method: 'POST', url: 'https://site.example/wp-json/wp/v2/media', mutation: true },
      { method: 'POST', url: 'https://site.example/wp-json/wp/v2/media/77', mutation: true },
    ]);
    const upload = server.requests[1]!;
    expect(upload.headers['content-type']).toBe('image/png');
    expect(upload.headers['content-disposition']).toBe('attachment; filename="why-ore-and-tar-1.png"');
    expect(upload.headers['authorization']).toBe(expectedAuth);
    load('upload_media_forbidden');
    expect(await adapter.uploadMedia(site, creds, io, media)).toMatchObject({
      outcome: 'rejected',
      code: 'reconnect_required',
    });
    // The release must answer with an image: anything else is refused before the site is touched.
    load('upload_media_not_image');
    expect(await adapter.uploadMedia(site, creds, io, media)).toMatchObject({
      outcome: 'rejected',
      code: 'media_unexpected_type',
    });
    expect(io.calls.every((c) => !c.mutation)).toBe(true);
  });

  it("createArticle (RA-08): the uploaded media is the post's featured image and the body references the site's copy", async () => {
    load('create_with_featured');
    const html =
      '<p>Ore is heavy.</p>\n<figure><img src="https://site.example/wp-content/uploads/2026/10/why-ore-and-tar-1.png" alt="The weighbridge"></figure>';
    const result = await adapter.createArticle(
      site,
      creds,
      io,
      {
        ...input,
        html,
        featuredMedia: {
          remoteId: '77',
          url: 'https://site.example/wp-content/uploads/2026/10/why-ore-and-tar-1.png',
        },
      },
      'idem-feat',
    );
    expect(result).toMatchObject({ outcome: 'done', article: { remoteId: '43', status: 'draft', html } });
    const post = JSON.parse(server.requests.at(-1)!.body) as Record<string, unknown>;
    expect(post['featured_media']).toBe(77);
    expect(post['content']).toBe(html);
  });

  it('readArticle: the raw revision with its modified instant and content hash; 404 is absent; 403 a reconnect', async () => {
    load('read_found');
    const found = await adapter.readArticle(site, creds, io, '42');
    expect(found).toEqual({
      outcome: 'found',
      article: {
        remoteId: '42',
        remoteUrl: 'https://site.example/why-ore-and-tar/',
        title: 'Why ore & tar',
        slug: 'why-ore-and-tar',
        status: 'draft',
        modifiedAt: '2026-09-30T10:00:00Z',
        contentHash: hashOf('draft', '<p>Ore is heavy.</p>'),
        html: '<p>Ore is heavy.</p>',
      },
    });
    // RA-12: the hash moves with the title, the slug, the status or a term, not only the content.
    const base = { title: 'T', slug: 's', status: 'publish', categories: [1], tags: [2], html: '<p>x</p>' };
    for (const change of [
      { title: 'U' },
      { slug: 'other' },
      { status: 'draft' },
      { categories: [3] },
      { tags: [] },
      { html: '<p>y</p>' },
    ])
      expect(remoteArticleFingerprint({ ...base, ...change })).not.toBe(remoteArticleFingerprint(base));
    expect(remoteArticleFingerprint({ ...base, categories: [2, 1], tags: [2] })).toBe(
      remoteArticleFingerprint({ ...base, categories: [1, 2] }),
    );
    expect(remoteArticleFingerprint(base)).not.toBe(textFingerprint('<p>x</p>'));
    expect(io.calls.every((c) => !c.mutation)).toBe(true);
    load('read_absent');
    expect(await adapter.readArticle(site, creds, io, '404')).toEqual({ outcome: 'absent' });
    load('read_forbidden');
    expect(await adapter.readArticle(site, creds, io, '42')).toMatchObject({
      outcome: 'rejected',
      code: 'reconnect_required',
    });
  });

  it('createArticle: terms resolved by exact name over the pages (a missing tag created), then one draft post', async () => {
    load('create_draft');
    const created = await adapter.createArticle(site, creds, io, input, 'idem_1');
    expect(created).toMatchObject({
      outcome: 'done',
      article: {
        remoteId: '42',
        status: 'draft',
        slug: 'why-ore-and-tar',
        remoteUrl: 'https://site.example/?p=42',
      },
    });
    expect(
      io.calls.map((c) => `${c.method} ${new URL(c.url).pathname}${c.mutation ? ' (mutation)' : ''}`),
    ).toEqual([
      'GET /wp-json/wp/v2/categories',
      'GET /wp-json/wp/v2/categories',
      'GET /wp-json/wp/v2/tags',
      'POST /wp-json/wp/v2/tags (mutation)',
      'POST /wp-json/wp/v2/posts (mutation)',
    ]);
    expect(server.requests.at(-1)?.headers['x-oremedia-idempotency-key']).toBe('idem_1');
    expect(server.remaining()).toEqual([]);
  });

  it('createArticle: a 403 is rejected as a reconnect; a 502 after the post was sent is unknown, never retried blindly', async () => {
    load('create_forbidden');
    expect(
      await adapter.createArticle(site, creds, io, { ...input, categories: [], tags: [] }, 'idem_2'),
    ).toMatchObject({
      outcome: 'rejected',
      code: 'reconnect_required',
    });
    load('create_outage_after_send');
    expect(
      await adapter.createArticle(site, creds, io, { ...input, categories: [], tags: [] }, 'idem_3'),
    ).toMatchObject({
      outcome: 'unknown',
      code: 'http_502',
    });
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(
      await adapter.createArticle(site, creds, refused, { ...input, categories: [], tags: [] }, 'idem_4'),
    ).toMatchObject({
      outcome: 'retryable_error',
      code: 'transport_before_send',
    });
  });

  it('updateArticle: a remote that moved since the read-back is a conflict and nothing is written', async () => {
    load('update_conflict');
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>'), expectedModifiedAt: '2026-09-30T10:00:00Z' },
    );
    expect(result).toMatchObject({
      outcome: 'conflict',
      current: { title: 'Why ore & tar (edited on the site)', modifiedAt: '2026-09-30T12:30:00Z' },
    });
    expect(io.calls.some((c) => c.mutation)).toBe(false);
    // A remote whose content and identity still hash the same but was touched since (the timestamp moved) is a
    // conflict too: both halves of the precondition hold.
    load('update_ok');
    const touched = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>'), expectedModifiedAt: '2026-09-30T09:00:00Z' },
    );
    expect(touched).toMatchObject({ outcome: 'conflict' });
    expect(io.calls.some((c) => c.mutation)).toBe(false);
  });

  it('updateArticle: with the precondition met the post is written once, the new revision comes back with the pre-write read, and the replaced revision is the one read', async () => {
    load('update_ok');
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>'), expectedModifiedAt: '2026-09-30T10:00:00Z' },
    );
    expect(result).toMatchObject({
      outcome: 'done',
      article: {
        modifiedAt: '2026-09-30T13:00:00Z',
        contentHash: hashOf('publish', '<p>Ore is heavy and tar is sticky.</p>'),
      },
      previous: { modifiedAt: '2026-09-30T10:00:00Z', html: '<p>Ore is heavy.</p>' },
    });
    expect(result.outcome === 'done' && result.overwritten).toBeUndefined();
    expect(io.calls.filter((c) => c.mutation)).toHaveLength(1);
    expect(io.calls.at(-1)).toMatchObject({
      method: 'GET',
      url: 'https://site.example/wp-json/wp/v2/posts/42/revisions?context=edit&per_page=2',
      mutation: false,
    });
    expect(server.remaining()).toEqual([]);
  });

  it('updateArticle (RA-12): a site edit that slipped between the read and the write is detected after the write and returned as what was overwritten; an unreadable revision list claims nothing', async () => {
    load('update_overwritten');
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>'), expectedModifiedAt: '2026-09-30T10:00:00Z' },
    );
    expect(result).toMatchObject({
      outcome: 'done',
      article: { modifiedAt: '2026-09-30T13:00:00Z' },
      previous: { modifiedAt: '2026-09-30T10:00:00Z' },
      overwritten: {
        remoteId: '42',
        remoteUrl: 'https://site.example/why-ore-and-tar/',
        title: 'Why ore & tar (edited on the site)',
        modifiedAt: '2026-09-30T12:30:00Z',
        html: '<p>Someone changed this in the window.</p>',
      },
    });
    expect(server.remaining()).toEqual([]);
    load('update_revisions_unavailable');
    const unknown = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>') },
    );
    expect(unknown).toMatchObject({ outcome: 'done', previous: { modifiedAt: '2026-09-30T10:00:00Z' } });
    expect(unknown.outcome === 'done' && unknown.overwritten).toBeUndefined();
  });

  it('unpublishArticle sets a live article back to a draft under the precondition it read; deleteArticle reports one already gone', async () => {
    load('unpublish');
    expect(await adapter.unpublishArticle(site, creds, io, '42')).toMatchObject({
      outcome: 'done',
      article: { status: 'draft' },
      previous: { status: 'publish', modifiedAt: '2026-09-30T13:00:00Z' },
    });
    expect(server.remaining()).toEqual([]);
    expect(server.unmatched).toEqual([]);
    load('delete_gone');
    expect(await adapter.deleteArticle(site, creds, io, '42')).toEqual({ outcome: 'already_absent' });
    load('delete_ok');
    expect(await adapter.deleteArticle(site, creds, io, '42')).toMatchObject({
      outcome: 'done',
      article: { status: 'trash' },
    });
  });

  it('fetchRendered: follows a same-host redirect, refuses another host, reads against the byte cap, sends no credentials', async () => {
    load('rendered_redirect');
    const page = await adapter.fetchRendered(site, io, 'https://site.example/?p=42', 1024 * 1024);
    expect(page).toMatchObject({
      status: 200,
      truncated: false,
      url: 'https://site.example/why-ore-and-tar/',
    });
    expect(page.html).toContain('<h1>Why ore &amp; tar</h1>');
    expect(server.requests.every((r) => r.headers['authorization'] === undefined)).toBe(true);
    load('rendered_other_host');
    await expect(
      adapter.fetchRendered(site, io, 'https://site.example/why-ore-and-tar/', 1024),
    ).rejects.toBeInstanceOf(RenderedPageError);
    await expect(adapter.fetchRendered(site, io, 'https://other.example/x', 1024)).rejects.toMatchObject({
      code: 'other_host',
    });
    await expect(adapter.fetchRendered(site, io, 'http://site.example/x', 1024)).rejects.toMatchObject({
      name: 'BlockedAddressError',
    });
    load('rendered_large');
    const large = await adapter.fetchRendered(site, io, 'https://site.example/big/', 16);
    expect(large).toMatchObject({ status: 200, truncated: true, bytes: 16 });
    expect(large.html).toBe('0123456789012345');
  });

  it('classifyError: a 429 before send is a throttle; 401 refresh, 403 reconnect, 404 rejected, 5xx unknown', () => {
    expect(adapter.classifyError({ status: 429, phase: 'before_send' })).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
    });
    expect(adapter.classifyError({ status: 429, phase: 'after_send' })).toEqual({ kind: 'unknown' });
    expect(adapter.classifyError({ status: 401, phase: 'after_send' })).toEqual({ kind: 'refresh_token' });
    expect(adapter.classifyError({ status: 403, phase: 'after_send' })).toEqual({
      kind: 'reconnect_required',
    });
    expect(adapter.classifyError({ status: 404, phase: 'after_send' })).toEqual({
      kind: 'rejected',
      code: 'http_404',
    });
    expect(adapter.classifyError({ status: 503, phase: 'after_send' })).toEqual({ kind: 'unknown' });
  });
});
